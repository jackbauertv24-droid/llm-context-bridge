// test/automation.test.mjs — Comprehensive offline validation suite.
// Tests DOM automation, scoping, selector disambiguation, Confluence tools, and static AST.
// Uses node:test and node:assert only (zero external npm dependencies).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { installGlobals, resetDom, El, document as doc } from '../lib-dom.mjs';
import { askInPage } from '../page-fn.mjs';
import {
  createDefaultRegistry,
  parseAgentCommand,
  formatSkillsList,
  confluenceSkill,
} from '../lib-skills.mjs';
import { confluenceHtmlToText, confluenceTools } from '../lib-confluence.mjs';
import { renderSystemPrompt } from '../lib-agent.mjs';

// ============================================================================
// 1. STATIC AST COMPILATION AUDIT (Every single .mjs file in the repo)
// ============================================================================

test('static AST check: every .mjs file in copilot-cli compiles cleanly', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    ...fs.readdirSync(root).filter((f) => f.endsWith('.mjs')).map((f) => path.join(root, f)),
    ...fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(root, 'test', f)),
  ];

  assert.ok(files.length >= 15, `expected at least 15 modules, found ${files.length}`);
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(`Syntax or AST error in ${path.basename(file)}: ${err.stderr?.toString() || err.message}`);
    }
  }
});

// ============================================================================
// 2. DOM AUTOMATION & REGRESSION TESTS (page-fn.mjs)
// ============================================================================

test('DOM: input text is completely cleared before inserting new prompt (no prompt duplication)', async () => {
  const restore = installGlobals();
  try {
    resetDom();
    const input = new El('div', { id: 'm365-chat-editor-target-element', contenteditable: 'true' }, 'OLD STALE LEFTOVER PROMPT');
    const sendBtn = new El('button', { 'aria-label': 'Send' });
    const composer = new El('div', { class: 'composer' });
    composer.append(input, sendBtn);
    doc.body.append(composer);
    doc._editor = input;

    const res = await askInPage({
      inputSelector: '#m365-chat-editor-target-element',
      prompt: 'NEW CLEAN TASK PROMPT',
      answerTimeoutMs: 300,
      quietMs: 100,
    });

    assert.ok(res);
    // The editor must contain ONLY the new prompt, never the old leftover text
    const finalContent = input.innerText;
    assert.ok(!finalContent.includes('OLD STALE LEFTOVER PROMPT'), 'editor still contains stale prompt text');
    assert.ok(finalContent.includes('NEW CLEAN TASK PROMPT'), 'editor does not contain new prompt');
  } finally {
    restore();
  }
});

test('DOM: send button detection prioritizes composer and rejects header "Send feedback"', async () => {
  const restore = installGlobals();
  try {
    resetDom();
    // Header containing a feedback button at top of screen (y = 20)
    const header = new El('header');
    const feedbackBtn = new El('button', { 'aria-label': 'Send feedback', title: 'Send feedback' });
    feedbackBtn.rect = { x: 800, y: 20, width: 80, height: 30 };
    header.append(feedbackBtn);
    doc.body.append(header);

    // Chat composer at bottom of screen (y = 700)
    const input = new El('div', { id: 'm365-chat-editor-target-element', contenteditable: 'true' });
    input.rect = { x: 200, y: 700, width: 600, height: 60 };
    const chatSendBtn = new El('button', { 'aria-label': 'Send message' });
    chatSendBtn.rect = { x: 750, y: 710, width: 40, height: 40 };

    let chatSendClicked = false;
    let feedbackClicked = false;
    chatSendBtn.addEventListener('click', () => { chatSendClicked = true; });
    feedbackBtn.addEventListener('click', () => { feedbackClicked = true; });

    const composer = new El('div', { class: 'fui-ChatComposer' });
    composer.rect = { x: 200, y: 700, width: 600, height: 80 };
    composer.append(input, chatSendBtn);
    doc.body.append(composer);
    doc._editor = input;

    const res = await askInPage({
      inputSelector: '#m365-chat-editor-target-element',
      prompt: 'test query',
      answerTimeoutMs: 300,
      quietMs: 100,
    });

    assert.ok(res);
    assert.equal(feedbackClicked, false, 'header "Send feedback" button was mistakenly clicked!');
    assert.equal(chatSendClicked, true, 'composer send button was not clicked!');
  } finally {
    restore();
  }
});

test('DOM: detects "Please wait for current response" and flags busy: true', async () => {
  const restore = installGlobals();
  try {
    resetDom();
    const input = new El('div', { id: 'm365-chat-editor-target-element', contenteditable: 'true' });
    const sendBtn = new El('button', { 'aria-label': 'Send' });
    const composer = new El('div', { class: 'composer' });
    composer.append(input, sendBtn);

    // Simulate response region where Copilot displays the busy message
    const replyRegion = new El('div', { 'data-testid': 'markdown-reply' }, 'Copilot said:\nPlease wait for the current response to finish.');
    doc.body.append(composer, replyRegion);
    doc._editor = input;

    const res = await askInPage({
      inputSelector: '#m365-chat-editor-target-element',
      answerSelector: '[data-testid="markdown-reply"]',
      prompt: 'find docs',
      answerTimeoutMs: 300,
      quietMs: 100,
    });

    assert.ok(res);
    assert.equal(res.busy, true, 'expected busy flag to be true when Copilot emits busy warning');
    assert.equal(res.ok, false, 'expected ok to be false when busy');
  } finally {
    restore();
  }
});

