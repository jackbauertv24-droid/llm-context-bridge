// test/skills.test.mjs — Unit tests for SkillRegistry, command parsing, and prompt scoping.
// Uses node:test and node:assert only (zero external npm dependencies).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultRegistry,
  parseAgentCommand,
  formatSkillsList,
  filesSkill,
  mailSkill,
  confluenceSkill,
} from '../lib-skills.mjs';
import { confluenceHtmlToText } from '../lib-confluence.mjs';
import { renderSystemPrompt } from '../lib-agent.mjs';
import { askInPage } from '../page-fn.mjs';

test('parseAgentCommand parses standard /agent tasks', () => {
  const res = parseAgentCommand('/agent refactor auth.js');
  assert.equal(res.skillName, 'default');
  assert.equal(res.task, 'refactor auth.js');
});

test('parseAgentCommand parses colon subcommands', () => {
  const mail = parseAgentCommand('/agent:mail check unread inbox');
  assert.equal(mail.skillName, 'mail');
  assert.equal(mail.task, 'check unread inbox');

  const code = parseAgentCommand('/agent:code fix tests');
  assert.equal(code.skillName, 'code');
  assert.equal(code.task, 'fix tests');

  const emptyTask = parseAgentCommand('/agent:mail');
  assert.equal(emptyTask.skillName, 'mail');
  assert.equal(emptyTask.task, '');
});

test('parseAgentCommand parses plus-modifiers for multi-skill composition', () => {
  const res = parseAgentCommand('/agent +mail summarize inbox and write notes');
  assert.equal(res.skillName, 'files,mail');
  assert.equal(res.task, 'summarize inbox and write notes');
});

test('parseAgentCommand parses flag-style options', () => {
  const eq = parseAgentCommand('/agent --skills=files,mail find bugs');
  assert.equal(eq.skillName, 'files,mail');
  assert.equal(eq.task, 'find bugs');

  const sp = parseAgentCommand('/agent --skill mail check status');
  assert.equal(sp.skillName, 'mail');
  assert.equal(sp.task, 'check status');
});

test('SkillRegistry resolves default to files skill', () => {
  const reg = createDefaultRegistry();
  const res = reg.resolve('default', { root: '/dummy' });
  assert.equal(res.activeSkills.length, 1);
  assert.equal(res.activeSkills[0].id, 'files');
  assert.ok(res.tools.read);
  assert.ok(res.tools.write);
  assert.ok(res.tools.edit);
  assert.ok(res.tools.list);
});

test('SkillRegistry supports aliases like code, file, fs', () => {
  const reg = createDefaultRegistry();
  for (const alias of ['code', 'file', 'fs']) {
    const res = reg.resolve(alias, { root: '/dummy' });
    assert.equal(res.activeSkills[0].id, 'files');
  }
});

test('SkillRegistry reports unconfigured mail when missing credentials', () => {
  const reg = createDefaultRegistry();
  assert.throws(
    () => reg.resolve('mail', { root: '/nonexistent', mailConfig: { configured: false } }),
    /mail is not configured/,
  );
});

test('SkillRegistry resolves mail when configured', () => {
  const reg = createDefaultRegistry();
  const mockConfig = {
    configured: true,
    protocol: 'ews',
    user: 'testuser',
    host: 'owa.example.com',
  };
  const res = reg.resolve('mail', { root: '/dummy', mailConfig: mockConfig });
  assert.equal(res.activeSkills.length, 1);
  assert.equal(res.activeSkills[0].id, 'mail');
  assert.ok(res.tools.mail);
  assert.ok(res.tools.mailboxes);
});

test('SkillRegistry rejects unknown skill names', () => {
  const reg = createDefaultRegistry();
  assert.throws(
    () => reg.resolve('quantum_teleporter', { root: '/dummy' }),
    /Unknown skill "quantum_teleporter"/,
  );
});

test('renderSystemPrompt for files skill includes mutation guidance and code persona', () => {
  const prompt = renderSystemPrompt('/mock/root', filesSkill.getTools(), { skills: [filesSkill] });
  assert.match(prompt, /You are a coding agent working in a checkout/);
  assert.match(prompt, /<copilot:read path="src\/index\.js"\/>/);
  assert.match(prompt, /WHEN NOT TO CHANGE ANYTHING/);
  assert.match(prompt, /write replaces the whole file/);
  assert.match(prompt, /The workspace root is \/mock\/root/);
  assert.doesNotMatch(prompt, /READ-ONLY MODE/);
});

