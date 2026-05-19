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
./cpp_engine/build/cpp_engine tcp://127.0.0.1:6000
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

- `XAI_API_KEY=...`

### Build & run

```bash
npm run build
npm start
```

### Subscribe to macro headlines (ZeroMQ SUB)

In a separate terminal (while `cpp_engine` is running):

```bash
cd ts_agent
npm run build
npm run sub
```

If you ran `cpp_engine` on a non-default port, pass the endpoint through to the subscriber:

```bash
npm run sub -- tcp://127.0.0.1:6000
```
