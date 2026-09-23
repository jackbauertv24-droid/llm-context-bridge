/**
 * Typing, line breaks and the end of a turn, on an editor built from the
 * 2026-09-23 recording:
 *
 *   - text typed with line breaks arrives with every one removed
 *     (held = typed − newlines, on all five multi-line messages)
 *   - the box shows what was typed only a moment later (the bridge read 0)
 *   - text written into it directly is ignored
 *   - the stop button is a button labelled "Stop generating", and it can
 *     stay up long after the reply has finished (50 s after "OK")
 *
 * What insertLineBreak does on the real page is not recorded, so each
 * possibility is a switch: it adds a line, it is ignored, or it is taken as
 * "send". In every case the message must go exactly once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from '../lib-dom.mjs';
import { askInPage } from '../page-fn.mjs';

function page({ lineBreak = 'works', lingerMs = 0, strayTestid = false } = {}) {
  resetDom();
  const state = { submits: 0, sent: [] };
  const feed = new El('div', {});
  doc.body.append(feed);
  const composer = new El('div', {});
  const input = new El('span', { id: 'm365-chat-editor-target-element', role: 'textbox', contenteditable: 'true' });
  input.rect = { x: 735, y: 495, width: 704, height: 27 };
  composer.append(input);
  doc.body.append(composer);
  doc._editor = input;
  if (strayTestid) {
    // Not a button, always visible, test id containing "stop".
    const d = new El('div', { 'data-testid': 'stopwatch-widget' });
    d.rect = { x: 0, y: 0, width: 20, height: 20 };
    doc.body.append(d);
  }

  let model = '';                       // what the editor holds
  let shown = '';                       // what the DOM shows, a moment later
  const render = () => setTimeout(() => { shown = model; }, 80);
  Object.defineProperty(input, 'innerText', {
    get() { return shown ? `​${shown}​` : ''; },
    set() {},
    configurable: true,
  });
  Object.defineProperty(input, 'textContent', { get() { return shown; }, set() {}, configurable: true });

  const submit = () => {
    if (!model) return;
    state.submits++; state.sent.push(model);
    const sent = model;
    setTimeout(() => { model = ''; shown = ''; }, 300);
    const stop = new El('button', { 'aria-label': 'Stop generating' });
    setTimeout(() => doc.body.append(stop), 300);
    const reply = new El('div', { 'data-testid': 'lastChatMessage' });
    const md = new El('div', { 'data-testid': 'markdown-reply' });
    reply.append(md);
    setTimeout(() => feed.append(reply), 500);
    const lines = sent.includes('\n') ? [`I got ${sent.split('\n').length} lines.`] : ['Hi! 👋'];
    lines.forEach((l, i) => setTimeout(() => md.append(new El('p', {}, l)), 900 + i * 200));
    setTimeout(() => { stop.rect = { x: 0, y: 0, width: 0, height: 0 }; }, 1400 + lingerMs);
  };

  doc.execCommand = (cmd, _u, arg) => {
    if (cmd === 'insertText') { model += String(arg).replace(/\r?\n/g, ''); render(); return true; }   // RECORDED
    if (cmd === 'insertLineBreak') {
      if (lineBreak === 'works') { model += '\n'; render(); }
      if (lineBreak === 'sends') submit();
      return true;
    }
    return false;
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
  return state;
}

async function ask(prompt, opts) {
  const restore = installGlobals();
  const saved = doc.execCommand;
  try {
    const state = page(opts);
    const t0 = Date.now();
    const res = await askInPage({ inputSelector: '#m365-chat-editor-target-element', answerSelector: '[data-testid="markdown-reply"]', prompt, quietMs: 1500, answerTimeoutMs: 60000 });
    return { state, res, ms: Date.now() - t0 };
  } finally { doc.execCommand = saved; restore(); }
}

const PROMPT = 'line one\nline two\n\n    indented line four';

test('where a line break can be inserted, the message goes once with every line break in it', async () => {
  const { state, res } = await ask(PROMPT, { lineBreak: 'works' });
  assert.equal(state.submits, 1);
  assert.equal(state.sent[0].replace(/^\n/, ''), PROMPT, 'exactly the prompt, line breaks and indentation intact');
  assert.equal(res.debug.lineBreaks.method, 'insertLineBreak between lines');
  // The line break from the check in the empty box stays at the start: one
  // blank line ahead of the message, which is harmless.
  assert.ok(state.sent[0].startsWith('\n'));
  assert.equal(res.text, 'I got 5 lines.', res.method);
});

test('where it is ignored, the message goes once as one line, exactly as before', async () => {
  const { state, res } = await ask(PROMPT, { lineBreak: 'ignored' });
  assert.equal(state.submits, 1);
  assert.equal(state.sent[0], PROMPT.replace(/\n/g, ''));
  assert.match(res.debug.lineBreaks.method, /typed whole/);
});

test('where it is taken as "send", the empty box sends nothing, and the message goes once', async () => {
  const { state } = await ask(PROMPT, { lineBreak: 'sends' });
  assert.equal(state.submits, 1, 'the probe in the empty box sent nothing');
  assert.equal(state.sent[0], PROMPT.replace(/\n/g, ''));
});

test('"hi" on an editor that shows text a moment late: no second write, sent once, not doubled', async () => {
  const { state, res } = await ask('hi (probe-abc123)', {});
  assert.equal(state.submits, 1);
  assert.equal(state.sent[0], 'hi (probe-abc123)');
  assert.ok(!res.debug.steps.some((s) => /setting the text directly/.test(s)), res.debug.steps.join(' | '));
  assert.equal(res.text, 'Hi! 👋');
});

test('a stop button left up long after the reply: the turn ends about 12 s after the text stops, not 30', async () => {
  const { res, ms } = await ask('hi (probe-abc123)', { lingerMs: 50000 });
  assert.equal(res.text, 'Hi! 👋');
  assert.equal(res.debug.wait.via, 'stale-stop-control');
  assert.ok(ms < 20000, `took ${ms}ms`);
});

test('an element that is not a button, with "stop" in its test id, does not hold the turn open', async () => {
  const { res, ms } = await ask('hi (probe-abc123)', { strayTestid: true });
  assert.equal(res.debug.wait.via, 'stop-control-gone');
  assert.ok(ms < 8000, `took ${ms}ms`);
});
