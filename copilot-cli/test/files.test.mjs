/**
 * Tests for @path expansion. No browser and no network: the whole point of
 * keeping this logic out of the page function is that it can be checked here.
 *
 *   node --test test/
 *
 * Each case is a defect someone would actually hit — a typo'd path, a file
 * with backticks in it, an email address mistaken for a filename, a prompt
 * quietly cut in half.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandPrompt, withStdin, humanSize } from '../lib-files.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cli-test-'));
const write = (name, content) => {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const expand = (raw, opts = {}) => expandPrompt(raw, { cwd: dir, ...opts });

write('hello.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
write('notes.md', 'a fenced block:\n```\ninner\n```\ndone\n');
write('big.txt', 'x'.repeat(5000));
write('empty.txt', '');
write('binary.bin', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
write('creds.env', 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n');
write('my file.txt', 'spaces in the name\n');
write('sub/nested.txt', 'nested\n');

test('a prompt with no references passes through untouched', () => {
  const r = expand('explain CRDTs to me');
  assert.equal(r.prompt, 'explain CRDTs to me');
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.error, null);
});

test('a referenced file is attached with its content and a header', () => {
  const r = expand('review @hello.js please');
  assert.equal(r.error, null);
  assert.match(r.prompt, /^review @hello\.js please\n\n/);
  assert.match(r.prompt, /--- file: hello\.js \(3 lines, 39 B\) ---/);
  assert.match(r.prompt, /```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```/);
  assert.deepEqual(r.attachments, ['hello.js (3 lines, 39 B)']);
});

test('a missing but path-shaped reference warns and stays literal', () => {
  const r = expand('look at @src/nope.js');
  assert.equal(r.prompt, 'look at @src/nope.js');
  assert.deepEqual(r.attachments, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /no such file: src\/nope\.js/);
});

test('an email address is not mistaken for a file reference', () => {
  const r = expand('forward it to jane@corp.com and cc @corp.com');
  assert.equal(r.prompt, 'forward it to jane@corp.com and cc @corp.com');
  assert.deepEqual(r.warnings, [], 'a bare @mention should not nag about missing files');
});

test('trailing sentence punctuation is not part of the path', () => {
  const r = expand('what does @hello.js do?');
  assert.deepEqual(r.attachments, ['hello.js (3 lines, 39 B)']);
  const inParens = expand('see (@hello.js).');
  assert.deepEqual(inParens.attachments, ['hello.js (3 lines, 39 B)']);
});

test('a line range attaches only those lines and says so', () => {
  const r = expand('explain @hello.js:2-3');
  assert.deepEqual(r.attachments, ['hello.js (lines 2-3 of 3, 25 B)']);
  assert.match(r.prompt, /const b = 2;\nconst c = 3;/);
  assert.doesNotMatch(r.prompt, /const a = 1;/);
});

test('an open-ended range runs to the end of the file', () => {
  const r = expand('@hello.js:2-');
  assert.deepEqual(r.attachments, ['hello.js (lines 2-3 of 3, 25 B)']);
});

test('a range past the end of the file is refused, not clamped to nothing', () => {
  const r = expand('@hello.js:40-50');
  assert.deepEqual(r.attachments, []);
  assert.match(r.warnings[0], /has 3 lines/);
});

test('backticks inside a file cannot close the fence early', () => {
  const r = expand('@notes.md');
  assert.match(r.prompt, /````markdown\n/, 'fence must be longer than any run inside');
  assert.match(r.prompt, /```\ninner\n```/, 'the inner fence survives verbatim');
  assert.ok(r.prompt.trimEnd().endsWith('````'));
});

test('a binary file is skipped with a warning rather than pasted as mojibake', () => {
  const r = expand('@binary.bin');
  assert.deepEqual(r.attachments, []);
  assert.match(r.warnings[0], /looks binary/);
});

test('an oversized file is skipped and the warning says how to attach part of it', () => {
  const r = expand('@big.txt', { maxFileBytes: 1024 });
  assert.deepEqual(r.attachments, []);
  assert.match(r.warnings[0], /over the 1.0 KB limit/);
  assert.match(r.warnings[0], /:1-200/);
});

test('a line range can rescue a file that is too big whole', () => {
  const r = expand('@big.txt:1-1', { maxFileBytes: 1024 });
  assert.equal(r.attachments.length, 0, 'one 5000-char line is still over the limit');
  const ok = expand('@hello.js:1-1', { maxFileBytes: 20 });
  assert.deepEqual(ok.attachments, ['hello.js (lines 1-1 of 3, 12 B)']);
});

test('an empty file is attached and labelled, not silently dropped', () => {
  const r = expand('@empty.txt');
  assert.equal(r.attachments.length, 1);
  assert.match(r.prompt, /--- file: empty\.txt \(0 lines, 0 B\) — empty ---/);
});

test('a quoted path may contain spaces', () => {
  const r = expand('read @"my file.txt" out loud');
  assert.deepEqual(r.attachments, ['my file.txt (1 line, 19 B)']);
});

test('the same file referenced twice is attached once', () => {
  const r = expand('compare @hello.js with @hello.js');
  assert.equal(r.attachments.length, 1);
});

test('the same file at different ranges is two attachments', () => {
  const r = expand('@hello.js:1-1 versus @hello.js:3-3');
  assert.equal(r.attachments.length, 2);
});

test('a directory attaches a listing', () => {
  const r = expand('what is in @sub');
  assert.match(r.prompt, /--- directory: sub \(1 entry\) ---/);
  assert.match(r.prompt, /nested\.txt {2}7 B/);
});

test('a likely credential warns but still sends', () => {
  const r = expand('@creds.env');
  assert.equal(r.attachments.length, 1, 'warning only — never silently dropped');
  assert.match(r.warnings[0], /AWS access key id/);
});

test('a prompt over the total budget is refused whole, never truncated', () => {
  const r = expand('review @hello.js', { maxPromptChars: 30 });
  assert.ok(r.error, 'must refuse');
  assert.equal(r.prompt, 'review @hello.js', 'the unexpanded prompt comes back, not a half-file');
  assert.match(r.error, /MAX_PROMPT_CHARS/);
});

test('piped stdin becomes its own labelled block', () => {
  const p = withStdin('review this', 'diff --git a/x b/x\n+line\n', 'git diff');
  assert.match(p, /^review this\n\n--- git diff \(2 lines, 24 B\) ---/);
  assert.match(p, /\+line/);
});

test('empty stdin adds nothing', () => {
  assert.equal(withStdin('hello', '   \n'), 'hello');
});

test('stdin alone is the whole prompt', () => {
  assert.match(withStdin('', 'some text'), /^--- stdin/);
});

test('sizes read the way a person would say them', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(1023), '1023 B');
  assert.equal(humanSize(1536), '1.5 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
});
