/**
 * userManager.js - Privacy Mode (.private/.public), Group Muting (.self), & User Whitelist
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR, ensureDir, readJsonSafe, loadSettings, saveSettings } = require("./configStore");
const { cleanNumber, isOwnerSender, resolveMappedJid } = require("./utils");

const USERS_FILE = path.join(DATA_DIR, "users.json");

function loadUsers() {
    ensureDir(DATA_DIR);
    const data = readJsonSafe(USERS_FILE, null);
    if (!data) {
        try { fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2)); } catch (_) {}
        return {};
    }
    return data;
}

function saveUsers(users) {
    ensureDir(DATA_DIR);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function isPrivateMode() {
    return Boolean(loadSettings().isPrivateMode);
}

function setPrivateMode(flag) {
    return saveSettings({ isPrivateMode: Boolean(flag) });
}

function isGroupMuted(groupJid) {
    const list = loadSettings().mutedGroups || [];
    return list.includes(groupJid);
}

function setGroupMuted(groupJid, muted) {
    const s = loadSettings();
    const set = new Set(s.mutedGroups || []);
    if (muted) set.add(groupJid);
    else set.delete(groupJid);
    return saveSettings({ mutedGroups: Array.from(set) });
}

function getMutedGroups() {
    return loadSettings().mutedGroups || [];
}

function recordUser(senderJid, pushName = "") {
    const clean = cleanNumber(senderJid);
    if (!clean) return null;
    const users = loadUsers();
    if (!users[clean]) {
        users[clean] = {
            name: (pushName || clean).trim(),
            registeredAt: new Date().toISOString(),
            role: "guest",
            allowedFeatures: []
        };
        saveUsers(users);
    }
    return users[clean];
}

function canUserAccess(senderJid, feature, config = {}) {
    if (isOwnerSender(senderJid, config)) return true;
    const clean = cleanNumber(senderJid);
    const users = loadUsers();
    const mapped = resolveMappedJid(clean);
    const user = users[clean] || (mapped && users[mapped]);
    if (!user) return false;
    if (user.role === "admin" || user.role === "owner") return true;
    return Array.isArray(user.allowedFeatures) && user.allowedFeatures.includes(String(feature).toLowerCase());
}

function grantFeatureAccess(identifier, feature) {
    const users = loadUsers();
    const feat = String(feature || "").trim().toLowerCase();
    const clean = cleanNumber(identifier);
    if (!clean || clean.length < 8) {
        return { success: false, message: "Masukkan nomor WhatsApp yang valid (contoh: 628123456789)." };
    }
    if (!users[clean]) {
        users[clean] = {
            name: identifier,
            registeredAt: new Date().toISOString(),
            role: "guest",
            allowedFeatures: [feat]
        };
    } else {
        if (!Array.isArray(users[clean].allowedFeatures)) users[clean].allowedFeatures = [];
        if (!users[clean].allowedFeatures.includes(feat)) users[clean].allowedFeatures.push(feat);
    }
    saveUsers(users);
    return { success: true, number: clean, feature: feat };
}

function revokeFeatureAccess(identifier, feature) {
    const users = loadUsers();
    const feat = String(feature || "").trim().toLowerCase();
    const clean = cleanNumber(identifier);
    if (!users[clean]) {
        return { success: false, message: `Nomor ${identifier} tidak terdaftar.` };
    }
    users[clean].allowedFeatures = (users[clean].allowedFeatures || []).filter((f) => f !== feat);
    saveUsers(users);
    return { success: true, number: clean, feature: feat };
}

function listAllowedUsers() {
    const users = loadUsers();
    return Object.entries(users)
        .filter(([, u]) => (u.allowedFeatures || []).length > 0 || u.role === "admin")
        .map(([id, u]) => ({ id, name: u.name, role: u.role, features: u.allowedFeatures || [] }));
}

module.exports = {
    isPrivateMode,
    setPrivateMode,
    isGroupMuted,
    setGroupMuted,
    getMutedGroups,
    recordUser,
    canUserAccess,
    grantFeatureAccess,
    revokeFeatureAccess,
    listAllowedUsers
};
