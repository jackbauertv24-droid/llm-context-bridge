/**
 * The page function, run against a replica of the real Copilot DOM.
 *
 * The structure here is not invented: it is what the live probe and the turn
 * diagnostics showed — a feed of div[data-testid="copilot-message-div"] turn
 * containers, the reply text inside div[data-testid="markdown-reply"] as
 * streamed <p> elements, suggestion chips as sibling buttons, and a
 * contenteditable span#m365-chat-editor-target-element as the composer.
 *
 * Every case below is a failure that actually happened and cost a manual run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from './dom-shim.mjs';
import { askInPage } from '../page-fn.mjs';

const CFG = {
  inputSelector: '#m365-chat-editor-target-element',
  sendSelector: '',
  answerSelector: '[data-testid="markdown-reply"]',
  quietMs: 60,
  answerTimeoutMs: 3000,
};

const PARAS = [
  "I'm responding normally and the conversation context is intact.",
  'Everything looks fine on my side.',
  'Feel free to throw a more interesting test at me.',
];
const CHIPS = ['Can you tell me a fun fact?', 'What’s the meaning of life?', 'Show me a random joke'];

/**
 * @param {object} opts
 *   replyIntoExisting - stream into a markdown-reply that was already present
 *                       when the prompt was sent, rather than a new one.
 *   chipsAsOwnTurn    - the chips arrive as their own turn container beside
 *                       the reply, which is how the live page did it.
 *   dead              - the page does nothing at all (send did not register).
 */
function buildCopilotPage({ replyIntoExisting = false, dead = false, chipsAsOwnTurn = false } = {}) {
  resetDom();
  const body = doc.body;

  const listContainer = new El('div', { 'data-testid': 'MessageListContainer' });
  const feed = new El('div', { role: 'feed', 'aria-label': 'Chat conversation' });
  listContainer.append(feed);
  body.append(listContainer);

  // An earlier exchange, so the page is not empty when we send.
  const oldTurn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-old' });
  const oldReply = new El('div', { 'data-testid': 'markdown-reply' });
  const oldInner = new El('div');
  oldInner.append(new El('p', {}, 'Hi! How can I help? 👋'));
  oldReply.append(oldInner);
  oldTurn.append(oldReply);
  feed.append(oldTurn);

  // The composer, as the probe found it.
  const wrap = new El('div', { class: 'fai-BebopLiteChatInput' });
  const input = new El('span', {
    id: 'm365-chat-editor-target-element',
    role: 'textbox',
    contenteditable: 'true',
    'aria-label': 'Message Copilot',
  });
  input.rect = { x: 140, y: 833, width: 704, height: 27 };
  wrap.append(input);
  body.append(wrap);
  doc._editor = input;

  let existingReply = null;
  if (replyIntoExisting) {
    const turn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-pending' });
    existingReply = new El('div', { 'data-testid': 'markdown-reply' });
    turn.append(existingReply);
    feed.append(turn);
  }

  let sent = false;
  input.onKey = (ev) => {
    if (ev.key !== 'Enter' || sent || dead) return;
    sent = true;
    const prompt = input.innerText;
    input.textContent = '';                      // the real page clears the composer

    const userTurn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageUser-1' });
    userTurn.append(new El('div', {}, prompt));  // one outermost insertion carrying our echo
    feed.append(userTurn);

    setTimeout(() => {
      let inner;
      let container;
      if (existingReply) { container = existingReply.parentElement; inner = new El('div'); existingReply.append(inner); }
      else {
        container = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-new' });
        feed.append(container);
        const md = new El('div', { 'data-testid': 'markdown-reply' });
        inner = new El('div');
        md.append(inner);
        container.append(md);
      }
      let i = 0;
      const stream = () => {
        if (i < PARAS.length) { inner.append(new El('p', {}, PARAS[i++])); setTimeout(stream, 8); return; }
        const chips = new El('div');
        for (const c of CHIPS) chips.append(new El('button', { 'data-testid': 'chat-suggestion' }, c));
        if (chipsAsOwnTurn) {
          const chipTurn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-suggestions' });
          chipTurn.append(chips);
          feed.append(chipTurn);
        } else {
          container.append(chips);
        }
      };
      setTimeout(stream, 8);
    }, 8);
  };

  return { input, feed };
}

