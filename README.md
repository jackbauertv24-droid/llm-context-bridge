# llm-context-bridge

Giving external context — mail, remote logs — to a corporate VS Code LLM plugin
that is **only allowed to read text**.

No tool calls. No MCP. The plugin stays exactly as restricted as IT intended;
a local Node program does the fetching and leaves the results on disk as files
the plugin can read like any other file in the workspace.

```
  mail / ssh / logs  ->  [ node exporter ]  ->  .llm/**.md  ->  [ VS Code plugin ]  ->  LLM
```

## Start here

```bash
node corp-probe.mjs you@corp.com
```

One read-only sweep of the workstation, ~15 seconds, **zero npm dependencies**
(node builtins only, so it runs where `npm install` is blocked). It answers, in
a single run, everything needed to pick an approach:

| # | Section | Question it settles |
|---|---|---|
| 1 | Runtime | Node version, OS, and whether a proxy is in the way |
| 2 | Egress + TLS | Can you reach out, and is TLS being intercepted (which silently breaks Node) |
| 3 | Mail | MX, SRV, autodiscover, IMAP/POP3 `CAPABILITY`, EWS, M365 tenant — i.e. **can you use a password, or is it OAuth-only** |
| 4 | VS Code | Which extensions exist, and **does any of them keep a chat transcript on disk** |
| 5 | SSH | Client, config aliases, agent, key presence |
| 6 | Summary | The decision-relevant facts in one pasteable block |

It authenticates nothing, sends no credentials, reads no mail, and never opens a
key file. Every check is a DNS lookup, a TCP/TLS connect, an unauthenticated
HTTPS GET, or a directory listing. Output is redacted by default (username and
home path masked); `--raw` disables that, `--mask-domain` also hides the company
domain.

### Why section 4 matters more than it looks

If the corporate plugin persists its conversation to disk, a watcher can read
what the model just said and act on it. That turns a copy-paste workflow into a
real agent loop — the model emits a request, the watcher executes it, the answer
lands in a file, the model reads it. If nothing is persisted, the relay is manual
or clipboard-driven. Section 4 is what tells you which world you're in.

## Then: the mail exporter

See [`mail/README.md`](mail/README.md).

```bash
cd mail && npm install
MAIL_HOST=imap.corp.com MAIL_USER=you@corp.com MAIL_PASS='...' node export-imap.js
```

Produces an index/detail tree, because you cannot put a mailbox in a context
window but you can put a table of contents in one:

```
.llm/mail/
  index.md      <- one line per message, cheap enough to keep in context always
  manifest.md   <- generated-at, filters applied, staleness warning
  INBOX/2026-09-20-1487-quarterly-review.md
```

Incremental by IMAP UID with a `UIDVALIDITY` check, HTML converted to text,
attachments listed but never written to disk, credential patterns redacted, and
an offline self-test (`MAIL_SELFTEST=sample.eml`) so you can see the output shape
without touching a real mailbox.

## Talk to it from a CLI (attach to your own browser)

[`copilot-cli/`](copilot-cli/) drives a chat web UI you are already signed into
and prints the answer in your terminal, so you stop copy-pasting by hand. It
attaches to your own Chrome over the DevTools Protocol — the standard
"automate my own logged-in browser" approach, same category as Selenium or
Playwright. It reads and writes only visible DOM; it does not touch network
traffic, headers, cookies or tokens. Zero npm dependencies.

Run `node probe.mjs` once to inventory the page, then `node chat.mjs` for an
interactive REPL. See [`copilot-cli/README.md`](copilot-cli/README.md).
## Can this be a browser extension instead?

[`ext-probe/`](ext-probe/) is a minimal MV3 extension that answers whether
unpacked sideloading is allowed on a managed machine, and whether admin policy
still blocks host access to the domain you care about (`runtime_blocked_hosts`
loads the extension fine and then forbids it from touching the site). It ships
with a zero-dependency loopback echo server to test the local bridge transport.

Note for anyone planning to intercept traffic from an extension: MV3 removed
blocking `webRequest`, so an extension can redirect and block requests but
**cannot rewrite request or response bodies**. Body rewriting needs a real proxy.

## The request protocol (optional)

To let the model ask for data instead of only receiving it, put a file in the
workspace that is always in context:

```
When you need data you don't have, stop and emit exactly one block:

@@REQ id=<short-slug>
op: logs.tail | logs.grep | mail.search | mail.get
host: prod-api-07
since: 2h
match: "NullPointer"
@@END

Then wait. The answer will appear at .llm/responses/<slug>.md.
Never invent data you haven't read from a file under .llm/.
```

**`op` must be an allowlist of parameterized operations, never a free-form
command string.** Mail content is attacker-influenced: anyone who can email you
can put an `@@REQ` block in a message body and have the model relay it. If the
executor ever does `exec(req.cmd)`, you have built a remote shell that arrives
by email. Validate `host` against a known set, keep SSH read-only with a
`command=` restriction in `authorized_keys`, and require a human confirmation
for anything that is not a read.

## Before pointing any of this at real data

Whatever these scripts write becomes readable by the VS Code plugin and whatever
backend it talks to. Confirm that is within your acceptable-use policy — a local
model helps, but mailbox contents flowing into a code assistant is the kind of
thing DLP rules name explicitly. Keep `.llm/` out of git, and never put
credentials in a file inside the workspace: the plugin reads text files, and
that includes your `.env`.

## Licence

MIT.
