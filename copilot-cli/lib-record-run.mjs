// The --record-chat command, as a function its dependencies are handed to.
//
// It records the chat page and nothing else. Every skill — files, mail,
// Confluence — reaches the model through the same box as plain request and
// response, so the chat path is the whole of what needs recording. Mail and
// Confluence checks were chained in here once and removed: they said nothing
// about the chat, and they read a real message and internal page titles.
//
// It lives here rather than inside chat.mjs so that the whole path can be run
// before it is used — building the probe messages, recording each turn,
// running one real bridge turn, sending the long message last, analysing it
// all, and writing the bundle. It is used once, on a corporate account, so a typo in the plumbing
// costs exactly as much as a bug in the recorder.

import { randomBytes } from 'node:crypto';
import { recordConversation } from './lib-record.mjs';
import { analyseConversation } from './lib-record-analyse.mjs';
import { renderSystemPrompt, renderResults } from './lib-agent.mjs';
import { askInPage } from './page-fn.mjs';

/**
 * The body a write reply must carry back intact. Everything the files agent
 * depends on is in it: four-space and eight-space indentation, a tab, a
 * blank line, trailing text after a backslash, a Windows path, non-ASCII
 * text, and the SEARCH/REPLACE markers an edit uses.
 */
export const CODE_BODY = [
  'def greet(name):',
  '    """Say hello."""',
  '    if name:',
  '        return f"hi {name}"',
  '',
  '\treturn "hi"  # a tab, then text',
  'PATH = r"C:\\Users\\someone\\work"',
  'NOTE = "\u6a94\u6848 \u2014 done"',
  '<<<<<<< SEARCH',
  'old line',
  '=======',
  'new line',
  '>>>>>>> REPLACE',
].join('\n');

/**
 * The turns, each a plain request and response, in the order they are sent.
 * A turn whose send does not register ends the recording (except the two
 * fallback probes, which are allowed to fail), and everything before it is
 * already kept, so the ones most likely to be refused go last.
 *
 *   1  a short plain message    the case that could not be sent at all
 *   2  the real agent prompt    what the composer does to long markdown
 *   3  a real tool result       the second turn of every agent exchange
 *   4  a multi-line code reply  whether write and edit bodies survive the page
 *   5  a long streamed reply    pauses mid-answer, and whether the reply node is replaced
 *   6  sent by the send button the bridge's third attempt, never exercised
 *   7  sent by Ctrl+Enter      the bridge's second attempt, never exercised
 *   -  one real bridge turn    askInPage itself, run separately after these
 *   8  a very long message     whether the box has a size limit, and where
 */
export function buildProbeTurns({ registry, root, longChars = 30000 }) {
  const nonce = () => `probe-${randomBytes(3).toString('hex')}`;
  const n = Array.from({ length: 9 }, nonce);
  const resolved = registry.resolve('files', { root });

  const agentPrompt = `${renderSystemPrompt(root, resolved.tools, { skills: resolved.activeSkills })}\n\nTASK: list the files here (${n[1]})`;
  const toolResult = `${renderResults([{ name: 'list', ok: true, output: 'README.md  12b\nchat.mjs  3401b\ntest/' }])}\n(${n[2]})`;
  const codeRequest = [
    `Reply with exactly the following, character for character, inside one fenced code block, and nothing else. (${n[3]})`,
    '',
    '<copilot:write path="probe.py">',
    CODE_BODY,
    '</copilot:write>',
  ].join('\n');

  // The instruction comes first, so that if the box truncates the message
  // the part that says what to do survives, and the filler is plainly ours.
  const head = `Reply with only the word OK. The rest of this message is filler used to measure how long a message this chat accepts. (${n[4]})\n\n`;
  const lines = [];
  for (let i = 1; head.length + lines.join('\n').length < longChars; i++) {
    lines.push(`line ${String(i).padStart(5, '0')} of filler text for a length measurement`);
  }
  const longMessage = head + lines.join('\n');

  return {
    tools: resolved.tools,
    turns: [
      { label: 'short', prompt: `hi (${n[0]})`, nonce: n[0] },
      { label: 'agent-prompt', prompt: agentPrompt, nonce: n[1] },
      { label: 'tool-result', prompt: toolResult, nonce: n[2] },
      { label: 'code-body', prompt: codeRequest, nonce: n[3], expectBody: CODE_BODY },
      { label: 'long-reply', prompt: `Write a numbered list from 1 to 60, one short sentence about the number on each line. (${n[5]})`, nonce: n[5] },
      { label: 'button', method: 'button', tolerant: true, prompt: `Reply with only the word OK. (${n[6]})`, nonce: n[6] },
      { label: 'ctrl-enter', method: 'ctrl-enter', tolerant: true, prompt: `Reply with only the word OK. (${n[7]})`, nonce: n[7] },
    ],
    bridgePrompt: `hi (${n[8]})`,
    bridgeNonce: n[8],
    long: { label: 'long', prompt: longMessage, nonce: n[4] },
  };
}

