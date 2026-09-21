// An agent loop over a chat web UI that has no tool calling.
//
// Ported from the clichat agent harness (src/agent.mjs). The protocol is the
// same idea and deliberately the same shape: an XML-ish tag with a raw body,
// so file contents need no escaping, and a toolset described in a sentence
// each rather than a JSON Schema dump. A model that was never trained to call
// tools is exactly the model that gets JSON string escaping wrong, and the
// thing an agent mostly emits is the contents of a source file.
//
// Two things differ from clichat, both forced by the backend:
//
//   1. clichat streams tokens; a turn here is one round trip through the page
//      and arrives whole. The loop is correspondingly simpler — there is
//      nothing to suppress as it arrives, only prose to print once the tags
//      have been cut out.
//
//   2. clichat reads a raw response body. Here the answer is read out of a
//      rendered page, so whatever the model emits has been through a markdown
//      renderer and an HTML sanitizer first. A bare <copilot:write> tag may
//      well not survive that — an unknown element is exactly what a sanitizer
//      drops — and prose-level markdown would in any case reflow the body and
//      destroy the indentation of the file being written.
//
//      So the model is told to put every tag inside a fenced code block, which
//      is the one construct that survives rendering with its whitespace
//      intact. The parser accepts tags with or without the fence, because
//      which of the two actually comes back is a property of the page that no
//      amount of reasoning here can settle.
//
// Like clichat, the backend is stateful: the conversation lives in the tab, so
// the instructions are sent once and each later turn carries only the results.

import { tools, ToolError } from './lib-fstools.mjs';

const NS = 'copilot';
const OPEN = new RegExp(`<${NS}:([a-z]+)((?:\\s+[a-z_]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`, 'g');

// ---------------------------------------------------------------- protocol

export function renderSystemPrompt(root) {
  const lines = [
    'You are a coding agent working in a checkout on the user\'s machine.',
    'You act by emitting tool tags, which a bridge outside this chat executes',
    'for you. You cannot see the machine except through their results.',
    '',
    'TOOLS',
  ];
  // Usage is rendered flush left. Indenting it would invite the model to
  // indent a tag body too, and a body is literal -- the indentation would land
  // in the file, or shift a SEARCH block away from what it is meant to match.
  for (const t of Object.values(tools)) {
    lines.push(`# ${t.summary}`, t.usage, '');
  }
  lines.push(
    'RULES',
    '- Put every tool tag inside a fenced code block, on its own, like this:',
    '',
    '```',
    `<${NS}:read path="src/index.js"/>`,
    '```',
    '',
    '  The fence matters: it is what stops this chat from reformatting the tag',
    '  or the file content inside it. Never emit a tag outside a fence.',
    '- A tool tag must start at the beginning of a line.',
    '- Paths are relative to the workspace root. Never use absolute paths or "..".',
    '- Use edit to change a file that already exists, and write only to create a',
    '  new one or to replace a file wholesale.',
    '- Read a file before you edit it, and quote the SEARCH lines exactly as they',
    '  appear, including indentation. SEARCH must match one place in the file; if',
    '  it could match more, include more surrounding lines.',
    '- write replaces the whole file. Emit the complete new contents, never a diff',
    '  and never a fragment with "... rest unchanged".',
    '- The body of a write tag is literal file content. Do not escape it.',
    '- You may emit several tags in one reply; they run in order.',
    '- After each reply that contains tags, you will be shown the results and can',
    '  continue. When the task is done, reply with prose and no tags at all.',
    '- Keep prose short. Say what you are about to do, not what you might do.',
    '',
    `The workspace root is ${root}`,
  );
  return lines.join('\n');
}

function parseAttrs(s) {
  const out = {};
  for (const m of String(s || '').matchAll(/([a-z_]+)\s*=\s*"([^"]*)"|([a-z_]+)\s*=\s*'([^']*)'/g)) {
    if (m[1] !== undefined) out[m[1]] = m[2];
    else out[m[3]] = m[4];
  }
  return out;
}

/**
 * Removes the code fences the model was told to wrap its tags in.
 *
 * Only fence *lines* go; everything between them is kept exactly, because that
 * is the file content. A fence line inside a body would be a file that itself
 * contains a fence — rare, and it costs a retry rather than a wrong write,
 * since the tag would then fail to parse rather than parse incorrectly.
 */
