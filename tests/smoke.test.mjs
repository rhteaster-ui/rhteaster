import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("syntax check succeeds for setup.sh and all JS modules", () => {
    execFileSync("bash", ["-n", path.join(ROOT, "setup.sh")]);
    const jsFiles = [
        "index.js",
        "bin/rhteaster.js",
        "ecosystem.config.js",
        "lib/configStore.js",
        "lib/utils.js",
        "lib/aiRouter.js",
        "lib/accountManager.js",
        "lib/agyHelper.js",
        "lib/userManager.js",
        "lib/systemHelper.js",
        "lib/nativeTools.js",
        "lib/controlBridge.js",
        "lib/messageHandler.js",
        "dashboard/server.js",
        "dashboard/quotaService.js",
        "dashboard/taskMapService.js",
        "dashboard/public/deck.js",
        "dashboard/public/task-map.js"
    ];
    for (const rel of jsFiles) {
        execFileSync(process.execPath, ["-c", path.join(ROOT, rel)]);
    }
});

test("utils normalizes numbers, recognizes owner, and splits long WhatsApp messages", () => {
    const utils = require(path.join(ROOT, "lib/utils.js"));
    assert.equal(utils.cleanNumber("+62 812-3456-789"), "628123456789");
    assert.equal(utils.cleanNumber("08123456789"), "628123456789");
    assert.equal(utils.isOwnerSender("628123456789@s.whatsapp.net", { ownerNumber: "08123456789" }), true);
    assert.equal(utils.isOwnerSender("628999999999@s.whatsapp.net", { ownerNumber: "08123456789" }), false);

    const longText = "## Header\n**Bold text**\n" + Array.from({ length: 120 }, (_, i) => `Baris ke-${i} dengan isi yang cukup panjang untuk menguji pembagian pesan`).join("\n");
    const chunks = utils.splitWhatsAppChunks(longText, 1200);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.length <= 1200));
    assert.ok(chunks[0].includes("*Header*"));
});

test("aiRouter separates fast path and autonomous agent path cleanly", () => {
    const aiRouter = require(path.join(ROOT, "lib/aiRouter.js"));
    assert.equal(aiRouter.classify("halo apa kabar", false, null).mode, "fast");
    assert.equal(aiRouter.classify("tolong buatkan script python untuk backup", false, null).mode, "agen");
    assert.equal(aiRouter.classify("halo", false, "agen").mode, "agen");
    assert.equal(aiRouter.classify("riset web", false, "fast").mode, "fast");
});

test("accountManager auto-imports active token and switches profiles safely in isolated HOME", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "setup-bot-acct-"));
    const prevHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
        const agyDir = path.join(tmpHome, ".gemini", "antigravity-cli");
        fs.mkdirSync(agyDir, { recursive: true });
        fs.writeFileSync(path.join(agyDir, "antigravity-oauth-token"), JSON.stringify({
            id_token_email: "client.satu@example.com",
            token: { access_token: "tok1", refresh_token: "ref1" }
        }));

        const acctPath = require.resolve(path.join(ROOT, "lib/accountManager.js"));
        delete require.cache[acctPath];
        const am = require(acctPath);

        const list1 = am.listAccounts();
        assert.equal(list1.accounts.length, 1);
        assert.equal(list1.accounts[0].email, "client.satu@example.com");
        assert.equal(list1.accounts[0].isActive, true);

        const added = am.addAccountFromJson("cadangan", {
            id_token_email: "client.dua@example.com",
            token: { access_token: "tok2", refresh_token: "ref2" }
        });
        assert.equal(added.success, true);

        const sw = am.switchAccount("cadangan");
        assert.equal(sw.success, true);
        assert.equal(am.getActiveAccountInfo().email, "client.dua@example.com");

        const rot = am.autoSwitchNext();
        assert.equal(rot.switched, true);
    } finally {
        process.env.HOME = prevHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
    }
});

