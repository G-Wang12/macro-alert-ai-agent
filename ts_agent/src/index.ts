import "dotenv/config";

import { Spectrum, cloud, type Space } from "spectrum-ts";
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
import { Publisher, Subscriber } from "zeromq";
import { SpaceOutboundCoordinator } from "./spaceOutbound.js";

type UserPreferences = {
  trackedKeywords: string[];
  // Minimum headline market-impact score (0..1) required to send an alert.
  // Compared against Grok's `severity` rating — not bullish/bearish sentiment.
  severityThreshold: number;
  watchlist?: string[]; // explicit stock tickers the user mentioned
  // Minimum source trustworthiness (0..1) required to alert. 0 = no filtering
  // (alert regardless of source); higher values suppress low-trust publishers.
  sourceTrustThreshold: number;
};

// A single inbound message is treated as an incremental change to existing
// preferences, not a full replacement. The LLM extracts only what THIS message
// mentions; the merge (mergePreferences) applies it in code.
//
// Per list: `replace*` (non-null) sets the list to exactly that value — an empty
// array clears just that list — and takes precedence over add/remove. Otherwise
// `add*` then `remove*` are applied. `severityThreshold: null` means untouched.
// `clearAll` resets everything to defaults.
type PreferenceUpdate = {
  addKeywords: string[];
  removeKeywords: string[];
  replaceKeywords: string[] | null;
  addTickers: string[];
  removeTickers: string[];
  replaceTickers: string[] | null;
  severityThreshold: number | null;
  sourceTrustThreshold: number | null;
  clearAll: boolean;
};

const DEFAULT_PREFERENCES: UserPreferences = {
  trackedKeywords: [],
  severityThreshold: 0.6,
  watchlist: [],
  sourceTrustThreshold: 0,
};

type HeadlineMessage = {
  type?: string;
  ts?: string;
  headline?: string;
  source?: string; // publisher of the headline (e.g. "Reuters"); may be absent
};

type HeadlineAnalysis = {
  sentiment: number; // 0=bearish, 1=bullish
  severity: number; // 0=low market impact, 1=high
  summary: string;
  sourceTrust: number; // 0=untrustworthy source, 1=highly credible
};

