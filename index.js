/**
 * WhatsApp Client AI Agent - Main Entrypoint
 * Baileys Multi-Device (8-Digit Pairing Code) + Localhost Control Bridge + Hot Reloader
 * Repository: https://github.com/rhteaster-ui/rhteaster
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { ROOT_DIR, ensureDir, loadConfig, saveConfig, loadSettings, saveSettings } = require("./lib/configStore");
const { cleanNumber, extractMessageText } = require("./lib/utils");
const { startControlBridge } = require("./lib/controlBridge");

let handlerModule = require("./lib/messageHandler");

function hotReloadModules() {
    const reloadTargets = [
        "./lib/messageHandler",
        "./lib/aiRouter",
        "./lib/agyHelper",
        "./lib/userManager",
        "./lib/systemHelper",
        "./lib/nativeTools",
        "./lib/utils"
    ];
    for (const rel of reloadTargets) {
        try {
            const full = require.resolve(rel);
            delete require.cache[full];
        } catch (_) {}
    }
    handlerModule = require("./lib/messageHandler");
    return true;
}

const AUTH_DIR = path.join(ROOT_DIR, "session_auth");
ensureDir(AUTH_DIR);
ensureDir(path.join(ROOT_DIR, "logs"));

function askQuestion(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(query, (ans) => {
            rl.close();
            resolve(ans.trim());
        });
    });
}

let activeSock = null;
let isConnecting = false;
let retryCount = 0;
let reconnectTimer = null;

const waRuntime = {
    status: "starting", // starting | connecting | awaiting_pairing | open | logged_out | close
    registered: false,
    botNumber: loadConfig().botNumber || "",
    lastPairingCode: "",
    lastPairingAt: null,
    lastError: "",
    connectedAt: null
};

async function requestPairingForNumber(rawPhone) {
    const cleanPhone = cleanNumber(rawPhone);
    if (!cleanPhone || cleanPhone.length < 8) {
        return { ok: false, error: "Nomor WhatsApp tidak valid (contoh: 628123456789)." };
    }

    const cfg = saveConfig({ botNumber: cleanPhone });
    waRuntime.botNumber = cleanPhone;

    // Jika sebelumnya logged out atau sudah terdaftar, reset sesi lama terlebih dahulu agar pairing baru bersih
    if (waRuntime.status === "logged_out" || (activeSock?.authState?.creds?.registered)) {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        ensureDir(AUTH_DIR);
        waRuntime.registered = false;
        if (activeSock) {
            try { activeSock.end(undefined); } catch (_) {}
            activeSock = null;
        }
        await startBot();
        await new Promise((r) => setTimeout(r, 2500));
    } else if (!activeSock || waRuntime.status === "close") {
        await startBot();
        await new Promise((r) => setTimeout(r, 2500));
    }

    if (!activeSock) {
        return { ok: false, error: "Socket WhatsApp belum siap. Coba lagi dalam beberapa detik." };
    }

    if (activeSock.authState?.creds?.registered) {
        return { ok: false, error: "WhatsApp sudah terhubung. Lakukan Reset Sesi jika ingin ganti nomor." };
    }

    try {
        const rawCode = await activeSock.requestPairingCode(cleanPhone);
        const formatted = rawCode?.match(/.{1,4}/g)?.join("-") || rawCode;
        waRuntime.lastPairingCode = formatted;
        waRuntime.lastPairingAt = new Date().toISOString();
        waRuntime.status = "awaiting_pairing";
        waRuntime.lastError = "";

        console.log("\n=======================================================");
        console.log(`KODE PAIRING WHATSAPP (+${cleanPhone}): ${formatted}`);
        console.log("Buka WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon saja");
        console.log("=======================================================\n");

        return { ok: true, pairingCode: formatted, botNumber: cleanPhone };
    } catch (err) {
        waRuntime.lastError = err.message;
        return { ok: false, error: `Gagal meminta pairing code: ${err.message}` };
    }
}

async function startBot() {
    if (isConnecting) return;
    isConnecting = true;
    clearTimeout(reconnectTimer);

    const cfg = loadConfig();
    ensureDir(AUTH_DIR);
    waRuntime.status = "connecting";
    waRuntime.botNumber = cfg.botNumber || "";

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
            version: [2, 3000, 1015901307],
            isLatest: true
        }));

        console.log(`[BAILEYS] Versi: v${version.join(".")} (Latest: ${isLatest})`);

        const sock = makeWASocket({
            version,
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            browser: ["Ubuntu", "Chrome", "124.0.0"],
            generateHighQualityLinkPreview: true,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });

        activeSock = sock;
        waRuntime.registered = Boolean(sock.authState.creds.registered);

        if (!sock.authState.creds.registered) {
            waRuntime.status = "awaiting_pairing";
            let targetNumber = cleanNumber(cfg.botNumber || process.env.BOT_NUMBER);

            // Jika berjalan interaktif di terminal (npm start / npm run pair) dan nomor belum disetel
            if (!targetNumber && process.stdin.isTTY && !process.env.pm_id) {
                console.log("\n=======================================================");
                console.log("   SETUP AWAL WHATSAPP BOT CLIENT (PAIRING CODE)");
                console.log("=======================================================");
                targetNumber = cleanNumber(await askQuestion("Masukkan Nomor WhatsApp Bot Anda (cth: 628123456789): "));
                if (targetNumber) {
                    saveConfig({ botNumber: targetNumber });
                    waRuntime.botNumber = targetNumber;
                }
            }

            if (targetNumber) {
                setTimeout(() => {
                    if (activeSock === sock && !sock.authState.creds.registered) {
                        requestPairingForNumber(targetNumber).catch(() => {});
                    }
                }, 2600);
            } else {
                console.log("[PAIRING] Nomor bot belum disetel. Buka Web Dashboard untuk meminta Pairing Code.");
            }
        }

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "connecting") {
                waRuntime.status = sock.authState.creds.registered ? "connecting" : "awaiting_pairing";
            }

            if (connection === "close") {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === DisconnectReason.loggedOut;
                waRuntime.status = loggedOut ? "logged_out" : "close";
                waRuntime.registered = Boolean(sock.authState.creds.registered && !loggedOut);

                if (loggedOut) {
                    waRuntime.lastError = "Sesi WhatsApp logout. Reset sesi atau minta Pairing Code ulang.";
                    console.log("[WA] Sesi telah logout. Reset sesi dari Dashboard atau hapus folder session_auth.");
                } else {
                    retryCount++;
                    const delayMs = Math.min(30000, 3000 * retryCount);
                    console.log(`[WA] Terputus (${statusCode || "?"}). Menyambung ulang dalam ${delayMs / 1000}s...`);
                    reconnectTimer = setTimeout(startBot, delayMs);
                }
            } else if (connection === "open") {
                isConnecting = false;
                retryCount = 0;
                waRuntime.status = "open";
                waRuntime.registered = true;
                waRuntime.lastPairingCode = "";
                waRuntime.lastError = "";
                waRuntime.connectedAt = new Date().toISOString();

                const liveCfg = loadConfig();
                const settings = loadSettings();
                console.log("\n=======================================================");
                console.log("WHATSAPP AGENT BOT ONLINE!");
                console.log(`Bot Number : ${liveCfg.botNumber || sock.user?.id || "Aktif"}`);
                console.log(`Owner      : ${liveCfg.ownerNumber || "Belum disetel"}`);
                console.log(`Model AI   : ${settings.currentModel}`);
                console.log("=======================================================\n");

                if (liveCfg.ownerNumber && !process.env.SKIP_STARTUP_NOTIFY) {
                    const ownerJid = `${cleanNumber(liveCfg.ownerNumber)}@s.whatsapp.net`;
                    sock.sendMessage(ownerJid, {
                        text: `*${liveCfg.botName || "BOT AGENT"} ONLINE!*\nBot WhatsApp & Web Ops Dashboard siap digunakan.\nKetik *${liveCfg.prefix || "."}menu* untuk melihat fitur lengkap.`
                    }).catch(() => {});
                }
            }
        });

        sock.ev.on("messages.upsert", async (m) => {
            if (m.type !== "notify" || !m.messages || !m.messages.length) return;
            for (const msg of m.messages) {
                if (!msg.message || msg.key.fromMe) continue;
                const rawText = extractMessageText(msg);
                try {
                    await handlerModule.handleIncomingMessage(sock, msg, rawText, loadConfig(), {
                        hotReload: hotReloadModules
                    });
                } catch (err) {
                    console.error("[HANDLER ERROR]", err);
                }
            }
        });
    } catch (err) {
        isConnecting = false;
        waRuntime.status = "close";
        waRuntime.lastError = err.message;
        console.error("[START BOT ERR]", err.message);
        reconnectTimer = setTimeout(startBot, 5000);
    }
}

startControlBridge({
    getStatus: async () => {
        const cfg = loadConfig();
        const settings = loadSettings();
        return {
            ok: true,
            status: waRuntime.status,
            registered: waRuntime.registered,
            botNumber: cfg.botNumber || cleanNumber(activeSock?.user?.id || "") || "",
            ownerNumber: cfg.ownerNumber || "",
            mode: settings.isPrivateMode ? "private" : "public",
            activeModel: settings.currentModel,
            lastPairingCode: waRuntime.lastPairingCode,
            lastPairingAt: waRuntime.lastPairingAt,
            connectedAt: waRuntime.connectedAt,
            lastError: waRuntime.lastError
        };
    },
    requestPair: async (phone) => requestPairingForNumber(phone),
    logoutSession: async () => {
        try {
            if (activeSock) {
                try { await activeSock.logout(); } catch (_) {}
                try { activeSock.end(undefined); } catch (_) {}
                activeSock = null;
            }
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            ensureDir(AUTH_DIR);
            waRuntime.status = "awaiting_pairing";
            waRuntime.registered = false;
            waRuntime.lastPairingCode = "";
            waRuntime.lastError = "";
            setTimeout(() => startBot(), 800);
            return { ok: true, message: "Sesi WhatsApp berhasil direset." };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },
    setMode: async (mode) => {
        const isPriv = mode === "private";
        saveSettings({ isPrivateMode: isPriv });
        return { ok: true, mode: isPriv ? "private" : "public" };
    }
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

startBot().catch((err) => {
    console.error("[FATAL START ERROR]", err);
});
