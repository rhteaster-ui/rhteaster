/**
 * server.js - Client Web Ops Dashboard & Task Map Server (Single-VPS)
 * Industrial Graphite Ops Deck UI + SSE Live Telemetry + WhatsApp Pairing Control + AI Quota Pool
 */

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { ROOT_DIR, DATA_DIR, ensureDir, loadConfig, loadSettings, saveSettings } = require("../lib/configStore");
const accountManager = require("../lib/accountManager");
const { AVAILABLE_MODELS, checkAgyStatus } = require("../lib/agyHelper");
const { queryControlBridge } = require("../lib/controlBridge");
const { startMonitors, refreshAllQuotas, getQuotaSnapshot } = require("./quotaService");
const { getTaskMapData, getClusterSnapshot, subscribeTaskMap, startTaskMapMonitor } = require("./taskMapService");

const execFileAsync = promisify(execFile);
const app = express();
const cfg = loadConfig();
const PORT = Number(process.env.DASHBOARD_PORT || cfg.dashboardPort || 3000);

// Persistent random secret for optional Dashboard PIN cookies
const SECRET_FILE = path.join(DATA_DIR, "session_secret.txt");
function getSessionSecret() {
    ensureDir(DATA_DIR);
    try {
        if (fs.existsSync(SECRET_FILE)) {
            const existing = fs.readFileSync(SECRET_FILE, "utf8").trim();
            if (existing.length >= 32) return existing;
        }
        const secret = crypto.randomBytes(32).toString("hex");
        fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
        return secret;
    } catch (_) {
        return crypto.randomBytes(32).toString("hex");
    }
}
const SESSION_SECRET = getSessionSecret();

function parseCookies(cookieHeader = "") {
    const out = {};
    for (const part of String(cookieHeader).split(";")) {
        const idx = part.indexOf("=");
        if (idx > 0) {
            out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return out;
}

function makeAuthToken(pin) {
    return crypto.createHmac("sha256", SESSION_SECRET).update(`pin:${pin}`).digest("hex");
}

function isRequestAuthenticated(req) {
    const activePin = String(process.env.DASHBOARD_PIN ?? loadConfig().dashboardPin ?? "").trim();
    if (!activePin) return true;

    const cookies = parseCookies(req.headers.cookie);
    const cookieTok = cookies.client_deck_auth || "";
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const expected = makeAuthToken(activePin);

    for (const candidate of [cookieTok, bearer]) {
        if (candidate.length === expected.length) {
            try {
                if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) return true;
            } catch (_) {}
        }
    }
    return false;
}

startMonitors();
startTaskMapMonitor();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const telemetryHistory = [];
const MAX_TELEMETRY = 60;
let prevNetRx = 0;
let prevNetTx = 0;
let prevCpuTimes = null;
let cachedPm2 = [];
let cachedProcesses = [];
let cachedDisk = { used: 0, total: 100 };
let cachedWaStatus = { status: "checking", registered: false, mode: "public", botNumber: "" };
let cachedTaskSnap = null;
let isRefreshingSystem = false;
const statusStreamClients = new Set();

function getCpuTimes() {
    try {
        const lines = fs.readFileSync("/proc/stat", "utf8").split("\n");
        const cpuLine = lines.find((l) => l.startsWith("cpu "));
        if (cpuLine) {
            const parts = cpuLine.trim().split(/\s+/).slice(1).map(Number);
            return { idle: parts[3] + parts[4], total: parts.reduce((a, b) => a + b, 0) };
        }
    } catch (_) {}
    return { idle: 0, total: 1 };
}

function getNetBytes() {
    try {
        const lines = fs.readFileSync("/proc/net/dev", "utf8").split("\n");
        let rx = 0, tx = 0;
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 9 && !parts[0].startsWith("lo") && !parts[0].startsWith("Inter") && !parts[0].startsWith("face")) {
                rx += Number(parts[1]) || 0;
                tx += Number(parts[9]) || 0;
            }
        }
        return { rx, tx };
    } catch (_) {
        return { rx: 0, tx: 0 };
    }
}

