# What has broken, and what stops it breaking again

Every defect in this list reached the user. Most of them reached the user
because a check existed that agreed with the bug — the replica the tests ran
against was written from the same wrong belief as the code. This file is the
ledger: the symptom as it was actually seen, the cause, and the thing that
now catches it.

Its purpose is to be read before changing the send path, the wait, or the tag
grammar, because several of these were reintroduced by a later fix.

`ok` in the last column means a behavioural check fails if the fix is removed.
`code` means the guard is structural — an assertion or an allow-list that
throws — with no separate check.

## Sending a message

| Symptom seen | Cause | Guard | Covered |
|---|---|---|---|
| The same prompt appeared in the chat twice, every turn | `Enter` then `Ctrl+Enter` fired back to back with nothing checked between | attempt two only runs after attempt one is seen to fail | ok |
| A single-line prompt could be sent ~30 times | one "click" dispatched a MouseEvent, called `click()`, clicked the button's first child and called `form.requestSubmit()` — inside a loop | `activate()` performs exactly one activation; the loop is gone | ok |
| A page with handlers on `keydown` and `keypress` submitted twice | all three key events fired unconditionally | `keypress` only if the `keydown` was not consumed; the shim honours `preventDefault` so this is testable | ok |
| Typing `Blast` sent `BlastBlast` | a synthetic `beforeinput` carrying the text *and* `execCommand('insertText')`, each inserting all of it | inserted once; `debug.composer.corrected` distinguishes a clean insert from a repaired one | ok |
| A two-letter `hi` was refused as "the page was still generating" | the editor pads what is typed with zero-width anchors, which are not whitespace, so the composer never compared equal to the prompt | comparison ignores zero-width and bidi marks | ok |
| Nothing sent, and the reason named the wrong cause | every refusal printed "still generating" whatever had happened | refusals report `res.method`, their own reason | ok |
| The comprehensive recording stopped after 3 seconds, having sent nothing | its first step typed into the box and then could not clear it — selecting and deleting in the same instant, and writing `textContent`, both leave the text on the real page (recorded: 15 of 15 characters remained) — and the test page cleared under every method, so nothing caught it | clearing comes after every send that does not need it; four methods are tried and measured, real Ctrl+A/Backspace last; a probe that cannot clear hands its text to the next probe instead of stopping; the test page now reverts direct writes and ignores a same-instant delete, and a test checks it reproduces the recording | ok |
| **Open:** the bridge clears the box with the same method that failed | `clearComposer` in `page-fn.mjs`; anything it leaves behind would have gone out in front of the next prompt, since typing inserts at the caret | the bridge now refuses to type into a box that still shows text after clearing, and says to delete it by hand; the clearing method itself is not changed until the recording shows which one works | ok (refusal); recording (method) |
| (live, v1.0) An agent run stopped with its message sitting unsent in the box, the send button never pressed, and the previous answer read back | every agent follow-up ends with the same sentence, and delivery was judged by finding the prompt's last 60 characters outside the box — which earlier follow-ups already satisfied, so a failed Enter counted as sent and neither Ctrl+Enter nor the button was tried. Enter itself most likely failed because v1.0 wrote the text in directly after reading the box too early (removed in .3) | delivery counts only a copy of the ending that was not on the page before Enter; a send that never registers returns "not sent, still in the box" instead of reading on. Tests reproduce it with the recorded nesting of the box, and fail on v1.0 | ok |

## Deciding when to send, and when it is finished

| Symptom seen | Cause | Guard | Covered |
|---|---|---|---|
| Messages sent into a page that was visibly still answering | the wait timed out after 30s and then sent anyway | it refuses instead; `PREFLIGHT_MS=0` opts out | ok |
| Every message refused, permanently, on a live page | "is it busy" watched for any DOM mutation, and every real page mutates constantly | busy means the *text is growing*, not that the DOM changed | ok |
| A turn took the full answer timeout on a live page | same assumption in the wait for the answer | the quiet rule uses growth too | ok |
| The last second of every reply was missing | the stop control disappears before the answer finishes — measured at 4237ms with text still arriving at 5239ms | finishing also requires growth to have stopped | ok |
| A turn hung for two minutes on a stuck control | the stale net needed only 3× the quiet period | 30-second floor, and a control present before the send is distrusted | ok |
| A slow accept was treated as a failed send, and duplicated | delivery was judged by the composer emptying | delivery is proved by the prompt appearing in the conversation | ok |
| Our own prompt returned as the answer — which for the agent means executing the example tags in its own instructions | the echo scored best when nothing else had arrived | an echo is refused and reported | ok |
| Found in the replica, not yet seen live: a turn finished at 1.1s with no answer | a new reply element counted as the answer arriving while it was still empty, so a page that built the element and dropped its stop control before any text came would return nothing | a new block counts only once it holds visible text; this only lengthens a wait | ok |
| Found in a test: a turn that could wait for ever | `quietMs` and `answerTimeoutMs` had no defaults, so every finish condition compared against `undefined`; live config always sets both | both default inside the page function | ok |

