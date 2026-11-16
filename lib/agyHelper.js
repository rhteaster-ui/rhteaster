/**
 * agyHelper.js - Streaming Antigravity CLI (agy) Runner, Session Persistence, 429 Auto-Switch & Live Telemetry
 */

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DATA_DIR, ensureDir, loadConfig, loadSettings, readJsonSafe } = require("./configStore");
const accountManager = require("./accountManager");

const TASKS_FILE = path.join(DATA_DIR, "wa_tasks.json");

const AVAILABLE_MODELS = [
    { num: "1", id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { num: "2", id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { num: "3", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { num: "4", id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { num: "5", id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { num: "6", id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { num: "7", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { num: "8", id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { num: "9", id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
    { num: "10", id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
    { num: "11", id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }
];

const chatSessions = new Map();       // sessionKey -> { conversationId, lastActive }
const activeProcesses = new Map();    // taskId / chatId -> childProcess
const activeTasks = new Map();        // taskId -> metadata for Task Map & .stop

function persistTasksSnapshot() {
    try {
        ensureDir(DATA_DIR);
        const existing = readJsonSafe(TASKS_FILE, []);
        const prevMap = new Map(Array.isArray(existing) ? existing.map((t) => [t.id, t]) : []);
        for (const [id, task] of activeTasks.entries()) {
            prevMap.set(id, task);
        }
        const sorted = Array.from(prevMap.values())
            .sort((a, b) => new Date(b.lastUpdated || 0) - new Date(a.lastUpdated || 0))
            .slice(0, 12);
        fs.writeFileSync(TASKS_FILE, JSON.stringify(sorted, null, 2));
    } catch (_) {}
}

function getAgyBinPath(configuredBin = "agy") {
    if (configuredBin && path.isAbsolute(configuredBin) && fs.existsSync(configuredBin)) {
        return configuredBin;
    }
    const home = process.env.HOME || os.homedir();
    const candidates = [
        path.join(home, ".local", "bin", "agy"),
        "/usr/local/bin/agy",
        "/usr/bin/agy"
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    try {
        const found = execFileSync("which", [configuredBin || "agy"], { encoding: "utf8", timeout: 2000 }).trim();
        if (found) return found;
    } catch (_) {}
    return "agy";
}

function checkAgyStatus(configuredBin = "agy") {
    const binPath = getAgyBinPath(configuredBin);
    const isInstalled = Boolean(fs.existsSync(binPath) || (binPath === "agy" && (() => {
        try { execFileSync("which", ["agy"], { timeout: 1500 }); return true; } catch (_) { return false; }
    })()));

    const activeInfo = accountManager.getActiveAccountInfo();
    const { accounts } = accountManager.listAccounts();

    return {
        binPath,
        isInstalled,
        isLoggedIn: Boolean(activeInfo || accounts.length > 0),
        authEmail: activeInfo?.email || accounts[0]?.email || null,
        accountsCount: accounts.length
    };
}

function clearChatSession(chatId) {
    let cleared = 0;
    for (const key of Array.from(chatSessions.keys())) {
        if (key.startsWith(`${chatId}::`)) {
            chatSessions.delete(key);
            cleared++;
        }
    }
    return cleared;
}

function cancelTasksForChat(chatId) {
    let stopped = 0;
    for (const [key, proc] of Array.from(activeProcesses.entries())) {
        if (key === chatId || String(key).startsWith(`${chatId}_`)) {
            try { proc.kill("SIGTERM"); } catch (_) {}
            stopped++;
            activeProcesses.delete(key);
        }
    }
    for (const [taskId, task] of activeTasks.entries()) {
        if (task.chatId === chatId && task.status === "running") {
            task.status = "error";
            task.statusLabel = "Dibatalkan";
            task.lastUpdated = new Date().toISOString();
            activeTasks.set(taskId, task);
        }
    }
    persistTasksSnapshot();
    return stopped;
}

function formatToolStep(stepNum, toolName, params = {}, toolSummary = "") {
    const num = `[${String(stepNum).padStart(2, "0")}]`;
    if (toolSummary) return `${num} ${toolSummary}`;

    switch (toolName) {
        case "search_web":
            return `${num} Menelusuri web: "${String(params.query || "").slice(0, 40)}"`;
        case "run_command": {
            const cmd = String(params.CommandLine || "").replace(/\n/g, " ").trim();
            if (cmd.includes("curl") || cmd.includes("wget")) return `${num} Mengambil data web/API...`;
            if (cmd.includes("git ")) return `${num} Operasi Git: ${cmd.slice(0, 32)}`;
            if (cmd.includes("pm2 ")) return `${num} Manajemen PM2: ${cmd.slice(0, 32)}`;
            return `${num} Eksekusi shell: ${cmd.slice(0, 35)}`;
        }
        case "read_file":
        case "view_file":
            return `${num} Membaca file: ${params.Path ? path.basename(params.Path) : "berkas"}`;
        case "write_file":
        case "edit_file":
            return `${num} Menulis/mengedit: ${params.Path ? path.basename(params.Path) : "berkas"}`;
        case "invoke_subagent":
            return `${num} Subagen: ${params.Role || params.TypeName || "worker"}`;
        default:
            return `${num} Tool: ${toolName}`;
    }
}

function buildPersona(isOwner, userName, commandType, brandName) {
    if (isOwner) {
        return (
            `Identitas kamu: Kamu adalah ${brandName}, asisten AI DevOps & Personal Agent di WhatsApp yang melayani Owner.\n` +
            `Kewenangan: Akses penuh ke server VPS Linux, bash shell, file sistem, dan pencarian web.\n` +
            `ATURAN OUTPUT: Gunakan format teks WhatsApp yang bersih (*bold*, \`code\`, bullet rapi). Hindari tanda LaTeX ($) dan link file:///... Jangan mengeluarkan pesan status sementara jika mode agen; selesaikan tugas dan berikan satu jawaban akhir yang tuntas.`
        );
    }
    return (
        `Identitas kamu: Kamu adalah ${brandName}, asisten AI cerdas di WhatsApp yang melayani "${userName}" (Pengguna Publik / Tamu).\n` +
        `ATURAN: Panggil pengguna dengan namanya ("${userName}"), ramah, sopan, solutif, tanpa akses rahasia server pribadi Owner.`
    );
}

function pickOutputAttachment(taskDir, inputFiles = []) {
    try {
        const inputBasenames = new Set((inputFiles || []).map((f) => path.basename(f)));
        const files = fs.readdirSync(taskDir);
        const candidates = [];

        for (const file of files) {
            if (inputBasenames.has(file)) continue;
            const fullPath = path.join(taskDir, file);
            const stat = fs.statSync(fullPath);
            if (!stat.isFile() || stat.size === 0) continue;

            const ext = path.extname(file).toLowerCase();
            let mediaType = null;
            let mime = "application/octet-stream";

            if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
                mediaType = "image";
                mime = ext === ".png" ? "image/png" : (ext === ".webp" ? "image/webp" : "image/jpeg");
            } else if ([".mp4", ".mov"].includes(ext)) {
                mediaType = "video";
                mime = "video/mp4";
            } else if ([".mp3", ".ogg", ".wav", ".m4a"].includes(ext)) {
                mediaType = "audio";
                mime = ext === ".mp3" ? "audio/mpeg" : "audio/ogg";
            } else if ([".pdf", ".docx", ".xlsx", ".csv", ".zip", ".json", ".txt", ".html", ".md", ".py", ".js"].includes(ext)) {
                mediaType = "document";
                if (ext === ".pdf") mime = "application/pdf";
                else if (ext === ".zip") mime = "application/zip";
                else if (ext === ".json") mime = "application/json";
                else mime = "text/plain";
            }

            if (mediaType) {
                candidates.push({ path: fullPath, file, size: stat.size, mediaType, mime, mtime: stat.mtimeMs });
            }
        }

        if (!candidates.length) return null;
        candidates.sort((a, b) => b.mtime - a.mtime);
        return candidates[0];
    } catch (_) {
        return null;
    }
}

async function runAgyAgent({
    taskDir,
    commandType = "fast",
    promptText = "",
    inputFiles = [],
    quotedContext = "",
    chatId,
    isOwner = false,
    userName = "Pengguna",
    onStep = null
}) {
    const cfg = loadConfig();
    const settings = loadSettings();
    const agyBin = getAgyBinPath(cfg.agyBin);
    const homeDir = process.env.HOME || os.homedir();

    const accountName = accountManager.getAccountForChat(chatId);
    const profile = accountManager.ensureAccountProfile(accountName);
    const sessionKey = `${chatId}::${accountName}::${isOwner ? "owner" : "guest"}`;
    const existingSession = chatSessions.get(sessionKey);

    const taskId = `wa_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const isAlreadyRunning = Array.from(activeTasks.values()).some((t) => t.chatId === chatId && t.status === "running");
    const isResuming = Boolean(!isAlreadyRunning && existingSession?.conversationId);

    const activeModel = commandType === "fast"
        ? (settings.fastModel || cfg.fastAiModel || "gemini-3.8-flash-low")
        : (settings.currentModel || cfg.defaultAiModel || "gemini-3.8-flash-medium");

    const promptFinal = String(promptText || "").trim() || (inputFiles.length ? "Tolong periksa, analisis, dan jelaskan isi lampiran ini." : "Halo");
    const listInput = inputFiles.length
        ? inputFiles.map((f, i) => `File ${i + 1}: ${path.basename(f)} (${f})`).join("\n")
        : "Tidak ada file lampiran.";
    const quotedBlock = quotedContext ? `\n[Pesan/Konteks yang di-reply]:\n"${quotedContext}"\n` : "";

    let instruction = "";
    if (!isResuming) {
        const persona = buildPersona(isOwner, userName, commandType, cfg.botName || "Agency Client");
        if (commandType === "agen") {
            instruction =
                `${persona}\n\n[AUTONOMOUS AGENT TASK]\nDirektori kerja tugas: ${taskDir}\nWorkspace utama: ${homeDir}\nLampiran:\n${listInput}${quotedBlock}\n\n` +
                `Instruksi dari ${isOwner ? "Owner" : userName}: "${promptFinal}"\n` +
                `Catatan output file: Jika diminta membuat file (.pdf, .txt, .json, .csv, script, dll), simpan di ${taskDir}/<nama_jelas>.<ext> agar otomatis dikirim ke WhatsApp.`;
        } else {
            const filePart = inputFiles.length ? `\nLampiran:\n${listInput}` : "";
            instruction = `${persona}${quotedBlock}${filePart}\n\nPesan: "${promptFinal}"`;
        }
    } else {
        const filePart = inputFiles.length ? `\n[Lampiran Baru]:\n${listInput}` : "";
        instruction = `${quotedBlock}${filePart}\nInstruksi lanjutan dari ${isOwner ? "Owner" : userName}: "${promptFinal}"`;
    }

    const args = [];
    if (isResuming) {
        args.push("--conversation", existingSession.conversationId);
    }
    args.push(
        "--model", activeModel,
        "-p", instruction,
        "--output-format", "stream-json",
        "--dangerously-skip-permissions"
    );
    if (commandType === "fast") {
        args.push("--effort", "low", "--disable-slash-commands");
    }

    const startTimeIso = new Date().toISOString();
    const taskRecord = {
        id: taskId,
        shortId: taskId.slice(-8),
        chatId,
        title: `#WA ${promptFinal.slice(0, 28)}${promptFinal.length > 28 ? "…" : ""}`,
        prompt: promptFinal.slice(0, 180),
        channel: "whatsapp",
        engine: "agy",
        status: "running",
        statusLabel: "Berjalan",
        phase: "thinking",
        stepCount: 0,
        startTimeIso,
        duration: "0s",
        tokenStr: "--",
        model: activeModel,
        account: { alias: accountName, email: accountManager.getActiveAccountInfo()?.email || "" },
        steps: [],
        lastUpdated: startTimeIso
    };
    activeTasks.set(taskId, taskRecord);
    persistTasksSnapshot();

    return new Promise((resolve) => {
        const child = spawn(agyBin, args, {
            cwd: taskDir,
            env: {
                ...process.env,
                HOME: profile.profileHome,
                PATH: `${path.join(homeDir, ".local", "bin")}:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`
            }
        });

        activeProcesses.set(`${chatId}_${taskId}`, child);
        activeProcesses.set(chatId, child);

        let convId = existingSession?.conversationId || null;
        let finalResponse = "";
        let streamedResponse = "";
        let errText = "";
        let stderr = "";
        let stepCount = 0;
        let timedOut = false;

        const timeoutMs = Number(cfg.agentTimeoutMs) || 1800000;
        const timer = setTimeout(() => {
            timedOut = true;
            errText = `Batas waktu eksekusi (${Math.round(timeoutMs / 60000)} menit) tercapai.`;
            try { child.kill("SIGTERM"); } catch (_) {}
            setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 2000);
        }, timeoutMs);

        if (child.stderr) {
            child.stderr.on("data", (d) => { stderr += d.toString(); });
        }

        let buf = "";
        child.stdout.on("data", (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;

                try {
                    const data = JSON.parse(line);
                    if (data.conversation_id) convId = data.conversation_id;

                    if (data.event === "step_update" && data.step_update) {
                        const s = data.step_update;
                        if (s.conversation_id) convId = s.conversation_id;
                        if (s.step_type === "agent_response" && s.text_delta) {
                            streamedResponse += s.text_delta;
                        }
                        if (s.step_type === "tool" && s.state === "ACTIVE") {
                            stepCount++;
                            const text = formatToolStep(stepCount, s.tool_name, s.tool_info?.parameters, s.tool_info?.toolSummary);
                            taskRecord.phase = "tool";
                            taskRecord.stepCount = stepCount;
                            taskRecord.steps.push({
                                id: String(stepCount),
                                name: s.tool_name || "tool",
                                summary: text.replace(/^\[\d+\]\s*/, ""),
                                time: new Date().toISOString(),
                                status: "done"
                            });
                            taskRecord.steps = taskRecord.steps.slice(-20);
                            taskRecord.lastUpdated = new Date().toISOString();
                            persistTasksSnapshot();
                            if (typeof onStep === "function") onStep(text, stepCount);
                        }
                    }

                    if (data.event === "result" && data.result) {
                        if (data.result.conversation_id) convId = data.result.conversation_id;
                        if (data.result.response) finalResponse = data.result.response;
                        if (data.result.status === "ERROR" && !timedOut) {
                            errText = data.result.error || data.result.message || "Agen mengalami kendala eksekusi.";
                        }
                    }

                    if (data.event === "error" && !timedOut) {
                        errText = data.error?.message || data.message || "Error internal runtime AI.";
                    }
                } catch (_) {
                    if (!finalResponse) streamedResponse += line + "\n";
                }
            }
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            activeProcesses.delete(`${chatId}_${taskId}`);
            if (activeProcesses.get(chatId) === child) activeProcesses.delete(chatId);

            if (convId && !isAlreadyRunning) {
                chatSessions.set(sessionKey, { conversationId: convId, lastActive: Date.now() });
            } else if (code !== 0 && isResuming) {
                chatSessions.delete(sessionKey);
            }

            accountManager.syncProfileTokenBack(accountName);
            const outputMedia = pickOutputAttachment(taskDir, inputFiles);
            let output = (finalResponse || streamedResponse).trim();

            if (timedOut) {
                output = `*Kendala Waktu:* ${errText}${output ? `\n\n${output}` : ""}`;
            } else if (!output) {
                if (/RESOURCE_EXHAUSTED|quota reached|429/i.test(stderr)) {
                    const rot = accountManager.autoSwitchNext();
                    if (rot.switched) {
                        chatSessions.delete(sessionKey);
                        output = `*Kuota akun ${rot.from.name || "aktif"} penuh (429).*\nBot otomatis beralih ke akun *${rot.to.name}* (${rot.to.maskedEmail}). Silakan kirim ulang pesan Anda.`;
                    } else {
                        output = `*Kuota AI habis (429).* Ganti model via \`.model 1\` atau cek status akun di Dashboard / \`.akun\`.`;
                    }
                } else if (errText) {
                    output = `*Kendala Agen:* ${errText}`;
                } else if (code !== 0) {
                    output = `*Agen berhenti dengan kode ${code}.*${stderr ? `\n${stderr.trim().slice(0, 300)}` : ""}\nPastikan sudah login via perintah \`agy\` di terminal VPS.`;
                } else {
                    output = "Tugas selesai (tidak ada pesan teks balasan).";
                }
            }

            const endIso = new Date().toISOString();
            const durSec = Math.max(0, Math.round((Date.now() - Date.parse(startTimeIso)) / 1000));
            taskRecord.status = (timedOut || errText || (code !== 0 && !finalResponse)) ? "error" : "done";
            taskRecord.statusLabel = taskRecord.status === "error" ? "Error" : "Selesai";
            taskRecord.phase = taskRecord.status === "error" ? "error" : "done";
            taskRecord.duration = durSec < 60 ? `${durSec}s` : `${Math.floor(durSec / 60)}m ${durSec % 60}s`;
            taskRecord.responseSnippet = output.slice(0, 260);
            taskRecord.lastUpdated = endIso;
            activeTasks.set(taskId, taskRecord);
            persistTasksSnapshot();

            resolve({
                response: output,
                outputMedia,
                stepCount,
                taskId
            });
        });

        child.on("error", (err) => {
            clearTimeout(timer);
            activeProcesses.delete(`${chatId}_${taskId}`);
            taskRecord.status = "error";
            taskRecord.statusLabel = "Error";
            taskRecord.responseSnippet = err.message;
            taskRecord.lastUpdated = new Date().toISOString();
            persistTasksSnapshot();
            resolve({
                response: `*Gagal menjalankan Antigravity CLI:* ${err.message}\nJalankan \`agy\` sekali di terminal VPS untuk memastikan CLI siap.`,
                outputMedia: null,
                stepCount: 0,
                taskId
            });
        });
    });
}

module.exports = {
    AVAILABLE_MODELS,
    getAgyBinPath,
    checkAgyStatus,
    clearChatSession,
    cancelTasksForChat,
    runAgyAgent
};
