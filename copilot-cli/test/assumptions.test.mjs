/**
 * The rule from ASSUMPTIONS.md, enforced.
 *
 * Every outage in this bridge has been a check refusing to send on the
 * strength of a belief about a page nobody here can see. The rule is that a
 * check may only block if a recording supports it, and a rule nobody checks
 * is a rule that lapses.
 *
 * So: enumerate the ways a message can fail to be sent, and require each to
 * be justified by a field in the recording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const pageFn = fs.readFileSync(path.join(here, '..', 'page-fn.mjs'), 'utf8');
const record = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'copilot-web-2026-09-22.json'), 'utf8'));

test('every way of refusing to send is one of the justified ones', () => {
  // Each `notSent: true` in the page function must carry a via: that is on
  // the list, so a new refusal cannot be added without appearing here.
  const reasons = [...pageFn.matchAll(/via: '(not-sent-[a-z-]+)'/g)].map((m) => m[1]);
  const allowed = ['not-sent-page-busy', 'not-sent-bad-composer', 'not-sent-box-not-empty'];
  for (const r of reasons) {
    assert.ok(allowed.includes(r), `a new refusal "${r}" was added without being justified in ASSUMPTIONS.md`);
  }
  const refusals = (pageFn.match(/notSent: true/g) || []).length;
  assert.equal(refusals, allowed.length, `there should be ${allowed.length} refusal paths, found ${refusals}`);
});

test('refusing over a busy page is backed by the recording', () => {
  // It rests on two things: a stop control that appears while generating,
  // and text that grows while generating and not while idle.
  assert.equal(typeof record.turn.stopAppearedAt, 'number', 'the recording must show a stop control appearing');
  assert.equal(typeof record.turn.stopGoneAt, 'number', 'and going away again');
  assert.equal(record.idle.charGrowth, 0, 'and the page must be shown not to grow while idle');
  const growth = record.turn.timeline.filter((e) => e.what === 'text grew');
  assert.ok(growth.length >= 3, 'and to grow while answering');

  assert.ok(pageFn.includes('growthChars'), 'the check must use growth, not mere mutation');
  assert.ok(pageFn.includes('stopNow()'), 'and the stop control');
});

test('refusing over the composer is limited to empty or doubled', () => {
  // The recording shows this page both pads with invisible characters and
  // strips markdown markers, so anything stricter than these two would
  // refuse a correct prompt.
  assert.ok(pageFn.includes('ratio > 1.8'), 'doubling must be the upper test');
  assert.ok(pageFn.includes('inBox.length === 0'), 'and empty the lower one');
  assert.ok(!/ratio < 0\.[1-9]/.test(pageFn), 'no ratio threshold in between: that is what stopped the agent');
});

test('the recording covers the payload the agent actually sends', () => {
  // A recording of a four-letter word said nothing about a long markdown
  // prompt, which is how assumption 8 was missed.
  assert.ok(fs.readFileSync(path.join(here, '..', 'chat.mjs'), 'utf8').includes('--as-agent'),
    'there must be a way to record with the real agent prompt');
  const rec = fs.readFileSync(path.join(here, '..', 'lib-record.mjs'), 'utf8');
  assert.ok(rec.includes('bulletLines') && rec.includes('headingLines') && rec.includes('fenceLines'),
    'the recording must count the markdown the editor might strip');
  assert.ok(rec.includes('explains'), 'and report how much of a shortfall they account for');
});

test('the assumptions file lists every blocking assumption', () => {
  const doc = fs.readFileSync(path.join(here, '..', 'ASSUMPTIONS.md'), 'utf8');
  for (const needed of ['stop control appears while generating', 'gains text while generating',
    'arriving twice over', 'empty composer']) {
    assert.ok(doc.toLowerCase().includes(needed.toLowerCase().slice(0, 24)),
      `ASSUMPTIONS.md should describe: ${needed}`);
  }
  assert.ok(doc.includes('GUESSED'), 'and keep the three evidence levels');
});
