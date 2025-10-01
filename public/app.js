(() => {
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

  
  const vrmTextarea = $("#vrm-list");
  const userInput   = $("#dbg-user");
  const passInput   = $("#dbg-pass");
  const btnScan     = $("#btn-scan");
  const progressBox = $("#progress");
  const tsBox       = $("#ts");
  const tabButtons  = $$(".tab-btn");
  const tabPages    = $$(".tab-page");

  // Overview
  const cardTotalChannels   = $("#card-total-channels");
  const cardActiveRecord    = $("#card-active-recordings");
  const cardOfflineChannels = $("#card-offline-channels");
  const cardSignalLoss      = $("#card-signal-loss");
  const cardVmsIssues       = $("#card-vms-issues");
  const cardExternalIssues  = $("#card-external-issues");
  const tblDevicesBody      = $("#tbl-devices tbody");
  const storageDetailHost   = $("#storage-detail");
  const loadDetailHost      = $("#load-detail");

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
    cameraStatus: null,
    storageByVrm: new Map(),
  };
const storageResizeObservers = new Map();
  
  const inputFiles  = $("#import-files");
  const inputLabel  = $("#import-label");
  const btnAttach   = $("#btn-import");

  let snapshot = { cameras: [], vrmStats: [], vrms: [], progress: [], ts: 0, overviewTotals: {}, cameraStatus: {}, dashboards: [] };

  
  tabButtons.forEach(b => {
    b.addEventListener("click", () => {
      tabButtons.forEach(x => x.classList.remove("active"));
      tabPages.forEach(p => p.classList.add("hidden"));
      b.classList.add("active");
      $(b.getAttribute("data-target")).classList.remove("hidden");
      setTimeout(() => {
        if (charts.cameraStatus) charts.cameraStatus.resize();
        charts.storageByVrm.forEach(ch => ch.resize());
      }, 50);
    });
  });

  
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
  
  const numberFormatter = new Intl.NumberFormat("es-AR");

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function formatMetric(value) {
    if (value == null || value === "") return "—";
    if (isFiniteNumber(value)) return numberFormatter.format(value);
    const num = Number(String(value).replace(/\s+/g, "").replace(/,/g, "."));
    if (Number.isFinite(num)) return numberFormatter.format(num);
    return String(value);
  }

  function getDashboardSection(vrm, key) {
    return vrm?.dashboard?.[key] || vrm?.[key] || null;
  }

  function getDeviceMetric(vrm, key) {
    return vrm?.dashboard?.devices?.metrics?.[key];
  }

  function getDeviceMetricText(vrm, key) {
    return vrm?.dashboard?.devices?.metricsText?.[key] ?? null;
  }

  function pickDisplayMetric(vrm, key) {
    const metric = getDeviceMetric(vrm, key);
    if (metric != null && metric !== "") return { value: metric, numeric: true };
    const text = getDeviceMetricText(vrm, key);
    if (text != null && text !== "") return { value: text, numeric: false };
    return { value: "—", numeric: false };
  }
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
  
  function isRecording(cam) {
    const val = cam?.recordingNormalized || cam?.recording || "";
    return /record/i.test(String(val));
  }
  function renderProgress(lines){
    progressBox.value = (lines || []).join("\n");
    progressBox.scrollTop = progressBox.scrollHeight;
  }

    function computeCameraStatusLocal() {
    const cams = snapshot.cameras || [];
    const summary = { recording: 0, recordingDisabled: 0, pending: 0, offline: 0, other: 0, total: cams.length };
    cams.forEach(cam => {
      const state = String(cam?.recording || "").trim().toLowerCase();
      if (!state) { summary.other += 1; return; }
      if (state.includes("recording disabled")) summary.recordingDisabled += 1;
      else if (state.includes("pending") && (state.includes("no blocks") || state.includes("connecting to storage"))) summary.pending += 1;
      else if (state.includes("offline") || state.includes("off-line")) summary.offline += 1;
      else if (state.includes("record")) summary.recording += 1;
      else summary.other += 1;
    });
    summary.vmsIssues = (summary.recordingDisabled || 0) + (summary.pending || 0);
    summary.externalIssues = summary.offline || 0;
    return summary;
    
  }

   function getCameraStatusSummary() {
    if (snapshot.cameraStatus && typeof snapshot.cameraStatus === "object") {
      const s = { ...snapshot.cameraStatus };
      if (s.total == null) s.total = snapshot.cameras?.length || 0;
      if (s.vmsIssues == null) s.vmsIssues = (s.recordingDisabled || 0) + (s.pending || 0);
      if (s.externalIssues == null) s.externalIssues = s.offline || 0;
      return s;
    }
    const computed = computeCameraStatusLocal();
    snapshot.cameraStatus = computed;
    return computed;
  }
  

     function updateOverviewCards() {
    const totals = snapshot.overviewTotals || {};
    const status = getCameraStatusSummary();
    const statusTotal = status.total ?? (snapshot.cameras?.length || 0);

    cardTotalChannels.textContent   = formatMetric(totals.totalChannels);
    cardActiveRecord.textContent    = formatMetric(totals.activeRecordings);
    cardOfflineChannels.textContent = formatMetric(totals.offlineChannels);
    cardSignalLoss.textContent      = formatMetric(totals.signalLoss);
    cardVmsIssues.textContent       = formatMetric(statusTotal > 0 ? (status.vmsIssues ?? 0) : null);
    cardExternalIssues.textContent  = formatMetric(statusTotal > 0 ? (status.externalIssues ?? 0) : null);
  }

    function renderCameraStatusChart() {
    const status = getCameraStatusSummary();
    const baseData = [status.recording || 0, status.recordingDisabled || 0, status.pending || 0, status.offline || 0];
    const labels = ["Grabando", "Recording disabled", "Pending", "Offline"];
    const total = status.total || baseData.reduce((a, b) => a + b, 0);
    const other = Math.max(total - baseData.reduce((a, b) => a + b, 0), 0);
    if (other > 0) {
      baseData.push(other);
      labels.push("Otros");
    }

    const data = { labels, datasets: [{ data: baseData }] };

    if (charts.cameraStatus) {
      charts.cameraStatus.data.labels = data.labels;
      charts.cameraStatus.data.datasets[0].data = data.datasets[0].data;
      charts.cameraStatus.update();
      return;
    }

    charts.cameraStatus = new Chart(recordingCanvas.getContext("2d"), {
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

  
  function updateDevicesTable(){
    const rows = snapshot.vrms || [];
    tblDevicesBody.innerHTML = "";

    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" class="kv-empty">Sin datos disponibles.</td>`;
      tblDevicesBody.appendChild(tr);
      return;
    }

    rows.forEach(v => {
      const total = pickDisplayMetric(v, "totalChannels");
      const offline = pickDisplayMetric(v, "offlineChannels");
      const active = pickDisplayMetric(v, "activeRecordings");
      const loss = pickDisplayMetric(v, "signalLoss");
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${nice(v.vrmId)}</td>
        <td class="num" data-value="${total.numeric ? total.value : ""}">${totalText}</td>
        <td class="num" data-value="${offline.numeric ? offline.value : ""}">${offlineText}</td>
        <td class="num" data-value="${active.numeric ? active.value : ""}">${activeText}</td>
        <td class="num" data-value="${loss.numeric ? loss.value : ""}">${lossText}</td>
      `;
       tblDevicesBody.appendChild(tr);
    });
    applySort("tbl-devices");
  }

  function renderDashboardSectionCards(container, sectionKey) {
    if (!container) return;
    container.innerHTML = "";

    const rows = snapshot.vrms || [];
    let any = false;

    rows.forEach(v => {
      const section = getDashboardSection(v, sectionKey);
      const entries = section?.entries || [];
      if (!entries.length) return;
      any = true;
      const card = document.createElement("div");
      card.className = "kv-card";

      const head = document.createElement("div");
      head.className = "kv-card-head";
      head.textContent = nice(v.vrmId);
      card.appendChild(head);

      const list = document.createElement("dl");
      list.className = "kv-list";

      entries.forEach(entry => {
        const row = document.createElement("div");
        row.className = "kv-item";
        const dt = document.createElement("dt");
        dt.textContent = nice(entry.label);
        const dd = document.createElement("dd");
        const displayValue = entry.valueText && entry.valueText.trim() !== "" ? entry.valueText : (entry.number != null ? formatMetric(entry.number) : "—");
        dd.textContent = displayValue;
        row.appendChild(dt);
        row.appendChild(dd);
        list.appendChild(row);
      });

      card.appendChild(list);
      container.appendChild(card);
    });
     if (!any) {
      const empty = document.createElement("div");
      empty.className = "kv-empty";
      empty.textContent = "Sin datos disponibles.";
      container.appendChild(empty);
    }
  }

  function renderDashboardSections() {
    renderDashboardSectionCards(storageDetailHost, "storage");
    renderDashboardSectionCards(loadDetailHost, "load");
  }

  
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
    renderCameraStatusChart();
    buildOrUpdateStorageCharts();
    updateDevicesTable();
    renderDashboardSections();
    updateVrms();
    updateCamerasTable();
  }

  
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
  setupSortable("tbl-devices");
  setupSortable("tbl-vrms");
  setupSortable("tbl-cams");

  
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
        ts: data.ts || Date.now(),
        overviewTotals: data.overviewTotals || {},
        cameraStatus: data.cameraStatus || {},
        dashboards: data.dashboards || []
      };
      renderAll();
    }catch(e){
      progressBox.value += `\n❌ ${e.message}`;
    }
  });

  
  btnAttach.addEventListener("click", async () => {
    if (!inputFiles.files || !inputFiles.files.length) {
       alert("Adjuntá al menos un HTML (showCameras/showDevices/showTargets/Bosch VRM).");
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
        ts: data.ts || Date.now(),
        overviewTotals: data.overviewTotals || {},
        cameraStatus: data.cameraStatus || {},
        dashboards: data.dashboards || []
      };
      renderAll();
      
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