type AlertContext = {
  headline: string;
  source: string;
  analysis: HeadlineAnalysis;
  sentAt: number;
  alertMessageId?: string; // id of the OutboundMessage we sent, used to match thread replies
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
// Ordered newest-first; capped at ALERT_HISTORY_MAX entries per space.
const alertHistoryBySpace = new Map<string, AlertContext[]>();
const ALERT_HISTORY_MAX = 10;
const spaceOutbound = new SpaceOutboundCoordinator();

// Reverse channel to cpp_engine: we PUB the union of every user's tracked
// keywords + watchlist tickers so the engine narrows what it forwards. The
// engine subscribes and rebuilds its filter at runtime (see FilterSubscriber).
let filterPublisher: Publisher | null = null;
let lastPublishedFilterSet = "";
const FILTER_HEARTBEAT_MS = 5 * 1000;

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

function toStringList(maybe: unknown): string[] {
  return Array.isArray(maybe)
    ? maybe
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

const NOOP_PREFERENCE_UPDATE: PreferenceUpdate = {
  addKeywords: [],
  removeKeywords: [],
  replaceKeywords: null,
  addTickers: [],
  removeTickers: [],
  replaceTickers: null,
  severityThreshold: null,
  sourceTrustThreshold: null,
  clearAll: false,
};

// Parse the LLM's incremental-update JSON. Returns a no-op update for anything
// malformed — never throws away existing prefs. A `replace*` field is honored
// only when it's actually an array (so an empty array means "clear that list",
// while a missing/null field means "don't replace").
function normalizePreferenceUpdate(maybe: unknown): PreferenceUpdate {
  if (!maybe || typeof maybe !== "object") return { ...NOOP_PREFERENCE_UPDATE };
  const obj = maybe as Record<string, unknown>;

  const upper = (xs: string[]) => xs.map((s) => s.toUpperCase());
  const asListOrNull = (v: unknown): string[] | null =>
    Array.isArray(v) ? toStringList(v) : null;

  const replaceTickersRaw = asListOrNull(obj.replaceTickers);

  let severityThreshold: number | null = null;
  const thresholdRaw =
    obj.severityThreshold ?? obj.sentimentThreshold; // legacy LLM key
  if (typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw)) {
    severityThreshold = Math.max(0, Math.min(1, thresholdRaw));
  }

  let sourceTrustThreshold: number | null = null;
  if (
    typeof obj.sourceTrustThreshold === "number" &&
    Number.isFinite(obj.sourceTrustThreshold)
  ) {
    sourceTrustThreshold = Math.max(0, Math.min(1, obj.sourceTrustThreshold));
  }

  return {
    addKeywords: toStringList(obj.addKeywords),
    removeKeywords: toStringList(obj.removeKeywords),
    replaceKeywords: asListOrNull(obj.replaceKeywords),
    addTickers: upper(toStringList(obj.addTickers)),
    removeTickers: upper(toStringList(obj.removeTickers)),
    replaceTickers: replaceTickersRaw === null ? null : upper(replaceTickersRaw),
    severityThreshold,
    sourceTrustThreshold,
    clearAll: obj.clearAll === true,
  };
}

// Append `additions` to `existing`, dropping case-insensitive duplicates and
// preserving the existing entries' order and casing.
function mergeUnique(
  existing: string[],
  additions: string[],
  upper: boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...existing, ...additions]) {
    const value = upper ? raw.trim().toUpperCase() : raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// Drop any entries of `list` that match `toRemove` case-insensitively.
function removeItems(list: string[], toRemove: string[]): string[] {
  if (toRemove.length === 0) return list;
  const drop = new Set(toRemove.map((s) => s.trim().toLowerCase()));
  return list.filter((item) => !drop.has(item.toLowerCase()));
}

// Resolve one list against its update ops: `replace` (if non-null) wins, else
// add-then-remove. Replacement values are deduped the same way as merges.
function resolveList(
  existing: string[],
  add: string[],
  remove: string[],
  replace: string[] | null,
  upper: boolean,
): string[] {
  if (replace !== null) return mergeUnique([], replace, upper);
  return removeItems(mergeUnique(existing, add, upper), remove);
}

// Apply an incremental update to the saved preferences. Unmentioned fields are
// preserved; `clearAll` resets everything to defaults.
function mergePreferences(
  current: UserPreferences,
  update: PreferenceUpdate,
): UserPreferences {
  if (update.clearAll) {
    return {
      trackedKeywords: [],
      watchlist: [],
      severityThreshold: DEFAULT_PREFERENCES.severityThreshold,
      sourceTrustThreshold: DEFAULT_PREFERENCES.sourceTrustThreshold,
    };
  }
  return {
    trackedKeywords: resolveList(
      current.trackedKeywords,
      update.addKeywords,
      update.removeKeywords,
      update.replaceKeywords,
      false,
    ),
    watchlist: resolveList(
      current.watchlist ?? [],
      update.addTickers,
      update.removeTickers,
      update.replaceTickers,
      true,
    ),
    severityThreshold: update.severityThreshold ?? current.severityThreshold,
    sourceTrustThreshold:
      update.sourceTrustThreshold ?? current.sourceTrustThreshold,
  };
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
  // Default an unscored source to low-ish trust so an absent/garbled rating
  // doesn't masquerade as credible when a user has set a trust threshold.
  let sourceTrust =
    typeof obj.source_trust === "number" ? obj.source_trust : 0.3;
  if (!Number.isFinite(sentiment)) sentiment = 0.5;
  if (!Number.isFinite(severity)) severity = 0.5;
  if (!Number.isFinite(sourceTrust)) sourceTrust = 0.3;
  sentiment = Math.max(0, Math.min(1, sentiment));
  severity = Math.max(0, Math.min(1, severity));
  sourceTrust = Math.max(0, Math.min(1, sourceTrust));

  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : "";

  return { sentiment, severity, summary, sourceTrust };
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
  // Watchlist tickers act as additional match terms alongside macro keywords,
  // so news about a watched stock triggers an alert even if no keyword matches.
  const matchTerms = [...prefs.trackedKeywords, ...(prefs.watchlist ?? [])];
  if (!matchesUserKeywords(headline, matchTerms)) return false;
  if (analysis.severity < prefs.severityThreshold) return false;
  // Suppress headlines from sources the user deems insufficiently trustworthy.
  // Threshold 0 (the default) lets everything through regardless of source.
  return analysis.sourceTrust >= prefs.sourceTrustThreshold;
}

function formatSentimentLabel(sentiment: number): string {
  if (sentiment >= 0.65) return "bullish";
  if (sentiment <= 0.35) return "bearish";
  return "neutral";
}

function formatTrustLabel(trust: number): string {
  if (trust >= 0.7) return "high";
  if (trust >= 0.4) return "medium";
  return "low";
}

function formatSeverityThresholdLine(threshold: number): string {
  return (
    `Severity threshold: ${threshold}\n` +
    `Alerts when a matching headline's Severity score is ≥ ${threshold} ` +
    `(same "Severity" on each alert; not bullish/bearish Direction). Lower = more alerts.`
  );
}

function pruneAlertHistory(spaceId: string): AlertContext[] {
  const history = alertHistoryBySpace.get(spaceId) ?? [];
  const now = Date.now();
  const fresh = history.filter((ctx) => now - ctx.sentAt <= ALERT_CONTEXT_TTL_MS);
  if (fresh.length !== history.length) {
    alertHistoryBySpace.set(spaceId, fresh);
  }
  return fresh;
}

// Return the most recent non-expired alert (used for text-heuristic follow-ups).
function getRecentAlertContext(spaceId: string): AlertContext | null {
  return pruneAlertHistory(spaceId)[0] ?? null;
}

// Return the specific alert a thread reply is targeting, or null if it doesn't
// match any of our stored alerts or has expired.
function getAlertContextForThread(
  spaceId: string,
  targetMessageId: string,
): AlertContext | null {
  const fresh = pruneAlertHistory(spaceId);
  return fresh.find((ctx) => ctx.alertMessageId === targetMessageId) ?? null;
}

function rememberAlertContext(
  spaceId: string,
  headline: string,
  source: string,
  analysis: HeadlineAnalysis,
  alertMessageId?: string,
): void {
  const ctx: AlertContext = {
    headline,
    source,
    analysis,
    sentAt: Date.now(),
    alertMessageId,
  };
  const history = alertHistoryBySpace.get(spaceId) ?? [];
  history.unshift(ctx); // newest first
  if (history.length > ALERT_HISTORY_MAX) history.length = ALERT_HISTORY_MAX;
  alertHistoryBySpace.set(spaceId, history);
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
    /\bonly (alert|notify|watch|track)\b/,
    /\bstop alerting\b/,
    /\bstop watching\b/,
    /\buntrack\b/,
    /\bremove\b/,
    /\bwatchlist\b/,
    /\bno longer\b/,
    /\bunsubscribe\b/,
    /\breputable\b/,
    /\btrust(ed|worthy)\b/,
  ];
  return patterns.some((p) => p.test(t));
}

