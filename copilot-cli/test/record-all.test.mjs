/**
 * The --record-chat command, run end to end before it is used once.
 *
 * Real skill registry, real agent prompt, both turns recorded against a page
 * with every behaviour the real one has shown, the analysis and the bundle
 * written — with only the tab stood in for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from '../lib-dom.mjs';
import { runRecordAllWith, buildProbeTurns } from '../lib-record-run.mjs';
import { createDefaultRegistry } from '../lib-skills.mjs';

function realisticPage() {
  resetDom();
  const state = { submits: 0 };
  const feed = new El('div', {});
  doc.body.append(feed);
  const composer = new El('div', { class: 'fai-BebopLiteChatInput' });
  const input = new El('span', { id: 'm365-chat-editor-target-element', role: 'textbox', contenteditable: 'true' });
  input.rect = { x: 735, y: 495, width: 704, height: 27 };
  composer.append(input);
  composer.append(new El('button', { 'aria-label': 'Send' }));
  doc.body.append(composer);
  doc._editor = input;
  Object.defineProperty(input, 'innerText', {
    get() { const raw = this.children.length ? this.children.map((c) => c.innerText).join('\n') : this._text; return raw ? `​${raw}​` : raw; },
    set(v) { this.children = []; this._text = v; },
    configurable: true,
  });
  let turn = 0;
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    state.submits++; turn++;
    const sent = input._text || '';
    setTimeout(() => { input._text = ''; }, 500);
    const stop = new El('button', { 'aria-label': 'Stop responding' });
    setTimeout(() => doc.body.append(stop), 500);
    setTimeout(() => { const e = new El('div', {}); e.append(new El('div', {}, sent.split('\n').join(''))); feed.append(e); }, 600);
    const reply = new El('div', { 'data-testid': 'lastChatMessage' });
    const md = new El('div', { 'data-testid': 'markdown-reply' });
    reply.append(md);
    setTimeout(() => feed.append(reply), 800);
    const lines = turn === 1 ? ['I’ll list the files.', 'Plain Text', '1', '<copilot:list path="."/>'] : ['Those are the files.'];
    lines.forEach((l, i) => setTimeout(() => md.append(new El('p', {}, l)), 1000 + i * 250));
    setTimeout(() => { stop.rect = { x: 0, y: 0, width: 0, height: 0 }; }, 1000 + lines.length * 250 + 200);
  });
  return state;
}

const CONFIG = {
  inputSelector: '#m365-chat-editor-target-element',
  answerSelector: '[data-testid="markdown-reply"]',
  perTurnMs: 20000, idleMaxMs: 8000, registerMs: 4000,
};

test('the probe turns are the real agent prompt and a real tool result', () => {
  const { turns, long } = buildProbeTurns({ registry: createDefaultRegistry(), root: process.cwd() });
  const agent = turns.find((t) => t.label === 'agent-prompt');
  const result = turns.find((t) => t.label === 'tool-result');
  assert.ok(agent.prompt.includes('TOOLS') && agent.prompt.includes('<copilot:list'), 'the real agent instructions');
  assert.ok(agent.prompt.length > 1500, 'at the real size');
  assert.ok(result.prompt.includes('<copilot:result tool="list"'), 'the real shape of a tool result');
  for (const t of [...turns, long]) assert.ok(t.prompt.includes(t.nonce), 'each carries its own marker');
});

test('the whole command runs, sends each message once and writes the bundle', async () => {
  const restore = installGlobals();
  const notes = [];
  const files = {};
  let state;
  try {
    state = realisticPage();
    const bundle = await runRecordAllWith({
      evalFn: (fn, arg) => fn(arg),
      note: (l) => notes.push(l),
      write: (f, t) => { files[f] = t; },
      registry: createDefaultRegistry(),
      root: process.cwd(),
      config: CONFIG,
      version: 'test',
    });
    // This page sends on any Enter, Ctrl or not, and its Send button does
    // nothing: seven by the keyboard, the bridge's turn, and the long one.
    assert.equal(state.submits, 8, 'one per message that registers, never a repeat');
    assert.equal(bundle.stages.conversation.turns.length, 7);
    assert.deepEqual(bundle.stages.analysis.turns[0].answer.bridgeParses, ['list'], 'the real parser reads the real-shaped reply');
    assert.equal(bundle.stages.confluence, undefined, 'mail and Confluence are not part of this recording');
    assert.equal(bundle.stages.mail, undefined);
    assert.ok(files['copilot-cli-record-all.json'], 'the bundle is written');
    const onDisk = JSON.parse(files['copilot-cli-record-all.json']);
    assert.ok(onDisk.finished, 'and written again at the end, complete');
    assert.ok(notes.some((l) => l.includes('BRIDGE PARSES: list')), 'the answer is printed in the terminal');
  } finally { restore(); }
});

test('if the recording call dies, what it had got to is still collected', async () => {
  const restore = installGlobals();
  try {
    realisticPage();
    let calls = 0;
    const bundle = await runRecordAllWith({
      evalFn: async (fn, arg) => {
        calls++;
        if (calls === 1) {
          fn(arg);                                   // starts and publishes as it goes
          await new Promise((r) => setTimeout(r, 6000));
          throw new Error('Runtime.evaluate timed out');
        }
        return fn(arg);
      },
      note: () => {},
      write: () => {},
      registry: createDefaultRegistry(),
      root: process.cwd(),
      config: CONFIG,
      version: 'test',
    });
    assert.ok(bundle.stages.conversation, 'the partial recording was collected from the page');
    assert.equal(bundle.stages.conversation.kind, 'conversation-recording');
  } finally { restore(); }
});
