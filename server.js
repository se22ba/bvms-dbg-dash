import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { Agent as HttpsAgent } from "https";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// Si tenés VRMs por defecto en .env:
// VRMS=[{"site":"BVMS1","name":"VRM1","host":"172.20.67.94"}]
const DEFAULT_VRMS = (() => {
  try { return JSON.parse(process.env.VRMS || "[]"); } catch { return []; }
})();

const DBG_USER = process.env.DBG_USER || "srvadmin";
const DBG_PASS = process.env.DBG_PASS || "DFDgsfe01!";

const httpsAgent = new HttpsAgent({ rejectUnauthorized: false });

let lastSnapshot = { ts: 0, vrms: [], cameras: [], vrmStats: [], progress: [] };

/* ---------- FS helpers ---------- */
const RAW_DIR = path.resolve(process.cwd(), "data", "raw");
fs.mkdirSync(RAW_DIR, { recursive: true });
function saveHtml(host, name, html) {
  const dir = path.join(RAW_DIR, host);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), html, "utf8");
}

/* ---------- HTTP utils ---------- */
function authHeader(u, p) {
  return { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") };
}

async function fetchWithTimeout(url, { https = true, headers = {}, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers,
      agent: https ? httpsAgent : undefined,
      signal: controller.signal,
    });
    const text = await r.text();
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
      text,
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Intenta descargar la primera ruta que exista.
 * - Prueba HTTPS y si no, HTTP.
 * - Usa un set de candidatos (case variants).
 * - Guarda el HTML en data/raw/<host>/<logicalName>.html si ok.
 */
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
            Referer: `${scheme}://${host}/dbg`,
          },
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

/* ---------- PARSERS ---------- */

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
        lastOutOfRes: td.eq(12).text().trim(),
      });
    }
  });

  $("h1:contains('Targets')").next("table").find("tr").each((_, tr) => {
    const k = $(tr).find("td").eq(0).text().trim();
    const v = $(tr).find("td").eq(1).text().trim();
    if (k) out.totals[k] = isNaN(Number(v)) ? v : Number(v);
  });
  $("h1:contains('Blocks')").next("table").find("tr").each((_, tr) => {
    const k = $(tr).find("td").eq(0).text().trim();
    const v = $(tr).find("td").eq(1).text().trim();
    if (k) out.totals[k] = isNaN(Number(v)) ? v : Number(v);
  });
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
        device: td.eq(0).text().trim(),             // 172.20.65.85\0
        guid: td.eq(1).text().trim(),
        mac: td.eq(2).text().trim(),
        fw: td.eq(3).text().trim(),                 // 09.41.0019
        url: td.eq(6).text().trim(),
        connTime: td.eq(7).text().trim(),
        allocatedBlocks: Number(td.eq(8).text().trim() || 0),
        limitedSpansSince: td.eq(9).text().trim(),
        lbMode: td.eq(10).text().trim(),
        primaryTarget: td.eq(11).text().trim(),
        maxBitrate: Number(td.eq(17).text().trim() || 0), // “Max bitrate”
      });
    }
  });
  return rows;
}

// showCameras.htm  (robusto a nombres / idioma)
function parseCameras(html, vrmId) {
  const $ = cheerio.load(html);

  const norm = s => String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const rows = [];
  const $tbl = $("table").first();
  const headers = $tbl.find("tr").first().find("th").map((i, th) =>
    norm($(th).text())
  ).get();

  const idxBy = (label) => headers.findIndex(h => h === norm(label));

  const iName          = idxBy("camera name");
  const iAddr          = idxBy("address");
  const iRec           = idxBy("recording");
  const iCurBlock      = idxBy("current block");
  const iPrimaryTarget = idxBy("primary target");
  const iMaxBitrate    = idxBy("max bitrate");

  $tbl.find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (!td.length) return;

    const get = (i) => (i >= 0 ? td.eq(i).text().trim() : "");

    const name           = get(iName);
    const address        = get(iAddr);
    const recording      = get(iRec);
    const currentBlock   = get(iCurBlock);
    const primaryTarget  = get(iPrimaryTarget);
    const maxBitrateCam  = Number(get(iMaxBitrate).replace(",", ".")) || null;

    const raw = {};
    headers.forEach((h, i) => raw[h] = td.eq(i).text().trim());

    rows.push({
      vrmId,
      name,
      address,
      recording,
      currentBlock,
      primaryTarget,
      maxBitrateCam,
      raw,
    });
  });
  return rows;
}

function joinCamerasDevices(camRows, devRows) {
  const devByDevice = new Map();
  devRows.forEach(d => devByDevice.set((d.device || "").replace(/\/+$/, ""), d));

  return camRows.map(c => {
    const key = (c.address || "").replace(/\/+$/, "");
    const dev = devByDevice.get(key);

    const maxBitrate = c.maxBitrateCam != null
      ? c.maxBitrateCam
      : (dev?.maxBitrate ?? null);

    return {
      ...c,
      device: key,
      fw: dev?.fw || "",
      connTime: dev?.connTime || "",
      allocatedBlocks: dev?.allocatedBlocks ?? null,
      primaryTarget: c.primaryTarget || dev?.primaryTarget || "",
      maxBitrate,
    };
  });
}

/* ---------- API ---------- */

app.get("/api/status", (_req, res) => res.json({ ok: true, lastSnapshot: lastSnapshot.ts }));

app.post("/api/scan", async (req, res) => {
  const { vrms = DEFAULT_VRMS, user = DBG_USER, pass = DBG_PASS } = req.body || {};
  if (!Array.isArray(vrms) || !vrms.length) return res.status(400).json({ error: "No VRMs" });

  const progress = [];
  const ping = (m) => { progress.push(m); console.log(m); };

  const CANDS = {
    cameras: [
      "/dbg/showCameras.htm", "/dbg/showcameras.htm", "/dbg/ShowCameras.htm",
      "/showCameras.htm", "/ShowCameras.htm"
    ],
    devices: [
      "/dbg/showDevices.htm", "/dbg/showdevices.htm", "/dbg/ShowDevices.htm",
      "/showDevices.htm", "/ShowDevices.htm"
    ],
    targets: [
      "/dbg/showTargets.htm", "/dbg/showtargets.htm", "/dbg/ShowTargets.htm",
      "/showTargets.htm", "/ShowTargets.htm"
    ],
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
      return {
        vrmId: r.vrmId,
        totalGiB: Number(t["Total GiB"] || t["Total number of blocks"] || 0),
        availableGiB: Number(t["Available blocks [GiB]"] || 0),
        emptyGiB: Number(t["Empty blocks [GiB]"] || 0),
        protectedGiB: Number(t["Protected blocks [GiB]"] || 0),
        targets: (r.targets?.targets || []).length,
        cameras: (r.cameras || []).length,
      };
    });

    lastSnapshot = { ts: Date.now(), progress, vrms: results, cameras: camerasAll, vrmStats };
    res.json(lastSnapshot);
  } catch (e) {
    progress.push("❌ Error general: " + e.message);
    res.status(500).json({ error: e.message, progress });
  }
});

/* ---------- CSV ---------- */
app.get("/api/export/cameras.csv", (_req, res) => {
  const cols = ["vrmId", "name", "address", "recording", "currentBlock", "fw", "connTime", "primaryTarget", "maxBitrate"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=cameras.csv");
  const stringifier = stringify({ header: true, columns: cols });
  (lastSnapshot.cameras || []).forEach(c => stringifier.write(cols.map(k => c[k] ?? "")));
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

app.listen(PORT, () => console.log(`BVMS DBG Dashboard en http://localhost:${PORT}`));