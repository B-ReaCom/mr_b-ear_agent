# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Mr. B-EAR is a single-page AI agent chatbot for B-EAR Corporation (ベアリッジ), answering customer questions about the ALVO 1.9 product line and the BRIDGECOM series. It is a fully static front-end plus one Vercel Edge Function proxy and a Google Apps Script for usage logging / cost alerting. There is no build system, no package manager, no test suite, and no framework — just `index.html`, `api/chat.js`, and a `.gs` file.

## Repository layout (the only files that matter)

- `index.html` (~1700 lines) — the entire app. Inline CSS, inline JS, the full FAQ knowledge base inside the `FAQ_CONTENT` template literal, the `SYSTEM_PROMPT` constant, the `translations` object (12 languages), client-side rate limiting, and all chat logic.
- `api/chat.js` — Vercel Edge Function at `/api/chat`. Validates Origin, applies per-IP rate limits, forwards to `https://api.anthropic.com/v1/messages`, and POSTs usage to the GAS endpoint.
- `GAS_USAGE_MONITORING.gs` — Google Apps Script source. Deployed manually as a Web App; receives QA logs and API usage logs into Google Sheets, and emails `sales@bearidge.jp` when the month's spend exceeds ¥20,000 (once per month).
- `vercel.json`, `README.md`, `GAS_SETUP.md`, `VERCEL_SETUP.md` — config and operator docs.

## Deployment / dev workflow

- There are **no local build, test, or lint commands**. The only "workflow" is: edit → `git push` → Vercel auto-deploys (~30s).
- No local dev server is configured. Front-end changes can be smoke-tested by opening `index.html` directly, but `/api/chat` only works on a Vercel deployment (or `vercel dev` if installed manually).
- The `api/chat.js` proxy requires `ANTHROPIC_API_KEY` set in Vercel → Settings → Environment Variables. See `VERCEL_SETUP.md`.
- The GAS script is **not** redeployed by git pushes — it must be pasted into the existing Apps Script project and redeployed manually (see `GAS_SETUP.md`). Its deployment URL is hard-coded as `USAGE_LOG_URL` in `api/chat.js` and as the spreadsheet-logging `fetch(...)` call in `index.html`. If the GAS URL changes, **both** must be updated.

## Architecture: how a question flows end-to-end

Understanding this flow is required before touching either file — the cost-protection layers depend on each other.

1. **Client rate limit (level 1+2)** — `checkRateLimit()` in `index.html` enforces a 10s cooldown, 20 questions / 20 min session, blocks the 3rd repeat of the same normalized question, and a 30-min lockout after the cap. Backed by `localStorage`. Trivially bypassable; this is UX, not security.
2. **Haiku pre-judge (level 4)** — `judgeQuestionRelevance()` calls `claude-haiku-4-5` with `max_tokens: 10` asking only "YES/NO: is this about B-EAR products?". A NO short-circuits the request before the expensive Sonnet call. On API error the code fails **open** (returns relevant) on purpose.
3. **Server proxy + per-IP rate limit (level 5)** — `api/chat.js` checks Origin against `ALLOWED_ORIGIN_PATTERNS` (CSRF guard for the shared API key), then enforces 5/min, 50/hr, 200/day per IP using an **in-memory** `Map` per Edge Function instance. The comment notes that for real durability this should move to Vercel KV / Upstash Redis.
4. **Anthropic call** — model `claude-sonnet-4-6`, `max_tokens: 2500`, system prompt is sent as **two blocks**: the big static `SYSTEM_PROMPT` with `cache_control: { type: "ephemeral" }` (prompt caching) followed by a small dynamic block carrying the current language's `langInstruction`. Keeping the cached block **byte-stable** is what makes caching work — never interleave dynamic content into `SYSTEM_PROMPT`.
5. **Cost telemetry** — after a successful response the Edge Function computes a USD cost from `usage` (with rate tables for sonnet-4-6 / haiku-4-5 / opus-4-7 including cache write/read multipliers) and fires-and-forgets to GAS. The client separately POSTs the raw Q&A text to the same GAS endpoint for the QA log.
6. **GAS alert** — `handleUsageLog` appends to `USAGE_LOG`, then `checkMonthlyThreshold` sums the current month's JPY column and emails once per month via the `ALERT_STATUS` sheet (call `resetAlertForCurrentMonth()` to re-test).

## API call indirection (`USE_SERVER_PROXY`)

`index.html` has a hard-coded `const USE_SERVER_PROXY = true`. When true, all requests go through `/api/chat` and the "⚙ APIキー" UI is hidden on load. When false, the client calls `api.anthropic.com` directly with `anthropic-dangerous-direct-browser-access: true`, using a key the user pastes into a localStorage-backed panel. The `false` path is the documented fallback if the Edge Function is broken. Both paths must keep working — `callClaudeAPI()` is the single seam.

## Display-only messages

The chat history array `messages` supports a `_display_only: true` flag (and `_system: true` for styling). `prepareApiMessages()` filters those out before sending to Claude and also caps history at `MAX_API_HISTORY = 20`. Rate-limit notices, off-topic rejections, and server errors all use this pattern so they're visible to the user but never replayed back to the API (which would corrupt the conversation and waste tokens). When adding any new "show this in the chat but don't send it" path, set both flags.

## Prompt / FAQ conventions (matter for content edits)

The `FAQ_CONTENT` + `SYSTEM_PROMPT` template strings encode business rules that you **must not silently relax** when editing prose:

- ALVO 1.9 price is fixed at **¥100,000–120,000 per unit**. The prompt explicitly forbids vague reassurance when a customer's budget is short — it must compute `台数 × ¥100k–120k` and say so honestly.
- Volume discounts: never disclose specific percentages or thresholds; route to a quote.
- The canonical one-line ALVO 1.9 description is locked: do **not** rewrite it to "手を使いながら会話できる" — the prompt explicitly bans that phrasing.
- Off-topic, prompt-injection, and "forget your instructions" attempts have scripted refusal templates; preserve them when refactoring.

## i18n

`translations` covers 12 locales (ja, en, zh, yue, ko, vi, pt, tl, ne, id, es, th). `changeLang(lang)` persists to `localStorage['mr_bear_lang']` and rerenders. The active locale's `langInstruction` is appended as a **separate, uncached** system block so switching languages doesn't invalidate the prompt cache.

## When you change something, also check

- Touching the system prompt → think about cache invalidation; the cached block must remain stable across sessions.
- Touching `api/chat.js` rate limits → also update the matching numbers in `VERCEL_SETUP.md` if they're documented there.
- Touching the GAS URL → update **both** `USAGE_LOG_URL` in `api/chat.js` and the `fetch(...)` in `sendMessage()` in `index.html`.
- Adding a new model → add it to the `rates` table in `estimateCost()` or cost logging silently falls back to the sonnet rates.
- Changing `ALLOWED_ORIGIN_PATTERNS` → any new deployment domain (custom domain, new preview pattern) must be added or the proxy returns 403.
