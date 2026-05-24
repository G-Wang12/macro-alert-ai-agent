# Onboarding, users, and going live

This document explains how people become users today, what they need to text,
how Photon Spectrum fits in, and when you need persistent storage. It is aimed
at hosting the product and pairing it with a marketing landing page in another
repo.

For what users can say after they are set up, see [`MESSAGING.md`](MESSAGING.md).
For runtime internals, see [`TECHNICAL.md`](TECHNICAL.md).

---

## The two different questions (this is the common confusion)

People often mix up **“can many users use it at the same time?”** and **“do we
need a database?”** They are separate:

| Question | Answer today | Needs a database? |
| --- | --- | --- |
| Can Alice and Bob both text the agent and get their own alerts? | **Yes** — each iMessage thread is a separate user in memory. | **No** (while the agent process is running) |
| Do Alice’s settings survive if we restart or redeploy the agent? | **No** — preferences live only in RAM until she texts again. | **Yes**, if you want settings (and “registered” state) to survive restarts |
| Can we run two agent servers behind a load balancer? | **Not cleanly** — each instance has its own memory; users would be split and confused. | **Yes**, for shared state |
| Does the landing page need to write users into a DB before they can text? | **No** — texting the number is enough to start using the product as built today. | Only if *you* want web signup, billing, or invite-only access |

**Short version:** persistent storage is **not** required for *concurrent*
multi-user chat. It **is** required for anything that must **outlive a single
process** (restarts, deploys, accounts, billing, invite lists, analytics tied
to identity).

---

## How Photon Spectrum works for this project

The agent (`ts_agent`) runs a **Spectrum server** that listens for inbound
iMessage events. When someone texts your line, Spectrum delivers a
`[space, message]` tuple to the agent:

- **`space`** — the conversation (thread). One-to-one chats get one `space.id`
  per person; that id is how we store preferences today.
- **`message.sender`** — who sent the text (Spectrum’s sender id for that
  person).

The agent does **not** implement a separate “sign up” API and does **not** send
“you need to register” replies. Spectrum is the front door: **only if Photon
delivers the text into `app.messages`** does your code run (preferences, Grok,
alerts).

If an unknown tester sees a registration message on iMessage, that is almost
certainly **Photon’s cloud gate** (sender not linked to your project in shared
mode), not `ts_agent`. Your console will show **no** `[iMessage] inbound event`
for those texts.

