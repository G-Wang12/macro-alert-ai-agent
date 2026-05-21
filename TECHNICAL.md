# Technical notes (how it works)

This document is the technical companion to the user-facing README. It explains the repo’s internals: build systems, dependency choices, and the intended C++ ↔ Node communication model.

## High-level architecture

The repository is split into two projects:

- **`cpp_engine/`**: a C++20 executable intended to own low-latency / system-level work.
- **`ts_agent/`**: a Node.js + TypeScript process intended to own LLM/tooling orchestration.

The intended integration point between them is **ZeroMQ**:

- **libzmq**: the native ZeroMQ implementation (shared library)
- **cppzmq**: header-only C++ bindings over libzmq
- **zeromq (npm)**: Node.js bindings

That separation keeps each language doing what it’s good at while still allowing a simple local IPC boundary.

## `cpp_engine/` build system

### Dependency model

- `cpp_engine/CMakeLists.txt` uses CMake `FetchContent` to fetch, at configure time:
  - **cppzmq** — header-only C++ bindings for ZeroMQ.
  - **cpp-httplib** (`yhirose/cpp-httplib`) — header-only HTTP/HTTPS client used by `--live` mode to poll Finnhub. Configured with `HTTPLIB_REQUIRE_OPENSSL ON`, which finds OpenSSL, defines `CPPHTTPLIB_OPENSSL_SUPPORT`, and links it so `https://` works.
  - **nlohmann/json** — header-only JSON parser, used to decode Finnhub responses.
- **libzmq and OpenSSL are not vendored**: install them via your OS package manager (e.g. `brew install zeromq openssl@3`). OpenSSL is only required for `--live`.

Why this approach:

- These libraries are small and header-only, so `FetchContent` is straightforward.
- libzmq and OpenSSL are native dependencies better managed by the system (security updates, platform builds).

### Linking details

The CMake file links the executable against:

- `cppzmq` (interface target) for `#include <zmq.hpp>`
- libzmq (pulled in transitively by cppzmq’s CMake logic)

If you hit link or discovery issues, the most common cause is that libzmq isn’t installed or isn’t visible to CMake/pkg-config.

### Engine architecture (`cpp_engine/src/`)

The engine is built around a small data-source abstraction so the headline feed can be swapped without touching the publish pipeline:

