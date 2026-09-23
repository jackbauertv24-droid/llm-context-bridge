// The tools the agent can actually run.
//
// Ported from the clichat agent harness (src/fstools.mjs), which was written
// against a different chat backend. The confinement logic below is carried
// over unchanged and deliberately so: it is the part that took care to get
// right, and divergence between the two copies would be a bug in whichever
// one fell behind. Only the tag namespace in the usage strings differs.
//
// Everything here is confined to a single root directory. The model is being
// asked to imitate a format it was never trained on, so it will occasionally
// emit a path that makes no sense; the confinement is what makes that boring
// instead of dangerous.
//
// Confinement is enforced three times over, because a path string alone cannot
// carry it:
//
//   1. `safePath` resolves the path against the realpath of the root and
//      rejects anything landing outside, including via a symlinked directory
//      in the middle, and refuses outright when the final component is itself
//      a symlink. That last part matters: `existsSync` follows links, so a
//      DANGLING symlink reads as "this leaf does not exist yet" and resolves
//      innocently against the root -- and then the write follows it straight
//      out of the workspace.
//   2. Before writing, the parent directory is re-resolved after `mkdir` and
//      re-checked, so a link cannot be introduced part way through.
//   3. The file is opened with O_NOFOLLOW, so even if a symlink wins the race
//      between the check and the open, the kernel refuses it.
//
// Nothing here executes anything. The worst a confused reply can do is write a
// bad file inside the root.

import {
  readFileSync, readdirSync, lstatSync, statSync, mkdirSync,
  openSync, closeSync, writeSync, readSync, fstatSync, realpathSync, constants,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, basename, relative, join, sep, parse } from 'node:path';

const MAX_READ = 200_000;   // bytes; a file bigger than this is truncated
const MAX_ENTRIES = 400;    // directory entries per listing
const SKIP = new Set(['.git', 'node_modules', '.cache', 'dist', 'build']);
const MAX_TREE = 1000;        // entries per tree
const TREE_DEPTH = 8;         // default depth; the model may ask for up to 20
const MAX_MATCHES = 200;      // search matches in total
const MAX_PER_FILE = 20;      // search matches from any one file
const MAX_SEARCH_BYTES = 1_000_000;   // larger files are not searched
const MAX_LINE_SHOWN = 240;   // characters of a matching line shown

// Roots where confinement would be meaningless. Handing the agent your home
// directory is not a sandbox, it is the whole problem with a longer prefix.
const FORBIDDEN_ROOTS = new Set([
  '/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev',
  '/proc', '/sys', '/var', '/opt', '/root', '/home', '/srv', '/run',
]);

export class ToolError extends Error {}

// Validates the workspace root itself, before any tool runs.
export function resolveRoot(dir) {
  let real;
  try {
    real = realpathSync(resolve(dir));
  } catch {
    throw new ToolError(`no such directory: ${dir}`);
  }
  if (!statSync(real).isDirectory()) throw new ToolError(`not a directory: ${dir}`);
  if (FORBIDDEN_ROOTS.has(real) || real === parse(real).root) {
    throw new ToolError(`refusing to use ${real} as a workspace root`);
  }
  if (real === realpathSync(homedir())) {
    throw new ToolError(
      'refusing to use your home directory as a workspace root; '
      + 'run this inside a project, or pass --root',
    );
  }
  return real;
}

// True if the path exists at all, INCLUDING a symlink whose target does not.
// `existsSync` follows links and would answer false for a dangling one.
function lexists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

function assertInside(rootReal, resolved, shown) {
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new ToolError(`path escapes the workspace root: ${shown}`);
  }
}

