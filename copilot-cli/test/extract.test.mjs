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
import { installGlobals } from '../lib-dom.mjs';
import { askInPage } from '../page-fn.mjs';
import { CFG, PARAS, CHIPS, buildCopilotPage } from './copilot-page.mjs';

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
