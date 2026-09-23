/**
 * The comprehensive recording, checked before it is used — because it is
 * used once.
 *
 * The page here combines every behaviour the real one has shown: input
 * padded with invisible anchors and Enter consumed (the recording), a sent
 * message echoed with its newlines removed (a transcript: "executesfor
 * you"), replies wrapped in a "Plain Text" caption and a line-number gutter
 * (transcripts), a stop control that appears and then goes, text arriving
 * in bursts. And a conversation that already holds private content, which
 * must not leave in the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from '../lib-dom.mjs';
import { recordConversation } from '../lib-record.mjs';
import { analyseConversation } from '../lib-record-analyse.mjs';
import { tools as fileTools } from '../lib-fstools.mjs';

const SECRETS = ['SECRET-earlier-mail-subject', 'SECRET-earlier-reply-body', 'SECRET-unsent-draft'];

function hostilePage({ busy = false, stuckDraft = false, deadEnter = false } = {}) {
  resetDom();
  const state = { submits: 0 };
  const feed = new El('div', {});
  doc.body.append(feed);

  // Earlier conversation, private.
  const old = new El('div', { 'data-testid': 'lastChatMessage' });
  const oldMd = new El('div', { 'data-testid': 'markdown-reply' });
  oldMd.append(new El('p', {}, SECRETS[0]));
  oldMd.append(new El('p', {}, SECRETS[1]));
  old.append(oldMd);
  feed.append(old);

  const composer = new El('div', { class: 'fai-BebopLiteChatInput' });
  const input = new El('span', { id: 'm365-chat-editor-target-element', role: 'textbox', contenteditable: 'true' });
  input.rect = { x: 735, y: 495, width: 704, height: 27 };
  composer.append(input);
  composer.append(new El('button', { 'aria-label': 'Attach' }));
  doc.body.append(composer);
  doc._editor = input;

  // RECORDED: anchors around whatever is typed.
  Object.defineProperty(input, 'innerText', {
    get() {
      const raw = this.children.length ? this.children.map((c) => c.innerText).join('\n') : this._text;
      return raw ? `​${raw}​` : raw;
    },
    set(v) {
      // A draft that the page refuses to let go of.
      if (stuckDraft && !v) return;
      this.children = []; this._text = v;
    },
    configurable: true,
  });
  if (stuckDraft) {
    // Truly stuck: neither route to emptying the box works.
    input._text = SECRETS[2];
    Object.defineProperty(input, 'textContent', {
      get() { return this._text; },
      set() { /* refuses */ },
      configurable: true,
    });
  }

  if (busy) {
    doc.body.append(new El('button', { 'aria-label': 'Stop responding' }));
    const live = new El('p', {});
    feed.append(live);
    const tick = setInterval(() => live.setText(`${live._text || ''}streaming text arriving `), 200);
    state.stop = () => clearInterval(tick);
  }

  let turn = 0;
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || deadEnter) return;
    ev.preventDefault();                                   // RECORDED
    state.submits++;
    turn++;
    const sent = input._text || '';
    setTimeout(() => { input._text = ''; input.children = []; }, 600);
    const stop = new El('button', { 'aria-label': 'Stop responding', 'data-testid': 'stop-generating' });
    setTimeout(() => doc.body.append(stop), 600);
    setTimeout(() => {                                     // OBSERVED: newlines dropped
      const echo = new El('div', { 'data-testid': 'user-message' });
      echo.append(new El('div', {}, sent.split('\n').join('')));
      feed.append(echo);
    }, 700);
    const reply = new El('div', { 'data-testid': 'lastChatMessage', id: `response-id_${turn}` });
    const md = new El('div', { 'data-testid': 'markdown-reply' });
    reply.append(md);
    setTimeout(() => feed.append(reply), 900);
    const lines = turn === 1
      ? ['I’ll list the files.', 'Plain Text', '1', '<copilot:list path="."/>']   // OBSERVED chrome
      : ['The folder holds README.md, chat.mjs and a test directory.'];
    lines.forEach((line, i) => setTimeout(() => {
      if (line === 'Plain Text') {
        const pre = new El('pre', {});
        pre.append(new El('code', {}, 'Plain Text'));
        md.append(pre);
      } else md.append(new El('p', {}, line));
    }, 1100 + i * 300));
    setTimeout(() => { stop.rect = { x: 0, y: 0, width: 0, height: 0 }; }, 1100 + lines.length * 300 + 200);
  });
  return state;
}

