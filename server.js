import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { Agent as HttpsAgent } from "https";
import * as cheerio from "cheerio";
import { stringify } from "csv-stringify";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const DEFAULT_VRMS = (() => {
  try { return JSON.parse(process.env.VRMS || "[]"); }
  catch { return []; }
})();

const DBG_USER = process.env.DBG_USER || "srvadmin";
const DBG_PASS = process.env.DBG_PASS || "DFDgsfe01!";

const httpsAgent = new HttpsAgent({ rejectUnauthorized: false });

let lastSnapshot = { ts: 0, vrms: [], cameras: [], vrmStats: [] };

/* ---------- helpers ---------- */
const btoa = (s) => Buffer.from(s, "utf8").toString("base64");
const authHeader = (u,p) => ({ Authorization: `Basic ${btoa(`${u}:${p}`)}` });

async function getHtml(url, user=DBG_USER, pass=DBG_PASS) {
  const res = await fetch(url, {
    agent: url.startsWith("https") ? httpsAgent : undefined,
    headers: { ...authHeader(user, pass) }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

/* ---------- parsers (basados en la estructura de /dbg) ---------- */
/* showTargets.htm -> VRM capacity + targets */
function parseTargets(html, vrmId) {
  const $ = cheerio.load(html);
  const out = { vrmId, targets: [], totals: {}, connections: [] };

  // Tabla principal (por-target)
  $("table").first().find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length >= 13) {
      out.targets.push({
        vrmId,
        target: td.eq(0).text().trim(),
        connTime: td.eq(1).text().trim(),
        bitrate: Number(td.eq(5).text().trim()||0),
        totalGiB: Number(td.eq(6).text().trim()||0),
        availableGiB: Number(td.eq(7).text().trim()||0),
        emptyGiB: Number(td.eq(8).text().trim()||0),
        protectedGiB: Number(td.eq(9).text().trim()||0),
        slices: Number(td.eq(10).text().trim()||0),
        outOfRes: Number(td.eq(11).text().trim()||0),
        lastOutOfRes: td.eq(12).text().trim()
      });
    }
  });

  // Totales (tres tablas h1: Targets, LUNs, Blocks). Tomamos la de Targets+Blocks
  $("h1:contains('Targets')").next("table").find("tr").each((_, tr) => {
    const key = $(tr).find("td").eq(0).text().trim();
    const val = $(tr).find("td").eq(1).text().trim();
    if (key) out.totals[key] = isNaN(Number(val)) ? val : Number(val);
  });
  $("h1:contains('Blocks')").next("table").find("tr").each((_, tr) => {
    const key = $(tr).find("td").eq(0).text().trim();
    const val = $(tr).find("td").eq(1).text().trim();
    if (key) out.totals[key] = isNaN(Number(val)) ? val : Number(val);
  });

  // Conexiones por target (si está)
  $("h1:contains('Connections')").next("table").find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    out.connections.push({
      vrmId, target: td.eq(0).text().trim(), connections: Number(td.eq(1).text().trim()||0)
    });
  });

  return out;
}

/* showDevices.htm -> info de “Device” (IP\canal), FW, conexión, bloques, etc */
function parseDevices(html, vrmId) {
  const $ = cheerio.load(html);
  const rows = [];
  $("table").first().find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length >= 18) {
      rows.push({
        vrmId,
        device: td.eq(0).text().trim(),       // ej: 172.25.0.24\5
        guid: td.eq(1).text().trim(),
        mac: td.eq(2).text().trim(),
        fw: td.eq(3).text().trim(),
        url: td.eq(6).text().trim(),
        connTime: td.eq(7).text().trim(),
        allocatedBlocks: Number(td.eq(8).text().trim()||0),
        limitedSpansSince: td.eq(9).text().trim(),
        lbMode: td.eq(10).text().trim(),
        primaryTarget: td.eq(11).text().trim(),
        maxBitrate: Number(td.eq(17).text().trim()||0)
      });
    }
  });
  return rows;
}

/* showCameras.htm -> nombre, address, recording, mounted, etc */
function parseCameras(html, vrmId) {
  const $ = cheerio.load(html);
  const rows = [];
  const $tbl = $("table").first();
  const headers = $tbl.find("tr").first().find("th").map((i,th)=>$(th).text().trim()).get();

  $tbl.find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (!td.length) return;
    const row = {};
    headers.forEach((h, i) => row[h] = td.eq(i).text().trim());

    // Normalizaciones típicas
    const name = row["Camera name"] || row["Name"] || "";
    const addr = row["Camera address"] || row["Address"] || "";
    const recording = (row["Recording"] || row["Recording status"] || "").toLowerCase(); // on/off/no
    const blockMounted = (row["Block mounted"] || row["Block"] || "").toLowerCase();

    rows.push({
      vrmId,
      name, address: addr,
      recording, blockMounted,
      raw: row
    });
  });
  return rows;
}

