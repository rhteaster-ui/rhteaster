/**
 * taskMapService.js - Real-Time Client Single-VPS Task Execution Telemetry & n8n DAG Mapper
 * Combines live WhatsApp bot execution state (data/wa_tasks.json) + local AGY transcripts.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { EventEmitter } = require("events");
const { DATA_DIR, readJsonSafe } = require("../lib/configStore");
const { queryControlBridge } = require("../lib/controlBridge");
const { getQuotaSnapshot } = require("./quotaService");

const execFileAsync = promisify(execFile);
const HOME_DIR = process.env.HOME || os.homedir();
const BRAIN_DIR = path.join(HOME_DIR, ".gemini", "antigravity-cli", "brain");
const WA_TASKS_FILE = path.join(DATA_DIR, "wa_tasks.json");

const taskMapEvents = new EventEmitter();
taskMapEvents.setMaxListeners(50);

const liveCluster = {
    waBot: { status: "unknown", registered: false, mode: "public", botNumber: "" },
    host: { agyProcs: 0, terminals: 0, browserProcs: 0, activeCmds: [], updatedAt: null }
};

let probeTimer = null;
let watchTimer = null;
let debounceTimer = null;
let lastDigest = "";
const watchers = new Map();

function cutStr(s, n) {
    const t = String(s || "").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

function formatDuration(startIso, endIso) {
    if (!startIso || !endIso) return "0s";
    const diffSec = Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
    if (diffSec < 60) return `${diffSec}s`;
    return `${Math.floor(diffSec / 60)}m ${diffSec % 60}s`;
}

function classifyTool(name, args = {}) {
    const memSkill = /SKILL\.md|MEMORY\.md|DESIGN_SYSTEM\.md|\/skills\/|\/memories\//i.test(JSON.stringify(args || {}));
    if (["read_file", "write_file", "edit_file", "replace_file_content", "patch"].includes(name)) {
        const p = String(args.Path || args.TargetFile || "").replace(/^"|"$/g, "");
        const verb = name === "read_file" ? "Baca" : (name === "write_file" ? "Tulis" : "Edit");
        return { category: "code", summary: `${verb}: ${path.basename(p) || "berkas"}`, detail: p || name, memSkill };
    }
    if (["search_web", "read_url_content", "web_search"].includes(name)) {
        const q = String(args.query || args.Url || "").replace(/^"|"$/g, "");
        return { category: "search", summary: `Search: ${q.slice(0, 28) || "web"}`, detail: q || name, memSkill };
    }
    if (["browser", "browser_exec", "browser_navigate"].includes(name)) {
        return { category: "browser", summary: `Browser: ${String(args.url || args.action || name).slice(0, 26)}`, detail: JSON.stringify(args).slice(0, 140), memSkill };
    }
    if (["invoke_subagent", "run_workflow", "swarm", "send_message"].includes(name)) {
        const role = String(args.Role || args.TypeName || args.name || name).replace(/^"|"$/g, "");
        return { category: "subagent", summary: `Subagen: ${role.slice(0, 24)}`, detail: String(args.Prompt || role).slice(0, 140), memSkill };
    }
    if (name === "run_command" || name === "terminal") {
        const rawCmd = String(args.CommandLine || args.command || "").trim();
        const sum = String(args.toolSummary || "").trim();
        let category = "terminal";
        if (/\b(playwright|chromium|google-chrome|puppeteer|screenshot)\b/i.test(rawCmd)) category = "browser";
        else if (/\b(ffmpeg|ffprobe|pdftotext|weasyprint|pdf)\b/i.test(rawCmd)) category = "media";
        else if (/\b(git\s+|gh\s+|npm\s+run\s+build)\b/i.test(rawCmd)) category = "git";
        else if (/\b(pm2\s+|systemctl\s+|nginx\b|ufw\b|service\s+)\b/i.test(rawCmd)) category = "infra";
        else if (/\b(curl\s+.*https?:|wget\s+.*https?:)\b/i.test(rawCmd)) category = "search";
        return { category, summary: sum || rawCmd.slice(0, 32) || name, detail: rawCmd.slice(0, 160) || name, memSkill };
    }
    return { category: "terminal", summary: name, detail: JSON.stringify(args).slice(0, 120), memSkill };
}

function cleanPromptText(raw) {
    let text = String(raw || "");
    text = text.replace(/<\/USER_REQUEST>[\s\S]*$/g, "").replace(/<ADDITIONAL_METADATA>[\s\S]*$/g, "");
    const idx = text.lastIndexOf("Instruksi dari ");
    if (idx !== -1) text = text.slice(text.indexOf(":", idx) + 1);
    return cutStr(text.replace(/<[^>]+>/g, "").replace(/^[\s"']+|[\s"']+$/g, ""), 180) || "Tugas Agen AI";
}

function readTranscriptTasks(activeAcctInfo, activeModel) {
    const tasks = [];
    if (!fs.existsSync(BRAIN_DIR)) return tasks;

    const sessions = [];
    try {
        for (const dirName of fs.readdirSync(BRAIN_DIR)) {
            const tp = path.join(BRAIN_DIR, dirName, ".system_generated", "logs", "transcript.jsonl");
            if (!fs.existsSync(tp)) continue;
            try {
                const st = fs.statSync(tp);
                if (st.size > 0) sessions.push({ id: dirName, path: tp, mtime: st.mtimeMs });
            } catch (_) {}
        }
    } catch (_) {}

    sessions.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();

    for (const sess of sessions.slice(0, 6)) {
        let lines = [];
        try { lines = fs.readFileSync(sess.path, "utf8").trim().split("\n").filter(Boolean); } catch (_) { continue; }
        if (!lines.length) continue;

        let model = activeModel || "gemini-3.8-flash-medium";
        let firstTime = "";
        let lastTime = "";
        let totalTokens = 0;
        let lastUserIdx = 0;
        const parsed = [];

        for (const line of lines) {
            try {
                const item = JSON.parse(line);
                parsed.push(item);
                if (item.source === "USER_EXPLICIT" || item.type === "USER_INPUT") lastUserIdx = parsed.length - 1;
                if (item.created_at) {
                    if (!firstTime) firstTime = item.created_at;
                    lastTime = item.created_at;
                }
                if (item.model) model = item.model;
                if (item.input_tokens || item.output_tokens) {
                    totalTokens = (item.input_tokens || 0) + (item.output_tokens || 0);
                }
            } catch (_) {}
        }

        const turnItems = parsed.slice(lastUserIdx);
        const turnUser = turnItems.find((x) => x.source === "USER_EXPLICIT" || x.type === "USER_INPUT") || parsed[0];
        const rawContent = String(turnUser?.content || "");
        const channel = /WhatsApp|s\.whatsapp\.net|AUTONOMOUS AGENT TASK/i.test(rawContent) ? "whatsapp" : "cli";
        const prompt = cleanPromptText(rawContent);
        const turnStart = turnUser?.created_at || firstTime || new Date(sess.mtime).toISOString();
        let turnEnd = lastTime || turnStart;
        let finalResponse = "";
        let memSkillActive = false;
        const pendingQueue = [];
        const steps = [];
        const counts = { code: 0, search: 0, browser: 0, git: 0, infra: 0, media: 0, subagent: 0, terminal: 0 };

        for (const item of turnItems) {
            if (item.created_at) turnEnd = item.created_at;
            if (item.type === "PLANNER_RESPONSE" || item.source === "MODEL") {
                if (Array.isArray(item.tool_calls) && item.tool_calls.length) {
                    finalResponse = "";
                    for (const tc of item.tool_calls) {
                        const info = classifyTool(tc.name || "tool", tc.args || {});
                        counts[info.category] = (counts[info.category] || 0) + 1;
                        if (info.memSkill) memSkillActive = true;
                        const entry = {
                            id: `${steps.length + 1}`,
                            name: tc.name || "tool",
                            category: info.category,
                            summary: info.summary,
                            detail: info.detail,
                            time: item.created_at || turnEnd,
                            status: "running",
                            error: ""
                        };
                        steps.push(entry);
                        pendingQueue.push(entry);
                    }
                } else if (item.type === "GENERIC") {
                    finalResponse = "";
                    const t = pendingQueue.shift();
                    const isErr = item.status === "ERROR" || Boolean(item.error);
                    if (t) {
                        t.status = isErr ? "error" : "done";
                        t.error = isErr ? String(item.error || item.content || "Error").slice(0, 200) : "";
                    }
                } else if (item.content) {
                    finalResponse = String(item.content);
                }
            }
        }

        const ageMs = now - sess.mtime;
        const agyLive = liveCluster.host.agyProcs > 0;
        const isFresh = ageMs < (agyLive ? 300000 : 90000);
        const isRunning = isFresh && (!finalResponse || pendingQueue.length > 0);
        const hasErrors = steps.some((s) => s.status === "error");
        if (!isRunning) pendingQueue.forEach((p) => { p.status = hasErrors ? "error" : "done"; });

        const activeTools = isRunning ? [...new Set(steps.filter((s) => s.status === "running").map((s) => s.category))] : [];
        const errorTools = [...new Set(steps.filter((s) => s.status === "error").map((s) => s.category))];
        const status = isRunning ? "running" : (hasErrors && !finalResponse ? "error" : "done");

        tasks.push({
            id: sess.id,
            shortId: sess.id.slice(0, 8),
            title: `${channel === "whatsapp" ? "#WA" : "#CLI"} ${cutStr(prompt, 24)}`,
            prompt,
            channel,
            engine: "agy",
            status,
            statusLabel: status === "running" ? "Berjalan" : (status === "error" ? "Error" : "Selesai"),
            phase: isRunning ? (activeTools.length ? "tool" : "thinking") : (status === "error" ? "error" : "done"),
            stepCount: steps.length,
            startTimeIso: turnStart,
            duration: formatDuration(turnStart, isRunning ? new Date().toISOString() : turnEnd),
            tokenStr: totalTokens > 0 ? (totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : String(totalTokens)) : "--",
            model,
            account: activeAcctInfo,
            responseSnippet: finalResponse ? finalResponse.slice(0, 260) : (isRunning ? "Sedang memproses instruksi…" : "Selesai."),
            counts,
            activeTools,
            errorTools,
            memSkillActive,
            steps: steps.slice(-24),
            lastUpdated: lastTime || new Date(sess.mtime).toISOString()
        });
    }

    return tasks;
}

function readWaStoredTasks(activeAcctInfo) {
    const raw = readJsonSafe(WA_TASKS_FILE, []);
    if (!Array.isArray(raw)) return [];
    return raw.map((t) => {
        const counts = { code: 0, search: 0, browser: 0, git: 0, infra: 0, media: 0, subagent: 0, terminal: 0 };
        const steps = (t.steps || []).map((s, idx) => {
            const info = classifyTool(s.name || "terminal", {});
            counts[info.category] = (counts[info.category] || 0) + 1;
            return { ...s, id: String(idx + 1), category: info.category };
        });
        return {
            ...t,
            account: t.account || activeAcctInfo,
            counts,
            activeTools: t.status === "running" && steps.length ? [steps[steps.length - 1].category] : [],
            errorTools: t.status === "error" && steps.length ? [steps[steps.length - 1].category] : [],
            memSkillActive: false,
            steps
        };
    });
}

async function probeLocalHost() {
    try {
        const [psOut, waRes] = await Promise.all([
            execFileAsync("bash", ["-lc", 'who 2>/dev/null | wc -l; echo "---"; ps -eo pid,comm,args --no-headers | grep -E "agy|chromium|google-chrome" | grep -v grep | head -n 12'], { timeout: 2500, encoding: "utf8" }).catch(() => ({ stdout: "0\n---\n" })),
            queryControlBridge("/status", "GET")
        ]);

        const [termRaw, procsRaw = ""] = (psOut.stdout || "").split("---");
        const lines = procsRaw.trim().split("\n").filter(Boolean);
        liveCluster.host = {
            agyProcs: lines.filter((l) => /\bagy\b/.test(l)).length,
            browserProcs: lines.filter((l) => /chromium|google-chrome/i.test(l)).length,
            terminals: parseInt((termRaw || "0").trim(), 10) || 0,
            activeCmds: lines.slice(0, 6).map((l) => l.trim().slice(0, 96)),
            updatedAt: new Date().toISOString()
        };

        if (waRes && waRes.ok) {
            liveCluster.waBot = {
                status: waRes.status,
                registered: Boolean(waRes.registered),
                mode: waRes.mode || "public",
                botNumber: waRes.botNumber || "",
                lastPairingCode: waRes.lastPairingCode || "",
                lastError: waRes.lastError || ""
            };
        } else {
            liveCluster.waBot = { ...liveCluster.waBot, status: "offline" };
        }
    } catch (_) {}
}

function getTaskMapData() {
    startTaskMapMonitor();
    const quotaSnap = getQuotaSnapshot();
    const activeAcct = (quotaSnap.accounts || []).find((a) => a.isActive);
    const activeAcctInfo = activeAcct
        ? { alias: activeAcct.alias, email: activeAcct.email }
        : { alias: quotaSnap.activeAccount || "utama", email: quotaSnap.activeEmail || "--" };

    const waTasks = readWaStoredTasks(activeAcctInfo);
    const brainTasks = readTranscriptTasks(activeAcctInfo, quotaSnap.activeModel);

    const allTasks = [...waTasks, ...brainTasks]
        .sort((a, b) => {
            if (a.status === "running" && b.status !== "running") return -1;
            if (b.status === "running" && a.status !== "running") return 1;
            return new Date(b.lastUpdated || 0).getTime() - new Date(a.lastUpdated || 0).getTime();
        })
        .slice(0, 12);

    const activeTask = allTasks.find((t) => t.status === "running") || allTasks[0] || null;
    return {
        tasks: allTasks,
        activeTaskId: activeTask ? activeTask.id : null,
        cluster: liveCluster,
        activeAccount: activeAcctInfo,
        serverTime: new Date().toISOString()
    };
}

function emitIfChanged(force = false) {
    if (taskMapEvents.listenerCount("update") === 0) return;
    try {
        const data = getTaskMapData();
        const digest = JSON.stringify({
            activeTaskId: data.activeTaskId,
            cluster: data.cluster,
            tasks: data.tasks.map((t) => [t.id, t.status, t.stepCount, t.lastUpdated])
        });
        if (force || digest !== lastDigest) {
            lastDigest = digest;
            taskMapEvents.emit("update", data);
        }
    } catch (_) {}
}

function scheduleEmit() {
    if (debounceTimer || taskMapEvents.listenerCount("update") === 0) return;
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        emitIfChanged();
    }, 220);
}

function watchPath(key, target) {
    if (watchers.has(key) || !fs.existsSync(target)) return;
    try {
        const w = fs.watch(target, { persistent: false }, () => scheduleEmit());
        w.on("error", () => {
            watchers.delete(key);
            try { w.close(); } catch (_) {}
        });
        watchers.set(key, w);
    } catch (_) {}
}

function startTaskMapMonitor() {
    if (!probeTimer) {
        probeLocalHost().then(() => emitIfChanged());
        watchPath("wa-tasks", DATA_DIR);
        watchPath("brain", BRAIN_DIR);
        probeTimer = setInterval(async () => {
            await probeLocalHost();
            emitIfChanged();
        }, 2500);
        probeTimer.unref();
    }
    if (!watchTimer) {
        watchTimer = setInterval(() => {
            if (taskMapEvents.listenerCount("update") > 0) emitIfChanged();
        }, 1200);
        watchTimer.unref();
    }
}

function getClusterSnapshot() {
    startTaskMapMonitor();
    return liveCluster;
}

function subscribeTaskMap(listener) {
    startTaskMapMonitor();
    taskMapEvents.on("update", listener);
    return () => taskMapEvents.off("update", listener);
}

module.exports = {
    getTaskMapData,
    getClusterSnapshot,
    subscribeTaskMap,
    startTaskMapMonitor,
    classifyTool
};
