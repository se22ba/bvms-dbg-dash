import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { Agent as HttpsAgent } from "https";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import multer from "multer";
import {
  detectExtension,
  extractPrimaryHtml,
  fetchAndParseDashboard,
  parseDashboardUpload
} from "./lib/fetchAndParseDashboard.js";


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const DEFAULT_VRMS = (() => {
  try { return JSON.parse(process.env.VRMS || "[]"); } catch { return []; }
})();

const DBG_USER = process.env.DBG_USER || "srvadmin";
const DBG_PASS = process.env.DBG_PASS || "DFDgsfe01!";


const httpsAgent = new HttpsAgent({ rejectUnauthorized: false });


let lastSnapshot = { ts: 0, vrms: [], cameras: [], vrmStats: [], progress: [], dashboards: [], overviewTotals: {}, cameraStatus: {} };

const RAW_DIR = path.resolve(process.cwd(), "data", "raw");
fs.mkdirSync(RAW_DIR, { recursive: true });

function saveRaw(host, name, contents) {
  try {
    const dir = path.join(RAW_DIR, host);
    fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), contents, "utf8");
  } catch {}
}
function sanitizePathSegment(value, fallback) {
  const str = String(value || "").trim();
  if (!str) return fallback;
  const sanitized = str.replace(/[^a-z0-9._-]+/gi, "_");
  return sanitized || fallback;
}

function saveConvertedHtml({ host, label, logicalName = "bosch-vrm", html, ext }) {
  if (!html) return;
  try {
    const folder =
      sanitizePathSegment(host, null) ||
      sanitizePathSegment(label, null) ||
      "uploads";
    const baseName =
      sanitizePathSegment(logicalName, null) ||
      sanitizePathSegment(label, null) ||
      "bosch-vrm";
    const extension = ext && ext.startsWith(".") ? ext : `.${ext || "html"}`;
    saveRaw(folder, `${baseName}${extension}`, html);
  } catch {}
}

function authHeader(u, p) {
  return { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") };
}
async function fetchWithTimeout(url, { https = false, headers = {}, timeout = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeout);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers,
      agent: https ? httpsAgent : undefined,
      signal: controller.signal
    });
    const text = await r.text();
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
      text
    };
  } finally { clearTimeout(t); }
}


async function downloadFirst(host, logicalName, candidates, user, pass, progress) {
  const ping = (m) => { progress.push(m); console.log(m); };
  for (const scheme of ["https", "http"]) {
    for (const rel of candidates) {
      const url = `${scheme}://${host}${rel}`;
      try {
        const r = await fetchWithTimeout(url, {
          https: scheme === "https",
          headers: {
            ...authHeader(user, pass),
            Accept: "*/*",
            Referer: `${scheme}://${host}/dbg`
          }
        });
        if (r.ok && r.status === 200) {
          const contentType = r.headers.get("content-type");
          const raw = r.text;
          const ext = detectExtension(rel, contentType, raw);
          saveRaw(host, `${logicalName}${ext}`, raw);
          const html = extractPrimaryHtml(raw, { contentType, ext });
          ping(`✓ ${host} ${logicalName} ← ${rel} (${scheme.toUpperCase()})`);
            return { ok: true, scheme, rel, ext, html, contentType, raw };
        } else {
          ping(`· ${host} ${logicalName} ${r.status} ${r.statusText} ← ${rel} (${scheme})`);
        }
      } catch (e) {
        ping(`· ${host} ${logicalName} error ${String(e.message)} ← ${rel} (${scheme})`);
      }
    }
  }
  return { ok: false, error: `no encontrado (${logicalName})` };
}