export function summaryLines(a, rec) {
  const out = [];
  if (!rec) return ['[record-chat]      nothing was recorded'];
  if (rec.aborted) return [`[record-chat]      stopped before sending: ${rec.aborted}`];
  if (!a || a.error) return [`[record-chat]      recorded, but the analysis failed: ${a && a.error}`];
  out.push(`[record-chat]      idle page: ${a.idle.mutations} mutations, ${a.idle.charGrowth} characters over 3s`);
  if (a.clearTest) {
    const c = a.clearTest;
    out.push(c.skipped ? `[record-chat]      clearing: not tested — ${c.skipped}`
      : `[record-chat]      clearing: ${c.clearedBy} (typed ${c.afterInsert}, after delete ${c.afterExecCommandDelete}${c.afterTextContentFallback !== undefined ? `, after fallback ${c.afterTextContentFallback}` : ''})`);
  }
  for (const t of a.turns) {
    out.push(`[record-chat]      turn ${t.index} (${t.label || '?'}, by ${t.method})${t.skipped ? `: SKIPPED — ${t.skipped}` : ''}${t.sendNotRegistered ? ': the send did not register' : ''}`);
    if (t.skipped) continue;
    if (t.composer) out.push(`        composer: ${t.composer.verdict} (typed ${t.composer.typedLength}, held ${t.composer.heldLength}, zero-width ${t.composer.zeroWidth})`);
    out.push(`        echo:     ${t.echo.found ? `found, newlines ${t.echo.newlinesInEcho}/${t.echo.newlinesTyped}, matches with spaces ${t.echo.matchesWithSpaces}, squashed ${t.echo.matchesSquashed}` : 'not found'}`);
    if (t.method === 'button') out.push(`        button:   ${t.buttonNotFound ? 'no labelled send button was found; nothing clicked' : `clicked aria="${(t.sendButton && t.sendButton.ariaLabel) || ''}"`}`);
    if (t.sendNotRegistered && t.clearedAfterNoSend !== undefined) out.push(`        our text cleared afterwards: ${t.clearedAfterNoSend}`);
    out.push(`        timing:   cleared ${t.timing.composerClearedAt}, stop ${t.timing.stopAppearedAt}–${t.timing.stopGoneAt}, answer ${t.timing.answerAppearedAt}, total ${t.timing.totalMs}; longest pause mid-answer ${t.maxGrowthGapMs}ms; insert ${t.insertMs}ms${t.answerReplacedMidStream ? '; ANSWER NODE REPLACED' : ''}`);
    out.push(`        stop:     ${t.stopControl.length ? t.stopControl.map((s) => `aria="${s.ariaLabel || ''}" testid="${s.testid || ''}"`).join('; ') : 'none appeared'}`);
    if (t.answer.found) {
      out.push(`        answer:   ${t.answer.length} chars, tag ${t.answer.containsTag}, "Plain Text" ${t.answer.plainTextCaption}, gutter lines ${t.answer.gutterLines}`);
      out.push(`        BRIDGE PARSES: ${t.answer.bridgeParses.length ? t.answer.bridgeParses.join(', ') : '(no tool call)'}`);
    } else out.push('        answer:   none found');
    if (t.codeBody) {
      const c = t.codeBody;
      if (!c.parsed) out.push(`        CODE BODY: not parsed — ${c.reason}`);
      else out.push(`        CODE BODY: ${c.exact ? 'EXACT' : 'differs'}; lines ${c.gotLines}/${c.expectedLines}, indentation ${c.indentationPreserved}, tab ${c.tabPreserved}, blank line ${c.blankLinePreserved}, non-ASCII ${c.nonAsciiPreserved}, gutter digits inside ${c.digitOnlyLinesInBody}`);
    }
    if (t.long) {
      const l = t.long;
      out.push(`        LONG: typed ${l.typed}, box held ${l.held}${l.truncated ? '  <-- TRUNCATED' : ''}; registered ${l.sendRegistered}; maxlength ${l.maxlength}; counters ${JSON.stringify(l.counters)}`);
    }
    if (t.notices && t.notices.length) out.push(`        page notices: ${JSON.stringify(t.notices)}`);
  }
  if (a.bridge) {
    const b = a.bridge;
    if (b.error) out.push(`[record-chat]      BRIDGE TURN: failed to run — ${b.error}`);
    else if (b.skipped) out.push(`[record-chat]      BRIDGE TURN: not run — ${b.skipped}`);
    else {
      out.push(`[record-chat]      BRIDGE TURN: ${b.notSent ? `NOT SENT — ${b.method}` : `ok=${b.ok}, ${b.textLength} chars via ${b.method}`}`);
      if (b.wait) out.push(`        wait: ${b.wait.ms}ms via ${b.wait.via}, submissions ${b.wait.submissions}, stop seen ${b.wait.sawStop}`);
      if (b.sameTextAsAnEarlierReply) out.push('        same text as an earlier reply: a repeated greeting, or the bridge read the wrong reply (check method)');
    }
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
  note('[record-chat] the chat page: at most nine messages, one at a time, each only after the page is idle');
  note('[record-chat]   1 "hi"   2 the agent prompt   3 a tool result   4 a code block   5 a list of 60');
  note('[record-chat]   6 "OK" by the send button   7 "OK" by Ctrl+Enter   8 "hi" through the bridge itself');
  note('[record-chat]   9 a 30,000-character message');
  note('[record-chat] 6 and 7 may not send; that is recorded, not retried. Expect about ten minutes.');
  note('[record-chat] open a NEW Copilot chat first; nothing earlier is read either way.');
  note('[record-chat] keep the Copilot tab in front and visible until this ends: Chrome slows the timers');
  note('[record-chat] of a hidden tab, which would distort every timing this records.');
  const { turns, tools, bridgePrompt, long } = buildProbeTurns({ registry, root });

  const record = async (arg, timeoutMs) => {
    try {
      return await evalFn(recordConversation, arg, { timeoutMs });
    } catch (e) {
      note(`[record-chat]      the recording call failed (${e.message}); collecting what it had got to`);
      try { return await evalFn(() => window.__copilotRecord || null, null, { timeoutMs: 20000 }); } catch { return null; }
    }
  };

  // Each turn can take up to perTurnMs plus idleMaxMs; allow for all of them.
  const perTurn = Number(config.perTurnMs || 90000) + Number(config.idleMaxMs || 90000) + 5000;
  const rec = await record({ ...config, turns }, 60000 + perTurn * turns.length);
  bundle.stages.conversation = rec;
  save();

  // A failure that is not one of the tolerated fallbacks means the page is in
  // a state nobody has seen; nothing more is sent into it.
  const hardStop = !rec || rec.aborted || (rec.turns || []).length < turns.length
    || (rec.turns || []).some((t) => t.skipped || t.stoppedHere || (t.sendNotRegistered && !t.tolerant));

  // The bridge's own turn: the function that failed, on the page it failed on.
  let bridge;
  if (hardStop) bridge = { skipped: 'an earlier turn did not complete, so nothing further was sent' };
  else {
    note('[record-chat]      the recorder turns are done; now one turn through the bridge itself');
    try {
      const res = await evalFn(askInPage, { ...config, prompt: bridgePrompt }, { timeoutMs: Number(config.answerTimeoutMs || 120000) + 60000 });
      bridge = { prompt: bridgePrompt, ...bridgeFacts(res, rec) };
    } catch (e) { bridge = { error: e.message }; }
  }
  bundle.stages.bridge = bridge;
  save();

  // The long message last: it is the one most likely to be refused.
  let longRec = null;
  if (hardStop || !bridge || bridge.error || bridge.notSent) {
    longRec = { turns: [{ index: turns.length + 1, label: 'long', skipped: 'not sent, because an earlier step did not complete' }] };
  } else {
    longRec = await record({ ...config, turns: [long], clearTest: false }, 60000 + perTurn);
    if (longRec && longRec.turns) longRec.turns.forEach((t) => { t.index = turns.length + 1; });
  }
  bundle.stages.longMessage = longRec;
  save();

  const merged = rec ? { ...rec, turns: [...(rec.turns || []), ...((longRec && longRec.turns) || [])], bridge } : null;
  if (merged) {
    try { bundle.stages.analysis = analyseConversation(merged, tools, { expect: { 'code-body': CODE_BODY } }); } catch (e) { bundle.stages.analysis = { error: e.message }; }
  }
  save();
  for (const line of summaryLines(bundle.stages.analysis, merged)) note(line);

  bundle.finished = new Date().toISOString();
  save();

  note('');
  note('[record-chat] done. Send copilot-cli-record-all.json.');
  note('[record-chat] it holds only the probe messages this sent and the replies to them.');
  return bundle;
}

/**
 * What the bridge's own turn is kept as. Its DOM capture is dropped, as the
 * bridge itself drops it from the pasteable file, and the reply text is kept
 * only when the chat held nothing before the recording began — otherwise a
 * wrong pick could be something private from earlier.
 */
export function bridgeFacts(res, rec) {
  if (!res) return { error: 'no result' };
  const debug = { ...(res.debug || {}) };
  delete debug.capture;
  if (Array.isArray(debug.candidates)) debug.candidates = debug.candidates.map(({ sample: _s, ...rest }) => rest);
  const text = String(res.text || '');
  const fresh = !!(rec && rec.before && rec.before.answerNodes === 0);
  const earlier = ((rec && rec.turns) || []).map((t) => t.answer && t.answer.text).filter(Boolean);
  const squash = (x) => String(x).replace(/\s+/g, '');
  return {
    ok: res.ok, busy: !!res.busy, notSent: !!res.notSent, method: res.method || null,
    textLength: text.length,
    text: fresh ? text.slice(0, 4000) : null,
    textWithheld: fresh ? null : 'the chat was not empty when recording began',
    sameTextAsAnEarlierReply: !!text && earlier.some((a) => squash(a) === squash(text)),
    wait: debug.wait || null,
    composer: debug.composer || null,
    debug,
  };
}