- **`IMarketDataSource.hpp`** — abstract interface with one method: `std::optional<Headline> nextHeadline()`, where `Headline { std::string text; std::string source; }` pairs the headline with its publisher. Returning `std::nullopt` means "no headline available right now."
- **`SimulatedDataSource.hpp`** — implements the interface with a built-in vector of mock `Headline`s (each paired with a synthetic publisher spanning trust tiers, e.g. Reuters / Bloomberg / PRNewswire / a no-name blog, so source-trust scoring is exercisable without a live key), rotated sequentially. It self-paces: it returns a headline at most once every 2 seconds and `std::nullopt` in between (via a `std::chrono::steady_clock` timestamp).
- **`LiveRestDataSource.hpp`** — implements the interface against the Finnhub REST news API. Its constructor starts a background `std::thread` that polls every 2 seconds (cpp-httplib over HTTPS); an `std::atomic<bool>` controls the thread's lifecycle and the destructor joins it. New headlines (de-duplicated by article `id` via an `std::unordered_set<int>`) are pushed — together with the article's `source` field — onto a `std::queue<Headline>` guarded by a `std::mutex`. JSON parsing happens outside the lock; only the push is inside it. `nextHeadline()` pops the oldest queued headline, or returns `std::nullopt` when the queue is empty. With `LiveRestConfig::demo` (`--live --demo`), the first snapshot marks every returned `id` as seen, enqueues only items whose Finnhub `datetime` falls within `backlogHours` (newest first, capped at `backlogMax`), then subsequent polls enqueue only new ids. **`PacedDataSource.hpp`** wraps any `IMarketDataSource` and rate-limits `nextHeadline()` so demo mode emits a steady trickle instead of draining the queue instantly.
- **`MacroFilter.hpp`** — holds a keyword list and exposes `bool matches(std::string_view)` using a case-insensitive substring search (C++20 `std::ranges` algorithms). Substring matching means e.g. `Rates` matches "acceleRATES" and `Fed` matches "FedEx"; the downstream LLM acts as a second filter.
- **`SharedFilter.hpp`** — a thread-safe holder for the *active* `MacroFilter`. The main loop reads it once per headline; the background `FilterSubscriber` swaps in a new one when the agent pushes an updated term set. Built-in macro keywords are the constructor default and the fallback used whenever the pushed set is empty. Reads/writes are guarded by a `std::mutex` around a `std::shared_ptr<const MacroFilter>` (the lock is held only to copy/swap the pointer, not during matching).
- **`FilterSubscriber.hpp`** — owns a background `std::thread` running a `SUB` socket on `FILTER_ENDPOINT` (default `tcp://127.0.0.1:5556`). It parses `{"type":"filterset","terms":[...]}` frames from the agent and calls `SharedFilter::update()`, skipping no-op updates (the agent heartbeats the same set). `recv` uses a 200 ms `RCVTIMEO` so the thread can observe its stop flag.
- **`ZmqPublisher.hpp`** — owns the `zmq::context_t` + `zmq::socket_t` (`PUB`), binds in its constructor, and serializes each headline (text + `source`, both JSON-escaped) to the JSON wire frame in `publishHeadline()`.
- **`DotEnv.hpp`** — minimal `.env` loader (`KEY=VALUE`, `#` comments, optional quotes/`export`). It uses `setenv(..., overwrite=0)` so a real shell variable always wins over the file.

`main.cpp` wires these together: it loads `.env`, parses flags (`--simulate`/`--live` + optional endpoint), constructs the chosen source behind a `std::unique_ptr<IMarketDataSource>`, the `SharedFilter` (seeded with the macro defaults), the `FilterSubscriber`, and the `ZmqPublisher`, then runs the main loop:

1. Call `source->nextHeadline()`.
2. If a headline is returned: run it through the active filter (`filter.current()->matches(...)`), publish matches, and immediately loop again (draining any queued backlog).
3. If `std::nullopt`: sleep 50 ms to avoid busy-waiting, then loop.

Pacing therefore lives in the *source* (the simulated source's 2 s cadence, the live source's 2 s poll), not the loop — so live headlines drain as fast as they arrive while idle CPU stays near zero. Startup errors (bad flags, bind failure, missing `FINNHUB_API_KEY` under `--live`) are fatal and exit non-zero; per-iteration errors are logged and the loop continues.

### Extending the C++ side

Typical next steps:

- Add more sources under `cpp_engine/src/`.
- Add libraries with `add_library(...)` and link them into `cpp_engine`.
- Introduce a small messaging layer (encode/decode + request routing) once you define your message schema.

## `ts_agent/` build system

### TypeScript + Node ESM

- `package.json` sets `"type": "module"`.
- `tsconfig.json` uses `module`/`moduleResolution` = `NodeNext`.

This matches modern Node.js ESM behavior while keeping the TypeScript compiler in control of output under `ts_agent/dist/`.

### Dependencies

- `dotenv`: loads `.env` via `import "dotenv/config"`
- `spectrum-ts`: Photon Spectrum SDK for unified messaging + iMessage provider
- xAI (Grok): called via OpenAI-compatible HTTP endpoints using `fetch`
- `zeromq`: Node bindings for ZeroMQ

Security note: keep `XAI_API_KEY` on the agent side. Don’t pass the key over ZeroMQ.

## Photon Spectrum (iMessage agent loop)

The `ts_agent` main entrypoint runs a Spectrum server that listens to incoming messages:

