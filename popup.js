const MIN = 0.25;
const MAX = 4.0;
const LOG = "[GongSpeed:popup]";

function clamp(v) {
  return Math.min(MAX, Math.max(MIN, Math.round(v * 100) / 100));
}

function normName(name) {
  if (typeof name !== "string") return "";
  return name
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pillClass(rate) {
  if (rate < 1) return "slow";
  if (rate >= 2.5) return "fastest";
  if (rate >= 2) return "faster";
  if (rate >= 1.25) return "fast";
  return "";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function makeStepperRow({ name, value, isDefault, onChange }) {
  const row = document.createElement("div");
  row.className = "row";

  const nameEl = document.createElement("span");
  nameEl.className = "name" + (isDefault ? " is-default" : "");
  nameEl.title = name;
  nameEl.textContent = name;

  const pill = document.createElement("span");
  pill.className = "pill " + pillClass(value);
  pill.textContent = `${value}×`;

  const stepper = document.createElement("div");
  stepper.className = "stepper";

  const minus = document.createElement("button");
  minus.type = "button";
  minus.textContent = "−";
  minus.setAttribute("aria-label", "Decrease");

  const input = document.createElement("input");
  input.type = "number";
  input.min = MIN;
  input.max = MAX;
  input.step = 0.25;
  input.value = value;

  const plus = document.createElement("button");
  plus.type = "button";
  plus.textContent = "+";
  plus.setAttribute("aria-label", "Increase");

  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = "×";

  stepper.append(minus, input, plus);
  row.append(nameEl, pill, stepper, unit);

  function update(v) {
    const next = clamp(v);
    input.value = next;
    pill.textContent = `${next}×`;
    pill.className = "pill " + pillClass(next);
    nameEl.classList.remove("is-default");
    onChange(next);
  }

  minus.addEventListener("click", () => update(parseFloat(input.value) - 0.25));
  plus.addEventListener("click", () => update(parseFloat(input.value) + 0.25));
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (!isNaN(v)) update(v);
  });

  return row;
}

function render(speakers, speedMap, defaultRate) {
  const defaultInput = document.getElementById("default-rate");
  defaultInput.value = defaultRate ?? 1;

  const list = document.getElementById("list");
  list.innerHTML = "";

  if (!speakers || speakers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No speakers detected. Open a Gong call page.";
    list.appendChild(empty);
    return;
  }

  speakers.forEach((s) => {
    const key = normName(s.name);
    const hasOverride = typeof speedMap[key] === "number";
    const value = hasOverride ? speedMap[key] : defaultRate ?? 1;
    console.log(LOG, "render row", { name: s.name, key, hasOverride, value });

    const row = makeStepperRow({
      name: s.name,
      value,
      isDefault: !hasOverride,
      onChange: async (next) => {
        const { speedMap: cur = {} } = await chrome.storage.local.get(["speedMap"]);
        cur[key] = next;
        console.log(LOG, "save override", { name: s.name, key, next, fullMap: cur });
        await chrome.storage.local.set({ speedMap: cur });
      }
    });
    list.appendChild(row);
  });
}

document.querySelectorAll('#default-row button[data-step]').forEach((btn) => {
  btn.addEventListener("click", async () => {
    const input = document.getElementById("default-rate");
    const next = clamp(parseFloat(input.value) + parseFloat(btn.dataset.step));
    input.value = next;
    await chrome.storage.local.set({ defaultRate: next });
  });
});

document.getElementById("default-rate").addEventListener("change", async (e) => {
  const v = clamp(parseFloat(e.target.value));
  if (isNaN(v)) return;
  e.target.value = v;
  await chrome.storage.local.set({ defaultRate: v });
});

function setStatus(text, ok = true) {
  const el = document.getElementById("log-status");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "var(--text-muted)" : "var(--danger)";
}

function todayStartMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildLogText(payload) {
  const cutoff = todayStartMs();
  const filtered = (payload.logs || []).filter((e) => e.t >= cutoff);
  const head = [
    `# GongSpeed log dump (today only)`,
    `# captured:  ${payload.capturedAt}`,
    `# dayStart:  ${payload.dayStart}`,
    `# boot:      ${payload.bootTime}`,
    `# url:       ${payload.url}`,
    `# bufferAll: ${payload.logCount}`,
    `# todayOnly: ${filtered.length}`,
    `# extensionDead: ${payload.extensionDead}`,
    ``,
    `## state`,
    JSON.stringify({
      speedMap: payload.speedMap,
      defaultRate: payload.defaultRate,
      lastAppliedRate: payload.lastAppliedRate,
      lastSpeakerName: payload.lastSpeakerName,
      video: payload.video,
      speakers: payload.speakers
    }, null, 2),
    ``,
    `## logs`
  ];
  const lines = filtered.map((e) => {
    const argsStr = e.args.map((a) =>
      typeof a === "string" ? a : JSON.stringify(a)
    ).join(" ");
    return `[${e.iso}] [${e.level}] ${argsStr}`;
  });
  return { text: head.concat(lines).join("\n"), filtered };
}

document.getElementById("download-logs").addEventListener("click", async () => {
  setStatus("Fetching logs…");
  try {
    const tab = await getActiveTab();
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_LOGS" });
    if (!resp) {
      setStatus("No response from page (refresh Gong tab?)", false);
      return;
    }
    const { text, filtered } = buildLogText(resp);
    const filteredPayload = { ...resp, logs: filtered, logCount: filtered.length };
    const json = JSON.stringify(filteredPayload, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const textBlob = new Blob([text], { type: "text/plain" });
    const jsonBlob = new Blob([json], { type: "application/json" });
    const aText = document.createElement("a");
    aText.href = URL.createObjectURL(textBlob);
    aText.download = `gongspeed-logs-${stamp}.txt`;
    document.body.appendChild(aText);
    aText.click();
    aText.remove();
    setTimeout(() => URL.revokeObjectURL(aText.href), 1000);

    const aJson = document.createElement("a");
    aJson.href = URL.createObjectURL(jsonBlob);
    aJson.download = `gongspeed-logs-${stamp}.json`;
    document.body.appendChild(aJson);
    aJson.click();
    aJson.remove();
    setTimeout(() => URL.revokeObjectURL(aJson.href), 1000);

    setStatus(`Downloaded ${filtered.length} entries (today only)`);
  } catch (err) {
    console.warn(LOG, "download logs failed", err);
    setStatus("Failed: " + (err?.message || "unknown"), false);
  }
});

document.getElementById("clear-logs").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_LOGS" });
    setStatus("Logs cleared");
  } catch (err) {
    setStatus("Failed: " + (err?.message || "unknown"), false);
  }
});

document.getElementById("clear-overrides").addEventListener("click", async () => {
  await chrome.storage.local.set({ speedMap: {} });
  const tab = await getActiveTab();
  const { defaultRate = 1 } = await chrome.storage.local.get(["defaultRate"]);
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_SPEAKERS" });
    render(resp?.speakers || [], {}, defaultRate);
  } catch {
    render([], {}, defaultRate);
  }
});

(async () => {
  const tab = await getActiveTab();
  const { speedMap = {}, defaultRate = 1 } = await chrome.storage.local.get([
    "speedMap",
    "defaultRate"
  ]);
  console.log(LOG, "popup open", { tabId: tab?.id, tabUrl: tab?.url, speedMap, defaultRate });
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_SPEAKERS" });
    console.log(LOG, "GET_SPEAKERS response", resp);
    render(
      resp?.speakers || [],
      resp?.speedMap || speedMap,
      resp?.defaultRate ?? defaultRate
    );
  } catch (err) {
    console.warn(LOG, "GET_SPEAKERS failed", err);
    render([], speedMap, defaultRate);
  }
})();

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === "SPEAKERS_UPDATED") {
    const { speedMap = {}, defaultRate = 1 } = await chrome.storage.local.get([
      "speedMap",
      "defaultRate"
    ]);
    console.log(LOG, "SPEAKERS_UPDATED", { speakers: msg.speakers, speedMap, defaultRate });
    render(msg.speakers, speedMap, defaultRate);
  }
});