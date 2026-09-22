/**
 * The whole agent flow, on a page assembled from the user's own evidence.
 *
 * This is the check that should have existed before any of it was handed
 * over: not a unit of the send path, but a task going in and a result coming
 * out, through the real page function, the real agent loop and the real file
 * tools. Nothing here is a stub except the model's replies, and those are
 * copied from shapes the page actually produced.
 */
// The whole agent flow, on a page assembled from the user's own evidence.
//
// Page facts, each with its source:
//   - input id, geometry, Enter consumed, composer clears at 671ms,
//     stop control appears 671ms / goes 4237ms, text grows to 5239ms
//       -> copilot-cli-page-record.json, 2026-09-22T09:52
//   - typing 4 characters leaves 6: the editor pads with invisible anchors
//       -> same recording, insert.askedChars 4 / gotLength 6
//   - a sent message is echoed with its newlines removed entirely
//       -> the user's paste of 2026-09-22T03:28, "executesfor you"
//   - replies arrive wrapped in code-block chrome: a "Plain Text" caption
//     and a line-number gutter
//       -> the user's paste of 2026-09-22T03:10 and 03:28
import { El, document as doc, installGlobals, resetDom } from '/config/claude-workspace/llm-context-bridge/copilot-cli/lib-dom.mjs';
import { askInPage } from '/config/claude-workspace/llm-context-bridge/copilot-cli/page-fn.mjs';
import { runAgent, createAgentSession, renderSystemPrompt } from '/config/claude-workspace/llm-context-bridge/copilot-cli/lib-agent.mjs';
import { createDefaultRegistry } from '/config/claude-workspace/llm-context-bridge/copilot-cli/lib-skills.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rec = JSON.parse(fs.readFileSync('/config/claude-workspace/llm-context-bridge/copilot-cli/test/fixtures/copilot-web-2026-09-22.json', 'utf8'));

// A real workspace with real files for the agent to list.
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
fs.writeFileSync(path.join(ws, 'chat.mjs'), '// a file\n');
fs.writeFileSync(path.join(ws, 'README.md'), '# readme\n');
fs.mkdirSync(path.join(ws, 'test'));

let sends = 0;
let feed = null;
let input = null;

function buildPage() {
  resetDom();
  feed = new El('div', {});
  doc.body.append(feed);
  const composer = new El('div', { class: 'fai-BebopLiteChatInput' });
  input = new El('span', {
    id: rec.chosenInput.id, role: 'textbox', contenteditable: 'true',
    'aria-label': rec.chosenInput.ariaLabel,
  });
  input.rect = { x: rec.chosenInput.rect.x, y: rec.chosenInput.rect.y, width: rec.chosenInput.rect.w, height: rec.chosenInput.rect.h };
  composer.append(input);
  doc.body.append(composer);
  doc._editor = input;
  // "Task Hub" in the header, which the old send-finder matched on "ask".
  doc.body.append(new El('a', { id: 'menu_r_bd_', role: 'button', 'aria-label': 'Task Hub', 'data-testid': 'tasks-launcher-button' }));

  // RECORDED: the editor pads what is typed with invisible anchors.
  Object.defineProperty(input, 'innerText', {
    get() {
      const raw = this.children.length ? this.children.map((c) => c.innerText).join('\n') : this._text;
      return raw ? `​${raw}​` : raw;
    },
    set(v) { this.children = []; this._text = v; },
    configurable: true,
  });
}

