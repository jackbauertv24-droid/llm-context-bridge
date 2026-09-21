# copilot-cli

Talk to a chat web UI you are already signed into, from a terminal, so you stop
copy-pasting by hand. It attaches to **your own** Chrome over the DevTools
Protocol, types your prompt into the page, waits for the answer to finish, and
prints it.

This is UI automation of a session you own — the same category as Selenium or
Playwright against your own logged-in app. It reads and writes only visible DOM.
It does **not** read network traffic, request headers, cookies or tokens, and it
sends nothing anywhere except to the local Chrome debugging port you opened.

Zero npm dependencies — the CDP client is JSON over node's builtin WebSocket, so
it runs where `npm install` is blocked. Node 18+ (for builtin `WebSocket`;
Node 20+ recommended).

## Launch Chrome with remote debugging

The CLI connects to a debugging port. You start Chrome yourself; nothing here
starts or configures a browser.

**The Chrome 136+ gotcha:** for security, recent Chrome refuses
`--remote-debugging-port` when pointed at your *default* profile directory. Use a
separate `--user-data-dir` and sign in once in that window — cookies persist
there, so you only sign in the first time.

**Windows**
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%TEMP%\copilot-cli-profile"
```

**macOS**
```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.copilot-cli-profile"
```

**Linux**
```
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.copilot-cli-profile"
```

Edge works identically — same flags, `msedge` / `Microsoft Edge` as the binary.

In that Chrome window: sign in and open your chat page. Confirm the port is up by
visiting `http://127.0.0.1:9222/json/version` — you should see JSON.

> The debugging port is unauthenticated and local. Anything on your machine that
> can reach `127.0.0.1:9222` can drive that browser. Use a throwaway profile,
> and close the debug window when you are done.

## Two commands, run once

**1. Probe the page** (read-only) so the selectors are known:
```
node probe.mjs
```
It prints — and saves to `copilot-cli-probe.txt` — the input box, send button
and answer-region candidates it found. If no tab matches `TAB_MATCH` it
inventories **every** page tab rather than guessing at one, so a single run
always contains the right page. Because page structure differs and changes over
time, **paste that whole block back** and the selectors get pinned precisely.

**2. Chat:**
```
node chat.mjs
> summarize my last email from Jane
...answer prints here...
> /quit
```

The first answer that prints is proof the bridge works end to end.

## Let the CLI do the reading

The point of the bridge is to stop copy-pasting, so write `@path` in a prompt
and the file is read here and pasted into the page for you:

```
node chat.mjs "review @src/app.js"          # one shot, answer on stdout
node chat.mjs "explain @src/app.js:40-80"   # just those lines
node chat.mjs "what is in @src/"            # a directory listing
git diff | node chat.mjs "review this"      # stdin becomes its own block
```

Quote paths with spaces (`@"my notes.md"`). Binary and oversized files are
skipped with a warning; a prompt over the budget is **refused rather than
truncated**, because half a file in a chat is worse than none. Likely
credentials in an attached file are flagged before it is sent. Limits are
`MAX_FILE_BYTES` (256 KB) and `MAX_PROMPT_CHARS` (100000).

The answer goes to stdout and every diagnostic to stderr, so
`node chat.mjs "..." > answer.md` captures the answer alone.

## When the DOM is not what the defaults expect

`chat.mjs` auto-detects the input, send button and answer region with
heuristics. If a turn misbehaves, the diagnostics tell you which step:

- `/debug` — the last turn's step log: what it picked as input, how it sent
  (Enter vs. clicking a button), how it extracted the answer, and the character
  counts at each stage.
- `[bridge] could not locate the input box` — run `node probe.mjs`, share the
  report.
- `[bridge] sent, but extracted no answer text` — the send worked; the answer
  selector needs pinning.

Defaults are already pinned from a live probe of copilot.cloud.microsoft:
`#m365-chat-editor-target-element` for the input and
`[data-testid="markdown-reply"]` for the answer. Copilot has no send button
until you type, so Enter is the send path. Both selectors fall back to
auto-detection if they match nothing, which is what keeps the tool usable
against another chat UI.

