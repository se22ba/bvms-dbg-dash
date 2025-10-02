(() => {
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

  // Inputs / botones / tabs
  const vrmTextarea = $("#vrm-list");
  const userInput   = $("#dbg-user");
  const passInput   = $("#dbg-pass");
  const btnScan     = $("#btn-scan");
  const progressBox = $("#progress");
  const tsBox       = $("#ts");
  const tabButtons  = $$(".tab-btn");
  const tabPages    = $$(".tab-page");

  // Overview (cards y contenedores)
  const cardTotalChannels   = $("#card-total-channels");
  const cardActiveRecord    = $("#card-active-recordings");
  const cardOfflineChannels = $("#card-offline-channels");
  const cardSignalLoss      = $("#card-signal-loss");
  const cardVmsIssues       = $("#card-vms-issues");
  const cardExternalIssues  = $("#card-external-issues");
  const deviceCardHost      = $("#vrm-device-grid");
  const loadCardHost        = $("#vrm-load-grid");

  // VRMs
  const tblVrmsBody = $("#tbl-vrms tbody");

  // Cámaras
  const tblCamsBody   = $("#tbl-cams tbody");
  const filterName    = $("#filter-name");
  const filterIp      = $("#filter-ip");
  const btnExportCams = $("#btn-exp-cams");
  const btnExportVrms = $("#btn-exp-vrms");

  // Charts
  const recordingCanvas = $("#chart-recording");
  const storageHost     = $("#vrm-storage-charts");
  let charts = {
    cameraStatus: null,
    storageByVrm: new Map(),
    devicesByVrm: new Map(),
    loadByVrm: new Map(),
  };

  // ResizeObservers por tarjeta
  const storageResizeObservers = new Map();
  const deviceResizeObservers  = new Map();
  const loadResizeObservers    = new Map();

  // (opcional, si usas adjuntar archivos en algún lado)
  const inputFiles = $("#import-files");
  const inputLabel = $("#import-label");
  const btnAttach  = $("#btn-import");

  // Estado global
  let snapshot = {
    cameras: [],
    vrmStats: [],
    vrms: [],
    progress: [],
    ts: 0,
    overviewTotals: {},
    cameraStatus: {},
    dashboards: []
  };
  
  const chartWarningMessage = "⚠️ Chart.js no está disponible; se omiten gráficos.";
  let chartJsMissingLogged = false;
  function ensureChartJsAvailable() {
    if (typeof window !== "undefined" && window.Chart) return true;
    const hasMessage = Array.isArray(snapshot.progress) && snapshot.progress.includes(chartWarningMessage);
    if (!hasMessage) {
      const lines = Array.isArray(snapshot.progress)
        ? [...snapshot.progress, chartWarningMessage]
        : [chartWarningMessage];
      snapshot.progress = lines;
    }
    if (!chartJsMissingLogged || !hasMessage) {
      chartJsMissingLogged = true;
      renderProgress(snapshot.progress);
    }
    return false;
  }

  
   function updateExportButtons() {
    const hasCameras = Array.isArray(snapshot?.cameras) && snapshot.cameras.length > 0;
    const hasVrms = Array.isArray(snapshot?.vrms) && snapshot.vrms.length > 0;
    if (btnExportCams) btnExportCams.disabled = !hasCameras;
    if (btnExportVrms) btnExportVrms.disabled = !hasVrms;
  }

  updateExportButtons();

  /* ================= TABS ================= */
  tabButtons.forEach(b => {
    b.addEventListener("click", () => {
      tabButtons.forEach(x => x.classList.remove("active"));
      tabPages.forEach(p => p.classList.add("hidden"));
      b.classList.add("active");
      $(b.getAttribute("data-target")).classList.remove("hidden");
      // Ajuste de charts tras mostrar tab
      setTimeout(() => {
        if (charts.cameraStatus) charts.cameraStatus.resize();
        charts.storageByVrm.forEach(ch => ch.resize());
        charts.devicesByVrm.forEach(ch => ch.resize());
        charts.loadByVrm.forEach(ch => ch.resize());
      }, 50);
    });
  });

  /* ================= HELPERS ================= */
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

  // colores
  const COLORS = {
    recording: "#3fb950",
    disabled: "#f78166",
    pending:   "#f2cc60",
    offline:   "#ff7b72",
    other:     "#8b949e",
  };
  const ACCENT_COLORS = ["#58a6ff", "#f2cc60", "#ff7b72", "#3fb950", "#b393f5", "#ffa657", "#8b949e"];

  function hexToRgba(hex, alpha) {
    if (!hex) return `rgba(255,255,255,${alpha})`;
    let value = String(hex).trim().replace(/^#/, "");
    if (value.length === 3) value = value.split("").map(ch => ch + ch).join("");
    const int = parseInt(value, 16);
    if (!Number.isFinite(int)) return `rgba(255,255,255,${alpha})`;
    const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  function applyAccentStyles(el, color) {
    if (!el) return;
    el.style.setProperty("--accent-color", color);
    el.style.setProperty("--accent-border", hexToRgba(color, 0.35));
    el.style.setProperty("--accent-bg", hexToRgba(color, 0.15));
  }

  function extractNumberFromText(text) {
    if (!text) return null;
    const match = String(text).match(/-?\d[\d.,]*/);
    if (!match) return null;
    let numStr = match[0];
    const lastComma = numStr.lastIndexOf(",");
    const lastDot   = numStr.lastIndexOf(".");
    const sepIndex  = Math.max(lastComma, lastDot);
    if (sepIndex >= 0) {
      const intPart     = numStr.slice(0, sepIndex).replace(/[^\d-]/g, "");
      const decimalPart = numStr.slice(sepIndex + 1).replace(/[^\d]/g, "");
      numStr = `${intPart}.${decimalPart}`;
    } else {
      numStr = numStr.replace(/[^\d-]/g, "");
    }
    const num = Number(numStr);
    return Number.isFinite(num) ? num : null;
  }

  function getDeviceMetricNumber(vrm, key) {
    const metrics = vrm?.dashboard?.devices?.metrics || {};
    const val = metrics[key];
    if (isFiniteNumber(val)) return val;
    const text = vrm?.dashboard?.devices?.metricsText?.[key];
    return extractNumberFromText(text);
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

  // <- ESTA era la que faltaba cerrar
  function getRawValue(cam, ...keys) {
    const raw = cam?.raw || {};
    for (const key of keys) {
      if (!key) continue;
      const candidates = [key, String(key).toLowerCase()];
      for (const cand of candidates) {
        if (cand in raw && raw[cand] != null) return raw[cand];
      }
    }
    return "";
  }

  // Si el server no mandara cameraStatus, devolver algo seguro
  function getCameraStatusSummary() {
    const s = snapshot.cameraStatus || {};
    // normalizamos claves típicas
    return {
      total:             s.total ?? (snapshot.cameras?.length || 0),
      recording:         s.recording ?? 0,
      recordingDisabled: s.recordingDisabled ?? 0,
      pending:           s.pending ?? 0,
      offline:           s.offline ?? 0,
      vmsIssues:         s.vmsIssues ?? 0,
      externalIssues:    s.externalIssues ?? 0
    };
  }

  /* ================= OVERVIEW: CARDS & CHART ================= */
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
    if (!recordingCanvas) return;
    const status  = getCameraStatusSummary();
    const base    = [status.recording || 0, status.recordingDisabled || 0, status.pending || 0, status.offline || 0];
    const labels  = ["Grabando", "Recording disabled", "Pending", "Offline"];
    const total   = status.total || base.reduce((a,b)=>a+b,0);
    const other   = Math.max(total - base.reduce((a,b)=>a+b,0), 0);
    if (other > 0) { base.push(other); labels.push("Otros"); }

    const colors  = [COLORS.recording, COLORS.disabled, COLORS.pending, COLORS.offline];
    if (other > 0) colors.push(COLORS.other);

    const data = { labels, datasets: [{ data: base, backgroundColor: colors, borderWidth: 0 }] };
     if (!ensureChartJsAvailable()) {
      if (charts.cameraStatus) {
        charts.cameraStatus.destroy();
        charts.cameraStatus = null;
      }
      return;
    }
    if (charts.cameraStatus) {
      charts.cameraStatus.data.labels = data.labels;
      charts.cameraStatus.data.datasets[0].data = data.datasets[0].data;
      charts.cameraStatus.data.datasets[0].backgroundColor = colors;
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

  function cssEscape(s) {
    return String(s).replace(/(["\\.#\[\]\(\)])/g, "\\$1");
  }

  /* ================= STORAGE CARDS ================= */
  function renderStorageCards() {
    if (!storageHost) return;
    storageHost.querySelectorAll(".empty-block").forEach(el => el.remove());
    const rows = snapshot.vrms || [];
    const seen = new Set();

    rows.forEach(v => {
      const entries = v?.dashboard?.storage?.entries || [];
      if (!entries.length) return;
      const vrmId = v.vrmId;
      seen.add(vrmId);

      let card = storageHost.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
      if (!card) {
        card = document.createElement("div");
        card.className = "storage-card";
        card.setAttribute("data-vrm-id", vrmId);
        card.innerHTML = `
          <div class="storage-card-head">
            <div class="title"></div>
            <div class="meta"></div>
          </div>
          <div class="chart-box mini"><canvas></canvas></div>
          <div class="metric-tags"></div>
        `;
        storageHost.appendChild(card);
        if (!storageResizeObservers.has(vrmId) && window.ResizeObserver) {
          const observer = new ResizeObserver(() => {
            const targetChart = charts.storageByVrm.get(vrmId);
            if (targetChart) targetChart.resize();
          });
          observer.observe(card);
          storageResizeObservers.set(vrmId, observer);
        }
      }

      const titleEl = card.querySelector(".title");
      const metaEl  = card.querySelector(".meta");
      if (titleEl) titleEl.textContent = nice(vrmId);
      if (metaEl)  metaEl.textContent  = `${entries.length} métricas`;

      const numericEntries = entries.filter(e => isFiniteNumber(e?.number));
      const chartEntries   = numericEntries.slice(0, 5);
      const labels = chartEntries.map(e => nice(e.label));
      const data   = chartEntries.map(e => e.number ?? 0);
      const colors = chartEntries.map((_, i) => ACCENT_COLORS[(i + 1) % ACCENT_COLORS.length]);

      const chartBox = card.querySelector(".chart-box");
      const canvas   = card.querySelector("canvas");
      let chart      = charts.storageByVrm.get(vrmId);

      if (chartEntries.length && canvas) {
         if (!ensureChartJsAvailable()) {
          if (chart) {
            chart.destroy();
            charts.storageByVrm.delete(vrmId);
          }
          if (chartBox) chartBox.style.display = "none";
        } else {
         if (!chart) {
            chart = new Chart(canvas.getContext("2d"), {
              type: "bar",
              data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, borderSkipped: false }] },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                scales: {
                  x: { ticks: { color: "#c9d1d9" }, grid: { color: "rgba(255,255,255,0.06)" } },
                  y: { ticks: { color: "#c9d1d9" }, grid: { display: false } }
                },
                plugins: { legend: { display: false }, tooltip: { enabled: true } }
              }
            });
            charts.storageByVrm.set(vrmId, chart);
          } else {
            chart.data.labels = labels;
            chart.data.datasets[0].data = data;
            chart.data.datasets[0].backgroundColor = colors;
            chart.update();
          }
          if (chartBox) chartBox.style.display = "";
        }
       
      } else {
        if (chart) {
          chart.destroy();
          charts.storageByVrm.delete(vrmId);
        }
        if (chartBox) chartBox.style.display = "none";
      }

      const tagsHost = card.querySelector(".metric-tags");
      if (tagsHost) {
        tagsHost.innerHTML = "";
        entries.slice(0, 6).forEach((entry, idx) => {
          const color = ACCENT_COLORS[(idx + 2) % ACCENT_COLORS.length];
          const tag = document.createElement("div");
          tag.className = "metric-tag with-accent";
          const valueDisplay = entry.valueText && entry.valueText.trim() !== ""
            ? entry.valueText.trim()
            : formatMetric(entry.number);
          tag.innerHTML = `
            <span class="dot"></span>
            <div class="tag-info">
              <span class="value accent-value">${valueDisplay}</span>
              <span class="label">${nice(entry.label)}</span>
            </div>
          `;
          applyAccentStyles(tag, color);
          tagsHost.appendChild(tag);
        });
      }
    });

    charts.storageByVrm.forEach((chart, vrmId) => {
      if (!rows.find(r => r.vrmId === vrmId)) {
        chart.destroy();
        charts.storageByVrm.delete(vrmId);
        const dead = storageHost.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
        if (dead) dead.remove();
        const observer = storageResizeObservers.get(vrmId);
        if (observer) { observer.disconnect(); storageResizeObservers.delete(vrmId); }
      }
    });

    if (!rows.length) {
      storageHost.innerHTML = '<div class="empty-block">Sin información de almacenamiento disponible.</div>';
    }
  }

  /* ================= DEVICE CARDS ================= */
  function renderDeviceOverview() {
    if (!deviceCardHost) return;
    deviceCardHost.querySelectorAll(".empty-block").forEach(el => el.remove());
    const rows = snapshot.vrms || [];
    const seen = new Set();

    rows.forEach(v => {
      const vrmId = v.vrmId;
      const totalMetric   = pickDisplayMetric(v, "totalChannels");
      const offlineMetric = pickDisplayMetric(v, "offlineChannels");
      const activeMetric  = pickDisplayMetric(v, "activeRecordings");
      const lossMetric    = pickDisplayMetric(v, "signalLoss");

      const totalNum   = getDeviceMetricNumber(v, "totalChannels");
      const offlineNum = getDeviceMetricNumber(v, "offlineChannels");
      const activeNum  = getDeviceMetricNumber(v, "activeRecordings");
      const lossNum    = getDeviceMetricNumber(v, "signalLoss");

      if (![totalNum, offlineNum, activeNum, lossNum].some(isFiniteNumber)) {
        if ((totalMetric.value ?? "") === "—") return;
      }

      seen.add(vrmId);
      let card = deviceCardHost.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
      let created = false;
      if (!card) {
        card = document.createElement("div");
        card.className = "vrm-card";
        card.setAttribute("data-vrm-id", vrmId);
        card.innerHTML = `
          <div class="vrm-card-head">
            <div class="title"></div>
            <div class="meta"></div>
          </div>
          <div class="vrm-card-body">
            <div class="chart-box mini"><canvas></canvas></div>
            <div class="pill-list">
              <div class="pill with-accent" data-key="active">
                <span class="pill-label">Grabando</span>
                <span class="pill-value accent-value" data-metric="active"></span>
              </div>
              <div class="pill with-accent" data-key="offline">
                <span class="pill-label">Offline</span>
                <span class="pill-value accent-value" data-metric="offline"></span>
              </div>
              <div class="pill with-accent" data-key="signal">
                <span class="pill-label">Pérdida</span>
                <span class="pill-value accent-value" data-metric="signal"></span>
              </div>
              <div class="pill with-accent" data-key="other">
                <span class="pill-label">Otros</span>
                <span class="pill-value accent-value" data-metric="other"></span>
              </div>
            </div>
          </div>
        `;
        deviceCardHost.appendChild(card);
        applyAccentStyles(card.querySelector('[data-key="active"]'),  COLORS.recording);
        applyAccentStyles(card.querySelector('[data-key="offline"]'), COLORS.offline);
        applyAccentStyles(card.querySelector('[data-key="signal"]'),  COLORS.disabled);
        applyAccentStyles(card.querySelector('[data-key="other"]'),   COLORS.other);
        if (!deviceResizeObservers.has(vrmId) && window.ResizeObserver) {
          const observer = new ResizeObserver(() => {
            const chart = charts.devicesByVrm.get(vrmId);
            if (chart) chart.resize();
          });
          observer.observe(card);
          deviceResizeObservers.set(vrmId, observer);
        }
        created = true;
      }

      const titleEl = card.querySelector(".title");
      const metaEl  = card.querySelector(".meta");
      if (titleEl) titleEl.textContent = nice(vrmId);
      if (metaEl)  metaEl.textContent  = totalMetric.value !== "—" ? `Total ${formatMetric(totalMetric.value)}` : "Total —";

      const activeValueEl  = card.querySelector('[data-metric="active"]');
      const offlineValueEl = card.querySelector('[data-metric="offline"]');
      const lossValueEl    = card.querySelector('[data-metric="signal"]');
      const otherValueEl   = card.querySelector('[data-metric="other"]');

      if (activeValueEl)  activeValueEl.textContent  = formatMetric(activeMetric.value);
      if (offlineValueEl) offlineValueEl.textContent = formatMetric(offlineMetric.value);
      if (lossValueEl)    lossValueEl.textContent    = formatMetric(lossMetric.value);

      const sumKnown = [activeNum, offlineNum, lossNum].reduce((acc, val) => acc + (isFiniteNumber(val) ? val : 0), 0);
      const otherNum = isFiniteNumber(totalNum) ? Math.max(totalNum - sumKnown, 0) : null;
      const otherPill = card.querySelector('[data-key="other"]');
      if (otherValueEl) {
        if (otherNum != null) {
          otherValueEl.textContent = formatMetric(otherNum);
          if (otherPill) otherPill.style.display = otherNum > 0 ? "" : "none";
        } else {
          otherValueEl.textContent = "—";
          if (otherPill) otherPill.style.display = "none";
        }
      }

      const labels = ["Grabando", "Offline", "Pérdida"];
      const data   = [
        isFiniteNumber(activeNum)  ? activeNum  : 0,
        isFiniteNumber(offlineNum) ? offlineNum : 0,
        isFiniteNumber(lossNum)    ? lossNum    : 0,
      ];
      const colors = [COLORS.recording, COLORS.offline, COLORS.disabled];
      if (otherNum != null && otherNum > 0) {
        labels.push("Otros"); data.push(otherNum); colors.push(COLORS.other);
      }

      let chart = charts.devicesByVrm.get(vrmId);
      const canvas = card.querySelector("canvas");
      if (canvas) {
        if (!ensureChartJsAvailable()) {
          if (chart) {
            chart.destroy();
            charts.devicesByVrm.delete(vrmId);
          }
        } else if (!chart) {
          chart = new Chart(canvas.getContext("2d"), {
            type: "doughnut",
            data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              cutout: "55%",
              plugins: { legend: { display: false }, tooltip: { enabled: true } }
            }
          });
          charts.devicesByVrm.set(vrmId, chart);
        } else {
          chart.data.labels = labels;
          chart.data.datasets[0].data = data;
          chart.data.datasets[0].backgroundColor = colors;
          chart.update();
        }
      }
      if (!created) deviceCardHost.appendChild(card);
    });

    charts.devicesByVrm.forEach((chart, vrmId) => {
      if (!rows.find(r => r.vrmId === vrmId)) {
        chart.destroy();
        charts.devicesByVrm.delete(vrmId);
        const dead = deviceCardHost?.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
        if (dead) dead.remove();
        const obs = deviceResizeObservers.get(vrmId);
        if (obs) { obs.disconnect(); deviceResizeObservers.delete(vrmId); }
      }
    });

    if (!rows.length && deviceCardHost) {
      deviceCardHost.innerHTML = '<div class="empty-block">Sin métricas de dispositivos disponibles.</div>';
    }
  }

  /* ================= LOAD CARDS ================= */
  function renderLoadCards() {
    if (!loadCardHost) return;
    loadCardHost.querySelectorAll(".empty-block").forEach(el => el.remove());
    const rows = snapshot.vrms || [];
    const seen = new Set();

    rows.forEach(v => {
      const entries = v?.dashboard?.load?.entries || [];
      if (!entries.length) return;
      const vrmId = v.vrmId;
      seen.add(vrmId);

      let card = loadCardHost.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
      let created = false;
      if (!card) {
        card = document.createElement("div");
        card.className = "load-card";
        card.setAttribute("data-vrm-id", vrmId);
        card.innerHTML = `
          <div class="load-card-head">
            <div class="title"></div>
            <div class="meta"></div>
          </div>
          <div class="chart-box mini"><canvas></canvas></div>
          <div class="metric-tags"></div>
        `;
        loadCardHost.appendChild(card);
        if (!loadResizeObservers.has(vrmId) && window.ResizeObserver) {
          const observer = new ResizeObserver(() => {
            const chart = charts.loadByVrm.get(vrmId);
            if (chart) chart.resize();
          });
          observer.observe(card);
          loadResizeObservers.set(vrmId, observer);
        }
        created = true;
      }

      const titleEl = card.querySelector(".title");
      const metaEl  = card.querySelector(".meta");
      if (titleEl) titleEl.textContent = nice(vrmId);
      if (metaEl)  metaEl.textContent  = `${entries.length} métricas`;

      const numericEntries = entries.filter(e => isFiniteNumber(e?.number));
      const chartEntries   = numericEntries.slice(0, 5);
      const labels = chartEntries.map(e => nice(e.label));
      const data   = chartEntries.map(e => e.number ?? 0);
      const colors = chartEntries.map((_, i) => ACCENT_COLORS[i % ACCENT_COLORS.length]);

      const chartBox = card.querySelector(".chart-box");
      const canvas   = card.querySelector("canvas");
      let chart      = charts.loadByVrm.get(vrmId);

      if (chartEntries.length && canvas) {
          if (!ensureChartJsAvailable()) {
          if (chart) {
            chart.destroy();
            charts.loadByVrm.delete(vrmId);
          }
          if (chartBox) chartBox.style.display = "none";
        } else {
           if (!chart) {
            chart = new Chart(canvas.getContext("2d"), {
              type: "bar",
              data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, borderSkipped: false }] },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: "y",
                scales: {
                  x: { ticks: { color: "#c9d1d9" }, grid: { color: "rgba(255,255,255,0.06)" } },
                  y: { ticks: { color: "#c9d1d9" }, grid: { display: false } }
                },
                plugins: { legend: { display: false }, tooltip: { enabled: true } }
              }
            });
            charts.loadByVrm.set(vrmId, chart);
          } else {
            chart.data.labels = labels;
            chart.data.datasets[0].data = data;
            chart.data.datasets[0].backgroundColor = colors;
            chart.update();
          }
          if (chartBox) chartBox.style.display = "";
        }
        
      } else {
        if (chart) { chart.destroy(); charts.loadByVrm.delete(vrmId); }
        if (chartBox) chartBox.style.display = "none";
      }

      const tagsHost = card.querySelector(".metric-tags");
      if (tagsHost) {
        tagsHost.innerHTML = "";
        entries.slice(0, 6).forEach((entry, idx) => {
          const color = ACCENT_COLORS[idx % ACCENT_COLORS.length];
          const tag = document.createElement("div");
          tag.className = "metric-tag with-accent";
          const valueDisplay = entry.valueText && entry.valueText.trim() !== ""
            ? entry.valueText.trim()
            : formatMetric(entry.number);
          tag.innerHTML = `
            <span class="dot"></span>
            <div class="tag-info">
              <span class="value accent-value">${valueDisplay}</span>
              <span class="label">${nice(entry.label)}</span>
            </div>
          `;
          applyAccentStyles(tag, color);
          tagsHost.appendChild(tag);
        });
      }

      if (!created) loadCardHost.appendChild(card);
    });

    charts.loadByVrm.forEach((chart, vrmId) => {
      if (!rows.find(r => r.vrmId === vrmId)) {
        chart.destroy();
        charts.loadByVrm.delete(vrmId);
        const dead = loadCardHost?.querySelector(`[data-vrm-id="${cssEscape(vrmId)}"]`);
        if (dead) dead.remove();
        const obs = loadResizeObservers.get(vrmId);
        if (obs) { obs.disconnect(); loadResizeObservers.delete(vrmId); }
      }
    });

    if (!rows.length && loadCardHost) {
      loadCardHost.innerHTML = '<div class="empty-block">Sin métricas de compensación disponibles.</div>';
    }
  }

  /* ================= TABLA VRMs ================= */
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

  /* ================= TABLA CÁMARAS ================= */
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

  /* ================= RENDER ALL ================= */
  function renderAll(){
    tsBox.textContent = snapshot.ts ? new Date(snapshot.ts).toLocaleString() : "—";
    renderProgress(snapshot.progress || []);
    updateOverviewCards();
    renderDeviceOverview();
    renderCameraStatusChart();
    renderStorageCards();
    renderLoadCards();
    updateVrms();
    updateCamerasTable();
    updateExportButtons();
  }

  function renderProgress(lines){
    progressBox.value = (lines||[]).join("\n");
    progressBox.scrollTop = progressBox.scrollHeight;
  }

  /* ================= SORT ================= */
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
  setupSortable("tbl-vrms");
  setupSortable("tbl-cams");

  /* ================= EVENTOS ================= */
  function applySnapshotData(data) {
    snapshot = {
      cameras: data && data.cameras ? data.cameras : [],
      vrmStats: data && data.vrmStats ? data.vrmStats : [],
      vrms: data && data.vrms ? data.vrms : [],
      progress: data && data.progress ? data.progress : [],
      ts: data && data.ts ? data.ts : Date.now(),
      overviewTotals: data && data.overviewTotals ? data.overviewTotals : {},
      cameraStatus: data && data.cameraStatus ? data.cameraStatus : {},
      dashboards: data && data.dashboards ? data.dashboards : []
    };
    renderAll();
  }
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
          let data;
      try { data = await r.json(); }
      catch { data = {}; }
      if (!r.ok) {
        renderProgress(data && data.progress ? data.progress : []);
        const msg = data && data.error ? data.error : `Error ${r.status}`;
        throw new Error(msg);
      }
      applySnapshotData(data);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      progressBox.value += `\n❌ ${message}`;
    }
  });

