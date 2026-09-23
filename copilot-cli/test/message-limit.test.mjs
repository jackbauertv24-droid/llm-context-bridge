/**
 * No message longer than the page is known to take.
 *
 * RECORDED: 30,019 characters were accepted. A longer agent message left
 * Copilot's send button disabled and the text stuck in the box (live report,
 * 2026-09-23). Results are cut to fit and say how to get the rest; a task
 * that is itself too long is not sent at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResults, runAgent, MESSAGE_LIMIT } from '../lib-agent.mjs';
import { expandPrompt } from '../lib-files.mjs';

test('results that fit are unchanged', () => {
  const r = [{ name: 'read', ok: true, output: 'small' }];
  assert.ok(renderResults(r).includes('\nsmall\n'));
  assert.ok(!renderResults(r).includes('[cut:'));
});

test('one huge read is cut to fit, and the model is told how to get the rest', () => {
  const big = 'x'.repeat(150000);
  const out = renderResults([{ name: 'read', ok: true, output: big }]);
  assert.ok(out.length <= MESSAGE_LIMIT, `${out.length}`);
  assert.match(out, /\[cut: \d+ of 150000 characters shown.*lines="\.\.\."/);
  assert.ok(out.endsWith('Continue, or reply with prose and no tags if the task is done.'));
});

test('several results: the small ones are kept whole, the big ones share what is left', () => {
  const out = renderResults([
    { name: 'search', ok: true, output: 'a.mjs:1: hit' },
    { name: 'read', ok: true, output: 'y'.repeat(80000) },
    { name: 'tree', ok: true, output: 'z'.repeat(80000) },
  ]);
  assert.ok(out.length <= MESSAGE_LIMIT, `${out.length}`);
  assert.ok(out.includes('a.mjs:1: hit\n'), 'the small result is whole');
  assert.equal((out.match(/\[cut:/g) || []).length, 2);
  const ys = (out.match(/y/g) || []).length; const zs = (out.match(/z/g) || []).length;
  assert.ok(Math.abs(ys - zs) < 50, `fair shares: ${ys} vs ${zs}`);
});

test('the agent loop never sends more than the limit, and cut results still go', async () => {
  const sent = [];
  const replies = ['<copilot:read path="big.txt"/>', 'done'];
  const tools = {
    read: { summary: 'r', usage: '<copilot:read path="a"/>', describe: () => 'read', run: () => 'q'.repeat(200000) },
  };
  const ui = new Proxy({}, { get: () => () => {} });
  const res = await runAgent({
    ask: async (p) => { sent.push(p); return replies.shift(); },
    task: 'read big.txt', session: { root: process.cwd(), primed: true }, ui, tools, minTurnGapMs: 0,
  });
  assert.equal(sent.length, 2);
  for (const p of sent) assert.ok(p.length <= MESSAGE_LIMIT, `${p.length}`);
  assert.match(sent[1], /\[cut:/);
  assert.equal(res.done, true);
});

test('a task that is itself too long is not sent at all', async () => {
  const sent = [];
  const ui = new Proxy({}, { get: () => () => {} });
  const res = await runAgent({
    ask: async (p) => { sent.push(p); return 'x'; },
    task: 't'.repeat(40000), session: { root: process.cwd(), primed: true }, ui, minTurnGapMs: 0,
  });
  assert.equal(sent.length, 0);
  assert.match(res.stalled, /over the 30000 the chat is known to accept; nothing was sent/);
});

test('plain chat with attached files refuses before typing when over the limit', () => {
  const r = expandPrompt('x'.repeat(31000), { cwd: process.cwd(), maxFileBytes: 262144, maxPromptChars: 30000 });
  assert.match(r.error || '', /over the 30000 limit/);
});
