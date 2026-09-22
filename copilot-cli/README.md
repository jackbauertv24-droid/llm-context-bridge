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
| `lib-skills.mjs` | Domain-scoped skill bundles, registry, and command parser |
| `lib-confluence.mjs` | Read-only corporate Confluence bridge over CDP with in-tab SSO |
| `PORTING-BACK-TO-CLICHAT.md` | The fixes found here that clichat still needs |
| `lib-fstools.mjs` | read / write / list / edit, confined to one directory |
| `lib-mailtool.mjs` | the mail tools, their settings and redaction |
| `lib-ews.mjs` | a read-only Exchange Web Services client, zero dependencies |
| `lib-imap.mjs` | a read-only IMAP client, for servers that offer it |
| `lib-mime.mjs` | turning a raw message into readable text |
| `lib-dom.mjs` | A hand-written DOM, so the page function runs with no browser |
| `lib-replay.mjs` | Rebuilds a saved capture and re-runs extraction against it |

## Agent mode

The chat backend has no tool calling. Agent mode gives it some anyway: the
model is asked to emit tagged blocks, this CLI executes them and feeds the
results back as the next turn. Ported from the clichat harness, which solved
the same problem against a different backend.

```sh
node chat.mjs --agent "add a --version flag to cli.js"
node chat.mjs --agent:mail "summarise unread emails"
node chat.mjs --agent:confluence "find architecture overview"
node chat.mjs --agent "..." --root ../myproject --yes
```

or `/agent <task>` in the REPL, which keeps one conversation across tasks so
a follow-up lands in a session that still remembers the files it read.

### Skill Bundles: domain scoping & security

Rather than advertising all tools at once—which dilutes model attention and
risks prompt-injection when external mail text encounters write tools—skills are
isolated into domain bundles:

| Skill | Category | Tools | Default / Behavior |
|---|---|---|---|
| `files` (or `code`) | Coding | `read`, `list`, `write`, `edit` | **Default** for `/agent`. Confined to `--root`. |
| `mail` | Agenda | `mail`, `mailboxes` | **Strictly read-only**. No write tools in prompt. |
| `confluence` (or `wiki`) | Knowledge | `confluence_search`, `confluence_read`, `confluence_spaces` | **Strictly read-only**. Connects to authenticated Chrome tab. |
| `logs` | Ops | `log.tail`, `log.grep` | (Planned) Read-only SSH log access. |
| `teams` | Collab | `teams.search` | (Planned) Read-only chat search. |

Use them in the REPL or CLI:

```sh
/agent <task>              # coding agent (files only, default)
/agent:mail <task>         # read-only mail agent (no file write/edit tools in prompt)
/agent:confluence <task>   # read-only Confluence knowledge base search
/agent +confluence <task>  # coding agent + Confluence reading combined
/agent:all <task>          # all active configured skills
/skills                    # view status of all registered skills
/new (or /reset)           # reset session and clear primed prompt context
```

CLI flags:
```sh
node chat.mjs --agent:confluence "find deployment runbook"
node chat.mjs --agent "implement auth" --skills files,confluence
```

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

## Reading mail

The agent can read a window of recent mail and work from it:

```sh
node chat.mjs --agent "summarise anything from the last 10 days that needs a reply"
```

```
<copilot:mail days="10"/>
<copilot:mail days="30" folder="Sent Items" from="alice@" subject="invoice"/>
<copilot:mail days="7" unread="true" limit="10"/>
<copilot:mailboxes/>
```

### Exchange, because that is what is actually reachable

The default protocol is **Exchange Web Services** against an on-premises
server — the same `/EWS/Exchange.asmx` endpoint an Outlook client uses, with
a username and password. That choice is not a guess: an existing production
integration on the same network reaches its mailboxes exactly this way, and
that environment has no IMAP, no Graph and no OAuth. Because the server is
on-premises, Microsoft's 2023 removal of basic authentication — which applies
to Office 365 in the cloud — does not apply to it.

IMAP is kept as an alternative for servers that offer it; set
`MAIL_PROTOCOL=imap`.

