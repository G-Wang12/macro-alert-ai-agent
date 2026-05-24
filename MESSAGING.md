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
update. The agent extracts four things from your message:

| Field | What it is | Example phrasing |
| --- | --- | --- |
| `trackedKeywords` | Macro/news triggers to match headlines against | "alert me on CPI, FOMC, and Powell" |
| `watchlist` | Explicit **stock tickers** you care about | "watch TSLA and NVDA for me" |
| `severityThreshold` | Minimum **market impact** to alert, 0–1 (lower = more alerts) | "only the big stuff, threshold 0.8" |
| `sourceTrustThreshold` | Minimum publisher trustworthiness, 0–1 (higher = stricter) | "only alert me from reputable sources" |

You can combine them in one message, or send them across several — you don't
have to restate everything each time. Examples:

- `Alert me on CPI and FOMC, threshold 0.5`
- `Watch TSLA, NVDA, and AAPL for me`
- `Track inflation and rate decisions, and watch MSFT and GOOGL`
- `Only ping me on high-impact news — threshold 0.8`

The agent replies with a confirmation echoing your **current** settings, e.g.:

```
Got it — saved your macro preferences for this chat.
Tracked keywords: CPI, FOMC
Watchlist: TSLA, NVDA
Severity threshold: 0.5
Alerts when a matching headline's Severity score is ≥ 0.5 (same "Severity" on each alert; not bullish/bearish Direction). Lower = more alerts.
Source trust: any source
```

### What “threshold” means (severity, not direction)

When you text `threshold 0.5`, you are setting your **severity threshold** — how
**market-moving** a headline must be before you get pinged. After a headline matches your keywords or
watchlist, Grok scores it on three separate 0–1 scales:

| Score on each alert | What it measures | Used to filter alerts? |
| --- | --- | --- |
| **Severity** | How market-moving the headline is (CPI surprise, FOMC shock, etc.) | **Yes** — compared to your **severity threshold** |
| **Direction** | Bearish vs bullish tone | **No** — shown for context only |
| **Source trust** | Publisher credibility (Reuters high, PR wire low) | **Yes** — if you set a source-trust minimum |

So **`threshold 0.5` sets your severity threshold** — “only alert me when severity ≥
0.5.” It does **not** mean “only bearish news” or “only bullish news.” Lower the
number for more alerts; raise it (e.g. `threshold 0.8`) for fewer, bigger
headlines only.

**Updates are incremental.** Each message changes only what it mentions; the
rest of your settings are kept. So this works as a conversation:

```
You:   watch GOOGL and AMZN, threshold 0.3
Agent: ... Watchlist: GOOGL, AMZN | threshold 0.3
You:   track CPI
Agent: ... Tracked keywords: CPI | Watchlist: GOOGL, AMZN | threshold 0.3   ← watchlist + threshold kept
```

Preferences are stored per chat/conversation.

### Adding, removing, replacing, and resetting

You can adjust settings in plain English — add, remove, replace a whole list, or
start over:

| Intent | Say something like | Effect |
| --- | --- | --- |
| **Add** (default) | `watch TSLA`, `also track FOMC` | appends; existing settings kept |
| **Remove** | `stop watching GOOGL`, `untrack CPI`, `no longer alert on rates` | drops just those items |
| **Replace a list** | `only watch TSLA`, `just track CPI and FOMC` | sets that one list to exactly what you named |
| **Clear one list** | `clear my watchlist` | empties that list, keeps the rest |
| **Reset everything** | `reset my settings`, `clear everything` | back to defaults (no keywords/tickers, threshold 0.6, any source) |
| **Set impact threshold** | `threshold 0.5`, `only big alerts` | changes how market-moving news must be |
| **Filter by source** | `only reputable sources`, `any source is fine` | sets/clears the minimum source-trust level |

Add/remove are case-insensitive, so `untrack cpi` removes `CPI`. Replacing or
clearing one list (e.g. the watchlist) leaves your keywords and threshold
untouched.

### What triggers a watchlist alert

A watched ticker behaves like an extra keyword: a headline alerts you if it
mentions the ticker **and** the headline's **market impact** is at or above your
threshold. Tickers and tracked keywords are matched as a combined set, so you
don't need to also list a ticker under keywords.

Behind the scenes, the agent pushes your tickers down to the C++ news engine so
it actually forwards headlines mentioning them — see
[README → Dynamic filter sync](README.md#dynamic-filter-sync). There can be a
few seconds' lag between saving a watchlist and the engine picking it up.

### Filtering by source trustworthiness

Every alert shows **how trustworthy the publisher is**. When a headline is
analyzed, the agent has Grok rate the source's credibility from 0 to 1 (based on
the publisher's reputation — established wire services and major outlets score
high; press-release wires, aggregators, and unknown/blog sources score low), and
each alert is labelled `low` / `medium` / `high`:

```
Macro alert
Fed raises rates by 25bps, signals higher-for-longer stance
Source: Reuters · trust high (0.95)
Severity: 0.90 | Direction: bearish (0.20)
...
```

By default nothing is filtered on trust — you see alerts from any source. If you
only want credible publishers, set a minimum:

| Say something like | Effect |
| --- | --- |
| `only alert me from reputable sources` | min trust ≈ 0.7 (high) |
| `trusted sources only` | min trust ≈ 0.6 |
| `skip blogs and PR wires` | min trust ≈ 0.5 |
| `any source is fine` | turns the filter off (back to 0) |

The trust threshold is per chat and incremental like your other settings, and it
stacks with your keyword/watchlist match and impact threshold — a headline
must clear **all** of them to alert.

### Defaults

A brand-new chat starts at `trackedKeywords = []`, `watchlist = []`,
`severityThreshold = 0.6`, `sourceTrustThreshold = 0` (any source). An empty
keyword **and** watchlist set means "match every headline" (subject to the
thresholds).

If a message can't be understood (or the LLM call fails), your saved settings
are left **unchanged** — a bad parse can no longer wipe what you had.

---

## 2. Asking follow-up questions about an alert

After you receive a proactive macro alert, you can reply in the same chat with a
question about it and get a threaded analysis back (instead of a "saved
preferences" reply). Examples:

- `Why is this hawkish?`
- `What does this mean for rates?`
- `Summarize the whole report`
- `Break this down for me`
- `Why is the Waller news good for equities?`

The agent keeps up to **10 recent alerts** per chat, each for **30 minutes**
after it was sent. The agent recognizes follow-ups by question phrasing (messages
ending in `?`, or starting with why/what/how/explain/summarize, etc.).

**Multiple alerts in the window:** If several alerts are active, you don't need
to do anything special. Just ask naturally — the agent passes all recent alerts
to the AI and it works out which one your question is about from the wording. If
your question is ambiguous, the AI picks the most relevant alert and briefly says
which one it chose.

If you instead want to change settings, phrase it as a preference (e.g. "alert
me on CPI") and it'll be saved rather than answered.

---

## Quick reference

| You want to… | Text something like |
| --- | --- |
| Track macro topics | `alert me on CPI and FOMC` |
| Watch specific stocks | `watch TSLA and NVDA` |
| Stop tracking / watching something | `untrack CPI`, `stop watching GOOGL` |
| Replace a whole list | `only watch TSLA` |
| Clear a list / reset all | `clear my watchlist`, `reset my settings` |
| Get fewer / only big alerts | `threshold 0.8` |
| Get more alerts | `threshold 0.3` |
| Only trust reputable sources | `only alert me from reputable sources` |
| Ask about a recent alert | `why is this hawkish?`, `what does the Waller news mean?` |
| See what's saved | send any preference message; the reply echoes it back |
