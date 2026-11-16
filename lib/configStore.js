/**
 * Shared Configuration & Settings Store
 * Reads/writes config.json and data/bot_settings.json dynamically without hardcoded paths.
 */

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const CONFIG_EXAMPLE_PATH = path.join(ROOT_DIR, "config.example.json");
const DATA_DIR = path.join(ROOT_DIR, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "bot_settings.json");

const DEFAULT_CONFIG = {
    brandName: "Agency Client",
    botName: "Agency AI Bot",
    botNumber: "",
    ownerNumber: "",
    ownerLid: "",
    prefix: ".",
    defaultAiModel: "gemini-3.8-flash-medium",
    fastAiModel: "gemini-3.8-flash-low",
    agyBin: "agy",
    autoRead: false,
    typingIndicator: true,
    agentTimeoutMs: 1800000,
    dashboardPort: 3000,
    dashboardPin: "",
    controlPort: 3847
};

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function readJsonSafe(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_) {
        return fallback;
    }
}

function loadConfig() {
    ensureDir(DATA_DIR);
    let loaded = readJsonSafe(CONFIG_PATH, null);
    if (!loaded) {
        const example = readJsonSafe(CONFIG_EXAMPLE_PATH, {});
        loaded = { ...DEFAULT_CONFIG, ...example };
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(loaded, null, 2));
        } catch (_) {}
    } else {
        loaded = { ...DEFAULT_CONFIG, ...loaded };
    }
    return loaded;
}

function saveConfig(patch) {
    const current = loadConfig();
    const next = { ...current, ...patch };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
    return next;
}

function loadSettings() {
    ensureDir(DATA_DIR);
    const cfg = loadConfig();
    const defaults = {
        currentModel: cfg.defaultAiModel || "gemini-3.8-flash-medium",
        fastModel: cfg.fastAiModel || "gemini-3.8-flash-low",
        isPrivateMode: false,
        mutedGroups: [],
        updatedAt: new Date().toISOString()
    };
    const saved = readJsonSafe(SETTINGS_PATH, null);
    if (!saved) {
        try {
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaults, null, 2));
        } catch (_) {}
        return defaults;
    }
    return {
        ...defaults,
        ...saved,
        mutedGroups: Array.isArray(saved.mutedGroups) ? saved.mutedGroups : []
    };
}

function saveSettings(patch) {
    ensureDir(DATA_DIR);
    const current = loadSettings();
    const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
    return next;
}

module.exports = {
    ROOT_DIR,
    DATA_DIR,
    CONFIG_PATH,
    SETTINGS_PATH,
    DEFAULT_CONFIG,
    ensureDir,
    readJsonSafe,
    loadConfig,
    saveConfig,
    loadSettings,
    saveSettings
};
