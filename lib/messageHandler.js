/**
 * messageHandler.js - Client WhatsApp AI Agent Command & Multimodal Router
 * Parity features: .agen (streaming steps), .ai, $/sh shell, .model, .akun/.switch/.saveakun,
 * .private/.public, .self, .status/.pm2, .dns/.toimg/.hdstatus, .stop/.reset/.reload/.restart
 */

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");

const { ROOT_DIR, ensureDir, loadConfig, loadSettings, saveSettings } = require("./configStore");
const {
    cleanNumber,
    isOwnerSender,
    extractQuotedText,
    extractMediaAttachment,
    splitWhatsAppChunks
} = require("./utils");
const aiRouter = require("./aiRouter");
const agyHelper = require("./agyHelper");
const accountManager = require("./accountManager");
const userManager = require("./userManager");
const { getFormattedVpsStatus } = require("./systemHelper");
const { resolveDnsRecords, convertStickerToPng, optimizeMediaForStatus } = require("./nativeTools");

const TEMP_TASKS_DIR = path.join(ROOT_DIR, "temp_tasks");
ensureDir(TEMP_TASKS_DIR);

async function downloadBaileysMedia(attachment, destPath) {
    const stream = await downloadContentFromMessage(attachment.node, attachment.type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(destPath, buffer);
    return buffer;
}

async function sendSplitReply(sock, remoteJid, text, quotedMsg) {
    const chunks = splitWhatsAppChunks(text, 3500);
    for (let i = 0; i < chunks.length; i++) {
        await sock.sendMessage(
            remoteJid,
            { text: chunks[i] },
            i === 0 && quotedMsg ? { quoted: quotedMsg } : undefined
        );
        if (i < chunks.length - 1) {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
}

async function sendMediaFile(sock, remoteJid, media, caption, quotedMsg) {
    if (!media || !fs.existsSync(media.path)) return;
    const buffer = fs.readFileSync(media.path);
    const opts = quotedMsg ? { quoted: quotedMsg } : undefined;
    if (media.mediaType === "image") {
        await sock.sendMessage(remoteJid, { image: buffer, caption: caption || media.file }, opts);
    } else if (media.mediaType === "video") {
        await sock.sendMessage(remoteJid, { video: buffer, caption: caption || media.file }, opts);
    } else if (media.mediaType === "audio") {
        await sock.sendMessage(remoteJid, { audio: buffer, mimetype: media.mime }, opts);
    } else {
        await sock.sendMessage(remoteJid, {
            document: buffer,
            mimetype: media.mime || "application/octet-stream",
            fileName: media.file,
            caption: caption || undefined
        }, opts);
    }
}

function buildMenuText(pushName, isOwner, config, settings) {
    const p = config.prefix || ".";
    const modelObj = agyHelper.AVAILABLE_MODELS.find((m) => m.id === settings.currentModel);
    const activeAcc = accountManager.getActiveAccountName();

    return (
        `*${config.botName || "AGENCY AI BOT"}*\n` +
        `Halo *${pushName}* · Akses: *${isOwner ? "Owner (Penuh)" : "Pengguna"}*\n` +
        `Model: \`${modelObj ? modelObj.name : settings.currentModel}\` · Akun: \`${activeAcc}\`\n\n` +
        `*AI & AGENT OTONOM*\n` +
        `• \`${p}agen <tugas>\` — Agen koding, riset web, kelola file/PDF & VPS (live progress)\n` +
        `• \`${p}ai <tanya>\` — Tanya jawab kilat & analisis foto/dokumen\n` +
        `• \`${p}stop\` / \`${p}reset\` — Hentikan proses / reset memori obrolan\n\n` +
        `*MODEL & AKUN AI*\n` +
        `• \`${p}model [nomor/nama]\` — Lihat atau ganti model AI Gemini/Claude\n` +
        `• \`${p}akun\` / \`${p}switch <nomor>\` — Daftar & pindah akun Google AGY\n` +
        `• \`${p}saveakun <alias>\` — Simpan login aktif ke daftar pool akun\n` +
        `• \`${p}agy\` — Cek status login Antigravity CLI\n\n` +
        `*UTILITY & MEDIA*\n` +
        `• \`${p}dns <domain>\` — Cek DNS record domain\n` +
        `• \`${p}toimg\` — Reply stiker untuk diubah ke gambar PNG\n` +
        `• \`${p}hdstatus\` — Optimasi foto/video status WA jernih\n\n` +
        (isOwner
            ? `*OWNER DEVOPS & PRIVASI*\n` +
              `• \`$ <bash>\` atau \`${p}sh <bash>\` — Jalankan terminal VPS\n` +
              `• \`${p}status\` / \`${p}pm2\` — Cek beban CPU, RAM, Disk & PM2\n` +
              `• \`${p}private\` / \`${p}public\` — Kunci atau buka akses bot publik\n` +
              `• \`${p}self on\` / \`${p}self off\` — Mute/unmute bot di grup ini\n` +
              `• \`${p}reload\` / \`${p}restart\` — Hot reload kode / restart PM2\n`
            : `_Ketik perintah di atas atau kirim foto/PDF untuk langsung dianalisis._`)
    );
}

async function handleIncomingMessage(sock, msg, rawText, runtimeConfig, callbacks = {}) {
    const config = loadConfig();
    const settings = loadSettings();

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid || remoteJid === "status@broadcast") return;

    const isGroup = remoteJid.endsWith("@g.us");
    const senderJid = msg.key.participant || remoteJid;
    const isOwner = isOwnerSender(senderJid, config);
    const pushName = msg.pushName || (isOwner ? "Owner" : "Pengguna");

    userManager.recordUser(senderJid, pushName);

    // Cek privasi & group mute (Owner tetap tembus untuk mengontrol bot!)
    if (!isOwner) {
        if (userManager.isPrivateMode()) return;
        if (isGroup && userManager.isGroupMuted(remoteJid)) return;
    }

    const text = String(rawText || "").trim();
    const attachment = extractMediaAttachment(msg);
    if (!text && !attachment) return;

    const reply = (content) => sendSplitReply(sock, remoteJid, content, msg);
    const react = async (emoji) => {
        try { await sock.sendMessage(remoteJid, { react: { text: emoji, key: msg.key } }); } catch (_) {}
    };

    // 1. TERMINAL SHELL SHORTCUTS ($ cmd, > cmd, .sh cmd, .bash cmd) — Owner Only
    const isDollarShell = text.startsWith("$ ") || text.startsWith("> ");
    const prefix = config.prefix || ".";
    const isDotCmd = text.startsWith(prefix);
    const cmdBody = isDotCmd ? text.slice(prefix.length).trim() : "";
    const [rawCmd, ...args] = cmdBody.split(/\s+/);
    const cmd = isDotCmd ? (rawCmd || "").toLowerCase() : "";
    const query = args.join(" ").trim();

    if (isDollarShell || (isDotCmd && (cmd === "sh" || cmd === "bash" || cmd === "exec"))) {
        if (!isOwner) {
            return await reply("Akses ditolak. Perintah terminal hanya tersedia untuk Owner.");
        }
        const shellCmd = isDollarShell ? text.slice(2).trim() : query;
        if (!shellCmd) {
            return await reply(`Contoh: \`$ pm2 status\` atau \`${prefix}sh df -h\``);
        }

        const isSelfRestart = /(?:pm2\s+(?:restart|reload)\s+(?:wa-bot|all)|reboot)/i.test(shellCmd);
        if (isSelfRestart) {
            await reply(`Menjalankan restart: \`${shellCmd}\`... Bot akan kembali aktif dalam beberapa detik.`);
            setTimeout(() => { exec(shellCmd, () => {}); }, 1200);
            return;
        }

        exec(shellCmd, { cwd: ROOT_DIR, timeout: 60000, maxBuffer: 5 * 1024 * 1024 }, async (err, stdout, stderr) => {
            const combined = [stdout, stderr].filter(Boolean).join("\n").trim() || (err ? err.message : "(Selesai, exit code 0)");
            if (combined.length > 3500) {
                const filePath = path.join(TEMP_TASKS_DIR, `terminal_${Date.now()}.txt`);
                fs.writeFileSync(filePath, `$ ${shellCmd}\n\n${combined}`);
                await reply(`*OUTPUT TERMINAL ($ ${shellCmd.slice(0, 60)})*\n\n\`\`\`\n${combined.slice(0, 1200)}\n...\n\`\`\`\n_Output penuh (${combined.length} karakter) terlampir._`);
                await sendMediaFile(sock, remoteJid, { path: filePath, file: "terminal_output.txt", mediaType: "document", mime: "text/plain" }, null, msg);
                try { fs.unlinkSync(filePath); } catch (_) {}
            } else {
                await reply(`*$ ${shellCmd}*\n\`\`\`\n${combined}\n\`\`\``);
            }
        });
        return;
    }

    // 2. COMMANDS
    if (isDotCmd) {
        if (cmd === "menu" || cmd === "help" || cmd === "panduan") {
            return await reply(buildMenuText(pushName, isOwner, config, settings));
        }

        if (cmd === "ping" || cmd === "speed") {
            const t0 = Date.now();
            return await reply(`*Pong!*\n• Latensi handler: *${Date.now() - t0} ms*\n• Mode: *${userManager.isPrivateMode() ? "Private" : "Public"}*\n• Dashboard Port: *${config.dashboardPort || 3000}*`);
        }

        if (cmd === "status" || cmd === "stats" || cmd === "vps" || cmd === "pm2") {
            return await reply(getFormattedVpsStatus(config.dashboardPort || 3000));
        }

        if (cmd === "agy") {
            const st = agyHelper.checkAgyStatus(config.agyBin);
            const txt =
                `*STATUS ANTIGRAVITY AI ENGINE*\n\n` +
                `• Binary: \`${st.binPath}\`\n` +
                `• Terpasang: *${st.isInstalled ? "Ya" : "Belum"}*\n` +
                `• Login Google: *${st.isLoggedIn ? `Aktif (${st.authEmail})` : "Belum Login"}*\n` +
                `• Pool Akun: *${st.accountsCount} akun*\n\n` +
                (!st.isLoggedIn ? "_Jalankan perintah `agy` di terminal VPS untuk login Google sekali saja._" : "_Engine AI siap digunakan._");
            return await reply(txt);
        }

        if (cmd === "model") {
            if (!query) {
                const lines = agyHelper.AVAILABLE_MODELS.map((m) =>
                    `${m.id === settings.currentModel ? "👉" : "•"} *${m.num}.* ${m.name} (\`${m.id}\`)`
                ).join("\n");
                return await reply(`*DAFTAR MODEL AI AKTIF*\nModel saat ini: \`${settings.currentModel}\`\n\n${lines}\n\nGanti dengan: \`${prefix}model <nomor/nama>\``);
            }
            if (!isOwner) return await reply("Hanya Owner yang dapat mengganti model AI.");
            const q = query.toLowerCase();
            const picked = agyHelper.AVAILABLE_MODELS.find((m) => m.num === q || m.id === q || m.name.toLowerCase().includes(q) || m.id.includes(q));
            if (!picked) return await reply(`Model "${query}" tidak ditemukan. Ketik \`${prefix}model\` untuk melihat daftar.`);
            saveSettings({ currentModel: picked.id });
            return await reply(`Model AI aktif diubah ke: *${picked.name}* (\`${picked.id}\`)`);
        }

        if (cmd === "akun" || cmd === "accounts" || cmd === "kuota" || cmd === "quota") {
            const { accounts } = accountManager.listAccounts();
            if (!accounts.length) {
                return await reply("Belum ada akun AI tersimpan. Jalankan `agy` di terminal VPS untuk login Google terlebih dahulu.");
            }
            const rows = accounts.map((a) => `${a.isActive ? "👉 [AKTIF]" : "•"} *${a.index}.* ${a.name} (\`${a.maskedEmail}\`)`).join("\n");
            return await reply(`*POOL AKUN ANTIGRAVITY*\n\n${rows}\n\nPindah akun: \`${prefix}switch <nomor/nama>\`\nSimpan login baru: \`${prefix}saveakun <nama>\`\nDetail kuota lengkap tersedia di Web Dashboard.`);
        }

        if (cmd === "switch") {
            if (!isOwner) return await reply("Hanya Owner yang dapat mengganti akun AI.");
            if (!query) return await reply(`Gunakan: \`${prefix}switch <nomor/nama>\``);
            const res = accountManager.switchAccount(query);
            if (!res.success) return await reply(`Gagal pindah akun: ${res.error}`);
            agyHelper.clearChatSession(remoteJid);
            return await reply(`Berhasil beralih ke akun *${res.account.name}* (\`${res.account.maskedEmail}\`).`);
        }

        if (cmd === "saveakun") {
            if (!isOwner) return await reply("Hanya Owner yang dapat menyimpan profil akun.");
            if (!query) return await reply(`Gunakan: \`${prefix}saveakun <nama_alias>\``);
            const res = accountManager.saveCurrentAs(query);
            return await reply(res.success ? `Token aktif disimpan sebagai profil *${res.name}* (${res.email}).` : `Gagal: ${res.error}`);
        }

        if (cmd === "delakun") {
            if (!isOwner) return await reply("Hanya Owner yang dapat menghapus profil akun.");
            const res = accountManager.deleteAccount(query);
            return await reply(res.success ? `Akun *${res.account.name}* dihapus dari pool.` : `Gagal: ${res.error}`);
        }

        if (cmd === "private" || cmd === "public" || cmd === "mode") {
            if (!isOwner && cmd !== "mode") return await reply("Hanya Owner yang dapat mengubah mode privasi.");
            if (cmd === "private" || query === "private") {
                userManager.setPrivateMode(true);
                return await reply("Mode *PRIVATE* aktif. Hanya Owner yang dapat mengakses bot.");
            }
            if (cmd === "public" || query === "public") {
                userManager.setPrivateMode(false);
                return await reply("Mode *PUBLIC* aktif. Pengguna dapat berinteraksi dengan bot.");
            }
            return await reply(`Status mode saat ini: *${userManager.isPrivateMode() ? "PRIVATE (Owner Only)" : "PUBLIC"}*`);
        }

        if (cmd === "self") {
            if (!isOwner) return await reply("Hanya Owner yang dapat mengatur mute grup.");
            if (!isGroup) return await reply("Perintah `.self` khusus untuk grup WhatsApp.");
            if (query === "on") {
                userManager.setGroupMuted(remoteJid, true);
                return await reply("Bot dikunci (*mute*) di grup ini.");
            }
            if (query === "off") {
                userManager.setGroupMuted(remoteJid, false);
                return await reply("Bot diaktifkan kembali di grup ini.");
            }
            return await reply(`Status grup ini: *${userManager.isGroupMuted(remoteJid) ? "Muted" : "Aktif"}*\nGunakan \`.self on\` atau \`.self off\`.`);
        }

        if (cmd === "stop" || cmd === "batal" || cmd === "cancel") {
            const count = agyHelper.cancelTasksForChat(remoteJid);
            return await reply(count ? `Menghentikan ${count} tugas agen yang sedang berjalan.` : "Tidak ada tugas aktif untuk obrolan ini.");
        }

        if (cmd === "reset" || cmd === "clear") {
            const count = agyHelper.clearChatSession(remoteJid);
            return await reply(count ? "Memori percakapan untuk obrolan ini telah dibersihkan." : "Sesi percakapan sudah kosong.");
        }

        if (cmd === "reload") {
            if (!isOwner) return await reply("Hanya Owner yang dapat melakukan hot reload.");
            const ok = typeof callbacks.hotReload === "function" ? callbacks.hotReload() : false;
            return await reply(ok ? "Hot reload modul berhasil tanpa memutus koneksi WhatsApp." : "Hot reload tidak tersedia di mode ini.");
        }

        if (cmd === "restart") {
            if (!isOwner) return await reply("Hanya Owner yang dapat merestart bot.");
            await reply("Merestart service WhatsApp Bot... Koneksi akan pulih dalam beberapa detik.");
            setTimeout(() => process.exit(0), 1000);
            return;
        }

        if (cmd === "dns") {
            const res = await resolveDnsRecords(query);
            return await reply(res.text);
        }

        if (cmd === "toimg") {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const stickerNode = quotedMsg?.stickerMessage || msg.message?.stickerMessage;
            if (!stickerNode) return await reply(`Reply sebuah stiker dengan \`${prefix}toimg\`.`);
            const stream = await downloadContentFromMessage(stickerNode, "sticker");
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            const conv = await convertStickerToPng(Buffer.concat(chunks), TEMP_TASKS_DIR);
            if (!conv.ok) return await reply(conv.error);
            await sock.sendMessage(remoteJid, { image: conv.buffer, caption: "Stiker berhasil diubah menjadi PNG." }, { quoted: msg });
            return;
        }

        if (cmd === "hdstatus" || cmd === "clearstatus") {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const targetAttachment = attachment || (quoted ? extractMediaAttachment({ message: quoted }) : null);
            if (!targetAttachment || !["image", "video"].includes(targetAttachment.type)) {
                return await reply(`Kirim atau reply foto/video dengan caption \`${prefix}hdstatus\`.`);
            }
            const inPath = path.join(TEMP_TASKS_DIR, `status_in_${Date.now()}.${targetAttachment.ext}`);
            await downloadBaileysMedia(targetAttachment, inPath);
            const opt = await optimizeMediaForStatus(inPath, targetAttachment.type, TEMP_TASKS_DIR);
            try { fs.unlinkSync(inPath); } catch (_) {}
            if (!opt.ok) return await reply(opt.error);
            for (const f of opt.files) {
                await sendMediaFile(sock, remoteJid, { path: f, file: path.basename(f), mediaType: opt.type, mime: opt.type === "video" ? "video/mp4" : "image/jpeg" }, "Siap diunggah sebagai Status WhatsApp HD.", msg);
                try { fs.unlinkSync(f); } catch (_) {}
            }
            return;
        }
    }

    // 3. AI & AUTONOMOUS AGENT EXECUTION (.agen, .ai, private chat, or group @mention/reply)
    const explicitCmd = isDotCmd ? (cmd === "agen" || cmd === "task" ? "agen" : (cmd === "ai" || cmd === "ask" || cmd === "fast" ? "fast" : null)) : null;
    if (isDotCmd && !explicitCmd) return; // Abaikan perintah dot tak dikenal agar tidak bocor ke AI

    if (isGroup && !explicitCmd) return; // Di grup hanya merespon command eksplisit (.agen / .ai)

    const promptText = explicitCmd ? query : text;
    if (!promptText && !attachment) {
        return await reply(`Masukkan instruksi setelah perintah. Contoh:\n• \`${prefix}ai jelaskan apa itu Docker\`\n• \`${prefix}agen cek log pm2 dan periksa error\``);
    }

    // Cek privilese: mode agen penuh hanya untuk Owner di chat grup, di private chat disesuaikan owner status
    const route = aiRouter.classify(promptText, Boolean(attachment), explicitCmd);
    const runMode = (route.mode === "agen" && isOwner) ? "agen" : (explicitCmd === "agen" && !isOwner ? "fast" : route.mode);

    const taskDir = path.join(TEMP_TASKS_DIR, `t_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
    ensureDir(taskDir);

    const inputFiles = [];
    if (attachment) {
        try {
            const safeName = (attachment.fileName || `input_${Date.now()}.${attachment.ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");
            const fileDest = path.join(taskDir, safeName);
            await downloadBaileysMedia(attachment, fileDest);
            inputFiles.push(fileDest);
        } catch (dlErr) {
            console.error("[MEDIA DL ERR]", dlErr.message);
        }
    }

    const quotedContext = extractQuotedText(msg);

    if (config.typingIndicator !== false) {
        try { await sock.sendPresenceUpdate("composing", remoteJid); } catch (_) {}
    }
    await react("⏳");

    let statusMsgKey = null;
    let lastProgressEdit = 0;
    const progressSteps = [];

    if (runMode === "agen") {
        try {
            const sentStatus = await sock.sendMessage(remoteJid, { text: "*[Agent Task]* `[00] Menginisialisasi agen...`" }, { quoted: msg });
            statusMsgKey = sentStatus?.key || null;
        } catch (_) {}
    }

    const onStep = async (stepLine) => {
        progressSteps.push(stepLine);
        if (!statusMsgKey) return;
        const now = Date.now();
        if (now - lastProgressEdit < 2200) return;
        lastProgressEdit = now;
        const preview = progressSteps.slice(-4).map((l) => `• \`${l}\``).join("\n");
        try {
            await sock.sendMessage(remoteJid, {
                text: `*[Agent Progress]*\n${preview}`,
                edit: statusMsgKey
            });
        } catch (_) {}
    };

    const result = await agyHelper.runAgyAgent({
        taskDir,
        commandType: runMode,
        promptText,
        inputFiles,
        quotedContext,
        chatId: remoteJid,
        isOwner,
        userName,
        onStep
    });

    if (statusMsgKey) {
        try { await sock.sendMessage(remoteJid, { delete: statusMsgKey }); } catch (_) {}
    }

    await react("✅");
    await sendSplitReply(sock, remoteJid, result.response, msg);
    if (result.outputMedia) {
        await sendMediaFile(sock, remoteJid, result.outputMedia, result.outputMedia.file, msg);
    }

    // Bersihkan direktori tugas setelah selesai kirim agar disk tetap lega
    setTimeout(() => {
        try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (_) {}
    }, 30000);
}

module.exports = {
    handleIncomingMessage
};