Photon’s [Spaces and Users](https://photon.codes/docs/spectrum-ts/spaces-and-users)
doc describes the **SDK model** (`space`, `user`, `space.send`, `im.user(phone)`)
for conversations your **code** creates or replies in. It does **not** define
end-user “registration” on the platform — that lives in Photon’s **iMessage line /
plan** setup; see [iMessage provider → Line model](https://photon.codes/docs/spectrum-ts/providers/imessage#line-model).

### Shared pool vs dedicated line (Photon plan)

From Photon’s [iMessage provider docs](https://photon.codes/docs/spectrum-ts/providers/imessage#line-model):

| Photon plan | Line model | What end users see |
| --- | --- | --- |
| Free / Pro | **Shared pool** — routing may use different pool numbers per recipient | iMessage from a number that can differ; senders often must be **linked** to your project in the dashboard |
| Business | **Dedicated** — one number for your project | Everyone texts the **same** agent number |

Run `cd ts_agent && npm run build && npm run info` to see what **your** project
token reports (`dedicated` vs shared). Startup also prints a hint when shared.

| Token / mode | What users text | What you configure |
| --- | --- | --- |
| **Dedicated** | Your project’s phone number(s) from `npm run info` | Provision the line in the Photon dashboard; strangers can DM that number without per-phone linking in our repo |
| **Shared** | The shared Photon number (dashboard) | **Link each tester’s sending phone** to this project, or Photon blocks them (auto-reply / no agent logs) |

Put the number users should text on your landing page. On **Business /
dedicated**, that is your stable agent line. On **Free/Pro / shared**, also
document that testers must complete Photon’s sender linking (or upgrade plan).

### Blue bubble only

The agent only processes **`platform === "iMessage"`** and **text** messages.
Green-bubble SMS or non-text events are logged and skipped. Users need an Apple
device (or Mac) with iMessage to talk to the agent.

---

## Can anyone register by texting? What do they say?

### Two layers: Photon gate vs your agent

| Layer | Who controls it | Unknown phone texts your line |
| --- | --- | --- |
| **Photon (iMessage cloud)** | Dashboard linking (shared) or dedicated line (Business) | May get “need to register” / no delivery to agent |
| **`ts_agent` (this repo)** | No allowlist in code | Once `[iMessage]` logs appear, first text = user in memory |

There is **no allowlist**, **no invite code**, and **no required magic word**
in **this codebase**. Anyone whose message **reaches** `app.messages` can:

1. Become a “user” on first contact (their thread is stored in memory).
2. Have every subsequent text interpreted as a **preference update** (unless it
   looks like a follow-up to a recent alert — see [`MESSAGING.md`](MESSAGING.md)).

That is **self-service onboarding in the agent** — but only **after** Photon
routes the iMessage to you.

### What they need to say (nothing special)

They do **not** need to text `REGISTER` or `START`. Any normal preference
phrase works on the first message, for example:

- `Alert me on CPI and FOMC, threshold 0.5`
- `Watch TSLA and NVDA`
- `Only big alerts, threshold 0.8`

The agent replies with something like:

```text
Got it — saved your macro preferences for this chat.
Tracked keywords: CPI, FOMC
Watchlist: (none)
Severity threshold: 0.5
Alerts when a matching headline's Severity score is ≥ 0.5 (same "Severity" on each alert; not bullish/bearish Direction). Lower = more alerts.
Source trust: any source
```

From then on they are a user for that chat: proactive macro alerts can fire when
headlines match their settings (see below).

**Empty keywords + empty watchlist** means “match every headline” (subject to
thresholds). So even a vague first message like `hello` may still parse into
defaults and start matching broadly — worth knowing before you publish a public
number.

### What “registered” means in code today

On each inbound text the agent:

1. Caches the Spectrum `space` handle (`spacesById`) so it can **send** alerts
   later.
2. Merges extracted preferences into `userPreferences` keyed by **`space.id`**.

There is no separate `users` table and no check against a landing-page signup.

### Proactive alerts: one extra requirement

Headlines come from `cpp_engine` over ZeroMQ. For a user to **receive** proactive
alerts:

1. **`cpp_engine` must be running** and connected to the agent.
2. The user must have **messaged at least once since the agent last started** —
   so the agent has cached their `space` for outbound iMessage.
3. Their preferences must match an incoming headline (keywords/watchlist +
   severity + source trust).

If the agent restarts, preferences in memory are **gone** until they text again
(and the space cache is empty until they text again). After they text once,
settings are rebuilt from that message onward.

---

## End-to-end flow (landing page + hosted agent)

```text
  Landing page (other repo)
       │
       │  "Text +1 …… on iMessage to get macro alerts"
       ▼
  User's iPhone (iMessage, blue bubble)
       │
       ▼
  Photon Spectrum  ──►  ts_agent (hosted)
       │                      │
       │                      ├── saves prefs per space.id (RAM)
       │                      └── pushes filter union to cpp_engine (ZMQ)
       ▼
  cpp_engine (hosted)  ── headlines ──►  ts_agent  ── alerts ──►  user
```

Recommended copy for the landing page:

1. **CTA** — Text our iMessage number: `+1 …` (from `npm run info` or Photon
   dashboard).
2. **First message examples** — 2–3 lines from the table in
   [`MESSAGING.md`](MESSAGING.md) (e.g. CPI/FOMC + threshold, or a watchlist).
3. **Requirements** — iMessage (Apple device); not SMS/green bubble.
4. **What happens next** — They get a confirmation reply; macro alerts arrive
   when news matches their settings (may take a few seconds for watchlist sync —
   see README → Dynamic filter sync).

The landing page does **not** need to call this repo unless you add web signup
later.

---

## Hosting checklist

When you deploy (VPS, container, etc.), run **both** processes and keep **one**
agent instance (the agent uses a single-instance lock):

| Component | Role |
| --- | --- |
| `cpp_engine` | Polls/simulates headlines, filters, publishes to `ZMQ_ENDPOINT` |
| `ts_agent` | Spectrum + Grok + per-user routing + `FILTER_ENDPOINT` to engine |

Environment (minimum):

- **Spectrum:** `PROJECT_ID`, `PROJECT_SECRET`
- **Grok:** `XAI_API_KEY`
- **Live news (optional):** `FINNHUB_API_KEY` on `cpp_engine` for `--live`
- **ZMQ:** `ZMQ_ENDPOINT` / `FILTER_ENDPOINT` aligned between processes

Operational notes:

- **Restarts wipe in-memory users** — expect users to text again after deploy, or
  add persistence (below).
- **Public number = public product** — budget Grok/Finnhub for unsolicited texts
  unless you add gating.
- **One agent process** — do not run duplicate `npm start` (duplicate replies).

---

## When to add persistent storage

Add a database (or similar) when you need any of the following:

| Need | Why memory is not enough |
| --- | --- |
| Preferences survive deploys/restarts | Maps are empty after restart |
| “Registered” / opted-in flag | No durable record of who joined |
| Invite-only or paid access | Must check identity before accepting prefs |
| Landing page creates account first | Web stores phone/email; agent must match inbound sender |
| Support / billing / GDPR delete | Need stable `user_id` and audit trail |
| Horizontal scale (multiple agents) | Shared prefs + space routing |

A minimal schema later might look like:

- `users`: `id`, `sender_id` (Spectrum), `phone` (if available), `created_at`,
  `status` (`active` / `blocked`)
- `preferences`: `user_id`, JSON matching `UserPreferences` in `ts_agent`
- `spaces`: `user_id`, `space_id` (last known Spectrum thread)

Load on startup; upsert on each inbound message; still cache `spacesById` in
memory for outbound (Spectrum needs the live `Space` object).

**Phase 1 without a DB:** landing page + public number + examples in
[`MESSAGING.md`](MESSAGING.md) is valid for a demo or small beta if you accept
reset-on-restart and open registration.

---

## Product options you may want later (not implemented yet)

These are design choices for when open registration is too risky or UX needs a
clearer “join” step:

| Approach | User experience | Implementation sketch |
| --- | --- | --- |
| **Open (today)** | Text anything preference-like | No change |
| **Explicit opt-in** | First reply: “Text START to enable alerts” | Ignore preference parsing until `START` or store `opted_in` in DB |
| **Invite-only** | “You need an invite” | Allowlist `sender.id` in env or DB |
| **Web-first signup** | Enter phone on site, then text | DB pending row; first text links `sender.id` |
| **Welcome on first text** | Short onboarding before prefs | Detect new `space.id`; send welcome; optional second message for prefs |

Document any choice you ship in this file and in the landing page repo.

---

## Quick FAQ

**Do users need to say “register”?**  
No. First iMessage that reaches the line starts a user session for that thread.

**Is storage required for multiple users?**  
No for simultaneous use; yes if settings and identity must survive restarts or
you want signup/billing/invite control.

**Why did you say storage wasn’t needed before?**  
Meant: the *architecture already supports many chats at once* without adding a
database first. That is not the same as “never use a database for production.”

**Someone got “you need to register” — is that us?**  
Almost certainly **Photon**, not this repo (grep finds no such copy). Check
the agent terminal: no `[iMessage] inbound event` = Photon never delivered it.
Fix: link their sending number (shared) or use a **dedicated Business line**.

**What if someone texts but never sets keywords?**  
Defaults apply; empty keyword + empty watchlist can match all headlines (see
[`MESSAGING.md`](MESSAGING.md) → Defaults).

**Can the landing page register users without texting?**  
Not with the current agent. The landing page is marketing + instructions unless
you build a separate signup service and later teach the agent to honor it.

---

## Related docs

- [`MESSAGING.md`](MESSAGING.md) — what to text after onboarding
- [`README.md`](README.md) — build, run, test, dynamic filter sync
- [`TECHNICAL.md`](TECHNICAL.md) — Spectrum loop, in-memory maps, ZMQ channels
