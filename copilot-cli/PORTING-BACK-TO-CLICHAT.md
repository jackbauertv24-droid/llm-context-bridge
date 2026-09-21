# Fixes to port back to clichat

`copilot-cli`'s agent mode is a port of the clichat agent harness
(`clichat/src/agent.mjs` + `src/fstools.mjs`). While running it against the
Microsoft Copilot web UI, four defects turned up. **Three of them exist in
clichat too**, because they came across with the port; one is new here.

This file is the porting spec. It is written to be applied by someone who has
only the clichat checkout in front of them, with no access to the conversation
that produced it. Every change is given as the exact current text and the
exact replacement.

Line numbers refer to clichat at commit `901778c` and are a hint, not an
anchor — match on the text.

| # | Fix | clichat file | Severity |
|---|---|---|---|
| 1 | Anchor the tool-tag regex to column one | `src/agent.mjs` | **executes text the model never meant as a call** |
| 2 | Stop suppressing prose at a mere mention | `src/agent.mjs` | truncates a reply mid-sentence |
| 3 | Tell the model a tag is an action, not an example | `src/agent.mjs` | invites edits during a read-only task |
| 4 | Report tag-shaped text that was passed over | `src/agent.mjs` + the UI | a call can silently not happen |
| 5 | Written files lose their trailing newline | `src/fstools.mjs` | every file the agent writes |

**Do not port the fenced-code-block handling** from `copilot-cli/lib-agent.mjs`
(`stripFences`, and the prompt rule about fences). That exists only because
Copilot's answer is read out of a *rendered page*, where a bare tag can be
eaten by an HTML sanitizer and markdown would reflow a file body. clichat reads
a raw response body and needs none of it.

---

## How the bug showed up

A user asked the agent for a **code review**. The CLI kept stopping to ask
permission to `edit` and `write` files, although nothing had been asked to
change, and the review text itself arrived truncated.

Neither symptom was the model misbehaving. Reviewing code means *talking
about* code, and the harness could not tell the difference between a tag the
model emitted as an action and a tag it mentioned while explaining something.

## Reproducing it before you change anything

Run this against the unfixed clichat:

```js
import { parseToolTags } from './src/agent.mjs';

const shapes = {
  'complete tag mid-sentence':
    'Review done. You could fix it with <clichat:write path="README.md">text</clichat:write> — your call.',
  'tag quoted in backticks':
    'The protocol uses `<clichat:write path="f">body</clichat:write>` for new files.',
  'tag quoted from a file under review':
    'In agent.mjs the usage string is <clichat:read path="src/index.js"/>, which looks right.',
  'tag indented inside a block':
    '  <clichat:read path="a.js"/>',
};
for (const [name, text] of Object.entries(shapes)) {
  const calls = parseToolTags(text).filter((c) => !c.unterminated);
  console.log((calls.length ? 'FIRES ' : 'quiet ') + name, calls.map((c) => c.name));
}
```

All four print `FIRES`. After fix 1 all four print `quiet`, and genuine calls
still fire.

The third shape is the one that makes this urgent: **every source file in a
repo that implements this protocol contains the protocol**, so asking the
agent to review its own project is close to guaranteed to execute something.

---

## Fix 1 — anchor the tool-tag regex to column one

`src/agent.mjs`, line 24.

The prompt has always contained the rule *"A tool tag must start at the
beginning of a line."* Nothing enforced it. The regex is unanchored, so a tag
anywhere in a reply — mid-sentence, inside backticks, quoted from a file — is
parsed as a call and executed.

**Before**