- The SDK is `spectrum-ts`.
- iMessage is enabled via the provider `imessage.config()`.
- Incoming messages arrive on `app.messages` as `[space, message]` tuples.

### Environment variables

**Spectrum (iMessage, required for `npm start`)**

- `PROJECT_ID`
- `PROJECT_SECRET` (or `SECRET_KEY`)

**Grok (required for preference extraction and headline analysis)**

- `XAI_API_KEY`
- `XAI_BASE_URL` (optional, default `https://api.x.ai/v1`)
- `GROK_MODEL` (optional; auto-fallback if unset)

**ZeroMQ (optional)**

- `ZMQ_ENDPOINT` (default `tcp://127.0.0.1:5555`; must match `cpp_engine` bind address)

The `ts_agent` main process runs **two concurrent loops**:

1. **Reactive (Spectrum)**: `for await` on `app.messages` — dispatches each inbound text to a per-space handler (non-blocking on the iterator).
2. **Proactive (ZeroMQ)**: a background `SUB` socket in the same process — analyzes headlines and sends alerts when thresholds match.

For debugging, inbound iMessages are logged with `space.id` and `sender.id`; ZMQ headlines are logged as `[ZMQ] headline: ...`.

### Per-space outbound ordering (`spaceOutbound.ts`)

`SpaceOutboundCoordinator` prevents races between user-driven replies and proactive alerts:

- **Alert hold**: while an inbound message is handled for a `space.id`, proactive alerts to that space are deferred.
- **FIFO queue**: all outbound work for a space runs through `spaceOutbound.run(spaceId, kind, fn)` with `kind` of `"user"` or `"alert"`.
- **Re-check on send**: alert tasks re-read `userPreferences` immediately before `app.send`, so a settings change that finishes during a hold can still affect whether the alert fires.

Inbound handlers use `void spaceOutbound.run(spaceId, "user", …)` so one slow Grok call does not block other conversations.

### In-memory preferences state

When a user sends a text message, `ts_agent` extracts macro trading preferences using the configured LLM and stores them in-memory:

- `userPreferences: Map<string, UserPreferences>`
- Key: `space.id` (conversation id)
- Value: `{ trackedKeywords: string[], watchlist: string[], sentimentThreshold: number, sourceTrustThreshold: number }`
- `spacesById: Map<string, Space>` — caches the Spectrum `space` handle for proactive outbound sends (populated on each inbound message)
- `lastAlertBySpace: Map<string, AlertContext>` — headline + Grok analysis for conversational follow-ups (~30 minute TTL)

This is intentionally **ephemeral** (memory-only). Persisting to a DB can be added later once the preference schema stabilizes.

### Alert follow-ups

After a proactive alert is sent, the agent stores `AlertContext` for that `space.id`. On later inbound text:

1. If there is recent alert context and the message looks like a **follow-up question** (e.g. ends with `?`, starts with “why”/“summarize”, mentions hawkish/dovish), it is **not** treated as a preference update.
2. Grok receives the stored headline/analysis plus the user’s question.
3. The response is sent with `message.reply()` so it threads in iMessage.

Preference-shaped messages (e.g. “alert me on CPI”, “threshold 0.5”) still go through preference extraction even if alert context exists.

### LLM preference extraction

Preferences are extracted by calling an **OpenAI-compatible** chat completions endpoint.

- Defaults to xAI (Grok):
  - `XAI_BASE_URL` (default `https://api.x.ai/v1`)
  - `XAI_API_KEY`
  - `GROK_MODEL` (optional)

If `GROK_MODEL` is unset, the agent tries `grok-4.3` first (if available on your account) and will auto-fallback by querying `/models` if the chosen model id is not available.

If the LLM call fails (or no API key is set), the agent falls back to defaults.

#### Notes on "Sorry" vs "Got it" replies