// Resolves `p` inside `root`, refusing anything that escapes.
//
// The file itself may not exist yet (that is the point of `write`), so the
// realpath check walks up to the nearest existing ancestor of its PARENT: a
// symlinked directory anywhere on the way out is caught, without requiring the
// leaf. The leaf is handled separately, by refusing to touch a symlink at all.
export function safePath(root, p) {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('no path given');
  if (p.includes('\0')) throw new ToolError('path contains a null byte');

  const rootReal = realpathSync(root);
  const target = resolve(rootReal, p);

  // Resolve the parent chain through any symlinks it contains.
  let probe = dirname(target);
  while (!lexists(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let probeReal;
  try {
    probeReal = realpathSync(probe);
  } catch {
    throw new ToolError(`cannot resolve path: ${p}`);   // dangling link in the chain
  }
  const rest = relative(probe, dirname(target));
  const parentReal = rest ? join(probeReal, rest) : probeReal;
  const resolved = target === rootReal ? rootReal : join(parentReal, basename(target));

  assertInside(rootReal, resolved, p);

  // A symlink at the leaf is refused rather than followed. Inside a workspace
  // it is almost always a mistake, and it is the one case the checks above
  // cannot see through.
  if (lexists(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new ToolError(`refusing to follow the symlink at ${p}`);
  }
  return resolved;
}

// Opens `full` for reading or writing without following a final symlink, and
// refuses anything that is not an ordinary file (a fifo would hang the read, a
// device is not ours to touch).
function openRegular(full, shown, { write = false } = {}) {
  if (lexists(full)) {
    const st = lstatSync(full);
    if (st.isDirectory()) throw new ToolError(`${shown} is a directory`);
    if (!st.isFile()) throw new ToolError(`${shown} is not an ordinary file`);
    // A hard link shares its inode with a name elsewhere, which realpath cannot
    // see. Overwriting it would change that other file too.
    if (write && st.nlink > 1) {
      throw new ToolError(`${shown} is a hard link with ${st.nlink} names; refusing to write`);
    }
  }
  const flags = (write ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
    : constants.O_RDONLY) | constants.O_NOFOLLOW;
  try {
    return openSync(full, flags, 0o644);
  } catch (err) {
    if (err.code === 'ELOOP') throw new ToolError(`refusing to follow the symlink at ${shown}`);
    if (err.code === 'ENOENT') throw new ToolError(`no such file: ${shown}`);
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new ToolError(`permission denied: ${shown}`);
    throw err;
  }
}

// ------------------------------------------------------------ search/replace
//
// The edit grammar is the SEARCH/REPLACE block, deliberately: it is all over
// the training data, so the model already knows the shape without being taught
// it. Inside a raw tag body the markers need no escaping either.
//
//   <<<<<<< SEARCH
//   the exact lines to find
//   =======
//   what to put there instead
//   >>>>>>> REPLACE

const HEAD = /^[ \t]*<{5,9} *SEARCH *$/;
const MID = /^[ \t]*={5,9} *$/;
const TAIL = /^[ \t]*>{5,9} *REPLACE *$/;

export function parseEditBlocks(body) {
  const lines = String(body).split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!HEAD.test(lines[i])) continue;
    const search = [];
    for (i++; i < lines.length && !MID.test(lines[i]); i++) search.push(lines[i]);
    if (i >= lines.length) throw new ToolError('an edit block is missing its ======= divider');
    const replace = [];
    for (i++; i < lines.length && !TAIL.test(lines[i]); i++) replace.push(lines[i]);
    if (i >= lines.length) throw new ToolError('an edit block is missing its >>>>>>> REPLACE line');
    if (!search.length) {
      throw new ToolError('an edit block has an empty SEARCH section; use write to create a file');
    }
    blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
  }
  if (!blocks.length) {
    throw new ToolError('no <<<<<<< SEARCH / ======= / >>>>>>> REPLACE block found');
  }
  return blocks;
}

const rstrip = (s) => s.replace(/[ \t]+$/, '');
const indentOf = (s) => s.match(/^[ \t]*/)[0];

// Finds the one window of `lines` matching `want`, tolerating two slips the
// model actually makes: trailing whitespace, and a block quoted at the wrong
// indentation. The indent has to be wrong *uniformly* -- a consistent prefix
// added to or removed from every line -- which is what happens when a model
// re-indents a snippet, and is narrow enough not to match something unintended.
//
// Anything ambiguous is an error rather than a guess. Silently editing the
// wrong one of two matches is the failure mode worth designing against.
function locate(lines, want) {
  const wl = want.split('\n');
  const hits = [];

  for (let i = 0; i + wl.length <= lines.length; i++) {
    let delta = null;
    let ok = true;
    for (let j = 0; j < wl.length; j++) {
      const have = rstrip(lines[i + j]);
      const need = rstrip(wl[j]);
      if (have === need) continue;
      if (have.trim() !== need.trim()) { ok = false; break; }
      if (!need.trim()) continue;                       // blank either way
      const d = indentOf(have).slice(0, indentOf(have).length - indentOf(need).length);
      if (indentOf(have) !== d + indentOf(need)) { ok = false; break; }
      if (delta === null) delta = d;
      else if (delta !== d) { ok = false; break; }      // indent shift not uniform
    }
    if (ok) hits.push({ at: i, delta: delta ?? '' });
  }

  if (!hits.length) return { at: -1 };
  if (hits.length > 1) {
    throw new ToolError(
      `the SEARCH text matches ${hits.length} places; include more surrounding `
      + 'lines so it identifies exactly one',
    );
  }
  return hits[0];
}

// Applies every block in order against the evolving text.
export function applyEdits(text, blocks) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  let changed = 0;

  blocks.forEach((b, n) => {
    const { at, delta } = locate(lines, b.search);
    if (at < 0) {
      throw new ToolError(
        `the SEARCH text of block ${n + 1} is not in the file; read it again and `
        + 'quote the lines exactly as they appear',
      );
    }
    const wl = b.search.split('\n');
    const rl = b.replace === '' ? [] : b.replace.split('\n')
      .map((l) => (l.trim() ? delta + l : l));
    lines = [...lines.slice(0, at), ...rl, ...lines.slice(at + wl.length)];
    changed++;
  });

  return { text: lines.join(eol), changed };
}

