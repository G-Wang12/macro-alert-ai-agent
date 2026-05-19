import { Subscriber } from "zeromq";

type HeadlineMessage = {
  type?: string;
  ts?: string;
  headline?: string;
};

const MACRO_KEYWORDS = ["FOMC", "CPI", "Rates", "Powell"] as const;

function matchesMacroKeywords(headline: string): boolean {
  const haystack = headline.toLowerCase();
  return MACRO_KEYWORDS.some((kw) => haystack.includes(kw.toLowerCase()));
}

async function main(): Promise<void> {
  const endpoint =
    process.argv[2] ?? process.env.ZMQ_ENDPOINT ?? "tcp://127.0.0.1:5555";

  const sub = new Subscriber();
  sub.connect(endpoint);
  // Subscribe to all messages (publisher does not use topics).
  sub.subscribe("");

  console.log(`ts_agent: subscribed to ${endpoint}`);

  for await (const frames of sub) {
    const msg = frames[0];
    if (!msg) continue;

    const text = msg.toString("utf8");

    let parsed: HeadlineMessage;
    try {
      parsed = JSON.parse(text) as HeadlineMessage;
    } catch {
      // Ignore non-JSON messages.
      continue;
    }

    const headline = parsed.headline;
    if (
      parsed.type === "headline" &&
      typeof headline === "string" &&
      matchesMacroKeywords(headline)
    ) {
      console.log(headline);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