export function stripFences(text) {
  return String(text)
    .split('\n')
    .filter((ln) => !/^\s*```+[\w-]*\s*$/.test(ln))
    .join('\n');
}

// Pulls every tool tag out of a finished reply, in order.
//
// A raw body means the body could itself contain the closing tag -- a file
// that quotes this protocol, most obviously this very file. We take the FIRST
// close, which is what the model is told to produce; the alternative (last
// close) breaks two legitimate writes in one reply, which is far more common.
export function parseToolTags(text) {
  const src = stripFences(text);
  const calls = [];
  OPEN.lastIndex = 0;
  let m;
  while ((m = OPEN.exec(src))) {
    const [full, name, attrs, selfClose] = m;
    const tool = tools[name];
    if (!tool) continue;

    if (selfClose || !tool.body) {
      calls.push({ name, args: parseAttrs(attrs), body: '' });
      continue;
    }
    const closeTag = `</${NS}:${name}>`;
    const bodyStart = m.index + full.length;
    const end = src.indexOf(closeTag, bodyStart);
    if (end < 0) {
      calls.push({ name, args: parseAttrs(attrs), body: '', unterminated: true });
      break;
    }
    // A body is a block: drop one leading newline after the tag and one
    // trailing newline before the close, so the file does not gain blank lines.
    let body = src.slice(bodyStart, end);
    body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    calls.push({ name, args: parseAttrs(attrs), body });
    OPEN.lastIndex = end + closeTag.length;
  }
  return calls;
}

/** The prose part of a reply: everything before the first tag, fences removed. */
export function proseOf(text) {
  const src = stripFences(text);
  const at = src.indexOf(`<${NS}:`);
  return (at < 0 ? src : src.slice(0, at)).trim();
}

// Feeds results back as the next turn's prompt. Same tag shape as the calls, so
// the model sees one consistent syntax rather than two.
export function renderResults(results) {
  const parts = results.map((r) => [
    `<${NS}:result tool="${r.name}" status="${r.ok ? 'ok' : 'error'}">`,
    r.output,
    `</${NS}:result>`,
  ].join('\n'));
  parts.push('', 'Continue, or reply with prose and no tags if the task is done.');
  return parts.join('\n');
}

// ---------------------------------------------------------------- the loop

// One conversation. Held across tasks so a follow-up ("now do the same for the
// other handler") lands in a session that still remembers the files it read.
export function createAgentSession(root) {
  return { root, primed: false };
}

/**
 * Run a task to completion.
 *
 * `ask(prompt)` sends one turn through the page and resolves with the answer
 * text, or null if the turn produced nothing — which is a page problem, not a
 * model one, and ends the run rather than looping on an empty reply.
 */
export async function runAgent({
  ask, task, session, maxSteps = 16, approve = async () => true, ui,
}) {
  const ctx = { root: session.root };

  // The instructions are sent once. The tab holds the conversation, so
  // repeating them every task would pay for context the session already has.
  let prompt = session.primed
    ? task
    : `${renderSystemPrompt(session.root)}\n\nTASK: ${task}`;
  session.primed = true;

  for (let step = 1; step <= maxSteps; step++) {
    ui.step(step, maxSteps);

    const reply = await ask(prompt);
    if (reply === null || reply === undefined) return { done: false, steps: step, stalled: 'no answer came back' };

    const prose = proseOf(reply);
    if (prose) ui.prose(prose);

    const calls = parseToolTags(reply);
    if (!calls.length) return { done: true, steps: step };

    const results = [];
    for (const call of calls) {
      const tool = tools[call.name];
      if (call.unterminated) {
        ui.toolError(call.name, 'reply ended mid-tag');
        results.push({
          name: call.name, ok: false,
          output: `the <${NS}:${call.name}> tag was never closed; re-send it complete`,
        });
        continue;
      }

      const label = tool.describe(call.args, call.body);
      if (tool.mutates && !(await approve(label, call))) {
        ui.skipped(label);
        results.push({ name: call.name, ok: false, output: 'the user declined this action' });
        continue;
      }

      try {
        const output = tool.run(ctx, call.args, call.body);
        ui.toolOk(label, output);
        results.push({ name: call.name, ok: true, output });
      } catch (err) {
        const msg = err instanceof ToolError ? err.message : `${err.code || ''} ${err.message}`.trim();
        ui.toolError(label, msg);
        results.push({ name: call.name, ok: false, output: msg });
      }
    }
    prompt = renderResults(results);
  }
  return { done: false, steps: maxSteps, stalled: `hit the ${maxSteps}-step limit` };
}
