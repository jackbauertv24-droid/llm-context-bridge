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

Tested by `node --test test/files.test.mjs` — 23 cases, no browser needed.

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

Pin any selector with an env var (values come from the probe report's `path`):
```
INPUT_SELECTOR='textarea[aria-label="Ask Copilot"]' \
SEND_SELECTOR='button[aria-label="Send"]' \
ANSWER_SELECTOR='[data-author-role="assistant"]' \
node chat.mjs
```

Other env vars: `CDP_PORT` (9222), `CDP_HOST` (127.0.0.1), `TAB_MATCH`
(`copilot.cloud.microsoft`), `QUIET_MS` (1500 — silence that counts as
"done streaming"), `ANSWER_TIMEOUT_MS` (120000).

## How a turn works

1. `chat.mjs` finds your tab via `http://127.0.0.1:9222/json` and opens its CDP
   WebSocket.
2. Each prompt is run as one `Runtime.evaluate` of a self-contained function in
   the page: it sets the input text (native setter + `input` event for
   textareas; `execCommand('insertText')` for rich contenteditable editors),
   sends (Enter, falling back to a send-button click), then waits on a
   `MutationObserver` until the DOM has been quiet for `QUIET_MS` and no "stop
   generating" control is present.
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