```js
const OPEN = new RegExp(`<${NS}:([a-z]+)((?:\\s+[a-z_]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`, 'g');
```

**After**

```js
// Anchored to the start of a line, and multiline, which is the rule the
// prompt has always stated and the parser never enforced. Unanchored, a reply
// that merely *talks about* the protocol executes it: asked for a code review,
// the model writes "you could fix this with <clichat:edit path=...>" and the
// harness dutifully offers to edit the file. Reviewing a file that contains
// the protocol does the same. A tag is an action; a mention of a tag is prose,
// and column zero is what separates them.
const OPEN = new RegExp(`^<${NS}:([a-z]+)((?:\\s+[a-z_]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`, 'gm');
```

Only two things change: a leading `^`, and the `m` flag alongside `g`.

The rest of `parseToolTags` needs no change. Its `OPEN.lastIndex = end +
closeTag.length` still works, and a tag appearing *inside* a body is still
skipped, because the scan resumes after the closing tag.

### Why strict, and what it costs

Requiring column one will also ignore a genuine call that the model indented —
inside a numbered list, for instance. That is the right trade: **executing a
mention is far worse than skipping a call.** The cost is paid back by fix 4,
which makes the skip visible instead of silent.

Do not "fix" this by allowing leading whitespace. That re-admits the indented
quotation case, which is one of the four shapes above.

---

## Fix 2 — stop suppressing prose at a mere mention

`src/agent.mjs`, `TagSuppressor`, line 126.

The same bug in the streaming path, and it is the reason the review looked
mangled rather than merely over-eager. `TagSuppressor.push` trips on the first
`<clichat:` it sees and suppresses **everything from there to the end of the
reply**. In a review, that is usually a sentence or two in, so the user sees
the first line and nothing else.

It must trip only on a marker at the start of a line, let a mention through,
and carry on scanning. That is harder than it sounds, because the marker can
be split across streamed chunks and the character before it may already have
been emitted — so the line-start flag has to be carried across pushes.

**Replacement** (drop-in; the constructor gains one field and there is one new
private helper):

```js
// Hides tag syntax from the terminal while prose streams through.
//
// Everything from the first tag onward is suppressed: the loop prints a
// one-line summary per call afterwards, which is far more readable than
// watching a file scroll past twice.
//
// Only a marker at the START OF A LINE counts. A reply that discusses the
// protocol -- any code review -- otherwise loses everything after the first
// time it says the word. Because a chunk boundary can fall anywhere, the
// "am I at the start of a line" flag is carried across pushes rather than
// recomputed from the tail, whose earlier characters have already gone out.
export class TagSuppressor {
  constructor() {
    this.done = false;
    this.tail = '';
    this.bol = true;          // true at the very start of a reply
  }

  // Moves `n` characters out of the tail, keeping the line-start flag honest.
  #take(n) {
    const out = this.tail.slice(0, n);
    if (out) this.bol = out.endsWith('\n');
    this.tail = this.tail.slice(n);
    return out;
  }

  push(text) {
    if (this.done) return '';
    this.tail += text;
    const MARK = `<${NS}:`;
    let out = '';

    for (;;) {
      const at = this.tail.indexOf(MARK);
      if (at < 0) break;
      const atLineStart = at === 0 ? this.bol : this.tail[at - 1] === '\n';
      if (atLineStart) {
        out += this.#take(at);
        this.done = true;
        this.tail = '';
        return out;
      }
      // A mention, not a call. Let it through and keep scanning after it.
      out += this.#take(at + MARK.length);
    }

    // Hold back what could still grow into the marker.
    out += this.#take(Math.max(0, this.tail.length - MARK.length));
    return out;
  }

  finish() { const out = this.done ? '' : this.tail; this.tail = ''; return out; }
}
```

Note `MARK.length` replaces the old `NS.length - 2` arithmetic for the
held-back window; they are the same number, but the named form does not have
to be re-derived when `NS` changes.

### Verifying it

This was checked by feeding each reply through the suppressor in chunks of 1,
3, 7 and all-at-once, and comparing what reached the terminal:

| Reply | Should reach the terminal |
|---|---|
| `Here is my review.\nAll good.` | all of it |
| `Reading it now.\n<clichat:read path="a.js"/>` | `Reading it now.\n` |
| ``The syntax is `<clichat:write path="f">body</clichat:write>` for new files.`` | all of it |
| `You could fix it with <clichat:edit path="a"> and a block.\nNothing changed.` | all of it |
| `Use <clichat:read path="x"/> normally. Now doing it:\n<clichat:read path="x"/>` | up to and including `Now doing it:\n` |
| `<clichat:list path="."/>` (first thing in the reply) | nothing |
| `Both <clichat:read path="a"/> and <clichat:list path="b"/> are read-only.` | all of it |

Chunk size 1 is the case worth keeping: it is the one that catches a
line-start flag computed from the tail instead of carried across pushes.

---

## Fix 3 — tell the model a tag is an action, not an example

`src/agent.mjs`, `renderSystemPrompt`.

Fixes 1 and 2 stop the harness from *executing* prose. They do not stop the
model from reaching for `write` and `edit` when it was only asked to look. The
prompt frames every task as a change to be made — "You are a coding agent…
You act by emitting tool tags" — and never says that some tasks are read-only,
or that a write interrupts a human.

**Change** line 42 from

```js
    '- A tool tag must start at the beginning of a line.',
```

to

```js
    '- A tool tag must start at the beginning of a line, in column one.',
    '- A tag ANYWHERE in your reply is executed. It is not an illustration.',
    '  Never quote, mention or give an example of a tag while explaining',
    '  something. Describe the change in words instead.',
```

**And add**, after line 56 (`'- Keep prose short. …'`):

```js
    '',
    'WHEN NOT TO CHANGE ANYTHING',
    '- If the task only asks you to look at code — review it, audit it, explain',
    '  it, find a bug, answer a question about it — then read and list are the',
    '  only tools you may use. Report what you found in prose and stop.',
    '- Every write and edit interrupts the user to ask permission. Do not emit',
    '  one unless the task actually asked for the file to change.',
    '- Proposing a change is prose. Making one is a tag. Do not confuse them.',
```

---

## Fix 4 — report tag-shaped text that was passed over

`src/agent.mjs`.

Fix 1 is deliberately strict, so a genuine call that the model indented will
now do nothing. Silence there is its own bug: the user is told a file will be
changed, and it is not. Count what was skipped and say so.

**Add**, next to the `OPEN` definition:

```js
// Tag-shaped text that is NOT a call, so the user can be told when something
// that looked like one was passed over rather than silently dropped.
const MENTION = new RegExp(`<${NS}:[a-z]+`, 'g');

export function countMentions(text) {
  let loose = 0;
  for (const m of String(text).matchAll(MENTION)) {
    const bol = m.index === 0 || text[m.index - 1] === '\n';
    if (!bol) loose++;
  }
  return loose;
}
```

**Change** the loop, lines 200–201, from

```js
    const calls = parseToolTags(reply);
    if (!calls.length) return { done: true, steps: step };
```

to

```js
    const calls = parseToolTags(reply);
    // Tag-shaped text that was not in column one is passed over. Say so
    // whether or not anything else ran: silence here would leave the user
    // wondering why a file they were just told about never changed.
    const loose = countMentions(reply);
    if (loose && ui.ignored) ui.ignored(loose);
    if (!calls.length) return { done: true, steps: step };
```

The `ui.ignored &&` guard means no UI has to change for the loop to keep
working. Add the method wherever a `ui` object is built (`src/cli.mjs`, and
the web UI if it has its own):

```js
  ignored: (n) => note(`ignored ${n} tag-like mention${n === 1 ? '' : 's'} that were not at the start of a line`),
```

In copilot-cli, `countMentions` takes the reply *after* fences are stripped.
clichat has no fences, so it takes the reply as it stands.

---

## Fix 5 — written files lose their trailing newline

`src/fstools.mjs`, the `write` tool. **This one is not about code review**; it
affects every file the agent writes, in both projects.

`parseToolTags` drops one newline at each end of a tag body, so that

```
<clichat:write path="a.js">
line one
line two
</clichat:write>
```

does not gain a blank first and last line. That is correct for the tag layout,
but it also removes the file's own final newline: the body becomes
`"line one\nline two"` and the file is written without a terminating `\n`.

Fix it in the `write` tool rather than in the parser — the parser's trimming
is about tag syntax, and `edit` is unaffected because `applyEdits` rebuilds
the whole text.

**Before**

```js
      const fd = openRegular(full, a.path, { write: true });
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
```

**After**

```js
      // The tag body had one trailing newline removed as syntax; a file
      // should still end with one.
      const contents = body === '' || body.endsWith('\n') ? body : body + '\n';

      const fd = openRegular(full, a.path, { write: true });
      try {
        writeSync(fd, contents);
      } finally {
        closeSync(fd);
      }
```

and use `contents` in the byte count on the following lines:

```js
      const lines = contents.split('\n').length;
      return `${existed ? 'overwrote' : 'created'} ${a.path} `
        + `(${lines} lines, ${Buffer.byteLength(contents)} bytes)`;
```

Worth checking after this change that read → write of an unchanged file is a
no-op rather than a one-byte diff.

---

## Checklist

- [ ] `OPEN` anchored with `^` and the `m` flag (fix 1)
- [ ] The four repro shapes print `quiet`; a fenceless call at column one still fires
- [ ] `TagSuppressor` replaced and checked at chunk sizes 1, 3, 7 and whole (fix 2)
- [ ] Prompt: "a tag anywhere is executed" and the `WHEN NOT TO CHANGE ANYTHING` block (fix 3)
- [ ] `countMentions` + `ui.ignored` wired into the loop and every UI (fix 4)
- [ ] `write` restores the trailing newline, and the byte count matches what was written (fix 5)
- [ ] Nothing about code fences was ported

Once these are in, ask the agent to review a file that contains the protocol —
`src/agent.mjs` itself is the sharpest test. It should produce a review and
change nothing.