async function refreshSystemCache() {
    if (isRefreshingSystem) return;
    isRefreshingSystem = true;
    try {
        const [pm2Res, psRes, dfRes, waRes] = await Promise.allSettled([
            execFileAsync("pm2", ["jlist"], { timeout: 3000 }),
            execFileAsync("ps", ["-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu"], { timeout: 2500 }),
            execFileAsync("df", ["-B1", "/"], { timeout: 2000 }),
            queryControlBridge("/status", "GET")
        ]);

        if (pm2Res.status === "fulfilled" && pm2Res.value.stdout) {
            try {
                const list = JSON.parse(pm2Res.value.stdout);
                cachedPm2 = list.map((p) => ({
                    id: p.pm_id,
                    name: p.name,
                    status: p.pm2_env?.status || "unknown",
                    cpu: p.monit?.cpu ?? 0,
                    memMb: Math.round((p.monit?.memory || 0) / 1024 / 1024),
                    restarts: p.pm2_env?.restart_time ?? 0,
                    uptimeSec: p.pm2_env?.pm_uptime ? Math.max(0, Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000)) : 0
                }));
            } catch (_) {}
        }

        if (psRes.status === "fulfilled" && psRes.value.stdout) {
            cachedProcesses = psRes.value.stdout.trim().split("\n").slice(1, 9).map((line) => {
                const parts = line.trim().split(/\s+/);
                return { pid: Number(parts[0]), cmd: parts[1], cpu: Number(parts[2]), mem: Number(parts[3]) };
            }).filter((p) => Number.isFinite(p.pid));
        }

        if (dfRes.status === "fulfilled" && dfRes.value.stdout) {
            const rows = dfRes.value.stdout.trim().split("\n");
            if (rows[1]) {
                const cols = rows[1].trim().split(/\s+/);
                const totalBytes = Number(cols[1]);
                const usedBytes = Number(cols[2]);
                if (Number.isFinite(usedBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
                    cachedDisk = {
                        used: Math.round((usedBytes / (1024 ** 3)) * 10) / 10,
                        total: Math.round((totalBytes / (1024 ** 3)) * 10) / 10
                    };
                }
            }
        }

        if (waRes.status === "fulfilled" && waRes.value?.ok) {
            cachedWaStatus = waRes.value;
        } else {
            cachedWaStatus = { ...cachedWaStatus, ok: false, status: "offline" };
        }
    } finally {
        isRefreshingSystem = false;
    }
}

function sampleTelemetryPoint() {
    const curCpu = getCpuTimes();
    let cpuPct = 0;
    if (prevCpuTimes) {
        const idleDelta = curCpu.idle - prevCpuTimes.idle;
        const totalDelta = curCpu.total - prevCpuTimes.total;
        if (totalDelta > 0) cpuPct = Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
    }
    prevCpuTimes = curCpu;

    const curNet = getNetBytes();
    let netDeltaKb = 0;
    if (prevNetRx > 0) {
        netDeltaKb = Math.round((Math.max(0, curNet.rx - prevNetRx) + Math.max(0, curNet.tx - prevNetTx)) / 1024);
    }
    prevNetRx = curNet.rx;
    prevNetTx = curNet.tx;

    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    const usedMem = totalMem - freeMem;
    const ramPct = Math.round((usedMem / totalMem) * 100);
    const now = new Date();

    telemetryHistory.push({
        time: now.toLocaleTimeString("id-ID", { hour12: false }),
        timestamp: now.getTime(),
        cpu: cpuPct,
        ram: ramPct,
        ramUsedMb: usedMem,
        load: Math.round(os.loadavg()[0] * 100) / 100,
        netKb: netDeltaKb
    });
    if (telemetryHistory.length > MAX_TELEMETRY) telemetryHistory.shift();
}

(function seedTelemetry() {
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const usedMem = totalMem - Math.round(os.freemem() / 1024 / 1024);
    const ramPct = Math.round((usedMem / totalMem) * 100);
    const baseLoad = Math.round(os.loadavg()[0] * 100) / 100;
    const now = Date.now();
    for (let i = 20; i >= 0; i--) {
        const t = new Date(now - i * 2000);
        telemetryHistory.push({
            time: t.toLocaleTimeString("id-ID", { hour12: false }),
            timestamp: t.getTime(),
            cpu: 0,
            ram: ramPct,
            ramUsedMb: usedMem,
            load: baseLoad,
            netKb: 0
        });
    }
})();