- A reply like "Sorry — I couldn't update your preferences right now." indicates the preference extraction step threw an error (network issue, non-OK API response, etc.).
- A "Got it — saved…" reply with `(none)` and `0.6` indicates the agent used defaults (commonly because `XAI_API_KEY` is missing/blank, the LLM returned empty content, or the JSON schema didn’t match expectations).
- The agent also dedupes duplicate inbound events when Spectrum delivers the same iMessage more than once, to avoid repeated replies.

#### Single-instance lock

To prevent accidentally running two agents at once (which would cause duplicate replies), `ts_agent` creates a lock file in your OS temp directory (macOS example: `/var/folders/...`). If a second instance starts and sees the lock held by a live PID, it exits with an error and prints the PID to stop.

## ZeroMQ integration

The repo uses **two** ZeroMQ PUB/SUB channels in opposite directions:

1. **Headlines** (C++ → Node): the engine publishes matching headlines; the agent consumes them in-process alongside Spectrum.
2. **Filter set** (Node → C++): the agent publishes the union of all users' interests so the engine knows what to forward (see [Filter-set channel](#filter-set-channel-node--c) below).

### Publisher (C++)

- `cpp_engine` binds a `PUB` socket (default `tcp://127.0.0.1:5555`).
- Bind endpoint override: positional CLI argument (any non-flag arg), e.g. `./cpp_engine --live tcp://127.0.0.1:5556`.
- Source selected by flag: `--simulate` (default; mock headlines every 2 s), `--live` (Finnhub REST poll every 2 s; needs `FINNHUB_API_KEY`), or `--live --demo` (real Finnhub data with capped recent backlog on first fetch + paced emissions; optional `--pace-ms=`, `--backlog-hours=`, `--backlog-max=` or `DEMO_*` env vars).
- Only headlines matching the **active** keyword filter are published. The filter defaults to the built-in macro keyword list below, but is replaced at runtime by the agent's filter set when one is connected.

**Built-in macro keyword filter** (case-insensitive substring; the default/fallback): `FOMC`, `CPI`, `PCE`, `inflation`, `Fed`, `Powell`, `Rates`, `ECB`, `Treasury`, `yield`, `jobs`, `payroll`, `unemployment`, `GDP`, `recession`, `tariff`, `stimulus`, `central bank`, `bond`.

### Filter-set channel (Node → C++)

User preferences (tracked keywords + watchlist tickers) live only in the agent, so the agent pushes them to the engine to control what gets forwarded:

- The agent **binds** a `PUB` socket on `FILTER_ENDPOINT` (default `tcp://127.0.0.1:5556`); the engine's `FilterSubscriber` **connects** a `SUB`.
- Frame: `{"type":"filterset","terms":[...]}`, where `terms` is the case-insensitively de-duplicated, sorted union of every `userPreferences` entry's `trackedKeywords` + `watchlist`.
- The agent publishes on every preference change **and** on a ~5 s heartbeat (`FILTER_HEARTBEAT_MS`). Because PUB/SUB drops messages to absent subscribers, the heartbeat is what lets a late/reconnecting engine converge; the engine ignores no-op repeats.
- An **empty** term set makes the engine fall back to its built-in macro keywords (e.g. no users yet). This is consistent with the agent's own "empty keyword set ⇒ match all" rule, and since the agent skips analysis entirely when it has no preferences, no Grok calls are wasted.
- This channel only decides what the engine *forwards*. Final per-user routing (which chat gets an alert) is still done in the agent's `shouldAlertUser`, which matches each headline against that user's `trackedKeywords` ∪ `watchlist` and the severity threshold.

### Subscriber (TypeScript, main agent)

- `index.ts` starts `runZmqHeadlineSubscriber()` concurrently with the Spectrum message loop (same Node process).
- Connects via `ZMQ_ENDPOINT` (default `tcp://127.0.0.1:5555`).
- Accepts any `type: "headline"` JSON frame (no second hardcoded keyword filter in the main agent).

**Headline pipeline**

