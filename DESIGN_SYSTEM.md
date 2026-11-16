# DESIGN_SYSTEM.md — Rhteaster Ops Deck (`rhteaster`)

---

## 1. Project Overview
- **Product Name:** Rhteaster Ops Deck (`rhteaster` v2.1)
- **Surface Profile:** Dashboard / Admin (`B2`)
- **Audience:** Non-technical ("awam") VPS clients operating their own WhatsApp AI Agent + Antigravity CLI (`agy`) on a single Ubuntu/Debian VPS.
- **Core Concept:** Single-VPS operational cockpit combining one-click browser WhatsApp 8-digit pairing, live server instrumentation, AI model & quota rotation matrix, PM2 logs, and an n8n-style live Task Execution Map (`/task-map`).

## 2. Color System (OKLCH Stepped Graphite + Operator Amber)
All tokens live at `:root` inside `dashboard/public/deck.css`.
- **Dominant Surfaces (60%):** `--bg` (`oklch(15.5% 0.008 250)`), `--well` (`oklch(12.5% 0.007 250)`).
- **Elevated Cards & Controls (30%):** `--surface` (`oklch(20% 0.009 250)`), `--surface-raised` (`oklch(24.5% 0.011 250)`).
- **Primary Signal & Accent (10%):** `--accent` (`oklch(82% 0.15 78)`), `--accent-ink` (`oklch(20% 0.05 70)`).
- **Instrument & Status Signals:** `--cool` (`oklch(78% 0.11 240)`), `--ok` (`oklch(77% 0.15 152)`), `--warn` (`oklch(80% 0.15 70)`), `--bad` (`oklch(71% 0.17 25)`).
- **Zero Slop Rules Enforced:** No purple-pink gradients, no blurry decorative neon orbs, no emojis in dashboard chrome/buttons/headers (uniform inline SVG `<symbol>` sprite only), strict WCAG AA/AAA text contrast.

## 3. Typography & Layout
- **Fonts:** `Space Grotesk` (headings), `Plus Jakarta Sans` (body), `JetBrains Mono` (`tabular-nums slashed-zero` for metrics, timestamps, pairing codes, and logs).
- **Responsive Breakpoints:**
  - `> 1180px`: 12-column CSS grid (`Verdict` -> `WA Pairing / Server VPS / Model & Rotation` -> `Telemetry Canvas + Reset Queue` -> `Quota Matrix` -> `Processes + Logs` -> `Live Tasks`).
  - `<= 860px`: Quota matrix transforms into stacked 2×2 mobile cards (`data-label`).
  - `<= 760px`: Single-column layout down to `375px`, 44px+ touch targets, mobile search toggle, and fixed 5-item bottom navigation dock (`.dock`).
  - `prefers-reduced-motion: reduce`: Disables all keyframe pulses, flow animations, and transitions.

## 4. Security Boundaries
- Optional `dashboardPin` protects `/api/*` and UI views using timing-safe comparison (`crypto.timingSafeEqual`) + HMAC-SHA256 signed `HttpOnly; SameSite=Lax` cookie.
- Dashboard-to-Bot control bridge listens exclusively on `127.0.0.1`.
- Process restarts accept only an explicit allowlist (`wa-bot`, `agent-dashboard`); log reads strip non-identifier characters.
