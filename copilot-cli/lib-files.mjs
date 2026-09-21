/**
 * Turning "@path" references in a prompt into attached file content.
 *
 * The point of the bridge is to stop copy-pasting; this is the half that lets
 * the terminal do the reading. Everything here is pure enough to test without a
 * browser: give it a string, get back the string that should be typed into the
 * page, plus what was attached and what went wrong.
 *
 * Nothing is ever silently truncated. A file that is too large, binary, or
 * unreadable is skipped with a warning; a prompt that would exceed the total
 * budget is refused outright, because half a file pasted into a chat is worse
 * than no file at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULTS = {
  maxFileBytes: 256 * 1024,
  maxPromptChars: 100000,
  maxDirEntries: 200,
};

// A reference starts a word and is either @"quoted path" or @bare/path.
const TOKEN_RE = /(^|[\s(])@(?:"([^"\n]+)"|([^\s)"]+))/g;

// Extensions that make a bare token look like a file, so a typo gets a warning
// rather than sailing through as ordinary prose.
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonc',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala', '.c', '.h', '.cc',
  '.cpp', '.hpp', '.cs', '.swift', '.php', '.pl', '.lua', '.r',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties',
  '.sql', '.graphql', '.proto', '.diff', '.patch', '.xml', '.svg',
  '.dockerfile', '.gradle', '.tf', '.tfvars',
]);

const FENCE_LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
  '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.jsonc': 'json',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.swift': 'swift', '.php': 'php', '.lua': 'lua', '.r': 'r',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.sql': 'sql', '.graphql': 'graphql', '.proto': 'protobuf',
  '.md': 'markdown', '.xml': 'xml', '.svg': 'xml',
  '.diff': 'diff', '.patch': 'diff', '.csv': 'csv',
};

// Credential shapes worth a heads-up before the text leaves the machine. These
// warn, never block: the person knows their own repo, and a false positive that
// silently drops a file would be the worse failure.
const SECRET_PATTERNS = [
  [/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, 'a private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"']{6,}/i, 'an inline credential'],
];

export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function expandHome(p, cwd) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

function looksPathLike(tok) {
  const bare = tok.replace(/:\d+-\d*$/, '');
  return /[/\\]/.test(bare) || /^[~.]/.test(bare) || TEXT_EXTS.has(path.extname(bare).toLowerCase());
}

/**
 * Work out what a token points at, tolerating a trailing ":10-40" line range
 * and trailing sentence punctuation. Returns null when nothing resolves.
 */
function resolveToken(tok, cwd) {
  const candidates = [];
  const push = (s) => {
    candidates.push({ spec: s, range: null });
    const m = /^(.+):(\d+)-(\d*)$/.exec(s);
    if (m) candidates.push({ spec: m[1], range: [Number(m[2]), m[3] === '' ? Infinity : Number(m[3])] });
  };
  push(tok);
  let t = tok;
  while (t.length > 1 && /[.,;:!?)\]}>'"]$/.test(t)) { t = t.slice(0, -1); push(t); }

  for (const c of candidates) {
    const abs = expandHome(c.spec, cwd);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    return { abs, display: c.spec, range: c.range, isDir: st.isDirectory(), size: st.size };
  }
  return null;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// A fence long enough that backticks inside the file cannot close it early.
