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

- `cpp_engine/CMakeLists.txt` uses CMake `FetchContent` to fetch **cppzmq** at configure time.
- **libzmq is not vendored** by this repo: you install it via your OS package manager (e.g. Homebrew on macOS).

Why this approach:

- cppzmq is small and header-only, so `FetchContent` is straightforward.
- libzmq is a native dependency that’s better managed by the system (security updates, platform builds).

### Linking details

The CMake file links the executable against:

- `cppzmq` (interface target) for `#include <zmq.hpp>`
- libzmq (pulled in transitively by cppzmq’s CMake logic)

If you hit link or discovery issues, the most common cause is that libzmq isn’t installed or isn’t visible to CMake/pkg-config.

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

1. **Reactive (Spectrum)**: `for await` on `app.messages` — replies when a user configures preferences.
2. **Proactive (ZeroMQ)**: a background `SUB` socket in the same process — analyzes headlines and calls `app.send(space, text)` when thresholds match.

For debugging, inbound iMessages are logged with `space.id` and `sender.id`; ZMQ headlines are logged as `[ZMQ] headline: ...`.

### In-memory preferences state

When a user sends a text message, `ts_agent` extracts macro trading preferences using the configured LLM and stores them in-memory:

- `userPreferences: Map<string, UserPreferences>`
- Key: `space.id` (conversation id)
- Value: `{ trackedKeywords: string[], sentimentThreshold: number }`
- `spacesById: Map<string, Space>` — caches the Spectrum `space` handle for proactive outbound sends (populated on each inbound message)

This is intentionally **ephemeral** (memory-only). Persisting to a DB can be added later once the preference schema stabilizes.

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

The repo streams macro headlines from C++ → Node over **PUB/SUB**, and the main agent (`index.ts`) consumes them in-process alongside Spectrum.

### Publisher (C++)

- `cpp_engine` binds a `PUB` socket (default `tcp://127.0.0.1:5555`).
- Bind endpoint override: `argv[1]`.
- A simulated headline is sampled every 2 seconds.
- Only headlines matching a **hardcoded** macro keyword filter are published.

**C++ macro keyword filter** (case-insensitive substring): `FOMC`, `CPI`, `Rates`, `Powell`.

### Subscriber (TypeScript, main agent)

- `index.ts` starts `runZmqHeadlineSubscriber()` concurrently with the Spectrum message loop (same Node process).
- Connects via `ZMQ_ENDPOINT` (default `tcp://127.0.0.1:5555`).
- Accepts any `type: "headline"` JSON frame (no second hardcoded keyword filter in the main agent).

**Headline pipeline**

1. Parse JSON frame; dedupe by `ts` + headline (or headline alone) for ~2 minutes.
2. Call Grok (`analyzeHeadlineWithLlm`) → `{ sentiment, severity, summary }`.
3. For each `userPreferences` entry:
   - **Keywords**: if `trackedKeywords` is non-empty, the headline must contain at least one (case-insensitive). If empty, no keyword filter.
   - **Threshold**: alert when `severity >= sentimentThreshold` (lower threshold = more alerts).
4. If matched, `app.send(space, alertText)` using the cached `spacesById` entry.

If no user has messaged since startup, preferences are empty and headlines are logged but not alerted. If preferences exist but `spacesById` lacks that `space.id`, the agent logs that the user must message first (Spectrum needs a cached conversation handle for outbound iMessage).

### Debug subscriber (`subscriber.ts`)

- `npm run sub` runs a **standalone** `SUB` CLI that only logs headlines matching the same hardcoded macro keywords as C++.
- Useful for verifying ZMQ without Spectrum, Grok, or iMessage.

**Message framing**

- No topic frames are used right now.
- Each publish is a single frame: UTF-8 JSON string with fields:
  - `type`: `"headline"`
  - `ts`: UTC ISO8601 timestamp
  - `headline`: headline text

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
- TS ZMQ debug CLI: `ts_agent/src/subscriber.ts`
- TS build config: `ts_agent/tsconfig.json`
- Node deps: `ts_agent/package.json`