function getHostMetrics() {
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);
    const usedMem = totalMem - freeMem;
    return {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.arch()}`,
        nodeVersion: process.version,
        uptime: Math.round(os.uptime()),
        cores: os.cpus().length,
        loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
        ram: { used: usedMem, total: totalMem, free: freeMem, pct: Math.round((usedMem / totalMem) * 100) },
        disk: {
            used: cachedDisk.used,
            total: cachedDisk.total,
            free: Math.round((cachedDisk.total - cachedDisk.used) * 10) / 10,
            pct: cachedDisk.total > 0 ? Math.round((cachedDisk.used / cachedDisk.total) * 100) : 0
        }
    };
}

function getStatusPayload() {
    const liveCfg = loadConfig();
    const settings = loadSettings();
    const quotaSnap = getQuotaSnapshot();
    const agyStatus = checkAgyStatus(liveCfg.agyBin);
    const host = getHostMetrics();
    const cluster = getClusterSnapshot();

    if (!cachedTaskSnap) {
        try { cachedTaskSnap = getTaskMapData(); } catch (_) { cachedTaskSnap = { tasks: [] }; }
    }
    const tasks = cachedTaskSnap?.tasks || [];

    return {
        serverTime: new Date().toISOString(),
        brandName: liveCfg.brandName || "Agency Client",
        botName: liveCfg.botName || "Agency AI Bot",
        quotaUpdatedAt: quotaSnap.updatedAt,
        quotaRefreshing: quotaSnap.refreshing,
        host,
        cluster,
        waBot: {
            ...cachedWaStatus,
            botNumber: cachedWaStatus.botNumber || liveCfg.botNumber || "",
            ownerNumber: cachedWaStatus.ownerNumber || liveCfg.ownerNumber || "",
            mode: cachedWaStatus.mode || (settings.isPrivateMode ? "private" : "public")
        },
        agy: {
            installed: agyStatus.isInstalled,
            loggedIn: agyStatus.isLoggedIn,
            authEmail: agyStatus.authEmail,
            binPath: agyStatus.binPath
        },
        activeAccount: quotaSnap.activeAccount || "--",
        activeEmail: quotaSnap.activeEmail || "--",
        activeModel: settings.currentModel || quotaSnap.activeModel || "gemini-3.8-flash-medium",
        models: AVAILABLE_MODELS,
        accounts: quotaSnap.accounts,
        telemetry: telemetryHistory,
        pm2: cachedPm2,
        processes: cachedProcesses,
        tasksSummary: {
            runningCount: tasks.filter((t) => t.status === "running").length,
            totalTracked: tasks.length,
            activeTaskId: cachedTaskSnap?.activeTaskId || null,
            tasks: tasks.slice(0, 6)
        }
    };
}

function broadcastStatusStream(force = false) {
    if (statusStreamClients.size === 0) return;
    const now = Date.now();
    const payload = JSON.stringify(getStatusPayload());
    for (const client of statusStreamClients) {
        if (force || (now - client.lastSentAt >= client.intervalMs - 80)) {
            client.lastSentAt = now;
            try { client.res.write(`data: ${payload}\n\n`); } catch (_) { statusStreamClients.delete(client); }
        }
    }
}

subscribeTaskMap((data) => {
    cachedTaskSnap = data;
    broadcastStatusStream(true);
});

refreshSystemCache();
let tickCount = 0;
setInterval(async () => {
    tickCount += 1;
    if (tickCount % 2 === 0) sampleTelemetryPoint();
    await refreshSystemCache();
    broadcastStatusStream(false);
}, 1000).unref();

// Public Auth Routes
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/auth/state", (req, res) => {
    const activePin = String(process.env.DASHBOARD_PIN ?? loadConfig().dashboardPin ?? "").trim();
    res.json({
        pinRequired: Boolean(activePin),
        authenticated: isRequestAuthenticated(req),
        brandName: loadConfig().brandName || "Agency Client"
    });
});

app.post("/api/auth/login", (req, res) => {
    const activePin = String(process.env.DASHBOARD_PIN ?? loadConfig().dashboardPin ?? "").trim();
    if (!activePin) return res.json({ ok: true });
    const pin = String(req.body?.pin || "").trim();
    if (pin.length !== activePin.length || !crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(activePin))) {
        return res.status(401).json({ ok: false, error: "PIN Dashboard salah." });
    }
    const token = makeAuthToken(activePin);
    res.cookie("client_deck_auth", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000 });
    return res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("client_deck_auth");
    res.json({ ok: true });
});

// Protect all operational /api routes if PIN is configured
app.use("/api", (req, res, next) => {
    if (!isRequestAuthenticated(req)) {
        return res.status(401).json({ ok: false, error: "Autentikasi PIN diperlukan." });
    }
    next();
});

app.get("/api/status", (req, res) => res.json(getStatusPayload()));

app.get("/api/stream", (req, res) => {
    const intervalMs = Math.min(10000, Math.max(1000, Number(req.query.interval) || 2000));
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
    });
    const client = { res, intervalMs, lastSentAt: Date.now() };
    statusStreamClients.add(client);
    try { res.write(`data: ${JSON.stringify(getStatusPayload())}\n\n`); } catch (_) {}
    const keepalive = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 15000);
    req.on("close", () => { clearInterval(keepalive); statusStreamClients.delete(client); });
});

app.get("/task-map", (req, res) => res.sendFile(path.join(__dirname, "public", "task-map.html")));

app.get("/api/task-map", (req, res) => {
    try {
        const snap = getTaskMapData();
        cachedTaskSnap = snap;
        res.json(snap);
    } catch (err) {
        res.status(500).json({ error: err.message, tasks: [] });
    }
});

app.get("/api/task-map/stream", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
    });
    const send = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) {} };
    try { send(getTaskMapData()); } catch (err) { send({ error: err.message, tasks: [] }); }
    const unsub = subscribeTaskMap(send);
    const keepalive = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 15000);
    req.on("close", () => { clearInterval(keepalive); unsub(); });
});

// Interactive WA Bot & AI Controls
app.post("/api/wa/pair", async (req, res) => {
    const phone = String(req.body?.phoneNumber || "").trim();
    const result = await queryControlBridge("/pair", "POST", { phoneNumber: phone });
    await refreshSystemCache();
    broadcastStatusStream(true);
    res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/wa/logout", async (req, res) => {
    const result = await queryControlBridge("/logout", "POST");
    await refreshSystemCache();
    broadcastStatusStream(true);
    res.status(result.ok ? 200 : 500).json(result);
});

app.post("/api/wa/mode", async (req, res) => {
    const mode = req.body?.mode === "private" ? "private" : "public";
    saveSettings({ isPrivateMode: mode === "private" });
    const result = await queryControlBridge("/mode", "POST", { mode });
    await refreshSystemCache();
    broadcastStatusStream(true);
    res.json({ ok: true, mode, bridge: result.ok });
});

app.post("/api/refresh-quotas", async (req, res) => {
    const state = await refreshAllQuotas();
    broadcastStatusStream(true);
    res.json({ ok: true, updatedAt: state.updatedAt, accountsCount: state.accounts.length });
});

app.post("/api/switch-account", async (req, res) => {
    const target = String(req.body?.target || "").trim();
    const result = accountManager.switchAccount(target);
    if (!result.success) return res.status(400).json({ ok: false, error: result.error });
    broadcastStatusStream(true);
    res.json({ ok: true, account: result.account });
});

app.post("/api/model", (req, res) => {
    const modelId = String(req.body?.modelId || "").trim();
    const valid = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!valid) return res.status(400).json({ ok: false, error: "Model tidak valid." });
    saveSettings({ currentModel: valid.id });
    broadcastStatusStream(true);
    res.json({ ok: true, activeModel: valid.id });
});

app.post("/api/pm2/restart", async (req, res) => {
    const target = String(req.body?.target || "wa-bot").trim();
    if (!["wa-bot", "agent-dashboard"].includes(target)) {
        return res.status(400).json({ ok: false, error: "Target proses tidak diizinkan." });
    }
    if (target === "agent-dashboard") {
        res.json({ ok: true, message: "Merestart agent-dashboard..." });
        setTimeout(() => { execFile("pm2", ["restart", "agent-dashboard"], () => {}); }, 400);
        return;
    }
    try {
        await execFileAsync("pm2", ["restart", target], { timeout: 6000 });
        await refreshSystemCache();
        broadcastStatusStream(true);
        res.json({ ok: true, message: `Service ${target} berhasil direstart.` });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.get("/api/logs", (req, res) => {
    const procName = String(req.query.process || "wa-bot").replace(/[^a-zA-Z0-9_-]/g, "");
    const lines = Math.min(100, Math.max(10, Number(req.query.lines) || 40));

    const readTail = (filePath) => {
        if (!fs.existsSync(filePath)) return [];
        try { return fs.readFileSync(filePath, "utf8").trim().split("\n").slice(-lines); } catch (_) { return []; }
    };

    const localLogsDir = path.join(ROOT_DIR, "logs");
    const pm2LogsDir = path.join(process.env.PM2_HOME || path.join(os.homedir(), ".pm2"), "logs");

    const localOut = readTail(path.join(localLogsDir, `${procName}-out.log`));
    const localErr = readTail(path.join(localLogsDir, `${procName}-error.log`));
    const out = localOut.length ? localOut : readTail(path.join(pm2LogsDir, `${procName}-out.log`));
    const err = localErr.length ? localErr : readTail(path.join(pm2LogsDir, `${procName}-error.log`));

    res.json({ process: procName, source: "pm2", out, err });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`[CLIENT-OPS-DECK] Listening on http://0.0.0.0:${PORT}`);
});
