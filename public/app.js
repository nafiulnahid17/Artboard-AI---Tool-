const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STORAGE_KEY = "artboard-ai-project-id";
const DEFAULT_FORMATS = ["eps", "svg", "pdf"];

const state = {
  engine: null,
  ready: false,
  connectionError: null,
  project: null,
  projectId: localStorage.getItem(STORAGE_KEY) || null,
  projectName: "Untitled Artboard",
  file: null,
  previewUrl: null,
  naturalWidth: 0,
  naturalHeight: 0,
  stage: "upload",
  cornerMode: "auto",
  corners: [],
  aiReconstruction: true,
  job: null,
  busy: false,
  lastExportResult: null,
  selectedFormats: new Set(DEFAULT_FORMATS),
};

const steps = [
  ["upload", "Upload", "Source artwork"],
  ["prepare", "Prepare", "Surface + geometry"],
  ["production", "Reconstruct", "AI + vector core"],
  ["validation", "Validate", "Fidelity + integrity"],
  ["export", "Export", "Production files"],
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function jsonText(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function toast(message, type = "normal") {
  const node = $("#toast");
  node.textContent = message;
  node.className = type === "error" ? "show error" : "show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = "";
  }, 3400);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "Size unavailable";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 ** 2).toFixed(2) + " MB";
}

function statusBadge(label, tone = "") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function humanState(value) {
  return String(value || "Unavailable").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function errorFromPayload(payload, fallback = "Request failed") {
  return payload?.error?.message || payload?.detail?.message || payload?.detail || fallback;
}

async function request(path, options = {}) {
  const response = await fetch("/gateway" + path, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(options.headers || {}),
    },
  });

  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : null;

  if (!response.ok) {
    const error = new Error(errorFromPayload(payload, `Request failed with status ${response.status}`));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function refreshHealth() {
  try {
    const [health, ready] = await Promise.all([
      request("/health"),
      request("/ready"),
    ]);
    state.engine = health;
    state.ready = ready?.status === "ready";
    state.connectionError = state.ready ? null : "Engine readiness check did not pass.";
  } catch (error) {
    state.engine = null;
    state.ready = false;
    state.connectionError = error.message;
  }
}

function fidelity(project = state.project) {
  return project?.validation?.production_fidelity || project?.surface?.validation?.production_fidelity || null;
}

function deriveStage(project = state.project) {
  if (!project) return "upload";
  const current = String(project.state || "");
  if (current === "CREATED") return "upload";
  if (current === "UPLOADED" || current === "ANALYZED" || current === "GEOMETRY_CORRECTED") return "prepare";
  if (["SEGMENTED", "RECONSTRUCTED", "VECTORIZED", "OPTIMIZED", "COMPOSED"].includes(current)) return "production";
  if (current === "READY") {
    const grade = fidelity(project);
    if (grade?.status === "REVIEW_REQUIRED") return "validation";
    return project.true_vector_ready ? "export" : "validation";
  }
  if (current === "FAILED") return "validation";
  return state.stage || "upload";
}

async function loadProject(projectId = state.projectId, { quiet = false } = {}) {
  if (!projectId) return null;
  try {
    const project = await request(`/api/artboard/projects/${encodeURIComponent(projectId)}`);
    state.project = project;
    state.projectId = project.project_id;
    state.projectName = project.name || state.projectName;
    localStorage.setItem(STORAGE_KEY, state.projectId);
    if (!state.busy) state.stage = deriveStage(project);
    if (!quiet) render();
    return project;
  } catch (error) {
    if (error.status === 404) {
      localStorage.removeItem(STORAGE_KEY);
      state.projectId = null;
      state.project = null;
      state.stage = "upload";
    }
    if (!quiet) {
      toast(error.message, "error");
      render();
    }
    return null;
  }
}

function resetLocalProject() {
  state.project = null;
  state.projectId = null;
  state.file = null;
  state.corners = [];
  state.cornerMode = "auto";
  state.job = null;
  state.busy = false;
  state.lastExportResult = null;
  state.stage = "upload";
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  localStorage.removeItem(STORAGE_KEY);
  render();
}

async function createProject() {
  const project = await request("/api/artboard/projects", {
    method: "POST",
    body: JSON.stringify({
      name: state.projectName.trim() || "Untitled Artboard",
    }),
  });
  state.project = project;
  state.projectId = project.project_id;
  localStorage.setItem(STORAGE_KEY, state.projectId);
  return project;
}

async function uploadFile(file) {
  if (!state.ready) {
    toast("The production engine is not ready.", "error");
    return;
  }
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    toast("Upload a JPEG, PNG or WEBP jersey image.", "error");
    return;
  }

  state.busy = true;
  state.file = file;
  state.corners = [];
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  render();

  try {
    if (!state.project || state.project.state !== "CREATED") {
      state.project = null;
      state.projectId = null;
      localStorage.removeItem(STORAGE_KEY);
      await createProject();
    }

    const form = new FormData();
    form.append("project_id", state.projectId);
    form.append("file", file, file.name);
    const project = await request("/api/artboard/upload", {
      method: "POST",
      body: form,
    });

    state.project = project;
    state.projectName = project.name || state.projectName;
    state.stage = "prepare";
    toast("Artwork uploaded to the production engine.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.busy = false;
    render();
  }
}

function jobEventText(job) {
  const event = job?.process_event;
  if (!event) return null;
  return event.message || event.stage || event.event || event.type || null;
}

async function pollJob(jobId, onSuccess) {
  while (state.busy && state.job?.job_id === jobId) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    let job;
    try {
      job = await request(`/api/artboard/jobs/${encodeURIComponent(jobId)}`);
    } catch (error) {
      state.busy = false;
      toast(error.message, "error");
      render();
      return;
    }
    state.job = job;
    render();

    if (job.status === "completed") {
      state.busy = false;
      await loadProject(job.project_id, { quiet: true });
      if (onSuccess) await onSuccess(job);
      state.job = job;
      render();
      return;
    }

    if (job.status === "failed" || job.status === "cancelled") {
      state.busy = false;
      const message = job.error?.message || (job.status === "cancelled" ? "Processing cancelled." : "Processing failed.");
      toast(message, job.status === "failed" ? "error" : "normal");
      await loadProject(job.project_id, { quiet: true });
      render();
      return;
    }
  }
}