// Forward slashes whatever the platform, so the model sees one path style.
const relOf = (rootReal, full) => relative(rootReal, full).split(sep).join('/') || '.';

const intArg = (v, def, lo, hi, name) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new ToolError(`${name} must be a whole number from ${lo} to ${hi}`);
  return n;
};

// A directory to walk, confined like every other path.
function dirArg(ctx, p) {
  const shown = p || '.';
  const rootReal = realpathSync(ctx.root);
  const full = safePath(rootReal, shown);
  if (!lexists(full)) throw new ToolError(`no such directory: ${shown}`);
  if (!lstatSync(full).isDirectory()) throw new ToolError(`${shown} is a file; use read`);
  return { rootReal, full, shown };
}

// Depth-first, sorted, never following a symlink, so the walk cannot leave
// the directory it started in. visit() returns false to stop early.
function walk(dir, depth, maxDepth, visit) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }).sort(byName); } catch { return true; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (visit(e, full, depth) === false) return false;
    if (e.isDirectory() && depth < maxDepth && walk(full, depth + 1, maxDepth, visit) === false) return false;
  }
  return true;
}

// "*.mjs", "test*", "*.{js,mjs}" against a file's name.
function globToRegExp(glob) {
  const alts = [];
  const body = String(glob).replace(/\{([^}]*)\}/g, (_, list) => {
    alts.push(list.split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|'));
    return `\u0000${alts.length - 1}\u0000`;
  });
  const re = body.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `(?:${alts[Number(i)]})`);
  return new RegExp(`^${re}$`, 'i');
}

// "120-180", "120-", "120" (that one line), "-40" (the first forty).
function parseRange(spec, total) {
  const m = /^\s*(\d*)\s*(-)?\s*(\d*)\s*$/.exec(String(spec));
  if (!m || (!m[1] && !m[3])) throw new ToolError(`lines must look like "120-180", "120-" or "120", not "${spec}"`);
  const from = m[1] ? Number(m[1]) : 1;
  const to = m[3] ? Number(m[3]) : (m[2] ? total : from);
  if (from < 1 || to < from) throw new ToolError(`lines "${spec}" is not a valid range`);
  return { from, to: Math.min(to, total) };
}

export const tools = {
  read: {
    summary: 'read a file',
    describe: (a) => `read ${a.path}${a.lines ? ` lines ${a.lines}` : ''}`,
    usage: '<copilot:read path="src/index.js"/>\n'
      + '<copilot:read path="src/index.js" lines="120-180"/>\n'
      + '# lines is optional: "120-180", "120-" to the end, or "120" for one line.',
    run(ctx, a) {
      const full = safePath(ctx.root, a.path);
      if (a.lines !== undefined && a.lines !== '') return readRange(full, a.path, a.lines);
      const fd = openRegular(full, a.path);
      try {
        const size = fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, MAX_READ));
        readSync(fd, buf, 0, buf.length, 0);
        const text = buf.toString('utf8');
        return size > MAX_READ
          ? `${text}\n... [truncated at ${MAX_READ} bytes of ${size}]; use lines="…" to read further`
          : text;
      } finally {
        closeSync(fd);
      }
    },
  },

