#!/usr/bin/env node
/**
 * Rhteaster CLI Toolkit
 * Unified terminal management for WhatsApp AI Agent, Web Ops Dashboard, diagnostics, and backups.
 * Repository: https://github.com/rhteaster-ui/rhteaster
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const {
    ROOT_DIR,
    DATA_DIR,
    CONFIG_PATH,
    DEFAULT_CONFIG,
    ensureDir,
    readJsonSafe,
    loadConfig,
    saveConfig,
    loadSettings,
    saveSettings
} = require("../lib/configStore");
const { cleanNumber } = require("../lib/utils");
const { queryControlBridge } = require("../lib/controlBridge");
const { AVAILABLE_MODELS, checkAgyStatus } = require("../lib/agyHelper");
const accountManager = require("../lib/accountManager");
const { getVpsStatus } = require("../lib/systemHelper");

const PKG = readJsonSafe(path.join(ROOT_DIR, "package.json"), { version: "2.1.0", name: "rhteaster" });

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = {
    reset: (s) => (USE_COLOR ? `\x1b[0m${s}\x1b[0m` : String(s)),
    bold: (s) => (USE_COLOR ? `\x1b[1m${s}\x1b[0m` : String(s)),
    dim: (s) => (USE_COLOR ? `\x1b[2m${s}\x1b[0m` : String(s)),
    green: (s) => (USE_COLOR ? `\x1b[32m${s}\x1b[0m` : String(s)),
    yellow: (s) => (USE_COLOR ? `\x1b[33m${s}\x1b[0m` : String(s)),
    red: (s) => (USE_COLOR ? `\x1b[31m${s}\x1b[0m` : String(s)),
    cyan: (s) => (USE_COLOR ? `\x1b[36m${s}\x1b[0m` : String(s))
};

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (const token of argv) {
        if (token.startsWith("--")) {
            const eq = token.indexOf("=");
            if (eq !== -1) {
                flags[token.slice(2, eq)] = token.slice(eq + 1);
            } else {
                flags[token.slice(2)] = true;
            }
        } else if (token === "-h") {
            flags.help = true;
        } else if (token === "-v") {
            flags.version = true;
        } else {
            positional.push(token);
        }
    }
    return { positional, flags };
}

function commandExists(cmd) {
    try {
        return execFileSync("which", [cmd], { encoding: "utf8", timeout: 2000 }).trim();
    } catch (_) {
        return "";
    }
}

function getEffectiveConfig() {
    const existing = readJsonSafe(CONFIG_PATH, null);
    if (!existing) return { exists: false, config: { ...DEFAULT_CONFIG } };
    return { exists: true, config: { ...DEFAULT_CONFIG, ...existing } };
}

function printBanner() {
    console.log(c.bold(`Rhteaster CLI v${PKG.version}`) + c.dim(" · WhatsApp AI Agent + Web Ops Deck"));
}

function printHelp() {
    printBanner();
    console.log(`
Usage:
  rhteaster <command> [options]

Commands:
  status [--json]               Show VPS health, PM2 services, WA connection, and AI pool
  doctor [--json]               Run pre-flight & troubleshooting diagnostics
  pair [phone]                  Request an 8-digit WhatsApp pairing code
  config [options]              View or update config.json and bot mode
    --show                      Display active configuration (PIN masked)
    --brand=<name>              Set dashboard brand name
    --bot=<phone>               Set bot WhatsApp number (e.g. 628...)
    --owner=<phone>             Set owner WhatsApp number (e.g. 628...)
    --port=<number>             Set Web Ops Dashboard port (1-65535)
    --pin=<pin>                 Set optional Web Dashboard PIN
    --clear-pin                 Remove Web Dashboard PIN
    --mode=<public|private>     Set bot access mode
  model [num_or_id]             List AI models or switch the active model
  accounts [switch <name>]      List saved Antigravity accounts or switch active account
  start | stop | restart        Manage PM2 processes (wa-bot & agent-dashboard)
  logs [wa|dash|all]            Stream or inspect PM2 logs (--lines=50, --nostream)
  update                        Pull latest code, install dependencies, and reload PM2
  backup [archive.tar.gz]       Archive config.json, data/, and session_auth/
  version | help                Show version or this help message
`);
}

async function checkDashboardHealth(port) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
        const json = await res.json();
        return { online: Boolean(res.ok && json?.ok), status: res.status };
    } catch (err) {
        return { online: false, error: err.message };
    } finally {
        clearTimeout(timer);
    }
}

async function handleStatus(flags) {
    const { exists, config } = getEffectiveConfig();
    const settings = loadSettings();
    const vps = getVpsStatus();
    const agy = checkAgyStatus(config.agyBin);
    const waBridge = await queryControlBridge("/status", "GET");
    const dash = await checkDashboardHealth(config.dashboardPort || 3000);
    const { accounts, activeName } = accountManager.listAccounts();

    const payload = {
        version: PKG.version,
        rootDir: ROOT_DIR,
        configExists: exists,
        brandName: config.brandName,
        dashboardPort: config.dashboardPort,
        dashboardOnline: dash.online,
        dashboardPinEnabled: Boolean(config.dashboardPin),
        waBridgeOnline: !waBridge.offline,
        waStatus: waBridge.offline ? "offline" : waBridge.status,
        waRegistered: Boolean(waBridge.registered),
        waMode: waBridge.mode || (settings.isPrivateMode ? "private" : "public"),
        agyInstalled: agy.isInstalled,
        agyLoggedIn: agy.isLoggedIn,
        agyAccounts: accounts.length,
        activeAccount: activeName || null,
        activeModel: settings.currentModel,
        host: {
            hostname: vps.hostname,
            nodeVersion: vps.nodeVersion,
            ram: `${vps.ramUsed} / ${vps.ramTotal} (${vps.ramUsagePercent}%)`,
            disk: vps.diskInfo,
            loadAvg: vps.loadAvg,
            uptime: vps.uptimeSys
        },
        pm2: vps.pm2List
    };

    if (flags.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
    }

    printBanner();
    console.log("");
    console.log(c.bold("Host & Runtime"));
    console.log(`  Hostname       : ${payload.host.hostname} (${payload.host.nodeVersion})`);
    console.log(`  RAM / Disk     : ${payload.host.ram} | ${payload.host.disk}`);
    console.log(`  Load / Uptime  : ${payload.host.loadAvg} | ${payload.host.uptime}`);

    console.log("");
    console.log(c.bold("WhatsApp & Dashboard"));
    const waLabel = payload.waBridgeOnline
        ? `${payload.waStatus} (registered: ${payload.waRegistered ? "yes" : "no"}, mode: ${payload.waMode})`
        : "offline (control bridge unreachable)";
    console.log(`  WA Agent       : ${payload.waBridgeOnline ? c.green(waLabel) : c.yellow(waLabel)}`);
    const dashLabel = payload.dashboardOnline
        ? `online at http://127.0.0.1:${payload.dashboardPort} (PIN: ${payload.dashboardPinEnabled ? "enabled" : "off"})`
        : `offline (expected port ${payload.dashboardPort})`;
    console.log(`  Web Ops Deck   : ${payload.dashboardOnline ? c.green(dashLabel) : c.yellow(dashLabel)}`);

    console.log("");
    console.log(c.bold("AI Engine"));
    console.log(`  Antigravity    : ${agy.isInstalled ? c.green(agy.binPath) : c.red("not found")} (auth: ${agy.isLoggedIn ? "logged in" : "not logged in"})`);
    console.log(`  Active Model   : ${c.cyan(payload.activeModel)}`);
    console.log(`  Account Pool   : ${accounts.length} account(s)${activeName ? ` (active: ${activeName})` : ""}`);

    console.log("");
    console.log(c.bold("PM2 Processes"));
    if (vps.pm2List.length === 0) {
        console.log("  No active PM2 processes detected.");
    } else {
        for (const p of vps.pm2List) {
            const st = p.status === "online" ? c.green(p.status) : c.red(p.status);
            console.log(`  - ${p.name.padEnd(18)} ${st}  RAM: ${p.memMb}MB  CPU: ${p.cpu}%  Restarts: ${p.restarts}`);
        }
    }
    console.log("");
}

async function handleDoctor(flags) {
    const checks = [];
    const pushCheck = (id, level, ok, detail, hint = "") => {
        checks.push({ id, level, status: ok ? "pass" : level, detail, hint });
    };

    // 1. Node.js >= 20
    const major = Number(process.versions.node.split(".")[0] || 0);
    pushCheck(
        "nodejs",
        "fail",
        major >= 20,
        `Node.js ${process.version}`,
        major >= 20 ? "" : "Upgrade to Node.js v20+ (recommended v22 LTS)."
    );

    // 2. Core binaries
    const pm2Path = commandExists("pm2");
    pushCheck("pm2", "warn", Boolean(pm2Path), pm2Path || "pm2 not found", pm2Path ? "" : "Install with: npm install -g pm2");

    const gitPath = commandExists("git");
    pushCheck("git", "warn", Boolean(gitPath), gitPath || "git not found", gitPath ? "" : "Install git via apt-get install -y git");

    const ffmpegPath = commandExists("ffmpeg");
    pushCheck("ffmpeg", "warn", Boolean(ffmpegPath), ffmpegPath || "ffmpeg not found (optional for media tools)", ffmpegPath ? "" : "Install with: apt-get install -y ffmpeg");

    // 3. Config file & directories
    const { exists, config } = getEffectiveConfig();
    pushCheck(
        "config",
        "warn",
        exists && Boolean(cleanNumber(config.ownerNumber)),
        exists
            ? `config.json present (owner: ${cleanNumber(config.ownerNumber) || "unset"}, port: ${config.dashboardPort})`
            : "config.json not initialized yet",
        exists && cleanNumber(config.ownerNumber)
            ? ""
            : "Run: rhteaster config --owner=628... --brand=\"Your Brand\""
    );

    let dirsOk = true;
    let dirDetail = "data/, logs/, session_auth/ writable";
    try {
        for (const sub of ["data", "logs", "session_auth"]) {
            const p = path.join(ROOT_DIR, sub);
            ensureDir(p);
            fs.accessSync(p, fs.constants.W_OK);
        }
    } catch (err) {
        dirsOk = false;
        dirDetail = err.message;
    }
    pushCheck("directories", "fail", dirsOk, dirDetail, dirsOk ? "" : `Check filesystem permissions in ${ROOT_DIR}`);

    // 4. Antigravity CLI & auth
    const agy = checkAgyStatus(config.agyBin);
    pushCheck(
        "agy-binary",
        "warn",
        agy.isInstalled,
        agy.isInstalled ? `${agy.binPath}` : "agy CLI binary not found",
        agy.isInstalled ? "" : "Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash"
    );
    pushCheck(
        "agy-auth",
        "warn",
        agy.isLoggedIn,
        agy.isLoggedIn ? `Logged in (${agy.accountsCount} account(s) in pool)` : "No active Google AI token found",
        agy.isLoggedIn ? "" : "Run: agy   (complete Google login once)"
    );

    // 5. Runtime services
    const waBridge = await queryControlBridge("/status", "GET");
    pushCheck(
        "wa-bridge",
        "warn",
        !waBridge.offline,
        waBridge.offline ? "wa-bot control bridge offline" : `wa-bot ${waBridge.status} (registered: ${Boolean(waBridge.registered)})`,
        waBridge.offline ? "Start services with: rhteaster start" : ""
    );

    const dash = await checkDashboardHealth(config.dashboardPort || 3000);
    pushCheck(
        "dashboard",
        "warn",
        dash.online,
        dash.online ? `Ops Deck healthy on port ${config.dashboardPort}` : `Ops Deck unreachable on port ${config.dashboardPort}`,
        dash.online ? "" : "Start services with: rhteaster start"
    );

    const criticalFailed = checks.some((ch) => ch.status === "fail");
    const warnings = checks.filter((ch) => ch.status === "warn").length;

    if (flags.json) {
        console.log(JSON.stringify({ ok: !criticalFailed, warnings, checks }, null, 2));
        process.exitCode = criticalFailed ? 1 : 0;
        return;
    }

    printBanner();
    console.log("\n" + c.bold("Diagnostics"));
    for (const ch of checks) {
        const badge =
            ch.status === "pass"
                ? c.green("[PASS]")
                : ch.status === "warn"
                    ? c.yellow("[WARN]")
                    : c.red("[FAIL]");
        console.log(`  ${badge} ${ch.id.padEnd(14)} ${ch.detail}`);
        if (ch.hint) console.log(`         ${c.dim("-> " + ch.hint)}`);
    }
    console.log("");
    if (criticalFailed) {
        console.log(c.red("Result: critical checks failed."));
        process.exitCode = 1;
    } else if (warnings > 0) {
        console.log(c.yellow(`Result: ready with ${warnings} warning(s).`));
    } else {
        console.log(c.green("Result: all checks passed."));
    }
}

async function handlePair(positional, flags) {
    const cfg = loadConfig();
    const rawPhone = positional[0] || flags.phone || cfg.botNumber || "";
    const phone = cleanNumber(rawPhone);
    if (!phone || phone.length < 8) {
        console.error(c.red("Error: provide a valid WhatsApp number (example: rhteaster pair 628123456789)."));
        process.exitCode = 1;
        return;
    }

    const res = await queryControlBridge("/pair", "POST", { phoneNumber: phone });
    if (!res.offline) {
        if (res.ok) {
            console.log(c.green(`Pairing code for +${res.botNumber}: `) + c.bold(res.pairingCode));
            console.log("Open WhatsApp > Linked Devices > Link with phone number instead.");
        } else {
            console.error(c.red(`Pairing failed: ${res.error || "Unknown error"}`));
            process.exitCode = 1;
        }
        return;
    }

    console.log(c.yellow("wa-bot PM2 service is offline; starting standalone pairing mode..."));
    saveConfig({ botNumber: phone });
    const child = spawnSync(process.execPath, [path.join(ROOT_DIR, "index.js"), "--pair"], {
        cwd: ROOT_DIR,
        stdio: "inherit"
    });
    process.exitCode = child.status ?? 0;
}

function handleConfig(flags) {
    const { exists, config } = getEffectiveConfig();
    const settings = loadSettings();

    const hasMutation = Boolean(
        flags.brand || flags.name || flags.bot || flags.owner || flags.port || flags.pin || flags["clear-pin"] || flags.mode
    );

    if (hasMutation) {
        const patch = {};
        if (flags.brand || flags.name) {
            const b = String(flags.brand || flags.name).trim();
            patch.brandName = b;
            patch.botName = `${b} Bot`;
        }
        if (flags.owner) {
            const o = cleanNumber(String(flags.owner));
            if (!o || o.length < 8) {
                console.error(c.red("Invalid --owner phone number."));
                process.exitCode = 1;
                return;
            }
            patch.ownerNumber = o;
        }
        if (flags.bot) {
            const b = cleanNumber(String(flags.bot));
            if (!b || b.length < 8) {
                console.error(c.red("Invalid --bot phone number."));
                process.exitCode = 1;
                return;
            }
            patch.botNumber = b;
        }
        if (flags.port) {
            const p = Number(flags.port);
            if (!Number.isInteger(p) || p < 1 || p > 65535) {
                console.error(c.red("Invalid --port (must be 1..65535)."));
                process.exitCode = 1;
                return;
            }
            patch.dashboardPort = p;
        }
        if (flags["clear-pin"]) {
            patch.dashboardPin = "";
        } else if (flags.pin !== undefined && flags.pin !== true) {
            patch.dashboardPin = String(flags.pin).trim();
        }
        if (Object.keys(patch).length > 0) {
            saveConfig(patch);
        }
        if (flags.mode) {
            const m = String(flags.mode).toLowerCase();
            if (m !== "public" && m !== "private") {
                console.error(c.red("Invalid --mode (use public or private)."));
                process.exitCode = 1;
                return;
            }
            saveSettings({ isPrivateMode: m === "private" });
        }
    }

    const finalCfg = hasMutation ? loadConfig() : config;
    const finalSettings = loadSettings();
    const display = {
        configInitialized: exists || hasMutation,
        brandName: finalCfg.brandName,
        botName: finalCfg.botName,
        botNumber: finalCfg.botNumber || "(unset)",
        ownerNumber: finalCfg.ownerNumber || "(unset)",
        dashboardPort: finalCfg.dashboardPort,
        dashboardPin: finalCfg.dashboardPin ? (flags.reveal ? finalCfg.dashboardPin : "**** (configured)") : "(disabled)",
        mode: finalSettings.isPrivateMode ? "private" : "public",
        defaultAiModel: finalCfg.defaultAiModel,
        activeAiModel: finalSettings.currentModel
    };

    if (flags.json) {
        console.log(JSON.stringify(display, null, 2));
        return;
    }

    printBanner();
    if (hasMutation) console.log(c.green("\nConfiguration updated."));
    console.log("\n" + c.bold("Active Configuration"));
    for (const [k, v] of Object.entries(display)) {
        console.log(`  ${k.padEnd(20)}: ${v}`);
    }
    console.log("");
}

function handleModel(positional) {
    const settings = loadSettings();
    const target = positional[0];
    if (!target) {
        printBanner();
        console.log("\n" + c.bold("Available AI Models"));
        for (const m of AVAILABLE_MODELS) {
            const active = m.id === settings.currentModel ? c.green(" [ACTIVE]") : "";
            console.log(`  ${m.num.padStart(2)}. ${m.id.padEnd(28)} ${c.dim(m.name)}${active}`);
        }
        console.log(`\nSwitch with: rhteaster model <number_or_id>\n`);
        return;
    }

    const found = AVAILABLE_MODELS.find((m) => m.num === String(target) || m.id === String(target));
    if (!found) {
        console.error(c.red(`Model "${target}" not found.`));
        process.exitCode = 1;
        return;
    }
    saveSettings({ currentModel: found.id });
    console.log(c.green(`Active model switched to: ${found.id} (${found.name})`));
}

function handleAccounts(positional) {
    const sub = positional[0];
    if (sub === "switch" && positional[1]) {
        const res = accountManager.switchAccount(positional[1]);
        if (res.success) {
            console.log(c.green(`Switched active account to: ${res.name} (${res.email || "ok"})`));
        } else {
            console.error(c.red(`Switch failed: ${res.error}`));
            process.exitCode = 1;
        }
        return;
    }

    const { accounts, activeName } = accountManager.listAccounts();
    printBanner();
    console.log("\n" + c.bold("Antigravity Account Pool"));
    if (accounts.length === 0) {
        console.log("  No accounts imported yet. Login with `agy` then run `rhteaster status`.");
        return;
    }
    for (const acc of accounts) {
        const mark = acc.name === activeName || acc.isActive ? c.green(" [ACTIVE]") : "";
        console.log(`  - ${acc.name.padEnd(16)} ${acc.email || "(no email)"}${mark}`);
    }
    console.log("");
}

function handlePm2Lifecycle(action) {
    if (!commandExists("pm2")) {
        console.error(c.red("PM2 is not installed. Install with: npm install -g pm2"));
        process.exitCode = 1;
        return;
    }
    const eco = path.join(ROOT_DIR, "ecosystem.config.js");
    const map = {
        start: ["startOrReload", eco, "--update-env"],
        restart: ["restart", eco, "--update-env"],
        stop: ["stop", eco]
    };
    const res = spawnSync("pm2", map[action], { cwd: ROOT_DIR, stdio: "inherit" });
    process.exitCode = res.status ?? 0;
}

function handleLogs(positional, flags) {
    if (!commandExists("pm2")) {
        console.error(c.red("PM2 is not installed."));
        process.exitCode = 1;
        return;
    }
    const target = positional[0] || "all";
    const procMap = { wa: "wa-bot", "wa-bot": "wa-bot", dash: "agent-dashboard", dashboard: "agent-dashboard" };
    const lines = Number(flags.lines || positional[1] || 50);
    const args = ["logs"];
    if (target !== "all") {
        const mapped = procMap[target];
        if (!mapped) {
            console.error(c.red("Unknown log target. Use: wa | dash | all"));
            process.exitCode = 1;
            return;
        }
        args.push(mapped);
    }
    args.push("--lines", String(Number.isFinite(lines) && lines > 0 ? lines : 50));
    if (flags.nostream) args.push("--nostream");
    const res = spawnSync("pm2", args, { cwd: ROOT_DIR, stdio: "inherit" });
    process.exitCode = res.status ?? 0;
}

function handleUpdate() {
    console.log(c.bold("Updating Rhteaster..."));
    const pull = spawnSync("git", ["pull", "--ff-only"], { cwd: ROOT_DIR, stdio: "inherit" });
    if (pull.status !== 0) {
        process.exitCode = pull.status ?? 1;
        return;
    }
    const npm = spawnSync("npm", ["install", "--omit=dev"], { cwd: ROOT_DIR, stdio: "inherit" });
    if (npm.status !== 0) {
        process.exitCode = npm.status ?? 1;
        return;
    }
    if (commandExists("pm2")) {
        spawnSync("pm2", ["startOrReload", path.join(ROOT_DIR, "ecosystem.config.js"), "--update-env"], {
            cwd: ROOT_DIR,
            stdio: "inherit"
        });
    }
    console.log(c.green("Update completed."));
}

function handleBackup(positional) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultName = `rhteaster-backup-${stamp}.tar.gz`;
    const outPath = path.resolve(process.cwd(), positional[0] || defaultName);

    const targets = ["config.json", "data", "session_auth"].filter((rel) =>
        fs.existsSync(path.join(ROOT_DIR, rel))
    );
    if (targets.length === 0) {
        console.error(c.yellow("Nothing to back up yet (no config.json, data/, or session_auth/)."));
        process.exitCode = 1;
        return;
    }

    ensureDir(path.dirname(outPath));
    execFileSync("tar", ["-czf", outPath, "-C", ROOT_DIR, ...targets], { stdio: "inherit" });
    const sizeKb = Math.round(fs.statSync(outPath).size / 1024);
    console.log(c.green(`Backup created: ${outPath} (${sizeKb} KB)`));
    console.log(c.dim(`Included: ${targets.join(", ")}`));
}

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const cmd = positional[0];

    if (flags.version || cmd === "version") {
        console.log(`${PKG.name} v${PKG.version} (${os.platform()} ${os.arch()}, Node ${process.version})`);
        return;
    }
    if (flags.help || !cmd || cmd === "help") {
        printHelp();
        return;
    }

    const rest = positional.slice(1);
    switch (cmd) {
        case "status":
            await handleStatus(flags);
            break;
        case "doctor":
            await handleDoctor(flags);
            break;
        case "pair":
            await handlePair(rest, flags);
            break;
        case "config":
            handleConfig(flags);
            break;
        case "model":
            handleModel(rest);
            break;
        case "accounts":
            handleAccounts(rest);
            break;
        case "start":
        case "stop":
        case "restart":
            handlePm2Lifecycle(cmd);
            break;
        case "logs":
            handleLogs(rest, flags);
            break;
        case "update":
            handleUpdate();
            break;
        case "backup":
            handleBackup(rest);
            break;
        default:
            console.error(c.red(`Unknown command: ${cmd}`));
            printHelp();
            process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(c.red(`Fatal error: ${err.message}`));
    process.exit(1);
});
