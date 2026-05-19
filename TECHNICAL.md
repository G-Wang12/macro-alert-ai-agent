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
- xAI (Grok): called via OpenAI-compatible HTTP endpoints using `fetch`
- `zeromq`: Node bindings for ZeroMQ

Security note: keep `XAI_API_KEY` on the agent side. Don’t pass the key over ZeroMQ.

## ZeroMQ integration (intended)

Today the repo only validates that both sides can initialize their libraries. The next technical decision is the **messaging pattern** and **wire format**.

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
- TS entrypoint: `ts_agent/src/index.ts`
- TS build config: `ts_agent/tsconfig.json`
- Node deps: `ts_agent/package.json`
