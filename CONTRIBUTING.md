# Contributing to Rhteaster

Thank you for helping improve **Rhteaster**.

## Development Setup

```bash
git clone https://github.com/rhteaster-ui/rhteaster.git
cd rhteaster
npm install
npm test
```

## Project Layout

- `bin/rhteaster.js` — Global CLI management toolkit (`rhteaster`).
- `index.js` & `lib/` — WhatsApp Baileys runtime, intent router, account pool, and localhost control bridge.
- `dashboard/` — Express Web Ops Deck server, SSE telemetry, quota polling, and Live Task Map UI.
- `tests/smoke.test.mjs` — Automated syntax, module, CLI, HTTP auth, and privacy leakage checks.
- `setup.sh` — Ubuntu/Debian one-command provisioning script.

## Guidelines

1. **Keep changes focused**: Avoid unrelated refactors or unnecessary dependencies.
2. **Never commit credentials or personal data**: Keep `config.json`, `session_auth/`, `data/`, and `logs/` excluded via `.gitignore`, and never place real IPs, phone numbers, or tokens in tests or examples.
3. **Verify before opening a PR**:
   ```bash
   bash -n setup.sh
   npm test
   ```
4. **Update documentation**: Reflect new CLI flags, WhatsApp commands, or `config.json` keys in `README.md` and `CHANGELOG.md`.
