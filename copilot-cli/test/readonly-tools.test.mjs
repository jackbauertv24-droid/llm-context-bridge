/**
 * tree, search and read with a line range — driven the way the model drives
 * them: a tag as it would write it, parsed by the real parser, run by the
 * real tool, against a real directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tools } from '../lib-fstools.mjs';
import { parseToolTags } from '../lib-agent.mjs';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'ro-tools-'));
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'README.md'), '# demo\nparseToolTags is described here\n');
  writeFileSync(join(root, 'src', 'index.mjs'), 'import { parseToolTags } from "./lib/agent.mjs";\n\nexport function main() {\n  return parseToolTags("x");\n}\n');
  writeFileSync(join(root, 'src', 'lib', 'agent.mjs'), Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\nexport function parseToolTags(t) { return t; }\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'parseToolTags everywhere\n');
  writeFileSync(join(root, 'test', 'data.bin'), Buffer.from([0, 1, 2, 0x70, 0x61, 0x72, 0x73, 0x65]));
  try { symlinkSync('/etc', join(root, 'escape')); } catch { /* not permitted here */ }
  return root;
}

function run(root, tag) {
  const calls = parseToolTags(tag, tools);
  assert.equal(calls.length, 1, `the tag should parse: ${tag}`);
  return tools[calls[0].name].run({ root }, calls[0].args, calls[0].body);
}

test('tree: the whole project in one call, full paths, skipping node_modules, not following links', () => {
  const root = project();
  try {
    const out = run(root, '<copilot:tree/>');
    const lines = out.split('\n');
    assert.ok(lines.includes('src/'));
    assert.ok(lines.some((l) => l.startsWith('src/lib/agent.mjs  ')), 'full path with a size');
    assert.ok(!out.includes('node_modules'));
    if (out.includes('escape')) assert.match(out, /escape {2}\(symlink, not followed\)/);
    assert.ok(!out.includes('passwd'), 'the link was not followed');
    assert.match(lines[lines.length - 1], /^\(\d+ files, \d+ directories\)$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tree: depth and a subdirectory', () => {
  const root = project();
  try {
    const out = run(root, '<copilot:tree path="src" depth="1"/>');
    assert.ok(out.includes('src/index.mjs'));
    assert.ok(out.includes('src/lib/'));
    assert.ok(!out.includes('src/lib/agent.mjs'), 'depth 1 stops at the first level');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tree and search refuse to leave the workspace', () => {
  const root = project();
  try {
    assert.throws(() => run(root, '<copilot:tree path=".."/>'), /escapes the workspace/);
    assert.throws(() => run(root, '<copilot:search query="root" path="../.."/>'), /escapes the workspace/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('search: file:line: text for each match, skipping node_modules and binary files', () => {
  const root = project();
  try {
    const out = run(root, '<copilot:search query="parseToolTags"/>');
    assert.ok(out.includes('src/index.mjs:1: import { parseToolTags }'));
    assert.ok(out.includes('src/index.mjs:4:   return parseToolTags("x");'));
    assert.ok(out.includes('src/lib/agent.mjs:31: export function parseToolTags'));
    assert.ok(!out.includes('node_modules'));
    assert.ok(!out.includes('data.bin'));
    assert.match(out, /\(4 matches in 3 files\)$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('search: glob, context, case and regex', () => {
  const root = project();
  try {
    const g = run(root, '<copilot:search query="parseToolTags" glob="*.md"/>');
    assert.ok(g.startsWith('README.md:2: '), g);
    const c = run(root, '<copilot:search query="export function main" context="1"/>');
    assert.deepEqual(c.split('\n').slice(0, 3), ['src/index.mjs:2- ', 'src/index.mjs:3: export function main() {', 'src/index.mjs:4-   return parseToolTags("x");']);
    assert.match(run(root, '<copilot:search query="PARSETOOLTAGS" case="true"/>'), /^no matches/);
    const r = run(root, '<copilot:search query="line(1|2)0 =" regex="true"/>');
    assert.match(r, /agent\.mjs:10: const line10 = 10;/);
    assert.match(r, /agent\.mjs:20: const line20 = 20;/);
    assert.throws(() => run(root, '<copilot:search query="(" regex="true"/>'), /not a valid regular expression/);
    assert.match(run(root, '<copilot:search query="a.b"/>'), /^no matches/, 'a plain query is literal, not a pattern');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read with lines: numbered, with the total, and the note that numbers are not the file', () => {
  const root = project();
  try {
    const out = run(root, '<copilot:read path="src/lib/agent.mjs" lines="9-11"/>');
    assert.deepEqual(out.split('\n'), [
      'src/lib/agent.mjs lines 9-11 of 31 (the numbers are not part of the file)',
      ' 9: const line9 = 9;', '10: const line10 = 10;', '11: const line11 = 11;',
    ]);
    assert.match(run(root, '<copilot:read path="src/lib/agent.mjs" lines="30-"/>'), /lines 30-31 of 31/);
    assert.match(run(root, '<copilot:read path="src/lib/agent.mjs" lines="5"/>'), /lines 5-5 of 31 \(the numbers are not part of the file\)\n5: const line5 = 5;$/);
    assert.match(run(root, '<copilot:read path="src/lib/agent.mjs" lines="25-999"/>'), /lines 25-31 of 31/);
    assert.throws(() => run(root, '<copilot:read path="src/lib/agent.mjs" lines="50-60"/>'), /has only 31 lines/);
    assert.throws(() => run(root, '<copilot:read path="src/lib/agent.mjs" lines="abc"/>'), /lines must look like/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read without lines is exactly as before: the file itself, no numbers', () => {
  const root = project();
  try {
    assert.equal(run(root, '<copilot:read path="README.md"/>'), '# demo\nparseToolTags is described here\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('none of the three is marked as changing files, so none asks for approval', () => {
  for (const n of ['tree', 'search', 'read']) assert.ok(!tools[n].mutates, n);
});