async function startJob(path, body, onSuccess) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const job = await request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.job = job;
    render();
    pollJob(job.job_id, onSuccess);
  } catch (error) {
    state.busy = false;
    toast(error.message, "error");
    render();
  }
}

async function prepareArtboard() {
  if (!state.projectId) return;
  if (state.cornerMode === "manual" && state.corners.length !== 4) {
    toast("Select exactly four surface corners before manual preparation.", "error");
    return;
  }
  const body = {
    project_id: state.projectId,
    auto: state.cornerMode === "auto",
    surface: "front_body",
    width_in: 22,
    height_in: 31,
  };
  if (state.cornerMode === "manual") body.corners = state.corners;

  await startJob("/api/artboard/prepare", body, async () => {
    state.stage = "production";
    toast("Front Body surface prepared at the 22 × 31 production aspect.");
  });
}

async function runProduction() {
  if (!state.projectId) return;
  await startJob(
    "/api/artboard/production",
    {
      project_id: state.projectId,
      ai_reconstruction: state.aiReconstruction,
    },
    async job => {
      const grade = fidelity();
      if (grade?.status === "REVIEW_REQUIRED") {
        state.stage = "validation";
        toast("Vector integrity passed; fidelity review is required.");
      } else if (state.project?.true_vector_ready) {
        state.stage = "export";
        toast("Production vector validated and ready for export.");
      } else {
        state.stage = "validation";
        toast(job.result?.status === "READY" ? "Production processing completed." : "Validation requires review.");
      }
    },
  );
}

async function exportFiles() {
  if (!state.projectId || !state.selectedFormats.size) {
    toast("Select at least one export format.", "error");
    return;
  }
  await startJob(
    "/api/artboard/export",
    {
      project_id: state.projectId,
      formats: [...state.selectedFormats],
      bundle: "selected_files",
    },
    async job => {
      state.lastExportResult = job.result || null;
      state.stage = "export";
      toast("Production files generated.");
    },
  );
}