test('renderSystemPrompt for mail skill enforces strict read-only mode and drops file write rules', () => {
  const mockConfig = { configured: true, protocol: 'ews', user: 'u', host: 'h' };
  const tools = mailSkill.getTools({ mailConfig: mockConfig });
  const prompt = renderSystemPrompt('/mock/root', tools, { skills: [mailSkill] });

  assert.match(prompt, /assistant with read-only access to the user's corporate mail/);
  assert.match(prompt, /<copilot:mail days="7"\/>/);
  assert.match(prompt, /READ-ONLY MODE/);
  assert.match(prompt, /All tools in this session are strictly read-only/);
  // Security & cleanliness checks
  assert.doesNotMatch(prompt, /write replaces the whole file/);
  assert.doesNotMatch(prompt, /WHEN NOT TO CHANGE ANYTHING/);
  assert.doesNotMatch(prompt, /The workspace root is/);
});

test('formatSkillsList lists registered skills and status', () => {
  const reg = createDefaultRegistry();
  const output = formatSkillsList(reg, { root: '/dummy' });
  assert.match(output, /files\s+\[available, default\]/);
  assert.match(output, /mail/);
  assert.match(output, /logs/);
  assert.match(output, /teams/);
  assert.match(output, /confluence/);
});

test('confluenceHtmlToText converts HTML into clean markdown', () => {
  const html = `
    <div id="main">
      <h1>API Specification</h1>
      <p>This is the <b>core</b> documentation.</p>
      <table>
        <tr><th>Endpoint</th><th>Method</th></tr>
        <tr><td>/api/v1/auth</td><td>POST</td></tr>
      </table>
      <pre><code>console.log("hello");</code></pre>
      <ul><li>Item A</li><li>Item B</li></ul>
      <script>alert("bad");</script>
    </div>
  `;
  const md = confluenceHtmlToText(html);
  assert.match(md, /# API Specification/);
  assert.match(md, /This is the core documentation\./);
  assert.match(md, /\| Endpoint \| Method/);
  assert.match(md, /\| \/api\/v1\/auth \| POST/);
  assert.match(md, /```\n`console\.log\("hello"\);`\n```/);
  assert.match(md, /- Item A\n- Item B/);
  assert.doesNotMatch(md, /alert/);
});

test('SkillRegistry resolves confluence and wiki aliases', () => {
  const reg = createDefaultRegistry();
  for (const alias of ['confluence', 'wiki', 'doc', 'docs']) {
    const res = reg.resolve(alias, { root: '/dummy' });
    assert.equal(res.activeSkills[0].id, 'confluence');
    assert.ok(res.tools.confluence_search);
    assert.ok(res.tools.confluence_read);
    assert.ok(res.tools.confluence_spaces);
  }
});

test('renderSystemPrompt for confluence skill enforces read-only mode and drops write rules', () => {
  const tools = confluenceSkill.getTools();
  const prompt = renderSystemPrompt('/mock/root', tools, { skills: [confluenceSkill] });
  assert.match(prompt, /<copilot:confluence_search/);
  assert.match(prompt, /READ-ONLY MODE/);
  assert.match(prompt, /All tools in this session are strictly read-only/);
  assert.doesNotMatch(prompt, /write replaces the whole file/);
  assert.doesNotMatch(prompt, /WHEN NOT TO CHANGE ANYTHING/);
  assert.doesNotMatch(prompt, /The workspace root is/);

  // RULES section must not duplicate tool definitions (only sampleTag should appear)
  const rulesSection = prompt.split('RULES')[1];
  const ruleTags = (rulesSection.match(/<copilot:confluence_/g) || []);
  assert.equal(ruleTags.length, 1, 'Only sample tag should appear in RULES, no redundant tool definitions');
});

test('askInPage module exports valid executable function', () => {
  assert.equal(typeof askInPage, 'function');
  assert.equal(askInPage.constructor.name, 'AsyncFunction');
});

test('askInPage executes against DOM and handles input and baseline without ReferenceError', async () => {
  const { installGlobals, resetDom, El, document: doc } = await import('../lib-dom.mjs');
  const restore = installGlobals();
  try {
    resetDom();
    const input = new El('div', { id: 'm365-chat-editor-target-element', contenteditable: 'true' });
    const sendBtn = new El('button', { 'aria-label': 'Send' });
    const composer = new El('div', { class: 'composer' });
    composer.append(input, sendBtn);
    doc.body.append(composer);
    doc._editor = input;

    // Run askInPage with short timeout so it completes quickly in test
    const res = await askInPage({
      inputSelector: '#m365-chat-editor-target-element',
      prompt: 'hello world test prompt',
      answerTimeoutMs: 300,
      quietMs: 100,
    });

    assert.ok(res);
    assert.ok(res.debug);
    assert.equal(typeof res.debug.wait.ms, 'number');
  } finally {
    restore();
  }
});
