(() => {
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

  // UI refs
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

  let snapshot = { cameras: [], vrmStats: [], vrms: [], progress: [], ts: 0 };

  // Tabs
  tabButtons.forEach(b => {
    b.addEventListener("click", () => {
      tabButtons.forEach(x => x.classList.remove("active"));
      tabPages.forEach(p => p.classList.add("hidden"));
      b.classList.add("active");
      const target = b.getAttribute("data-target");
      $(target).classList.remove("hidden");
    });
  });

  // Helpers
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

  function renderProgress(lines){
    progressBox.value = lines.join("\n");
    progressBox.scrollTop = progressBox.scrollHeight;
  }

  function updateOverview(){
    const cams = snapshot.cameras || [];
    cardTotalCams.textContent = cams.length;
    cardRecCams.textContent   = cams.filter(c => (c.recording||"").toLowerCase().startsWith("record")).length;
    cardNoRecCams.textContent = cams.filter(c => !(c.recording||"").toLowerCase().startsWith("record")).length;
    cardNoBlocks.textContent  = cams.filter(c => !c.raw || !c.raw["Current block"]).length;

    tblOverviewBody.innerHTML = "";
    cams.forEach(c => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${nice(c.vrmId)}</td>
        <td>${nice(c.name)}</td>
        <td>${nice(c.address)}</td>
        <td>${nice(c.recording)}</td>
        <td>${nice(c.raw?.["Current block"]||"")}</td>
        <td>${nice(c.fw)}</td>
        <td>${nice(c.connTime)}</td>
      `;
      tblOverviewBody.appendChild(tr);
    });
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
  }

  function updateCamerasTable(){
    const nameQ = (filterName.value||"").toLowerCase();
    const ipQ   = (filterIp.value||"").toLowerCase();
    const cams = (snapshot.cameras||[]).filter(c => {
      const name = (c.name||"").toLowerCase();
      const ip   = (c.address||"").toLowerCase();
      return (!nameQ || name.includes(nameQ)) && (!ipQ || ip.includes(ipQ));
    });

    tblCamsBody.innerHTML = "";
    cams.forEach(c => {
      const block = c.raw?.["Current block"] || "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${nice(c.vrmId)}</td>
        <td>${nice(c.name)}</td>
        <td>${nice(c.address)}</td>
        <td>${nice(c.recording)}</td>
        <td>${nice(block)}</td>
        <td>${nice(c.fw)}</td>
        <td>${nice(c.connTime)}</td>
        <td>${nice(c.primaryTarget || c.raw?.["Primary target"] || "")}</td>
        <td class="num">${c.maxBitrate ?? ""}</td>
      `;
      tblCamsBody.appendChild(tr);
    });
  }

  function renderAll(){
    tsBox.textContent = snapshot.ts ? new Date(snapshot.ts).toLocaleString() : "—";
    renderProgress(snapshot.progress || []);
    updateOverview();
    updateVrms();
    updateCamerasTable();
  }

  // Eventos
  btnScan.addEventListener("click", async () => {
    progressBox.value = "";
    tsBox.textContent = "consultando…";
    const vrms = parseVrmTextarea(vrmTextarea.value);
    if (!vrms.length){
      alert("Cargá al menos un VRM (site • nombre • IP)");
      return;
    }
    const payload = {
      vrms,
      user: userInput.value || "srvadmin",
      pass: passInput.value || ""
    };

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

  filterName.addEventListener("input", updateCamerasTable);
  filterIp.addEventListener("input", updateCamerasTable);
  btnExportCams.addEventListener("click", () => window.open("/api/export/cameras.csv", "_blank"));
  btnExportVrms.addEventListener("click", () => window.open("/api/export/vrms.csv", "_blank"));
})();