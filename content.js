(() => {
  const POLL_MS = 100;
  const RESCAN_MS = 3000;
  const MIN_RATE = 0.25;
  const MAX_RATE = 4.0;
  const STEP = 0.25;
  const LOG = "[GongSpeed]";
  const LOG_BUFFER_MAX = 5000;
  const LOG_BUFFER = [];
  const BOOT_TIME = new Date().toISOString();

  function safeSerialize(a) {
    if (a === undefined) return "undefined";
    if (a === null) return null;
    if (typeof a !== "object") return a;
    try {
      return JSON.parse(JSON.stringify(a));
    } catch (_) {
      try { return String(a); } catch (__) { return "[unserializable]"; }
    }
  }

  function startOfTodayMs() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function pruneBuffer() {
    const cutoff = startOfTodayMs();
    let drop = 0;
    while (LOG_BUFFER.length > 0 && LOG_BUFFER[0].t < cutoff) {
      LOG_BUFFER.shift();
      drop++;
    }
    return drop;
  }

  function gsLog(level, ...args) {
    const entry = {
      t: Date.now(),
      iso: new Date().toISOString(),
      level,
      args: args.map(safeSerialize)
    };
    LOG_BUFFER.push(entry);
    pruneBuffer();
    if (LOG_BUFFER.length > LOG_BUFFER_MAX) LOG_BUFFER.shift();
    try { (console[level] || console.log)(LOG, ...args); } catch (_) {}
  }

  let speedMap = {};
  let defaultRate = 1.0;
  let speakers = [];
  let lastAppliedRate = null;
  let lastSpeakerName = null;
  let lastLoggedSpeaker = null;
  let scanIntervalId = null;
  let applyIntervalId = null;
  let extensionDead = false;

  function extensionAlive() {
    if (extensionDead) return false;
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function markDead(reason) {
    if (extensionDead) return;
    extensionDead = true;
    gsLog("warn","extension context invalidated — tearing down", reason);
    try { if (scanIntervalId) clearInterval(scanIntervalId); } catch (_) {}
    try { if (applyIntervalId) clearInterval(applyIntervalId); } catch (_) {}
    try {
      document.querySelectorAll(".gong-speed-inline").forEach((el) => el.remove());
    } catch (_) {}
    try {
      const b = document.getElementById("gong-speed-badge");
      if (b) b.remove();
    } catch (_) {}
  }

  function safeChromeCall(fn) {
    if (!extensionAlive()) {
      markDead("safeChromeCall before invoke");
      return null;
    }
    try {
      return fn();
    } catch (err) {
      if (err && /Extension context invalidated/i.test(err.message || "")) {
        markDead(err.message);
        return null;
      }
      throw err;
    }
  }

  function normName(name) {
    if (typeof name !== "string") return "";
    return name
      .normalize("NFC")
      .replace(/[​-‍﻿]/g, "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function migrateMap(raw) {
    const out = {};
    const moves = [];
    for (const [k, v] of Object.entries(raw || {})) {
      const nk = normName(k);
      if (!nk) continue;
      if (nk !== k) moves.push([k, nk]);
      if (typeof v === "number") {
        if (typeof out[nk] === "number" && out[nk] !== v) {
          gsLog("warn","migration collision", { key: nk, existing: out[nk], incoming: v });
        }
        out[nk] = v;
      }
    }
    return { map: out, moves };
  }

  function loadConfig() {
    safeChromeCall(() => chrome.storage.local.get(["speedMap", "defaultRate"], (res) => {
      if (chrome.runtime.lastError) {
        gsLog("warn","loadConfig lastError", chrome.runtime.lastError.message);
        return;
      }
      const raw = res.speedMap || {};
      const { map, moves } = migrateMap(raw);
      speedMap = map;
      defaultRate = typeof res.defaultRate === "number" ? res.defaultRate : 1.0;
      gsLog("log","loadConfig", { raw, normalized: map, moves, defaultRate });
      if (moves.length > 0 || JSON.stringify(raw) !== JSON.stringify(map)) {
        gsLog("log","writing migrated speedMap back to storage");
        safeChromeCall(() => chrome.storage.local.set({ speedMap: map }));
      }
      apply(true);
    }));
  }
  safeChromeCall(() => chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.speedMap) {
      const incoming = changes.speedMap.newValue || {};
      const { map } = migrateMap(incoming);
      speedMap = map;
      gsLog("log","storage.onChanged speedMap", { incoming, normalized: map });
    }
    if (changes.defaultRate) {
      defaultRate =
        typeof changes.defaultRate.newValue === "number"
          ? changes.defaultRate.newValue
          : 1.0;
      gsLog("log","storage.onChanged defaultRate", defaultRate);
    }
    injectInlineControls();
    apply(true);
  }));

  async function bumpSpeakerKey(key, name, delta) {
    const cur = typeof speedMap[key] === "number" ? speedMap[key] : defaultRate;
    const next = clamp(cur + delta);
    const newMap = { ...speedMap, [key]: next };
    gsLog("log","inline bump", { speaker: name, key, cur, delta, next });
    if (!extensionAlive()) { markDead("bumpSpeakerKey"); return; }
    try {
      await chrome.storage.local.set({ speedMap: newMap });
    } catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) markDead(err.message);
      else throw err;
    }
  }

  async function resetSpeakerKey(key, name) {
    if (!(key in speedMap)) {
      gsLog("log","inline reset (already default)", { speaker: name, key });
      return;
    }
    const newMap = { ...speedMap };
    delete newMap[key];
    gsLog("log","inline reset", { speaker: name, key, removed: speedMap[key] });
    if (!extensionAlive()) { markDead("resetSpeakerKey"); return; }
    try {
      await chrome.storage.local.set({ speedMap: newMap });
    } catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) markDead(err.message);
      else throw err;
    }
  }

  function styleInlineButton(b) {
    Object.assign(b.style, {
      cursor: "pointer",
      border: "1px solid rgba(0,0,0,0.15)",
      background: "rgba(255,255,255,0.95)",
      borderRadius: "4px",
      width: "18px",
      height: "18px",
      padding: "0",
      margin: "0",
      font: "600 12px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      color: "#111",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "0 1px 2px rgba(0,0,0,0.06)"
    });
  }

  function buildInlineHost(sp) {
    const host = document.createElement("span");
    host.className = "gong-speed-inline";
    host.setAttribute("data-gs-id", sp.id);
    host.setAttribute("data-gs-key", sp.normKey);
    host.setAttribute("data-gs-name", sp.name);
    Object.assign(host.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "3px",
      marginLeft: "8px",
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      pointerEvents: "auto",
      userSelect: "none"
    });

    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.title = "Slower";
    minus.setAttribute("data-gs-action", "minus");
    styleInlineButton(minus);

    const val = document.createElement("span");
    val.className = "gsv";
    Object.assign(val.style, {
      minWidth: "34px",
      textAlign: "center",
      padding: "2px 6px",
      borderRadius: "10px",
      font: "600 11px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      background: "rgba(99, 102, 241, 0.14)",
      color: "#3730a3"
    });

    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.title = "Faster";
    plus.setAttribute("data-gs-action", "plus");
    styleInlineButton(plus);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "↺";
    reset.title = "Reset to default";
    reset.setAttribute("data-gs-action", "reset");
    styleInlineButton(reset);

    host.append(minus, val, plus, reset);
    return host;
  }

  function handleInlineEvent(e) {
    const btn = e.target.closest && e.target.closest("button[data-gs-action]");
    if (!btn) return;
    const host = btn.closest(".gong-speed-inline");
    if (!host) return;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

    if (e.type !== "click") return;

    const action = btn.getAttribute("data-gs-action");
    const key = host.getAttribute("data-gs-key");
    const name = host.getAttribute("data-gs-name") || "";
    gsLog("log","inline click", { action, key, name, eventType: e.type });
    if (action === "minus") bumpSpeakerKey(key, name, -STEP);
    else if (action === "plus") bumpSpeakerKey(key, name, STEP);
    else if (action === "reset") resetSpeakerKey(key, name);
  }

  ["pointerdown", "mousedown", "click", "pointerup", "mouseup"].forEach((evt) => {
    document.addEventListener(evt, handleInlineEvent, true);
  });

  function injectInlineControls() {
    const nodes = document.querySelectorAll(".speaker[data-speaker-id]");
    let injected = 0;
    let updated = 0;
    nodes.forEach((el) => {
      const id = el.getAttribute("data-speaker-id");
      const sp = speakers.find((s) => s.id === id);
      if (!sp) return;

      let host = el.querySelector(":scope > .gong-speed-inline, .gong-speed-inline[data-gs-id='" + id + "']");
      if (!host) {
        host = buildInlineHost(sp);
        const nameEl =
          el.querySelector(".speaker-name.no-capture") ||
          el.querySelector(".speaker-name") ||
          el.querySelector(".speaker-identity");
        if (nameEl && nameEl.parentElement) {
          nameEl.parentElement.insertBefore(host, nameEl.nextSibling);
        } else {
          el.appendChild(host);
        }
        injected++;
      } else {
        updated++;
      }

      const hasOverride = typeof speedMap[sp.normKey] === "number";
      const rate = hasOverride ? speedMap[sp.normKey] : defaultRate;
      const valEl = host.querySelector(".gsv");
      if (valEl) valEl.textContent = `${rate}×`;
      host.style.opacity = hasOverride ? "1" : "0.6";
      host.dataset.override = hasOverride ? "1" : "0";
      host.dataset.rate = String(rate);
    });
    if (injected > 0 || updated > 0) {
      gsLog("log","injectInlineControls", { injected, updated, total: nodes.length });
    }
  }

  function scanSpeakers() {
    const list = [];
    const nodes = document.querySelectorAll(".speaker[data-speaker-id]");
    nodes.forEach((el) => {
      const id = el.getAttribute("data-speaker-id");
      const aria = el.querySelector(".speaker-identity")?.getAttribute("aria-label") || null;
      const nameNoCap = el.querySelector(".speaker-name.no-capture")?.textContent?.trim() || null;
      const nameEl = el.querySelector(".speaker-name")?.textContent?.trim() || null;
      const rawName = aria || nameNoCap || nameEl || "Unknown";

      const segments = [];
      el.querySelectorAll(".speaker-segment[data-from][data-to]").forEach((s) => {
        const from = parseFloat(s.getAttribute("data-from"));
        const to = parseFloat(s.getAttribute("data-to"));
        if (!isNaN(from) && !isNaN(to)) segments.push({ from, to });
      });
      segments.sort((a, b) => a.from - b.from);
      list.push({ id, name: rawName, normKey: normName(rawName), sources: { aria, nameNoCap, nameEl }, segments });
    });

    const prev = JSON.stringify(speakers.map((s) => ({ id: s.id, name: s.name, normKey: s.normKey, segs: s.segments.length })));
    const next = JSON.stringify(list.map((s) => ({ id: s.id, name: s.name, normKey: s.normKey, segs: s.segments.length })));
    if (prev !== next) {
      gsLog("log","scanSpeakers", {
        count: list.length,
        speakers: list.map((s) => ({
          id: s.id,
          name: s.name,
          normKey: s.normKey,
          segs: s.segments.length,
          sources: s.sources,
          override: typeof speedMap[s.normKey] === "number" ? speedMap[s.normKey] : null
        }))
      });
    }
    speakers = list;
    injectInlineControls();

    safeChromeCall(() => chrome.runtime.sendMessage(
      {
        type: "SPEAKERS_UPDATED",
        speakers: list.map((s) => ({ id: s.id, name: s.name }))
      },
      () => {
        if (chrome.runtime.lastError) {
          const m = chrome.runtime.lastError.message || "";
          if (/Extension context invalidated/i.test(m)) markDead(m);
        }
      }
    ));
  }

  let lastNoMediaLog = 0;
  function getVideo() {
    const v = document.querySelector("video");
    if (v) return v;
    const a = document.querySelector("audio");
    if (a) return a;
    const all = document.querySelectorAll("video, audio");
    if (all.length > 0) return all[0];
    const now = Date.now();
    if (now - lastNoMediaLog > 5000) {
      lastNoMediaLog = now;
      gsLog("log", "no media element found", {
        videoCount: document.querySelectorAll("video").length,
        audioCount: document.querySelectorAll("audio").length,
        iframes: document.querySelectorAll("iframe").length
      });
    }
    return null;
  }

  function findSpeakerAt(time) {
    for (const sp of speakers) {
      for (const seg of sp.segments) {
        if (time >= seg.from && time <= seg.to) return sp;
        if (seg.from > time) break;
      }
    }
    return null;
  }

  function rateFor(name) {
    if (!name) return defaultRate;
    const key = normName(name);
    if (typeof speedMap[key] === "number") return speedMap[key];
    return defaultRate;
  }

  function clamp(r) {
    return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(r * 100) / 100));
  }

  function apply(force = false) {
    const video = getVideo();
    if (!video) return;
    const sp = findSpeakerAt(video.currentTime);
    const name = sp?.name || null;
    const key = sp ? sp.normKey : null;
    const rate = rateFor(name);
    const hit = key !== null && typeof speedMap[key] === "number";

    const prevRate = video.playbackRate;
    const drifted = Math.abs(prevRate - rate) > 0.01;
    if (drifted) {
      video.playbackRate = rate;
      if (Math.abs(prevRate - rate) > 0.05) {
        gsLog("log","enforce rate", { speaker: name, normKey: key, target: rate, was: prevRate });
      }
    }

    if (force || rate !== lastAppliedRate || name !== lastSpeakerName) {
      lastAppliedRate = rate;
      lastSpeakerName = name;
      lastLoggedSpeaker = name;
      updateBadge(name, rate);
      gsLog("log","apply", {
        force,
        currentTime: video.currentTime,
        speaker: name,
        speakerId: sp?.id || null,
        normKey: key,
        rate,
        hit,
        defaultRate,
        prevPlaybackRate: prevRate,
        newPlaybackRate: video.playbackRate,
        drifted,
        mapKeys: Object.keys(speedMap)
      });
    } else if (name !== lastLoggedSpeaker) {
      lastLoggedSpeaker = name;
      gsLog("log","apply (no-op, speaker stable)", { speaker: name, normKey: key, rate, hit });
    }
  }

  let badge, flashTimer;
  function ensureBadge() {
    if (badge && document.body.contains(badge)) return badge;
    badge = document.createElement("div");
    badge.id = "gong-speed-badge";
    Object.assign(badge.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      background: "rgba(17, 24, 39, 0.92)",
      color: "#fff",
      font: "500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      padding: "8px 12px",
      borderRadius: "8px",
      pointerEvents: "none",
      boxShadow: "0 4px 12px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.12)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      border: "1px solid rgba(255,255,255,0.08)",
      transition: "background-color 200ms ease",
      letterSpacing: "0.01em"
    });
    document.body.appendChild(badge);
    return badge;
  }
  function updateBadge(name, rate, flashMsg) {
    const b = ensureBadge();
    b.textContent = flashMsg
      ? flashMsg
      : name
      ? `${name} · ${rate}×`
      : `— · ${rate}× (default)`;
    if (flashMsg) {
      b.style.background = "rgba(99, 102, 241, 0.95)";
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        b.style.background = "rgba(17, 24, 39, 0.92)";
        const v = getVideo();
        const sp = v ? findSpeakerAt(v.currentTime) : null;
        const r = rateFor(sp?.name || null);
        b.textContent = sp?.name ? `${sp.name} · ${r}×` : `— · ${r}× (default)`;
      }, 900);
    }
  }

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  async function adjustCurrentSpeaker(delta) {
    const v = getVideo();
    if (!v) return;
    const sp = findSpeakerAt(v.currentTime);
    if (!sp) return adjustDefault(delta);
    const key = sp.normKey;
    const cur = typeof speedMap[key] === "number" ? speedMap[key] : defaultRate;
    const next = clamp(cur + delta);
    const newMap = { ...speedMap, [key]: next };
    gsLog("log","adjustCurrentSpeaker", { speaker: sp.name, key, cur, delta, next });
    if (!extensionAlive()) { markDead("adjustCurrentSpeaker"); return; }
    try { await chrome.storage.local.set({ speedMap: newMap }); }
    catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) { markDead(err.message); return; }
      throw err;
    }
    updateBadge(sp.name, next, `${sp.name} → ${next}×`);
  }

  async function resetCurrentSpeaker() {
    const v = getVideo();
    if (!v) return;
    const sp = findSpeakerAt(v.currentTime);
    if (!sp) return;
    const key = sp.normKey;
    if (!(key in speedMap)) {
      gsLog("log","resetCurrentSpeaker (already default)", { speaker: sp.name, key });
      updateBadge(sp.name, defaultRate, `${sp.name} already at default`);
      return;
    }
    const newMap = { ...speedMap };
    delete newMap[key];
    gsLog("log","resetCurrentSpeaker", { speaker: sp.name, key, removed: speedMap[key] });
    if (!extensionAlive()) { markDead("resetCurrentSpeaker"); return; }
    try { await chrome.storage.local.set({ speedMap: newMap }); }
    catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) { markDead(err.message); return; }
      throw err;
    }
    updateBadge(sp.name, defaultRate, `${sp.name} reset → ${defaultRate}×`);
  }

  async function adjustDefault(delta) {
    const next = clamp(defaultRate + delta);
    gsLog("log","adjustDefault", { cur: defaultRate, delta, next });
    if (!extensionAlive()) { markDead("adjustDefault"); return; }
    try { await chrome.storage.local.set({ defaultRate: next }); }
    catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) { markDead(err.message); return; }
      throw err;
    }
    updateBadge(null, next, `default → ${next}×`);
  }

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;

    if (e.key === "]" || e.key === "}") {
      e.preventDefault();
      e.shiftKey ? adjustDefault(STEP) : adjustCurrentSpeaker(STEP);
    } else if (e.key === "[" || e.key === "{") {
      e.preventDefault();
      e.shiftKey ? adjustDefault(-STEP) : adjustCurrentSpeaker(-STEP);
    } else if (e.key === "\\") {
      e.preventDefault();
      resetCurrentSpeaker();
    }
  }, true);

  safeChromeCall(() => chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_LOGS") {
      const droppedOld = pruneBuffer();
      const v = getVideo();
      sendResponse({
        bootTime: BOOT_TIME,
        capturedAt: new Date().toISOString(),
        dayStart: new Date(startOfTodayMs()).toISOString(),
        url: location.href,
        userAgent: navigator.userAgent,
        speedMap,
        defaultRate,
        speakers: speakers.map((s) => ({ id: s.id, name: s.name, normKey: s.normKey, segments: s.segments.length, sources: s.sources })),
        video: v ? { tag: v.tagName, currentTime: v.currentTime, playbackRate: v.playbackRate, paused: v.paused, duration: v.duration } : null,
        lastAppliedRate,
        lastSpeakerName,
        extensionDead,
        droppedOldOnFetch: droppedOld,
        logCount: LOG_BUFFER.length,
        logs: LOG_BUFFER.slice()
      });
      return true;
    }
    if (msg?.type === "CLEAR_LOGS") {
      LOG_BUFFER.length = 0;
      gsLog("log", "log buffer cleared via popup");
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "GET_SPEAKERS") {
      gsLog("log","GET_SPEAKERS request", {
        speakerCount: speakers.length,
        speakers: speakers.map((s) => ({ id: s.id, name: s.name, normKey: s.normKey })),
        speedMap,
        defaultRate
      });
      sendResponse({
        speakers: speakers.map((s) => ({ id: s.id, name: s.name })),
        speedMap,
        defaultRate
      });
      return true;
    }
  }));

  function safeScan() {
    if (!extensionAlive()) { markDead("safeScan tick"); return; }
    try { scanSpeakers(); }
    catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) markDead(err.message);
      else gsLog("error","scanSpeakers threw", err);
    }
  }
  function safeApply() {
    if (!extensionAlive()) { markDead("safeApply tick"); return; }
    try { apply(); }
    catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) markDead(err.message);
      else gsLog("error","apply threw", err);
    }
  }

  gsLog("log","content.js boot", { url: location.href, ua: navigator.userAgent });
  loadConfig();
  safeScan();
  scanIntervalId = setInterval(safeScan, RESCAN_MS);
  applyIntervalId = setInterval(safeApply, POLL_MS);

  function isMediaTag(el) {
    return el && (el.tagName === "VIDEO" || el.tagName === "AUDIO");
  }

  document.addEventListener("seeked", (e) => {
    if (!isMediaTag(e.target)) return;
    gsLog("log", "media seeked", { tag: e.target.tagName, currentTime: e.target.currentTime });
    if (!extensionAlive()) { markDead("seeked handler"); return; }
    try { apply(true); }
    catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) markDead(err.message);
    }
  }, true);

  document.addEventListener("ratechange", (e) => {
    if (!isMediaTag(e.target)) return;
    if (!extensionAlive()) { markDead("ratechange handler"); return; }
    try { apply(false); }
    catch (err) {
      if (/Extension context invalidated/i.test(err.message || "")) markDead(err.message);
    }
  }, true);

  document.addEventListener("play", (e) => {
    if (!isMediaTag(e.target)) return;
    if (!extensionAlive()) return;
    gsLog("log", "media play", { tag: e.target.tagName });
    try { apply(true); } catch (_) {}
  }, true);

  document.addEventListener("loadedmetadata", (e) => {
    if (!isMediaTag(e.target)) return;
    gsLog("log", "media loadedmetadata", { tag: e.target.tagName, duration: e.target.duration });
    if (!extensionAlive()) return;
    try { apply(true); } catch (_) {}
  }, true);
})();