test('the answer is the reply text, not the suggestion chips', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage();
    const res = await askInPage({ ...CFG, prompt: 'are you ok?' });
    assert.equal(res.ok, true);
    assert.equal(res.text, PARAS.join('\n'));
    for (const chip of CHIPS) assert.ok(!res.text.includes(chip), `chip leaked into the answer: ${chip}`);
  } finally { restore(); }
});

test('the answer keeps its first characters', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage();
    const res = await askInPage({ ...CFG, prompt: 'are you ok?' });
    assert.ok(res.text.startsWith("I'm responding normally"),
      `answer was truncated at the start: ${JSON.stringify(res.text.slice(0, 40))}`);
  } finally { restore(); }
});

test('our own prompt is never returned as the answer', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage();
    const res = await askInPage({ ...CFG, prompt: 'are you ok?' });
    assert.ok(!res.text.includes('are you ok?'));
  } finally { restore(); }
});

test('a reply streamed into a block that already existed is still found', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage({ replyIntoExisting: true });
    const res = await askInPage({ ...CFG, prompt: 'are you ok?' });
    assert.equal(res.text, PARAS.join('\n'));
  } finally { restore(); }
});

test('every strategy is recorded, so one run explains itself', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage();
    const res = await askInPage({ ...CFG, prompt: 'are you ok?' });
    const names = res.debug.candidates.map((c) => c.name);
    assert.ok(names.includes('answer-selector/new'), 'selector strategy missing');
    assert.ok(names.includes('added-node'), 'added-node strategy missing');
    assert.ok(names.includes('body-suffix'), 'body-suffix strategy missing');
    assert.match(res.method, /answer-selector/, 'the selector strategy should win here');
  } finally { restore(); }
});

test('a chips-only candidate is scored as page furniture', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage({ chipsAsOwnTurn: true });
    const res = await askInPage({ ...CFG, prompt: 'are you ok?' });
    assert.equal(res.text, PARAS.join('\n'), 'the reply must still win');
    const chippy = res.debug.candidates.filter((c) => c.mostlyButtons);
    assert.ok(chippy.length > 0, 'the chips block should be seen and marked');
    for (const c of chippy) assert.ok(c.score < 0, 'button text must never outscore an answer');
  } finally { restore(); }
});

test('the DOM capture is written, so a bad pick is fixable without another run', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage();
    const res = await askInPage({ ...CFG, prompt: 'are you ok?' });
    assert.ok(res.debug.capture, 'no capture');
    assert.match(res.debug.capture.region, /MessageListContainer|feed/);
    const flat = JSON.stringify(res.debug.capture.tree);
    assert.match(flat, /markdown-reply/, 'the capture must contain the answer element');
    assert.match(flat, /chat-suggestion/, 'and the furniture it competed with');
  } finally { restore(); }
});

test('a send that does not register says so instead of inventing an answer', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage({ dead: true });
    const res = await askInPage({ ...CFG, prompt: 'are you ok?', answerTimeoutMs: 900 });
    assert.ok(res.debug.steps.some((s) => /WARNING: no new answer block/.test(s)),
      'a dead send must be reported as a send problem, not a selector problem');
    assert.ok(!res.text.includes('are you ok?'));
  } finally { restore(); }
});

test('a wrong answer selector falls back instead of returning nothing', async () => {
  const restore = installGlobals();
  try {
    buildCopilotPage();
    const res = await askInPage({ ...CFG, answerSelector: '[data-testid="renamed-by-microsoft"]', prompt: 'are you ok?' });
    assert.ok(res.text.includes(PARAS[0]), `fallback produced: ${JSON.stringify(res.text.slice(0, 60))}`);
  } finally { restore(); }
});
