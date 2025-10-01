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

/* ---------------- last snapshot ---------------- */
let lastSnapshot = { ts: 0, vrms: [], cameras: [], vrmStats: [], progress: [] };

/* ---------------- FS helpers ------------------- */
const RAW_DIR = path.resolve(process.cwd(), "data", "raw");
fs.mkdirSync(RAW_DIR, { recursive: true });

function saveHtml(host, name, html) {
  try {
    const dir = path.join(RAW_DIR, host);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), html, "utf8");
  } catch {}
}

/* ---------------- HTTP utils ------------------- */
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

/* tries several relative paths; returns first 200 OK (saves html) */
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
          saveHtml(host, `${logicalName}.html`, r.text);
          ping(`✓ ${host} ${logicalName} ← ${rel} (${scheme.toUpperCase()})`);
          return { ok: true, scheme, rel, html: r.text };
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
// showTargets.htm, robusto con fallback de totales
function parseTargets(html, vrmId) {
  const $ = cheerio.load(html);
  const out = { vrmId, targets: [], totals: {}, connections: [] };

  // Tabla principal por target
  $("table").first().find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length >= 13) {
      out.targets.push({
        vrmId,
        target: td.eq(0).text().trim(),
        connTime: td.eq(1).text().trim(),
        // td[2..4] son columnas intermedias
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

  // Totales “bonitos” si están en tablas bajo h1
  $("h1:contains('Targets'), h1:contains('Blocks')").each((_, h) => {
    const t = $(h).next("table");
    t.find("tr").each((_, tr) => {
      const k = $(tr).find("td").eq(0).text().trim();
      const v = $(tr).find("td").eq(1).text().trim();
      if (k) out.totals[k] = isNaN(Number(v)) ? v : Number(v);
    });
  });

  // Fallback de totales sumando por filas
  if (!Object.keys(out.totals).length && out.targets.length) {
    const sum = (k) => out.targets.reduce((a, t) => a + (Number(t[k]) || 0), 0);
    out.totals["Total GiB"]               = sum("totalGiB");
    out.totals["Available blocks [GiB]"]  = sum("availableGiB");
    out.totals["Empty blocks [GiB]"]      = sum("emptyGiB");
    out.totals["Protected blocks [GiB]"]  = sum("protectedGiB");
  }

  // Connections (si existe)
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
    targets: ["/dbg/showTargets.htm", "/dbg/showtargets.htm", "/dbg/ShowTargets.htm", "/showTargets.htm", "/ShowTargets.htm"]
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

      const errs = [];
      if (!tgtRes.ok) errs.push(`targets: ${tgtRes.error || "no 200"}`);
      if (!devRes.ok) errs.push(`devices: ${devRes.error || "no 200"}`);
      if (!camRes.ok) errs.push(`cameras: ${camRes.error || "no 200"}`);
      if (errs.length) ping(`⚠ ${vrmId} -> ${errs.join(" | ")}`);

      let targets = null, devices = [], cameras = [];
      if (tgtRes.ok) try { targets = parseTargets(tgtRes.html, vrmId); } catch (e) { errs.push("parseTargets:" + e.message); }
      if (devRes.ok) try { devices = parseDevices(devRes.html, vrmId); } catch (e) { errs.push("parseDevices:" + e.message); }
      if (camRes.ok) try { cameras = parseCameras(camRes.html, vrmId); } catch (e) { errs.push("parseCameras:" + e.message); }

      const camsEnriched = joinCamerasDevices(cameras, devices);
      results.push({ vrm: v, vrmId, errors: errs, targets, devicesCount: devices.length, cameras: camsEnriched });
      ping(`OK ${vrmId} — cams:${camsEnriched.length} devs:${devices.length}`);
    }

    const camerasAll = results.flatMap(r => r.cameras || []);
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

    lastSnapshot = { ts: Date.now(), progress, vrms: results, cameras: camerasAll, vrmStats };
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

    let camsHtml = null, devsHtml = null, tgtsHtml = null;

    for (const f of files) {
      const name = (f.originalname || "").toLowerCase();
      const text = f.buffer.toString("utf8");
      if (name.includes("showcameras")) camsHtml = text;
      else if (name.includes("showdevices")) devsHtml = text;
      else if (name.includes("showtargets")) tgtsHtml = text;
    }

    if (!camsHtml && !devsHtml && !tgtsHtml) {
      return res.status(400).json({ error: "No se detectó showCameras/showDevices/showTargets en los archivos adjuntos." });
    }

    const vrmId = label;
    const errs = [];
    let targets = null, devices = [], cameras = [];

    if (tgtsHtml) try { targets = parseTargets(tgtsHtml, vrmId); ping("✓ targets (upload)"); } catch (e) { errs.push("parseTargets:" + e.message); }
    if (devsHtml) try { devices = parseDevices(devsHtml, vrmId); ping("✓ devices (upload)"); } catch (e) { errs.push("parseDevices:" + e.message); }
    if (camsHtml) try { cameras = parseCameras(camsHtml, vrmId); ping("✓ cameras (upload)"); } catch (e) { errs.push("parseCameras:" + e.message); }

    const camsEnriched = joinCamerasDevices(cameras, devices);
    const results = [{ vrm: { site: "Import", name: "VRM", host: "" }, vrmId, errors: errs, targets, devicesCount: devices.length, cameras: camsEnriched }];

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

    lastSnapshot = { ts: Date.now(), progress, vrms: results, cameras: camerasAll, vrmStats };
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