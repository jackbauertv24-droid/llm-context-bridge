/**
 * The one-shot --record-chat run, every stage, before it is used once.
 *
 * The page stands in for Copilot with every behaviour seen so far — anchors
 * around typed text, Enter consumed, echo with newlines dropped, code replies
 * wrapped in a "Plain Text" caption and a line-number gutter, a stop control
 * that goes before the text stops — plus the behaviours the recording exists
 * to find out about, each switchable: Ctrl+Enter that only adds a newline, a
 * send button that does nothing, a box that truncates long text, a reply
 * that pauses mid-stream and has its node replaced, a code reply that loses
 * indentation or keeps its gutter digits. For every variant, the question is
 * the same: does the run send what it says, no more, record the fact, and
 * leak nothing from before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from '../lib-dom.mjs';
import { runRecordAllWith, buildProbeTurns, CODE_BODY, bridgeFacts } from '../lib-record-run.mjs';
import { analyseConversation } from '../lib-record-analyse.mjs';
import { createDefaultRegistry } from '../lib-skills.mjs';

const SECRETS = ['SECRET-old-mail-subject', 'SECRET-old-reply'];

function page(opt = {}) {
  const {
    ctrlEnter = 'newline',      // 'newline' | 'send'
    buttonSends = true,
    maxChars = Infinity,        // a box that silently truncates
    codeReply = 'faithful',     // 'faithful' | 'flattened' | 'gutter'
    replaceAnswerNode = false,
    earlier = false,            // a conversation that already holds private text
    labelledSend = true,
  } = opt;
  resetDom();
  const state = { submits: 0, sent: [], via: [] };
  const feed = new El('div', {});
  doc.body.append(feed);
  if (earlier) {
    const old = new El('div', { 'data-testid': 'lastChatMessage' });
    const md = new El('div', { 'data-testid': 'markdown-reply' });
    for (const s of SECRETS) md.append(new El('p', {}, s));
    old.append(md);
    feed.append(old);
  }
  const composer = new El('div', { class: 'fai-BebopLiteChatInput' });
  const input = new El('span', { id: 'm365-chat-editor-target-element', role: 'textbox', contenteditable: 'true' });
  input.rect = { x: 735, y: 495, width: 704, height: 27 };
  composer.append(input);
  composer.append(new El('button', { 'aria-label': 'Attach a file' }));
  const send = new El('button', { 'aria-label': labelledSend ? 'Send' : '' });
  composer.append(send);
  doc.body.append(composer);
  doc._editor = input;
  Object.defineProperty(input, 'innerText', {
    get() { const raw = this.children.length ? this.children.map((c) => c.innerText).join('\n') : this._text; return raw ? `​${raw}​` : raw; },
    set(v) { this.children = []; this._text = v; },
    configurable: true,
  });
  Object.defineProperty(input, 'textContent', {
    get() { return this._text || ''; },
    set(v) { this.children = []; this._text = String(v).slice(0, maxChars); },
    configurable: true,
  });

  let turn = 0;
  const submit = (via) => {
    const sent = input._text || '';
    if (!sent) return;
    state.submits++; turn++; state.sent.push(sent); state.via.push(via);
    setTimeout(() => { input._text = ''; }, 500);
    const stop = new El('button', { 'aria-label': 'Stop responding' });
    setTimeout(() => doc.body.append(stop), 500);
    setTimeout(() => { const e = new El('div', {}); e.append(new El('div', {}, sent.split('\n').join(''))); feed.append(e); }, 600);
    let reply = new El('div', { 'data-testid': 'lastChatMessage', id: `response-id_${turn}` });
    let md = new El('div', { 'data-testid': 'markdown-reply' });
    reply.append(md);
    setTimeout(() => feed.append(reply), 800);

    let lines;
    let pauseAt = -1;
    if (sent.includes('TASK:')) lines = ['I’ll list the files.', 'Plain Text', '1', '<copilot:list path="."/>'];
    else if (sent.includes('<copilot:write path="probe.py">')) {
      const body = codeReply === 'flattened' ? CODE_BODY.split('\n').map((l) => l.trim()) : CODE_BODY.split('\n');
      const shown = codeReply === 'gutter' ? body.flatMap((l, i) => [String(i + 1), l]) : body;
      // A code block arrives as one <pre>, so its blank lines survive as text.
      lines = ['Plain Text', ['<copilot:write path="probe.py">', ...shown, '</copilot:write>'].join('\n')];
    } else if (sent.includes('numbered list')) {
      lines = Array.from({ length: 60 }, (_, i) => `${i + 1}. The number ${i + 1}.`);
      pauseAt = 30;
    } else if (sent.includes('Reply with only the word OK')) lines = ['OK'];
    else if (sent.startsWith('hi')) lines = [`Hello! How can I help? ${(sent.match(/probe-\w+/) || [''])[0]}`];
    else lines = ['Those are the files.'];

    // Lines arrive in bursts of five, with one long silence mid-answer.
    let at = 1000;
    lines.forEach((l, i) => {
      if (i === pauseAt) at += 2600;
      if (i % 5 === 0) at += 200;
      setTimeout(() => md.append(new El(l.includes('\n') ? 'pre' : 'p', {}, l)), at);
    });
    if (replaceAnswerNode && pauseAt > 0) {
      // The page swaps the streaming node for a final one.
      setTimeout(() => {
        const final = new El('div', { 'data-testid': 'markdown-reply' });
        for (const c of md.children) final.append(new El('p', {}, c.innerText));
        reply.children = []; reply.append(final); md.parentElement = null; md = final;
      }, at + 100);
    }
    setTimeout(() => { stop.rect = { x: 0, y: 0, width: 0, height: 0 }; }, at - 400);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    if (ev.ctrlKey && ctrlEnter === 'newline') { input._text = `${input._text || ''}\n`; return; }
    submit(ev.ctrlKey ? 'ctrl-enter' : 'enter');
  });
  send.addEventListener('click', () => { if (buttonSends) submit('button'); });
  return state;
}

const CONFIG = {
  inputSelector: '#m365-chat-editor-target-element',
  answerSelector: '[data-testid="markdown-reply"]',
  perTurnMs: 25000, idleMaxMs: 10000, registerMs: 4000,
  quietMs: 1500, answerTimeoutMs: 30000,
};

async function runAll(opt = {}) {
  const restore = installGlobals();
  const notes = [];
  const files = {};
  try {
    const state = page(opt);
    const bundle = await runRecordAllWith({
      // Exactly what lib-cdp.mjs sends Chrome: the function's source and a
      // JSON argument, evaluated with no module scope, the value returned
      // by value. Anything the function reaches for outside itself fails here.
      evalFn: async (fn, arg) => {
        const expr = `(${fn.toString()})(${JSON.stringify(arg)})`;
        const value = await (0, eval)(expr);
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      },
      note: (l) => notes.push(l),
      write: (f, t) => { files[f] = t; },
      registry: createDefaultRegistry(),
      root: process.cwd(),
      config: CONFIG,
      version: 'test',
    });
    return { state, bundle, notes, files, a: bundle.stages.analysis };
  } finally { restore(); }
}

const byLabel = (a, label) => a.turns.find((t) => t.label === label);

test('the probe set covers every way the bridge touches the page', () => {
  const p = buildProbeTurns({ registry: createDefaultRegistry(), root: process.cwd() });
  assert.deepEqual(p.turns.map((t) => t.label), ['short', 'agent-prompt', 'tool-result', 'code-body', 'long-reply', 'button', 'ctrl-enter']);
  assert.deepEqual(p.turns.map((t) => t.method || 'enter'), ['enter', 'enter', 'enter', 'enter', 'enter', 'button', 'ctrl-enter']);
  assert.ok(p.turns.filter((t) => t.tolerant).every((t) => t.method !== undefined), 'only the fallback probes may fail and continue');
  assert.ok(p.long.prompt.length >= 30000, 'the long message is really long');
  assert.ok(p.long.prompt.startsWith('Reply with only the word OK'), 'with the instruction first, so truncation keeps it');
  assert.ok(p.bridgePrompt.startsWith('hi'), 'the bridge turn is the plain "hi" that failed');
  const nonces = [...p.turns.map((t) => t.nonce), p.bridgeNonce, p.long.nonce];
  assert.equal(new Set(nonces).size, nonces.length, 'every message is distinguishable');
});

test('on a page like the real one: nine messages, each once, in order, and every fact recorded', async () => {
  const { state, bundle, a, notes, files } = await runAll({ ctrlEnter: 'newline' });
  // 1-5 by Enter, 6 by the button, 7 Ctrl+Enter does NOT send here, the bridge turn, the long one.
  assert.deepEqual(state.via, ['enter', 'enter', 'enter', 'enter', 'enter', 'button', 'enter', 'enter'],
    `sends were ${JSON.stringify(state.via)}`);
  assert.equal(state.submits, 8, 'nothing was sent twice');
  assert.equal(new Set(state.sent).size, state.sent.length, 'no message sent twice');

  const ce = byLabel(a, 'ctrl-enter');
  assert.equal(ce.sendNotRegistered, true, 'the Ctrl+Enter probe records that it did not send');
  assert.equal(ce.clearedAfterNoSend, true, 'and its text was cleared rather than left to ride along');
  assert.ok(!state.sent.some((s) => s.includes(bundle.stages.conversation.turns[6].nonce)), 'the Ctrl+Enter text was never sent later by accident');

  const btn = byLabel(a, 'button');
  assert.equal(btn.sendNotRegistered, false);
  assert.equal(btn.sendButton.ariaLabel, 'Send', 'the button clicked is the one labelled Send, not Attach');

  assert.equal(a.clearTest.clearedBy, 'execCommand delete', 'clearing was measured on text in the box');

  const lr = byLabel(a, 'long-reply');
  assert.ok(lr.maxGrowthGapMs >= 2000, `the mid-answer silence was measured (${lr.maxGrowthGapMs}ms)`);
  assert.ok(lr.answer.length > 600, 'and the whole list captured, not the part before the pause');

  const cb = byLabel(a, 'code-body').codeBody;
  assert.equal(cb.parsed, true);
  assert.equal(cb.exact, true, JSON.stringify(cb.differences));
  assert.equal(cb.backslashesPreserved, true, 'the backslash check actually runs');
  assert.equal(cb.tabPreserved, true);

  assert.ok(!a.bridge.notSent && a.bridge.ok, `the bridge turn ran: ${a.bridge.method}`);
  assert.equal(a.bridge.debug.capture, undefined, 'the DOM capture is not kept');
  assert.ok(a.bridge.wait && a.bridge.wait.via, 'its wait is recorded');
  assert.equal(a.bridge.sameTextAsAnEarlierReply, false);
  assert.ok(String(a.bridge.text).includes(a.bridge.prompt.match(/probe-\w+/)[0]), 'the bridge read the reply to its own message, not an earlier one');
  assert.match(String(a.bridge.text), /Hello/, `a fresh chat, so the reply to our own "hi" is kept: ${JSON.stringify({ t: a.bridge.text, m: a.bridge.method, w: a.bridge.wait, steps: a.bridge.debug.steps })}`);

  const long = byLabel(a, 'long');
  assert.equal(long.index, 8);
  assert.equal(long.long.truncated, false);
  assert.equal(long.long.sendRegistered, true);

  assert.ok(files['copilot-cli-record-all.json']);
  for (const want of ['clearing:', 'button:', 'longest pause mid-answer', 'BRIDGE TURN', 'LONG:', 'CODE BODY: EXACT']) {
    assert.ok(notes.some((l) => l.includes(want)), `the terminal summary shows "${want}"`);
  }
});

test('where Ctrl+Enter does send, that is recorded too, and still once', async () => {
  const { state, a } = await runAll({ ctrlEnter: 'send' });
  assert.equal(state.submits, 9);
  assert.equal(state.via[6], 'ctrl-enter');
  assert.equal(byLabel(a, 'ctrl-enter').sendNotRegistered, false);
});

test('a send button that does nothing is recorded, cleared, and the run carries on', async () => {
  const { state, a } = await runAll({ buttonSends: false });
  const btn = byLabel(a, 'button');
  assert.equal(btn.sendNotRegistered, true);
  assert.equal(btn.clearedAfterNoSend, true);
  assert.ok(byLabel(a, 'long').long.sendRegistered, 'the long turn still ran');
  assert.equal(new Set(state.sent).size, state.sent.length);
});

test('with no button labelled Send, nothing is clicked at all', async () => {
  const { a } = await runAll({ labelledSend: false });
  const btn = byLabel(a, 'button');
  assert.equal(btn.buttonNotFound, true);
  assert.equal(btn.sendNotRegistered, true);
});

test('a box that truncates long text is caught by the long turn', async () => {
  const { a, notes } = await runAll({ maxChars: 10000 });
  const l = byLabel(a, 'long').long;
  assert.equal(l.truncated, true);
  assert.ok(l.held <= 10002, `held ${l.held}`);
  assert.ok(notes.some((n) => n.includes('TRUNCATED')));
});

test('a code reply that loses its indentation is reported, not passed', async () => {
  const { a } = await runAll({ codeReply: 'flattened' });
  const cb = byLabel(a, 'code-body').codeBody;
  assert.equal(cb.exact, false);
  assert.equal(cb.indentationPreserved, false);
  assert.equal(cb.tabPreserved, false);
});

test('gutter numbers left inside a code body are counted', async () => {
  const { a } = await runAll({ codeReply: 'gutter' });
  const cb = byLabel(a, 'code-body').codeBody;
  assert.equal(cb.exact, false);
  assert.ok(cb.digitOnlyLinesInBody > 0);
});

test('a reply node replaced mid-stream is noticed', async () => {
  const { a } = await runAll({ replaceAnswerNode: true });
  const lr = byLabel(a, 'long-reply');
  assert.equal(lr.answerReplacedMidStream, true);
});

test('in a chat that held private text, none of it is in the file — including via the bridge turn', async () => {
  const { files, a } = await runAll({ earlier: true });
  const json = files['copilot-cli-record-all.json'];
  for (const s of SECRETS) assert.ok(!json.includes(s), `leaked ${s}`);
  assert.equal(a.bridge.text, null, 'the bridge reply is withheld when the chat was not empty');
  assert.ok(a.bridge.textWithheld);
});

test('bridgeFacts drops the capture and candidate samples whatever the page returned', () => {
  const f = bridgeFacts({
    ok: true, text: 'x', method: 'm',
    debug: { capture: { tree: SECRETS[0] }, candidates: [{ name: 'n', sample: SECRETS[1], chars: 3 }], wait: { via: 'quiet' } },
  }, { before: { answerNodes: 0 }, turns: [] });
  const json = JSON.stringify(f);
  for (const s of SECRETS) assert.ok(!json.includes(s));
  assert.equal(f.debug.candidates[0].chars, 3);
});

test('analysis of the recording is the same when re-run from the file', async () => {
  const { bundle } = await runAll({});
  const rec = bundle.stages.conversation;
  const merged = { ...rec, turns: [...rec.turns, ...bundle.stages.longMessage.turns], bridge: bundle.stages.bridge };
  const again = analyseConversation(JSON.parse(JSON.stringify(merged)), buildProbeTurns({ registry: createDefaultRegistry(), root: process.cwd() }).tools, { expect: { 'code-body': CODE_BODY } });
  assert.deepEqual(again.turns.map((t) => t.label), bundle.stages.analysis.turns.map((t) => t.label));
});