function fenceFor(content) {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function readDirBlock(abs, display, max) {
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) {
    return { error: `could not list ${display}: ${e.code || e.message}` };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const shown = entries.slice(0, max);
  const lines = shown.map((e) => {
    if (e.isDirectory()) return `${e.name}/`;
    let size = '';
    try { size = `  ${humanSize(fs.statSync(path.join(abs, e.name)).size)}`; } catch { /* vanished */ }
    return `${e.name}${size}`;
  });
  if (entries.length > shown.length) lines.push(`... and ${entries.length - shown.length} more`);
  return {
    header: `--- directory: ${display} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}) ---`,
    body: lines.join('\n'),
    label: `${display} (directory, ${entries.length} entries)`,
  };
}

function readFileBlock(hit, o, warnings) {
  const { abs, display, range, size } = hit;
  if (!range && size > o.maxFileBytes) {
    warnings.push(`${display} is ${humanSize(size)}, over the ${humanSize(o.maxFileBytes)} limit — skipped. Attach part of it with @${display}:1-200, or raise MAX_FILE_BYTES.`);
    return null;
  }
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) {
    warnings.push(`could not read ${display}: ${e.code || e.message}`);
    return null;
  }
  if (isBinary(buf)) {
    warnings.push(`${display} looks binary — skipped.`);
    return null;
  }

  let content = buf.toString('utf8');
  const allLines = content.split('\n');
  // A trailing newline yields a final empty element that is not a real line.
  const totalLines = allLines.length && allLines[allLines.length - 1] === '' ? allLines.length - 1 : allLines.length;
  let span = `${totalLines} line${totalLines === 1 ? '' : 's'}`;

  if (range) {
    const [from, toRaw] = range;
    const to = toRaw === Infinity ? totalLines : toRaw;
    if (from < 1 || from > totalLines) {
      warnings.push(`${display} has ${totalLines} lines, so lines ${from}-${toRaw === Infinity ? '' : toRaw} do not exist — skipped.`);
      return null;
    }
    content = allLines.slice(from - 1, Math.min(to, totalLines)).join('\n');
    span = `lines ${from}-${Math.min(to, totalLines)} of ${totalLines}`;
    if (content.length > o.maxFileBytes) {
      warnings.push(`${display} ${span} is ${humanSize(content.length)}, over the ${humanSize(o.maxFileBytes)} limit — skipped.`);
      return null;
    }
  }

  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(content)) { warnings.push(`${display} appears to contain ${what} — it will be sent as-is.`); break; }
  }

  const bytes = Buffer.byteLength(content);
  const note = content.length === 0 ? ' — empty' : '';
  const fence = fenceFor(content);
  const lang = FENCE_LANG[path.extname(abs).toLowerCase()] || '';
  return {
    header: `--- file: ${display} (${span}, ${humanSize(bytes)})${note} ---`,
    body: `${fence}${lang}\n${content.replace(/\n$/, '')}\n${fence}`,
    label: `${display} (${span}, ${humanSize(bytes)})`,
  };
}

/**
 * Expand @path references in `raw` into an attachment-bearing prompt.
 *
 * @returns {{prompt: string, attachments: string[], warnings: string[], error: string|null}}
 *   `error` non-null means nothing should be sent.
 */
export function expandPrompt(raw, opts = {}) {
  const o = { ...DEFAULTS, cwd: process.cwd(), ...opts };
  const warnings = [];
  const attachments = [];
  const blocks = [];
  const seen = new Set();

  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(raw)) !== null) {
    const tok = m[2] !== undefined ? m[2] : m[3];
    if (!tok) continue;

    const hit = resolveToken(tok, o.cwd);
    if (!hit) {
      if (looksPathLike(tok)) warnings.push(`no such file: ${tok} — left as plain text.`);
      continue;
    }
    // Same file twice in one prompt is a repetition, not two attachments; a
    // different line range is a different attachment.
    const key = `${hit.abs}#${hit.range ? hit.range.join('-') : 'all'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const block = hit.isDir
      ? readDirBlock(hit.abs, hit.display, o.maxDirEntries)
      : readFileBlock(hit, o, warnings);
    if (!block) continue;
    if (block.error) { warnings.push(block.error); continue; }

    blocks.push(`${block.header}\n${block.body}`);
    attachments.push(block.label);
  }

  const prompt = blocks.length ? `${raw}\n\n${blocks.join('\n\n')}` : raw;
  if (prompt.length > o.maxPromptChars) {
    return {
      prompt: raw,
      attachments: [],
      warnings,
      error: `prompt would be ${prompt.length} chars, over the ${o.maxPromptChars} limit. Attach fewer files, use line ranges (@file:1-200), or raise MAX_PROMPT_CHARS.`,
    };
  }
  return { prompt, attachments, warnings, error: null };
}

/** Append piped stdin to a prompt as its own labelled block. */
export function withStdin(prompt, stdinText, label = 'stdin') {
  const text = stdinText.replace(/\n$/, '');
  if (!text.trim()) return prompt;
  const fence = fenceFor(text);
  const lines = text.split('\n').length;
  const block = `--- ${label} (${lines} line${lines === 1 ? '' : 's'}, ${humanSize(Buffer.byteLength(text))}) ---\n${fence}\n${text}\n${fence}`;
  return prompt.trim() ? `${prompt}\n\n${block}` : block;
}