/** One turn of the real page: consume Enter, echo without newlines, answer. */
function answerWith(replyText) {
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();                       // RECORDED: Enter is consumed
    sends++;
    const sent = input.innerText;
    setTimeout(() => { input.textContent = ''; }, 671);   // RECORDED
    const stop = new El('button', { 'aria-label': 'Stop responding' });
    setTimeout(() => doc.body.append(stop), 671);          // RECORDED
    // OBSERVED: the echo has its newlines removed entirely.
    setTimeout(() => {
      const echo = new El('div', { 'data-testid': 'copilot-message-div' });
      echo.append(new El('div', {}, sent.split('\n').join('')));
      feed.append(echo);
    }, 671);
    setTimeout(() => {
      const msg = new El('div', { 'data-testid': 'lastChatMessage' });
      const md = new El('div', { 'data-testid': 'markdown-reply' });
      // OBSERVED: code-block chrome around the tag.
      for (const line of replyText.split('\n')) md.append(new El('p', {}, line));
      msg.append(md);
      feed.append(msg);
    }, 1200);
    setTimeout(() => { stop.rect = { x: 0, y: 0, width: 0, height: 0 }; }, 2400);
  });
}

// Copilot's replies, in the shape its own transcripts show.
const replies = [
  'I’ll list the files.\n\nPlain Text\n1\n<copilot:list path="."/>',
  'Those are the files in the folder: chat.mjs, README.md and a test directory.',
];

const reg = createDefaultRegistry();
const resolved = reg.resolve('files', { root: ws });
let i = 0;

test('a task goes in and a result comes out', async () => {
  const restore = installGlobals();
  const steps = [];
  try {
  const res = await runAgent({
    ask: async (prompt) => {
      buildPage();
      answerWith(replies[Math.min(i, replies.length - 1)]);
      i++;
      const r = await askInPage({
        inputSelector: `#${rec.chosenInput.id}`,
        sendSelector: '',
        answerSelector: '[data-testid="markdown-reply"]',
        quietMs: 1200,
        answerTimeoutMs: 15000,
        prompt,
      });
      steps.push({
        promptChars: prompt.length,
        notSent: !!r.notSent,
        submissions: r.debug.wait.submissions,
        composer: r.debug.composer,
        via: r.debug.wait.via,
        answer: (r.text || '').replace(/\s+/g, ' ').slice(0, 60),
      });
      return r.text;
    },
    task: 'list the files here',
    session: createAgentSession(ws),
    tools: resolved.tools,
    skills: resolved.activeSkills,
    maxSteps: 4,
    minTurnGapMs: 100,
    ui: {
      step: (n, m) => console.log(`\n--- step ${n}/${m}`),
      prose: (t) => console.log('  model says :', JSON.stringify(t)),
      toolOk: (l, o) => console.log('  tool ran   :', l, '->', JSON.stringify(String(o).replace(/\n/g, ' ').slice(0, 70))),
      toolError: (l, m) => console.log('  tool FAILED:', l, m),
      skipped: () => {},
      ignored: (n) => console.log('  !! ignored', n, 'tag-like mentions'),
      unknownTag: (n) => console.log('  !! unknown tool', n),
      unreadable: (s) => console.log('  !! unreadable reply', JSON.stringify(s)),
      busy: () => {}, throttled: () => {},
    },
  });

  console.log('\n=== per turn ===');
  for (const [n, s] of steps.entries()) {
    console.log(`  turn ${n + 1}: prompt ${s.promptChars} chars | sent=${!s.notSent} | submissions=${s.submissions}`
      + ` | composer ${s.composer.actual}/${s.composer.expected} ratio ${s.composer.ratio}`
      + ` | ended ${s.via} | answer ${JSON.stringify(s.answer)}`);
  }
  console.log('\n=== outcome ===');
  console.log('  messages the page received:', sends);
  console.log('  agent result             :', JSON.stringify(res));
    assert.equal(res.done, true, 'the agent should finish the task');
    assert.equal(sends, 2, 'exactly one message per turn should reach the page');
    for (const s of steps) {
      assert.equal(s.notSent, false, 'no turn may be refused');
      assert.equal(s.submissions, 1, 'and none may need more than one attempt');
      assert.ok(s.composer.ratio > 0.95, 'the prompt must survive the composer');
    }
    assert.ok(steps[0].answer.includes('copilot:list'), 'the tag must survive the code-block chrome');
  } finally {
    restore();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
