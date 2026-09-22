/**
 * One plain chat turn, which is the most basic thing this tool does.
 *
 * Every case here is a defect that actually reached the user, in the order
 * they hit it. Simple chatting broke twice in one day while the edges were
 * being hardened, and nothing caught either break, because the checks that
 * found them were throwaway scripts that were deleted afterwards. These are
 * the same checks, kept.
 *
 * The bar for adding to this file is not coverage. It is: did this stop a
 * message reaching the chat, send more than one, or send the wrong text?
 *
 * WHAT THESE CAN AND CANNOT SHOW
 *
 * Nobody here has ever seen the real Copilot page. These run against a
 * hand-written replica, so they cannot tell you the bridge works — only that
 * a fault already seen has not come back. They are regression tests, not
 * validation, and a new fault in the real page will pass every one of them.
 * That is not hypothetical: it is how each of these bugs shipped.
 *
 * What they do prove is a set of properties of this code that hold whatever
 * the page turns out to be — the text is inserted once, one keystroke
 * submits once, nothing is sent into a page that is visibly working, an echo
 * of our own prompt is never returned as an answer. Those are invariants of
 * the bridge, not claims about Copilot.
 *
 * Each replica behaviour below is labelled with where it came from. Two are
 * inferred from something the user actually saw, and the inference is strong
 * because only one mechanism produces that exact symptom. One is a guess at
 * a plausible page, and is marked as such — it guards a real class of fault
 * but nobody has observed it.
 *
 * The way to close the gap is not more of these. It is a real
 * copilot-cli-capture.json from a live turn, used as a fixture, so the
 * replica is answerable to the page instead of to my idea of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from '../lib-dom.mjs';
import { askInPage } from '../page-fn.mjs';

const CFG = {
  inputSelector: '#ed',
  sendSelector: '',
  answerSelector: '[data-testid="markdown-reply"]',
  quietMs: 400,
  answerTimeoutMs: 5000,
  preflightMs: 3000,
  busyQuietMs: 1200,
};

/**
 * A chat page.
 *   lexical        - the editor also inserts on beforeinput, as Lexical does
 *   legacyKeypress - a submit handler on keypress as well as keydown
 *   strayStop      - a control matching the stop selector that is always there
 *   generating     - a real response in flight that never finishes
 *   deadEnter      - Enter does nothing; only the send button works
 *   quiet          - no ambient churn; almost no real page is like this
 *
 * Ambient churn is on by DEFAULT and that is the point. Every real web app
 * mutates constantly — a clock, a presence dot, a re-render — and the first
 * replica sat perfectly still. A check for "is the page busy" that watched
 * for any DOM mutation therefore passed every test here and blocked every
 * message on the real page: a plain "hi" could not be sent at all, twice,
 * across two builds each claimed as fixed. A replica that is quieter than
 * reality does not test the thing that breaks.
 */
function chatPage({ lexical = false, legacyKeypress = false, strayStop = false, generating = false, deadEnter = false, quiet = false } = {}) {
  resetDom();
  const state = { submits: 0, received: null };

  if (!quiet) {
    // The clock in the corner: constant mutation, no growth in text.
    const clock = new El('div', { class: 'clock' });
    doc.body.append(clock);
    const ticking = setInterval(() => clock.setText(new Date().toISOString()), 200);
    state.stopClock = () => clearInterval(ticking);
  }

  const feed = new El('div', { role: 'feed' });
  doc.body.append(new El('div', { 'data-testid': 'MessageListContainer' })).append(feed);

  const composer = new El('div', { class: 'composer' });
  const input = new El('span', { id: 'ed', role: 'textbox', contenteditable: 'true' });
  input.rect = { x: 0, y: 800, width: 700, height: 27 };
  composer.append(input);
  const button = new El('button', { 'aria-label': 'Send' });
  composer.append(button);
  doc.body.append(composer);
  doc._editor = input;

  if (lexical) {
    input.addEventListener('beforeinput', (ev) => {
      if (ev.inputType === 'insertText' && ev.data) input.textContent = (input.innerText || '') + ev.data;
    });
  }
  if (strayStop) doc.body.append(new El('button', { 'aria-label': 'Stop sharing', 'data-testid': 'stop-x' }));

  if (generating) {
    doc.body.append(new El('button', { 'aria-label': 'Stop responding' }));
    const live = new El('div');
    feed.append(live);
    const tick = setInterval(() => live.append(new El('p', {}, 'streaming')), 200);
    state.stop = () => clearInterval(tick);
  }

  const submit = () => {
    state.submits++;
    if (state.submits > 1) return;              // count them all, act once
    state.received = input.innerText;
    input.textContent = '';
    const mine = new El('div', { 'data-testid': 'copilot-message-div' });
    mine.append(new El('div', {}, state.received));
    feed.append(mine);
    const theirs = new El('div', { 'data-testid': 'copilot-message-div' });
    const md = new El('div', { 'data-testid': 'markdown-reply' });
    md.append(new El('p', {}, 'hello back'));
    theirs.append(md);
    feed.append(theirs);
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || deadEnter) return;
    ev.preventDefault();
    submit();
  });
  if (legacyKeypress) input.addEventListener('keypress', (ev) => { if (ev.key === 'Enter') submit(); });
  button.click = () => submit();

  return state;
}

