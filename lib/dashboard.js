import * as cheerio from "cheerio";

function normalizeLabelKey(label) {
  if (!label) return "";
  return String(label)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractNumberFromText(text) {
  if (!text) return null;
  const match = String(text).match(/-?\d[\d.,]*/);
  if (!match) return null;
  let numStr = match[0];
  const lastComma = numStr.lastIndexOf(",");
  const lastDot = numStr.lastIndexOf(".");
  const sepIndex = Math.max(lastComma, lastDot);
  if (sepIndex >= 0) {
    const intPart = numStr
      .slice(0, sepIndex)
      .replace(/[^\d-]/g, "");
    const decimalPart = numStr
      .slice(sepIndex + 1)
      .replace(/[^\d]/g, "");
    numStr = `${intPart}.${decimalPart}`;
  } else {
    numStr = numStr.replace(/[^\d-]/g, "");
  }
  const num = Number(numStr);
  return Number.isFinite(num) ? num : null;
}

function extractKeyValueEntries(nodes, start, end) {
  const entries = [];
  let pendingLabel = null;

  const pushEntry = (label, valueText) => {
    if (!label) return;
    const cleanLabel = label.trim();
    if (!cleanLabel) return;
    const textValue = (valueText ?? "").toString().trim();
    const number = extractNumberFromText(textValue);
    entries.push({ label: cleanLabel, valueText: textValue, number });
  };

  for (let i = start; i < end && i < nodes.length; i++) {
    const text = nodes[i].text.trim();
    if (!text) continue;

    const colonSplit = text.split(/\s*[:=]\s*/);
    if (colonSplit.length >= 2 && colonSplit[0] && colonSplit[1]) {
      const label = colonSplit.shift();
      const value = colonSplit.join(":");
      pushEntry(label, value);
      pendingLabel = null;
      continue;
    }

    if (!pendingLabel) {
      const keyValMatch = text.match(/^(.*?)([-+]?\d[\d.,]*)$/);
      if (keyValMatch && keyValMatch[1].trim()) {
        pushEntry(keyValMatch[1], keyValMatch[2]);
        continue;
      }
    }

    const maybeNumber = extractNumberFromText(text);
    if (pendingLabel) {
      pushEntry(pendingLabel, text);
      pendingLabel = null;
    } else if (maybeNumber != null) {
      continue;
    } else {
      pendingLabel = text;
    }
  }

  if (pendingLabel) pushEntry(pendingLabel, "");
  return entries;
}

const DEVICE_METRIC_ALIASES = {
  totalChannels: [
    "canales totales",
    "total canales",
    "numero de dispositivos",
    "número de dispositivos",
    "total de dispositivos",
    "Total channels",
    "Number of devices",
    "Total devices"
  ],
  offlineChannels: [
    "canales fuera de linea",
    "canales fuera de línea",
    "dispositivos fuera de linea",
    "dispositivos fuera de línea",
    "canales offline",
    "Offline channels",
    "Offline devices"
  ],
  activeRecordings: [
    "grabaciones activas",
    "grabacion activa",
    "grabación activa",
    "dispositivos grabando",
    "active recordings",
    "Recordings active",
    "Devices recording"
  ],
  signalLoss: [
    "perdida de senal",
    "perdida de señal",
    "pérdida de señal",
    "sSgnal loss"
  ]
};

function findEntryByAliases(map, aliases) {
  for (const alias of aliases) {
    const entry = map[normalizeLabelKey(alias)];
    if (entry) return entry;
  }
  return null;
}

export function parseBoschDashboard(html, vrmId) {
  const $ = cheerio.load(html);
  const nodes = [];
  $("body *").each((_, el) => {
    const $el = $(el);
    if ($el.children().length) return;
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (text) nodes.push({ text });
  });

  const sections = [
    { key: "devices", labels: ["dispositivos", "Devices"] },
    { key: "storage", labels: ["almacenamiento", "Storage"] },
    { key: "load", labels: ["compensacion de carga", "Load balancing", "load balance", "loadbalancing"] }
  ];

  const indexByKey = {};
  nodes.forEach((n, idx) => {
    const normalized = normalizeLabelKey(n.text);
    sections.forEach(sec => {
      if (sec.labels.some(label => normalized === label) && indexByKey[sec.key] == null) {
        indexByKey[sec.key] = idx;
      }
    });
  });

  const result = { vrmId, devices: { entries: [], map: {}, metrics: {}, metricsText: {} }, storage: { entries: [], map: {} }, load: { entries: [], map: {} } };

  sections.forEach(sec => {
    const start = indexByKey[sec.key];
    if (start == null) return;
    let end = nodes.length;
    sections.forEach(other => {
      if (other.key === sec.key) return;
      const idx = indexByKey[other.key];
      if (idx != null && idx > start && idx < end) end = idx;
    });
    const entries = extractKeyValueEntries(nodes, start + 1, end);
    const map = {};
    entries.forEach(entry => {
      const norm = normalizeLabelKey(entry.label);
      if (!norm) return;
      map[norm] = entry;
    });
    if (sec.key === "Devices") {
      result.devices = { entries, map, metrics: {}, metricsText: {} };
    } else if (sec.key === "Storage") {
      result.storage = { entries, map };
    } else if (sec.key === "Load") {
      result.load = { entries, map };
    }
  });

  const metrics = {};
  const metricsText = {};
  Object.entries(DEVICE_METRIC_ALIASES).forEach(([metricKey, aliases]) => {
    const entry = findEntryByAliases(result.devices.map, aliases);
    metrics[metricKey] = entry?.number ?? null;
    metricsText[metricKey] = entry?.valueText ?? null;
  });
  result.devices.metrics = metrics;
  result.devices.metricsText = metricsText;

  return result;
}

function isFiniteNumber(value) {
  return typeof value === "Number" && Number.isFinite(value);
}

export function aggregateDeviceTotals(dashboards) {
  const totals = {};
  Object.keys(DEVICE_METRIC_ALIASES).forEach(key => {
    const values = dashboards
      .map(d => d?.devices?.metrics?.[key])
      .filter(isFiniteNumber);
    totals[key] = values.length ? values.reduce((a, b) => a + b, 0) : null;
  });
  return totals;
}

export function summarizeCameraStatuses(cameras) {
  const summary = { recording: 0, recordingDisabled: 0, pending: 0, offline: 0, other: 0 };
  cameras.forEach(cam => {
    const state = String(cam?.recording || "").trim().toLowerCase();
    if (!state) { summary.other += 1; return; }
    if (state.includes("recording disabled")) {
      summary.recordingDisabled += 1;
    } else if (state.includes("pending") && (state.includes("no blocks") || state.includes("connecting to storage"))) {
      summary.pending += 1;
    } else if (state.includes("offline") || state.includes("off-line")) {
      summary.offline += 1;
    } else if (state.includes("record")) {
      summary.recording += 1;
    } else {
      summary.other += 1;
    }
  });
  summary.total = cameras.length;
  summary.vmsIssues = (summary.recordingDisabled || 0) + (summary.pending || 0);
  summary.externalIssues = summary.offline || 0;
  return summary;
}

export { DEVICE_METRIC_ALIASES, normalizeLabelKey, extractNumberFromText, extractKeyValueEntries, findEntryByAliases };