/* ---------------- Parsers ---------------------- */
// showTargets.htm
function parseTargets(html, vrmId) {
  const $ = cheerio.load(html);
  const out = { vrmId, targets: [], totals: {}, connections: [] };

  
  $("table").first().find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length >= 13) {
      out.targets.push({
        vrmId,
        target: td.eq(0).text().trim(),
        connTime: td.eq(1).text().trim(),
        
        bitrate: Number(td.eq(5).text().trim() || 0),
        totalGiB: Number(td.eq(6).text().trim() || 0),
        availableGiB: Number(td.eq(7).text().trim() || 0),
        emptyGiB: Number(td.eq(8).text().trim() || 0),
        protectedGiB: Number(td.eq(9).text().trim() || 0),
        slices: Number(td.eq(10).text().trim() || 0),
        outOfRes: Number(td.eq(11).text().trim() || 0),
        lastOutOfRes: td.eq(12).text().trim()
      });
    }
  });

  
  $("h1:contains('Targets'), h1:contains('Blocks')").each((_, h) => {
    const t = $(h).next("table");
    t.find("tr").each((_, tr) => {
      const k = $(tr).find("td").eq(0).text().trim();
      const v = $(tr).find("td").eq(1).text().trim();
      if (k) out.totals[k] = isNaN(Number(v)) ? v : Number(v);
    });
  });

  
  if (!Object.keys(out.totals).length && out.targets.length) {
    const sum = (k) => out.targets.reduce((a, t) => a + (Number(t[k]) || 0), 0);
    out.totals["Total GiB"]               = sum("totalGiB");
    out.totals["Available blocks [GiB]"]  = sum("availableGiB");
    out.totals["Empty blocks [GiB]"]      = sum("emptyGiB");
    out.totals["Protected blocks [GiB]"]  = sum("protectedGiB");
  }

  
  $("h1:contains('Connections')").next("table").find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    out.connections.push({ vrmId, target: td.eq(0).text().trim(), connections: Number(td.eq(1).text().trim() || 0) });
  });

  return out;
}

// showDevices.htm
function parseDevices(html, vrmId) {
  const $ = cheerio.load(html);
  const rows = [];
  $("table").first().find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length >= 18) {
      rows.push({
        vrmId,
        device: td.eq(0).text().trim(),           // 172.20.65.85\0
        guid: td.eq(1).text().trim(),
        mac: td.eq(2).text().trim(),
        fw: td.eq(3).text().trim(),
        url: td.eq(6).text().trim(),
        connTime: td.eq(7).text().trim(),
        allocatedBlocks: Number(td.eq(8).text().trim() || 0),
        limitedSpansSince: td.eq(9).text().trim(),
        lbMode: td.eq(10).text().trim(),
        primaryTarget: td.eq(11).text().trim(),
        maxBitrate: Number(td.eq(17).text().trim() || 0)
      });
    }
  });
  return rows;
}