## Not overwhelming the backend

| Symptom seen | Cause | Guard | Covered |
|---|---|---|---|
| The same prompt re-sent every 4s, indefinitely | the busy branch decremented the step counter and continued, so the loop never advanced | bounded retries with 5s/10s/20s backoff, then stop | code |
| One busy page cost a dozen submissions | `askPage` retried busy *and* the agent loop retried busy — two layers multiplying | the agent loop owns it; `askPage` reports and returns | code |
| Being rate-limited provoked more requests | throttling was treated as retryable | throttle phrases end the run immediately | code |
| — | nothing bounded the total | every message passes one function: budget per run, minimum interval, printed on attach | code |

## The agent protocol

| Symptom seen | Cause | Guard | Covered |
|---|---|---|---|
| Confluence tools could never be called; the turn ended as prose | the tag grammar's name pattern excluded the underscore in `confluence_search` | names allow `_` and digits; `assertToolNames` throws at prompt build | code |
| The model was taught to emit `[limit="5"]`, which never parses | optional arguments written in prose notation in the usage examples | `assertToolUsage` requires each tool's own example to parse back to it | code |
| An invented tool name ended the run silently | a well-formed tag naming nothing was dropped without trace | unknown names are collected and turned into a correction the model can act on | code |
| A run reported success when the reply could not be read | the loop returned `done: true` whenever no calls parsed | a reply is accounted for; tag-shaped text that produced no call is not success | code |
| Asked for a code review, it offered to edit files | the parser executed tags mentioned in prose | tags must start in column one | code |

## Reading mail and Confluence

| Symptom seen | Cause | Guard | Covered |
|---|---|---|---|
| "No mail in the last 3 days" from a 5816-message inbox | a greedy attribute group ate the slash of `<t:ItemId …/>`, so every message was skipped | lazy group; an unterminated tag is skipped rather than ending the scan | code |
| An empty result could not be told from a parse failure | nothing counted the stages | matched / parsed / fetched / kept are counted and a sentence names the stage that lost them | code |
| Every search result said `space: none` | CQL search does not expand `space` unless asked | expanded, with the key also derived from the page link | code |
| Tool output contained a live tag with a placeholder that parses | the search result suggested `<copilot:confluence_read id="<id>"/>` | described in prose instead | code |
| Mail could have been marked read | — | `EXAMINE` not `SELECT`, `BODY.PEEK[]` not `BODY[]`, `[READ-ONLY]` confirmed, deny list; EWS has an allow-list of three read operations | code |
| A password sat in a log meant to be shown | redacted only at the point of printing | redacted where it is recorded | code |

## Diagnostics

| Symptom seen | Cause | Guard | Covered |
|---|---|---|---|
| The page recording carried the user's mail | it stored 80 characters of every element's text and 400 of the last answer | text is recorded only as a length; a check builds a page full of secrets and requires none survive | ok |
| Ten commits shipped under a stale build number | the version lived in one file that changes rarely | one exported constant, imported everywhere, printed by every diagnostic | code |
| A safety line claimed "all of them are reads" when nothing had been sent | the summary did not check whether any request happened | it says nothing was sent | code |
| The recording never exercised the fallbacks, the clearing, or a long reply | it sent only by Enter into an already-empty box | `--record-chat` measures clearing on its own text, sends once each by button and Ctrl+Enter (allowed to fail, then cleared), records pauses mid-answer and a replaced reply node, and runs the bridge's own turn | ok |
| The code-body check for backslashes never ran | it looked for a double backslash in a body that has single ones | fixed; a test requires the check to report | ok |

## The lesson that produced most of this file

Three separate builds were declared fixed, handed over, and failed
immediately. In each case the replica the checks ran against had been written
from the same belief that was wrong in the code — that the composer empties
on send, that a visible stop control means a response is in flight, that the
DOM falls quiet when an answer ends. Plausible, all of them. None true of the
real page.

`chat.mjs --record` now writes down what the page actually is and does, and
`test/recorded-page.test.mjs` builds the test page from that file rather than
from an argument. Both builds handed over on the day it was added fail all
four of its checks.
