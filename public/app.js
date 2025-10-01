(() => {
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

  /* -------- UI refs -------- */
  const vrmTextarea = $("#vrm-list");
  const userInput   = $("#dbg-user");
  const passInput   = $("#dbg-pass");
  const btnScan     = $("#btn-scan");
  const progressBox = $("#progress");
  const tsBox       = $("#ts");
  const tabButtons  = $$(".tab-btn");
  const tabPages    = $$(".tab-page");

  // Overview
  const cardTotalCams   = $("#card-total-cams");
  const cardRecCams     = $("#card-rec-cams");
  const cardNoRecCams   = $("#card-norec-cams");
  const cardNoBlocks    = $("#card-noblocks-cams");
  const tblOverviewBody = $("#tbl-overview tbody");

  // VRMs
  const tblVrmsBody     = $("#tbl-vrms tbody");

  // Cámaras
  const tblCamsBody     = $("#tbl-cams tbody");
  const filterName      = $("#filter-name");
  const filterIp        = $("#filter-ip");
  const btnExportCams   = $("#btn-exp-cams");
  const btnExportVrms   = $("#btn-exp-vrms");

  // Charts
  const recordingCanvas = $("#chart-recording");
  const storageHost     = $("#vrm-storage-charts");
  let charts = {
    recording: null,
    storageByVrm: new Map(),
  };
const storageResizeObservers = new Map();
  // Upload offline
  const inputFiles  = $("#import-files");
  const inputLabel  = $("#import-label");
  const btnAttach   = $("#btn-import");

  let snapshot = { cameras: [], vrmStats: [], vrms: [], progress: [], ts: 0 };

  /* --------- Tabs ---------- */
  tabButtons.forEach(b => {
    b.addEventListener("click", () => {
      tabButtons.forEach(x => x.classList.remove("active"));
      tabPages.forEach(p => p.classList.add("hidden"));
      b.classList.add("active");
      $(b.getAttribute("data-target")).classList.remove("hidden");
      setTimeout(() => {
        if (charts.recording) charts.recording.resize();
        charts.storageByVrm.forEach(ch => ch.resize());
      }, 50);
    });
  });

  /* -------- helpers -------- */
  function parseVrmTextarea(txt) {
    return txt.split(/\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const parts = l.split(/\s*[•\-]\s*|\s{2,}/).filter(Boolean);
        const ip = parts.pop();
        const name = parts.pop() || "VRM";
        const site = parts.join(" ") || "BVMS";
        return { site, name, host: ip };
      });
  }
  function nice(s){ return (s==null ? "" : String(s)); }
   function getRawValue(cam, ...keys) {
    const raw = cam?.raw;
    if (!raw) return "";
    for (const key of keys) {
      if (!key) continue;
      const candidates = [key, key.toLowerCase()];
      for (const cand of candidates) {
        const val = raw[cand];
        if (val != null && String(val).trim() !== "") return val;
      }
    }
    return "";
  }
  function cameraHasBlock(cam) {
    const direct = cam?.currentBlock;
    if (direct && String(direct).trim() !== "") return true;
    const raw = getRawValue(cam, "Current block");
    return String(raw).trim() !== "";
  }
  function isRecording(cam) {
    const val = cam?.recordingNormalized || cam?.recording || "";
    return /record/i.test(String(val));
  }
  function renderProgress(lines){
    progressBox.value = (lines || []).join("\n");
    progressBox.scrollTop = progressBox.scrollHeight;
  }

  /* ------ Overview cards ------ */
  function updateOverviewCards() {
    const cams = snapshot.cameras || [];
    const rec = cams.filter(isRecording).length; // insensitive
    const noRec = cams.length - rec;
    const noBlock = cams.filter(c => !cameraHasBlock(c)).length;

    cardTotalCams.textContent = cams.length;
    cardRecCams.textContent   = rec;
    cardNoRecCams.textContent = noRec;
    cardNoBlocks.textContent  = noBlock;
  }

  /* ------ Recording chart ------ */
  function renderRecordingChart() {
    const cams = snapshot.cameras || [];
    const rec = cams.filter(isRecording).length;
    const noBlock = cams.filter(c => !cameraHasBlock(c)).length;
    const noRec = cams.length - rec;

    const data = {
      labels: ["Grabando", "Sin grabar", "Sin bloque"],
      datasets: [{ data: [rec, Math.max(noRec - noBlock, 0), noBlock] }]
    };

    if (charts.recording) {
      charts.recording.data.labels = data.labels;
      charts.recording.data.datasets[0].data = data.datasets[0].data;
      charts.recording.update();
      return;
    }

    charts.recording = new Chart(recordingCanvas.getContext("2d"), {
      type: "doughnut",
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: "#c9d1d9" } },
          tooltip: { enabled: true }
        }
      }
    });
  }

  /* ------ Storage charts por VRM ------ */
  function cssEscape(s) { return String(s).replace(/(["\\.#\[\]\(\)])/g, "\\$1"); }

  function buildOrUpdateStorageCharts() {
    const stats = snapshot.vrmStats || [];
    const seen = new Set();

    stats.forEach(v => {
      const vrmId = v.vrmId;
      seen.add(vrmId);

       const clamp = (value, min, max) => {
        const upper = Math.max(max, min);
        return Math.min(Math.max(Number(value || 0), min), upper);
      };
      const total = Math.max(Number(v.totalGiB || 0), 0);
      const available = clamp(v.availableGiB, 0, total);
      const used = Math.max(0, total - available);
      const empty = clamp(v.emptyGiB, 0, total - used);
      const protectedGiB = clamp(v.protectedGiB, 0, total - used - empty);
      const otherFree = Math.max(0, total - used - empty - protectedGiB);

      let card = storageHost.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
      if (!card) {
        card = document.createElement("div");
        card.className = "storage-card";
        card.setAttribute("data-vrm-id", vrmId);
        card.innerHTML = `
          <div class="storage-card-head">
            <div class="title">${vrmId}</div>
            <div class="meta">Total: ${total} GiB</div>
          </div>
          <div class="storage-chart-area">
            <canvas></canvas>
          </div>
        `;
        storageHost.appendChild(card);
      } else {
        const meta = card.querySelector(".meta");
        if (meta) meta.textContent = `Total: ${total} GiB`;
      }

      const canvas = card.querySelector("canvas");
      const ctx = canvas.getContext("2d");
      const dataset = {
        labels: ["Used", "Available", "Empty", "Protected"],
        datasets: [{ label: "GiB", data: [used, otherFree, empty, protectedGiB], borderWidth: 0 }]
      };

      if (charts.storageByVrm.has(vrmId)) {
        const chart = charts.storageByVrm.get(vrmId);
        chart.data.labels = dataset.labels;
        chart.data.datasets[0].data = dataset.datasets[0].data;
        chart.update();
      } else {
        const chart = new Chart(ctx, {
          type: "bar",
          data: dataset,
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: {
                stacked: true,
                ticks: { color: "#c9d1d9" },
                grid: { color: "rgba(255,255,255,0.06)" }
              },
              y: {
                stacked: true,
                ticks: { color: "#c9d1d9" },
                grid: { color: "rgba(255,255,255,0.06)" }
              }
            },
            plugins: {
              legend: { display: false },
              tooltip: { enabled: true }
            }
          }
        });
        charts.storageByVrm.set(vrmId, chart);
         if (!storageResizeObservers.has(vrmId) && window.ResizeObserver) {
          const observer = new ResizeObserver(() => {
            const targetChart = charts.storageByVrm.get(vrmId);
            if (targetChart) targetChart.resize();
          });
          observer.observe(card);
          storageResizeObservers.set(vrmId, observer);
        }
      }
    });

    // limpia VRMs que ya no estén
    charts.storageByVrm.forEach((chart, vrmId) => {
      if (!seen.has(vrmId)) {
        chart.destroy();
        charts.storageByVrm.delete(vrmId);
        const deadCard = storageHost.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
        if (deadCard) deadCard.remove();
        const observer = storageResizeObservers.get(vrmId);
        if (observer) {
          observer.disconnect();
          storageResizeObservers.delete(vrmId);
        }
      }
    });
  }

  /* ------ Overview table ------ */
  function updateOverviewTable(){
    const cams = snapshot.cameras || [];
    tblOverviewBody.innerHTML = "";
    cams.forEach(c => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${nice(c.vrmId)}</td>
        <td>${nice(c.name)}</td>
        <td>${nice(c.address)}</td>
        <td>${nice(c.recording)}</td>
        <td>${nice(c.currentBlock || getRawValue(c, "Current block") || "")}</td>
        <td>${nice(c.fw)}</td>
        <td>${nice(c.connTime)}</td>
      `;
      tblOverviewBody.appendChild(tr);
    });
    applySort("tbl-overview");
  }

  /* ------ VRMs table ------ */
  function updateVrms(){
    const rows = snapshot.vrmStats || [];
    tblVrmsBody.innerHTML = "";
    rows.forEach(v => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${nice(v.vrmId)}</td>
        <td class="num">${v.targets ?? ""}</td>
        <td class="num">${v.cameras ?? ""}</td>
        <td class="num">${v.totalGiB ?? ""}</td>
        <td class="num">${v.availableGiB ?? ""}</td>
        <td class="num">${v.emptyGiB ?? ""}</td>
        <td class="num">${v.protectedGiB ?? ""}</td>
      `;
      tblVrmsBody.appendChild(tr);
    });
    applySort("tbl-vrms");
  }

  /* ------ Cameras table ------ */
  function updateCamerasTable(){
    const nameQ = (filterName?.value||"").toLowerCase();
    const ipQ   = (filterIp?.value||"").toLowerCase();
    const cams = (snapshot.cameras||[]).filter(c => {
      const name = (c.name||"").toLowerCase();
      const ip   = (c.address||"").toLowerCase();
      return (!nameQ || name.includes(nameQ)) && (!ipQ || ip.includes(ipQ));
    });

    tblCamsBody.innerHTML = "";
    cams.forEach(c => {
      const block = c.currentBlock || getRawValue(c, "Current block") || "";
      const max   = c.maxBitrate ?? "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${nice(c.vrmId)}</td>
        <td>${nice(c.name)}</td>
        <td>${nice(c.address)}</td>
        <td>${nice(c.recording)}</td>
        <td>${nice(block)}</td>
        <td>${nice(c.fw)}</td>
        <td>${nice(c.connTime)}</td>
        <td>${nice(c.primaryTarget || getRawValue(c, "Primary target") || "")}</td>
        <td class="num" data-value="${max}">${nice(max)}</td>
      `;
      tblCamsBody.appendChild(tr);
    });
    applySort("tbl-cams");
  }

  function renderAll(){
    tsBox.textContent = snapshot.ts ? new Date(snapshot.ts).toLocaleString() : "—";
    renderProgress(snapshot.progress || []);
    updateOverviewCards();
    renderRecordingChart();
    buildOrUpdateStorageCharts();
    updateOverviewTable();
    updateVrms();
    updateCamerasTable();
  }

  /* ------ sorting ------ */
  const sortState = {};
  function isNumericText(s) {
    if (s == null) return false;
    const v = String(s).replace(/\s+/g,'').replace(',', '.');
    return v !== '' && !isNaN(Number(v));
  }
  function getCellValue(tr, idx) {
    const td = tr.children[idx];
    if (!td) return '';
    const dv = td.getAttribute('data-value');
    return dv != null ? dv : td.textContent.trim();
  }
  function compareBy(idx, dir) {
    return (a, b) => {
      const va = getCellValue(a, idx);
      const vb = getCellValue(b, idx);
      if (isNumericText(va) && isNumericText(vb)) {
        return (Number(va.replace(',', '.')) - Number(vb.replace(',', '.'))) * dir;
      }
      return va.localeCompare(vb, undefined, { sensitivity: 'accent' }) * dir;
    };
  }
  function applySort(tableId) {
    const st = sortState[tableId];
    if (!st) return;
    const table = document.getElementById(tableId);
    if (!table) return;
    const tbody = table.tBodies[0];
    if (!tbody) return;

    const rows = [...tbody.querySelectorAll('tr')];
    rows.sort(compareBy(st.col, st.dir));
    rows.forEach(r => tbody.appendChild(r));

    table.querySelectorAll('th').forEach((th, i) => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (i === st.col) th.classList.add(st.dir === 1 ? 'sort-asc' : 'sort-desc');
    });
  }
  function setupSortable(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;
    table.classList.add('sortable');
    const thead = table.tHead;
    if (!thead) return;
    [...thead.querySelectorAll('th')].forEach((th, idx) => {
      th.addEventListener('click', () => {
        const prev = sortState[tableId];
        const dir = prev && prev.col === idx ? -prev.dir : 1;
        sortState[tableId] = { col: idx, dir };
        applySort(tableId);
      });
    });
  }
  setupSortable("tbl-overview");
  setupSortable("tbl-vrms");
  setupSortable("tbl-cams");

  /* ------ events ------ */
  btnScan.addEventListener("click", async () => {
    progressBox.value = "";
    tsBox.textContent = "consultando…";
    const vrms = parseVrmTextarea(vrmTextarea.value);
    if (!vrms.length){ alert("Cargá al menos un VRM (site • nombre • IP)"); return; }
    const payload = { vrms, user: userInput.value || "srvadmin", pass: passInput.value || "" };

    try{
      const r = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      snapshot = {
        cameras: data.cameras || [],
        vrmStats: data.vrmStats || [],
        vrms: data.vrms || [],
        progress: data.progress || [],
        ts: data.ts || Date.now()
      };
      renderAll();
    }catch(e){
      progressBox.value += `\n❌ ${e.message}`;
    }
  });

  // Upload offline HTML
  btnAttach.addEventListener("click", async () => {
    if (!inputFiles.files || !inputFiles.files.length) {
      alert("Adjuntá al menos un HTML (showCameras/showDevices/showTargets).");
      return;
    }
    const fd = new FormData();
    [...inputFiles.files].forEach(f => fd.append("files", f, f.name));
    fd.append("label", inputLabel.value || "Importado • VRM (sin-IP)");

    try {
      const r = await fetch("/api/upload/html", { method: "POST", body: fd });
      const data = await r.json();
      if (data.error) { alert(data.error); return; }
      snapshot = {
        cameras: data.cameras || [],
        vrmStats: data.vrmStats || [],
        vrms: data.vrms || [],
        progress: data.progress || [],
        ts: data.ts || Date.now()
      };
      renderAll();
      // limpiamos input (para poder volver a adjuntar los mismos archivos si se desea)
      inputFiles.value = "";
    } catch (e) {
      alert("Error subiendo HTML: " + e.message);
    }
  });

  filterName?.addEventListener("input", updateCamerasTable);
  filterIp?.addEventListener("input", updateCamerasTable);
  btnExportCams?.addEventListener("click", () => window.open("/api/export/cameras.csv", "_blank"));
  btnExportVrms?.addEventListener("click", () => window.open("/api/export/vrms.csv", "_blank"));
})();