### It cannot change anything, send anything, or mark anything read

This is the constraint the feature was built around, so it is enforced in the
code rather than left to care or configuration. There is no setting that
turns it off.

**Over EWS:**

1. **Three operations exist.** `FindFolder`, `FindItem`, `GetItem`. All reads.
2. **Everything else is refused before it is sent.** `UpdateItem`,
   `CreateItem`, `SendItem`, `DeleteItem`, `MoveItem`, `CopyItem`,
   `MarkAllItemsAsRead` and the rest throw rather than go out, so no later
   edit can quietly add a write path.
3. **The read flag is reported, never set.** In EWS a message becomes read
   only through an explicit `UpdateItem` on `message:IsRead` — fetching an
   item does not change it — and `UpdateItem` cannot be sent. `unread="true"`
   filters on the flag; it does not touch it.
4. **Nothing is sent.** There is no code path that composes a message. The
   integration this borrowed its settings from both marks mail read and sends
   replies; neither came across.

**Over IMAP:** the mailbox is opened with `EXAMINE` and never `SELECT`; the
server's `[READ-ONLY]` confirmation is checked and the session abandoned
without it; bodies are fetched with `BODY.PEEK[]` and never `BODY[]`, which
is the one mistake that would silently mark an inbox read; and `STORE`,
`APPEND`, `COPY`, `MOVE`, `EXPUNGE` and friends hit the same deny list.

Nothing is written to disk either, and no attachment is downloaded.

### Setting it up

Copy `mail.env.example` to `mail.env` — it is gitignored — and fill in the
EWS URL, user and password. The username is often `DOMAIN\\username` rather
than an address. Then, in one run:

```sh
node chat.mjs --mail-check
```

That settles the whole setup at once rather than a question at a time: it
reports where the settings came from and which protocol it will use, connects,
authenticates, lists the folder names as the server spells them, searches a
small window, fetches exactly **one** real message, and shows it exactly as
the model would receive it. It then prints every request it sent — for EWS,
the operation names — so you can see for yourself that all of them are reads,
and writes the lot to `copilot-cli-mailcheck.txt`.

If the server uses a certificate from a company authority — normal for an
on-premises Exchange — the first run fails with `unable to verify the first
certificate`. That is a trust problem, not a connection problem: the server
answered fine. The check then reports the certificate chain it was offered,
naming the root to install, which it obtains with a bare handshake that sends
no credentials and makes no request. Three fixes, best first:

```sh
node --use-system-ca chat.mjs --mail-check       # node 22.15+/23.5+, uses the Windows store
set NODE_EXTRA_CA_CERTS=C:\path\to\company-root.cer    # export it from certmgr.msc
MAIL_TLS_INSECURE=1                              # last resort; stops checking altogether
```

### Authentication: Basic, then NTLM

An on-premises Exchange typically answers a Basic attempt with
`WWW-Authenticate: Negotiate, NTLM` and no Basic at all. `MAIL_AUTH=auto`
(the default) tries Basic, and on that refusal switches to **NTLMv2** with the
same username and password — which is exactly what the existing Java
integration on this network gets for free, since `ews-java-api` runs on
Apache HttpClient and does NTLM under the covers.

NTLM authenticates a *connection* rather than a request, so the client pins
itself to one keep-alive socket and runs the three legs over it: negotiate,
challenge, response. The real request rides on the third leg.

MD4 is implemented in `lib-ntlm.mjs` rather than taken from `node:crypto`:
OpenSSL 3 moved it to the legacy provider, so `createHash('md4')` throws on
any current node, and the NT hash is defined as MD4 of the UTF-16LE password.
It is checked against the published RFC 1320 and MS-NLMP vectors on every
`--mail-check`, because a wrong MD4 produces a well-formed handshake that
simply never authenticates — indistinguishable from a wrong password.

Only NTLMv2 is sent; the LM response is left empty. If the server offers
`Negotiate` alone, it wants Kerberos, which this client does not speak, and
it says so.

