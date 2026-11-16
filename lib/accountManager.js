/**
 * accountManager.js - Single-VPS Multi-Account Pool for Antigravity CLI (agy)
 * Uses dynamic os.homedir() paths (~/.gemini/antigravity-cli) with automatic active-token discovery.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readJsonSafe, ensureDir } = require("./configStore");

function getHomeDir() {
    return process.env.HOME || os.homedir();
}

function getAgyRoot() {
    return path.join(getHomeDir(), ".gemini", "antigravity-cli");
}

function getAccountsDir() {
    return path.join(getAgyRoot(), "accounts");
}

function getActiveTokenPath() {
    return path.join(getAgyRoot(), "antigravity-oauth-token");
}

function getProfilesDir() {
    return path.join(getHomeDir(), ".gemini", "profiles");
}

const chatAccountMap = new Map();
let currentActiveAlias = null;

function maskEmail(email) {
    if (!email || typeof email !== "string" || !email.includes("@")) return "***";
    const [user, domain] = email.split("@");
    if (user.length <= 3) return `${user.slice(0, 1)}***@${domain}`;
    return `${user.slice(0, 2)}***${user.slice(-2)}@${domain}`;
}

function getActiveAccountInfo() {
    const data = readJsonSafe(getActiveTokenPath(), null);
    if (!data) return null;
    return {
        email: String(data.id_token_email || data.email || "Akun Utama").trim(),
        auth_method: data.auth_method || "consumer"
    };
}

/**
 * Automatically imports the active ~/.gemini/antigravity-cli/antigravity-oauth-token
 * into accounts/utama.json if accounts/ has no matching entry yet.
 */
function autoImportActiveToken() {
    const activePath = getActiveTokenPath();
    if (!fs.existsSync(activePath)) return;
    const activeData = readJsonSafe(activePath, null);
    if (!activeData) return;

    const accountsDir = getAccountsDir();
    ensureDir(accountsDir);

    const activeEmail = String(activeData.id_token_email || activeData.email || "").trim().toLowerCase();
    const existingFiles = fs.readdirSync(accountsDir).filter((f) => f.endsWith(".json"));

    if (activeEmail) {
        const already = existingFiles.some((f) => {
            const d = readJsonSafe(path.join(accountsDir, f), null);
            return d && String(d.id_token_email || d.email || "").trim().toLowerCase() === activeEmail;
        });
        if (already) return;
    } else if (existingFiles.length > 0) {
        return;
    }

    const baseName = activeEmail
        ? activeEmail.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase() || "utama"
        : "utama";
    let destName = baseName;
    let suffix = 2;
    while (fs.existsSync(path.join(accountsDir, `${destName}.json`))) {
        destName = `${baseName}_${suffix++}`;
    }

    try {
        fs.copyFileSync(activePath, path.join(accountsDir, `${destName}.json`));
        try { fs.chmodSync(path.join(accountsDir, `${destName}.json`), 0o600); } catch (_) {}
    } catch (_) {}
}

function listAccounts() {
    autoImportActiveToken();
    const accountsDir = getAccountsDir();
    ensureDir(accountsDir);
    ensureDir(getProfilesDir());

    const activeInfo = getActiveAccountInfo();
    const activeEmail = activeInfo ? activeInfo.email : null;
    const files = fs.readdirSync(accountsDir).filter((f) => !f.startsWith(".") && f.endsWith(".json")).sort();
    const accounts = [];
    const seenEmails = new Set();

    for (const file of files) {
        const filePath = path.join(accountsDir, file);
        const data = readJsonSafe(filePath, null);
        if (!data) continue;
        const name = file.replace(/\.json$/, "");
        const email = String(data.id_token_email || data.email || name).trim();
        const key = email.toLowerCase();
        if (seenEmails.has(key)) continue;
        seenEmails.add(key);

        const isActive = Boolean(activeEmail && activeEmail.toLowerCase() === key);
        accounts.push({
            index: accounts.length + 1,
            name,
            email,
            maskedEmail: maskEmail(email),
            file,
            filePath,
            isActive
        });
    }

    return { accounts, activeEmail, activeMaskedEmail: maskEmail(activeEmail) };
}

