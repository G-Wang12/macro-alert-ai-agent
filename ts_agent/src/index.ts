import "dotenv/config";

import { Spectrum, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subscriber } from "zeromq";
import { SpaceOutboundCoordinator } from "./spaceOutbound.js";

type UserPreferences = {
  trackedKeywords: string[];
  sentimentThreshold: number; // 0..1
};

type HeadlineMessage = {
  type?: string;
  ts?: string;
  headline?: string;
};

type HeadlineAnalysis = {
  sentiment: number; // 0=bearish, 1=bullish
  severity: number; // 0=low market impact, 1=high
  summary: string;
};

type AlertContext = {
  headline: string;
  analysis: HeadlineAnalysis;
  sentAt: number;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ModelListResponse = {
  data?: Array<{ id?: string }>;
};

const userPreferences = new Map<string, UserPreferences>();
const spacesById = new Map<string, Space>();
const lastAlertBySpace = new Map<string, AlertContext>();
const spaceOutbound = new SpaceOutboundCoordinator();

const DEDUPE_TTL_MS = 5 * 60 * 1000;
const HEADLINE_DEDUPE_TTL_MS = 2 * 60 * 1000;
const ALERT_CONTEXT_TTL_MS = 30 * 60 * 1000;
const processedMessageKeys = new Map<string, number>();
const inFlightMessageKeys = new Set<string>();
const processedHeadlineKeys = new Map<string, number>();
const inFlightHeadlineKeys = new Set<string>();

function acquireSingleInstanceLock(): () => void {
  const lockPath = join(tmpdir(), "macro-alert-ai-agent-ts_agent.lock");

  const tryCreate = (): boolean => {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  };

  try {
    tryCreate();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") throw err;

    let otherPid = 0;
    try {
      const raw = readFileSync(lockPath, "utf8").trim();
      otherPid = Number.parseInt(raw, 10);
    } catch {
      otherPid = 0;
    }

    if (Number.isFinite(otherPid) && otherPid > 0) {
      try {
        process.kill(otherPid, 0);
        console.error(
          `ts_agent: another instance is already running (pid ${otherPid}). ` +
            `Stop the other process (Ctrl+C) before starting a new one.`,
        );
        process.exit(1);
      } catch {
        // Stale lock; fall through and replace it.
      }
    }

    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
    // One retry.
    tryCreate();
  }

  const release = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };

  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });

  return release;
}

function pruneProcessedMessageKeys(nowMs: number): void {
  for (const [key, ts] of processedMessageKeys) {
    if (nowMs - ts > DEDUPE_TTL_MS) {
      processedMessageKeys.delete(key);
    }
  }
}

function tryStartProcessingMessage(key: string): boolean {
  const now = Date.now();
  pruneProcessedMessageKeys(now);

  if (inFlightMessageKeys.has(key)) return false;
  const lastTs = processedMessageKeys.get(key);
  if (typeof lastTs === "number" && now - lastTs <= DEDUPE_TTL_MS) return false;

  inFlightMessageKeys.add(key);
  return true;
}

function finishProcessingMessage(key: string): void {
  inFlightMessageKeys.delete(key);
  processedMessageKeys.set(key, Date.now());
}

function stripJsonCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
  }
  return trimmed;
}

function normalizePreferences(maybe: unknown): UserPreferences | null {
  if (!maybe || typeof maybe !== "object") return null;
  const obj = maybe as Record<string, unknown>;

  const tracked = obj.trackedKeywords;
  const threshold = obj.sentimentThreshold;

  const trackedKeywords = Array.isArray(tracked)
    ? tracked
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  let sentimentThreshold = typeof threshold === "number" ? threshold : 0.6;
  if (!Number.isFinite(sentimentThreshold)) sentimentThreshold = 0.6;
  sentimentThreshold = Math.max(0, Math.min(1, sentimentThreshold));

  return { trackedKeywords, sentimentThreshold };
}

async function listModelIds(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    return [];
  }

  const data = (await res.json()) as ModelListResponse;
  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return Array.from(new Set(ids));
}