// showCameras.htm (insensible a mayúsculas en headers y estado recording)
function parseCameras(html, vrmId) {
  const $ = cheerio.load(html);
  const rows = [];
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  const $tbl = $("table").first();
  const headerCells = $tbl.find("tr").first().find("th");
  const headerTexts = headerCells.map((i, th) => $(th).text().replace(/\s+/g, " ").trim()).get();
  const headers = headerTexts.map(norm);
  const idxByAny = (...labels) => {
    for (const label of labels) {
      const target = norm(label);
      const exact = headers.findIndex(h => h === target);
      if (exact >= 0) return exact;
    }
    for (const label of labels) {
      const target = norm(label);
      const partial = headers.findIndex(h => h.includes(target));
      if (partial >= 0) return partial;
    }
    return -1;
  };

  const iName          = idxByAny("camera name", "name");
  const iAddr          = idxByAny("address", "ip");
  const iRec           = idxByAny("recording state", "recording");
  const iCurBlock      = idxByAny("current block");
  const iPrimaryTarget = idxByAny("primary target");
  const iMaxBitrate    = idxByAny("max bitrate", "maximum bitrate");

  $tbl.find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (!td.length) return;
    const get = (i) => (i >= 0 ? td.eq(i).text().trim() : "");

    const name          = get(iName);
    const address       = get(iAddr);             // 172.20.65.85\0\1
    const recordingText = get(iRec);
    const recordingNorm = recordingText.toLowerCase();
    const currentBlock  = get(iCurBlock);
    const primaryTarget = get(iPrimaryTarget);
    const maxBitrateCam = Number(get(iMaxBitrate).replace(",", ".")) || null;

    const raw = {};
     headerTexts.forEach((h, i) => {
      if (!h) return;
      const value = td.eq(i).text().trim();
      raw[h] = value;
      const normalized = headers[i];
      if (normalized && !(normalized in raw)) raw[normalized] = value;
    });

     rows.push({
      vrmId,
      name,
      address,
      recording: recordingText,
      recordingNormalized: recordingNorm,
      currentBlock,
      primaryTarget,
      maxBitrateCam,
      raw
    });
  });

  return rows;
}
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

    // Skip if matches other headings exactly to avoid bleeding.
    const normalized = normalizeLabelKey(text);
    if ([
      "dispositivos",
      "devices",
      "almacenamiento",
      "storage",
      "compensacion de carga",
      "load balancing",
      "load balance",
      "loadbalancing"
    ].includes(normalized)) {
      if (pendingLabel) {
        pushEntry(pendingLabel, "");
        pendingLabel = null;
      }
      continue;
    }

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
      // value without explicit key, skip unless we have pending label
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
    "total channels",
    "number of devices",
    "total devices"
  ],
  offlineChannels: [
    "canales fuera de linea",
    "canales fuera de línea",
    "dispositivos fuera de linea",
    "dispositivos fuera de línea",
    "canales offline",
    "offline channels",
    "offline devices"
  ],
  activeRecordings: [
    "grabaciones activas",
    "grabacion activa",
    "grabación activa",
    "dispositivos grabando",
    "active recordings",
    "recordings active",
    "devices recording"
  ],
  signalLoss: [
    "perdida de senal",
    "perdida de señal",
    "pérdida de señal",
    "signal loss"
  ]
};

function findEntryByAliases(map, aliases) {
  for (const alias of aliases) {
    const entry = map[normalizeLabelKey(alias)];
    if (entry) return entry;
  }
  return null;
}

