# macro-alert-ai-agent

Dual-language starter repo with:

- `cpp_engine/`: a C++20 engine built with CMake and linked to ZeroMQ (libzmq + cppzmq)
- `ts_agent/`: a Node.js + TypeScript agent using `zeromq`, xAI (Grok), and `dotenv`

For implementation details (build/linking choices, intended ZeroMQ protocol), see `TECHNICAL.md`. For what end users should text the agent (preferences, watchlist, follow-ups), see `MESSAGING.md`.

## Repository layout

- `cpp_engine/` — C++20 CMake project
- `ts_agent/` — Node.js TypeScript project

## cpp_engine (C++20 + ZeroMQ)

### Prereqs

- CMake 3.22+
- A C++20 compiler (Apple Clang / LLVM / GCC)
- ZeroMQ core library (`libzmq`)
- OpenSSL (only for `--live` mode; used by cpp-httplib for HTTPS)

On macOS (Homebrew):

```bash
brew install cmake zeromq openssl@3
```

`cppzmq`, `cpp-httplib`, and `nlohmann/json` are fetched automatically by CMake `FetchContent`; you only install the native libraries above.

### Build & run

```bash
cmake -S cpp_engine -B cpp_engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build cpp_engine/build
./cpp_engine/build/cpp_engine
```

`cpp_engine` reads headlines from a data source, keeps only those matching its macro keyword filter, and publishes the matches over ZeroMQ `PUB` (default `tcp://127.0.0.1:5555`) as JSON frames (each carries the headline text plus its `source` publisher, which the agent uses for trust scoring). The filter starts from a built-in macro keyword list but is **overridden at runtime** by the agent, which pushes the union of all users' tracked keywords + watchlist tickers (see [Dynamic filter sync](#dynamic-filter-sync)); with no agent connected it keeps the built-in list.

It supports two data sources, selected by flag:

- `--simulate` (default): rotates through a built-in list of mock headlines, emitting one every 2 seconds. No API key needed.
- `--live`: polls the Finnhub REST news API (`/api/v1/news?category=general`) every 2 seconds on a background thread, de-duplicating by article `id`. Requires a Finnhub API key (see below).

```bash
./cpp_engine/build/cpp_engine            # simulate (default)
./cpp_engine/build/cpp_engine --simulate
./cpp_engine/build/cpp_engine --live
```

Macro keywords (case-insensitive substring match): `FOMC`, `CPI`, `PCE`, `inflation`, `Fed`, `Powell`, `Rates`, `ECB`, `Treasury`, `yield`, `jobs`, `payroll`, `unemployment`, `GDP`, `recession`, `tariff`, `stimulus`, `central bank`, `bond`.

You can override the bind endpoint with a positional argument (works with either mode):

```bash
./cpp_engine/build/cpp_engine --live tcp://127.0.0.1:5555
```

#### Live mode: Finnhub API key

`--live` needs `FINNHUB_API_KEY`. Put it in `cpp_engine/.env` (copy from `cpp_engine/.env.example`):

```bash
cp cpp_engine/.env.example cpp_engine/.env
# edit cpp_engine/.env and set FINNHUB_API_KEY=...
```

The engine loads `cpp_engine/.env` at startup (a real shell env var of the same name takes precedence). `--simulate` ignores the key.

Note: the Finnhub general-news feed is a ~100-item snapshot that changes only when new articles are posted (not every 2 seconds). With de-duplication, a run publishes the current matches once, then stays quiet until genuinely new matching headlines appear; a fresh run re-publishes the current set.

Notes:

- `cpp_engine/CMakeLists.txt` fetches `cppzmq`, `cpp-httplib`, and `nlohmann/json` automatically via CMake `FetchContent`.
- You still need `libzmq` installed system-wide (e.g. via Homebrew), plus OpenSSL for `--live` HTTPS.

## ts_agent (Node.js + TypeScript)

### Prereqs

- Node.js 18+ (20+ recommended)
- npm

### Install

```bash
cd ts_agent
npm install
```

### Environment

Create an `.env` file (see `.env.example`):

```bash
cp .env.example .env
```

