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
 * indentation or keeps its gutter digits.
 *
 * The editor is modelled on what the first live run of this recorded: text
 * written straight into it is put back, and selecting and deleting in the
 * same instant deletes nothing. Which other method clears it is not known,
 * so each is a switch, and the default is the worst case — none of them,
 * only real key presses. For every variant, the question is
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
    clearing = 'none',          // which in-page method empties the box: 'none' | 'pause-select' | 'selectAll' | 'backspace'
    keysWork = true,            // whether real Ctrl+A, Backspace empty it
    draft = null,               // text already in the box when the run starts
    longNeverSends = false,     // a message over 5,000 characters is not accepted
  } = opt;
  resetDom();
  const state = { submits: 0, sent: [], via: [], keys: [] };
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
  // RECORDED: the editor keeps its own copy and puts it back.
  Object.defineProperty(input, 'textContent', {
    get() { return this._text || ''; },
    set() { /* reverted by the editor */ },
    configurable: true,
  });
  input._text = draft || '';
  input.focus = () => { doc.activeElement = input; };
  // The editor learns of a selection only a moment after it changes.
  const sel = { range: null, at: 0 };
  globalThis.window.getSelection = () => ({
    removeAllRanges() { sel.range = null; },
    addRange(range) { sel.range = range; sel.at = Date.now(); },
  });
  doc.createRange = () => ({ collapsed: false, selectNodeContents() { this.collapsed = false; }, collapse() { this.collapsed = true; } });
  doc.execCommand = (cmd, _ui, arg) => {
    if (doc.activeElement !== input) return false;
    if (cmd === 'insertText') { input._text = `${input._text || ''}${arg}`.slice(0, maxChars); return true; }
    if (cmd === 'selectAll') { sel.range = { all: true, collapsed: false }; sel.at = Date.now(); return true; }
    if (cmd !== 'delete') return false;
    const synced = sel.range && Date.now() - sel.at >= 100;
    if (!synced) return false;                                        // RECORDED
    if (clearing === 'pause-select' && !sel.range.all && !sel.range.collapsed) input._text = '';
    else if (clearing === 'selectAll' && sel.range.all) input._text = '';
    else if (clearing === 'backspace' && sel.range.collapsed) input._text = (input._text || '').slice(0, -1);
    return true;
  };
  state.pressKeys = (events) => {
    for (const ev of events) state.keys.push(`${ev.type}:${ev.key}`);
    const selectAll = events.some((e) => e.type === 'rawKeyDown' && e.key === 'a' && e.modifiers === 2);
    const back = events.some((e) => e.type === 'rawKeyDown' && e.key === 'Backspace');
    if (keysWork && selectAll && back && doc.activeElement === input) input._text = '';
  };

  let turn = 0;
  const submit = (via) => {
    const sent = input._text || '';
    if (!sent) return;
    if (longNeverSends && sent.length > 5000) return;
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
  const saved = { createRange: doc.createRange, execCommand: doc.execCommand };
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
      keysFn: async (events) => state.pressKeys(events),
      note: (l) => notes.push(l),
      write: (f, t) => { files[f] = t; },
      registry: createDefaultRegistry(),
      root: process.cwd(),
      config: CONFIG,
      version: 'test',
    });
    return { state, bundle, notes, files, a: bundle.stages.analysis };
  } finally { Object.assign(doc, saved); delete doc.activeElement; restore(); }
}

const byLabel = (a, label) => a.turns.find((t) => t.label === label);

const nonceOf = (text) => (String(text).match(/probe-[0-9a-f]+/) || [null])[0];
const noEnterByKeys = (state) => assert.ok(!state.keys.some((k) => /Enter/.test(k)), 'Enter is never pressed through the key channel');

test('the replica reproduces what the first live run recorded', async () => {
  // Selecting and deleting in the same instant, then writing textContent:
  // exactly the method that left 15 of 15 characters in the real box.
  const restore = installGlobals();
  const saved = { createRange: doc.createRange, execCommand: doc.execCommand };
  try {
    page({});
    const input = doc.querySelector('#m365-chat-editor-target-element');
    input.focus();
    doc.execCommand('insertText', false, 'clear-test probe');
    const s = globalThis.window.getSelection();
    s.removeAllRanges();
    const r = doc.createRange(); r.selectNodeContents(input); s.addRange(r);
    doc.execCommand('delete', false);
    input.textContent = '';
    assert.equal(input._text, 'clear-test probe');
  } finally { Object.assign(doc, saved); delete doc.activeElement; restore(); }
});

