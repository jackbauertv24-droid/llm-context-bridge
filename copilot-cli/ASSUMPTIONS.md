# What this code assumes about the page, and why

Every outage in this bridge has come from an assumption about a page nobody
here can see. Not from the page changing — from a belief being written into
the code, a check being built on it, and the check then refusing to send.

So assumptions are listed. Each one says what it rests on, and there is a
rule about what a weak one is allowed to do.

## The rule

**An assumption that can stop a message being sent must be backed by a
recording.** Anything weaker may warn, record, or adjust timing, but it may
not block. Not sending is a certain failure; sending something imperfect is a
probable success, so the burden of proof sits on the refusal.

Evidence has three strengths:

- **RECORDED** — a field in `test/fixtures/copilot-web-*.json`, written by
  `chat.mjs --record` against the live page. This is the only kind that may
  block.
- **OBSERVED** — a symptom the user reported, with only one mechanism that
  explains it. Strong, but it is still an inference.
- **GUESSED** — plausible, unverified. May never block.

## The assumptions

| # | Assumption | Evidence | Where from | May block? |
|---|---|---|---|---|
| 1 | The input is `#m365-chat-editor-target-element`, a contenteditable span | RECORDED — `chosenInput` | recording | n/a |
| 2 | The page consumes the Enter keydown | RECORDED — `enter.keydownDefaultPrevented: true` | recording | no |
| 3 | The composer empties when a message is accepted | RECORDED — `turn.composerClearedAt: 671` | recording | no, it is one of three delivery signs |
| 4 | A stop control appears while generating and goes afterwards | RECORDED — `stopAppearedAt: 671`, `stopGoneAt: 4237` | recording | **yes** — refusing to send into a generating page |
| 5 | The page gains text while generating and not otherwise | RECORDED — `idle.charGrowth: 0` against `timeline` growth of 24–68 chars | recording | **yes**, with 4 |
| 6 | The stop control vanishes *before* the answer is complete | RECORDED — gone at 4237ms, text still growing at 5239ms | recording | no — it extends the wait |
| 7 | The editor pads typed text with invisible anchors | RECORDED — `insert.askedChars: 4`, `gotLength: 6` | recording | no |
| 8 | The composer returns fewer characters than were typed, for a long structured prompt | OBSERVED — 2584 back from 2624 sent. **The mechanism is not established**: stripped markdown markers predicts 42, lines joined with no separator predicts 52, and neither is 40 | symptom | no — and nothing depends on knowing which |
| 9 | Text arriving twice over means it was inserted twice | OBSERVED — "Blast" sent as "BlastBlast" | symptom | **yes** — the only unambiguous corruption |
| 10 | An empty composer means nothing would be sent | trivially true | — | **yes** |
| 11 | A page with handlers on both keydown and keypress would submit twice | GUESSED | reasoning | no — it only suppresses a redundant event |
| 12 | Answers are in `[data-testid="markdown-reply"]` | RECORDED — `turn.lastAnswer.testid` | recording | no |
| 13 | There is no `MessageListContainer` or `role=feed` on this page | RECORDED — `conversationRegion: null` | recording | no |
| 14 | A control labelled "Task Hub" is not a send button | RECORDED — `sendLike` listed it | recording | no |
| 15 | Sending repeatedly can get the account throttled or banned | OBSERVED — the user reported throttling after duplicate sends | symptom | **yes** — the send budget and backoff |
| 16 | Selecting the box's contents and deleting at once, or writing `textContent`, empties it | **RECORDED FALSE** — `clearTest`: 15 characters typed, 15 after each (2026-09-23) | recording | **yes** — since clearing does not work, the bridge refuses to type into a box that still shows text, which would otherwise be sent with the prompt |

## What blocks, and what each blocking check rests on

There are exactly five ways a message is not sent. Every one is RECORDED or
trivially true:

1. **The page is generating** — assumptions 4 and 5, both recorded. A visible
   stop control *and* text still growing.
2. **The composer is empty** — assumption 10.
3. **The text plainly arrived twice** — assumption 9, from a symptom with one
   explanation.
5. **The box still shows text after clearing** — assumption 16, recorded:
   typing would put the prompt after it and send both. An empty box reads
   as zero visible characters on the real page, so this never meets an
   ordinary send.
4. **The send budget for the run is spent** — assumption 15, and the harm of
   being wrong here is far smaller than the harm of being wrong the other way.

Nothing GUESSED blocks anything. If that stops being true, the thing to do is
record, not to reason further.

## Assumption 8 is still a guess, and it no longer matters

Two mechanisms explain the missing characters and neither matches exactly.
Stripping "- ", "# " and fence markers accounts for 42. Running the lines
together with no separator at all — which an earlier paste of this page
plainly showed, "executesfor you" — accounts for 52. The observed figure is
40.

It was stated as settled arithmetic. It is not, and saying so was the same
mistake that produced every other entry here.

What matters is that the code no longer needs the answer. The comparison
tolerates any reduction and refuses only an empty box or text that plainly
arrived twice, so whichever mechanism it turns out to be, the send is not
blocked by it. That is the better fix than identifying the cause: remove the
dependency on the unknown rather than keep guessing at it.

## Why assumption 8 was missed

The first recording used `ping` as its payload. Four letters have no list
markers, no headings and no fences, so nothing in that recording said
anything about what this page does to a long markdown prompt — which is the
payload the agent actually sends. A check comparing the composer against the
prompt was then written on the strength of a recording that did not cover the
case, and it stopped the agent on its first task.

`--record --as-agent` records with the real agent instructions for exactly
this reason: **record the payload you are going to send, not a convenient
one.** The recording now counts the bullets, headings and fences in what it
typed and reports how much of any shortfall they account for, so the rule the
editor follows is read off rather than assumed.

## Before adding a check that can refuse

1. Name the assumption it rests on and add it to the table.
2. If it is not RECORDED, either record it or make the check non-blocking.
3. If recording it needs a payload unlike the one already recorded, record
   that payload. This is the step that was skipped.