const CFG = {
  inputSelector: '#m365-chat-editor-target-element',
  answerSelector: '[data-testid="markdown-reply"]',
  perTurnMs: 20000,
  idleMaxMs: 8000,
  registerMs: 4000,
};
const TURNS = [
  { prompt: 'You are an agent.\n\nTOOLS\n- read\n- list\n\nTASK: list the files here (probe-aaa111)', nonce: 'probe-aaa111' },
  { prompt: '<copilot:result tool="list" status="ok">\nREADME.md\n</copilot:result>\n(probe-bbb222)', nonce: 'probe-bbb222' },
];

async function run(opts) {
  const restore = installGlobals();
  try {
    const state = hostilePage(opts);
    const rec = await recordConversation({ ...CFG, turns: TURNS });
    if (state.stop) state.stop();
    return { state, rec };
  } finally { restore(); }
}

test('two turns are recorded, with exactly two messages sent', async () => {
  const { state, rec } = await run({});
  assert.equal(state.submits, 2, 'exactly one submission per turn');
  assert.equal(rec.turns.length, 2);
  for (const t of rec.turns) assert.ok(!t.skipped, `turn ${t.index} was skipped: ${t.skipped}`);
});

test('it captures the composer, the echo, the reply and the stop control', async () => {
  const { rec } = await run({});
  const [t1, t2] = rec.turns;
  assert.ok(t1.composerHeld.text.includes('probe-aaa111'), 'the composer text, as the page holds it');
  assert.ok(t1.composerHeld.text.includes('​'), 'with the invisible anchors intact');
  assert.ok(t1.echo && t1.echo.text.includes('probe-aaa111'), 'the echo of the sent message');
  assert.ok(t1.answer.text.includes('<copilot:list'), 'the reply text');
  assert.ok(/<pre/.test(t1.answer.html), 'and its HTML, which shows how code blocks are built');
  assert.equal(t1.stopControl[0].ariaLabel, 'Stop responding', 'the actual stop control, not just when it appeared');
  assert.ok(t2.answer.text.includes('README.md'), 'the second reply');
  assert.notEqual(t1.answer.text, t2.answer.text, 'the second turn reads the new answer, not the old one');
});

test('the analysis answers the questions that matter', async () => {
  const { rec } = await run({});
  const a = analyseConversation(rec, fileTools);
  const [t1] = a.turns;
  assert.equal(t1.echo.matchesSquashed, true, 'the echo is recognised once spaces are ignored');
  assert.equal(t1.echo.matchesWithSpaces, false, 'and the analysis shows a space-based match would miss it');
  assert.equal(t1.answer.plainTextCaption, true);
  assert.equal(t1.answer.gutterLines, 1);
  assert.deepEqual(t1.answer.bridgeParses, ['list'], 'the bridge parser finds the tag in the reply as the page returns it');
  assert.equal(a.secondTurnReadsNewAnswer, true);
});

test('nothing from the earlier conversation leaves in the recording', async () => {
  const { rec } = await run({});
  const json = JSON.stringify(rec);
  for (const s of SECRETS) assert.ok(!json.includes(s), `leaked: ${s}`);
});

test('nothing is sent into a page that is still generating', async () => {
  const { state, rec } = await run({ busy: true });
  assert.equal(state.submits, 0);
  assert.ok(rec.turns[0].skipped, 'the first turn should be skipped');
  assert.equal(rec.turns.length, 1, 'and no further turn attempted');
});

test('a draft that cannot be cleared is neither read nor sent', async () => {
  const { state, rec } = await run({ stuckDraft: true });
  assert.equal(state.submits, 0, 'typing on top of a draft would send it');
  assert.ok(rec.turns[0].skipped);
  assert.ok(!JSON.stringify(rec).includes(SECRETS[2]), 'the draft must not be captured');
});

test('a send that does not register ends the recording without a retry', async () => {
  const { rec } = await run({ deadEnter: true });
  assert.equal(rec.turns.length, 1, 'the second turn must not be attempted');
  assert.equal(rec.turns[0].sendNotRegistered, true);
});