1. Parse JSON frame (including the `source` publisher); dedupe by `ts` + headline (or headline alone) for ~2 minutes.
2. Call Grok (`analyzeHeadlineWithLlm`, passing the headline + source) → `{ sentiment, severity, summary, sourceTrust }`. `sourceTrust` (0–1) is Grok's credibility rating of the publisher; an absent/garbled rating defaults to ~0.3 (low).
3. For each `userPreferences` entry, enqueue `spaceOutbound.run(spaceId, "alert", …)` (waits if that space has an active alert hold).
4. Inside the alert task, re-check keywords, `severity >= sentimentThreshold`, **and** `sourceTrust >= sourceTrustThreshold` against current preferences, then `app.send(space, alertText)` and store `lastAlertBySpace`. The alert text and stored context include the source name and its `low`/`medium`/`high` trust label.

If no user has messaged since startup, preferences are empty and headlines are logged but not alerted. If preferences exist but `spacesById` lacks that `space.id`, the agent logs that the user must message first (Spectrum needs a cached conversation handle for outbound iMessage).

### Debug subscriber (`subscriber.ts`)

- `npm run sub` runs a **standalone** `SUB` CLI that only logs headlines matching its own hardcoded macro keyword list in `subscriber.ts`.
- Note: this list is maintained separately from the C++ engine's `MacroFilter` and is currently narrower (`FOMC`, `CPI`, `Rates`, `Powell`), so the debug subscriber may show fewer headlines than the engine publishes.
- Useful for verifying ZMQ without Spectrum, Grok, or iMessage.

**Message framing**

- No topic frames are used right now.
- Each publish is a single frame: UTF-8 JSON string with fields:
  - `type`: `"headline"`
  - `ts`: UTC ISO8601 timestamp
  - `headline`: headline text
  - `source`: publisher of the headline (e.g. `"Reuters"`); empty string when the upstream feed omits it (the agent treats unknown sources as low trust)

### Recommended starting point

For a simple “agent asks, engine answers” loop:

- **REQ/REP** sockets
- Engine **binds** to a local endpoint (e.g. `tcp://127.0.0.1:5555`)
- Agent **connects**

When you need more throughput / concurrency, consider:

- ROUTER/DEALER (async request/response)
- PUSH/PULL (work queue)
- PUB/SUB (broadcast events)

### Message framing and schema

ZeroMQ messages are frames (byte arrays). A pragmatic baseline is:

- Frame 0: `request_id` (UTF-8)
- Frame 1: `content_type` (e.g. `application/json`)
- Frame 2: payload bytes

If you pick JSON as a first version, define a minimal envelope like:

- `type`: string (command name)
- `payload`: object
- `ts`: number (unix millis)

Add versioning early (`schema_version`) so you can evolve without breaking.

### Reliability and timeouts

ZeroMQ is not a message broker; you must design for:

- timeouts on the client side
- retries / idempotency if you resend
- a clear contract for “at most once” vs “at least once” behavior

## Troubleshooting

### CMake can’t find ZeroMQ

- Ensure libzmq is installed (macOS: `brew install zeromq`).
- If you have multiple brew prefixes, make sure your shell environment exposes the right `pkg-config` paths.

### `npm install` fails for `zeromq`

`zeromq` may download a prebuilt binary or compile native components depending on platform/version. If compilation is required, make sure you have:

- Xcode Command Line Tools on macOS (`xcode-select --install`)
- a supported Node.js version

## Where to look in the repo

- C++ entrypoint: `cpp_engine/src/main.cpp`
- C++ build config: `cpp_engine/CMakeLists.txt`
- TS entrypoint (Spectrum + ZMQ alerts): `ts_agent/src/index.ts`
- TS per-space outbound ordering: `ts_agent/src/spaceOutbound.ts`
- TS ZMQ debug CLI: `ts_agent/src/subscriber.ts`
- TS build config: `ts_agent/tsconfig.json`
- Node deps: `ts_agent/package.json`