async function turn(page, prompt = 'hi', extra = {}) {
  const restore = installGlobals();
  try {
    const state = chatPage(page);
    const res = await askInPage({ ...CFG, ...extra, prompt });
    if (state.stop) state.stop();
    if (state.stopClock) state.stopClock();
    return { state, res };
  } finally { restore(); }
}

test('a plain message is sent once and answered', async () => {
  const { state, res } = await turn({});
  assert.equal(state.submits, 1, 'the page should receive exactly one submission');
  assert.equal(state.received, 'hi');
  assert.equal(res.text, 'hello back');
});

test('the prompt is not doubled by an editor that handles beforeinput', async () => {
  // OBSERVED on the real page: typing "Blast" arrived as "BlastBlast". The
  // replica's editor behaviour is inferred from that symptom — a synthetic
  // beforeinput carrying the text plus execCommand('insertText'), each
  // inserting all of it, is the only mechanism that produces exactly a
  // doubled string.
  const { state, res } = await turn({ lexical: true }, 'Blast');
  assert.equal(state.received, 'Blast');
  assert.equal(res.debug.composer.actual, res.debug.composer.expected);
  assert.equal(res.debug.composer.matched, true);
  // Not merely repaired afterwards: the insert itself must be single.
  assert.equal(res.debug.composer.corrected, false, 'the text had to be corrected, so it was inserted wrongly');
});

test('one keystroke is one submission even with a legacy keypress handler', async () => {
  // NOT OBSERVED — a guess at a plausible page. keydown, keypress and keyup
  // were all fired unconditionally, so a page carrying handlers on both
  // keydown and keypress would submit twice. Whether Copilot does that is
  // unknown; the fix is faithful to the browser either way, since a keydown
  // whose default is prevented produces no keypress.
  const { state } = await turn({ legacyKeypress: true });
  assert.equal(state.submits, 1);
});

test('a stray control matching the stop selector does not block sending', async () => {
  // OBSERVED on the real page: a plain "hi" was refused with "the page was
  // still generating" when nothing had been sent and the page was idle, and
  // it never recovered even after the user sent manually. A control matching
  // the stop selector that is permanently present is the only thing that
  // produces a refusal which never clears; its exact identity on Copilot is
  // still unknown, which is why the turn now reports what it matched.
  const { state, res } = await turn({ strayStop: true });
  assert.equal(res.notSent, undefined, 'the turn should not be refused');
  assert.equal(state.submits, 1);
  assert.equal(res.text, 'hello back');
});

test('a stray stop control does not hold the turn open to the answer timeout', async () => {
  // With a permanent stop control the exact finish signal can never fire and
  // the quiet fallback was suppressed, so every turn ran the full timeout.
  const started = Date.now();
  const { res } = await turn({ strayStop: true });
  assert.ok(Date.now() - started < 4000, `turn took ${Date.now() - started}ms`);
  assert.equal(res.debug.wait.strayStop, true);
});

test('a live page that merely ticks is not mistaken for one that is generating', async () => {
  // OBSERVED on the real page, twice: "hi" was refused with "the page was
  // still generating" while nothing had been sent and the page was idle.
  // A stray stop control plus the ordinary churn of a live app was read as
  // a response in flight. Generation grows the text; a clock does not.
  const { state, res } = await turn({ strayStop: true });
  assert.equal(res.notSent, undefined, 'a ticking idle page must not be refused');
  assert.equal(state.submits, 1);
  assert.equal(res.text, 'hello back');
});

