# mail-export

Exports mail into text files an LLM can read. No tool calls, no MCP — just files.

## 1. Find out what your server speaks

```bash
node probe.js you@corp.com
```

It reads DNS and opens TCP sockets. It authenticates nothing and reads no mail.

What the result means:

| Probe says | You have | Do this |
|---|---|---|
| `imap.corp.com:993 OPEN`, `AUTH=PLAIN` | IMAP with password auth | Best case. Use `export-imap.js` as-is. |
| MX = `*.mail.protection.outlook.com` | Microsoft 365 | Basic auth for IMAP is off by default since 2023. Needs OAuth2 or Graph. |
| `AUTH=XOAUTH2` only | OAuth-gated IMAP | Same code, but pass `MAIL_OAUTH_TOKEN`. |
| MX = Google | Google Workspace | IMAP works; needs an app password or OAuth2. |
| Nothing open | IMAP blocked at the firewall or disabled | See "if IMAP is off" below. |

## 2. Export

```bash
npm install

export MAIL_HOST=imap.corp.com
export MAIL_USER=you@corp.com
export MAIL_PASS='...'          # or MAIL_OAUTH_TOKEN for XOAUTH2

MAIL_LIST=1 node export-imap.js           # just print folder names, exit
MAIL_SINCE_DAYS=90 node export-imap.js    # first run: last 90 days of INBOX
node export-imap.js                       # every run after: incremental
```

### Options (all env vars)

| Var | Default | Meaning |
|---|---|---|
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_TLS` | — / 993 / on | Server. `MAIL_TLS=0` for plaintext:143. |
| `MAIL_USER` | — | Username, usually the full address. |
| `MAIL_PASS` | — | Password or app password. |
| `MAIL_OAUTH_TOKEN` | — | XOAUTH2 access token, instead of `MAIL_PASS`. |
| `MAIL_BOXES` | `INBOX` | Comma-separated. Run `MAIL_LIST=1` to see real names. |
| `MAIL_OUT` | `.llm/mail` | Output directory. |
| `MAIL_SINCE_DAYS` | `365` | Window for the *first* run only. |
| `MAIL_MAX_BODY` | `8000` | Chars of body kept per message. |
| `MAIL_REDACT` | on | Strips JWTs, AWS/GitHub/Slack tokens, private keys, `password: x`. `0` disables. |
| `MAIL_FULL` | off | `1` ignores checkpoints and re-exports everything. |
| `MAIL_SELFTEST` | — | Path to a .eml. Runs the parse/write/index path offline, no server. |

## 3. What comes out

```
.llm/mail/
  index.md          <- the cheap file. One line per message, newest first.
  manifest.md       <- when it ran, what was filtered, staleness warning
  INBOX/2026-09-20-1487-quarterly-review.md
  _meta.jsonl       <- append-only metadata; index.md is rebuilt from it
  .state.json       <- UID checkpoints (delete to force a full re-export)
```

Point the VS Code plugin at `index.md` first. It's small enough to sit in context
permanently. When the model needs a specific message, it names the file from the
index and you feed that one file. That two-tier split is the whole trick — you
cannot put a mailbox in a context window, but you can put a table of contents in
one.

Re-running is incremental: it resumes from the last UID per folder, so a cron
entry every 10 minutes costs almost nothing.

## If IMAP is off

In rough order of how much friction they cause:

1. **Microsoft Graph** (`https://graph.microsoft.com/v1.0/me/messages`). The
   supported path for M365. Needs an app registration with `Mail.Read`; device-code
   flow avoids needing a client secret. If your org lets you register an app, this
   is the cleanest answer and the exporter's output layer drops straight on top of it.
2. **EWS** (`/EWS/Exchange.asmx`) — still enabled in plenty of tenants, including
   on-prem Exchange. Deprecated by Microsoft but works today.
3. **Outlook client-side.** On Windows, a COM/VBA script against a running Outlook
   inherits your existing session and needs no server-side permission at all.
   Ugly, but it routes around the tenant policy entirely because it is just
   your desktop client doing what it already does.
4. **Manual export** to .pst/.mbox/.eml from Outlook, then parse the files offline.
   Zero live access, fine for a one-time corpus.

## Before you point this at real mail

- Whatever lands in these files becomes readable by the VS Code plugin and
  whatever backend it talks to. Worth confirming that's within your acceptable-use
  policy, especially for a mailbox with customer data in it.
- Keep `.llm/` out of git. Add it to `.gitignore` and to `.vscode/settings.json`
  under `search.exclude` if you don't want it in workspace-wide searches.
- Never put `MAIL_PASS` in a file inside the workspace — the plugin reads text
  files, and that includes your `.env`.
