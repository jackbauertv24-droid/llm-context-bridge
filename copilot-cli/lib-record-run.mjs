// The --record-chat command, as a function its dependencies are handed to.
//
// It records the chat page and nothing else. Every skill — files, mail,
// Confluence — reaches the model through the same box as plain request and
// response, so the chat path is the whole of what needs recording. Mail and
// Confluence checks were chained in here once and removed: they said nothing
// about the chat, and they read a real message and internal page titles.
//
// It lives here rather than inside chat.mjs so that the whole path can be run
// before it is used — building the two prompts, recording both turns,
// analysing them, chaining the Confluence and mail checks, and writing the
// bundle. It is used once, on a corporate account, so a typo in the plumbing
// costs exactly as much as a bug in the recorder.

import { randomBytes } from 'node:crypto';
import { recordConversation } from './lib-record.mjs';
import { analyseConversation } from './lib-record-analyse.mjs';
import { renderSystemPrompt, renderResults } from './lib-agent.mjs';

export function buildProbeTurns({ registry, root }) {
  const nonce = () => `probe-${randomBytes(3).toString('hex')}`;
  const n1 = nonce();
  const n2 = nonce();
  const resolved = registry.resolve('files', { root });
  const p1 = `${renderSystemPrompt(root, resolved.tools, { skills: resolved.activeSkills })}\n\nTASK: list the files here (${n1})`;
  const p2 = `${renderResults([{ name: 'list', ok: true, output: 'README.md  12b\nchat.mjs  3401b\ntest/' }])}\n(${n2})`;
  return { turns: [{ prompt: p1, nonce: n1 }, { prompt: p2, nonce: n2 }], tools: resolved.tools };
}

export function summaryLines(a, rec) {
  const out = [];
  if (!rec) return ['[record-chat]      nothing was recorded'];
  if (rec.aborted) return [`[record-chat]      stopped before sending: ${rec.aborted}`];
  if (!a || a.error) return [`[record-chat]      recorded, but the analysis failed: ${a && a.error}`];
  out.push(`[record-chat]      idle page: ${a.idle.mutations} mutations, ${a.idle.charGrowth} characters over 3s`);
  for (const t of a.turns) {
    out.push(`[record-chat]      turn ${t.index}${t.skipped ? `: SKIPPED — ${t.skipped}` : ''}${t.sendNotRegistered ? ': the send did not register' : ''}`);
    if (t.skipped) continue;
    if (t.composer) out.push(`        composer: ${t.composer.verdict} (typed ${t.composer.typedLength}, held ${t.composer.heldLength}, zero-width ${t.composer.zeroWidth})`);
    out.push(`        echo:     ${t.echo.found ? `found, newlines ${t.echo.newlinesInEcho}/${t.echo.newlinesTyped}, matches with spaces ${t.echo.matchesWithSpaces}, squashed ${t.echo.matchesSquashed}` : 'not found'}`);
    out.push(`        stop:     ${t.stopControl.length ? t.stopControl.map((s) => `aria="${s.ariaLabel || ''}" testid="${s.testid || ''}"`).join('; ') : 'none appeared'}`);
    if (t.answer.found) {
      out.push(`        answer:   ${t.answer.length} chars, tag ${t.answer.containsTag}, "Plain Text" ${t.answer.plainTextCaption}, gutter lines ${t.answer.gutterLines}`);
      out.push(`        BRIDGE PARSES: ${t.answer.bridgeParses.length ? t.answer.bridgeParses.join(', ') : '(no tool call)'}`);
    } else out.push('        answer:   none found');
  }
  if (a.secondTurnReadsNewAnswer !== null) out.push(`[record-chat]      second turn reads the new answer: ${a.secondTurnReadsNewAnswer}`);
  return out;
}

/**
 * @param deps.evalFn        (fn, arg, opts) => result — runs fn in the chat tab
 * @param deps.note          (line) => void
 * @param deps.write         (file, text) => void
 */
export async function runRecordAllWith(deps) {
  const { evalFn, note, write, registry, root, config, version } = deps;
  const bundle = { version, node: process.version, started: new Date().toISOString(), stages: {} };
  const save = () => { try { write('copilot-cli-record-all.json', JSON.stringify(bundle, null, 1) + '\n'); } catch { /* reported by caller */ } };

  note('');
  note('[record-chat] the chat page: two messages, the real agent prompt and a tool result');
  note('[record-chat] open a NEW Copilot chat first if you can; nothing earlier is read either way.');
  const { turns, tools } = buildProbeTurns({ registry, root });

  let rec = null;
  try {
    rec = await evalFn(recordConversation, { ...config, turns }, { timeoutMs: 420000 });
  } catch (e) {
    note(`[record-chat]      the recording call failed (${e.message}); collecting what it had got to`);
    try { rec = await evalFn(() => window.__copilotRecord || null, null, { timeoutMs: 20000 }); } catch { rec = null; }
  }
  bundle.stages.conversation = rec;
  if (rec) {
    try { bundle.stages.analysis = analyseConversation(rec, tools); } catch (e) { bundle.stages.analysis = { error: e.message }; }
  }
  save();
  for (const line of summaryLines(bundle.stages.analysis, rec)) note(line);

  bundle.finished = new Date().toISOString();
  save();

  note('');
  note('[record-chat] done. Send copilot-cli-record-all.json.');
  note('[record-chat] it holds only the two probe messages this sent and the replies to them.');
  return bundle;
}
