/**
 * The bridge, against a page built from a recording of the real one.
 *
 * These are the only checks here that are not somebody's idea of how the
 * page behaves. The element ids and classes, the fact that four typed
 * characters leave six in the composer, that Enter is consumed, that nothing
 * mutates while idle, and the exact milliseconds at which the composer
 * clears, a stop control appears and vanishes and each burst of text lands —
 * all come from test/fixtures/, written by `chat.mjs --record`.
 *
 * Re-record and drop the file in to update them. That is the point: the
 * replica is answerable to the page rather than to an argument about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installGlobals } from '../lib-dom.mjs';
import { askInPage } from '../page-fn.mjs';
import { pageFromRecord } from './page-from-record.mjs';

const dir = path.join(import.meta.dirname, 'fixtures');
const records = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.startsWith('copilot-web-') && f.endsWith('.json'))
  : [];

assert.ok(records.length, 'there should be at least one page recording to test against');

for (const file of records) {
  const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

  test(`${file}: a message is sent exactly once`, async () => {
    const restore = installGlobals();
    try {
      const state = pageFromRecord(record);
      const res = await askInPage({
        inputSelector: `#${record.chosenInput.id}`,
        sendSelector: '',
        answerSelector: record.answerSelector.selector,
        quietMs: 1500,
        answerTimeoutMs: 20000,
        prompt: 'hi',
      });
      state.cancel();
      assert.equal(res.notSent, undefined, `the turn was refused: ${res.method}`);
      assert.equal(state.submits, 1, 'exactly one submission should reach the page');
      assert.equal(res.debug.wait.submissions, 1, 'and only one attempt should have been needed');
    } finally { restore(); }
  });

  test(`${file}: the composer is judged correct despite invisible anchors`, async () => {
    const restore = installGlobals();
    try {
      const state = pageFromRecord(record);
      const res = await askInPage({
        inputSelector: `#${record.chosenInput.id}`,
        sendSelector: '',
        answerSelector: record.answerSelector.selector,
        quietMs: 1500,
        answerTimeoutMs: 20000,
        prompt: 'hi',
      });
      state.cancel();
      // The page pads two characters around whatever is typed, exactly as
      // the recording measured.
      assert.equal(state.receivedChars, 4, 'the page should see the prompt plus its own anchors');
      assert.equal(res.debug.composer.matched, true, 'and the bridge should still call that a match');
      assert.equal(res.debug.composer.corrected, false, 'without having to repair it');
    } finally { restore(); }
  });

  test(`${file}: the whole answer is collected, not the part before the stop control vanished`, async () => {
    const restore = installGlobals();
    try {
      const state = pageFromRecord(record);
      const res = await askInPage({
        inputSelector: `#${record.chosenInput.id}`,
        sendSelector: '',
        answerSelector: record.answerSelector.selector,
        quietMs: 1500,
        answerTimeoutMs: 20000,
        prompt: 'hi',
      });
      state.cancel();

      // The recording has the stop control going at 4237ms and text still
      // arriving at 5239ms. Everything after the control vanished must be in
      // the answer, or a second of every reply is lost.
      const growth = record.turn.timeline.filter((e) => e.what === 'text grew');
      const afterStopGone = growth.filter((e) => e.atMs >= record.turn.stopGoneAt);
      assert.ok(afterStopGone.length, 'this recording should contain growth after the stop control went');
      const total = growth.reduce((n, e) => n + e.by, 0);
      assert.ok(
        res.text.length >= total * 0.8,
        `only ${res.text.length} characters of about ${total} were collected`,
      );
    } finally { restore(); }
  });

  test(`${file}: the turn ends at about the speed the page answers`, async () => {
    const restore = installGlobals();
    const started = Date.now();
    try {
      const state = pageFromRecord(record);
      await askInPage({
        inputSelector: `#${record.chosenInput.id}`,
        sendSelector: '',
        answerSelector: record.answerSelector.selector,
        quietMs: 1500,
        answerTimeoutMs: 20000,
        prompt: 'hi',
      });
      state.cancel();
      const took = Date.now() - started;
      const lastGrowth = record.turn.timeline.filter((e) => e.what === 'text grew').pop().atMs;
      assert.ok(took >= lastGrowth, `finished in ${took}ms, before the page had stopped writing at ${lastGrowth}ms`);
      assert.ok(took < lastGrowth + 6000, `took ${took}ms when the page finished at ${lastGrowth}ms`);
    } finally { restore(); }
  });
}