**If NTLM completes but is rejected, suspect the domain.** Set `MAIL_DOMAIN`,
or write `MAIL_USER` as `DOMAIN\user`. A wrong domain fails identically to a
wrong password.

### Two things to know before you point it at real mail

**The mail goes into the chat.** That is the feature — the text is pasted into
the Copilot conversation so the model can work from it — but it does mean the
contents leave your machine the same way any prompt does. `MAIL_REDACT` (on by
default) strips JWTs, AWS and GitHub and Slack tokens, private keys and
`password: …` lines on the way past, and the size caps keep a busy inbox from
being sent wholesale.

**Use an account that is meant for this.** The tool cannot change anything,
but the credentials in `mail.env` are in a plain file on disk. A dedicated
service mailbox is a better idea than your own.

### Settings

All of these live in `mail.env`, and a real environment variable overrides the
file.

| Var | Default | Meaning |
|---|---|---|
| `MAIL_PROTOCOL` | `ews` when a URL is set | `ews` or `imap`. |
| `MAIL_EWS_URL` | — | e.g. `https://owa.example.com/EWS/Exchange.asmx`. |
| `MAIL_EWS_VERSION` | `Exchange2010_SP2` | Declared to the server; the safe floor. |
| `MAIL_TLS_INSECURE` | off | `1` skips certificate checking, for an internal CA. |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_TLS` | — / 993 / on | The IMAP server, if used. |
| `MAIL_USER` | — | Usually the full address. |
| `MAIL_PASS` | — | Password, or an app-specific one. |
| `MAIL_OAUTH_TOKEN` | — | XOAUTH2 token, instead of a password. |
| `MAIL_FOLDER` | `INBOX` | Default folder; `<copilot:mailboxes/>` lists the real names. |
| `MAIL_DAYS` / `MAIL_LIMIT` | 7 / 25 | Default window and message cap. |
| `MAIL_MAX_BODY` / `MAIL_MAX_TOTAL` | 2000 / 40000 | Characters per message, and in total. |
| `MAIL_FETCH_BYTES` | 65536 | IMAP only: how much of each message is downloaded. |
| `MAIL_REDACT` | on | Strip secrets before sending. `0` disables. |

## Reading Confluence Knowledge Base (via Chrome SSO Tab)

The agent can search your corporate Confluence site and read full wiki articles:

```sh
node chat.mjs --agent:confluence "find the deployment process and release schedule"
```

```
<copilot:confluence_search query="deployment runbook" space="DEV" limit="5"/>
<copilot:confluence_read id="123456"/>
<copilot:confluence_spaces/>
```

### Zero credentials, automatic SSO bypass

Corporate wikis typically sit behind Okta, SAML, Azure AD, or Kerberos. Instead of attempting brittle token interception, `copilot-cli` leverages your existing Chrome session:

1. Open your corporate Confluence site in your Chrome debug window (`port 9222`) and log in once.
2. The bridge finds the tab and evaluates queries (`fetch`) inside the tab context, automatically inheriting your authenticated session cookies.
3. No passwords, tokens, or credentials are stored on disk.
4. Confluence HTML is converted into clean, readable Markdown using the built-in formatter.

### Strictly read-only

Confluence access is enforced as strictly read-only:
- Only `GET` requests to search and content endpoints are constructed.
- Creation (`POST`), editing (`PUT`), or deletion (`DELETE`) are prohibited at the protocol level.

### Single-shot diagnostic check

Run the check once to discover your tabs, test in-tab endpoints, and verify setup:

```sh
node chat.mjs --confluence-check
```

This probes the Confluence REST v1 API, prototype search, quicksearch, and spaces endpoints, tests a sample retrieval, writes a full report to `copilot-cli-confluence-check.txt`, and names the selected working strategy.

## What has broken before

[REGRESSIONS.md](REGRESSIONS.md) is the ledger: every defect that reached a
user, what caused it, and what now catches it. Several were reintroduced by a
later fix, so it is worth reading before changing the send path, the wait, or
the tag grammar.

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