function getActiveAccountName() {
    const { accounts, activeEmail } = listAccounts();
    const matched = accounts.find((a) => a.isActive);
    if (matched) {
        currentActiveAlias = matched.name;
        return matched.name;
    }
    if (currentActiveAlias && accounts.some((a) => a.name === currentActiveAlias)) {
        return currentActiveAlias;
    }
    return accounts[0]?.name || (activeEmail ? activeEmail.split("@")[0] : "utama");
}

function getAccountForChat(chatId) {
    if (chatId && chatAccountMap.has(chatId)) {
        return chatAccountMap.get(chatId);
    }
    return getActiveAccountName();
}

function setAccountForChat(chatId, accountName) {
    if (chatId && accountName) {
        chatAccountMap.set(chatId, accountName);
    }
}

function ensureAccountProfile(accountName) {
    const cleanName = String(accountName || "utama").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    const profileHome = path.join(getProfilesDir(), cleanName);
    const agyCliDir = path.join(profileHome, ".gemini", "antigravity-cli");
    ensureDir(agyCliDir);

    const accountTokenSrc = path.join(getAccountsDir(), `${cleanName}.json`);
    const profileTokenDest = path.join(agyCliDir, "antigravity-oauth-token");
    const activeToken = getActiveTokenPath();

    if (fs.existsSync(accountTokenSrc) && !fs.existsSync(profileTokenDest)) {
        try {
            fs.copyFileSync(accountTokenSrc, profileTokenDest);
            fs.chmodSync(profileTokenDest, 0o600);
        } catch (_) {}
    } else if (fs.existsSync(activeToken) && !fs.existsSync(profileTokenDest)) {
        try {
            fs.copyFileSync(activeToken, profileTokenDest);
            fs.chmodSync(profileTokenDest, 0o600);
        } catch (_) {}
    }

    const mainSettings = path.join(getAgyRoot(), "settings.json");
    const profileSettings = path.join(agyCliDir, "settings.json");
    if (fs.existsSync(mainSettings) && !fs.existsSync(profileSettings)) {
        try { fs.copyFileSync(mainSettings, profileSettings); } catch (_) {}
    }

    for (const dirName of ["skills", "builtin", "bin"]) {
        const srcDir = path.join(getAgyRoot(), dirName);
        const destLink = path.join(agyCliDir, dirName);
        if (fs.existsSync(srcDir) && !fs.existsSync(destLink)) {
            try { fs.symlinkSync(srcDir, destLink, "dir"); } catch (_) {}
        }
    }

    return { name: cleanName, profileHome };
}

