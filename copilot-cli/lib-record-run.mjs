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
 *   6  one real bridge turn    askInPage itself
 *   7  sent by Ctrl+Enter      the bridge's second attempt, never exercised
 *   8  sent by the send button the bridge's third attempt, never exercised
 *   9  a very long message     whether the box has a size limit, and where
 *
 * 1 to 6 need no clearing: the page empties the box itself on every send.
 * 7 and 8 may leave our text behind, and clearing it is exactly what the
 * first run of this showed to be unreliable, so they come after everything
 * that cannot be put at risk by it.
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
    ],
    // Ctrl+Enter first: if it only adds a line and the text cannot be
    // cleared, the button probe sends that same text instead of being lost.
    fallbacks: [
      { label: 'ctrl-enter', method: 'ctrl-enter', tolerant: true, prompt: `Reply with only the word OK. (${n[7]})`, nonce: n[7] },
      { label: 'button', method: 'button', tolerant: true, prompt: `Reply with only the word OK. (${n[6]})`, nonce: n[6] },
    ],
    clearNonce: n[4].replace('probe', 'clear'),
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
  const clearing = (c) => (c.tried || []).map((t) => `${t.how} -> ${t.error ? `error ${t.error}` : t.after}`).join('; ');
  if (a.clearTest) {
    const c = a.clearTest;
    out.push(c.skipped ? `[record-chat]      clearing test: not run — ${c.skipped}`
      : `[record-chat]      clearing test: ${c.cleared ? `cleared by "${c.by}"` : 'NOTHING in the page cleared it'} (typed ${c.afterInsert}; ${clearing(c)})`);
  }
  for (const k of rec.keyClears || []) {
    out.push(`[record-chat]      real keys Ctrl+A, Backspace (${k.why}): ${k.skipped ? `not sent — ${k.skipped}` : `${k.before} -> ${k.after}${k.cleared ? ', CLEARED' : ', not cleared'}`}`);
  }
  if (rec.leftInBox && rec.leftInBox.visible > 0) {
    out.push(`[record-chat]      !! the Copilot box still holds ${rec.leftInBox.visible} characters of probe text: delete it by hand`);
  }
  for (const t of a.turns) {
    out.push(`[record-chat]      turn ${t.index} (${t.label || '?'}, by ${t.method})${t.skipped ? `: SKIPPED — ${t.skipped}` : ''}${t.sendNotRegistered ? ': the send did not register' : ''}`);
    if (t.skipped) continue;
    if (t.composer) out.push(`        composer: ${t.composer.verdict} (typed ${t.composer.typedLength}, held ${t.composer.heldLength}, zero-width ${t.composer.zeroWidth})`);
    out.push(`        echo:     ${t.echo.found ? `found, newlines ${t.echo.newlinesInEcho}/${t.echo.newlinesTyped}, matches with spaces ${t.echo.matchesWithSpaces}, squashed ${t.echo.matchesSquashed}` : 'not found'}`);
    if (t.method === 'button') out.push(`        button:   ${t.buttonNotFound ? 'no labelled send button was found; nothing clicked' : `clicked aria="${(t.sendButton && t.sendButton.ariaLabel) || ''}"`}`);
    if (t.reusedPreviousText) out.push(`        sent the previous probe's text, which could not be cleared (${t.reusedPreviousText})`);
    if (t.clearing && t.clearing.tried.length) out.push(`        clearing: ${t.clearing.cleared ? `cleared by "${t.clearing.by}"` : 'not cleared'} (${clearing(t.clearing)})`);
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
/** Put focus in the chat box and report how much it holds. Runs in the tab. */
export function focusComposer(cfg) {
  const input = document.querySelector(cfg.inputSelector);
  if (!input) return { found: false };
  try { input.focus(); } catch { /* reported below */ }
  const active = document.activeElement;
  const visible = String(input.innerText || '').replace(/[\u200B-\u200D\u2060\uFEFF\s]/g, '').length;
  return { found: true, focused: !!active && (active === input || input.contains(active)), visible };
}

/** Type our own words into an empty box, for the key-clearing test. Runs in the tab. */
export function typeIntoEmptyComposer(cfg) {
  const input = document.querySelector(cfg.inputSelector);
  if (!input) return { typed: false, why: 'no input' };
  const visible = () => String(input.innerText || '').replace(/[\u200B-\u200D\u2060\uFEFF\s]/g, '').length;
  if (visible() > 0) return { typed: false, why: 'the box was not empty' };
  input.focus();
  try { document.execCommand('insertText', false, cfg.words); } catch (e) { return { typed: false, why: String(e && e.message) }; }
  return { typed: true, visible: visible() };
}

/**
 * Ctrl+A then Backspace, as real key presses through the debugging
 * protocol. Neither can send a message. The select-all editing command is
 * named explicitly, because a raw Ctrl+A is not turned into one everywhere.
 */
export const CLEAR_KEYS = [
  { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll'] },
  { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
  { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
];

/**
 * @param deps.evalFn        (fn, arg, opts) => result — runs fn in the chat tab
 * @param deps.keysFn        (events) => void — real key events into the tab; optional
 * @param deps.note          (line) => void
 * @param deps.write         (file, text) => void
 */
export async function runRecordAllWith(deps) {
  const { evalFn, keysFn, note, write, registry, root, config, version } = deps;
  const bundle = { version, node: process.version, started: new Date().toISOString(), stages: {} };
  const save = () => { try { write('copilot-cli-record-all.json', JSON.stringify(bundle, null, 1) + '\n'); } catch { /* reported by caller */ } };

  note('');
  note('[record-chat] the chat page: at most seven messages, one at a time, each only after the page is idle');
  note('[record-chat]   1 "hi"   2 the agent prompt   3 a tool result   4 a code block   5 a list of 60');
  note('[record-chat]   6 "hi" through the bridge itself   7 a 30,000-character message');
  note('[record-chat] none of these needs the box cleared: the page empties it on every send. About ten minutes.');
  note('[record-chat] open a NEW Copilot chat first, with an EMPTY box; nothing earlier is read either way.');
  note('[record-chat] keep the Copilot tab in front and visible until this ends: Chrome slows the timers');
  note('[record-chat] of a hidden tab, which would distort every timing this records.');
  const { turns, fallbacks, tools, bridgePrompt, long, clearNonce } = buildProbeTurns({ registry, root });
  const keyClears = [];
  bundle.stages.keyClears = keyClears;

  const record = async (arg, timeoutMs) => {
    try {
      return await evalFn(recordConversation, arg, { timeoutMs });
    } catch (e) {
      note(`[record-chat]      the recording call failed (${e.message}); collecting what it had got to`);
      try { return await evalFn(() => window.__copilotRecord || null, null, { timeoutMs: 20000 }); } catch { return null; }
    }
  };
  // Only ever our own text, only ever select-all and delete.
  const keyClear = async (why) => {
    const k = { why };
    keyClears.push(k);
    if (!keysFn) { k.skipped = 'no key channel'; return k; }
    let f;
    try { f = await evalFn(focusComposer, { inputSelector: config.inputSelector }, { timeoutMs: 20000 }); } catch (e) { k.skipped = e.message; return k; }
    k.before = f && f.visible;
    if (!f || !f.found || !f.focused) { k.skipped = 'focus could not be put in the box, so no keys were sent'; return k; }
    try { await keysFn(CLEAR_KEYS); } catch (e) { k.error = e.message; }
    await new Promise((r) => setTimeout(r, 500));
    try { k.after = (await evalFn(focusComposer, { inputSelector: config.inputSelector }, { timeoutMs: 20000 })).visible; } catch (e) { k.error = e.message; }
    k.cleared = k.after === 0;
    save();
    return k;
  };
  const leftOurs = (r) => r && r.leftInBox && r.leftInBox.visible > 0 && r.leftInBox.ours;
  const blocked = (r, n) => !r || r.aborted || (r.turns || []).length < n
    || (r.turns || []).some((t) => t.skipped || t.stoppedHere || (t.sendNotRegistered && !t.tolerant));

  // Each turn can take up to perTurnMs plus idleMaxMs; allow for all of them.
  const perTurn = Number(config.perTurnMs || 90000) + Number(config.idleMaxMs || 90000) + 5000;

  // 1-5: plain sends, none of which needs the box cleared.
  const rec = await record({ ...config, turns }, 60000 + perTurn * turns.length);
  bundle.stages.conversation = rec;
  save();
  let stop = blocked(rec, turns.length) ? 'an earlier turn did not complete, so nothing further was sent' : null;

  // 6: the bridge's own turn — the function that failed, on the page it failed on.
  let bridge;
  if (stop) bridge = { skipped: stop };
  else {
    note('[record-chat]      turns 1-5 are done; now one turn through the bridge itself');
    try {
      const res = await evalFn(askInPage, { ...config, prompt: bridgePrompt }, { timeoutMs: Number(config.answerTimeoutMs || 120000) + 60000 });
      bridge = { prompt: bridgePrompt, ...bridgeFacts(res, rec) };
    } catch (e) { bridge = { error: e.message }; }
    if (bridge.error || bridge.notSent) stop = 'the bridge turn did not complete, so nothing further was sent';
  }
  bundle.stages.bridge = bridge;
  save();

  // The Ctrl+Enter and send-button probes and the clearing test are not
  // run: each can leave text in the box, and the first live run recorded
  // that nothing in the page clears it. They wait until clearing is solved.
  const fb = null;
  bundle.stages.fallbacks = fb;
  save();

  // 9: the long message last: it is the one most likely to be refused.
  let longRec;
  if (stop) {
    longRec = { turns: [{ index: turns.length + 2, label: 'long', skipped: stop }] };
  } else {
    longRec = await record({ ...config, turns: [long] }, 60000 + perTurn);
    if (longRec && longRec.turns) longRec.turns.forEach((t) => { t.index = turns.length + 2; });
    if (leftOurs(longRec)) await keyClear('the long message did not send');
  }
  bundle.stages.longMessage = longRec;
  save();

  let leftInBox = null;
  try { const f = await evalFn(focusComposer, { inputSelector: config.inputSelector }, { timeoutMs: 20000 }); leftInBox = { visible: f.visible }; } catch { /* unknown */ }
  const merged = rec ? {
    ...rec,
    turns: [...(rec.turns || []), ...((fb && fb.turns) || []), ...((longRec && longRec.turns) || [])],
    clearTest: fb && fb.clearTest, bridge, keyClears, leftInBox,
  } : null;
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
