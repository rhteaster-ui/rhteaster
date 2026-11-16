/**
 * systemHelper.js - VPS Telemetry & PM2 Summary for WhatsApp Bot
 */

const os = require("os");
const { execFileSync } = require("child_process");
const { formatBytes, formatUptime } = require("./utils");

function getVpsStatus() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ramUsagePercent = ((usedMem / totalMem) * 100).toFixed(1);

    const cpus = os.cpus();
    const cpuModel = cpus && cpus[0] ? cpus[0].model.trim() : "Unknown CPU";
    const cpuCores = cpus ? cpus.length : 1;

    let diskInfo = "N/A";
    try {
        const dfOut = execFileSync("df", ["-h", "/"], { encoding: "utf8", timeout: 2500 }).trim().split("\n");
        if (dfOut[1]) {
            const cols = dfOut[1].trim().split(/\s+/);
            diskInfo = `${cols[2]} / ${cols[1]} (${cols[4]})`;
        }
    } catch (_) {}

    let pm2List = [];
    try {
        const raw = execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 3000 });
        const list = JSON.parse(raw);
        pm2List = list.map((p) => ({
            id: p.pm_id,
            name: p.name,
            status: p.pm2_env?.status || "unknown",
            cpu: p.monit?.cpu ?? 0,
            memMb: Math.round((p.monit?.memory || 0) / 1024 / 1024),
            restarts: p.pm2_env?.restart_time ?? 0
        }));
    } catch (_) {}

    return {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.arch()}`,
        nodeVersion: process.version,
        cpuModel,
        cpuCores,
        loadAvg: os.loadavg().map((v) => v.toFixed(2)).join(", "),
        ramUsed: formatBytes(usedMem),
        ramTotal: formatBytes(totalMem),
        ramUsagePercent,
        diskInfo,
        uptimeSys: formatUptime(os.uptime()),
        uptimeProcess: formatUptime(process.uptime()),
        pm2List
    };
}

function getFormattedVpsStatus(dashboardPort = 3000) {
    const s = getVpsStatus();
    const pm2Lines = s.pm2List.length
        ? s.pm2List.map((p) => `• ${p.name}: *${p.status}* (RAM ${p.memMb} MB, CPU ${p.cpu}%)`).join("\n")
        : "• PM2 tidak terdeteksi atau berjalan di foreground";

    return (
        `*STATUS KESEHATAN VPS & LAYANAN*\n\n` +
        `• *Host / OS:* ${s.hostname} (${s.platform})\n` +
        `• *Node.js:* ${s.nodeVersion}\n` +
        `• *CPU:* ${s.cpuModel} (${s.cpuCores} Core)\n` +
        `• *Load Avg:* ${s.loadAvg}\n` +
        `• *RAM:* ${s.ramUsed} / ${s.ramTotal} (${s.ramUsagePercent}%)\n` +
        `• *Disk (/):* ${s.diskInfo}\n` +
        `• *Uptime VPS:* ${s.uptimeSys}\n` +
        `• *Uptime Bot:* ${s.uptimeProcess}\n\n` +
        `*Proses PM2:*\n${pm2Lines}\n\n` +
        `_Dashboard Web aktif di port ${dashboardPort}._`
    );
}

module.exports = {
    getVpsStatus,
    getFormattedVpsStatus
};