/* Fusiona cameras + devices por address/device (ip\X) para sumar FW, conexión, etc */
function joinCamerasDevices(camRows, devRows) {
  const devByDevice = new Map();
  devRows.forEach(d => devByDevice.set(d.device, d));

  return camRows.map(c => {
    const key = (c.address || "").replace(/\/+$/, ""); // 172.25.0.24\5
    const dev = devByDevice.get(key);
    return {
      ...c,
      device: dev?.device || key,
      fw: dev?.fw || "",
      connTime: dev?.connTime || "",
      allocatedBlocks: dev?.allocatedBlocks ?? null,
      primaryTarget: dev?.primaryTarget || "",
      maxBitrate: dev?.maxBitrate ?? null
    };
  });
}

/* ---------- API ---------- */

// Estado del backend
app.get("/api/status", (_req, res) => {
  res.json({ ok:true, lastSnapshot: lastSnapshot.ts });
});

// Escanea lista de VRMs y devuelve snapshot
app.post("/api/scan", async (req, res) => {
  const { vrms = DEFAULT_VRMS, user = DBG_USER, pass = DBG_PASS } = req.body || {};
  if (!Array.isArray(vrms) || !vrms.length) return res.status(400).json({ error:"No VRMs" });

  const progress = [];
  const pop = (m) => { progress.push(m); };

  try {
    const results = [];
    for (let i=0;i<vrms.length;i++){
      const v = vrms[i];
      const vrmId = `${v.site} • ${v.name} (${v.host})`;
      pop(`Conectando ${vrmId} (${i+1}/${vrms.length})`);

      // Descargas
      const base = `http://${v.host}/dbg`;
      const [targetsHtml, devicesHtml, camerasHtml] = await Promise.all([
        getHtml(`${base}/showTargets.htm`, user, pass).catch(e => ({__err:e})),
        getHtml(`${base}/showDevices.htm`, user, pass).catch(e => ({__err:e})),
        getHtml(`${base}/showCameras.htm`, user, pass).catch(e => ({__err:e}))
      ]);

      if (targetsHtml?.__err && devicesHtml?.__err && camerasHtml?.__err) {
        results.push({ vrmId, error: `Fallo total en ${v.host}` });
        continue;
      }

      const targets = !targetsHtml?.__err ? parseTargets(targetsHtml, vrmId) : null;   // :contentReference[oaicite:2]{index=2}
      const devices = !devicesHtml?.__err ? parseDevices(devicesHtml, vrmId) : [];     // :contentReference[oaicite:3]{index=3}
      const cams    = !camerasHtml?.__err ? parseCameras(camerasHtml, vrmId) : [];

      const camsEnriched = joinCamerasDevices(cams, devices);

      results.push({
        vrm: v, vrmId,
        targets, devicesCount: devices.length,
        cameras: camsEnriched
      });
      pop(`OK ${vrmId} — cams: ${camsEnriched.length}, devs: ${devices.length}`);
    }

    // Agregados globales
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
        cameras: (r.cameras || []).length
      };
    });

    lastSnapshot = {
      ts: Date.now(),
      progress,
      vrms: results,
      cameras: camerasAll,
      vrmStats
    };

    res.json(lastSnapshot);
  } catch (e) {
    res.status(500).json({ error: e.message, progress });
  }
});

// Export CSV: cámaras
app.get("/api/export/cameras.csv", (_req, res) => {
  const cols = [
    "vrmId","name","address","recording","blockMounted",
    "fw","connTime","allocatedBlocks","primaryTarget","maxBitrate"
  ];
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition","attachment; filename=cameras.csv");
  const stringifier = stringify({ header:true, columns: cols });
  (lastSnapshot.cameras || []).forEach(c => stringifier.write(cols.map(k => c[k] ?? "")));
  stringifier.pipe(res);
});

// Export CSV: VRMs
app.get("/api/export/vrms.csv", (_req, res) => {
  const cols = ["vrmId","totalGiB","availableGiB","emptyGiB","protectedGiB","targets","cameras"];
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition","attachment; filename=vrms.csv");
  const stringifier = stringify({ header:true, columns: cols });
  (lastSnapshot.vrmStats || []).forEach(r => stringifier.write(cols.map(k => r[k] ?? "")));
  stringifier.pipe(res);
});

app.listen(PORT, () => {
  console.log(`BVMS DBG Dashboard listo en http://localhost:${PORT}`);
});