test('DOM: short-circuits gracefully when send button is absent or unclickable', async () => {
  const restore = installGlobals();
  try {
    resetDom();
    const input = new El('div', { id: 'm365-chat-editor-target-element', contenteditable: 'true' });
    // Composer without any send button
    const composer = new El('div', { class: 'composer' });
    composer.append(input);
    doc.body.append(composer);
    doc._editor = input;

    const start = Date.now();
    const res = await askInPage({
      inputSelector: '#m365-chat-editor-target-element',
      prompt: 'unsendable task',
      answerTimeoutMs: 120000, // 2 minutes
      quietMs: 100,
    });

    const elapsed = Date.now() - start;
    assert.ok(res);
    assert.ok(elapsed < 12000, `expected short-circuit within ~8-10s, but took ${elapsed}ms`);
    assert.equal(res.debug.wait.via, 'send-not-triggered');
  } finally {
    restore();
  }
});

// ============================================================================
// 3. CONFLUENCE TOOLS & SYSTEM PROMPT SAFETY
// ============================================================================

test('confluenceHtmlToText converts rich tables, code, and lists to clean markdown', () => {
  const html = `
    <h1>System Architecture</h1>
    <p>This is an internal overview of the <b>trading</b> platform.</p>
    <table>
      <tr><th>Service</th><th>Port</th><th>Protocol</th></tr>
      <tr><td>Gateway</td><td>8080</td><td>HTTPS</td></tr>
      <tr><td>Engine</td><td>9000</td><td>TCP</td></tr>
    </table>
    <pre><code class="language-json">{"status": "UP"}</code></pre>
    <ul>
      <li>Node A</li>
      <li>Node B</li>
    </ul>
    <script>evil()</script>
  `;

  const md = confluenceHtmlToText(html);
  assert.match(md, /^# System Architecture/m);
  assert.match(md, /This is an internal overview/);
  assert.match(md, /\| Service \| Port \| Protocol/);
  assert.match(md, /\| Gateway \| 8080 \| HTTPS/);
  assert.match(md, /```\n`\{"status": "UP"\}`\n```/);
  assert.match(md, /- Node A\n- Node B/);
  assert.doesNotMatch(md, /<script>/);
  assert.doesNotMatch(md, /evil/);
});

test('confluence tools conform to copilot-cli protocol and are strictly read-only', () => {
  const mockClient = {
    search: async () => ({ strategy: 'rest_v1_cql', total: 1, results: [{ id: '101', title: 'Arch Spec', spaceKey: 'ENG' }] }),
    readPage: async () => ({ id: '101', title: 'Arch Spec', spaceKey: 'ENG', spaceName: 'Engineering', version: 1, markdown: '# Arch Spec\nContent' }),
    listSpaces: async () => [{ key: 'ENG', name: 'Engineering', type: 'global' }],
  };

  const tools = confluenceTools(mockClient);
  assert.ok(tools.confluence_search);
  assert.ok(tools.confluence_read);
  assert.ok(tools.confluence_spaces);

  for (const [name, t] of Object.entries(tools)) {
    assert.equal(t.mutates, false, `tool ${name} must be strictly read-only (mutates: false)`);
    assert.equal(t.body, false, `tool ${name} does not accept multiline body`);
    assert.equal(typeof t.run, 'function');
    assert.equal(typeof t.describe, 'function');
  }
});

// The confluence skill reports itself unavailable until configured, so this
// test states the configuration rather than relying on it always claiming to
// be ready.
process.env.CONFLUENCE_TAB_MATCH = process.env.CONFLUENCE_TAB_MATCH || 'confluence';

test('renderSystemPrompt for confluence skill generates safe read-only persona and rules', () => {
  const reg = createDefaultRegistry();
  const res = reg.resolve('confluence', { root: '/repo' });
  const prompt = renderSystemPrompt('/repo', res.tools, { skills: res.activeSkills });

  assert.match(prompt, /You are an assistant with read-only access to the corporate Confluence knowledge base/);
  assert.match(prompt, /READ-ONLY MODE/);
  assert.match(prompt, /<copilot:confluence_search/);
  assert.match(prompt, /<copilot:confluence_read/);
  assert.match(prompt, /<copilot:confluence_spaces/);
  assert.doesNotMatch(prompt, /write replaces the whole file/);
  assert.doesNotMatch(prompt, /<copilot:write/);
  assert.doesNotMatch(prompt, /<copilot:edit/);
});
