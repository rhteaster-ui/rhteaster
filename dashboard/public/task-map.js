(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cut = (s, n) => { const t = String(s || "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
  const WORLD_W = 1280, WORLD_H = 640;

  const fmtElapsed = (iso, fallback) => {
    if (!iso) return fallback || "0s";
    const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (!Number.isFinite(sec)) return fallback || "0s";
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}j ${m % 60}m`;
  };

  const urlTaskId = new URLSearchParams(location.search).get("task");
  const S = { data: null, tasks: [], activeId: urlTaskId || null, follow: !urlTaskId, view: "canvas", zoom: 1, panX: 0, panY: 0, pointers: new Map(), drag: null, pinch: null, didDrag: false, es: null };

  const NODES = {
    n_wa:      { x: 24,  y: 144, w: 170, h: 74, kind: "trigger", ico: "i-wa",  img: "./wa-official.svg",  title: "Bot WhatsApp" },
    n_cli:     { x: 24,  y: 268, w: 170, h: 74, kind: "trigger", ico: "i-cli", title: "CLI / Ops Deck" },
    n_prompt:  { x: 244, y: 204, w: 158, h: 78, kind: "std",     ico: "i-prompt", title: "Intent Router" },
    n_host:    { x: 446, y: 204, w: 164, h: 80, kind: "std",     ico: "i-vps", title: "VPS Host" },
    n_agy:     { x: 662, y: 150, w: 256, h: 116, kind: "wide",   ico: "i-agy", img: "./agy-official.png", title: "AGY Agent" },
    n_model:   { x: 664, y: 318, w: 46,  h: 46, kind: "circle",  ico: "i-model", title: "Model" },
    n_acct:    { x: 734, y: 318, w: 46,  h: 46, kind: "circle",  ico: "i-acct",  title: "Akun" },
    n_ctx:     { x: 804, y: 318, w: 46,  h: 46, kind: "circle",  ico: "i-ctx",   title: "Konteks" },
    n_mem:     { x: 874, y: 318, w: 46,  h: 46, kind: "circle",  ico: "i-mem",   title: "Skill / Mem" },
    n_code:    { x: 974, y: 40,  w: 162, h: 62, kind: "branch",  ico: "i-code",  title: "Code & Files" },
    n_search:  { x: 974, y: 124, w: 162, h: 62, kind: "branch",  ico: "i-search",title: "Web & Riset" },
    n_git:     { x: 974, y: 208, w: 162, h: 62, kind: "branch",  ico: "i-git",   title: "Git & Build" },
    n_infra:   { x: 974, y: 292, w: 162, h: 62, kind: "branch",  ico: "i-vps",   title: "PM2 & Infra" },
    n_media:   { x: 974, y: 376, w: 162, h: 62, kind: "branch",  ico: "i-media", title: "Media & PDF" },
    n_bash:    { x: 974, y: 460, w: 162, h: 62, kind: "branch",  ico: "i-bash",  title: "Bash Shell" },
    n_out:     { x: 1152, y: 242, w: 112, h: 86, kind: "std",   ico: "i-out",   title: "Output WA" }
  };

  const BRANCH_DEFS = [
    ["n_code",   "code",     "baca / edit file"],
    ["n_search", "search",   "riset web"],
    ["n_git",    "git",      "git / build"],
    ["n_infra",  "infra",    "pm2 / service"],
    ["n_media",  "media",    "pdf / gambar"],
    ["n_bash",   "terminal", "bash shell"]
  ];

  const rightPort = (n) => [n.x + n.w, n.y + n.h / 2];
  const leftPort = (n) => [n.x, n.y + n.h / 2];
  const bezierH = (a, b) => {
    const dx = Math.max(26, Math.abs(b[0] - a[0]) * 0.48);
    return `M ${a[0]} ${a[1]} C ${a[0] + dx} ${a[1]}, ${b[0] - dx} ${b[1]}, ${b[0]} ${b[1]}`;
  };
  const bezierV = (a, b) => {
    const dy = Math.max(18, Math.abs(b[1] - a[1]) * 0.5);
    return `M ${a[0]} ${a[1]} C ${a[0]} ${a[1] + dy}, ${b[0]} ${b[1] - dy}, ${b[0]} ${b[1]}`;
  };

  function computeNodeStates(t, cluster) {
    const wa = cluster?.waBot || {}, host = cluster?.host || {};
    const run = t.status === "running", err = t.status === "error";
    const isWa = t.channel === "whatsapp", isCli = !isWa;
    const c = t.counts || {}, act = new Set(t.activeTools || []), errs = new Set(t.errorTools || []);

    const toolState = (cat, count) => {
      if (act.has(cat)) return { cls: "st-running", badge: ["run", "LIVE"], edge: "active" };
      if (errs.has(cat)) return { cls: "st-err", badge: ["err", "ERR"], edge: "err" };
      if (count > 0) return { cls: "st-done", badge: ["ok", `×${count}`], edge: "done" };
      return { cls: "st-off", badge: ["off", "idle"], edge: "off" };
    };

    const waOnline = wa.status === "open";
    const waState = isWa
      ? (run ? { cls: "st-running", badge: ["run", "INPUT"] } : { cls: "st-done", badge: ["ok", "WA"] })
      : { cls: waOnline ? "st-cool" : "st-off", badge: [waOnline ? "cool" : "off", waOnline ? "ONLINE" : (wa.status || "OFF").toUpperCase()] };

    const cliState = isCli
      ? (run ? { cls: "st-running", badge: ["run", "INPUT"] } : { cls: "st-done", badge: ["ok", "CLI"] })
      : { cls: "st-cool", badge: ["cool", `${host.terminals || 0} tty`] };

    const branchStates = {}, activeBranches = [];
    for (const [nodeId, cat, idleSub] of BRANCH_DEFS) {
      const st = toolState(cat, c[cat] || 0);
      const last = (t.steps || []).filter((s) => s.category === cat).at(-1);
      branchStates[nodeId] = { ...st, cat, sub: last ? cut(last.summary, 18) : idleSub };
      if (act.has(cat) || errs.has(cat) || (c[cat] || 0) > 0) activeBranches.push([nodeId, st]);
    }

    const outState = run ? { cls: "st-off", badge: ["off", "tunggu"], edge: "off" } : (err ? { cls: "st-err", badge: ["err", "ERROR"], edge: "err" } : { cls: "st-done", badge: ["ok", "SENT"], edge: "done" });

    const edges = [
      { id: "e_wa_p",  d: bezierH(rightPort(NODES.n_wa), leftPort(NODES.n_prompt)), st: isWa ? (run ? "active" : "done") : "off" },
      { id: "e_cli_p", d: bezierH(rightPort(NODES.n_cli), leftPort(NODES.n_prompt)), st: isCli ? (run ? "active" : "done") : "off" },
      { id: "e_p_h",   d: bezierH(rightPort(NODES.n_prompt), leftPort(NODES.n_host)), st: run ? "active" : "done" },
      { id: "e_h_a",   d: bezierH(rightPort(NODES.n_host), leftPort(NODES.n_agy)), st: run ? "active" : "done" },
      { id: "e_m",     d: bezierV([NODES.n_agy.x + 25, NODES.n_agy.y + NODES.n_agy.h], [NODES.n_model.x + 23, NODES.n_model.y]), st: run ? "active-cool" : "done", dash: true },
      { id: "e_a",     d: bezierV([NODES.n_agy.x + 95, NODES.n_agy.y + NODES.n_agy.h], [NODES.n_acct.x + 23, NODES.n_acct.y]), st: "done", dash: true },
      { id: "e_c",     d: bezierV([NODES.n_agy.x + 165, NODES.n_agy.y + NODES.n_agy.h], [NODES.n_ctx.x + 23, NODES.n_ctx.y]), st: run ? "active" : "done", dash: true },
      { id: "e_mem",   d: bezierV([NODES.n_agy.x + 235, NODES.n_agy.y + NODES.n_agy.h], [NODES.n_mem.x + 23, NODES.n_mem.y]), st: t.memSkillActive ? "active-cool" : "done", dash: true },
      ...BRANCH_DEFS.map(([nodeId]) => ({ id: `e_${nodeId}`, d: bezierH(rightPort(NODES.n_agy), leftPort(NODES[nodeId])), st: branchStates[nodeId].edge }))
    ];

    if (activeBranches.length) {
      for (const [nodeId, st] of activeBranches) {
        edges.push({ id: `e_out_${nodeId}`, d: bezierH(rightPort(NODES[nodeId]), leftPort(NODES.n_out)), st: run ? (st.edge === "active" ? "active" : "off") : (st.edge === "err" ? "err" : outState.edge) });
      }
    } else {
      edges.push({ id: "e_out_direct", d: bezierH(rightPort(NODES.n_agy), leftPort(NODES.n_out)), st: outState.edge });
    }

    return {
      nodes: {
        n_wa:     { ...waState, sub: waOnline ? "wa-bot · online" : `wa-bot · ${wa.status || "standby"}`, hit: isWa },
        n_cli:    { ...cliState, sub: isCli ? "cli / dashboard" : "terminal lokal", hit: isCli },
        n_prompt: { cls: run && t.phase === "ingress" ? "st-running" : "st-done", badge: ["ok", isWa ? "WA" : "CLI"], sub: cut(t.prompt, 19) },
        n_host:   { cls: run ? "st-running" : "st-done", badge: [run ? "run" : "ok", `${host.agyProcs || 0} agy`], sub: "Single-VPS Worker" },
        n_agy:    { cls: run ? "st-running" : (err ? "st-err" : "st-done"), badge: [run ? "run" : (err ? "err" : "ok"), run ? "WORKING" : (err ? "ERROR" : "DONE")], sub: `${t.stepCount || 0} langkah · ${t.duration || "0s"}` },
        n_model:  { cls: run ? "st-cool" : "st-done", sub: cut(t.model, 11) },
        n_acct:   { cls: "st-cool", sub: cut(t.account?.alias || "utama", 11) },
        n_ctx:    { cls: run ? "st-running" : "st-done", sub: `${t.stepCount || 0}s · ${t.tokenStr || "--"}` },
        n_mem:    { cls: t.memSkillActive ? "st-cool" : "st-done", sub: t.memSkillActive ? "skill" : "workspace" },
        ...branchStates,
        n_out:    { ...outState, sub: isWa ? "Balasan WA" : "Output CLI" }
      },
      edges
    };
  }

  function render() {
    const standby = {
      id: "standby",
      shortId: "ready",
      title: "Standby · Siap Menerima Tugas",
      prompt: "Kirim pesan .agen di WhatsApp untuk melihat aliran eksekusi agen secara live.",
      channel: "whatsapp",
      status: "done",
      statusLabel: "Standby",
      phase: "done",
      stepCount: 0,
      duration: "0s",
      model: S.data?.activeAccount?.alias || "gemini-3.8-flash-medium",
      account: S.data?.activeAccount || { alias: "utama", email: "" },
      counts: {},
      steps: [],
      responseSnippet: "Agen dalam keadaan standby."
    };
    const list = S.tasks.length ? S.tasks : [standby];
    const t = list.find((x) => x.id === S.activeId) || list[0];
    S.activeId = t.id;
    $("sessionMeta").textContent = `sesi: ${t.shortId || "ready"} · ${(t.channel || "wa").toUpperCase()} · AGY`;

    $("taskRail").innerHTML = list.map((x) => `
      <button type="button" class="tm-tab ${x.id === t.id ? "on" : ""}" data-tid="${esc(x.id)}">
        <span class="dot ${esc(x.status)}"></span><span>${esc(x.title)}</span>
      </button>
    `).join("");
    $("taskRail").querySelectorAll("[data-tid]").forEach((b) => b.addEventListener("click", () => {
      S.activeId = b.dataset.tid;
      S.follow = false;
      $("followBtn")?.setAttribute("aria-pressed", "false");
      render();
    }));

    $("mPrompt").textContent = t.prompt;
    $("mStatus").textContent = t.statusLabel;
    $("mStatus").className = `tm-v ${t.status}`;
    $("mSteps").textContent = t.stepCount || 0;
    $("mDuration").textContent = t.status === "running" ? fmtElapsed(t.startTimeIso, t.duration) : (t.duration || "0s");
    $("mToken").textContent = t.model || "--";

    const st = computeNodeStates(t, S.data?.cluster);
    const markerFor = (s) => (s === "active" ? "arr-run" : s === "active-cool" ? "arr-cool" : s === "done" ? "arr-ok" : s === "err" ? "arr-err" : "arr-idle");

    $("edgesLayer").innerHTML = st.edges.map((e) => `<path class="edge ${e.dash ? "dash" : ""} ${e.st}" d="${e.d}" marker-end="url(#${markerFor(e.st)})"></path>`).join("");
    $("nodesLayer").innerHTML = Object.entries(NODES).map(([id, cfg]) => {
      const info = st.nodes[id] || {};
      const stCls = info.cls || "st-off";
      if (cfg.kind === "circle") {
        return `<button type="button" class="node node--circle ${stCls}" data-node="${id}" style="left:${cfg.x}px;top:${cfg.y}px;width:${cfg.w}px;height:${cfg.h}px"><span class="node-ico"><svg class="i"><use href="#${cfg.ico}"/></svg></span><span class="sub-cap"><strong>${esc(cfg.title)}</strong><span>${esc(info.sub || "")}</span></span></button>`;
      }
      const badge = info.badge ? `<span class="node-badge ${info.badge[0]}">${esc(info.badge[1])}</span>` : "";
      const bolt = cfg.kind === "trigger" ? `<span class="trig-bolt ${info.hit ? "hit" : ""}"><svg class="i" style="width:12px;height:12px"><use href="#i-bolt"/></svg></span>` : "";
      const ports = id === "n_agy" ? `<div class="agy-ports"><span>Model</span><span>Akun</span><span>Konteks</span><span>Skill</span></div>` : "";
      const icoHtml = cfg.img ? `<img src="${cfg.img}" alt="" width="22" height="22" class="node-logo" decoding="async" />` : `<svg class="i"><use href="#${cfg.ico}"/></svg>`;
      const kindCls = cfg.kind === "trigger" ? "node--trigger" : (cfg.kind === "wide" ? "node--wide" : (cfg.kind === "branch" ? "node--branch" : ""));
      return `<button type="button" class="node ${kindCls} ${stCls}" data-node="${id}" style="left:${cfg.x}px;top:${cfg.y}px;width:${cfg.w}px;height:${cfg.h}px">${bolt}${badge}<div class="node-top"><span class="node-ico">${icoHtml}</span><div style="min-width:0"><div class="node-title">${esc(cfg.title)}</div><div class="node-sub">${esc(info.sub || "")}</div></div></div>${ports}</button>`;
    }).join("");

    const order = ["n_wa", "n_cli", "n_prompt", "n_host", "n_agy", ...BRANCH_DEFS.map(([id]) => id), "n_out"];
    $("flowList").innerHTML = order.map((id) => {
      const cfg = NODES[id], info = st.nodes[id] || {};
      const icoHtml = cfg.img ? `<img src="${cfg.img}" alt="" width="22" height="22" class="node-logo" />` : `<svg class="i"><use href="#${cfg.ico}"/></svg>`;
      return `<button type="button" class="flow-step ${info.cls || ""}" data-node="${id}"><span class="step-ico">${icoHtml}</span><span style="min-width:0"><h3>${esc(cfg.title)}</h3><p>${esc(info.sub || "")}</p></span></button>`;
    }).join("");

    document.querySelectorAll("[data-node]").forEach((el) => el.addEventListener("click", () => {
      if (S.didDrag) { S.didDrag = false; return; }
      openInspector(el.dataset.node, t);
    }));
  }

  function openInspector(nodeId, t) {
    const cfg = NODES[nodeId];
    $("inspTitle").textContent = cfg ? cfg.title : "Detail Node";
    const steps = (t.steps || []).slice().reverse();
    const catObj = BRANCH_DEFS.find(([id]) => id === nodeId);
    const items = catObj ? steps.filter((s) => s.category === catObj[1]) : steps.slice(0, 8);
    const kv = [
      ["Tugas", t.title],
      ["Status", t.statusLabel],
      ["Model", t.model || "--"],
      ["Akun", t.account?.alias || "utama"],
      ["Langkah", String(t.stepCount || 0)]
    ];
    $("inspBody").innerHTML = `<dl class="insp-kv">${kv.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`
      + `<div class="insp-log">${(items.length ? items : [{ summary: "Siap menerima perintah", detail: t.responseSnippet || "Node standby.", status: "ok" }]).map((s) => `<div class="insp-item ${s.status === "error" ? "err" : ""}"><strong>${esc(s.summary)}</strong><span>${esc(s.error || s.detail || "")}</span></div>`).join("")}</div>`;
    $("backdrop").classList.add("open");
    $("inspector").classList.add("open");
    $("inspector").setAttribute("aria-hidden", "false");
  }

  function closeInspector() {
    $("backdrop").classList.remove("open");
    $("inspector").classList.remove("open");
    $("inspector").setAttribute("aria-hidden", "true");
  }
  $("backdrop").addEventListener("click", closeInspector);
  $("inspClose").addEventListener("click", closeInspector);
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeInspector(); });

  const applyTransform = () => { $("world").style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.zoom})`; };
  function fitCanvas() {
    const st = $("stage").getBoundingClientRect();
    if (!st.width || !st.height) return;
    S.zoom = Math.max(0.22, Math.min((st.width - 28) / WORLD_W, (st.height - 28) / WORLD_H, 1.05));
    S.panX = Math.max(8, (st.width - WORLD_W * S.zoom) / 2);
    S.panY = Math.max(8, (st.height - WORLD_H * S.zoom) / 2);
    applyTransform();
  }
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(2.2, Math.max(0.22, S.zoom * factor));
    const ratio = next / S.zoom;
    S.panX = cx - (cx - S.panX) * ratio; S.panY = cy - (cy - S.panY) * ratio; S.zoom = next;
    applyTransform();
  };

  const stage = $("stage");
  stage.addEventListener("pointerdown", (e) => {
    S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (S.pointers.size === 1) { S.didDrag = false; S.drag = { sx: e.clientX, sy: e.clientY, px: S.panX, py: S.panY }; }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!S.pointers.has(e.pointerId) || !S.drag) return;
    const dx = e.clientX - S.drag.sx, dy = e.clientY - S.drag.sy;
    if (Math.hypot(dx, dy) > 6) S.didDrag = true;
    if (S.didDrag) { S.panX = S.drag.px + dx; S.panY = S.drag.py + dy; applyTransform(); }
  });
  const endP = (e) => { S.pointers.delete(e.pointerId); S.drag = null; setTimeout(() => { S.didDrag = false; }, 40); };
  stage.addEventListener("pointerup", endP);
  stage.addEventListener("pointercancel", endP);
  stage.addEventListener("wheel", (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - r.left, e.clientY - r.top); }, { passive: false });

  $("zIn").addEventListener("click", () => { const r = stage.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); });
  $("zOut").addEventListener("click", () => { const r = stage.getBoundingClientRect(); zoomAt(0.82, r.width / 2, r.height / 2); });
  $("zFit").addEventListener("click", fitCanvas);
  addEventListener("resize", fitCanvas);

  $("followBtn").addEventListener("click", () => {
    S.follow = !S.follow;
    $("followBtn").setAttribute("aria-pressed", String(S.follow));
  });
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    S.view = b.dataset.view;
    document.querySelectorAll("[data-view]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    $("stage").classList.toggle("hidden", S.view !== "canvas");
    $("zoomControls").style.display = S.view === "canvas" ? "inline-flex" : "none";
    $("flowList").classList.toggle("active", S.view === "flow");
    if (S.view === "canvas") fitCanvas();
  }));

  function applyPayload(data) {
    if (!data) return;
    S.data = data;
    S.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const runTask = S.tasks.find((x) => x.status === "running");
    if (S.follow && runTask) S.activeId = runTask.id;
    render();
  }

  (async function init() {
    try {
      const auth = await fetch("/api/auth/state", { cache: "no-store" }).then((r) => r.json());
      if (auth.pinRequired && !auth.authenticated) {
        location.href = "/";
        return;
      }
    } catch (_) {}
    fitCanvas();
    const es = new EventSource("/api/task-map/stream");
    es.onmessage = (e) => { try { applyPayload(JSON.parse(e.data)); } catch (_) {} };
    es.onerror = () => {
      const b = $("sseBadge"); b.className = "live-pill off";
    };
    fetch("/api/task-map").then((r) => r.json()).then(applyPayload).catch(() => {});
  })();
})();
