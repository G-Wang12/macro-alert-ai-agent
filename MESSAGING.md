# Messaging the agent (iMessage)

This is the user-facing guide: what to text the agent (over iMessage, via Photon
Spectrum) and what it does with each kind of message. For setup/run instructions
see [`README.md`](README.md); for internals see [`TECHNICAL.md`](TECHNICAL.md).

Just text the agent's number in plain English — there are no slash commands or
fixed syntax. The agent uses an LLM (Grok) to interpret each message and routes
it into one of three buckets:

1. **Preference update** — set what you want to be alerted about.
2. **Alert follow-up** — ask a question about an alert you just received.
3. (everything else is treated as a preference update.)

---

## 1. Setting alert preferences

Anything that isn't a follow-up to a recent alert is parsed as a preference
update. The agent extracts three things from your message:

| Field | What it is | Example phrasing |
| --- | --- | --- |
| `trackedKeywords` | Macro/news triggers to match headlines against | "alert me on CPI, FOMC, and Powell" |
| `watchlist` | Explicit **stock tickers** you care about | "watch TSLA and NVDA for me" |
| `sentimentThreshold` | Sensitivity, 0–1 (lower = more alerts) | "only the big stuff, threshold 0.8" |

You can combine them in one message. Examples:

- `Alert me on CPI and FOMC, threshold 0.5`
- `Watch TSLA, NVDA, and AAPL for me`
- `Track inflation and rate decisions, and watch MSFT and GOOGL`
- `Only ping me on high-impact news — threshold 0.8`

The agent replies with a confirmation echoing what it saved, e.g.:

```
Got it — saved your macro preferences for this chat.
Tracked keywords: CPI, FOMC
Watchlist: TSLA, NVDA
Sentiment threshold: 0.5
```

Sending a new preference message **replaces** the saved preferences for that
chat (it is not additive). Preferences are stored per chat/conversation.

### What triggers a watchlist alert

A watched ticker behaves like an extra keyword: a headline alerts you if it
mentions the ticker **and** the headline's severity is at or above your
threshold. Tickers and tracked keywords are matched as a combined set, so you
don't need to also list a ticker under keywords.

Behind the scenes, the agent pushes your tickers down to the C++ news engine so
it actually forwards headlines mentioning them — see
[README → Dynamic filter sync](README.md#dynamic-filter-sync). There can be a
few seconds' lag between saving a watchlist and the engine picking it up.

### Defaults

If you provide nothing matchable (or the LLM call fails), the chat falls back to
`trackedKeywords = []`, `watchlist = []`, `sentimentThreshold = 0.6`. An empty
keyword **and** watchlist set means "match every headline" (subject to the
threshold).

---

## 2. Asking follow-up questions about an alert

After you receive a proactive macro alert, you can reply in the same chat with a
question about it and get a threaded analysis back (instead of a "saved
preferences" reply). Examples:

- `Why is this hawkish?`
- `What does this mean for rates?`
- `Summarize the whole report`
- `Break this down for me`

This works for about **30 minutes** after the alert. The agent recognizes
follow-ups by question phrasing (messages ending in `?`, or starting with
why/what/how/explain/summarize, etc.). If you instead want to change settings,
phrase it as a preference (e.g. "alert me on CPI") and it'll be saved rather
than answered.

---

## Quick reference

| You want to… | Text something like |
| --- | --- |
| Track macro topics | `alert me on CPI and FOMC` |
| Watch specific stocks | `watch TSLA and NVDA` |
| Get fewer / only big alerts | `threshold 0.8` |
| Get more alerts | `threshold 0.3` |
| Ask about the last alert | `why is this hawkish?` |
| See what's saved | send any preference message; the reply echoes it back |
