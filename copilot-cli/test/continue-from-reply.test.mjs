/**
 * Plain chat that got tool calls back. Live report (2026-09-23): the
 * conversation already held the agent instructions, so a plain question was
 * answered with six searches; the bridge printed them and did nothing, and
 * looked frozen. The calls are now found, and an agent run can continue from
 * that very reply without asking for it again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, parseToolTags } from '../lib-agent.mjs';
import { tools as fileTools } from '../lib-fstools.mjs';

// The reply exactly as the bridge printed it, page clutter and all.
const LIVE_REPLY = [
  "I'll locate the BPE implementation classes and startup flow first.",
  '', 'Plain Text', '1', '<copilot:search query="BuyingPower" path="borg-master" context="3"/>',
  'Plain Text', '1', '<copilot:search query="BPE_" path="borg-master" context="3"/>', '2', ' ',
  'Plain Text', '1', '<copilot:search query="port.bpe.websocket" path="borg-master" context="5"/>',
  'Plain Text', '1', '<copilot:search query="IsMarginOrder" path="borg-master" context="5"/>', '2', ' ',
  'Plain Text', '1', '<copilot:search query="BPE_STATIC_DATA_MGR_INITIALISED" path="borg-master" context="8"/>', '2', '``',
  'Plain Text', '1', '<copilot:search query="BPE_RECOVERY_FINISHED" path="borg-master" context="8"/>',
].join('\n');

test('all six searches in the live reply are found', () => {
  const calls = parseToolTags(LIVE_REPLY, fileTools);
  assert.deepEqual(calls.map((c) => c.name), ['search', 'search', 'search', 'search', 'search', 'search']);
  assert.equal(calls[4].args.query, 'BPE_STATIC_DATA_MGR_INITIALISED');
});

test('an agent run continuing from a reply runs its calls without sending anything first', async () => {
  const sent = [];
  const ran = [];
  const tools = {
    search: { summary: 's', usage: '<copilot:search query="x"/>', describe: (a) => `search ${a.query}`, run: (_c, a) => { ran.push(a.query); return `hit for ${a.query}`; } },
  };
  const ui = new Proxy({}, { get: () => () => {} });
  const res = await runAgent({
    ask: async (p) => { sent.push(p); return 'Here is the life cycle.'; },
    task: 'give me the life cycle', session: { root: process.cwd(), primed: false }, ui, tools, minTurnGapMs: 0,
    firstReply: LIVE_REPLY,
  });
  assert.equal(ran.length, 6, 'the six searches ran');
  assert.equal(sent.length, 1, 'one message: their results');
  assert.match(sent[0], /^<copilot:result tool="search"/, 'no system prompt and no task re-sent');
  assert.ok(sent[0].includes('hit for BPE_RECOVERY_FINISHED'));
  assert.equal(res.done, true);
});
