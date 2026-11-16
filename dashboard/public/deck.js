(() => {
  const $ = (id) => document.getElementById(id);
  const S = {
    poll: 2000,
    paused: false,
    mode: "dual",
    data: null,
    tel: [],
    hover: -1,
    filter: "",
    sort: { k: "cpu", d: -1 },
    rtt: 0,
    timer: null,
    es: null,
    logProc: "wa-bot",
    phonePrefilled: false
  };

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const up = (s) => {
    if (s == null) return "--";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}hr ${h}j` : `${h}j ${m}m`;
  };
  const toDate = (b) => {
    const r = b?.resetIso || b?.reset;
    if (!r) return null;
    const d = new Date(r.includes("T") ? r : r.replace(" ", "T") + "Z");
    return isNaN(d) ? null : d;
  };
  const left = (d) => {
    if (!d) return null;
    const ms = d - Date.now();
    if (ms <= 0) return "siap";
    const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
    return h >= 24 ? `${Math.floor(h / 24)}hr ${h % 24}j` : `${h}j ${m}m`;
  };
  const fmtElapsed = (iso, fallback) => {
    if (!iso) return fallback || "0s";
    const sec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (!Number.isFinite(sec)) return fallback || "0s";
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}j ${m % 60}m`;
  };

  const setSseBadge = (cls, txt) => {
    const b = $("sseBadge"), t = $("sseText");
    if (!b || !t) return;
    b.className = "live-pill" + (cls ? " " + cls : "");
    t.textContent = txt;
  };
  const lvl = (pct, inverse) => {
    if (pct == null) return "";
    if (inverse) return pct >= 85 ? "bad" : pct >= 65 ? "warn" : "ok";
    return pct <= 10 ? "bad" : pct < 40 ? "warn" : "ok";
  };
  const setFill = (id, pct, cls) => {
    const el = $(id);
    if (!el) return;
    el.style.transform = `scaleX(${Math.max(0, Math.min(100, pct || 0)) / 100})`;
    el.className = "fill " + (cls || "");
  };

  const BUCKETS = [["gemini5h", "G5j"], ["geminiWeekly", "GWk"], ["claude5h", "C5j"], ["claudeWeekly", "CWk"]];
  const GEM_KEYS = ["gemini5h", "geminiWeekly"];
  const CLA_KEYS = ["claude5h", "claudeWeekly"];
  const pctOf = (b) => (b ? (b.disabled ? 0 : (b.pctNum ?? parseInt(b.pct, 10))) : null);
  const isClaudeModel = (m) => /claude|opus|sonnet|gpt/i.test(m || "");
  const famMin = (a, keys) => {
    const vs = keys.map((k) => pctOf(a?.details?.[k])).filter((v) => v != null);
    return vs.length ? Math.min(...vs) : null;
  };
  const planMeta = (a) => {
    const label = a?.plan?.label || "";
    const low = `${a?.plan?.id || ""} ${a?.plan?.name || ""} ${label}`.toLowerCase();
    const cls = low.includes("ultra") ? "ultra" : low.includes("pro") ? "pro" : label ? "free" : "";
    return { label: label || "--", cls };
  };

  function toast(msg, ok = true) {
    const t = $("toast");
    t.className = "toast show " + (ok ? "ok" : "bad");
    t.querySelector("use").setAttribute("href", ok ? "#i-check" : "#i-alert");
    t.querySelector("span").textContent = msg;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove("show"), 2800);
  }

  function renderVerdict(d) {
    const h = d.host || {}, last = d.telemetry?.at(-1) || {}, wa = d.waBot || {};
    const issues = [], warns = [];
    if (wa.status === "offline") issues.push("Service WA Bot offline");
    else if (wa.status !== "open") warns.push("WhatsApp perlu pairing");
    if (!d.agy?.loggedIn) warns.push("AGY belum login");
    (d.pm2 || []).filter((p) => p.status !== "online").forEach((p) => issues.push(`PM2 ${p.name} ${p.status}`));
    if (last.cpu >= 85) warns.push(`CPU ${last.cpu}%`);
    if (h.ram?.pct >= 85) warns.push(`RAM ${h.ram.pct}%`);
    if (h.disk?.pct >= 85) warns.push(`Disk ${h.disk.pct}%`);

    const state = issues.length ? "bad" : warns.length ? "warn" : "ok";
    $("brandTitle").textContent = `${d.brandName || "Agency Client"} · Ops Deck`;
    $("verdict").dataset.state = state;
    $("verdictIcon").querySelector("use").setAttribute("href", state === "ok" ? "#i-check" : "#i-alert");
    $("verdictTitle").textContent = state === "ok" ? "Semua layanan sehat" : state === "warn" ? "Perlu setup / perhatian" : "Ada gangguan";
    $("verdictText").textContent = state === "ok"
      ? `WA Bot terhubung, ${(d.pm2 || []).length} PM2 online, AI siap digunakan.`
      : [...issues, ...warns].slice(0, 3).join(" · ");

    const waLabel = wa.status === "open" ? `Online (+${wa.botNumber || "WA"})` : wa.status === "awaiting_pairing" ? "Menunggu Pairing" : (wa.status || "Offline");
    $("fWa").textContent = waLabel;
    $("fModel").textContent = d.activeModel || "--";
    const act = (d.accounts || []).find((a) => a.isActive);
    $("fAcct").textContent = act ? `${act.alias}${act.plan?.label ? ` · ${act.plan.label}` : ""}` : (d.agy?.loggedIn ? (d.activeAccount || "utama") : "Belum login");
    $("fUptime").textContent = up(h.uptime);
  }

  function renderWaPanel(d) {
    const wa = d.waBot || {};
    const tag = $("waTag");
    const isOnline = wa.status === "open";
    const isWait = wa.status === "awaiting_pairing" || wa.status === "connecting";

    tag.className = "tag " + (isOnline ? "ok" : isWait ? "warn" : "bad");
    tag.textContent = isOnline ? "online" : isWait ? (wa.lastPairingCode ? "pairing siap" : "menunggu") : (wa.status || "offline");
    $("waSub").textContent = isOnline
      ? `Terhubung +${wa.botNumber || "WA"} · Owner +${wa.ownerNumber || "--"}`
      : (wa.lastError || "Koneksi & Pairing 8-Digit");

    if (!S.phonePrefilled && wa.botNumber && $("botPhoneInput") && !$("botPhoneInput").value) {
      $("botPhoneInput").value = wa.botNumber;
      S.phonePrefilled = true;
    }

    const panel = $("pairCodePanel");
    if (wa.lastPairingCode && !isOnline) {
      panel.hidden = false;
      $("pairCodeVal").textContent = wa.lastPairingCode;
    } else if (isOnline) {
      panel.hidden = true;
    }

    document.querySelectorAll("[data-wamode]").forEach((b) => {
      b.setAttribute("aria-pressed", b.dataset.wamode === (wa.mode || "public"));
    });
  }

  function renderHost(d) {
    const h = d.host || {}, last = d.telemetry?.at(-1) || {};
    $("hostSub").textContent = `${h.hostname || "localhost"} · ${h.platform || "Linux"}`;
    $("hCpuV").innerHTML = `<b>${last.cpu ?? 0}%</b><span> · load ${h.loadavg?.[0] ?? "--"}</span>`;
    setFill("hCpu", last.cpu, lvl(last.cpu, true));
    const r = h.ram || {};
    $("hRamV").innerHTML = `<b>${(r.used / 1024).toFixed(1)}</b><span> / ${(r.total / 1024).toFixed(1)} GB (${r.pct ?? 0}%)</span>`;
    setFill("hRam", r.pct, lvl(r.pct, true));
    const dk = h.disk || {};
    $("hDiskV").innerHTML = `<b>${dk.used ?? 0}</b><span> / ${dk.total ?? 0} GB (${dk.pct ?? 0}%)</span>`;
    setFill("hDisk", dk.pct, lvl(dk.pct, true));
    $("hostFoot").innerHTML = `<span>uptime <b>${up(h.uptime)}</b></span><span>${h.cores || "--"} vCPU</span><span>net <b>${last.netKb ?? 0} KB/s</b></span>`;
  }

  function renderPickAndModel(d) {
    $("agyWarn").hidden = Boolean(d.agy?.loggedIn);
    const sel = $("modelSelect");
    const models = d.models || [];
    const digest = models.map((m) => m.id).join("|");
    if (sel.dataset.digest !== digest) {
      sel.dataset.digest = digest;
      sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
    }
    if (document.activeElement !== sel && d.activeModel) {
      sel.value = d.activeModel;
    }

    const accs = (d.accounts || []).filter((a) => a.details);
    if (!accs.length) {
      $("pickName").textContent = d.agy?.loggedIn ? (d.activeAccount || "Akun Aktif") : "Belum ada akun";
      $("pickMail").textContent = d.agy?.authEmail || "Login 'agy' di terminal VPS";
      $("pickTag").textContent = d.agy?.loggedIn ? "Aktif" : "Perlu Login";
      $("pickWhy").textContent = d.agy?.loggedIn
        ? "Akun Google Antigravity aktif dan siap memproses AI."
        : "Jalankan perintah agy di SSH VPS satu kali untuk menautkan akun Google.";
      $("pickGrid").innerHTML = "";
      return;
    }

    const claudeAct = isClaudeModel(d.activeModel);
    const famKeys = claudeAct ? CLA_KEYS : GEM_KEYS;
    const famLabel = claudeAct ? "Claude" : "Gemini";
    const score = (a) => famMin(a, famKeys) ?? 100;
    const totalScore = (a) => Math.min(...BUCKETS.map(([k]) => pctOf(a.details[k]) ?? 100));
    const best = accs.slice().sort((a, b) => (score(b) - score(a)) || (totalScore(b) - totalScore(a)) || (a.isActive ? -1 : 1))[0];
    const act = accs.find((a) => a.isActive);

    $("pickName").innerHTML = `${esc(best.alias)}${best.plan?.label ? ` <span class="plan-pill ${planMeta(best).cls}">${esc(best.plan.label)}</span>` : ""}`;
    $("pickMail").textContent = best.email || "";
    $("pickTag").textContent = `${famLabel} min ${score(best)}%`;
    $("pickWhy").textContent = best.isActive
      ? `Kuota ${famLabel} di akun aktif sudah paling lega.`
      : act ? `${famLabel} lebih lega dari ${act.alias} (min ${score(act)}%).` : "Kandidat terbaik saat ini.";
    $("pickGrid").innerHTML = BUCKETS.map(([k, l]) => {
      const p = pctOf(best.details[k]);
      return `<div class="mini"><dt>${l}</dt><dd style="color:var(--${lvl(p) === "ok" ? "ink" : lvl(p) === "warn" ? "warn" : "bad"})">${p ?? "--"}%</dd></div>`;
    }).join("");
  }

  function renderTimeline(d) {
    const ev = [];
    (d.accounts || []).forEach((a) => BUCKETS.forEach(([k, l]) => {
      const b = a.details?.[k], p = pctOf(b), dt = toDate(b);
      if (dt && p != null && p < 100) ev.push({ dt, a: a.alias, l, p });
    }));
    ev.sort((x, y) => x.dt - y.dt);
    $("timeline").innerHTML = ev.slice(0, 6).map((e) => `<li><span class="t-when">${left(e.dt)}</span><span class="t-what">${esc(e.a)} · ${e.l}<small>${e.dt.toLocaleString("id-ID", { weekday: "short", hour: "2-digit", minute: "2-digit" })}</small></span><span class="tag plain ${lvl(e.p)}">${e.p}%</span></li>`).join("")
      || '<li class="empty" style="display:block">Semua kuota penuh atau menunggu sinkronisasi.</li>';
  }

  function renderMatrix(d) {
    const all = d.accounts || [];
    const list = S.filter ? all.filter((a) => `${a.alias} ${a.email} ${a.plan?.label || ""}`.toLowerCase().includes(S.filter)) : all;
    $("quotaCount").textContent = `${all.length} akun`;
    const ago = d.quotaUpdatedAt ? Math.round((Date.now() - new Date(d.quotaUpdatedAt)) / 1000) : null;
    $("quotaSub").textContent = d.quotaRefreshing ? "Menyinkronkan via agy…" : ago == null ? "Belum tersinkron" : `Disinkronkan ${ago < 60 ? ago + " dtk" : Math.floor(ago / 60) + " mnt"} lalu`;
    const LABELS = { gemini5h: "Gemini 5j", geminiWeekly: "Gemini Mg", claude5h: "Claude 5j", claudeWeekly: "Claude Mg" };

    $("matrix").innerHTML = list.map((a) => {
      const cells = BUCKETS.map(([k]) => {
        const b = a.details?.[k], p = pctOf(b), c = lvl(p);
        const sub = b?.disabled ? "nonaktif" : b?.note || (left(toDate(b)) ? "reset " + left(toDate(b)) : "");
        return `<td data-label="${LABELS[k]}"><div class="cell"><div class="cell-top">${p ?? "--"}%<span>${esc(sub)}</span></div><div class="track"><div class="fill ${c}" style="transform:scaleX(${(p || 0) / 100})"></div></div></div></td>`;
      }).join("");
      const gMin = famMin(a, GEM_KEYS), cMin = famMin(a, CLA_KEYS);
      const gLvl = lvl(gMin), cLvl = lvl(cMin);
      let st = "plain", stTxt = a.loading ? "sync" : "tanpa data";
      if (!a.loading && (gMin != null || cMin != null)) {
        const gDead = gMin != null && gLvl === "bad", cDead = cMin != null && cLvl === "bad";
        if ((gMin == null || gDead) && (cMin == null || cDead)) { st = "bad"; stTxt = "habis"; }
        else if (gLvl === "ok" && cLvl === "ok") { st = "ok"; stTxt = "siap"; }
        else { st = "warn"; stTxt = "menipis"; }
      }
      const pm = planMeta(a);
      const planBadge = a.plan?.label ? `<span class="plan-pill ${pm.cls}">${esc(pm.label)}</span>` : "";
      const actionBtn = a.isActive ? "" : ` <button type="button" class="btn btn--sm" data-switch="${esc(a.alias)}">Pakai</button>`;
      return `<tr class="${a.isActive ? "is-active" : ""}"><td><div class="acct-n">${esc(a.alias)}${planBadge}</div><div class="acct-m">${esc(a.email)}</div></td>${cells}<td><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="tag ${st}">${stTxt}</span>${actionBtn}</div></td></tr>`;
    }).join("") || '<tr><td colspan="6" class="empty">Belum ada akun atau tidak cocok dengan filter.</td></tr>';
  }

  function renderProcs(d) {
    const pm2 = d.pm2 || [];
    let rows = [
      ...pm2.map((p) => ({ n: p.name, s: `pm2 #${p.id} · restart ${p.restarts}`, st: p.status, cls: p.status === "online" ? "ok" : "bad", cpu: +p.cpu || 0, mv: p.memMb, m: `${p.memMb} MB`, u: up(p.uptimeSec) })),
      ...(d.processes || []).map((p) => ({ n: p.cmd, s: `pid ${p.pid}`, st: "proses", cls: "cool", cpu: +p.cpu || 0, mv: (+p.mem || 0) * 40, m: `${p.mem}%`, u: "--" }))
    ].filter((r) => !S.filter || (r.n + r.s).toLowerCase().includes(S.filter));
    rows.sort((a, b) => S.sort.k === "name" ? a.n.localeCompare(b.n) * -S.sort.d : (S.sort.k === "mem" ? a.mv - b.mv : a.cpu - b.cpu) * S.sort.d);
    const off = pm2.filter((p) => p.status !== "online").length;
    const t = $("pm2Tag"); t.className = "tag " + (off ? "bad" : "ok"); t.textContent = off ? `${off} PM2 down` : `${pm2.length} PM2 online`;
    $("procBody").innerHTML = rows.slice(0, 8).map((r) => `<tr><td><div class="proc-n">${esc(r.n)}</div><div class="proc-s">${esc(r.s)}</div></td><td><span class="tag ${r.cls}">${esc(r.st)}</span></td><td class="r"><span class="bar-inline">${r.cpu}%<span class="track"><span class="fill ${lvl(r.cpu, true)}" style="display:block;transform:scaleX(${Math.min(100, r.cpu) / 100})"></span></span></span></td><td class="r num">${esc(r.m)}</td><td class="r num col-m">${r.u}</td></tr>`).join("")
      || '<tr><td colspan="5" class="empty">Tidak ada proses cocok.</td></tr>';

    const sel = $("logProc");
    const names = pm2.map((p) => p.name).join("|");
    if (names && sel.dataset.names !== names) {
      sel.dataset.names = names;
      sel.innerHTML = pm2.map((p) => `<option value="${esc(p.name)}" ${p.name === S.logProc ? "selected" : ""}>${esc(p.name)} (PM2)</option>`).join("");
    }
  }

  function renderTasks(d) {
    const ts = d.tasksSummary || {};
    let tasks = ts.tasks || [];
    if (S.filter) tasks = tasks.filter((t) => `${t.title} ${t.channel} ${t.model}`.toLowerCase().includes(S.filter));
    $("agentSub").textContent = ts.runningCount ? `${ts.runningCount} aktif · ${tasks.length} riwayat` : `${tasks.length} eksekusi terakhir`;
    $("agentList").innerHTML = tasks.slice(0, 6).map((t) => {
      const cls = t.status === "running" ? "warn" : (t.status === "error" ? "bad" : "ok");
      const dur = t.status === "running" ? fmtElapsed(t.startTimeIso, t.duration) : (t.duration || "--");
      return `<li><a class="live-item ${t.status === "running" ? "is-running" : ""}" href="/task-map?task=${encodeURIComponent(t.id)}">`
        + `<div class="live-top"><span class="live-title">${esc(t.title)}</span><span class="tag ${cls}">${esc(t.statusLabel || t.status)}</span></div>`
        + `<div class="live-meta"><span>${esc((t.channel || "wa").toUpperCase())}</span><span>${t.stepCount || 0} step</span><b data-live-start="${t.status === "running" ? esc(t.startTimeIso || "") : ""}">${esc(dur)}</b></div>`
        + `</a></li>`;
    }).join("") || '<li class="live-empty">Belum ada task agen tercatat. Coba kirim <code>.agen</code> di WhatsApp Anda!</li>';
  }

  function renderChart() {
    const pts = S.tel, cv = $("chart"), empty = $("chartEmpty");
    if (!cv || !cv.parentElement) return;
    const r = cv.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const x = cv.getContext("2d"); x.scale(dpr, dpr);
    const w = r.width, h = r.height, L = 40, R = 12, T = 14, B = 24, cw = w - L - R, ch = h - T - B;
    empty.hidden = pts.length >= 2;
    if (pts.length < 2) return;
    const net = S.mode === "net";
    const a1 = pts.map((p) => +(net ? p.netKb : p.cpu) || 0), a2 = pts.map((p) => +p.ram || 0);
    const max = net ? Math.max(20, Math.ceil(Math.max(...a1) * 1.2 / 10) * 10) : 100;
    x.font = '11px "JetBrains Mono", monospace'; x.textAlign = "right"; x.textBaseline = "middle";
    [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
      const y = T + ch - f * ch;
      x.strokeStyle = css("--border"); x.lineWidth = 1; x.beginPath(); x.moveTo(L, y); x.lineTo(L + cw, y); x.stroke();
      x.fillStyle = css("--ink-muted"); x.fillText(Math.round(max * f) + (net ? "K" : "%"), L - 6, y);
    });
    x.textAlign = "center"; x.textBaseline = "top";
    [0, 0.5, 1].forEach((f) => { const i = Math.round(f * (pts.length - 1)); x.fillText((pts[i].time || "").slice(0, 5), Math.min(Math.max(L + cw * f, L + 18), L + cw - 18), T + ch + 7); });
    const P = (arr) => arr.map((v, i) => [L + (i / (arr.length - 1)) * cw, T + ch - (Math.min(v, max) / max) * ch]);
    const line = (p, col, fill) => {
      x.beginPath(); p.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py)));
      x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = "round"; x.stroke();
      if (fill) { x.lineTo(p.at(-1)[0], T + ch); x.lineTo(p[0][0], T + ch); x.closePath(); x.globalAlpha = 0.12; x.fillStyle = col; x.fill(); x.globalAlpha = 1; }
    };
    const p1 = P(a1);
    if (!net) line(P(a2), css("--cool"), false);
    line(p1, css("--accent"), true);
    const i = S.hover >= 0 ? S.hover : pts.length - 1, [hx, hy] = p1[i], pt = pts[i];
    if (S.hover >= 0) { x.strokeStyle = css("--border-strong"); x.beginPath(); x.moveTo(hx, T); x.lineTo(hx, T + ch); x.stroke(); }
    x.beginPath(); x.arc(hx, hy, 4, 0, 7); x.fillStyle = css("--accent"); x.fill();
    const tip = $("tip");
    if (S.hover >= 0) {
      tip.innerHTML = `${esc(pt.time)}<br>CPU <b>${pt.cpu}%</b> · RAM <b>${pt.ram}%</b> · NET <b>${pt.netKb} KB/s</b>`;
      tip.style.left = Math.max(8, Math.min(w - tip.offsetWidth - 8, hx - tip.offsetWidth / 2)) + "px";
      tip.classList.add("show");
    } else tip.classList.remove("show");
    const last = pts.at(-1);
    $("readout").innerHTML = net
      ? `<span class="key"><i></i>Jaringan</span><span>sekarang <b>${last.netKb} KB/s</b></span><span>puncak <b>${Math.max(...a1)} KB/s</b></span>`
      : `<span class="key"><i></i>CPU <b>${last.cpu}%</b></span><span class="key"><i class="c"></i>RAM <b>${last.ram}%</b></span><span>puncak CPU <b>${Math.max(...a1)}%</b></span>`;
  }

  function renderAll() {
    const d = S.data;
    if (!d) return;
    renderVerdict(d);
    renderWaPanel(d);
    renderHost(d);
    renderPickAndModel(d);
    renderTimeline(d);
    renderMatrix(d);
    renderProcs(d);
    renderTasks(d);
    renderChart();
  }

  async function apiPost(url, body = {}) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      $("pinGate").hidden = false;
      throw new Error("Autentikasi diperlukan.");
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function fetchStatus() {
    try {
      const t0 = performance.now();
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.status === 401) {
        $("pinGate").hidden = false;
        return;
      }
      if (!res.ok) throw new Error(res.status);
      S.data = await res.json();
      S.rtt = Math.round(performance.now() - t0);
      S.tel = S.data.telemetry || [];
      renderAll();
    } catch (_) {
      $("verdict").dataset.state = "bad";
      $("verdictTitle").textContent = "Dashboard terputus";
    }
  }

  function connectStream() {
    if (S.es) { try { S.es.close(); } catch (_) {} S.es = null; }
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (S.paused) { setSseBadge("warn", "Dijeda"); return; }
    if (!window.EventSource) {
      setSseBadge("", `Poll ${S.poll / 1000}s`);
      S.timer = setInterval(() => { if (!S.paused) fetchStatus(); }, S.poll);
      return;
    }
    const es = new EventSource(`/api/stream?interval=${S.poll}`);
    S.es = es;
    es.onopen = () => { if (S.timer) { clearInterval(S.timer); S.timer = null; } setSseBadge("ok", "SSE Live"); };
    es.onmessage = (ev) => {
      if (S.paused) return;
      try { S.data = JSON.parse(ev.data); S.tel = S.data.telemetry || []; renderAll(); setSseBadge("ok", "SSE Live"); } catch (_) {}
    };
    es.onerror = () => {
      if (S.paused) return;
      setSseBadge("warn", "Reconnect…");
      if (!S.timer) S.timer = setInterval(() => { if (!S.paused) fetchStatus(); }, S.poll);
    };
  }

  async function fetchLogs() {
    try {
      const res = await fetch(`/api/logs?process=${encodeURIComponent(S.logProc)}&lines=40`, { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json(), box = $("logBox");
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      let lines = [...(d.out || []).map((l) => ["", l]), ...(d.err || []).map((l) => ["err", l])].filter(([, l]) => l);
      if (S.filter) lines = lines.filter(([, l]) => l.toLowerCase().includes(S.filter));
      box.innerHTML = lines.map(([c, l]) => `<div class="${c}">${esc(l)}</div>`).join("") || '<div class="empty">Belum ada log.</div>';
      $("logSub").textContent = `${d.out?.length || 0} out · ${d.err?.length || 0} err`;
      if (atBottom) box.scrollTop = box.scrollHeight;
    } catch (_) {}
  }

  // Event Listeners
  const stage = $("stage");
  const hov = (cx) => {
    if (!S.tel.length) return;
    const r = stage.getBoundingClientRect();
    S.hover = Math.round(Math.max(0, Math.min(1, (cx - r.left - 40) / (r.width - 52))) * (S.tel.length - 1));
    renderChart();
  };
  stage.addEventListener("pointermove", (e) => hov(e.clientX));
  stage.addEventListener("pointerdown", (e) => hov(e.clientX));
  stage.addEventListener("pointerleave", () => { S.hover = -1; renderChart(); });

  $("pairForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = $("botPhoneInput").value.trim();
    if (!phone) return toast("Masukkan nomor WhatsApp Bot terlebih dahulu.", false);
    const btn = $("pairBtn");
    btn.disabled = true;
    try {
      const res = await apiPost("/api/wa/pair", { phoneNumber: phone });
      $("pairCodePanel").hidden = false;
      $("pairCodeVal").textContent = res.pairingCode;
      toast(`Kode pairing dibuat: ${res.pairingCode}`);
      fetchStatus();
    } catch (err) {
      toast(err.message, false);
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll("[data-wamode]").forEach((btn) => btn.addEventListener("click", async () => {
    try {
      await apiPost("/api/wa/mode", { mode: btn.dataset.wamode });
      toast(`Mode bot diubah ke ${btn.dataset.wamode.toUpperCase()}`);
      fetchStatus();
    } catch (err) { toast(err.message, false); }
  }));

  $("restartWaBtn").addEventListener("click", async () => {
    try {
      await apiPost("/api/pm2/restart", { target: "wa-bot" });
      toast("Service wa-bot direstart");
      setTimeout(fetchStatus, 1500);
    } catch (err) { toast(err.message, false); }
  });

  $("logoutWaBtn").addEventListener("click", async () => {
    if (!confirm("Yakin ingin mereset sesi WhatsApp agar bisa pairing nomor baru?")) return;
    try {
      await apiPost("/api/wa/logout");
      $("pairCodePanel").hidden = true;
      toast("Sesi WhatsApp direset. Silakan minta Pairing Code baru.");
      setTimeout(fetchStatus, 1200);
    } catch (err) { toast(err.message, false); }
  });

  $("modelSelect").addEventListener("change", async (e) => {
    try {
      await apiPost("/api/model", { modelId: e.target.value });
      toast(`Model diubah ke ${e.target.value}`);
    } catch (err) { toast(err.message, false); }
  });

  $("matrix").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-switch]");
    if (!btn) return;
    try {
      await apiPost("/api/switch-account", { target: btn.dataset.switch });
      toast(`Berhasil beralih ke akun ${btn.dataset.switch}`);
      fetchStatus();
    } catch (err) { toast(err.message, false); }
  });

  $("syncBtn").addEventListener("click", async () => {
    const b = $("syncBtn");
    b.classList.add("is-busy"); b.disabled = true;
    try {
      const r = await apiPost("/api/refresh-quotas");
      toast(`Kuota tersinkron (${r.accountsCount || 0} akun)`);
      fetchStatus();
    } catch (err) { toast(err.message, false); }
    finally { b.classList.remove("is-busy"); b.disabled = false; }
  });

  document.querySelectorAll("[data-poll]").forEach((b) => b.addEventListener("click", () => {
    S.poll = +b.dataset.poll;
    document.querySelectorAll("[data-poll]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    connectStream();
  }));
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    S.mode = b.dataset.mode; S.hover = -1;
    document.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    $("chartSub").textContent = S.mode === "net" ? "Throughput jaringan · KB/s" : "60 sampel · jendela 2 menit";
    renderChart();
  }));
  document.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.sort;
    S.sort = S.sort.k === k ? { k, d: -S.sort.d } : { k, d: -1 };
    document.querySelectorAll("[data-sort]").forEach((x) => { x.textContent = x.textContent.replace(/ [↑↓]$/, ""); });
    b.textContent += S.sort.d < 0 ? " ↓" : " ↑";
    if (S.data) renderProcs(S.data);
  }));

  $("searchToggleBtn")?.addEventListener("click", () => {
    const bar = document.querySelector(".bar"), open = bar.classList.toggle("search-open");
    $("searchToggleBtn").setAttribute("aria-expanded", open);
    if (open) $("filter").focus();
  });
  $("pauseBtn").addEventListener("click", () => {
    S.paused = !S.paused;
    const b = $("pauseBtn");
    b.querySelector("use").setAttribute("href", S.paused ? "#i-play" : "#i-pause");
    connectStream();
    if (!S.paused) { fetchStatus(); fetchLogs(); }
    toast(S.paused ? "Stream dijeda" : "Stream dilanjutkan");
  });
  $("exportBtn")?.addEventListener("click", () => {
    if (!S.data) return;
    const blob = new Blob([JSON.stringify(S.data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ops-snapshot-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    toast("Snapshot JSON diunduh");
  });
  $("logProc").addEventListener("change", (e) => { S.logProc = e.target.value; fetchLogs(); });
  $("filter").addEventListener("input", (e) => {
    S.filter = e.target.value.trim().toLowerCase();
    renderAll(); fetchLogs();
  });
  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      document.querySelector(".bar").classList.add("search-open");
      $("filter").focus();
    }
  });

  $("pinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("pinInput").value.trim();
    $("pinErr").textContent = "";
    try {
      await apiPost("/api/auth/login", { pin });
      $("pinGate").hidden = true;
      fetchStatus(); fetchLogs(); connectStream();
    } catch (err) {
      $("pinErr").textContent = err.message || "PIN salah";
    }
  });

  function tickClock() {
    $("clock").textContent = new Date().toLocaleTimeString("id-ID", { hour12: false }).replace(/\./g, ":");
    if (!S.paused) {
      document.querySelectorAll("[data-live-start]").forEach((el) => {
        const iso = el.getAttribute("data-live-start");
        if (iso) el.textContent = fmtElapsed(iso, el.textContent);
      });
    }
  }
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => { if (!S.paused && $("pinGate").hidden) fetchLogs(); }, 4000);
  addEventListener("resize", () => { if (S.data) renderChart(); });

  (async function boot() {
    try {
      const auth = await fetch("/api/auth/state", { cache: "no-store" }).then((r) => r.json());
      if (auth.pinRequired && !auth.authenticated) {
        $("pinGate").hidden = false;
        return;
      }
    } catch (_) {}
    await fetchStatus();
    fetchLogs();
    connectStream();
  })();
})();
