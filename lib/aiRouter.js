/**
 * aiRouter.js - Smart Intent Router for Client WhatsApp AI Agent
 * Separates Fast Path (instant Q&A) from Autonomous Agent Path (.agen, coding, bash, research, PDF/file tasks).
 */

class AIRouter {
    constructor() {
        this.workPatterns = [
            /\b(riset|research|analisis|analisa|browsing|search\s+web|cari\s+(di\s+web|info|berita|artikel|referensi)|investigasi|cek\s+web|buka\s+link|scrape)\b/i,
            /\b(koding|coding|buatkan\s+script|bikin\s+script|buat\s+script|bikin\s+kode|buatkan\s+kode|edit\s+kode|perbaiki|benerin|fix|debug|refactor|git\s+|commit|push)\b/i,
            /\b(buatkan\s+file|bikin\s+file|buat\s+file|edit\s+file|hapus\s+file|buatkan\s+dokumen|bikin\s+dokumen|buatkan\s+pdf|bikin\s+pdf|buat\s+pdf|export|simpan\s+ke\s+|buatkan\s+laporan)\b/i,
            /\b(terminal|bash|shell|jalankan\s+command|eksekusi|install|setup|deploy|docker|pm2|systemctl|service|nginx|crontab|database|sqlite|backup)\b/i,
            /\b(mode\s+analisis|kerjakan\s+projek|buatkan\s+proyek|otomasi|automation)\b/i
        ];
    }

    classify(text = "", isMedia = false, explicitCommand = null) {
        const cleanText = String(text || "").trim();
        const lower = cleanText.toLowerCase();

        if (explicitCommand === "agen") {
            return { mode: "agen", reason: "explicit_agen_command", isWork: true };
        }
        if (explicitCommand === "fast" || explicitCommand === "chat") {
            return { mode: "fast", reason: "explicit_fast_command", isWork: false };
        }

        for (const pattern of this.workPatterns) {
            if (pattern.test(lower)) {
                return { mode: "agen", reason: "matched_work_intent", isWork: true };
            }
        }

        return {
            mode: "fast",
            reason: isMedia ? "media_analysis" : "casual_conversation",
            isWork: false
        };
    }
}

module.exports = new AIRouter();