test('a ticking page does not hold the turn open to the answer timeout', async () => {
  // The same assumption in the second place: the wait for the answer ended
  // on "the DOM went quiet", which on a ticking page is never.
  const started = Date.now();
  const { res } = await turn({ strayStop: true });
  assert.ok(Date.now() - started < 4000, `turn took ${Date.now() - started}ms`);
  assert.notEqual(res.debug.wait.via, 'timeout');
});

test('nothing is sent into a page that is still generating', async () => {
  const { state, res } = await turn({ generating: true });
  assert.equal(state.submits, 0, 'not one message may go into a working page');
  assert.equal(res.notSent, true);
  assert.equal(res.debug.wait.via, 'not-sent-page-busy');
});

test('a dead Enter falls back to the button, still sending once', async () => {
  const { state } = await turn({ deadEnter: true }, 'hi', { sendVerifyMs: 600 });
  assert.equal(state.submits, 1);
});

test('the answer is never our own prompt echoed back', async () => {
  // When the page was slow, the echo of what we sent scored best and was
  // returned as the reply. For the agent that means executing the example
  // tags in its own instructions.
  const restore = installGlobals();
  try {
    resetDom();
    const feed = new El('div', { role: 'feed' });
    doc.body.append(new El('div', { 'data-testid': 'MessageListContainer' })).append(feed);
    const input = new El('span', { id: 'ed', role: 'textbox', contenteditable: 'true' });
    input.rect = { x: 0, y: 800, width: 700, height: 27 };
    doc.body.append(new El('div', { class: 'composer' })).append(input);
    doc._editor = input;
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const sent = input.innerText;
      input.textContent = '';
      const mine = new El('div', { 'data-testid': 'copilot-message-div' });
      mine.append(new El('div', {}, sent));
      feed.append(mine);                        // the echo, and nothing else
    });
    const res = await askInPage({ ...CFG, answerTimeoutMs: 2500, prompt: 'what is the status of the build' });
    assert.notEqual(res.text, 'what is the status of the build');
    assert.equal(res.text, '');
  } finally { restore(); }
});

test('an editor that anchors with zero-width characters still sends', async () => {
  // OBSERVED, from a recording of the real page: inserting the four letters
  // "ping" left six characters in the composer. Rich editors anchor their
  // selection with zero-width characters, which are not whitespace, so the
  // text never compared equal to the prompt and every turn was refused —
  // and reported as though the page were still generating.
  const restore = installGlobals();
  try {
    resetDom();
    const feed = new El('div', { role: 'feed' });
    doc.body.append(new El('div', { 'data-testid': 'MessageListContainer' })).append(feed);
    const input = new El('span', { id: 'ed', role: 'textbox', contenteditable: 'true' });
    input.rect = { x: 0, y: 800, width: 700, height: 27 };
    doc.body.append(new El('div', { class: 'composer' })).append(input);
    doc._editor = input;

    // The editor wraps whatever is typed in zero-width anchors.
    const realSetText = input.setText ? input.setText.bind(input) : null;
    Object.defineProperty(input, 'innerText', {
      get() {
        const raw = this.children.length
          ? this.children.map((c) => c.innerText).filter((t) => t !== '').join('\n')
          : this._text;
        return raw ? `​${raw}​` : raw;
      },
      set(v) { this.children = []; this._text = v; },
      configurable: true,
    });
    void realSetText;

    let received = null;
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      received = input.innerText;
      input.textContent = '';
      const t = new El('div', { 'data-testid': 'copilot-message-div' });
      const md = new El('div', { 'data-testid': 'markdown-reply' });
      md.append(new El('p', {}, 'hello back'));
      t.append(md);
      feed.append(t);
    });

    const res = await askInPage({ ...CFG, prompt: 'hi' });
    assert.equal(res.notSent, undefined, 'a message must not be refused over invisible characters');
    assert.ok(received, 'the page should have received the message');
    assert.equal(res.debug.composer.matched, true);
    assert.equal(res.text, 'hello back');
  } finally { restore(); }
});
