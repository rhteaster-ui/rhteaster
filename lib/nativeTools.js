/**
 * nativeTools.js - Zero-token utility helpers (DNS check, Sticker->PNG via ffmpeg, WA Status Video HD)
 */

const dns = require("dns");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

async function resolveDnsRecords(domainInput) {
    const domain = String(domainInput || "")
        .trim()
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        .replace(/[^a-zA-Z0-9.-]/g, "");

    if (!domain || !domain.includes(".")) {
        return { ok: false, text: "Masukkan nama domain yang valid (contoh: `.dns example.com`)." };
    }

    const lines = [`*HASIL CEK DNS: ${domain}*`];
    const lookup = async (label, fn) => {
        try {
            const res = await fn(domain);
            if (Array.isArray(res) && res.length) {
                lines.push(`• *${label}:* ${res.slice(0, 5).map((r) => (typeof r === "object" ? JSON.stringify(r) : r)).join(", ")}`);
            }
        } catch (_) {}
    };

    await Promise.all([
        lookup("A", dns.promises.resolve4),
        lookup("AAAA", dns.promises.resolve6),
        lookup("MX", (d) => dns.promises.resolveMx(d).then((rows) => rows.map((x) => `${x.exchange} (${x.priority})`))),
        lookup("NS", dns.promises.resolveNs),
        lookup("TXT", (d) => dns.promises.resolveTxt(d).then((rows) => rows.map((r) => r.join(""))))
    ]);

    if (lines.length === 1) {
        return { ok: false, text: `Tidak ada DNS record publik yang ditemukan untuk \`${domain}\`.` };
    }
    return { ok: true, text: lines.join("\n") };
}

async function hasBinary(binName) {
    try {
        await execFileAsync("which", [binName], { timeout: 2000 });
        return true;
    } catch (_) {
        return false;
    }
}

async function convertStickerToPng(inputBuffer, tempDir) {
    const hasFfmpeg = await hasBinary("ffmpeg");
    if (!hasFfmpeg) {
        return { ok: false, error: "Fitur .toimg membutuhkan `ffmpeg`. Jalankan `sudo apt install -y ffmpeg` di VPS." };
    }
    const stamp = Date.now();
    const inPath = path.join(tempDir, `sticker_${stamp}.webp`);
    const outPath = path.join(tempDir, `sticker_${stamp}.png`);
    fs.writeFileSync(inPath, inputBuffer);
    try {
        await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-frames:v", "1", outPath], { timeout: 20000 });
        const pngBuffer = fs.readFileSync(outPath);
        return { ok: true, buffer: pngBuffer };
    } catch (err) {
        return { ok: false, error: `Gagal mengonversi stiker: ${err.message}` };
    } finally {
        try { fs.unlinkSync(inPath); } catch (_) {}
        try { fs.unlinkSync(outPath); } catch (_) {}
    }
}

async function optimizeMediaForStatus(inputPath, mediaType, tempDir) {
    const hasFfmpeg = await hasBinary("ffmpeg");
    if (!hasFfmpeg) {
        return { ok: false, error: "Fitur .hdstatus membutuhkan `ffmpeg`. Jalankan `sudo apt install -y ffmpeg` di VPS." };
    }
    const stamp = Date.now();
    if (mediaType === "image") {
        const outPath = path.join(tempDir, `hd_status_${stamp}.jpg`);
        try {
            await execFileAsync("ffmpeg", [
                "-y", "-i", inputPath,
                "-vf", "scale='min(1440,iw)':-2:flags=lanczos,unsharp=5:5:0.45:5:5:0.0",
                "-q:v", "2",
                outPath
            ], { timeout: 30000 });
            return { ok: true, files: [outPath], type: "image" };
        } catch (err) {
            return { ok: false, error: `Gagal optimasi gambar: ${err.message}` };
        }
    }

    const outPath = path.join(tempDir, `hd_status_${stamp}.mp4`);
    try {
        await execFileAsync("ffmpeg", [
            "-y", "-i", inputPath,
            "-t", "90",
            "-vf", "scale='min(1280,iw)':-2:flags=lanczos",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            outPath
        ], { timeout: 90000 });
        return { ok: true, files: [outPath], type: "video" };
    } catch (err) {
        return { ok: false, error: `Gagal optimasi video: ${err.message}` };
    }
}

module.exports = {
    resolveDnsRecords,
    convertStickerToPng,
    optimizeMediaForStatus
};