function pickFallbackModelId(ids: string[]): string | null {
  if (ids.length === 0) return null;

  const prefer = [
    // Current xAI console models (May 2026)
    "grok-4.3",
    "grok-4.20-multi-agent-0309",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",

    // Older / common ids
    "grok-2",
    "grok-2-latest",
    "grok-1",
    "grok-1-latest",
  ];
  for (const wanted of prefer) {
    const hit = ids.find((id) => id === wanted);
    if (hit) return hit;
  }

  const grok = ids.find((id) => id.toLowerCase().startsWith("grok"));
  return grok ?? ids[0] ?? null;
}

async function grokChatCompletion(
  system: string,
  user: string,
  errorLabel: string,
): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(`${errorLabel}: XAI_API_KEY is not set`);
  }

  const baseUrl = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";
  const requestedModel = (process.env.GROK_MODEL ?? "").trim() || undefined;

  const call = async (model: string) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
      }),
    });
    return res;
  };

  let model = requestedModel ?? "grok-4.3";
  let res = await call(model);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const modelNotFound = res.status === 400 && /model not found/i.test(text);
    if (modelNotFound) {
      const ids = await listModelIds(baseUrl, apiKey);
      const fallback = pickFallbackModelId(ids);
      if (fallback && fallback !== model) {
        console.warn(
          `ts_agent: GROK_MODEL '${model}' not found; retrying with '${fallback}'. ` +
            (ids.length
              ? `Available: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", ..." : ""}`
              : ""),
        );
        model = fallback;
        res = await call(model);
      }
    }

    if (!res.ok) {
      const finalText = await res.text().catch(() => "");
      throw new Error(
        `${errorLabel}: ${res.status} ${res.statusText}${finalText ? `\n${finalText}` : ""}`,
      );
    }
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${errorLabel}: LLM returned no message content`);
  }

  return content;
}

function pruneProcessedHeadlineKeys(nowMs: number): void {
  for (const [key, ts] of processedHeadlineKeys) {
    if (nowMs - ts > HEADLINE_DEDUPE_TTL_MS) {
      processedHeadlineKeys.delete(key);
    }
  }
}

function tryStartProcessingHeadline(key: string): boolean {
  const now = Date.now();
  pruneProcessedHeadlineKeys(now);

  if (inFlightHeadlineKeys.has(key)) return false;
  const lastTs = processedHeadlineKeys.get(key);
  if (typeof lastTs === "number" && now - lastTs <= HEADLINE_DEDUPE_TTL_MS) {
    return false;
  }

  inFlightHeadlineKeys.add(key);
  return true;
}

function finishProcessingHeadline(key: string): void {
  inFlightHeadlineKeys.delete(key);
  processedHeadlineKeys.set(key, Date.now());
}

function normalizeHeadlineAnalysis(maybe: unknown): HeadlineAnalysis | null {
  if (!maybe || typeof maybe !== "object") return null;
  const obj = maybe as Record<string, unknown>;

  let sentiment = typeof obj.sentiment === "number" ? obj.sentiment : 0.5;
  let severity = typeof obj.severity === "number" ? obj.severity : 0.5;
  if (!Number.isFinite(sentiment)) sentiment = 0.5;
  if (!Number.isFinite(severity)) severity = 0.5;
  sentiment = Math.max(0, Math.min(1, sentiment));
  severity = Math.max(0, Math.min(1, severity));

  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : "";

  return { sentiment, severity, summary };
}

function matchesUserKeywords(
  headline: string,
  trackedKeywords: string[],
): boolean {
  if (trackedKeywords.length === 0) return true;
  const haystack = headline.toLowerCase();
  return trackedKeywords.some((kw) =>
    haystack.includes(kw.trim().toLowerCase()),
  );
}

function shouldAlertUser(
  headline: string,
  analysis: HeadlineAnalysis,
  prefs: UserPreferences,
): boolean {
  if (!matchesUserKeywords(headline, prefs.trackedKeywords)) return false;
  return analysis.severity >= prefs.sentimentThreshold;
}

function formatSentimentLabel(sentiment: number): string {
  if (sentiment >= 0.65) return "bullish";
  if (sentiment <= 0.35) return "bearish";
  return "neutral";
}

function getRecentAlertContext(spaceId: string): AlertContext | null {
  const ctx = lastAlertBySpace.get(spaceId);
  if (!ctx) return null;
  if (Date.now() - ctx.sentAt > ALERT_CONTEXT_TTL_MS) {
    lastAlertBySpace.delete(spaceId);
    return null;
  }
  return ctx;
}

function rememberAlertContext(
  spaceId: string,
  headline: string,
  analysis: HeadlineAnalysis,
): void {
  lastAlertBySpace.set(spaceId, {
    headline,
    analysis,
    sentAt: Date.now(),
  });
}

function looksLikeAlertFollowUp(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("?")) return true;

  const patterns = [
    /^why\b/,
    /^what\b/,
    /^how\b/,
    /^when\b/,
    /^explain\b/,
    /^summarize\b/,
    /^summary\b/,
    /^tell me\b/,
    /^can you\b/,
    /^could you\b/,
    /\bmore detail/,
    /\bwhole report\b/,
    /\bthis mean\b/,
    /\bbreak (it )?down\b/,
    /\belaborate\b/,
    /\bhawkish\b/,
    /\bdovish\b/,
    /\bmarket impact\b/,
    /\btrade\b.*\?/,
  ];
  return patterns.some((p) => p.test(t));
}

function looksLikePreferenceUpdate(text: string): boolean {
  const t = text.trim().toLowerCase();
  const patterns = [
    /\balert me\b/,
    /\bnotify me\b/,
    /\btrack\b/,
    /\bwatch for\b/,
    /\bthreshold\b/,
    /\bkeyword/,
    /\bpreference/,
    /\binterested in\b/,
    /\bonly (alert|notify)\b/,
    /\bstop alerting\b/,
    /\bunsubscribe\b/,
  ];
  return patterns.some((p) => p.test(t));
}

function shouldHandleAsAlertFollowUp(
  text: string,
  spaceId: string,
): boolean {
  if (!getRecentAlertContext(spaceId)) return false;
  if (looksLikePreferenceUpdate(text)) return false;
  return looksLikeAlertFollowUp(text);
}

function formatAlertContextForLlm(ctx: AlertContext): string {
  const sentimentLabel = formatSentimentLabel(ctx.analysis.sentiment);
  const lines = [
    `Headline: ${ctx.headline}`,
    `Severity: ${ctx.analysis.severity.toFixed(2)}`,
    `Sentiment: ${sentimentLabel} (${ctx.analysis.sentiment.toFixed(2)})`,
  ];
  if (ctx.analysis.summary) {
    lines.push(`Summary: ${ctx.analysis.summary}`);
  }
  return lines.join("\n");
}

async function answerAlertFollowUp(
  question: string,
  ctx: AlertContext,
): Promise<string> {
  const system =
    "You are a macro trading analyst helping a user understand a news alert they received. " +
    "Use the alert context below. Answer clearly in plain text for iMessage (no JSON, no markdown code fences). " +
    "Be specific about market implications when relevant. Keep under ~400 words unless they asked for a full report summary.";

  const user =
    `Alert context:\n${formatAlertContextForLlm(ctx)}\n\n` +
    `User follow-up: ${question}`;

  return grokChatCompletion(system, user, "Alert follow-up");
}

function formatAlertMessage(
  headline: string,
  analysis: HeadlineAnalysis,
): string {
  const sentimentLabel = formatSentimentLabel(analysis.sentiment);
  const lines = [
    "Macro alert",
    headline,
    `Severity: ${analysis.severity.toFixed(2)} | Sentiment: ${sentimentLabel} (${analysis.sentiment.toFixed(2)})`,
  ];
  if (analysis.summary) {
    lines.push(analysis.summary);
  }
  return lines.join("\n");
}

async function analyzeHeadlineWithLlm(
  headline: string,
): Promise<HeadlineAnalysis | null> {
  if (!process.env.XAI_API_KEY) {
    console.warn(
      "ts_agent: XAI_API_KEY is not set — skipping headline LLM analysis.",
    );
    return null;
  }

  const system =
    "You analyze macro/news headlines for traders. " +
    "Return ONLY valid JSON with keys: sentiment (number 0..1, 0=bearish, 1=bullish), " +
    "severity (number 0..1, market-moving importance), summary (short string). " +
    "Be conservative: severity should reflect likely market impact, not drama.";

  try {
    const content = await grokChatCompletion(
      system,
      headline,
      "Headline analysis",
    );
    const jsonText = stripJsonCodeFences(content);
    const parsed = JSON.parse(jsonText) as unknown;
    return normalizeHeadlineAnalysis(parsed);
  } catch (err) {
    console.error("ts_agent: headline analysis failed:", err);
    return null;
  }
}

async function dispatchHeadlineAlerts(
  app: Awaited<ReturnType<typeof Spectrum>>,
  headline: string,
  analysis: HeadlineAnalysis,
): Promise<void> {
  for (const spaceId of userPreferences.keys()) {
    const space = spacesById.get(spaceId);
    if (!space) {
      console.log(
        `[ZMQ] alert matched space=${spaceId} but no cached conversation — user must message the agent first`,
      );
      continue;
    }

    const alert = formatAlertMessage(headline, analysis);
    try {
      const sent = await spaceOutbound.run(spaceId, "alert", async () => {
        const prefs = userPreferences.get(spaceId);
        if (!prefs || !shouldAlertUser(headline, analysis, prefs)) return false;

        await app.send(space, alert);
        rememberAlertContext(spaceId, headline, analysis);
        return true;
      });
      if (sent) {
        console.log(`[ZMQ] proactive alert sent space=${spaceId}`);
      }
    } catch (err) {
      console.error(`[ZMQ] failed to send alert space=${spaceId}:`, err);
    }
  }
}

async function runZmqHeadlineSubscriber(
  app: Awaited<ReturnType<typeof Spectrum>>,
): Promise<void> {
  const endpoint = process.env.ZMQ_ENDPOINT ?? "tcp://127.0.0.1:5555";
  const sub = new Subscriber();
  sub.connect(endpoint);
  sub.subscribe("");

  console.log(`ts_agent: ZeroMQ subscriber connected to ${endpoint}`);

  for await (const frames of sub) {
    const msg = frames[0];
    if (!msg) continue;

    let parsed: HeadlineMessage;
    try {
      parsed = JSON.parse(msg.toString("utf8")) as HeadlineMessage;
    } catch {
      continue;
    }

    if (parsed.type !== "headline") continue;
    const headline = parsed.headline;
    if (typeof headline !== "string" || !headline.trim()) continue;

    const dedupeKey = parsed.ts
      ? `ts:${parsed.ts}:${headline}`
      : `headline:${headline}`;
    if (!tryStartProcessingHeadline(dedupeKey)) continue;

    console.log(`[ZMQ] headline: ${headline}`);

    try {
      if (userPreferences.size === 0) {
        console.log("[ZMQ] no user preferences yet — skipping alerts");
        continue;
      }

      const analysis = await analyzeHeadlineWithLlm(headline);
      if (!analysis) continue;

      await dispatchHeadlineAlerts(app, headline, analysis);
    } finally {
      finishProcessingHeadline(dedupeKey);
    }
  }
}

async function extractPreferencesWithLlm(
  userText: string,
): Promise<UserPreferences> {
  if (!process.env.XAI_API_KEY) {
    console.warn(
      "ts_agent: XAI_API_KEY is not set (or is empty) — using default preferences.",
    );
    return { trackedKeywords: [], sentimentThreshold: 0.6 };
  }

  const system =
    "You extract macro trading alert preferences from user messages. " +
    "Return ONLY valid JSON with keys: trackedKeywords (string[]), sentimentThreshold (number 0..1). " +
    "trackedKeywords should be macro/news triggers like CPI, FOMC, rates, Powell, NFP, inflation. " +
    "sentimentThreshold is a sensitivity value: lower = more alerts, higher = fewer alerts. " +
    "If user provides none, use trackedKeywords=[] and sentimentThreshold=0.6.";

  let content: string;
  try {
    content = await grokChatCompletion(
      system,
      userText,
      "LLM extraction",
    );
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  const jsonText = stripJsonCodeFences(content);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const normalized = normalizePreferences(parsed);
    if (!normalized) {
      console.warn(
        "ts_agent: LLM JSON did not match expected schema — using default preferences.",
      );
    }
    return (
      normalized ?? {
        trackedKeywords: [],
        sentimentThreshold: 0.6,
      }
    );
  } catch (err) {
    console.warn(
      "ts_agent: Failed to parse LLM JSON — using default preferences.",
      err,
    );
    return { trackedKeywords: [], sentimentThreshold: 0.6 };
  }
}

async function main(): Promise<void> {
  acquireSingleInstanceLock();

  const projectId = process.env.PROJECT_ID;
  const projectSecret = process.env.PROJECT_SECRET ?? process.env.SECRET_KEY;
  if (!projectId || !projectSecret) {
    console.log(
      "ts_agent: PROJECT_ID / PROJECT_SECRET not set (see .env.example). " +
        "These are required to receive iMessage via Spectrum cloud mode.",
    );
    return;
  }

  const app = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
  });

  process.on("SIGINT", () => {
    void app.stop();
  });
  process.on("SIGTERM", () => {
    void app.stop();
  });

  console.log("ts_agent: Spectrum app started; waiting for messages...");

  void runZmqHeadlineSubscriber(app).catch((err) => {
    console.error("ts_agent: ZeroMQ subscriber exited:", err);
  });

  for await (const [space, message] of app.messages) {
    if (message.platform !== "iMessage") continue;
    if (message.content.type !== "text") continue;

    const text = message.content.text;
    const spaceId = space.id;
    spacesById.set(spaceId, space);

    const msgAny = message as unknown as Record<string, unknown>;
    const messageId =
      (typeof msgAny.id === "string" && msgAny.id) ||
      (typeof msgAny.messageId === "string" && msgAny.messageId) ||
      (typeof msgAny.eventId === "string" && msgAny.eventId) ||
      "";
    const createdAt =
      (typeof msgAny.createdAt === "string" && msgAny.createdAt) ||
      (typeof msgAny.timestamp === "string" && msgAny.timestamp) ||
      (typeof msgAny.sentAt === "string" && msgAny.sentAt) ||
      "";
    const senderId = message.sender.id;
    const dedupeKey = messageId
      ? `id:${messageId}`
      : `sig:${senderId}:${createdAt}:${text}`;

    const messageKey = `${spaceId}|${dedupeKey}`;

    if (!tryStartProcessingMessage(messageKey)) {
      console.log(
        `[iMessage] duplicate ignored space=${spaceId} sender=${senderId}` +
          (messageId ? ` id=${messageId}` : ""),
      );
      continue;
    }

    console.log(
      `[iMessage] space=${spaceId} sender=${senderId}` +
        (messageId ? ` id=${messageId}` : "") +
        `: ${text}`,
    );

    void spaceOutbound
      .run(spaceId, "user", async () => {
        const releaseAlertHold = spaceOutbound.holdAlerts(spaceId);
        const isAlertFollowUp = shouldHandleAsAlertFollowUp(text, spaceId);

        try {
          if (isAlertFollowUp) {
            const alertCtx = getRecentAlertContext(spaceId);
            if (!alertCtx) {
              await message.reply(
                "I don't have a recent alert in context — ask again after your next macro alert.",
              );
              return;
            }

            if (!process.env.XAI_API_KEY) {
              await message.reply(
                "I need an API key configured to answer follow-up questions.",
              );
              return;
            }

            console.log(`[iMessage] alert follow-up space=${spaceId}: ${text}`);
            const answer = await answerAlertFollowUp(text, alertCtx);
            await message.reply(answer);
            return;
          }

          const prefs = await extractPreferencesWithLlm(text);
          userPreferences.set(spaceId, prefs);

          const keywordsPretty = prefs.trackedKeywords.length
            ? prefs.trackedKeywords.join(", ")
            : "(none)";
          await space.send(
            `Got it — saved your macro preferences for this chat.\n` +
              `Tracked keywords: ${keywordsPretty}\n` +
              `Sentiment threshold: ${prefs.sentimentThreshold}`,
          );
        } catch (err) {
          console.error(err);
          if (isAlertFollowUp) {
            await message.reply(
              "Sorry — I couldn't analyze that follow-up right now.",
            );
          } else {
            await space.send(
              "Sorry — I couldn't update your preferences right now.",
            );
          }
        } finally {
          releaseAlertHold();
          finishProcessingMessage(messageKey);
        }
      })
      .catch((err) => {
        console.error(`[iMessage] handler failed space=${spaceId}:`, err);
        finishProcessingMessage(messageKey);
      });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