test("taskMapService classifies tool calls accurately and avoids leaked personal paths", () => {
    const { classifyTool } = require(path.join(ROOT, "dashboard/taskMapService.js"));
    assert.equal(classifyTool("write_file", { Path: "/tmp/a.js" }).category, "code");
    assert.equal(classifyTool("search_web", { query: "nodejs" }).category, "search");
    assert.equal(classifyTool("run_command", { CommandLine: "pm2 restart wa-bot" }).category, "infra");
    assert.equal(classifyTool("run_command", { CommandLine: "git commit -m test" }).category, "git");

    // Verify public repo config template and files contain zero hardcoded personal info
    const example = fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8");
    assert.equal(example.includes("43.133.155.156"), false);
    assert.equal(example.includes("/home/rdev"), false);
    assert.equal(example.includes("6285187434573"), false);
});

test("dashboard HTTP server serves Ops Deck, Task Map, API status, and enforces optional PIN auth", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "setup-bot-dash-"));
    const port = 34567;
    const child = spawn(process.execPath, [path.join(ROOT, "dashboard/server.js")], {
        cwd: ROOT,
        env: {
            ...process.env,
            HOME: tmpHome,
            DASHBOARD_PORT: String(port),
            DASHBOARD_PIN: "2468"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Dashboard startup timeout")), 10000);
            child.stdout.on("data", (d) => {
                if (d.toString().includes(String(port))) {
                    clearTimeout(timer);
                    resolve();
                }
            });
            child.stderr.on("data", (d) => {
                // ignore warnings
            });
        });

        const baseUrl = `http://127.0.0.1:${port}`;
        const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
        assert.equal(health.ok, true);

        const unauth = await fetch(`${baseUrl}/api/status`);
        assert.equal(unauth.status, 401);

        const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: "0000" })
        });
        assert.equal(badLogin.status, 401);

        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: "2468" })
        });
        assert.equal(loginRes.status, 200);
        const cookie = loginRes.headers.get("set-cookie").split(";")[0];

        const statusJson = await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } }).then((r) => r.json());
        assert.ok(statusJson.host);
        assert.ok(statusJson.waBot);
        assert.ok(Array.isArray(statusJson.models) && statusJson.models.length >= 5);

        const tmJson = await fetch(`${baseUrl}/api/task-map`, { headers: { Cookie: cookie } }).then((r) => r.json());
        assert.ok(Array.isArray(tmJson.tasks));

        const htmlRes = await fetch(`${baseUrl}/`);
        assert.equal(htmlRes.status, 200);
        const html = await htmlRes.text();
        assert.ok(html.includes("Ops Deck"));

        const tmHtml = await fetch(`${baseUrl}/task-map`).then((r) => r.text());
        assert.ok(tmHtml.includes("Task Map"));
    } finally {
        child.kill("SIGTERM");
        fs.rmSync(tmpHome, { recursive: true, force: true });
    }
});

test("rhteaster CLI exposes help, version, doctor diagnostics, and masked config view", () => {
    const cli = path.join(ROOT, "bin/rhteaster.js");

    const helpOut = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.ok(helpOut.includes("Usage:"));
    assert.ok(helpOut.includes("rhteaster <command>"));
    assert.ok(helpOut.includes("doctor"));

    const verOut = execFileSync(process.execPath, [cli, "version"], { encoding: "utf8" });
    assert.ok(verOut.includes("rhteaster v"));

    const docOut = execFileSync(process.execPath, [cli, "doctor", "--json"], { encoding: "utf8" });
    const doc = JSON.parse(docOut);
    assert.equal(typeof doc.ok, "boolean");
    assert.ok(Array.isArray(doc.checks) && doc.checks.length >= 6);
    assert.equal(doc.checks.find((x) => x.id === "nodejs")?.status, "pass");

    const cfgOut = execFileSync(process.execPath, [cli, "config", "--show", "--json"], { encoding: "utf8" });
    const cfg = JSON.parse(cfgOut);
    assert.ok("brandName" in cfg);
    assert.ok("dashboardPort" in cfg);
});