`.env` is intentionally ignored by git (see `.gitignore`).

Set:

- `XAI_API_KEY=...` (required for preference extraction and headline analysis)

For Photon Spectrum (iMessage):

- `PROJECT_ID=...`
- `PROJECT_SECRET=...`

Optional:

- `ZMQ_ENDPOINT=...` (default `tcp://127.0.0.1:5555`; must match `cpp_engine` bind address)
- `FILTER_ENDPOINT=...` (default `tcp://127.0.0.1:5556`; must match `cpp_engine`'s `FILTER_ENDPOINT`). The agent binds this and pushes the union of all users' tracked keywords + watchlist tickers so the engine forwards headlines for watched tickers — see [Dynamic filter sync](#dynamic-filter-sync).

### Build & run

```bash
npm run build
npm start
```

`npm start` runs one process that:

1. **Reactive (iMessage)**: listens on Spectrum `app.messages`, extracts preferences with Grok, and replies.
2. **Follow-ups**: after a proactive alert, answer questions about that headline (e.g. “Why is this hawkish?”) via threaded `message.reply()`.
3. **Proactive (ZeroMQ)**: subscribes to `cpp_engine` headlines in the background, analyzes each with Grok, and pushes iMessage alerts when a user’s preferences match.

Outbound messages to the same chat are ordered so preference confirmations are not interrupted by a concurrent alert (see `TECHNICAL.md`).

Start `cpp_engine` in another terminal so headlines are published:

```bash
./cpp_engine/build/cpp_engine
```

### Dynamic filter sync

The engine can't know about users on its own, so the **agent tells it what to
watch**. This is a second ZeroMQ channel, in the reverse direction from
headlines:

- The agent **binds** a PUB socket on `FILTER_ENDPOINT` (default
  `tcp://127.0.0.1:5556`) and publishes a *filter set* — the de-duplicated union
  of every user's `trackedKeywords` + `watchlist` tickers:

  ```json
  { "type": "filterset", "terms": ["CPI", "FOMC", "TSLA", "NVDA"] }
  ```

- The engine **subscribes** and rebuilds its keyword filter at runtime, so it
  forwards exactly what at least one user cares about (and nothing else, which
  keeps Grok analysis volume down). An **empty** set falls back to the engine's
  built-in macro keyword list.

The agent republishes whenever preferences change **and** on a ~5s heartbeat, so
an engine that starts late or reconnects converges to the current set within one
interval (ZeroMQ PUB/SUB does not replay missed messages). Per-user routing is
still done by the agent in `shouldAlertUser`; the filter set only controls which
headlines the engine bothers to forward.

This is what makes the **watchlist** work end-to-end: a ticker you mention is
pushed to the engine, which then forwards headlines mentioning it.

### What to test (iMessage preferences)

Checklist:

1. Start `cpp_engine` (see above).
2. Start the agent: `cd ts_agent && npm run build && npm start`
3. In the Photon dashboard, find the iMessage “line” / phone number for your project.
4. From your iPhone, send an iMessage (blue bubble) to that number (e.g. “Alert me on CPI and FOMC, threshold 0.5”).
5. You should see a console log like: `[iMessage] space=... sender=...: <your text>`
6. You should receive a reply confirming saved preferences.

Troubleshooting (preferences):

- If you get `Got it — saved...` but `Tracked keywords: (none)` and `Sentiment threshold: 0.6`, the agent fell back to defaults (most commonly because `XAI_API_KEY` is missing/blank, or the LLM output wasn't parseable).
- If you get `Sorry — I couldn't update your preferences right now.`, the LLM call failed (network/API/model error). Check the agent console logs for the error.
- If an alert arrives before your “Got it — saved…” reply, restart the agent after `npm run build` — the agent holds alerts while your settings message is being processed so confirmations should arrive first.
- If you get multiple identical replies for a single text, you likely have multiple `npm start` processes running at once. Stop extras (Ctrl+C) so only one agent instance is connected.
- The agent also enforces a single-instance lock; if you try to start a second copy, it will exit and tell you which PID is already running.

### What to test (proactive macro alerts)

After saving preferences (above), leave `npm start` running with `cpp_engine` publishing:

1. Watch the agent console for `[ZMQ] headline: ... [source: ...]` when a headline is received.
2. If the headline matches your keywords **or watchlist tickers**, Grok’s **severity** is at or above your **sentiment threshold**, and the **source trust** Grok assigns the publisher is at or above your **source-trust threshold** (default 0 = any source), you should get a proactive iMessage (no new inbound message required). The alert names the source and its trust level, e.g. `Source: Reuters · trust high (0.95)`.
3. Lower threshold → more alerts; higher threshold → fewer. Raise the source-trust threshold (e.g. "only reputable sources") to suppress low-credibility publishers — see [`MESSAGING.md`](MESSAGING.md).

#### Testing the watchlist specifically

With both `cpp_engine` and the agent running, the agent pushes your watchlist
tickers to the engine (see [Dynamic filter sync](#dynamic-filter-sync)), so the
engine forwards headlines that mention them:

1. Text the agent `watch TSLA, threshold 0.3` (low threshold so severity passes).
   The agent console logs `[filter] pushed N term(s) to engine: ..., TSLA`.
2. In `--simulate` mode the engine cycles through a built-in `TSLA deliveries
   miss estimates...` headline; once your watchlist reaches the engine it starts
   forwarding it, and you should get an alert. (Before you set a watchlist, that
   ticker-only headline is dropped by the macro filter.)

To exercise the agent's matching **in isolation** (no engine, any headline),
stop `cpp_engine` and use the debug publisher to inject one directly, bypassing
the filter entirely:

```bash
cd ts_agent && npm run build
npm run pub -- "TSLA tumbles 8% on weak deliveries"
```

Troubleshooting (alerts):

- No `[ZMQ]` logs: check `cpp_engine` is running and `ZMQ_ENDPOINT` matches its bind address.
- Headlines logged but no alert: preferences may not match (keywords, severity below threshold, or the source's trust below your source-trust threshold), or `XAI_API_KEY` is missing (analysis is skipped).
- Console says `no user preferences yet`: send at least one iMessage to configure preferences first.
- Console says `no cached conversation`: you must message the agent at least once per run so it can resolve the Spectrum `space` for outbound sends.

### What to test (alert follow-ups)

After you receive a proactive macro alert:

1. Reply in the same chat with a question about that alert, e.g. `Why is this hawkish?` or `Summarize the whole report`.
2. You should get a threaded analysis reply (not a “Got it — saved preferences” message).
3. Follow-ups work for ~30 minutes after the alert; send a new preference message (e.g. “alert me on CPI”) if you want to change settings instead.

Troubleshooting (follow-ups):

- Got a preferences reply instead of analysis: phrase your message as a question, or include words like “why”, “summarize”, or “hawkish”. Messages like “alert me on CPI” are treated as preference updates.
- “I don't have a recent alert in context”: no alert was stored for this chat yet, or the 30-minute context window expired.

### Debug-only: standalone ZeroMQ subscriber

`npm run sub` runs `subscriber.ts` alone — it only logs headlines that pass the hardcoded C++ macro keyword filter. Use it to verify ZMQ wiring without Spectrum or Grok:

```bash
cd ts_agent
npm run build
npm run sub
```

If `cpp_engine` uses a non-default port:

```bash
npm run sub -- tcp://127.0.0.1:5555
```

### Debug-only: standalone ZeroMQ publisher

`npm run pub` runs `testPublisher.ts` — it **binds** a PUB socket and emits a
headline frame in the same JSON shape as `cpp_engine`, but **without** the macro
keyword filter. Use it to feed the agent arbitrary headlines (e.g. ticker-only
news for watchlist testing):

```bash
cd ts_agent
npm run build
npm run pub -- "TSLA tumbles 8% on weak deliveries"
npm run pub -- "Fed holds; NVDA pops" tcp://127.0.0.1:5555   # optional endpoint
```

Because it binds the endpoint, stop `cpp_engine` first (only one process can
bind). Start the agent (`npm start`) before publishing so its subscriber is
connected.