// Returns the list of recent unexpired alerts if the message looks like a
// follow-up question, or an empty array if it should be handled as a
// preference update / unrecognised message.
function getFollowUpAlerts(text: string, spaceId: string): AlertContext[] {
  const history = pruneAlertHistory(spaceId);
  if (history.length === 0) return [];
  if (looksLikePreferenceUpdate(text)) return [];
  if (!looksLikeAlertFollowUp(text)) return [];
  return history;
}

function formatAlertContextForLlm(ctx: AlertContext, index?: number): string {
  const sentimentLabel = formatSentimentLabel(ctx.analysis.sentiment);
  const trustLabel = formatTrustLabel(ctx.analysis.sourceTrust);
  const prefix = index !== undefined ? `Alert ${index + 1}:\n` : "";
  const lines = [
    `${prefix}Headline: ${ctx.headline}`,
    `Source: ${ctx.source || "unknown"} (trust ${trustLabel}, ${ctx.analysis.sourceTrust.toFixed(2)})`,
    `Severity: ${ctx.analysis.severity.toFixed(2)}`,
    `Direction: ${sentimentLabel} (${ctx.analysis.sentiment.toFixed(2)})`,
  ];
  if (ctx.analysis.summary) {
    lines.push(`Summary: ${ctx.analysis.summary}`);
  }
  return lines.join("\n");
}

