# Changelog

All notable changes to **Rhteaster** are documented in this file.

## [2.1.0] - 2026-11-16
### Added
- **Rhteaster CLI Toolkit (`bin/rhteaster.js`)**: Global `rhteaster` terminal command with `status`, `doctor`, `pair`, `config`, `model`, `accounts`, `start`, `stop`, `restart`, `logs`, `update`, and `backup`.
- **One-Line Global CLI Linking**: `setup.sh` links `/usr/local/bin/rhteaster` automatically during VPS provisioning.
- **Professional GitHub Documentation & Assets**: Added vector hero banner, real rendered Ops Deck & Task Map screenshots, Mermaid architecture diagram, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, and issue templates.
- **CI Workflow**: Added `.github/workflows/ci.yml` running bash syntax verification and `node --test`.

### Changed
- Standardized repository package name, installer URLs, and documentation to `rhteaster-ui/rhteaster`.
- Expanded automated smoke test suite in `tests/smoke.test.mjs` to cover CLI diagnostics, configuration masking, and zero personal data leakage across docs and source directories.

## [2.0.0] - 2026-11-16
### Added
- Full autonomous WhatsApp AI Agent parity (`index.js` + `lib/`): smart intent router (`.ai` vs `.agen`), live streaming step progress, multi-turn sessions, multimodal attachments, and 429 multi-account auto-rotation.
- Industrial Graphite **Web Ops Deck** (`dashboard/server.js`) with SSE real-time CPU/RAM/Network telemetry, AI quota matrix, PM2 log viewer, optional HMAC-SHA256 PIN authentication, and browser-based 8-digit WhatsApp pairing via localhost control bridge.
- Interactive **Live Task Map** (`/task-map`) visualizing tool branches and step details in real time.
