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

import { tools as fileTools, ToolError } from './lib-fstools.mjs';

// The toolset is a parameter rather than a fixed import, because mail is
// only offered when it has been configured — advertising a tool that will
// always fail teaches the model to keep trying it.
export const defaultTools = fileTools;

const NS = 'copilot';
// Anchored to the start of a line, and multiline, which is the rule the
// prompt has always stated and the parser never enforced. Unanchored, a reply
// that merely *talks about* the protocol executes it: asked for a code review,
// the model writes "you could fix this with <copilot:edit path=...>" and the
// bridge dutifully offers to edit the file. Reviewing a file that contains the
// protocol — this repository, for one — does the same. A tag is an action; a
// mention of a tag is prose, and column zero is what separates them.
// The tag name allows underscores and digits. It did not, and the confluence
// tools are called confluence_search, confluence_read and confluence_spaces:
// the model emitted them perfectly and the parser could not see them, so the
// turn ended as prose with the tag printed to the terminal. A tool name the
// grammar cannot express is checked for at startup now — see assertToolNames.
const TAG_NAME = '[a-z][a-z0-9_]*';
const OPEN = new RegExp(`^<${NS}:(${TAG_NAME})((?:\\s+[a-z_]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`, 'gm');

// Tag-shaped text that is NOT a call, so the user can be told when something
// that looked like one was passed over rather than silently dropped.
const MENTION = new RegExp(`<${NS}:${TAG_NAME}`, 'g');

export function countMentions(text) {
  const src = stripFences(text);
  let loose = 0;
  for (const m of src.matchAll(MENTION)) {
    const bol = m.index === 0 || src[m.index - 1] === '\n';
    if (!bol) loose++;
  }
  return loose;
}

// ---------------------------------------------------------------- protocol

/**
 * A tool whose name the tag grammar cannot express can never be called: the
 * model emits it correctly, the parser skips it, and the turn quietly ends.
 * That is invisible from the outside, so it is checked before a prompt is
 * ever built rather than discovered by running one.
 */
export function assertToolNames(tools) {
  const valid = new RegExp(`^${TAG_NAME}$`);
  const bad = Object.keys(tools || {}).filter((n) => !valid.test(n));
  if (bad.length) {
    throw new Error(
      `these tool names cannot be expressed as tags and would never be called: ${bad.join(', ')}. `
      + `Tag names must match ${TAG_NAME}.`,
    );
  }
  return true;
}