if (btnExportCams) {
    btnExportCams.addEventListener("click", () => {
      if (btnExportCams.disabled) return;
      window.open("/api/export/cameras.csv", "_blank");
    });
  }

  if (btnExportVrms) {
    btnExportVrms.addEventListener("click", () => {
      if (btnExportVrms.disabled) return;
      window.open("/api/export/vrms.csv", "_blank");
    });
  }

if (inputFiles && inputLabel) {
    inputFiles.addEventListener("change", () => {
      const files = inputFiles.files || [];
      if (!files.length) {
        inputLabel.textContent = "Sin archivos seleccionados";
      } else if (files.length === 1) {
        inputLabel.textContent = files[0].name;
      } else {
        inputLabel.textContent = `${files.length} archivos seleccionados`;
      }
    });
  }

  if (btnAttach && inputFiles && inputLabel) {
    btnAttach.addEventListener("click", async () => {
      const files = inputFiles.files || [];
      if (!files.length) {
        alert("Seleccioná al menos un archivo HTML exportado");
        return;
      }

      progressBox.value = "";
      tsBox.textContent = "importando…";
      inputLabel.textContent = "Importando…";

      const formData = new FormData();
      for (let i = 0; i < files.length; i++) {
        formData.append("files", files[i]);
      }

      try {
        const r = await fetch("/api/upload/html", {
          method: "POST",
          body: formData
        });
        let data;
        try { data = await r.json(); }
        catch { data = {}; }
        if (!r.ok) {
          renderProgress(data && data.progress ? data.progress : []);
          const msg = data && data.error ? data.error : `Error ${r.status}`;
          throw new Error(msg);
        }
        applySnapshotData(data);
        const vrmLabel = data && data.vrms && data.vrms[0] && data.vrms[0].vrmId;
        inputLabel.textContent = vrmLabel ? `Importado: ${vrmLabel}` : "Importación completada";
        inputFiles.value = "";
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        progressBox.value += `\n❌ ${message}`;
        inputLabel.textContent = `Error: ${message}`;
      }
    });
  }

})();