async function cancelJob() {
  if (!state.job?.job_id) return;
  try {
    await request(`/api/artboard/jobs/${encodeURIComponent(state.job.job_id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    toast("Cancellation requested. Native processing stops at the next safe boundary.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function artifactUrl(storageKey) {
  if (!storageKey || !state.projectId) return null;
  const prefix = `projects/${state.projectId}/`;
  const relative = storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : storageKey;
  return `/gateway/api/artboard/projects/${encodeURIComponent(state.projectId)}/artifacts/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function sourceMeta() {
  const meta = state.project?.source_metadata || {};
  const dims = meta.original_dimensions || meta.normalized_dimensions || null;
  return {
    filename: state.file?.name || meta.original_filename || meta.filename || null,
    size: state.file?.size ?? meta.bytes ?? meta.size_bytes ?? null,
    dimensions: Array.isArray(dims) && dims.length >= 2 ? `${dims[0]} × ${dims[1]} px` : null,
  };
}

function topbar() {
  const connectionTone = state.ready ? "ready" : "error";
  const connectionLabel = state.ready ? "Engine Ready" : "Engine Offline";
  return `<header class="topbar">
    <div class="brand">
      <img src="/logo.svg" alt="">
      <div class="brand-copy">
        <strong>Artboard AI</strong>
        <span>Resolution Independent</span>
      </div>
    </div>
    <div class="project-crumb">
      <span>Production Workspace</span>
      <span>›</span>
      <strong>${escapeHtml(state.project?.name || state.projectName)}</strong>
    </div>
    <div class="topbar-right">
      <div class="engine-pill ${connectionTone}" title="${escapeHtml(state.connectionError || "Live engine connection")}">
        <span class="status-orb"></span><span class="label">${connectionLabel}</span>
      </div>
      <button class="new-project" data-action="new-project" type="button">New Artboard</button>
    </div>
  </header>`;
}

function stepper() {
  const currentIndex = steps.findIndex(([key]) => key === state.stage);
  return `<nav class="stepper" aria-label="Production workflow">
    ${steps.map(([key, title, subtitle], index) => {
      const complete = index < currentIndex;
      const active = key === state.stage;
      const accessible = Boolean(state.project) && (
        key === "upload" ||
        (key === "prepare" && state.project.state !== "CREATED") ||
        (key === "production" && ["SEGMENTED","READY"].includes(state.project.state)) ||
        (key === "validation" && Boolean(state.project.validation)) ||
        (key === "export" && state.project.state === "READY")
      );
      return `<button class="step ${active ? "active" : ""} ${complete ? "complete" : ""}"
        data-action="stage" data-stage="${key}" ${accessible || active ? "" : "disabled"} type="button">
        <span class="step-index">${complete ? "✓" : index + 1}</span>
        <span class="step-copy"><strong>${title}</strong><small>${subtitle}</small></span>
      </button>`;
    }).join("")}
  </nav>`;
}

function leftSidebar() {
  const actualAi = state.project?.ai_reconstruction;
  const aiModel = actualAi?.provider?.model || "Engine-managed model";
  const aiState = actualAi
    ? actualAi.accepted ? statusBadge("Accepted", "success") : actualAi.attempted ? statusBadge("Rejected / Fallback", "warning") : statusBadge("Not used")
    : statusBadge("Not run");

  return `<aside class="card sidebar stack">
    <div class="sidebar-title">
      <div><span class="eyebrow">Production Spec</span><h2>Front Body</h2></div>
      ${statusBadge("Locked", "purple")}
    </div>
    <div class="lock-row">
      <div class="lock-box"><span>Chest / Width</span><strong>22 in</strong><small class="muted">558.8 mm</small></div>
      <div class="lock-box"><span>Length / Height</span><strong>31 in</strong><small class="muted">787.4 mm</small></div>
    </div>
    <div class="lock-box"><span>300 DPI Proof Equivalent</span><strong>6600 × 9300 px</strong><small class="muted">Final vector remains resolution independent.</small></div>
    <div class="divider"></div>
    <span class="eyebrow">Reconstruction</span>
    <div class="toggle-row">
      <div class="toggle-copy"><strong>AI Reconstruction</strong><small>Identity-gated guidance</small></div>
      <label class="switch">
        <input id="ai-reconstruction" type="checkbox" ${state.aiReconstruction ? "checked" : ""} ${state.busy ? "disabled" : ""}>
        <span></span>
      </label>
    </div>
    <div class="engine-model">
      <div class="row between"><strong>AI route</strong>${aiState}</div>
      <small class="muted">${escapeHtml(aiModel)}</small>
    </div>
    <div class="divider"></div>
    <span class="eyebrow">Vector Contract</span>
    <div class="inspector-row"><span>Preset</span><strong>ULTRA</strong></div>
    <div class="inspector-row"><span>Output</span><strong>True Vector</strong></div>
    <div class="inspector-row"><span>Embedded raster</span><strong>0 required</strong></div>
    <div class="inspector-row"><span>Print export</span><strong>CMYK EPS / PDF</strong></div>
  </aside>`;
}

function uploadStage() {
  const meta = sourceMeta();
  if (state.busy && !state.job) {
    return `<div class="processing"><div class="processing-core">
      <div class="processing-ring"></div>
      <div><h2>Uploading artwork</h2><p class="muted">Sending the original source to the production engine.</p></div>
    </div></div>`;
  }

  return `<div class="stack">
    <div class="row between wrap">
      <div><span class="eyebrow">Source Artwork</span><h2>Upload jersey front artwork</h2></div>
      ${state.project ? statusBadge(humanState(state.project.state), state.project.state === "UPLOADED" ? "success" : "") : ""}
    </div>
    ${state.project?.source_metadata && meta.filename ? `<div class="upload-file-card">
      <div class="upload-thumb">${state.previewUrl ? `<img src="${state.previewUrl}" alt="Uploaded jersey artwork">` : "<span class=\"muted small\">Local preview unavailable</span>"}</div>
      <div class="upload-details">
        <strong>${escapeHtml(meta.filename)}</strong>
        <span class="small muted">${[meta.size ? formatBytes(meta.size) : null, meta.dimensions].filter(Boolean).join(" • ") || "Stored in engine"}</span>
        ${statusBadge("Artwork uploaded", "success")}
        <div class="row wrap"><button data-action="choose-file" type="button">Replace with New Artboard</button><button class="primary" data-action="stage" data-stage="prepare" type="button">Continue to Prepare</button></div>
      </div>
    </div>` : `<div class="upload-zone" id="upload-zone">
      <div class="upload-inner">
        <div class="upload-icon">↥</div>
        <div><h2>Drop a jersey photo here</h2><p class="muted">JPEG, PNG or WEBP. Use the clearest available front-body photo for the best production reconstruction.</p></div>
        <button class="primary" data-action="choose-file" type="button">Choose Artwork</button>
        <span class="small muted">No demo image is loaded. The workspace starts only from your real upload.</span>
      </div>
    </div>`}
    ${!state.project ? `<label class="field">Art name
      <input id="project-name" maxlength="120" value="${escapeHtml(state.projectName)}" placeholder="Untitled Artboard">
    </label>` : ""}
  </div>`;
}

function manualCornerOverlay() {
  if (!state.previewUrl) return "";
  const points = state.corners.map(([x,y]) => {
    const left = state.naturalWidth ? x / state.naturalWidth * 100 : 0;
    const top = state.naturalHeight ? y / state.naturalHeight * 100 : 0;
    return { x, y, left, top };
  });
  const polygon = points.map(p => `${p.left},${p.top}`).join(" ");
  return `<div id="corner-layer" class="corner-layer" aria-label="Manual four-corner selector">
    ${points.length >= 2 ? `<svg class="corner-svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${polygon}"></polygon></svg>` : ""}
    ${points.map((p,i) => `<button class="corner-dot" type="button" style="left:${p.left}%;top:${p.top}%" title="Corner ${i+1}" aria-label="Corner ${i+1}"></button>`).join("")}
    <div class="corner-help">${points.length < 4 ? `Select corner ${points.length + 1} of 4` : "Four corners selected. Run manual preparation or reset."}</div>
  </div>`;
}

function prepareStage() {
  const geometry = state.project?.geometry || {};
  return `<div class="stack">
    <div class="row between wrap">
      <div><span class="eyebrow">Surface Preparation</span><h2>Detect and flatten Front Body</h2></div>
      ${geometry.method ? statusBadge(humanState(geometry.method), "purple") : ""}
    </div>
    <div class="mode-tabs">
      <button data-action="corner-mode" data-mode="auto" class="${state.cornerMode === "auto" ? "selected" : ""}" type="button">Auto Detect</button>
      <button data-action="corner-mode" data-mode="manual" class="${state.cornerMode === "manual" ? "selected" : ""}" type="button" ${state.previewUrl ? "" : "disabled"}>Manual 4 Corners</button>
    </div>
    <div class="image-stage">
      ${state.previewUrl ? `<div class="image-wrap">
        <img id="source-image" src="${state.previewUrl}" alt="Uploaded jersey source">
        ${state.cornerMode === "manual" ? manualCornerOverlay() : ""}
      </div>` : `<div class="upload-inner"><div class="upload-icon">◎</div><h2>Source is stored in the engine</h2><p class="muted">This browser session no longer has the local image preview. Auto Detect remains available. Re-upload as a new artboard if you need manual corner selection.</p></div>`}
    </div>
    ${state.cornerMode === "auto"
      ? `<p class="small muted">The engine will use AI surface analysis when configured and confidence-gated, then deterministic geometry rectification to the exact 22:31 physical artboard ratio.</p>`
      : `<p class="small muted">Click the four visible Front Body corners. Corner order does not need to be exact; the geometry engine validates and orders the quadrilateral.</p>`}
    <div class="action-bar">
      <div class="row">
        <button data-action="stage" data-stage="upload" type="button">Back</button>
        ${state.cornerMode === "manual" ? `<button data-action="reset-corners" type="button">Reset Corners</button>` : ""}
      </div>
      <button class="primary" data-action="prepare" type="button" ${!state.ready || state.busy || (state.cornerMode === "manual" && state.corners.length !== 4) ? "disabled" : ""}>
        ${state.cornerMode === "auto" ? "Analyze & Flatten" : "Flatten Selected Surface"}
      </button>
    </div>
  </div>`;
}

function processingStage() {
  const job = state.job;
  const eventText = jobEventText(job);
  return `<div class="processing"><div class="processing-core">
    <div class="processing-ring"></div>
    <div>
      <span class="eyebrow">${escapeHtml(job?.stage || "Production Job")}</span>
      <h2>${job?.status === "queued" ? "Queued for processing" : "Processing real artwork"}</h2>
      <p class="muted">${escapeHtml(eventText || "The engine is working. Progress is shown only when the backend reports a stage event.")}</p>
    </div>
    <div class="timeline">
      <div class="timeline-row"><span class="dot" style="color:${job?.status === "queued" ? "#a26813" : "#6d3dee"}"></span><div><strong>Job State</strong><div class="small muted">${escapeHtml(humanState(job?.job_state || job?.status || "Starting"))}</div></div></div>
      ${eventText ? `<div class="timeline-row"><span class="dot" style="color:#147c56"></span><div><strong>Engine Event</strong><div class="small muted">${escapeHtml(eventText)}</div></div></div>` : ""}
    </div>
    <button data-action="cancel-job" type="button">Cancel at Safe Boundary</button>
  </div></div>`;
}

function productionStage() {
  const ai = state.project?.ai_reconstruction;
  return `<div class="stack">
    <div class="row between wrap">
      <div><span class="eyebrow">Artwork Reconstruction</span><h2>Create production vector</h2></div>
      ${state.project?.surface ? statusBadge("Front Body prepared", "success") : statusBadge("Preparation required", "warning")}
    </div>
    <div class="report-banner ${state.aiReconstruction ? "success" : "warning"}">
      <div class="report-icon">✦</div>
      <div><strong>${state.aiReconstruction ? "Identity-gated AI reconstruction enabled" : "Deterministic reconstruction only"}</strong>
      <p class="small">${state.aiReconstruction
        ? "The image model can guide low-frequency fold and lighting cleanup only after structural/color drift gates. Generated geometry and chroma are not copied into the production vector."
        : "AI cleanup guidance is disabled. The deterministic reconstruction and ULTRA vector pipeline will still run."}</p></div>
    </div>
    <div class="validation-grid">
      <div class="metric"><span>Surface</span><strong>Front Body</strong></div>
      <div class="metric"><span>Physical Artboard</span><strong>22 × 31 in</strong></div>
      <div class="metric"><span>Trace Preset</span><strong>ULTRA</strong></div>
      <div class="metric"><span>Raster Policy</span><strong>0 embedded</strong></div>
    </div>
    ${ai ? `<div class="engine-model"><div class="row between"><strong>Previous AI reconstruction</strong>${ai.accepted ? statusBadge("Accepted","success") : ai.attempted ? statusBadge("Rejected","warning") : statusBadge("Not used")}</div><small class="muted">${escapeHtml(ai.provider?.model || "No provider model recorded")}</small></div>` : ""}
    <div class="action-bar">
      <button data-action="stage" data-stage="prepare" type="button">Back to Surface</button>
      <button class="primary" data-action="production" type="button" ${state.busy || state.project?.state !== "SEGMENTED" ? "disabled" : ""}>Create Production Vector</button>
    </div>
  </div>`;
}

function validationStage() {
  const project = state.project;
  const report = project?.validation || {};
  const artboard = report.artboard || project?.surface?.validation?.physical_artboard || {};
  const grade = fidelity(project);
  const trueVector = Boolean(project?.true_vector_ready);
  const status = trueVector && grade?.status !== "REVIEW_REQUIRED" ? "success" : grade?.status === "REVIEW_REQUIRED" ? "warning" : "error";
  const headline = trueVector
    ? grade?.status === "REVIEW_REQUIRED" ? "Vector passed. Visual fidelity needs review." : "Production vector passed."
    : "Production validation is not complete.";

  const checks = grade?.checks || {};
  return `<div class="stack">
    <div><span class="eyebrow">Validation</span><h2>Production integrity & fidelity</h2></div>
    <div class="report-banner ${status}">
      <div class="report-icon">${status === "success" ? "✓" : status === "warning" ? "!" : "×"}</div>
      <div><strong>${escapeHtml(headline)}</strong><p class="small">${trueVector ? "File integrity and visual fidelity are reported separately." : "Review the engine result before export."}</p></div>
    </div>
    <div class="validation-grid">
      <div class="metric"><span>True Vector Ready</span><strong>${trueVector ? "Yes" : "No"}</strong></div>
      <div class="metric"><span>Embedded Rasters</span><strong>${artboard.embedded_rasters ?? "Not reported"}</strong></div>
      <div class="metric"><span>Physical Size</span><strong>${artboard.width_in && artboard.height_in ? `${artboard.width_in} × ${artboard.height_in} in` : "Not reported"}</strong></div>
      <div class="metric"><span>Vector Paths</span><strong>${artboard.path_count ?? report.path_count ?? "Not reported"}</strong></div>
      <div class="metric"><span>Fidelity Grade</span><strong>${escapeHtml(grade?.status || "Not reported")}</strong></div>
      <div class="metric"><span>Aspect Distortion</span><strong>${artboard.nonuniform_scaling_allowed === false ? "Blocked" : "Not reported"}</strong></div>
    </div>
    ${grade ? `<div class="engine-model">
      <div class="row between"><strong>Automated fidelity checks</strong>${statusBadge(grade.status, grade.status === "PASS" ? "success" : "warning")}</div>
      <div class="inspector-row"><span>SSIM</span><strong>${checks.ssim ? "PASS" : "REVIEW"}</strong></div>
      <div class="inspector-row"><span>Edge overlap</span><strong>${checks.edge_iou ? "PASS" : "REVIEW"}</strong></div>
      <div class="inspector-row"><span>Color ΔE</span><strong>${checks.color_delta_e ? "PASS" : "REVIEW"}</strong></div>
      <div class="inspector-row"><span>Trace backend</span><strong>${checks.trace_backend ? "PASS" : "REVIEW"}</strong></div>
    </div>` : ""}
    ${project?.warnings?.length ? `<div class="warning-list">${project.warnings.map(w => `<div class="warning-item">${escapeHtml(w)}</div>`).join("")}</div>` : ""}
    <div class="action-bar">
      <button data-action="report" data-report="validation" type="button">View Full Report</button>
      <div class="row">
        <button data-action="stage" data-stage="production" type="button">Back</button>
        <button class="primary" data-action="stage" data-stage="export" type="button" ${project?.state === "READY" ? "" : "disabled"}>${grade?.status === "REVIEW_REQUIRED" ? "Continue to Export" : "Export Files"}</button>
      </div>
    </div>
  </div>`;
}

function downloadEntries() {
  const entries = [];
  const surfaceExports = state.project?.surface?.exports || {};
  for (const [format, key] of Object.entries(surfaceExports)) {
    if (!key) continue;
    entries.push({ format, key });
  }
  return entries;
}

function exportStage() {
  const downloads = downloadEntries();
  return `<div class="stack">
    <div class="row between wrap"><div><span class="eyebrow">Production Export</span><h2>Generate editable deliverables</h2></div>${state.project?.true_vector_ready ? statusBadge("Validated vector","success") : statusBadge("Validation required","warning")}</div>
    <p class="muted">Every download below is created by the engine from the validated Front Body vector. Native AI format is intentionally not advertised because the engine does not generate a native .ai file.</p>
    <div class="export-grid">
      ${[
        ["eps","EPS","Illustrator/Corel production"],
        ["svg","SVG","Fully editable vector"],
        ["pdf","PDF","CMYK production PDF"],
        ["png","PNG","300 DPI proof render"],
      ].map(([value,title,sub]) => `<label class="format-card">
        <input type="checkbox" data-format="${value}" ${state.selectedFormats.has(value) ? "checked" : ""} ${state.busy ? "disabled" : ""}>
        <span class="format-icon">${title}</span>
        <span><strong>${title}</strong><small class="muted" style="display:block;margin-top:3px">${sub}</small></span>
      </label>`).join("")}
    </div>
    <button class="primary full" data-action="export" type="button" ${!state.project?.true_vector_ready || state.busy || !state.selectedFormats.size ? "disabled" : ""}>Generate Selected Production Files</button>
    ${downloads.length ? `<div class="divider"></div><div><span class="eyebrow">Ready Downloads</span><h3 style="margin-top:4px">Current project files</h3></div><div class="download-list">
      ${downloads.map(({format,key}) => `<div class="download-row"><div><strong>${format.toUpperCase()}</strong><div class="small muted">Generated from validated Front Body vector</div></div><a href="${artifactUrl(key)}" download>Download ${format.toUpperCase()}</a></div>`).join("")}
    </div>` : ""}
    <div class="action-bar">
      <button data-action="stage" data-stage="validation" type="button">Validation</button>
      <button data-action="report" data-report="project" type="button">Project Report</button>
    </div>
  </div>`;
}

function mainStage() {
  if (state.busy && state.job) return processingStage();
  if (state.stage === "upload") return uploadStage();
  if (state.stage === "prepare") return prepareStage();
  if (state.stage === "production") return productionStage();
  if (state.stage === "validation") return validationStage();
  return exportStage();
}

function inspector() {
  const project = state.project;
  const artboard = project?.artboard || {};
  const geometry = project?.geometry || {};
  const ai = project?.ai_reconstruction;
  const grade = fidelity(project);
  return `<aside class="card inspector stack">
    <div class="inspector-block">
      <span class="eyebrow">Live Project</span>
      ${project ? `
        <div class="inspector-row"><span>State</span><strong>${escapeHtml(humanState(project.state))}</strong></div>
        <div class="inspector-row"><span>Project ID</span><strong title="${escapeHtml(project.project_id)}">${escapeHtml(project.project_id.slice(0,8))}…</strong></div>
        <div class="inspector-row"><span>Surface</span><strong>${escapeHtml(project.surface?.name || artboard.surface || "Not prepared")}</strong></div>
        <div class="inspector-row"><span>Artboard</span><strong>${artboard.width_in && artboard.height_in ? `${artboard.width_in} × ${artboard.height_in} in` : "Not prepared"}</strong></div>
      ` : `<div class="empty-inspector">No engine project exists yet. Upload a real source artwork to create one.</div>`}
    </div>
    <div class="divider"></div>
    <div class="inspector-block">
      <span class="eyebrow">Engine</span>
      <div class="inspector-row"><span>Status</span><strong>${state.ready ? "Ready" : "Unavailable"}</strong></div>
      <div class="inspector-row"><span>Version</span><strong>${escapeHtml(state.engine?.version || "Not reported")}</strong></div>
      <div class="inspector-row"><span>Default artboard</span><strong>${escapeHtml(state.engine?.default_artboard || "Not reported")}</strong></div>
    </div>
    ${geometry.method ? `<div class="divider"></div><div class="inspector-block">
      <span class="eyebrow">Geometry</span>
      <div class="inspector-row"><span>Method</span><strong>${escapeHtml(humanState(geometry.method))}</strong></div>
      <div class="inspector-row"><span>Aspect rectified</span><strong>${geometry.aspect_rectified === true ? "Yes" : geometry.aspect_rectified === false ? "No" : "Not reported"}</strong></div>
    </div>` : ""}
    ${ai ? `<div class="divider"></div><div class="inspector-block">
      <span class="eyebrow">AI Reconstruction</span>
      <div class="inspector-row"><span>Attempted</span><strong>${ai.attempted ? "Yes" : "No"}</strong></div>
      <div class="inspector-row"><span>Accepted</span><strong>${ai.accepted ? "Yes" : "No"}</strong></div>
      <div class="inspector-row"><span>Model</span><strong>${escapeHtml(ai.provider?.model || "Not reported")}</strong></div>
    </div>` : ""}
    ${grade ? `<div class="divider"></div><div class="inspector-block">
      <span class="eyebrow">Fidelity</span>
      <div class="inspector-row"><span>Grade</span><strong>${escapeHtml(grade.status)}</strong></div>
      <div class="inspector-row"><span>Advisory</span><strong>${grade.advisory ? "Yes" : "No"}</strong></div>
    </div>` : ""}
  </aside>`;
}

function heroCard() {
  return `<section class="card hero-card">
    <div class="hero-title">
      <span class="eyebrow">Artboard AI Production Engine</span>
      <h1>Photo → exact production artboard</h1>
      <p>Reconstruct one visible jersey Front Body into a resolution-independent, editable 22 × 31 inch vector artboard with measured validation before export.</p>
    </div>
    <div class="hero-meta">
      ${statusBadge("22 × 31 in", "purple")}
      ${statusBadge("True Vector")}
      ${statusBadge("CMYK EPS/PDF")}
    </div>
  </section>`;
}

function render() {
  $("#app").innerHTML = `${topbar()}${stepper()}<main class="workspace">
    ${leftSidebar()}
    <div class="main-column">
      ${heroCard()}
      <section class="card stage-card">${mainStage()}</section>
    </div>
    ${inspector()}
  </main>`;
  attachStageSpecificEvents();
}

function attachStageSpecificEvents() {
  const image = $("#source-image");
  if (image) {
    const syncSize = () => {
      state.naturalWidth = image.naturalWidth || state.naturalWidth;
      state.naturalHeight = image.naturalHeight || state.naturalHeight;
    };
    if (image.complete) syncSize();
    else image.addEventListener("load", syncSize, { once: true });
  }

  const layer = $("#corner-layer");
  if (layer) {
    layer.addEventListener("click", event => {
      if (event.target.closest(".corner-dot") || state.corners.length >= 4) return;
      const imageNode = $("#source-image");
      if (!imageNode?.naturalWidth || !imageNode?.naturalHeight) return;
      const rect = layer.getBoundingClientRect();
      const x = Math.max(0, Math.min(imageNode.naturalWidth, (event.clientX - rect.left) / rect.width * imageNode.naturalWidth));
      const y = Math.max(0, Math.min(imageNode.naturalHeight, (event.clientY - rect.top) / rect.height * imageNode.naturalHeight));
      state.corners.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      render();
    });
  }

  const uploadZone = $("#upload-zone");
  if (uploadZone) {
    for (const name of ["dragenter","dragover"]) {
      uploadZone.addEventListener(name, event => {
        event.preventDefault();
        uploadZone.classList.add("drag");
      });
    }
    for (const name of ["dragleave","drop"]) {
      uploadZone.addEventListener(name, event => {
        event.preventDefault();
        uploadZone.classList.remove("drag");
      });
    }
    uploadZone.addEventListener("drop", event => {
      const file = event.dataTransfer?.files?.[0];
      if (file) uploadFile(file);
    });
  }
}

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "choose-file") {
    $("#file-input").click();
    return;
  }
  if (action === "new-project") {
    resetLocalProject();
    return;
  }
  if (action === "stage") {
    state.stage = button.dataset.stage;
    render();
    return;
  }
  if (action === "corner-mode") {
    state.cornerMode = button.dataset.mode;
    state.corners = [];
    render();
    return;
  }
  if (action === "reset-corners") {
    state.corners = [];
    render();
    return;
  }
  if (action === "prepare") {
    await prepareArtboard();
    return;
  }
  if (action === "production") {
    await runProduction();
    return;
  }
  if (action === "export") {
    await exportFiles();
    return;
  }
  if (action === "cancel-job") {
    await cancelJob();
    return;
  }
  if (action === "report") {
    const kind = button.dataset.report;
    const title = kind === "validation" ? "Validation Report" : "Project Report";
    const data = kind === "validation" ? state.project?.validation : state.project;
    $("#dialog-title").textContent = title;
    $("#dialog-body").innerHTML = `<pre class="json">${escapeHtml(jsonText(data))}</pre>`;
    $("#details-dialog").showModal();
  }
});

document.addEventListener("change", event => {
  if (event.target.id === "ai-reconstruction") {
    state.aiReconstruction = event.target.checked;
  }
  if (event.target.matches("[data-format]")) {
    const format = event.target.dataset.format;
    if (event.target.checked) state.selectedFormats.add(format);
    else state.selectedFormats.delete(format);
    render();
  }
});

document.addEventListener("input", event => {
  if (event.target.id === "project-name") {
    state.projectName = event.target.value;
  }
});

$("#file-input").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (file) uploadFile(file);
  event.target.value = "";
});

$("#dialog-close").addEventListener("click", () => $("#details-dialog").close());

async function boot() {
  await refreshHealth();
  if (state.projectId && state.ready) {
    await loadProject(state.projectId, { quiet: true });
  }
  state.stage = deriveStage();
  render();
}

boot();
