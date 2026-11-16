# Security Policy

## Security Architecture

Rhteaster is designed for single-VPS self-hosting with clear privilege boundaries:

- **Localhost Control Bridge**: Bot control commands (`127.0.0.1:3847` by default) bind strictly to loopback and are not exposed directly to external interfaces.
- **Optional Dashboard PIN Authentication**: Setting `dashboardPin` in `config.json` (or `DASHBOARD_PIN`) protects `/api/*` endpoints and dashboard controls using `crypto.timingSafeEqual` verification and `HttpOnly; SameSite=Lax` HMAC-SHA256 signed cookies backed by a `0600` random secret.
- **Allowlisted Service Operations**: PM2 restart and log inspection routes validate target names against explicit allowlists (`wa-bot`, `agent-dashboard`).
- **Owner Authorization**: Destructive bot commands and host shell execution (`.agen`, `$ <cmd>`, `.sh`, `.model`, `.akun`, `.restart`) verify the sender JID/LID against `ownerNumber` / `ownerLid`.

## Credential Hygiene

Never commit or share:
- `config.json` (contains owner number and optional dashboard PIN)
- `session_auth/` (WhatsApp Multi-Device encryption keys)
- `data/` (local account pool tokens and runtime settings)

## Reporting a Vulnerability

If you discover a security issue, please open a GitHub issue without posting live secrets or tokens, or contact the repository maintainer directly.