function syncProfileTokenBack(accountName) {
    if (!accountName) return;
    const cleanName = String(accountName).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    const profileToken = path.join(getProfilesDir(), cleanName, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const accountDest = path.join(getAccountsDir(), `${cleanName}.json`);

    if (!fs.existsSync(profileToken)) return;
    try {
        fs.copyFileSync(profileToken, accountDest);
        fs.chmodSync(accountDest, 0o600);
        if (getActiveAccountName() === cleanName) {
            fs.copyFileSync(profileToken, getActiveTokenPath());
            fs.chmodSync(getActiveTokenPath(), 0o600);
        }
    } catch (_) {}
}

function switchAccount(target) {
    const { accounts } = listAccounts();
    if (!accounts.length) {
        return { success: false, error: "Belum ada akun Google Antigravity tersimpan. Login dulu via perintah 'agy' di terminal." };
    }

    const q = String(target || "").trim().toLowerCase();
    let selected = accounts.find((a) => String(a.index) === q || a.name.toLowerCase() === q);
    if (!selected) {
        selected = accounts.find((a) => a.email.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
    }
    if (!selected) {
        return { success: false, error: `Akun "${target}" tidak ditemukan.` };
    }

    try {
        ensureDir(getAgyRoot());
        fs.copyFileSync(selected.filePath, getActiveTokenPath());
        try { fs.chmodSync(getActiveTokenPath(), 0o600); } catch (_) {}

        const { profileHome } = ensureAccountProfile(selected.name);
        const profTok = path.join(profileHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
        fs.copyFileSync(selected.filePath, profTok);
        try { fs.chmodSync(profTok, 0o600); } catch (_) {}

        currentActiveAlias = selected.name;
        chatAccountMap.clear();
        return { success: true, account: selected };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function autoSwitchNext() {
    const { accounts, activeEmail } = listAccounts();
    if (accounts.length < 2) {
        return { switched: false, reason: "Hanya tersedia 1 akun terdaftar." };
    }
    const idx = accounts.findIndex((a) => a.isActive);
    const nextAcc = accounts[(idx === -1 ? 0 : idx + 1) % accounts.length];
    const res = switchAccount(nextAcc.index);
    if (!res.success) return { switched: false, reason: res.error };
    return {
        switched: true,
        from: idx !== -1 ? accounts[idx] : { name: "sebelumnya", email: activeEmail || "" },
        to: nextAcc
    };
}

function saveCurrentAs(alias) {
    const activePath = getActiveTokenPath();
    if (!fs.existsSync(activePath)) {
        return { success: false, error: "Belum ada token aktif. Jalankan 'agy' di terminal VPS untuk login Google terlebih dahulu." };
    }
    const clean = String(alias || "").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    if (!clean) return { success: false, error: "Nama alias akun wajib diisi (huruf/angka)." };

    ensureDir(getAccountsDir());
    const dest = path.join(getAccountsDir(), `${clean}.json`);
    try {
        fs.copyFileSync(activePath, dest);
        fs.chmodSync(dest, 0o600);
        const data = readJsonSafe(dest, {});
        return { success: true, name: clean, email: data?.id_token_email || clean, file: `${clean}.json` };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function addAccountFromJson(name, rawContent) {
    const clean = String(name || "").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    if (!clean) return { success: false, error: "Nama alias tidak valid." };

    let parsed = typeof rawContent === "object" && rawContent !== null ? rawContent : null;
    if (!parsed && typeof rawContent === "string") {
        try {
            parsed = JSON.parse(rawContent.trim());
        } catch (_) {
            const m = rawContent.match(/\{[\s\S]*\}/);
            if (m) {
                try { parsed = JSON.parse(m[0]); } catch (_) {}
            }
        }
    }

    if (!parsed || typeof parsed !== "object") {
        return { success: false, error: "Format token JSON tidak valid." };
    }

    let tokenData = null;
    if (parsed.token && typeof parsed.token === "object") {
        tokenData = parsed;
    } else if (parsed.access_token || parsed.refresh_token) {
        tokenData = {
            auth_method: parsed.auth_method || "consumer",
            id_token_email: parsed.id_token_email || parsed.email || `${clean}@local`,
            token: {
                access_token: parsed.access_token || "",
                token_type: parsed.token_type || "Bearer",
                refresh_token: parsed.refresh_token || "",
                expiry: parsed.expiry || new Date(Date.now() + 3600000).toISOString(),
                expires_in: parsed.expires_in || 3599
            }
        };
    }

    if (!tokenData) {
        return { success: false, error: "Struktur token wajib memiliki access_token atau refresh_token." };
    }

    ensureDir(getAccountsDir());
    const dest = path.join(getAccountsDir(), `${clean}.json`);
    try {
        fs.writeFileSync(dest, JSON.stringify(tokenData, null, 2));
        fs.chmodSync(dest, 0o600);
        return {
            success: true,
            name: clean,
            email: tokenData.id_token_email || clean,
            maskedEmail: maskEmail(tokenData.id_token_email),
            file: `${clean}.json`
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function deleteAccount(target) {
    const { accounts } = listAccounts();
    const q = String(target || "").trim().toLowerCase();
    const selected = accounts.find((a) => String(a.index) === q || a.name.toLowerCase() === q || a.email.toLowerCase().includes(q));
    if (!selected) return { success: false, error: `Akun "${target}" tidak ditemukan.` };
    if (selected.isActive) return { success: false, error: `Akun "${selected.name}" sedang aktif. Pindah ke akun lain dulu sebelum menghapus.` };

    try {
        fs.unlinkSync(selected.filePath);
        return { success: true, account: selected };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = {
    getAgyRoot,
    getAccountsDir,
    getActiveTokenPath,
    getProfilesDir,
    maskEmail,
    getActiveAccountInfo,
    autoImportActiveToken,
    listAccounts,
    getActiveAccountName,
    getAccountForChat,
    setAccountForChat,
    ensureAccountProfile,
    syncProfileTokenBack,
    switchAccount,
    autoSwitchNext,
    saveCurrentAs,
    addAccountFromJson,
    deleteAccount
};
