/**
 * controlBridge.js - Localhost-only HTTP bridge between WhatsApp Bot & Web Ops Dashboard
 * Allows the Web Dashboard to inspect live WA status, trigger 8-digit Pairing Code,
 * reset/logout session, or toggle Private/Public mode without restarting PM2 blindly.
 */

const http = require("http");
const { loadConfig } = require("./configStore");

function readBody(req) {
    return new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 65536) raw = raw.slice(0, 65536);
        });
        req.on("end", () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (_) {
                resolve({});
            }
        });
    });
}

function startControlBridge(handlers) {
    const cfg = loadConfig();
    const port = Number(cfg.controlPort) || 3847;

    const server = http.createServer(async (req, res) => {
        res.setHeader("Content-Type", "application/json");
        const url = (req.url || "/").split("?")[0];

        try {
            if (req.method === "GET" && url === "/status") {
                const data = await handlers.getStatus();
                res.statusCode = 200;
                return res.end(JSON.stringify(data));
            }
            if (req.method === "POST" && url === "/pair") {
                const body = await readBody(req);
                const result = await handlers.requestPair(body.phoneNumber || "");
                res.statusCode = result.ok ? 200 : 400;
                return res.end(JSON.stringify(result));
            }
            if (req.method === "POST" && url === "/logout") {
                const result = await handlers.logoutSession();
                res.statusCode = result.ok ? 200 : 500;
                return res.end(JSON.stringify(result));
            }
            if (req.method === "POST" && url === "/mode") {
                const body = await readBody(req);
                const result = await handlers.setMode(body.mode);
                res.statusCode = result.ok ? 200 : 400;
                return res.end(JSON.stringify(result));
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: "Not found" }));
        } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
    });

    server.on("error", (err) => {
        console.error("[CONTROL BRIDGE ERR]", err.message);
    });

    server.listen(port, "127.0.0.1", () => {
        console.log(`[CONTROL BRIDGE] Listening on http://127.0.0.1:${port}`);
    });

    return server;
}

async function queryControlBridge(endpoint, method = "GET", body = null) {
    const cfg = loadConfig();
    const port = Number(cfg.controlPort) || 3847;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
        const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        return await res.json();
    } catch (err) {
        return { ok: false, offline: true, error: err.message };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    startControlBridge,
    queryControlBridge
};
