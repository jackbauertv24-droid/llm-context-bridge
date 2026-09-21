/**
 * Replay: a capture from one turn, re-run offline.
 *
 * Two things are proved here. First, a round trip — capture a turn from the
 * page replica, rebuild it from that capture alone, and get the same answer
 * back. That is what makes copilot-cli-capture.json a sufficient bug report.
 * Second, every fixture in test/fixtures/ replays to its recorded expectation,
 * so a capture from a bad turn can simply be dropped in there and becomes a
 * permanent regression test — no further manual run, ever, for that shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installGlobals } from '../lib-dom.mjs';
import { askInPage } from '../page-fn.mjs';
import { CFG, PARAS, CHIPS, buildCopilotPage } from './copilot-page.mjs';
import { replay, report } from '../lib-replay.mjs';

const PROMPT = 'are you ok?';

/** Run a live turn against the replica and hand back its capture. */
async function captureTurn(opts) {
  const restore = installGlobals();
  try {
    buildCopilotPage(opts);
    const res = await askInPage({ ...CFG, prompt: PROMPT });
    assert.ok(res.debug && res.debug.capture, 'the turn produced no capture');
    return { res, capture: { ...res.debug.capture, method: res.method } };
  } finally { restore(); }
}

const SHAPES = {
  'a plain turn': {},
  'a reply streamed into an existing block': { replyIntoExisting: true },
  'chips arriving as their own turn': { chipsAsOwnTurn: true },
};

for (const [name, opts] of Object.entries(SHAPES)) {
  test(`replaying ${name} reproduces the live answer`, async () => {
    const { res, capture } = await captureTurn(opts);
    const again = await replay(JSON.parse(JSON.stringify(capture)));
    assert.equal(again.text, res.text, `replay diverged from the live turn:\n${report(again)}`);
    assert.equal(again.text, PARAS.join('\n'));
    for (const chip of CHIPS) assert.ok(!again.text.includes(chip), `chip leaked: ${chip}`);
  });
}

test('a capture carries the prompt and selectors, so replay needs no arguments', async () => {
  const { capture } = await captureTurn({});
  assert.equal(capture.prompt, PROMPT);
  assert.equal(capture.selectors.answer, CFG.answerSelector);
  assert.ok(capture.input && capture.input.id, 'the composer was not described');
  assert.ok(Array.isArray(capture.addedTops) && capture.addedTops.length, 'the added turns were not recorded');
});

test('replay falls back to the prompt echo when a capture predates addedTops', async () => {
  const { res, capture } = await captureTurn({});
  delete capture.addedTops;
  const again = await replay(capture);
  assert.equal(again.text, res.text);
});

test('a capture from an older build, whose addedTops meant another level, still replays', async () => {
  const { res, capture } = await captureTurn({ chipsAsOwnTurn: true });
  delete capture.listPath;          // the older shape
  capture.addedTops = [0];          // indexed the region, not the turn list
  const again = await replay(capture);
  assert.equal(again.text, res.text, report(again));
});

test('a report names what the capture had to clip', async () => {
  const { capture } = await captureTurn({});
  capture.tree.children[0].clipped = 3;
  const again = await replay(capture);
  assert.ok(report(again).includes('clipped'));
});

// ---------------------------------------------------------------- fixtures

const dir = path.join(import.meta.dirname, 'fixtures');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

for (const file of files) {
  test(`fixture ${file}`, async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const capture = raw.tree ? raw : (raw.debug && raw.debug.capture) || raw.capture;
    const want = raw.expect || {};
    const res = await replay(capture, want.prompt ? { prompt: want.prompt } : {});
    const detail = `\n${report(res)}`;
    if (want.text !== undefined) assert.equal(res.text, want.text, detail);
    if (want.startsWith) assert.ok(res.text.startsWith(want.startsWith), detail);
    if (want.includes) for (const s of want.includes) assert.ok(res.text.includes(s), detail);
    if (want.excludes) for (const s of want.excludes) assert.ok(!res.text.includes(s), detail);
    if (want.method) assert.ok(res.method.startsWith(want.method), detail);
    if (!Object.keys(want).length) assert.ok(res.text.length > 0, detail);
  });
}