// Answer a follow-up question about one or more recent alerts. When multiple
// alerts are passed the LLM infers which one(s) the question is about.
async function answerAlertFollowUp(
  question: string,
  alerts: AlertContext[],
): Promise<string> {
  const multiAlert = alerts.length > 1;

  const system = multiAlert
    ? "You are a macro trading analyst helping a user understand their recent news alerts. " +
      "The user has several recent alerts listed below (newest first). " +
      "Read their question and answer it, drawing on whichever alert is most relevant. " +
      "If the question clearly references a specific alert (by topic, ticker, or wording), answer about that one. " +
      "If it's ambiguous, answer about the most relevant alert and briefly note which one you're addressing. " +
      "Answer clearly in plain text for iMessage (no JSON, no markdown). " +
      "Be specific about market implications. Keep under ~400 words unless asked for a full report summary."
    : "You are a macro trading analyst helping a user understand a news alert they received. " +
      "Use the alert context below. Answer clearly in plain text for iMessage (no JSON, no markdown code fences). " +
      "Be specific about market implications when relevant. Keep under ~400 words unless they asked for a full report summary.";

  const alertsText = multiAlert
    ? alerts.map((ctx, i) => formatAlertContextForLlm(ctx, i)).join("\n\n")
    : formatAlertContextForLlm(alerts[0]!);

  const user =
    `${multiAlert ? "Recent alerts" : "Alert context"}:\n${alertsText}\n\n` +
    `User follow-up: ${question}`;

  return grokChatCompletion(system, user, "Alert follow-up");
}

function formatAlertMessage(
  headline: string,
  source: string,
  analysis: HeadlineAnalysis,
): string {
  const sentimentLabel = formatSentimentLabel(analysis.sentiment);
  const trustLabel = formatTrustLabel(analysis.sourceTrust);
  const lines = [
    "Macro alert",
    headline,
    `Source: ${source || "unknown"} · trust ${trustLabel} (${analysis.sourceTrust.toFixed(2)})`,
    `Severity: ${analysis.severity.toFixed(2)} | Direction: ${sentimentLabel} (${analysis.sentiment.toFixed(2)})`,
  ];
  if (analysis.summary) {
    lines.push(analysis.summary);
  }
  return lines.join("\n");
}

async function analyzeHeadlineWithLlm(
  headline: string,
  source: string,
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
    "severity (number 0..1, market-moving importance), summary (short string), " +
    "source_trust (number 0..1, how trustworthy the PUBLISHER is). " +
    "Judge source_trust by the publisher's reputation for accurate financial reporting: " +
    "established wire services and major outlets (e.g. Reuters, Bloomberg, AP, WSJ, Financial Times) ~0.85-1.0; " +
    "mainstream financial media (e.g. CNBC, MarketWatch, Yahoo Finance) ~0.6-0.8; " +
    "press-release wires, aggregators, and opinion/blog sites (e.g. PRNewswire, GlobeNewswire, Seeking Alpha, StockTwits) ~0.2-0.4; " +
    "an unknown, missing, or unrecognized source ~0.3. " +
    "Be conservative: severity should reflect likely market impact, not drama.";

  const user = `Source: ${source || "unknown"}\nHeadline: ${headline}`;

  try {
    const content = await grokChatCompletion(system, user, "Headline analysis");
    const jsonText = stripJsonCodeFences(content);
    const parsed = JSON.parse(jsonText) as unknown;
    return normalizeHeadlineAnalysis(parsed);
  } catch (err) {
    console.error("ts_agent: headline analysis failed:", err);
    return null;
  }
}

