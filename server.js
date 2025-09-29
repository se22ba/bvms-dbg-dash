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
const DEFAULT_VRMS = (() => {
  try { return JSON.parse(process.env.VRMS || "[]"); } catch { return []; }
})();

const DBG_USER = process.env.DBG_USER || "srvadmin";
const DBG_PASS = process.env.DBG_PASS || "DFDgsfe01!";

const httpsAgent = new HttpsAgent({ rejectUnauthorized: false });

let lastSnapshot = { ts: 0, vrms: [], cameras: [], vrmStats: [], progress: [] };

/* --------------------------- FS helpers --------------------------- */
const RAW_DIR = path.resolve(process.cwd(), "data", "raw");
fs.mkdirSync(RAW_DIR, { recursive: true });
function saveHtml(host, name, html) {
  const dir = path.join(RAW_DIR, host);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), html, "utf8");
}

/* ------------------------- HTTP utilities ------------------------- */
function authHeader(u,p){ return { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") }; }

async function fetchWithTimeout(url, { timeoutMs = 15000, https = true, headers = {} } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      agent: https ? httpsAgent : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Intenta descargar la primera ruta candidata que exista.
 * - Prueba HTTPS y luego HTTP
 * - Guarda HTML en data/raw/<host>/<logicalName>.html
 */
async function downloadFirst(host, logicalName, candidates, user, pass, progress) {
  const ping = (m)=>{ progress.push(m); console.log(m); };

  for (const scheme of ["https", "http"]) {
    for (const rel of candidates) {
      const url = `${scheme}://${host}${rel}`;
      try {
        const r = await fetchWithTimeout(url, {
          https: scheme === "https",
          headers: {
            ...authHeader(user, pass),
            Accept: "text/html,*/*;q=0.9",
            Referer: `${scheme}://${host}/dbg`
          }
        });
        const ctype = r.headers?.get?.("content-type") || "";
        if (r.ok && /text\/html/i.test(ctype)) {
          saveHtml(host, `${logicalName}.html`, r.text);
          ping(`✓ ${host} ${logicalName} ← ${rel} (${scheme.toUpperCase()})`);
          return { ok:true, scheme, rel, html:r.text };
        } else {
          ping(`· ${host} ${logicalName} ${r.status} ${r.statusText} ← ${rel} (${scheme})`);
        }
      } catch (e) {
        ping(`· ${host} ${logicalName} error ${String(e.message)} ← ${rel} (${scheme})`);
      }
    }
  }
  return { ok:false, error:`no encontrado (${logicalName})` };
}

/* ---------------------------- Parsers ----------------------------- */
function normHeader(s='') {
  return s.toLowerCase()
    .replace(/\s+/g,' ')
    .replace(/[._\-:/()[\]]/g,'')
    .trim();
}
function tdText($, td) {
  const $td = $(td);
  const imgAlt = $td.find('img[alt]').attr('alt') || $td.find('img[title]').attr('title');
  const title = $td.attr('title');
  const text = $td.text().trim();
  return (imgAlt || title || text || '').trim();
}
function asBool(v='') {
  const s = String(v).toLowerCase();
  return /(on|yes|ok|activo|grabando|mounted|mounted yes|check)/.test(s);
}
function pickNumber(s='') {
  const m = String(s).replace(/,/g,'.').match(/[-+]?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function ipOf(addr='') {
  const m = String(addr).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  return m ? m[0] : '';
}

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
        bitrate: pickNumber(td.eq(5).text()),
        totalGiB: pickNumber(td.eq(6).text()),
        availableGiB: pickNumber(td.eq(7).text()),
        emptyGiB: pickNumber(td.eq(8).text()),
        protectedGiB: pickNumber(td.eq(9).text()),
        slices: pickNumber(td.eq(10).text()),
        outOfRes: pickNumber(td.eq(11).text()),
        lastOutOfRes: td.eq(12).text().trim()
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
    out.connections.push({ vrmId, target: td.eq(0).text().trim(), connections: pickNumber(td.eq(1).text()) || 0 });
  });
  return out;
}

function parseDevices(html, vrmId) {
  const $ = cheerio.load(html);
  const $tbl = $("table").first();
  if (!$tbl.length) return [];

  const headers = $tbl.find("tr").first().find("th,td").map((i,th)=>normHeader($(th).text())).get();
  const idx = (alts) => {
    const list = Array.isArray(alts) ? alts : [alts];
    for (const a of list) {
      const i = headers.findIndex(h => h.includes(a));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iDev   = idx(['device','cameraaddress','address','ip']);
  const iGuid  = idx(['guid']);
  const iMac   = idx(['mac']);
  const iFw    = idx(['firmware','fw','firmwareversion','version']);
  const iUrl   = idx(['url','address','ip']);
  const iConn  = idx(['connectiontime','connection','coneccion','uptime']);
  const iBlocks= idx(['allocatedblocks','blocks','bloques']);
  const iLb    = idx(['lbmode']);
  const iTarget= idx(['primarytarget','target']);
  const iMaxBr = idx(['maxbitrate','bitratemax']);

  const rows = [];
  $tbl.find("tr").slice(1).each((_, tr) => {
    const td = $(tr).find("td");
    if (!td.length) return;

    rows.push({
      vrmId,
      device: iDev >= 0 ? tdText($, td[iDev]) : '',
      guid: iGuid >= 0 ? tdText($, td[iGuid]) : '',
      mac: iMac >= 0 ? tdText($, td[iMac]) : '',
      fw: iFw >= 0 ? tdText($, td[iFw]) : '',
      url: iUrl >= 0 ? tdText($, td[iUrl]) : '',
      connTime: iConn >= 0 ? tdText($, td[iConn]) : '',
      allocatedBlocks: iBlocks >= 0 ? pickNumber(tdText($, td[iBlocks])) : null,
      lbMode: iLb >= 0 ? tdText($, td[iLb]) : '',
      primaryTarget: iTarget >= 0 ? tdText($, td[iTarget]) : '',
      maxBitrate: iMaxBr >= 0 ? pickNumber(tdText($, td[iMaxBr])) : null
    });
  });

  return rows;
}

function parseCameras(html, vrmId) {
  const $ = cheerio.load(html);
  const $tbl = $("table").first();
  if (!$tbl.length) return [];

  const headers = $tbl.find("tr").first().find("th,td").map((i,th)=>normHeader($(th).text())).get();
  const idx = (nameAlts) => {
    const alts = Array.isArray(nameAlts) ? nameAlts : [nameAlts];
    for (const a of alts) {
      const i = headers.findIndex(h => h.includes(a));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iName   = idx(['cameraname','name','nombre']);
  const iAddr   = idx(['cameraaddress','address','ip']);
  const iRec    = idx(['recording','recordingstatus','estado']);
  const iBlock  = idx(['blockmounted','block','bloques','mounted']);

  const rows = [];
  $tbl.find("tr").slice(1).each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;

    const name = iName >= 0 ? tdText($, tds[iName]) : '';
    const address = iAddr >= 0 ? tdText($, tds[iAddr]) : '';
    const recRaw = iRec >= 0 ? tdText($, tds[iRec]) : '';
    const blkRaw = iBlock >= 0 ? tdText($, tds[iBlock]) : '';

    rows.push({
      vrmId,
      name,
      address,
      recording: asBool(recRaw) ? 'on' : (String(recRaw)||'').toLowerCase(),
      blockMounted: asBool(blkRaw) ? 'mounted' : (String(blkRaw)||'').toLowerCase(),
      raw: { recRaw, blkRaw }
    });
  });

  return rows;
}

function joinCamerasDevices(camRows, devRows) {
  const byIp = new Map();
  const byDev = new Map();

  devRows.forEach(d => {
    const ip = ipOf(d.device) || ipOf(d.url);
    if (ip) byIp.set(ip, d);
    if (d.device) byDev.set(d.device.replace(/\/+$/,''), d);
  });

  return camRows.map(c => {
    const ip = ipOf(c.address);
    let dev = null;
    if (ip && byIp.has(ip)) dev = byIp.get(ip);
    if (!dev) {
      const key = (c.address || '').replace(/\/+$/,'');
      dev = byDev.get(key) || null;
    }
    return {
      ...c,
      device: dev?.device || c.address,
      fw: dev?.fw || '',
      connTime: dev?.connTime || '',
      allocatedBlocks: dev?.allocatedBlocks ?? null,
      primaryTarget: dev?.primaryTarget || '',
      maxBitrate: dev?.maxBitrate ?? null
    };
  });
}

/* ----------------------------- API ------------------------------- */
app.get("/api/status", (_req, res) => res.json({ ok:true, lastSnapshot: lastSnapshot.ts }));

app.post("/api/scan", async (req, res) => {
  const { vrms = DEFAULT_VRMS, user = DBG_USER, pass = DBG_PASS } = req.body || {};
  if (!Array.isArray(vrms) || !vrms.length) return res.status(400).json({ error:"No VRMs" });

  const progress = [];
  const ping = (m)=>{ progress.push(m); console.log(m); };

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
    ]
  };

  try {
    const results = [];
    for (let i=0;i<vrms.length;i++){
      const v = vrms[i];
      const vrmId = `${v.site} • ${v.name} (${v.host})`;
      ping(`Conectando ${vrmId} (${i+1}/${vrms.length})`);

      const camRes = await downloadFirst(v.host, "showCameras", CANDS.cameras, user, pass, progress);
      const devRes = await downloadFirst(v.host, "showDevices", CANDS.devices, user, pass, progress);
      const tgtRes = await downloadFirst(v.host, "showTargets", CANDS.targets, user, pass, progress);

      const errs = [];
      if (!tgtRes.ok) errs.push(`targets: ${tgtRes.error || "no 200"}`);
      if (!devRes.ok) errs.push(`devices: ${devRes.error || "no 200"}`);
      if (!camRes.ok) errs.push(`cameras: ${camRes.error || "no 200"}`);
      if (errs.length) ping(`⚠ ${vrmId} -> ${errs.join(" | ")}`);

      let targets=null, devices=[], cameras=[];
      if (tgtRes.ok) try { targets = parseTargets(tgtRes.html, vrmId); } catch(e){ errs.push("parseTargets:"+e.message); }
      if (devRes.ok) try { devices = parseDevices(devRes.html, vrmId); } catch(e){ errs.push("parseDevices:"+e.message); }
      if (camRes.ok) try { cameras = parseCameras(camRes.html, vrmId); } catch(e){ errs.push("parseCameras:"+e.message); }

      const camsEnriched = joinCamerasDevices(cameras, devices);
      results.push({ vrm:v, vrmId, errors:errs, targets, devicesCount: devices.length, cameras: camsEnriched });
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

/* --------------------------- CSV exports ------------------------- */
app.get("/api/export/cameras.csv", (_req, res) => {
  const cols = ["vrmId","name","address","recording","blockMounted","fw","connTime","allocatedBlocks","primaryTarget","maxBitrate"];
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition","attachment; filename=cameras.csv");
  const stringifier = stringify({ header:true, columns: cols });
  (lastSnapshot.cameras || []).forEach(c => stringifier.write(cols.map(k => c[k] ?? "")));
  stringifier.pipe(res);
});

app.get("/api/export/vrms.csv", (_req, res) => {
  const cols = ["vrmId","totalGiB","availableGiB","emptyGiB","protectedGiB","targets","cameras"];
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition","attachment; filename=vrms.csv");
  const stringifier = stringify({ header:true, columns: cols });
  (lastSnapshot.vrmStats || []).forEach(r => stringifier.write(cols.map(k => r[k] ?? "")));
  stringifier.pipe(res);
});

/* --------------------------- Boot server ------------------------- */
app.listen(PORT, () => console.log(`BVMS DBG Dashboard en http://localhost:${PORT}`));