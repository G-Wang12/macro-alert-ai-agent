import { Publisher } from "zeromq";

// Debug-only headline injector.
//
// Binds a ZeroMQ PUB socket and publishes a single headline frame in the same
// JSON shape cpp_engine uses ({"type":"headline","ts":...,"headline":...}),
// bypassing the C++ macro-keyword filter. Use it to test the agent's own
// matching logic (e.g. watchlist tickers) with headlines the real cpp_engine
// would have dropped before publishing.
//
// Usage:
//   npm run build
//   npm run pub -- "TSLA tumbles 8% on weak deliveries"
//   npm run pub -- "Fed holds; NVDA pops" tcp://127.0.0.1:5555
//
// IMPORTANT: a PUB socket *binds* the endpoint, and cpp_engine binds the same
// endpoint, so only one can run at a time. Stop cpp_engine before running this.
// Start the agent (npm start) first so its SUB socket is connected before the
// headline is sent.

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Allow an optional trailing endpoint arg (anything starting with a scheme).
  let endpoint = process.env.ZMQ_ENDPOINT ?? "tcp://127.0.0.1:5555";
  if (args.length > 1 && /^[a-z]+:\/\//i.test(args[args.length - 1]!)) {
    endpoint = args.pop()!;
  }

  const headline = args.join(" ").trim();
  if (!headline) {
    console.error(
      'Usage: npm run pub -- "<headline text>" [tcp://host:port]',
    );
    process.exitCode = 1;
    return;
  }

  const pub = new Publisher();
  await pub.bind(endpoint);
  console.log(`testPublisher: bound PUB on ${endpoint}`);

  // Fixed timestamp so the agent's dedupe key (ts:headline) stays constant:
  // we publish a few times to beat the PUB/SUB slow-joiner, but the agent only
  // processes — and only alerts on — the headline once.
  const ts = new Date().toISOString();
  const frame = JSON.stringify({ type: "headline", ts, headline });

  const ATTEMPTS = 5;
  const INTERVAL_MS = 600;
  for (let i = 0; i < ATTEMPTS; i++) {
    await pub.send(frame);
    console.log(
      `testPublisher: published (${i + 1}/${ATTEMPTS}) ${headline}`,
    );
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  pub.close();
  console.log("testPublisher: done");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