const SEND_MAX_ATTEMPTS = 3;
const SEND_RETRY_BASE_MS = 600;

// Photon's outbound gRPC (SendTextMessage) intermittently returns
// UNAVAILABLE / "Stream refused by server" (gRPC code 14) — a transient
// server-side condition that typically succeeds on a quick retry. Detect those
// and retry with linear backoff; let anything else fail fast.
function isTransientSendError(err: unknown): boolean {
  const e = err as {
    grpcCode?: number;
    message?: string;
    cause?: { code?: number };
  };
  if (e?.grpcCode === 14 || e?.cause?.code === 14) return true;
  const msg = (e?.message ?? "").toLowerCase();
  return msg.includes("stream refused") || msg.includes("unavailable");
}

async function sendWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientSendError(err) || attempt === SEND_MAX_ATTEMPTS) break;
      const delay = SEND_RETRY_BASE_MS * attempt;
      console.warn(
        `ts_agent: ${label} send failed (attempt ${attempt}/${SEND_MAX_ATTEMPTS}, ` +
          `transient) — retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

async function dispatchHeadlineAlerts(
  app: Awaited<ReturnType<typeof Spectrum>>,
  headline: string,
  source: string,
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

    const alert = formatAlertMessage(headline, source, analysis);
    try {
      const sent = await spaceOutbound.run(spaceId, "alert", async () => {
        const prefs = userPreferences.get(spaceId);
        if (!prefs || !shouldAlertUser(headline, analysis, prefs)) return false;

        const outMsg = await sendWithRetry("alert", () => app.send(space, alert));
        rememberAlertContext(spaceId, headline, source, analysis, outMsg?.id);
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
    const source =
      typeof parsed.source === "string" ? parsed.source.trim() : "";

    const dedupeKey = parsed.ts
      ? `ts:${parsed.ts}:${headline}`
      : `headline:${headline}`;
    if (!tryStartProcessingHeadline(dedupeKey)) continue;

    console.log(`[ZMQ] headline: ${headline} [source: ${source || "unknown"}]`);

    try {
      if (userPreferences.size === 0) {
        console.log("[ZMQ] no user preferences yet — skipping alerts");
        continue;
      }

      const analysis = await analyzeHeadlineWithLlm(headline, source);
      if (!analysis) continue;

      await dispatchHeadlineAlerts(app, headline, source, analysis);
    } finally {
      finishProcessingHeadline(dedupeKey);
    }
  }
}

// Extract an *incremental* update from one message. The result is merged into
// the user's saved prefs by mergePreferences — we never return a full state, so
// a message that omits a field can't wipe it. On any failure we return a no-op
// update (which merges to "no change") rather than defaults.
async function extractPreferenceUpdate(
  userText: string,
): Promise<PreferenceUpdate> {
  if (!process.env.XAI_API_KEY) {
    console.warn(
      "ts_agent: XAI_API_KEY is not set (or is empty) — no preference change.",
    );
    return { ...NOOP_PREFERENCE_UPDATE };
  }

  const system =
    "You read ONE chat message and translate it into an incremental change to the " +
    "user's macro trading alert settings (tracked macro keywords, a watchlist of stock " +
    "tickers, a minimum market-impact threshold, and a minimum source-trust threshold). Report ONLY " +
    "what THIS message asks for; never restate prior settings.\n" +
    "Return ONLY valid JSON with these keys:\n" +
    "  addKeywords (string[]): macro/news triggers to ADD (e.g. CPI, FOMC, rates, Powell, inflation).\n" +
    "  removeKeywords (string[]): keywords to REMOVE (user says stop/drop/untrack/no longer).\n" +
    "  replaceKeywords (string[] or null): set keywords to EXACTLY this list (user says 'only track …'); else null.\n" +
    "  addTickers (string[]): stock tickers to ADD, uppercased (e.g. AAPL, TSLA, NVDA).\n" +
    "  removeTickers (string[]): tickers to REMOVE (user says stop watching/remove/drop).\n" +
    "  replaceTickers (string[] or null): set watchlist to EXACTLY this list (user says 'only watch …'); else null.\n" +
    "  severityThreshold (number 0..1 or null): set ONLY if the user specifies how big news must be to alert " +
    "(compared against Grok's market-impact score on each headline; lower = more alerts, higher = only big news). " +
    "Phrases like 'threshold 0.5' or 'only big alerts' map here. NOT bullish/bearish sentiment. else null.\n" +
    "  sourceTrustThreshold (number 0..1 or null): set ONLY if the user wants to filter by how trustworthy the news SOURCE is " +
    "(higher = stricter, only more credible publishers). Map phrasing to a number: " +
    "'only high-trust/reputable sources' -> ~0.7, 'trusted sources only' -> ~0.6, 'skip blogs/tabloids/PR wires' -> ~0.5, " +
    "'any source is fine' / 'stop filtering sources' -> 0; else null.\n" +
    "  clearAll (boolean): true ONLY if the user wants to reset/clear ALL settings.\n" +
    "Rules: do not invent tickers — only ones the user names. Use add/remove for incremental changes; " +
    "use replace* only for 'only/just/set to' phrasing; an empty replace* array clears just that list. " +
    "Default everything to empty arrays / null / false when the message doesn't mention it.\n" +
    'Examples:\n' +
    '  "watch GOOGL and AMZN, threshold 0.3" -> {"addKeywords":[],"removeKeywords":[],"replaceKeywords":null,"addTickers":["GOOGL","AMZN"],"removeTickers":[],"replaceTickers":null,"severityThreshold":0.3,"sourceTrustThreshold":null,"clearAll":false}\n' +
    '  "stop watching GOOGL" -> {"addKeywords":[],"removeKeywords":[],"replaceKeywords":null,"addTickers":[],"removeTickers":["GOOGL"],"replaceTickers":null,"severityThreshold":null,"sourceTrustThreshold":null,"clearAll":false}\n' +
    '  "untrack CPI" -> {"addKeywords":[],"removeKeywords":["CPI"],"replaceKeywords":null,"addTickers":[],"removeTickers":[],"replaceTickers":null,"severityThreshold":null,"sourceTrustThreshold":null,"clearAll":false}\n' +
    '  "only watch TSLA" -> {"addKeywords":[],"removeKeywords":[],"replaceKeywords":null,"addTickers":[],"removeTickers":[],"replaceTickers":["TSLA"],"severityThreshold":null,"sourceTrustThreshold":null,"clearAll":false}\n' +
    '  "only alert me from reputable sources" -> {"addKeywords":[],"removeKeywords":[],"replaceKeywords":null,"addTickers":[],"removeTickers":[],"replaceTickers":null,"severityThreshold":null,"sourceTrustThreshold":0.7,"clearAll":false}\n' +
    '  "clear my watchlist" -> {"addKeywords":[],"removeKeywords":[],"replaceKeywords":null,"addTickers":[],"removeTickers":[],"replaceTickers":[],"severityThreshold":null,"sourceTrustThreshold":null,"clearAll":false}\n' +
    '  "reset everything" -> {"addKeywords":[],"removeKeywords":[],"replaceKeywords":null,"addTickers":[],"removeTickers":[],"replaceTickers":null,"severityThreshold":null,"sourceTrustThreshold":null,"clearAll":true}';

  let content: string;
  try {
    content = await grokChatCompletion(system, userText, "LLM extraction");
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  const jsonText = stripJsonCodeFences(content);
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return normalizePreferenceUpdate(parsed);
  } catch (err) {
    console.warn(
      "ts_agent: Failed to parse LLM JSON — leaving preferences unchanged.",
      err,
    );
    return { ...NOOP_PREFERENCE_UPDATE };
  }
}

// Union of every user's tracked keywords + watchlist tickers, deduped
// case-insensitively and sorted (stable order lets the engine cheaply detect
// "no change"). This is exactly the set of terms the engine needs to forward.
function computeFilterTerms(): string[] {
  const bySeen = new Map<string, string>(); // lowercase -> first-seen casing
  for (const prefs of userPreferences.values()) {
    const terms = [...prefs.trackedKeywords, ...(prefs.watchlist ?? [])];
    for (const raw of terms) {
      const term = raw.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (!bySeen.has(key)) bySeen.set(key, term);
    }
  }
  return Array.from(bySeen.values()).sort((a, b) => a.localeCompare(b));
}

async function publishFilterSet(): Promise<void> {
  if (!filterPublisher) return;
  const terms = computeFilterTerms();
  const payload = JSON.stringify({ type: "filterset", terms });
  const changed = payload !== lastPublishedFilterSet;
  lastPublishedFilterSet = payload;
  try {
    // Always send (heartbeat lets a reconnecting engine catch up); only log on
    // an actual change so the heartbeat stays quiet.
    await filterPublisher.send(payload);
    if (changed) {
      console.log(
        `[filter] pushed ${terms.length} term(s) to engine: ` +
          (terms.length ? terms.join(", ") : "(empty — engine uses defaults)"),
      );
    }
  } catch (err) {
    console.error("[filter] failed to publish filter set:", err);
  }
}

async function startFilterPublisher(): Promise<void> {
  const endpoint = process.env.FILTER_ENDPOINT ?? "tcp://127.0.0.1:5556";
  try {
    const pub = new Publisher();
    await pub.bind(endpoint);
    filterPublisher = pub;
    console.log(`ts_agent: filter publisher bound on ${endpoint}`);
  } catch (err) {
    console.error(
      `ts_agent: failed to bind filter publisher on ${endpoint} — ` +
        "engine will fall back to its built-in macro filter.",
      err,
    );
    return;
  }

  await publishFilterSet();
  setInterval(() => {
    void publishFilterSet();
  }, FILTER_HEARTBEAT_MS);
}

async function logImessageRoutingHint(
  projectId: string,
  projectSecret: string,
): Promise<void> {
  try {
    const tokens = await cloud.issueImessageTokens(projectId, projectSecret);
    if (tokens.type === "dedicated") {
      const numbers = tokens.numbers ?? {};
      const entries = Object.entries(numbers);
      if (entries.length === 0) {
        console.log(
          "ts_agent: iMessage dedicated mode — no line numbers provisioned yet. " +
            "Finish line setup in the Photon dashboard, then text that number (blue bubble).",
        );
      } else {
        console.log("ts_agent: iMessage dedicated mode — text this agent at:");
        for (const [instanceId, phone] of entries) {
          console.log(
            `  • ${phone ?? "(not provisioned — null)"}  [instance ${instanceId}]`,
          );
        }
      }
      return;
    }

    console.log(
      "ts_agent: iMessage SHARED mode — text the shared Photon number shown in your " +
        "Photon dashboard (not necessarily a named “Line” in the UI unless that line is " +
        "linked to this project).\n" +
        "  Your sending phone must be linked to THIS project in the dashboard, or inbound " +
        "texts never reach the agent (no [iMessage] logs). Run: npm run info",
    );
  } catch (err) {
    console.warn(
      "ts_agent: could not fetch iMessage routing info (check PROJECT_ID / PROJECT_SECRET):",
      err,
    );
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
  await logImessageRoutingHint(projectId, projectSecret);

  void startFilterPublisher().catch((err) => {
    console.error("ts_agent: filter publisher failed to start:", err);
  });

  void runZmqHeadlineSubscriber(app).catch((err) => {
    console.error("ts_agent: ZeroMQ subscriber exited:", err);
  });

  for await (const [space, message] of app.messages) {
    // Diagnostic: log every inbound event so a non-iMessage / non-text message
    // (e.g. a green-bubble SMS, typing indicator, reaction) is visible instead
    // of being dropped silently.
    console.log(
      `[iMessage] inbound event platform=${String(message.platform)} ` +
        `contentType=${String(message.content?.type)} space=${space.id}`,
    );
    if (message.platform !== "iMessage") {
      console.log(
        `[iMessage] skipped: platform is '${String(message.platform)}', not 'iMessage'`,
      );
      continue;
    }
    if (message.content.type !== "text" && message.content.type !== "reply") {
      console.log(
        `[iMessage] skipped: content type is '${String(message.content.type)}', not 'text' or 'reply'`,
      );
      continue;
    }

    // For thread replies extract the inner text and the id of the replied-to message.
    let text: string;
    let replyToMessageId: string | null = null;

    if (message.content.type === "reply") {
      const replyContent = message.content as unknown as {
        type: "reply";
        content: { type: string; text?: string };
        target: { id: string };
      };
      const inner = replyContent.content;
      if (inner.type !== "text" || !inner.text?.trim()) {
        console.log("[iMessage] skipped: reply inner content is not text");
        continue;
      }
      text = inner.text;
      replyToMessageId = replyContent.target.id;
    } else {
      text = message.content.text;
    }

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

        // Build the list of alert contexts relevant to this message.
        //
        // Best-case: the message is a Spectrum-level thread reply (content.type
        // === "reply") targeting one of our alert messages — use just that alert.
        //
        // For iMessage the platform provider does NOT expose the thread originator
        // GUID on plain inbound text messages, so long-press → Reply arrives here
        // as a regular text message. In that case we fall back to the keyword
        // heuristic and pass ALL recent unexpired alerts to the LLM so it can
        // infer which one the question is about from the text alone.
        //
        // Thread reply to a non-alert message → empty list → handled as
        // preference update.
        let followUpAlerts: AlertContext[] = [];
        if (replyToMessageId !== null) {
          const matched = getAlertContextForThread(spaceId, replyToMessageId);
          if (matched) followUpAlerts = [matched];
          // No match → user replied to a non-alert message; treat as preference update.
        } else {
          followUpAlerts = getFollowUpAlerts(text, spaceId);
        }

        const isAlertFollowUp = followUpAlerts.length > 0;

        try {
          if (isAlertFollowUp) {
            if (!process.env.XAI_API_KEY) {
              await message.reply(
                "I need an API key configured to answer follow-up questions.",
              );
              return;
            }

            const followUpSource = replyToMessageId ? "thread reply" : "heuristic";
            console.log(
              `[iMessage] alert follow-up (${followUpSource}, ${followUpAlerts.length} alert(s)) space=${spaceId}: ${text}`,
            );
            const answer = await answerAlertFollowUp(text, followUpAlerts);
            await sendWithRetry("alert follow-up reply", () =>
              message.reply(answer),
            );
            return;
          }

          // Treat the message as an incremental update: merge into existing
          // prefs (or defaults for a new chat) so unmentioned fields are kept.
          const current = userPreferences.get(spaceId) ?? DEFAULT_PREFERENCES;
          const update = await extractPreferenceUpdate(text);
          const prefs = mergePreferences(current, update);
          userPreferences.set(spaceId, prefs);
          // Preferences changed — push the new union to the engine so it starts
          // forwarding headlines for any newly tracked keywords / watchlist.
          void publishFilterSet();

          const keywordsPretty = prefs.trackedKeywords.length
            ? prefs.trackedKeywords.join(", ")
            : "(none)";
          const watchlistPretty = prefs.watchlist?.length
            ? prefs.watchlist.join(", ")
            : "(none)";
          const sourceTrustPretty =
            prefs.sourceTrustThreshold > 0
              ? `min ${prefs.sourceTrustThreshold} (${formatTrustLabel(prefs.sourceTrustThreshold)}+)`
              : "any source";
          const confirmation =
            `Got it — saved your macro preferences for this chat.\n` +
            `Tracked keywords: ${keywordsPretty}\n` +
            `Watchlist: ${watchlistPretty}\n` +
            `${formatSeverityThresholdLine(prefs.severityThreshold)}\n` +
            `Source trust: ${sourceTrustPretty}`;
          // The update is already saved above; if the confirmation can't be
          // delivered (even after retries) just log it — don't fall through to
          // the catch's "couldn't update" message, which would be inaccurate.
          try {
            await sendWithRetry("preference confirmation", () =>
              space.send(confirmation),
            );
          } catch (sendErr) {
            console.error(
              `[iMessage] preferences saved for space=${spaceId} but confirmation ` +
                `delivery failed:`,
              sendErr,
            );
          }
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