edit: {
    body: true,
    summary: 'change part of a file (preferred over write for an existing file)',
    describe: (a, body) => {
      let n;
      try { n = parseEditBlocks(body).length; } catch { n = 0; }
      return `edit ${a.path}${n ? ` (${n} block${n === 1 ? '' : 's'})` : ''}`;
    },
    usage: '<copilot:edit path="src/index.js">\n'
      + '<<<<<<< SEARCH\nthe exact lines to find\n'
      + '=======\nwhat to put there instead\n'
      + '>>>>>>> REPLACE\n</copilot:edit>',
    mutates: true,
    run(ctx, a, body) {
      const rootReal = realpathSync(ctx.root);
      const full = safePath(rootReal, a.path);
      if (!lexists(full)) throw new ToolError(`no such file: ${a.path}; use write to create it`);

      const blocks = parseEditBlocks(body);

      const rfd = openRegular(full, a.path);
      let before;
      try { before = readFileSync(rfd, 'utf8'); } finally { closeSync(rfd); }

      const { text, changed } = applyEdits(before, blocks);
      if (text === before) return `${a.path} already matched the replacement; nothing changed`;

      const wfd = openRegular(full, a.path, { write: true });
      try { writeSync(wfd, text); } finally { closeSync(wfd); }

      const d = text.split('\n').length - before.split('\n').length;
      return `edited ${a.path} (${changed} block${changed === 1 ? '' : 's'}, `
        + `${d === 0 ? 'same line count' : `${d > 0 ? '+' : ''}${d} lines`})`;
    },
  },

  write: {
    body: true,
    summary: 'create or overwrite a file',
    describe: (a, body) => `write ${a.path} (${body.split('\n').length} lines)`,
    usage: '<copilot:write path="src/index.js">\nthe complete file contents\n</copilot:write>',
    mutates: true,
    run(ctx, a, body) {
      const rootReal = realpathSync(ctx.root);
      const full = safePath(rootReal, a.path);
      const existed = lexists(full);

      mkdirSync(dirname(full), { recursive: true });
      // mkdir happened after the check, so confirm the parent is still ours.
      assertInside(rootReal, realpathSync(dirname(full)), a.path);

      // The tag body had one trailing newline removed as syntax (see
      // parseToolTags); a file should still end with one. Without this every
      // file the agent writes is a byte short, and read -> write of an
      // unchanged file shows up as a diff.
      const contents = body === '' || body.endsWith('\n') ? body : body + '\n';

      const fd = openRegular(full, a.path, { write: true });
      try {
        writeSync(fd, contents);
      } finally {
        closeSync(fd);
      }
      const lines = contents.split('\n').length;
      return `${existed ? 'overwrote' : 'created'} ${a.path} `
        + `(${lines} lines, ${Buffer.byteLength(contents)} bytes)`;
    },
  },

  list: {
    summary: 'list a directory',
    describe: (a) => `list ${a.path || '.'}`,
    usage: '<copilot:list path="src"/>',
    run(ctx, a) {
      const shown = a.path || '.';
      const full = safePath(ctx.root, shown);
      if (!lexists(full)) throw new ToolError(`no such directory: ${shown}`);
      if (!lstatSync(full).isDirectory()) throw new ToolError(`${shown} is a file; use read`);

      const out = [];
      for (const e of readdirSync(full, { withFileTypes: true }).sort(byName)) {
        if (SKIP.has(e.name)) continue;
        if (e.isDirectory()) { out.push(`${e.name}/`); continue; }
        if (e.isSymbolicLink()) { out.push(`${e.name}  (symlink, not followed)`); continue; }
        let size = '';
        try { size = `  ${lstatSync(join(full, e.name)).size}b`; } catch { /* raced */ }
        out.push(`${e.name}${size}`);
        if (out.length >= MAX_ENTRIES) { out.push('... [truncated]'); break; }
      }
      return out.length ? out.join('\n') : '(empty)';
    },
  },

  tree: {
    summary: 'list a directory and everything under it, in one go',
    describe: (a) => `tree ${a.path || '.'}${a.depth ? ` (depth ${a.depth})` : ''}`,
    usage: '<copilot:tree path="src" depth="3"/>\n'
      + '# path and depth may be left out; the default is the whole workspace.',
    run(ctx, a) {
      const { rootReal, full } = dirArg(ctx, a.path);
      const maxDepth = intArg(a.depth, TREE_DEPTH, 1, 20, 'depth') - 1;
      const out = [];
      let files = 0; let dirs = 0; let truncated = false;
      // Full paths, one per line, rather than indentation: a path still reads
      // correctly if the page runs lines together, where an indented tree
      // turns into soup.
      walk(full, 0, maxDepth, (e, p) => {
        if (out.length >= MAX_TREE) { truncated = true; return false; }
        const rel = relOf(rootReal, p);
        if (e.isSymbolicLink()) { out.push(`${rel}  (symlink, not followed)`); return true; }
        if (e.isDirectory()) { dirs++; out.push(`${rel}/`); return true; }
        files++;
        let size = '';
        try { size = `  ${lstatSync(p).size}b`; } catch { /* raced */ }
        out.push(`${rel}${size}`);
        return true;
      });
      if (!out.length) return '(empty)';
      out.push(truncated
        ? `... [stopped at ${MAX_TREE} entries; tree a subdirectory, or use a smaller depth]`
        : `(${files} files, ${dirs} directories)`);
      return out.join('\n');
    },
  },

  search: {
    summary: 'find text in files; shows file:line: text for each match',
    describe: (a) => `search ${a.regex === 'true' ? 'regex ' : ''}"${a.query || ''}"${a.path ? ` in ${a.path}` : ''}${a.glob ? ` (${a.glob})` : ''}`,
    usage: '<copilot:search query="parseToolTags" path="src" glob="*.mjs" context="2"/>\n'
      + '# only query is needed. regex="true" makes it a regular expression;'
      + ' case="true" matches case exactly.',
    run(ctx, a) {
      if (typeof a.query !== 'string' || !a.query) throw new ToolError('no query given');
      const { rootReal, full } = dirArg(ctx, a.path);
      const context = intArg(a.context, 0, 0, 5, 'context');
      const flags = a.case === 'true' ? '' : 'i';
      let re;
      try {
        re = a.regex === 'true'
          ? new RegExp(a.query, flags)
          : new RegExp(a.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      } catch (e) { throw new ToolError(`not a valid regular expression: ${e.message}`); }
      const nameOk = a.glob ? globToRegExp(a.glob) : null;

      const out = [];
      let matches = 0; let filesHit = 0; let skippedLarge = 0; let stopped = false;
      walk(full, 0, 50, (e, p) => {
        if (!e.isFile()) return true;
        if (nameOk && !nameOk.test(e.name)) return true;
        let st;
        try { st = lstatSync(p); } catch { return true; }
        if (st.size > MAX_SEARCH_BYTES) { skippedLarge++; return true; }
        let buf;
        try {
          const fd = openRegular(p, relOf(rootReal, p));
          try { buf = readFileSync(fd); } finally { closeSync(fd); }
        } catch { return true; }
        if (buf.subarray(0, 8000).includes(0)) return true;          // binary
        const lines = buf.toString('utf8').split(/\r?\n/);
        const rel = relOf(rootReal, p);
        let inFile = 0; let lastShown = -1;
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i].slice(0, 4000))) continue;
          if (inFile === 0) filesHit++;
          inFile++; matches++;
          if (inFile > MAX_PER_FILE) { if (inFile === MAX_PER_FILE + 1) out.push(`${rel}: ... [more matches in this file not shown]`); continue; }
          const from = Math.max(lastShown + 1, i - context);
          if (context && lastShown >= 0 && from > lastShown + 1) out.push('--');
          for (let j = from; j <= Math.min(lines.length - 1, i + context); j++) {
            const text = lines[j].length > MAX_LINE_SHOWN ? `${lines[j].slice(0, MAX_LINE_SHOWN)}…` : lines[j];
            out.push(`${rel}:${j + 1}${j === i ? ':' : '-'} ${text}`);
            lastShown = j;
          }
          if (matches >= MAX_MATCHES) { stopped = true; return false; }
        }
        return true;
      });
      if (!matches) return `no matches for "${a.query}"${skippedLarge ? ` (${skippedLarge} files over 1 MB were not searched)` : ''}`;
      out.push(stopped
        ? `... [stopped at ${MAX_MATCHES} matches; narrow it with path, glob, or a more specific query]`
        : `(${matches} match${matches === 1 ? '' : 'es'} in ${filesHit} file${filesHit === 1 ? '' : 's'}${skippedLarge ? `; ${skippedLarge} files over 1 MB not searched` : ''})`);
      return out.join('\n');
    },
  },
};

// Lines of a file, numbered, with the total so the model knows what is left.
function readRange(full, shown, spec) {
  const fd = openRegular(full, shown);
  let text;
  try { text = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const { from, to } = parseRange(spec, lines.length);
  if (from > lines.length) throw new ToolError(`${shown} has only ${lines.length} lines`);
  const width = String(to).length;
  const body = [];
  let bytes = 0;
  for (let i = from; i <= to; i++) {
    const line = `${String(i).padStart(width)}: ${lines[i - 1]}`;
    bytes += line.length + 1;
    if (bytes > MAX_READ) { body.push(`... [stopped at ${MAX_READ} bytes; read from line ${i}]`); break; }
    body.push(line);
  }
  return [`${shown} lines ${from}-${to} of ${lines.length} (the numbers are not part of the file)`, ...body].join('\n');
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