Pin any selector with an env var (values come from the probe report's `path`):
```
INPUT_SELECTOR='textarea[aria-label="Ask Copilot"]' \
SEND_SELECTOR='button[aria-label="Send"]' \
ANSWER_SELECTOR='[data-author-role="assistant"]' \
node chat.mjs
```

Other env vars: `CDP_PORT` (9222), `CDP_HOST` (127.0.0.1), `TAB_MATCH`
(`copilot.cloud.microsoft`), `STOP_SELECTOR` (auto — the control shown while
generating), `QUIET_MS` (1500 — the fallback silence that counts as "done"),
`ANSWER_TIMEOUT_MS` (120000).

## How a turn works

1. `chat.mjs` finds your tab via `http://127.0.0.1:9222/json` and opens its CDP
   WebSocket.
2. Each prompt is run as one `Runtime.evaluate` of a self-contained function in
   the page: it sets the input text (native setter + `input` event for
   textareas; `execCommand('insertText')` for rich contenteditable editors),
   sends (Enter, falling back to a send-button click), then waits for the
   answer to be finished (below).
3. It reads the answer back from the nodes the page actually **added** during
   that wait — the largest new block outside the composer that is not the echo
   of your own prompt. Matching on added nodes rather than on class names keeps
   extraction working when the vendor renames things, and it fixed two real
   faults: the first characters of an answer going missing, and page furniture
   ("AI-generated content may be incorrect", suggestion chips) riding along.
   Selector matching, then a whole-page text diff, remain as fallbacks.
4. Every turn writes `copilot-cli-lastturn.txt` — the step log and the answer
   candidates it saw, with paths. If an answer comes out wrong, that one file
   is enough to pin the right selector.

Step 2 is the brittle part: it depends on the page's structure, which the
vendor can change. That is what the probe and `/debug` are for — a break is a
selector tweak, not a rewrite.

## Files

| File | Role |
|---|---|
| `probe.mjs` | One-shot read-only DOM inventory → report block |
| `chat.mjs` | Interactive REPL |
| `lib-cdp.mjs` | Minimal zero-dep CDP client |
| `probe-fn.mjs` | The page-side inventory, shared by both |
| `page-fn.mjs` | The function evaluated in the tab: type, send, wait, extract |
| `lib-files.mjs` | `@path` expansion into attachment blocks |
| `lib-agent.mjs` | The agent loop and tool-tag protocol (ported from clichat) |
| `PORTING-BACK-TO-CLICHAT.md` | The fixes found here that clichat still needs |
| `lib-fstools.mjs` | read / write / list / edit, confined to one directory |
| `lib-dom.mjs` | A hand-written DOM, so the page function runs with no browser |
| `lib-replay.mjs` | Rebuilds a saved capture and re-runs extraction against it |

## Agent mode

The chat backend has no tool calling. Agent mode gives it some anyway: the
model is asked to emit tagged blocks, this CLI executes them and feeds the
results back as the next turn. Ported from the clichat harness, which solved
the same problem against a different backend.

```sh
node chat.mjs --agent "add a --version flag to cli.js"
node chat.mjs --agent "..." --root ../myproject --yes
```

or `/agent <task>` in the REPL, which keeps one conversation across tasks so
a follow-up lands in a session that still remembers the files it read.

Four verbs, described to the model in a sentence each rather than as JSON
Schema:

| Tag | Does |
|---|---|
| `<copilot:read path="..."/>` | read a file |
| `<copilot:list path="..."/>` | list a directory |
| `<copilot:write path="...">…</copilot:write>` | create or replace a file |
| `<copilot:edit path="...">…</copilot:edit>` | a SEARCH/REPLACE block |

The grammar is a tag with a **raw body**, not JSON, because the thing an agent
mostly emits is the contents of a source file — and a model that was never
trained to call tools is exactly the model that gets JSON string escaping
wrong. Inside a raw body a newline is a newline.

One thing differs from clichat, and it is forced by this backend: the answer
is read out of a *rendered page*, so anything the model writes has been
through a markdown renderer and an HTML sanitizer first. A bare tag is an
unknown element, which is what a sanitizer drops, and prose-level markdown
would reflow a file body and destroy its indentation. So the model is told to
put every tag in a fenced code block — the one construct that survives
rendering with its whitespace intact — and the parser strips fences before
reading tags. It accepts unfenced tags too, since which of the two actually
comes back is a property of the page.

### A tag is an action, not an illustration

A tag only counts as a call when it starts at **column one** of a line. That
rule was always in the prompt and was not enforced, which broke the first code
review someone asked for: the model wrote "you could fix this with
`<copilot:edit path=...>`" and the bridge offered to edit the file. Reviewing
a file that contains the protocol — anything in this directory — did the same,
and the review itself was truncated at the first mention.

So the parser is anchored, and the prompt now says plainly that a tag anywhere
in a reply is executed and must never be used as an example. A read-only task
— review, audit, explain, find a bug — is told to use read and list only and
report in prose.

Anchoring is strict on purpose: executing a mention is far worse than skipping
a call that was indented. It is never silent, though — anything tag-shaped
that was passed over is reported as `ignored N tag-like mentions`, so a call
that did not run is visible rather than mysterious.

clichat, where this harness came from, has the same unanchored regex and the
same gap in its prompt. [PORTING-BACK-TO-CLICHAT.md](PORTING-BACK-TO-CLICHAT.md)
is the spec for applying these fixes there, written to be followed with only
that checkout in hand.

### What it is allowed to do

Everything is confined to the workspace root: the current directory, or
`--root`. Paths that resolve outside it are refused, including through a
symlinked directory in the middle; a symlink at the leaf is refused rather
than followed; files are opened with `O_NOFOLLOW`; and `/`, `/etc`, your home
directory and friends are rejected as roots outright.

**Nothing is ever executed.** There is no shell tool and there will not be
one. The worst a confused reply can do is write a bad file inside the root.

Writes and edits ask for confirmation first, unless `--yes`. Reads and
listings do not ask. With no terminal to ask at, a write is refused rather
than assumed.

## Knowing when the answer is finished

Waiting for the page to fall silent is a guess, and an expensive one. The
page keeps moving after the last word of the answer — the suggestion chips,
the copy and feedback toolbar, the "AI-generated content may be incorrect"
footer — and each of those resets the silence. The answer therefore reached
the terminal `QUIET_MS` **after all the trailing furniture had rendered**,
which is well after it was readable on screen.

The page already says when it is done: it shows a stop control while
generating and removes it when it finishes. That is used as the signal, and
three details make it reliable:

- **Visibility is checked, not just presence.** A stop control left in the DOM
  but hidden would otherwise read as "still generating" until the timeout.
- **The watch starts the moment Enter is pressed**, not after the 400ms
  send-confirmation pause. A short answer can be over inside that pause, and a
  signal nobody was watching for is no signal.
- **Two consecutive absences are required**, so a re-render that briefly drops
  the control does not end the turn early.

`QUIET_MS` remains the fallback for a page that never shows such a control,
and there is a safety net: a stop control still present long after the page
stopped changing is stale rather than generating, and is treated as finished
after `QUIET_MS * 3` instead of hanging until `ANSWER_TIMEOUT_MS`.

Every turn records which of these ended it, in `copilot-cli-lastturn.txt`:

```json
"wait": { "via": "stop-control-gone", "sawStop": true, "ms": 703 }
```

`via` is one of `stop-control-gone` (the exact signal), `quiet` (no stop
control was ever visible), `stale-stop-control` (the safety net) or
`timeout`. If yours says `quiet` every time, the stop control is not being
found — pin it with `STOP_SELECTOR` and the turn gets about a second and a
half shorter.

## When an answer still comes out wrong

Every turn writes two files. `copilot-cli-lastturn.txt` is small and
pasteable: the build, every extraction strategy that ran, what each produced
and how it scored. `copilot-cli-capture.json` is the conversation region —
the turns, their attributes, which of them the page had just added, the
composer and the prompt.

The capture is not only evidence, it is runnable. Re-run extraction against
it offline, as many times as you like, with no browser and no chat:

```sh
node chat.mjs --replay copilot-cli-capture.json
```

or `/replay` inside the REPL. It prints every candidate with its score and
flags, which of them won, and the answer that would have been printed — so a
bad pick is diagnosed, fixed and verified without going back to the page.

One live turn is all any bug here should ever cost.

The capture holds the text of the conversation region, so treat it as you
would the conversation: keep it local, or redact before sharing it.