export function renderSystemPrompt(root, tools = defaultTools, { skills = null } = {}) {
  assertToolNames(tools);
  const activeSkills = skills && skills.length ? skills : null;
  const anyMutates = activeSkills
    ? activeSkills.some((s) => s.mutates)
    : Object.values(tools).some((t) => t.mutates);

  const sampleTag = activeSkills && activeSkills[0]?.sampleTag
    ? activeSkills[0].sampleTag
    : `<${NS}:read path="src/index.js"/>`;

  let roleDesc = "You are a coding agent working in a checkout on the user's machine.";
  if (activeSkills) {
    const hasCode = activeSkills.some((s) => s.domain === 'code');
    if (!hasCode) {
      if (activeSkills.length === 1 && activeSkills[0].id === 'mail') {
        roleDesc = "You are an assistant with read-only access to the user's corporate mail.";
      } else if (activeSkills.length === 1 && activeSkills[0].id === 'confluence') {
        roleDesc = "You are an assistant with read-only access to the corporate Confluence knowledge base.";
      } else {
        roleDesc = "You are an assistant with access to specific tools on the user's machine.";
      }
    }
  }

  const lines = [
    roleDesc,
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
    sampleTag,
    '```',
    '',
    '  The fence matters: it is what stops this chat from reformatting the tag',
    '  or the file content inside it. Never emit a tag outside a fence.',
    '- A tool tag must start at the beginning of a line, in column one.',
    '- A tag ANYWHERE in your reply is executed. It is not an illustration.',
    '  Never quote, mention or give an example of a tag while explaining',
    '  something. Describe the change in words instead.',
  );

  // If specific skills provide guidance rules, render them here:
  if (activeSkills) {
    for (const s of activeSkills) {
      if (s.promptRules && s.promptRules.length) {
        lines.push(...s.promptRules);
      }
    }
  } else {
    // Legacy / default rules when skills array is not provided
    lines.push(
      '- Paths are relative to the workspace root. Never use absolute paths or "..".',
      '- Use edit to change a file that already exists, and write only to create a',
      '  new one or to replace a file wholesale.',
      '- Read a file before you edit it, and quote the SEARCH lines exactly as they',
      '  appear, including indentation. SEARCH must match one place in the file; if',
      '  it could match more, include more surrounding lines.',
      '- write replaces the whole file. Emit the complete new contents, never a diff',
      '  and never a fragment with "... rest unchanged".',
      '- The body of a write tag is literal file content. Do not escape it.',
    );
  }

  lines.push(
    '- You may emit several tags in one reply; they run in order.',
    '- After each reply that contains tags, you will be shown the results and can',
    '  continue. When the task is done, reply with prose and no tags at all.',
    '- Keep prose short. Say what you are about to do, not what you might do.',
  );

  if (anyMutates) {
    lines.push(
      '',
      'WHEN NOT TO CHANGE ANYTHING',
      '- If the task only asks you to look at code — review it, audit it, explain',
      '  it, find a bug, answer a question about it — then read and list are the',
      '  only tools you may use. Report what you found in prose and stop.',
      '- Every write and edit interrupts the user to ask permission. Do not emit',
      '  one unless the task actually asked for the file to change.',
      '- Proposing a change is prose. Making one is a tag. Do not confuse them.',
    );
  } else {
    lines.push(
      '',
      'READ-ONLY MODE',
      '- All tools in this session are strictly read-only. You cannot mutate files,',
      '  modify server state, or send messages.',
      '- Proposing a change or action is prose. Report what you found in prose and stop.',
    );
  }

  const hasWorkspaceSkill = !activeSkills || activeSkills.some((s) => s.domain === 'code');
  if (hasWorkspaceSkill) {
    lines.push(
      '',
      `The workspace root is ${root}`,
    );
  }
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
export function parseToolTags(text, tools = defaultTools) {
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

/**
 * The prose part of a reply: everything before the first real tag.
 *
 * Cutting at any mention of the namespace threw away most of a code review,
 * because a review discusses the syntax rather than emitting it. Only a tag
 * at the start of a line ends the prose.
 */
export function proseOf(text) {
  const src = stripFences(text);
  OPEN.lastIndex = 0;
  const m = OPEN.exec(src);
  let prose = (m ? src.slice(0, m.index) : src).trim();
  // Copilot renders a code block with a language caption and a line-number
  // gutter, and innerText hands both back as text. Immediately before a tag
  // they are chrome, not something the model said.
  if (m) {
    const lines = prose.split('\n');
    while (lines.length) {
      const last = lines[lines.length - 1].trim();
      if (/^\d+$/.test(last) || /^(plain ?text|text|xml|html|markdown|code|bash|shell|json|yaml)$/i.test(last) || last === '') {
        lines.pop();
        continue;
      }
      break;
    }
    prose = lines.join('\n').trim();
  }
  return prose;
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
  tools = defaultTools,
  skills = null,
}) {
  const ctx = { root: session.root };

  // The instructions are sent once. The tab holds the conversation, so
  // repeating them every task would pay for context the session already has.
  let prompt = session.primed
    ? task
    : `${renderSystemPrompt(session.root, tools, { skills })}\n\nTASK: ${task}`;
  session.primed = true;

  for (let step = 1; step <= maxSteps; step++) {
    ui.step(step, maxSteps);

    const reply = await ask(prompt);
    if (reply === null || reply === undefined) return { done: false, steps: step, stalled: 'no answer came back' };

    if (/please wait (for|until) the (current|previous) response/i.test(reply)) {
      if (ui.toolError) ui.toolError('copilot', 'page was still busy with a previous response; retrying...');
      await new Promise((r) => setTimeout(r, 4000));
      step--;
      continue;
    }

    const prose = proseOf(reply);
    if (prose) ui.prose(prose);

    const calls = parseToolTags(reply, tools);
    // Tag-shaped text that was not in column one is passed over. Say so
    // whether or not anything else ran: silence here would leave the user
    // wondering why a file they were just told about never changed. Strict is
    // the right default — executing a mention is far worse than skipping a
    // misplaced call — but it must never be quiet.
    const loose = countMentions(reply);
    if (loose && ui.ignored) ui.ignored(loose);
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
        const output = await tool.run(ctx, call.args, call.body);
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
