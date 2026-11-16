/**
 * Utility helpers: Phone normalization, LID detection, WA Markdown formatting & splitting
 */

const fs = require("fs");
const path = require("path");
const { ROOT_DIR } = require("./configStore");

function cleanNumber(phone) {
    if (!phone) return "";
    let clean = String(phone).split(":")[0].replace(/[^0-9]/g, "");
    if (clean.startsWith("0")) {
        clean = "62" + clean.substring(1);
    }
    return clean;
}

function resolveMappedJid(cleanId) {
    if (!cleanId) return null;
    const authDir = path.join(ROOT_DIR, "session_auth");
    try {
        const revFile = path.join(authDir, `lid-mapping-${cleanId}_reverse.json`);
        if (fs.existsSync(revFile)) {
            const val = JSON.parse(fs.readFileSync(revFile, "utf8"));
            return String(val || "").replace(/[^0-9]/g, "") || null;
        }
        const dirFile = path.join(authDir, `lid-mapping-${cleanId}.json`);
        if (fs.existsSync(dirFile)) {
            const val = JSON.parse(fs.readFileSync(dirFile, "utf8"));
            return String(val || "").replace(/[^0-9]/g, "") || null;
        }
    } catch (_) {}
    return null;
}

function isOwnerSender(senderJid, config = {}) {
    if (!senderJid) return false;
    const cleanSender = cleanNumber(senderJid);
    if (!cleanSender) return false;

    const ownerNum = cleanNumber(config.ownerNumber);
    const ownerLid = cleanNumber(config.ownerLid);

    if (ownerNum && (cleanSender === ownerNum || cleanSender.endsWith(ownerNum.replace(/^62/, "")))) {
        return true;
    }
    if (ownerLid && (cleanSender === ownerLid || cleanSender.includes(ownerLid))) {
        return true;
    }

    const mapped = resolveMappedJid(cleanSender);
    if (mapped && ownerNum && (mapped === ownerNum || mapped.endsWith(ownerNum.replace(/^62/, "")))) {
        return true;
    }
    return false;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatUptime(uptimeSeconds) {
    const total = Math.max(0, Math.floor(Number(uptimeSeconds) || 0));
    const sec = total % 60;
    const min = Math.floor((total / 60) % 60);
    const hour = Math.floor((total / 3600) % 24);
    const day = Math.floor(total / 86400);

    const parts = [];
    if (day > 0) parts.push(`${day}hr`);
    if (hour > 0) parts.push(`${hour}j`);
    if (min > 0) parts.push(`${min}m`);
    parts.push(`${sec}d`);
    return parts.join(" ");
}

function unwrapMessage(message) {
    if (!message) return null;
    return (
        message.ephemeralMessage?.message ||
        message.viewOnceMessage?.message ||
        message.viewOnceMessageV2?.message ||
        message.viewOnceMessageV2Extension?.message ||
        message.documentWithCaptionMessage?.message ||
        message
    );
}

function extractMessageText(msg) {
    if (!msg || !msg.message) return "";
    const actual = unwrapMessage(msg.message);
    if (!actual) return "";

    const btnJson = actual.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    if (btnJson) {
        try {
            const parsed = JSON.parse(btnJson);
            return parsed.id || parsed.rowId || parsed.selectedId || parsed.title || "";
        } catch (_) {}
    }

    const templateBtnId =
        actual.templateButtonReplyMessage?.selectedId ||
        actual.buttonsResponseMessage?.selectedButtonId ||
        actual.listResponseMessage?.singleSelectReply?.selectedRowId ||
        actual.interactiveResponseMessage?.body?.text;
    if (templateBtnId) return templateBtnId;

    return (
        actual.conversation ||
        actual.extendedTextMessage?.text ||
        actual.imageMessage?.caption ||
        actual.videoMessage?.caption ||
        actual.documentMessage?.caption ||
        ""
    );
}

function extractQuotedText(msg) {
    const ctx = msg?.message?.extendedTextMessage?.contextInfo || unwrapMessage(msg?.message)?.extendedTextMessage?.contextInfo;
    if (!ctx || !ctx.quotedMessage) return "";
    return extractMessageText({ message: ctx.quotedMessage });
}

function extractMediaAttachment(msg) {
    const actual = unwrapMessage(msg?.message);
    if (!actual) return null;
    if (actual.imageMessage) return { type: "image", node: actual.imageMessage, ext: "jpg" };
    if (actual.documentMessage) {
        const name = actual.documentMessage.fileName || "document";
        const ext = (path.extname(name).replace(".", "") || "bin").toLowerCase();
        return { type: "document", node: actual.documentMessage, fileName: name, ext };
    }
    if (actual.audioMessage) return { type: "audio", node: actual.audioMessage, ext: "ogg" };
    if (actual.videoMessage) return { type: "video", node: actual.videoMessage, ext: "mp4" };
    return null;
}

/**
 * Konversi Markdown standar ke format WhatsApp (*bold*, _italic_, ```code```) yang rapi.
 */
function formatWhatsAppText(text) {
    if (!text) return "";
    let out = String(text).replace(/\r\n/g, "\n");
    // Simpan code block agar isinya tidak rusak oleh format heading/bold
    const blocks = [];
    out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
        const idx = blocks.length;
        blocks.push("```\n" + body.trimEnd() + "\n```");
        return `__WA_BLOCK_${idx}__`;
    });

    out = out.replace(/^#{1,6}\s+(.+)$/gm, (_, h) => `*${h.trim()}*`);
    out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
    out = out.replace(/\n{3,}/g, "\n\n");

    blocks.forEach((b, i) => {
        out = out.replace(`__WA_BLOCK_${i}__`, b);
    });
    return out.trim();
}

/**
 * Pecah teks panjang WhatsApp secara rapi per paragraf/baris (< 3500 char per pesan).
 */
function splitWhatsAppChunks(text, maxLen = 3500) {
    const formatted = formatWhatsAppText(text);
    if (!formatted) return ["(Tidak ada respon)"];
    if (formatted.length <= maxLen) return [formatted];

    const lines = formatted.split("\n");
    const chunks = [];
    let buf = [];
    let bufLen = 0;

    for (const line of lines) {
        if (line.length > maxLen) {
            if (buf.length) {
                chunks.push(buf.join("\n").trim());
                buf = [];
                bufLen = 0;
            }
            for (let i = 0; i < line.length; i += maxLen) {
                chunks.push(line.slice(i, i + maxLen));
            }
            continue;
        }
        const nextLen = buf.length ? bufLen + 1 + line.length : line.length;
        if (buf.length && nextLen > maxLen) {
            chunks.push(buf.join("\n").trim());
            buf = [line];
            bufLen = line.length;
        } else {
            buf.push(line);
            bufLen = nextLen;
        }
    }
    if (buf.length) chunks.push(buf.join("\n").trim());
    return chunks.filter(Boolean);
}

module.exports = {
    cleanNumber,
    resolveMappedJid,
    isOwnerSender,
    formatBytes,
    formatUptime,
    unwrapMessage,
    extractMessageText,
    extractQuotedText,
    extractMediaAttachment,
    formatWhatsAppText,
    splitWhatsAppChunks
};
