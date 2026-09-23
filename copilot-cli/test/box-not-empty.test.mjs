/**
 * The bridge never types on top of text it could not clear.
 *
 * RECORDED (2026-09-23): on the real page, the bridge's way of clearing the
 * box leaves the text where it is, and typing then inserts at the caret — so
 * a leftover would go out in front of the next prompt. The editor here does
 * what the recording showed: direct writes are put back, and a delete made
 * in the same instant as the selection does nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from '../lib-dom.mjs';
import { askInPage } from '../page-fn.mjs';

function page(initial) {
  resetDom();
  const state = { submits: 0 };
  const composer = new El('div', {});
  const input = new El('span', { id: 'm365-chat-editor-target-element', role: 'textbox', contenteditable: 'true' });
  input.rect = { x: 735, y: 495, width: 704, height: 27 };
  composer.append(input);
  doc.body.append(composer);
  doc._editor = input;
  input._text = initial;
  Object.defineProperty(input, 'innerText', {
    get() { return this._text ? `​${this._text}​` : this._text; },
    set() {},
    configurable: true,
  });
  Object.defineProperty(input, 'textContent', { get() { return this._text; }, set() {}, configurable: true });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); state.submits++; } });
  return state;
}

async function ask(initial) {
  const restore = installGlobals();
  const saved = doc.execCommand;
  doc.execCommand = (cmd, _u, arg) => {
    const el = doc._editor;
    if (cmd === 'insertText') { el._text = `${el._text || ''}${arg}`; return true; }
    return false;                                   // RECORDED: delete does nothing
  };
  try {
    const state = page(initial);
    const res = await askInPage({ inputSelector: '#m365-chat-editor-target-element', prompt: 'hi', quietMs: 300, answerTimeoutMs: 3000, sendVerifyMs: 1000 });
    return { state, res };
  } finally { doc.execCommand = saved; restore(); }
}

test('leftover text in the box: nothing typed on top, nothing sent, and the reason given', async () => {
  const { state, res } = await ask('left over from before');
  assert.equal(state.submits, 0);
  assert.equal(res.notSent, true);
  assert.match(res.method, /already holds 21 characters/);
  assert.ok(!res.badComposer, 'this is not reported as a bug in the bridge');
});

test('an empty box (only the invisible anchors) is not refused', async () => {
  const { state, res } = await ask('');
  assert.ok(!/already holds/.test(res.method || ''), res.method);
  assert.equal(state.submits >= 1, true, 'the message was sent');
});
