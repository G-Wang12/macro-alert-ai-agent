# macro-alert-ai-agent

Dual-language starter repo with:

- `cpp_engine/`: a C++20 engine built with CMake and linked to ZeroMQ (libzmq + cppzmq)
- `ts_agent/`: a Node.js + TypeScript agent using `zeromq`, xAI (Grok), and `dotenv`

For implementation details (build/linking choices, intended ZeroMQ protocol), see `TECHNICAL.md`.

## Repository layout

- `cpp_engine/` — C++20 CMake project
- `ts_agent/` — Node.js TypeScript project

## cpp_engine (C++20 + ZeroMQ)

### Prereqs

- CMake 3.22+
- A C++20 compiler (Apple Clang / LLVM / GCC)
- ZeroMQ core library (`libzmq`)

On macOS (Homebrew):

```bash
brew install cmake zeromq
```

### Build & run

```bash
cmake -S cpp_engine -B cpp_engine/build -DCMAKE_BUILD_TYPE=Release
cmake --build cpp_engine/build
./cpp_engine/build/cpp_engine
```

By default, `cpp_engine` samples a simulated headline every 2 seconds and publishes it over ZeroMQ `PUB` on `tcp://127.0.0.1:5555` **only if it matches a hardcoded macro keyword filter**.

Current macro keywords (case-insensitive substring match): `FOMC`, `CPI`, `Rates`, `Powell`.

You can override the bind endpoint:

```bash
./cpp_engine/build/cpp_engine tcp://127.0.0.1:5555
```

Notes:

- `cpp_engine/CMakeLists.txt` fetches `cppzmq` automatically via CMake `FetchContent`.
- You still need `libzmq` installed system-wide (e.g. via Homebrew).

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

### Build & run

```bash
npm run build
npm start
```

`npm start` runs one process that:

1. **Reactive (iMessage)**: listens on Spectrum `app.messages`, extracts preferences with Grok, and replies.
2. **Proactive (ZeroMQ)**: subscribes to `cpp_engine` headlines in the background, analyzes each with Grok, and pushes iMessage alerts when a user’s preferences match.

Start `cpp_engine` in another terminal so headlines are published:

```bash
./cpp_engine/build/cpp_engine
```

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
- If you get multiple identical replies for a single text, you likely have multiple `npm start` processes running at once. Stop extras (Ctrl+C) so only one agent instance is connected.
- The agent also enforces a single-instance lock; if you try to start a second copy, it will exit and tell you which PID is already running.

### What to test (proactive macro alerts)

After saving preferences (above), leave `npm start` running with `cpp_engine` publishing:

1. Watch the agent console for `[ZMQ] headline: ...` when a headline is received.
2. If the headline matches your keywords and Grok’s **severity** is at or above your **sentiment threshold**, you should get a proactive iMessage (no new inbound message required).
3. Lower threshold → more alerts; higher threshold → fewer.

Troubleshooting (alerts):

- No `[ZMQ]` logs: check `cpp_engine` is running and `ZMQ_ENDPOINT` matches its bind address.
- Headlines logged but no alert: preferences may not match (keywords or severity below threshold), or `XAI_API_KEY` is missing (analysis is skipped).
- Console says `no user preferences yet`: send at least one iMessage to configure preferences first.
- Console says `no cached conversation`: you must message the agent at least once per run so it can resolve the Spectrum `space` for outbound sends.

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
