/**
 * quotaService.js - Client Single-VPS Antigravity Account Pool & Quota Monitor
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { DATA_DIR, ensureDir, loadConfig, loadSettings, readJsonSafe } = require("../lib/configStore");
const accountManager = require("../lib/accountManager");
const { getAgyBinPath } = require("../lib/agyHelper");

const execFileAsync = promisify(execFile);
const CACHE_FILE = path.join(DATA_DIR, "live_quotas_cache.json");
const REFRESH_INTERVAL_MS = 3 * 60 * 1000;

const quotaState = {
    updatedAt: null,
    refreshing: false,
    lastError: null,
    accounts: []
};

function formatUtcReset(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr);
    return d.toISOString().replace("T", " ").slice(0, 19);
}

function normalizeBucket(bucket, fallbackFull = false) {
    if (!bucket) {
        return {
            pct: fallbackFull ? "100%" : "--",
            pctNum: fallbackFull ? 100 : null,
            reset: "",
            resetIso: null,
            disabled: false,
            note: fallbackFull ? "Siap penuh" : ""
        };
    }
    const disabled = Boolean(bucket.disabled);
    const rawFrac = Number(bucket.remaining_fraction ?? 1);
    const pctNum = disabled ? 0 : Math.max(0, Math.min(100, Math.round(rawFrac * 100)));
    return {
        pct: disabled ? "0%" : `${pctNum}%`,
        pctNum,
        reset: formatUtcReset(bucket.reset_time),
        resetIso: bucket.reset_time || null,
        disabled,
        note: disabled ? "Terkunci (Weekly 0%)" : ""
    };
}

function extractQuotaDetails(groups) {
    const list = Array.isArray(groups) ? groups : [];
    const gemGroup = list.find((g) => /gemini models/i.test(g.name || "")) || list.find((g) => /gemini/i.test(g.name || "") && !/argon/i.test(g.name || ""));
    const claGroup = list.find((g) => /claude/i.test(g.name || "")) || list.find((g) => /3p/i.test(g.buckets?.[0]?.id || ""));

    const findBucket = (group, win) => (group?.buckets || []).find((b) => b.window === win || (b.id || "").endsWith(win));
    const gemW = findBucket(gemGroup, "weekly");
    const gem5 = findBucket(gemGroup, "5h");
    const claW = findBucket(claGroup, "weekly");
    const cla5 = findBucket(claGroup, "5h");

    const geminiWeekly = normalizeBucket(gemW, false);
    const gemini5h = gem5 ? normalizeBucket(gem5, false) : normalizeBucket(null, geminiWeekly.pctNum === 100);
    const claudeWeekly = normalizeBucket(claW, false);
    const claude5h = cla5 ? normalizeBucket(cla5, false) : normalizeBucket(null, claudeWeekly.pctNum === 100);

    return { geminiWeekly, gemini5h, claudeWeekly, claude5h };
}

function mapTierToPlan(tier) {
    if (!tier || (!tier.id && !tier.name)) return null;
    const id = String(tier.id || "").trim();
    const name = String(tier.name || "").trim();
    const low = `${id} ${name}`.toLowerCase();
    let label = name || id;
    if (low.includes("ultra")) label = "AI Ultra";
    else if (low.includes("pro")) label = "AI Pro";
    else if (low.includes("free") || low.includes("starter")) label = "Free";
    return { id, name, label };
}

async function fetchAccountPlan(profileHome, groups) {
    try {
        const tokFile = path.join(profileHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
        const raw = readJsonSafe(tokFile, null);
        const tok = raw?.token?.access_token;
        if (tok) {
            const res = await fetch("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${tok}`,
                    "Content-Type": "application/json",
                    "User-Agent": "antigravity/1.15.8 linux/amd64"
                },
                body: JSON.stringify({
                    metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }
                }),
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                const data = await res.json().catch(() => null);
                const mapped = mapTierToPlan(data?.paidTier || data?.currentTier);
                if (mapped) return mapped;
            }
        }
    } catch (_) {}

    if (Array.isArray(groups) && groups.some((g) => /argon/i.test(g.name || ""))) {
        return { id: "g1-pro-tier", name: "Google AI Pro", label: "AI Pro" };
    }
    return null;
}

async function fetchAccountQuota(acc, prevPlan = null) {
    const cfg = loadConfig();
    const agyBin = getAgyBinPath(cfg.agyBin);
    const { profileHome } = accountManager.ensureAccountProfile(acc.name);

    try {
        const { stdout } = await execFileAsync(agyBin, ["-p", "/usage", "--output-format", "json"], {
            env: { ...process.env, HOME: profileHome },
            timeout: 18000,
            maxBuffer: 1024 * 1024
        });
        const parsed = JSON.parse(stdout);
        const groups = parsed?.command?.data?.groups;
        if (!groups) {
            return {
                alias: acc.name,
                name: acc.email.split("@")[0],
                email: acc.email,
                plan: prevPlan,
                success: false,
                error: parsed?.error?.message || "Respons kuota kosong",
                fetchedAt: new Date().toISOString(),
                details: {}
            };
        }
        const plan = (await fetchAccountPlan(profileHome, groups)) || prevPlan;
        accountManager.syncProfileTokenBack(acc.name);
        return {
            alias: acc.name,
            name: acc.email.split("@")[0],
            email: acc.email,
            plan,
            success: true,
            fetchedAt: new Date().toISOString(),
            details: extractQuotaDetails(groups)
        };
    } catch (err) {
        return {
            alias: acc.name,
            name: acc.email.split("@")[0],
            email: acc.email,
            plan: prevPlan,
            success: false,
            error: err.message ? err.message.slice(0, 120) : "CLI agy belum siap",
            fetchedAt: new Date().toISOString(),
            details: {}
        };
    }
}

async function refreshAllQuotas() {
    if (quotaState.refreshing) return quotaState;
    quotaState.refreshing = true;
    try {
        const { accounts } = accountManager.listAccounts();
        const prevMap = new Map(quotaState.accounts.map((a) => [String(a.email || a.alias).toLowerCase(), a]));
        const next = [];

        for (const acc of accounts) {
            const prev = prevMap.get(String(acc.email || acc.name).toLowerCase());
            const res = await fetchAccountQuota(acc, prev?.plan || null);
            if (!res.success && prev) {
                next.push({ ...prev, plan: res.plan || prev.plan || null, stale: true, lastError: res.error });
            } else {
                next.push(res);
            }
        }

        quotaState.accounts = next;
        quotaState.updatedAt = new Date().toISOString();
        quotaState.lastError = null;
        ensureDir(DATA_DIR);
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: quotaState.updatedAt, accounts: next }, null, 2));
    } catch (err) {
        quotaState.lastError = err.message;
    } finally {
        quotaState.refreshing = false;
    }
    return quotaState;
}

function loadInitialCache() {
    const cached = readJsonSafe(CACHE_FILE, null);
    if (cached && Array.isArray(cached.accounts) && cached.accounts.length) {
        quotaState.accounts = cached.accounts;
        quotaState.updatedAt = cached.updatedAt || null;
    } else {
        const { accounts } = accountManager.listAccounts();
        quotaState.accounts = accounts.map((acc) => ({
            alias: acc.name,
            name: acc.email.split("@")[0],
            email: acc.email,
            success: false,
            loading: true,
            details: {}
        }));
    }
}

function getQuotaSnapshot() {
    const { accounts: diskAccounts, activeEmail } = accountManager.listAccounts();
    const byAlias = new Map(quotaState.accounts.map((a) => [a.alias, a]));
    const merged = diskAccounts.map((d) => {
        const cached = byAlias.get(d.name);
        return {
            ...(cached || {
                alias: d.name,
                name: d.email.split("@")[0],
                email: d.email,
                success: false,
                details: {}
            }),
            isActive: d.isActive
        };
    });

    const activeObj = merged.find((a) => a.isActive) || merged[0] || null;
    const settings = loadSettings();
    return {
        updatedAt: quotaState.updatedAt,
        refreshing: quotaState.refreshing,
        lastError: quotaState.lastError,
        activeAccount: activeObj ? activeObj.alias : null,
        activeEmail: activeEmail || (activeObj ? activeObj.email : null),
        activeModel: settings.currentModel,
        accounts: merged
    };
}

function startMonitors() {
    loadInitialCache();
    refreshAllQuotas().catch(() => {});
    const t = setInterval(() => refreshAllQuotas().catch(() => {}), REFRESH_INTERVAL_MS);
    t.unref();
}

module.exports = {
    startMonitors,
    refreshAllQuotas,
    getQuotaSnapshot,
    extractQuotaDetails
};
