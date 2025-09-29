const $ = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));
const fmt = (n) => Intl.NumberFormat('es-AR').format(n);

const defaultVrms = [
  { site:"BVMS1", name:"VRM1", host:"172.25.0.15" },
  { site:"BVMS1", name:"VRM2", host:"172.25.0.18" },
  { site:"BVMS2", name:"VRM1", host:"172.25.20.3" },
  { site:"BVMS2", name:"VRM2", host:"172.25.20.4" },
  { site:"BVMS2", name:"VRM3", host:"172.25.20.5" }
];

function setVrmsText(vrms) {
  $("#vrmsInput").value = vrms.map(v => `${v.site} · ${v.name} · ${v.host}`).join("\n");
}
function parseVrmsText() {
  const lines = $("#vrmsInput").value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  return lines.map(l => {
    const parts = l.split("·").map(s=>s.trim());
    if (parts.length === 3) return { site:parts[0], name:parts[1], host:parts[2] };
    const bits = l.split(/\s+/);
    return { site: bits[0]||"SITE", name: bits[1]||"VRM", host: bits.pop() };
  });
}

async function scanOnce() {
  const vrms = parseVrmsText();
  const user = $("#user").value;
  const pass = $("#pass").value;

  $("#progress").innerHTML = "Preparando…";
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ vrms, user, pass })
  });
  const data = await res.json();

  $("#progress").innerHTML = (data.progress||[]).map(p=>`• ${p}`).join("<br>");

  if (!data || !data.cameras) {
    $("#summary").innerHTML = `<div class="pill error">Sin datos</div>`;
    return;
  }

  renderOverview(data);
  renderVrms(data);
  renderCameras(data);
}

function pill(txt, cls="") { return `<span class="pill ${cls}">${txt}</span>`; }

function renderOverview(snap) {
  const cams = snap.cameras;
  const total = cams.length;
  const recOn = cams.filter(c => c.recording.includes("on")).length;
  const noRec = cams.filter(c => c.recording.includes("off") || c.recording.includes("no")).length;
  const noBlocks = cams.filter(c => c.blockMounted.includes("no")).length;

  $("#summary").innerHTML = `
    <div class="kpi">${pill("Cámaras", "neutral")}<b>${fmt(total)}</b></div>
    <div class="kpi">${pill("Grabando", "ok")}<b>${fmt(recOn)}</b></div>
    <div class="kpi">${pill("Sin grabar", "warn")}<b>${fmt(noRec)}</b></div>
    <div class="kpi">${pill("Sin bloques", "error")}<b>${fmt(noBlocks)}</b></div>
  `;

  // Lista de issues rápidos
  const issues = cams.filter(c =>
    c.recording.includes("off") || c.recording.includes("no") || c.blockMounted.includes("no")
  );
  $("#issues").innerHTML = renderTable(
    ["VRM","Nombre","IP/Canal","Recording","Bloques","FW","Conexión"],
    issues.map(c => [
      c.vrmId, c.name||"", c.address,
      c.recording||"", c.blockMounted||"",
      c.fw||"", c.connTime||""
    ])
  );
}

function renderVrms(snap) {
  const rows = (snap.vrmStats||[]).map(v => [
    v.vrmId, fmt(v.totalGiB), fmt(v.availableGiB), fmt(v.emptyGiB),
    fmt(v.protectedGiB), v.targets, v.cameras
  ]);
  $("#vrmTable").innerHTML = renderTable(
    ["VRM","Total GiB","Disponibles","Vacíos","Protegidos","Targets","Cámaras"], rows
  );
}

function renderCameras(snap) {
  const cams = snap.cameras;
  const termInput = $("#camSearch");
  const draw = () => {
    const term = termInput.value.toLowerCase();
    const filtered = cams.filter(c =>
      (c.name||"").toLowerCase().includes(term) ||
      (c.address||"").toLowerCase().includes(term) ||
      (c.vrmId||"").toLowerCase().includes(term)
    );
    $("#camTable").innerHTML = renderTable(
      ["VRM","Nombre","IP/Canal","Recording","Bloques","FW","Conexión","Target","Bitrate máx"],
      filtered.map(c => [
        c.vrmId, c.name||"", c.address||"",
        c.recording||"", c.blockMounted||"",
        c.fw||"", c.connTime||"", c.primaryTarget||"", c.maxBitrate??""
      ])
    );
  };
  termInput.oninput = draw;
  draw();
}

function renderTable(headers, rows) {
  const thead = `<thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c??""}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

/* tabs */
$$("nav button").forEach(btn => {
  btn.onclick = () => {
    $$("nav button").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const id = btn.dataset.tab;
    $$(".tab").forEach(t => t.classList.remove("active"));
    $(`#tab-${id}`).classList.add("active");
  };
});

/* exports */
$("#exportVrms").onclick = () => window.open("/api/export/vrms.csv","_blank");
$("#exportCams").onclick = () => window.open("/api/export/cameras.csv","_blank");

/* go */
setVrmsText(defaultVrms);
$("#scanBtn").onclick = scanOnce;