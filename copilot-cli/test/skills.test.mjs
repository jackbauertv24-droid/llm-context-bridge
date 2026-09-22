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
} from '../lib-skills.mjs';
import { renderSystemPrompt } from '../lib-agent.mjs';

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
  // Crucial security check: file mutation instructions must not be present in mail-only prompt!
  assert.doesNotMatch(prompt, /write replaces the whole file/);
  assert.doesNotMatch(prompt, /WHEN NOT TO CHANGE ANYTHING/);
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