function parseBoschDashboard(html, vrmId) {
  const $ = cheerio.load(html);
  const nodes = [];
  $("body *").each((_, el) => {
    const $el = $(el);
    if ($el.children().length) return;
    const text = $el.text().replace(/\s+/g, " ").trim();
    if (text) nodes.push({ text });
  });

  const sections = [
     { key: "devices", labels: ["dispositivos", "devices"] },
    { key: "storage", labels: ["almacenamiento", "storage"] },
    { key: "load", labels: ["compensacion de carga", "load balancing", "load balance", "loadbalancing"] }
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
    if (sec.key === "devices") {
      result.devices = { entries, map, metrics: {}, metricsText: {} };
    } else if (sec.key === "storage") {
      result.storage = { entries, map };
    } else if (sec.key === "load") {
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
  return typeof value === "number" && Number.isFinite(value);
}

function aggregateDeviceTotals(dashboards) {
  const totals = {};
  Object.keys(DEVICE_METRIC_ALIASES).forEach(key => {
    const values = dashboards
      .map(d => d?.devices?.metrics?.[key])
      .filter(isFiniteNumber);
    totals[key] = values.length ? values.reduce((a, b) => a + b, 0) : null;
  });
  return totals;
}

function summarizeCameraStatuses(cameras) {
  const summary = { recording: 0, recordingDisabled: 0, pending: 0, offline: 0, other: 0 };
  cameras.forEach(cam => {
    const state = String(cam?.recording || "").trim().toLowerCase();
    if (!state) { summary.other += 1; return; }
    const norm = state;
    if (norm.includes("recording disabled")) {
      summary.recordingDisabled += 1;
    } else if (norm.includes("pending") && (norm.includes("no blocks") || norm.includes("connecting to storage"))) {
      summary.pending += 1;
    } else if (norm.includes("offline") || norm.includes("off-line")) {
      summary.offline += 1;
    } else if (norm.includes("record")) {
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


// Join por IP base (ignora \canal y /)
function joinCamerasDevices(camRows, devRows) {
  const ipBase = (s) => String(s || "").split("\\")[0].split("/")[0].trim();
  const devByIp = new Map();
  devRows.forEach(d => devByIp.set(ipBase(d.device), d));   // device: 172.20.65.85\0

  return camRows.map(c => {
    const dev = devByIp.get(ipBase(c.address));             // address: 172.20.65.85\0\1
    const maxBitrate = c.maxBitrateCam != null ? c.maxBitrateCam : (dev?.maxBitrate ?? null);
    return {
      ...c,
      device: dev?.device || c.address,
      fw: dev?.fw || "",
      connTime: dev?.connTime || "",
      allocatedBlocks: dev?.allocatedBlocks ?? null,
      primaryTarget: c.primaryTarget || dev?.primaryTarget || "",
      maxBitrate
    };
  });
}

/* ---------------- API ------------------------- */
app.get("/api/status", (_req, res) => res.json({ ok: true, lastSnapshot: lastSnapshot.ts }));

// Online /scan
app.post("/api/scan", async (req, res) => {
  const { vrms = DEFAULT_VRMS, user = DBG_USER, pass = DBG_PASS } = req.body || {};
  if (!Array.isArray(vrms) || !vrms.length) return res.status(400).json({ error: "No VRMs" });

  const progress = [];
  const ping = (m) => { progress.push(m); console.log(m); };

  const CANDS = {
    cameras: ["/dbg/showCameras.htm", "/dbg/showcameras.htm", "/dbg/ShowCameras.htm", "/showCameras.htm", "/ShowCameras.htm"],
    devices: ["/dbg/showDevices.htm", "/dbg/showdevices.htm", "/dbg/ShowDevices.htm", "/showDevices.htm", "/ShowDevices.htm"],
    targets: ["/dbg/showTargets.htm", "/dbg/showtargets.htm", "/dbg/ShowTargets.htm", "/showTargets.htm", "/ShowTargets.htm"],
    dashboard: ["/", "/index.html", "/Bosch Security Systems - VRM.html", "/Bosch%20Security%20Systems%20-%20VRM.html", "/Bosch Security Systems - VRM.mhtml"]
  };

  try {
    const results = [];
    for (let i = 0; i < vrms.length; i++) {
      const v = vrms[i];
      const vrmId = `${v.site} • ${v.name} (${v.host})`;
      ping(`Conectando ${vrmId} (${i + 1}/${vrms.length})`);

      const camRes = await downloadFirst(v.host, "showCameras", CANDS.cameras, user, pass, progress);
      const devRes = await downloadFirst(v.host, "showDevices", CANDS.devices, user, pass, progress);
      const tgtRes = await downloadFirst(v.host, "showTargets", CANDS.targets, user, pass, progress);
      const dashRes = await fetchAndParseDashboard({
        downloader: ({ host, logicalName, candidates, user, pass, progress }) =>
          downloadFirst(host, logicalName, candidates, user, pass, progress),
        host: v.host,
        candidates: CANDS.dashboard,
        user,
        pass,
        progress,
        parseDashboard: (html) => parseBoschDashboard(html, vrmId),
        onConverted: ({ html, ext }) => {
          saveConvertedHtml({ host: v.host, logicalName: "bosch-vrm", html, ext });
          ping(`✓ ${v.host} bosch-vrm convertido a ${ext}`);
        }
      });

      const errs = [];
      if (!tgtRes.ok) errs.push(`targets: ${tgtRes.error || "no 200"}`);
      if (!devRes.ok) errs.push(`devices: ${devRes.error || "no 200"}`);
      if (!camRes.ok) errs.push(`cameras: ${camRes.error || "no 200"}`);
      if (!dashRes.ok) errs.push(`bosch-vrm: ${dashRes.error || "no 200"}`);
      if (errs.length) ping(`⚠ ${vrmId} -> ${errs.join(" | ")}`);

       let targets = null, devices = [], cameras = [], dashboard = null;
      if (tgtRes.ok) try { targets = parseTargets(tgtRes.html, vrmId); } catch (e) { errs.push("parseTargets:" + e.message); }
      if (devRes.ok) try { devices = parseDevices(devRes.html, vrmId); } catch (e) { errs.push("parseDevices:" + e.message); }
      if (camRes.ok) try { cameras = parseCameras(camRes.html, vrmId); } catch (e) { errs.push("parseCameras:" + e.message); }
      if (dashRes.ok) {
        if (dashRes.parseError) {
          errs.push("parseBoschDashboard:" + dashRes.parseError.message);
        } else {
          dashboard = dashRes.dashboard;
        }
      }

      const camsEnriched = joinCamerasDevices(cameras, devices);
      results.push({ vrm: v, vrmId, errors: errs, targets, devicesCount: devices.length, cameras: camsEnriched, dashboard });
      ping(`OK ${vrmId} — cams:${camsEnriched.length} devs:${devices.length}`);
    }

    const camerasAll = results.flatMap(r => r.cameras || []);
    const dashboards = results.map(r => r.dashboard).filter(Boolean);
    const vrmStats = results.map(r => {
      const t = r.targets?.totals || {};
      const total = Number(t["Total GiB"] || 0);
      const available = Number(t["Available blocks [GiB]"] || 0);
      const empty = Number(t["Empty blocks [GiB]"] || 0);
      const protectedGiB = Number(t["Protected blocks [GiB]"] || 0);
      return {
        vrmId: r.vrmId,
        totalGiB: total,
        availableGiB: available,
        emptyGiB: empty,
        protectedGiB,
        targets: (r.targets?.targets || []).length,
        cameras: (r.cameras || []).length
      };
    });

    const overviewTotals = aggregateDeviceTotals(dashboards);
    const cameraStatus = summarizeCameraStatuses(camerasAll);
    ping("overviewTotals=" + JSON.stringify(overviewTotals)); 

    lastSnapshot = {
      ts: Date.now(),
      progress,
      vrms: results,
      cameras: camerasAll,
      vrmStats,
      dashboards,
      overviewTotals,
      cameraStatus
    };
    res.json(lastSnapshot);
  } catch (e) {
    progress.push("❌ Error general: " + e.message);
    res.status(500).json({ error: e.message, progress });
  }
});

// Offline /upload (adjuntar HTML)
app.post("/api/upload/html", upload.array("files"), async (req, res) => {
  try {
    const label = (req.body?.label || "Importado • VRM (sin-IP)").trim();
    const files = req.files || [];
    const progress = [];
    const ping = (m) => { progress.push(m); console.log(m); };

    let camsHtml = null, devsHtml = null, tgtsHtml = null, dashHtml = null, dashFileName = null;

    for (const f of files) {
      const name = (f.originalname || "").toLowerCase();
      const text = f.buffer.toString("utf8");
      if (name.includes("showcameras")) camsHtml = text;
      else if (name.includes("showdevices")) devsHtml = text;
      else if (name.includes("showtargets")) tgtsHtml = text;
       else if (name.includes("bosch") && name.includes("vrm")) {
        dashHtml = text;
        dashFileName = f.originalname;
      }
    }

    if (!camsHtml && !devsHtml && !tgtsHtml && !dashHtml) {
      return res.status(400).json({ error: "No se detectó showCameras/showDevices/showTargets/Bosch VRM en los archivos adjuntos." });
    }

    const vrmId = label;
    const errs = [];
    let targets = null, devices = [], cameras = [], dashboard = null;

    if (tgtsHtml) try { targets = parseTargets(tgtsHtml, vrmId); ping("✓ targets (upload)"); } catch (e) { errs.push("parseTargets:" + e.message); }
    if (devsHtml) try { devices = parseDevices(devsHtml, vrmId); ping("✓ devices (upload)"); } catch (e) { errs.push("parseDevices:" + e.message); }
    if (camsHtml) try { cameras = parseCameras(camsHtml, vrmId); ping("✓ cameras (upload)"); } catch (e) { errs.push("parseCameras:" + e.message); }
     if (dashHtml) {
      const dashParsed = parseDashboardUpload({
        fileName: dashFileName || "bosch-vrm.mhtml",
        content: dashHtml,
       parseDashboard: (html) => parseBoschDashboard(html, vrmId),
        onConverted: ({ html, ext }) => {
          saveConvertedHtml({ label: vrmId, logicalName: "bosch-vrm", html, ext });
          ping(`✓ Bosch VRM convertido a ${ext} (upload)`);
        }
      });
      if (dashParsed.parseError) {
        errs.push("parseBoschDashboard:" + dashParsed.parseError.message);
      } else {
        dashboard = dashParsed.dashboard;
        ping("✓ Bosch VRM (upload)");
        if (dashParsed.convertedFromMhtml) {
          ping(`✓ Bosch VRM convertido a ${dashParsed.ext} (upload)`);
        }
      }
    }
    const camsEnriched = joinCamerasDevices(cameras, devices);
    const results = [{ vrm: { site: "Import", name: "VRM", host: "" }, vrmId, errors: errs, targets, devicesCount: devices.length, cameras: camsEnriched, dashboard }];

    const camerasAll = camsEnriched;
    const t = targets?.totals || {};
    const total = Number(t["Total GiB"] || 0);
    const available = Number(t["Available blocks [GiB]"] || 0);
    const empty = Number(t["Empty blocks [GiB]"] || 0);
    const protectedGiB = Number(t["Protected blocks [GiB]"] || 0);

    const vrmStats = [{
      vrmId,
      totalGiB: total,
      availableGiB: available,
      emptyGiB: empty,
      protectedGiB,
      targets: (targets?.targets || []).length,
      cameras: camerasAll.length
    }];

    const dashboards = results.map(r => r.dashboard).filter(Boolean);
    const overviewTotals = aggregateDeviceTotals(dashboards);
    const cameraStatus = summarizeCameraStatuses(camerasAll);

    lastSnapshot = {
      ts: Date.now(),
      progress,
      vrms: results,
      cameras: camerasAll,
      vrmStats,
      dashboards,
      overviewTotals,
      cameraStatus
    };
    res.json(lastSnapshot);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- CSV exports ------------------ */
app.get("/api/export/cameras.csv", (_req, res) => {
  const cols = ["vrmId", "name", "address", "recording", "currentBlock", "fw", "connTime", "primaryTarget", "maxBitrate"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=cameras.csv");
  const stringifier = stringify({ header: true, columns: cols });
  (lastSnapshot.cameras || []).forEach(c => {
    stringifier.write(cols.map(k => (c[k] ?? c.raw?.[k] ?? "")));
  });
  stringifier.pipe(res);
});

app.get("/api/export/vrms.csv", (_req, res) => {
  const cols = ["vrmId", "totalGiB", "availableGiB", "emptyGiB", "protectedGiB", "targets", "cameras"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=vrms.csv");
  const stringifier = stringify({ header: true, columns: cols });
  (lastSnapshot.vrmStats || []).forEach(r => stringifier.write(cols.map(k => r[k] ?? "")));
  stringifier.pipe(res);
});

/* ---------------- start ------------------------ */
app.listen(PORT, () => console.log(`BVMS DBG Dashboard en http://localhost:${PORT}`));