test('the probe set covers every way the bridge touches the page, in a safe order', () => {
  const p = buildProbeTurns({ registry: createDefaultRegistry(), root: process.cwd() });
  assert.deepEqual(p.turns.map((t) => t.label), ['short', 'agent-prompt', 'tool-result', 'code-body', 'long-reply']);
  assert.ok(p.turns.every((t) => !t.tolerant && (t.method || 'enter') === 'enter'), 'the first five need nothing but Enter');
  assert.deepEqual(p.fallbacks.map((t) => t.method), ['ctrl-enter', 'button']);
  assert.ok(p.fallbacks.every((t) => t.tolerant));
  assert.ok(p.long.prompt.length >= 30000, 'the long message is really long');
  assert.ok(p.long.prompt.startsWith('Reply with only the word OK'), 'with the instruction first, so truncation keeps it');
  assert.ok(p.bridgePrompt.startsWith('hi'), 'the bridge turn is the plain "hi" that failed');
  const nonces = [...p.turns, ...p.fallbacks, p.long].map((t) => t.nonce).concat(p.bridgeNonce);
  assert.equal(new Set(nonces).size, nonces.length, 'every message is distinguishable');
});

test('on the page as recorded: seven messages, each once, none needing the box cleared', async () => {
  const { state, a, notes, files } = await runAll({});
  assert.deepEqual(state.via, ['enter', 'enter', 'enter', 'enter', 'enter', 'enter', 'enter'], JSON.stringify(state.via));
  assert.equal(new Set(state.sent).size, state.sent.length, 'no message sent twice');
  assert.equal(state.keys.length, 0, 'no keys pressed: the box never needed clearing');
  assert.equal(a.clearTest, null, 'no clearing test');

  const cb = byLabel(a, 'code-body').codeBody;
  assert.equal(cb.exact, true, JSON.stringify(cb.differences));
  assert.equal(cb.backslashesPreserved, true);
  const lr = byLabel(a, 'long-reply');
  assert.ok(lr.maxGrowthGapMs >= 2000);
  assert.ok(lr.answer.length > 600);

  assert.ok(!a.bridge.notSent && a.bridge.ok, `the bridge turn ran: ${a.bridge.method}`);
  assert.ok(String(a.bridge.text).includes(nonceOf(a.bridge.prompt)), 'the bridge read the reply to its own message');
  const long = byLabel(a, 'long');
  assert.equal(long.index, 7);
  assert.equal(long.long.sendRegistered, true);
  assert.equal(a.leftInBox.visible, 0);
  assert.ok(files['copilot-cli-record-all.json']);
  for (const want of ['BRIDGE TURN', 'LONG:', 'CODE BODY: EXACT', 'longest pause mid-answer']) {
    assert.ok(notes.some((l) => l.includes(want)), `summary shows "${want}"`);
  }
});

test('a long message the page will not send: its text is cleared by keys afterwards, never resent', async () => {
  const { state, a } = await runAll({ maxChars: 10000, longNeverSends: true });
  assert.equal(state.submits, 6);
  assert.equal(byLabel(a, 'long').sendNotRegistered, true);
  assert.ok(a.keyClears.some((k) => k.cleared));
  noEnterByKeys(state);
});

test('a draft already in the box: nothing is sent, no keys are pressed, and the draft is not recorded', async () => {
  const { state, files } = await runAll({ draft: 'SECRET-unsent-draft' });
  assert.equal(state.submits, 0);
  assert.equal(state.keys.length, 0, 'keys are only ever used on our own text');
  assert.ok(!files['copilot-cli-record-all.json'].includes('SECRET-unsent-draft'));
});

test('a box that truncates long text is caught by the long turn', async () => {
  const { a, notes } = await runAll({ maxChars: 10000 });
  const l = byLabel(a, 'long').long;
  assert.equal(l.truncated, true);
  assert.ok(l.held <= 10002, `held ${l.held}`);
  assert.ok(notes.some((n) => n.includes('TRUNCATED')));
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
