import { applyChannelOrder, clamp, defaultVisibleChannelIds, formatDuration, moveChannelInOrder, ZOOM_WINDOWS, DEFAULT_ZOOM_SECONDS } from "./domain/channels.js?v=20260522-alpha-sidebar";
import { EdfWorkerClient } from "./edf/edfClient.js";
import { importScoring } from "./scoring/importers.js?v=20260522-xdf";
import { loadPreferences, savePreferences } from "./viewer/preferences.js";
import { renderPsgCanvas } from "./viewer/canvasRenderer.js?v=20260522-yaxis";

const app = document.querySelector("#app");
const edfClient = new EdfWorkerClient();
const preferences = loadPreferences();

const state = {
  study: null,
  scoring: null,
  visibleChannelIds: preferences.visibleChannelIds || [],
  channelOrder: preferences.channelOrder || [],
  zoomSeconds: preferences.zoomSeconds || DEFAULT_ZOOM_SECONDS,
  startSeconds: 0,
  signalWindow: null,
  channelScale: preferences.channelScale || {},
  eventVisibility: preferences.eventVisibility || {},
  sidebarOpen: preferences.sidebarOpen ?? false,
  sidebarMode: preferences.sidebarMode || "channels",
  loading: false,
  warnings: [],
  error: ""
};

let canvas = null;
let renderQueued = false;
let dragStart = null;
let laneDrag = null;
let canvasRegions = [];
let sidebarScrollTop = 0;

const PLOT_LEFT = 154;
const PLOT_RIGHT_PADDING = 18;
const MANUAL_SCALE_STEP = 0.01;
const KEY_SCROLL_ANIMATION_MS = 1000;
const KEY_SCROLL_REQUEST_INTERVAL_MS = 120;

let signalRequestSerial = 0;
let keyScrollFrame = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setState(patch) {
  Object.assign(state, patch);
  queueRender();
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function rememberSidebarScroll() {
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) sidebarScrollTop = sidebar.scrollTop;
}

function restoreSidebarScroll() {
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) sidebar.scrollTop = sidebarScrollTop;
}

function visibleChannels() {
  if (!state.study) return [];
  const ids = new Set(state.visibleChannelIds);
  return orderedChannels().filter((channel) => ids.has(channel.id));
}

function orderedChannels() {
  if (!state.study) return [];
  return applyChannelOrder(state.study.channels, state.channelOrder);
}

function alphabetizedChannels() {
  if (!state.study) return [];
  return [...state.study.channels].sort((a, b) => {
    const byLabel = a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
    return byLabel || a.id - b.id;
  });
}

function formatClockAt(seconds) {
  if (!state.study?.recordingStart) return formatDuration(seconds);
  const startMs = Date.parse(state.study.recordingStart);
  if (!Number.isFinite(startMs)) return formatDuration(seconds);
  const date = new Date(startMs + seconds * 1000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function alignScoringToEdfClock(scoring = state.scoring, study = state.study) {
  if (!scoring) return null;
  const recordingStartMs = Date.parse(study?.recordingStart || "");
  const hasAbsoluteTiming = ["absolute", "excelSerial"].includes(scoring.timing?.type);
  if (!hasAbsoluteTiming || !Number.isFinite(recordingStartMs)) return scoring;
  const alignItem = (item) => {
    let absoluteUnixMs = Number.isFinite(item.absoluteUnixMs) ? item.absoluteUnixMs : null;
    if (absoluteUnixMs === null && Number.isFinite(item.sourceOnset) && item.sourceOnset > 20000) {
      absoluteUnixMs = (item.sourceOnset - 25569) * 86400 * 1000;
    }
    if (absoluteUnixMs === null && Number.isFinite(scoring.timing.originUnixMs) && Number.isFinite(item.onset)) {
      absoluteUnixMs = scoring.timing.originUnixMs + item.onset * 1000;
    }
    return absoluteUnixMs === null ? item : { ...item, onset: (absoluteUnixMs - recordingStartMs) / 1000 };
  };
  return {
    ...scoring,
    stages: scoring.stages.map(alignItem),
    events: scoring.events.map(alignItem)
  };
}

function shiftedScoring() {
  const aligned = alignScoringToEdfClock();
  return aligned;
}

function eventLabel(event) {
  return String(event.label || event.subtype || event.type || "Event").trim();
}

function eventKey(event) {
  return eventLabel(event).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
}

function eventOptions() {
  const counts = new Map();
  for (const event of state.scoring?.events || []) {
    const key = eventKey(event);
    const label = eventLabel(event);
    const existing = counts.get(key) || { key, label, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  }
  return Array.from(counts.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function visibleScoring() {
  const scoring = shiftedScoring();
  if (!scoring) return null;
  return {
    ...scoring,
    recordingStart: state.study?.recordingStart || null,
    events: scoring.events.filter((event) => state.eventVisibility[eventKey(event)] !== false)
  };
}

function persistPreferences() {
  savePreferences({
    visibleChannelIds: state.visibleChannelIds,
    channelOrder: state.channelOrder,
    zoomSeconds: state.zoomSeconds,
    channelScale: state.channelScale,
    eventVisibility: state.eventVisibility,
    sidebarOpen: state.sidebarOpen,
    sidebarMode: state.sidebarMode
  });
}

async function loadEdf(file) {
  setState({ loading: true, error: "", warnings: [`Loading ${file.name}`], signalWindow: null });
  try {
    const study = await edfClient.loadStudy(file);
    const visibleChannelIds = preferences.visibleChannelIds?.length ? preferences.visibleChannelIds : defaultVisibleChannelIds(study.channels);
    const channelOrder = applyChannelOrder(study.channels, preferences.channelOrder).map((channel) => channel.id);
    setState({
      study,
      channelOrder,
      visibleChannelIds: visibleChannelIds.filter((id) => study.channels.some((channel) => channel.id === id)),
      startSeconds: 0,
      warnings: study.warnings,
      loading: false
    });
    persistPreferences();
    await requestWindow();
  } catch (error) {
    setState({ error: error.message, loading: false });
  }
}

async function loadScoring(file) {
  setState({ loading: true, error: "", warnings: [`Importing ${file.name}`] });
  try {
    const scoring = await importScoring(file);
    setState({
      scoring,
      warnings: scoring.warnings,
      loading: false
    });
  } catch (error) {
    setState({ error: error.message, loading: false });
  }
}

async function requestWindow() {
  const requestSerial = ++signalRequestSerial;
  if (!state.study || !canvas) return;
  const targetPixelWidth = Math.max(300, Math.floor(canvas.parentElement.getBoundingClientRect().width - 172));
  const channelIds = visibleChannels().map((channel) => channel.id);
  if (!channelIds.length) {
    if (requestSerial === signalRequestSerial) setState({ signalWindow: null });
    return;
  }
  const request = {
    channelIds,
    startSeconds: state.startSeconds,
    durationSeconds: state.zoomSeconds,
    targetPixelWidth
  };
  try {
    const result = await edfClient.readWindow(request);
    if (requestSerial !== signalRequestSerial) return;
    setState({ signalWindow: result, warnings: [...(state.study.warnings || []), ...(result.warnings || [])] });
  } catch (error) {
    if (requestSerial !== signalRequestSerial) return;
    setState({ error: error.message });
  }
}

function setStartSeconds(nextStart, { loadWindow = true } = {}) {
  if (!state.study) return;
  const maxStart = Math.max(0, state.study.duration - state.zoomSeconds);
  state.startSeconds = clamp(nextStart, 0, maxStart);
  if (loadWindow) requestWindow();
  queueRender();
}

function cancelKeyScroll() {
  if (keyScrollFrame !== null) {
    cancelAnimationFrame(keyScrollFrame);
    keyScrollFrame = null;
  }
}

function easeInOutCubic(progress) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - ((-2 * progress + 2) ** 3) / 2;
}

function scrollByWindow(direction) {
  if (!state.study) return;
  cancelKeyScroll();
  const maxStart = Math.max(0, state.study.duration - state.zoomSeconds);
  const from = state.startSeconds;
  const target = clamp(from + direction * state.zoomSeconds, 0, maxStart);
  if (target === from) return;

  let startedAt = null;
  let lastWindowRequestAt = 0;
  const step = (timestamp) => {
    if (startedAt === null) {
      startedAt = timestamp;
      lastWindowRequestAt = timestamp;
    }
    const progress = Math.min(1, (timestamp - startedAt) / KEY_SCROLL_ANIMATION_MS);
    const nextStart = from + (target - from) * easeInOutCubic(progress);
    setStartSeconds(nextStart, { loadWindow: false });

    if (timestamp - lastWindowRequestAt >= KEY_SCROLL_REQUEST_INTERVAL_MS) {
      requestWindow();
      lastWindowRequestAt = timestamp;
    }

    if (progress < 1) {
      keyScrollFrame = requestAnimationFrame(step);
      return;
    }

    keyScrollFrame = null;
    setStartSeconds(target);
  };

  keyScrollFrame = requestAnimationFrame(step);
}

function isTextEntryTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function handleNavigationKeydown(event) {
  if (isTextEntryTarget(event.target)) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    if (!event.repeat) scrollByWindow(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (event.key === "PageUp") {
    event.preventDefault();
    cancelKeyScroll();
    setStartSeconds(state.startSeconds - state.zoomSeconds);
    return;
  }
  if (event.key === "PageDown") {
    event.preventDefault();
    cancelKeyScroll();
    setStartSeconds(state.startSeconds + state.zoomSeconds);
  }
}

function setZoom(value) {
  cancelKeyScroll();
  const seconds = value === "night" ? state.study?.duration || DEFAULT_ZOOM_SECONDS : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  state.zoomSeconds = seconds;
  if (state.study) state.startSeconds = clamp(state.startSeconds, 0, Math.max(0, state.study.duration - state.zoomSeconds));
  persistPreferences();
  requestWindow();
  queueRender();
}

function toggleChannel(id, checked) {
  rememberSidebarScroll();
  const ids = new Set(state.visibleChannelIds);
  if (checked) ids.add(id);
  else ids.delete(id);
  state.visibleChannelIds = orderedChannels().map((channel) => channel.id).filter((id) => ids.has(id));
  persistPreferences();
  requestWindow();
  queueRender();
}

function clearSelectedChannels() {
  rememberSidebarScroll();
  state.visibleChannelIds = [];
  persistPreferences();
  requestWindow();
  queueRender();
}

function reorderChannel(draggedId, targetId) {
  if (!state.study) return;
  if (targetId !== null && targetId !== undefined && Number(draggedId) === Number(targetId)) return;
  rememberSidebarScroll();
  state.channelOrder = moveChannelInOrder(state.study.channels, state.channelOrder, draggedId, targetId);
  const visible = new Set(state.visibleChannelIds);
  state.visibleChannelIds = state.channelOrder.filter((id) => visible.has(id));
  persistPreferences();
  requestWindow();
  queueRender();
}

function channelRegions() {
  return canvasRegions
    .filter((region) => region.kind === "channel")
    .sort((a, b) => a.y - b.y);
}

function channelRegionAt(event) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return channelRegions().find((region) =>
    x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height
  ) || null;
}

function channelDropTargetAt(event) {
  if (!canvas) return { beforeId: null, y: 0 };
  const rect = canvas.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const regions = channelRegions();
  const target = regions.find((region) => y < region.y + region.height / 2);
  if (target) return { beforeId: target.item.id, y: target.y };
  const last = regions[regions.length - 1];
  return {
    beforeId: null,
    y: last ? last.y + last.height : 0
  };
}

function showLaneDropIndicator(y) {
  const indicator = document.querySelector("#lane-drop-indicator");
  if (!indicator) return;
  indicator.classList.remove("hidden");
  indicator.style.top = `${Math.max(0, y)}px`;
}

function hideLaneDropIndicator() {
  document.querySelector("#lane-drop-indicator")?.classList.add("hidden");
}

function updateScale(channelId, patch) {
  rememberSidebarScroll();
  state.channelScale[channelId] = { mode: "auto", ...(state.channelScale[channelId] || {}), ...patch };
  persistPreferences();
  queueRender();
}

function updateScaleDraft(channelId, patch) {
  rememberSidebarScroll();
  state.channelScale[channelId] = { mode: "manual", ...(state.channelScale[channelId] || {}), ...patch };
}

function commitScaleDraft() {
  persistPreferences();
  queueRender();
}

function scaleDefaults(channelId) {
  const channelWindow = state.signalWindow?.channels.find((candidate) => candidate.channelId === channelId);
  const visibleMin = channelWindow?.visibleMin ?? 0;
  const visibleMax = channelWindow?.visibleMax ?? 1;
  return {
    range: Math.max(0.01, visibleMax - visibleMin),
    center: (visibleMax + visibleMin) / 2
  };
}

function scaleNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nudgeScale(channelId, field, delta) {
  const defaults = scaleDefaults(channelId);
  const current = { mode: "manual", ...(state.channelScale[channelId] || {}) };
  const fallback = field === "range" ? defaults.range : defaults.center;
  const next = field === "range"
    ? Math.max(MANUAL_SCALE_STEP, scaleNumber(current.range, fallback) + delta)
    : scaleNumber(current.center, fallback) + delta;
  updateScale(channelId, { mode: "manual", [field]: next.toFixed(2) });
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  persistPreferences();
  queueRender();
  requestAnimationFrame(() => requestWindow());
}

function openSidebar(mode) {
  state.sidebarMode = mode;
  state.sidebarOpen = true;
  persistPreferences();
  queueRender();
  requestAnimationFrame(() => requestWindow());
}

function toggleEventVisibility(key, checked) {
  rememberSidebarScroll();
  state.eventVisibility = { ...state.eventVisibility, [key]: checked };
  persistPreferences();
  queueRender();
}

function setAllEventsVisible(visible) {
  rememberSidebarScroll();
  const next = {};
  for (const option of eventOptions()) next[option.key] = visible;
  state.eventVisibility = next;
  persistPreferences();
  queueRender();
}

function findHoverRegion(event) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  for (let index = canvasRegions.length - 1; index >= 0; index -= 1) {
    const region = canvasRegions[index];
    if (x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height) {
      return region;
    }
  }
  return null;
}

function showTooltip(event, region) {
  const tooltip = document.querySelector("#canvas-tooltip");
  if (!tooltip || !region) return;
  tooltip.textContent = region.label;
  tooltip.classList.remove("hidden");
  tooltip.style.left = `${event.clientX + 12}px`;
  tooltip.style.top = `${event.clientY + 12}px`;
}

function hideTooltip() {
  document.querySelector("#canvas-tooltip")?.classList.add("hidden");
}

function hideTimeCursor() {
  document.querySelector("#time-cursor")?.classList.add("hidden");
}

function updateTimeCursor(event) {
  if (!canvas || !state.study) return;
  const rect = canvas.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, PLOT_LEFT, rect.width - PLOT_RIGHT_PADDING);
  const plotWidth = rect.width - PLOT_LEFT - PLOT_RIGHT_PADDING;
  const time = state.startSeconds + ((x - PLOT_LEFT) / Math.max(1, plotWidth)) * state.zoomSeconds;
  const cursor = document.querySelector("#time-cursor");
  const label = document.querySelector("#time-cursor-label");
  if (!cursor || !label) return;
  cursor.classList.remove("hidden");
  cursor.style.left = `${x}px`;
  label.textContent = formatClockAt(time);
}

function fileLoader() {
  const startText = state.study?.recordingStartLabel || state.study?.recordingStart || "";
  return `
    <section class="toolbar" aria-label="File loading">
      <label class="file-control">
        <span>EDF / EDF+</span>
        <input id="edf-file" type="file" accept=".edf,.EDF,.bdf,.BDF" />
      </label>
      <label class="file-control">
        <span>Scoring</span>
        <input id="scoring-file" type="file" accept=".xdf,.XDF,.rml,.RML,.xml,.XML,.xlsx,.XLSX,.xls,.XLS,.csv,.CSV,.tsv,.TSV,.txt" />
      </label>
      <div class="study-summary">
        ${state.study ? `<strong>${escapeHtml(state.study.fileName)}</strong><span>${state.study.channels.length} channels · ${formatDuration(state.study.duration)}${startText ? ` · Start ${escapeHtml(startText)}` : ""}</span>` : "<strong>No study loaded</strong><span>Files are read locally in this browser.</span>"}
      </div>
    </section>
  `;
}

function controls() {
  const maxStart = state.study ? Math.max(0, state.study.duration - state.zoomSeconds) : 0;
  return `
    <section class="controls" aria-label="Viewer controls">
      <button class="panel-toggle ${state.sidebarOpen && state.sidebarMode === "channels" ? "active" : ""}" id="show-channels" title="Show channel controls">Channels</button>
      <button class="panel-toggle ${state.sidebarOpen && state.sidebarMode === "events" ? "active" : ""}" id="show-events" title="Show event controls" ${!state.scoring ? "disabled" : ""}>Events</button>
      <div class="segmented" role="group" aria-label="Zoom window">
        ${ZOOM_WINDOWS.map((value) => {
          const active = value === "night" ? state.study && state.zoomSeconds === state.study.duration : state.zoomSeconds === value;
          const label = value === "night" ? "Night" : value < 60 ? `${value}s` : `${value / 60}m`;
          return `<button class="${active ? "active" : ""}" data-zoom="${value}" ${value === "night" && !state.study ? "disabled" : ""}>${label}</button>`;
        }).join("")}
      </div>
      <button class="icon-button" data-jump="-${state.zoomSeconds}" title="Back one window" ${!state.study ? "disabled" : ""}>←</button>
      <button class="icon-button" data-jump="${state.zoomSeconds}" title="Forward one window" ${!state.study ? "disabled" : ""}>→</button>
      <label class="timeline">
        <span>${state.study ? formatClockAt(state.startSeconds) : "0:00"}</span>
        <input id="timeline" type="range" min="0" max="${maxStart}" step="1" value="${state.startSeconds}" ${!state.study ? "disabled" : ""} />
        <span>${state.study ? formatClockAt(state.study.duration) : "0:00"}</span>
      </label>
    </section>
  `;
}

function channelPanel() {
  const channels = state.study ? alphabetizedChannels() : [];
  const visible = new Set(state.visibleChannelIds);
  if (!channels.length) {
    return `<aside class="sidebar"><div class="empty">Load an EDF file to choose channels.</div></aside>`;
  }
  return `
    <aside class="sidebar" aria-label="Channels">
      <div class="sidebar-header">
        <h2>Channels</h2>
        <span>${visible.size}/${channels.filter((channel) => !channel.isAnnotation).length}</span>
      </div>
      <div class="bulk-actions">
        <button class="mini-button" data-channels-clear ${visible.size === 0 ? "disabled" : ""}>clear all</button>
      </div>
      <div class="channel-list">
        ${channels.map((channel) => {
          const checked = visible.has(channel.id);
          const scale = { mode: "auto", range: "", center: "", ...(state.channelScale[channel.id] || {}) };
          return `
            <article class="channel-row ${channel.isAnnotation ? "muted" : ""}">
              <div class="channel-main">
                <label>
                <input type="checkbox" data-channel="${channel.id}" ${checked ? "checked" : ""} ${channel.isAnnotation ? "disabled" : ""} />
                <span>${escapeHtml(channel.label)}</span>
                </label>
              </div>
              <small>${channel.sampleRate.toFixed(channel.sampleRate >= 10 ? 0 : 1)} Hz ${channel.units ? `· ${escapeHtml(channel.units)}` : ""}</small>
              ${checked ? `
                <div class="scale-controls">
                  <div class="scale-mode" aria-label="Scale mode for ${escapeHtml(channel.label)}">
                    <span>Scale</span>
                    <button type="button" class="${scale.mode !== "manual" ? "active" : ""}" data-scale-mode="${channel.id}" data-scale-mode-value="auto">Auto</button>
                    <button type="button" class="${scale.mode === "manual" ? "active" : ""}" data-scale-mode="${channel.id}" data-scale-mode-value="manual">Manual</button>
                  </div>
                  <div class="scale-field ${scale.mode === "manual" ? "" : "disabled"}" title="Manual full-scale amplitude range">
                    <span>Range</span>
                    <div class="scale-stepper" aria-label="Manual range for ${escapeHtml(channel.label)}">
                      <button type="button" data-scale-step="${channel.id}" data-scale-field="range" data-scale-delta="-${MANUAL_SCALE_STEP}" ${scale.mode === "manual" ? "" : "disabled"}>-</button>
                      <input type="text" inputmode="decimal" value="${escapeHtml(scale.range)}" data-scale-input="${channel.id}" data-scale-field="range" ${scale.mode === "manual" ? "" : "disabled"} />
                      <button type="button" data-scale-step="${channel.id}" data-scale-field="range" data-scale-delta="${MANUAL_SCALE_STEP}" ${scale.mode === "manual" ? "" : "disabled"}>+</button>
                    </div>
                  </div>
                  <div class="scale-field ${scale.mode === "manual" ? "" : "disabled"}" title="Manual center value">
                    <span>Center</span>
                    <div class="scale-stepper" aria-label="Manual center for ${escapeHtml(channel.label)}">
                      <button type="button" data-scale-step="${channel.id}" data-scale-field="center" data-scale-delta="-${MANUAL_SCALE_STEP}" ${scale.mode === "manual" ? "" : "disabled"}>-</button>
                      <input type="text" inputmode="decimal" value="${escapeHtml(scale.center)}" data-scale-input="${channel.id}" data-scale-field="center" ${scale.mode === "manual" ? "" : "disabled"} />
                      <button type="button" data-scale-step="${channel.id}" data-scale-field="center" data-scale-delta="${MANUAL_SCALE_STEP}" ${scale.mode === "manual" ? "" : "disabled"}>+</button>
                    </div>
                  </div>
                </div>
              ` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </aside>
  `;
}

function eventsPanel() {
  const options = eventOptions();
  if (!state.scoring) {
    return `<aside class="sidebar"><div class="empty">Load a scoring file to choose events.</div></aside>`;
  }
  return `
    <aside class="sidebar" aria-label="Events">
      <div class="sidebar-header">
        <h2>Events</h2>
        <span>${options.filter((option) => state.eventVisibility[option.key] !== false).length}/${options.length}</span>
      </div>
      <div class="bulk-actions">
        <button class="mini-button" data-events-all="show">Show all</button>
        <button class="mini-button" data-events-all="hide">clear all</button>
      </div>
      <div class="channel-list">
        ${options.map((option) => `
          <article class="channel-row">
            <label>
              <input type="checkbox" data-event-key="${escapeHtml(option.key)}" ${state.eventVisibility[option.key] !== false ? "checked" : ""} />
              <span>${escapeHtml(option.label)}</span>
            </label>
            <small>${option.count} events</small>
          </article>
        `).join("")}
      </div>
    </aside>
  `;
}

function sidebarPanel() {
  return state.sidebarMode === "events" ? eventsPanel() : channelPanel();
}

function statusPanel() {
  const scoringText = state.scoring
    ? `${state.scoring.stages.length} stages · ${state.scoring.events.length} events · ${state.scoring.sourceFormat.toUpperCase()}`
    : "No scoring loaded";
  return `
    <section class="status ${state.error ? "has-error" : ""}">
      <div>${state.loading ? "Working" : "Ready"} · ${scoringText}</div>
      ${state.error ? `<strong>${escapeHtml(state.error)}</strong>` : ""}
      ${(state.warnings || []).slice(0, 5).map((warning) => `<span>${escapeHtml(warning)}</span>`).join("")}
    </section>
  `;
}

function render() {
  const restoreCanvasFocus = document.activeElement?.id === "psg-canvas";
  rememberSidebarScroll();
  app.innerHTML = `
    <main class="shell">
      <header>
        <div>
          <h1>PSG Viewer</h1>
          <p>Local EDF/EDF+ waveform review with scoring overlays.</p>
          <p class="compatibility-line">Compatible exports: Nox/Noxturnal XLS, Sleepware G3 RML, Nihon Kohden Polysmith XDF.</p>
        </div>
      </header>
      ${fileLoader()}
      ${controls()}
      <div class="workspace ${state.sidebarOpen ? "sidebar-open" : "sidebar-closed"}">
        ${state.sidebarOpen ? sidebarPanel() : ""}
        <section class="viewer">
          <div class="canvas-wrap">
            <canvas id="psg-canvas" tabindex="0" aria-label="PSG waveform viewer"></canvas>
            <div id="time-cursor" class="time-cursor hidden"><span id="time-cursor-label"></span></div>
            <div id="lane-drop-indicator" class="lane-drop-indicator hidden"></div>
            <div id="canvas-tooltip" class="canvas-tooltip hidden"></div>
          </div>
          ${statusPanel()}
        </section>
      </div>
    </main>
  `;
  bindEvents();
  restoreSidebarScroll();
  canvas = document.querySelector("#psg-canvas");
  const renderResult = renderPsgCanvas(canvas, {
    visibleChannels: visibleChannels(),
    signalWindow: state.signalWindow,
    startSeconds: state.startSeconds,
    zoomSeconds: state.zoomSeconds,
    recordingStart: state.study?.recordingStart || null,
    scoring: visibleScoring(),
    channelScale: state.channelScale
  });
  canvasRegions = renderResult.regions || [];
  if (restoreCanvasFocus) canvas.focus({ preventScroll: true });
}

function bindEvents() {
  document.querySelector("#show-channels")?.addEventListener("click", () => {
    if (state.sidebarOpen && state.sidebarMode === "channels") toggleSidebar();
    else openSidebar("channels");
  });
  document.querySelector("#show-events")?.addEventListener("click", () => {
    if (state.sidebarOpen && state.sidebarMode === "events") toggleSidebar();
    else openSidebar("events");
  });
  document.querySelector("#edf-file")?.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (file) loadEdf(file);
  });
  document.querySelector("#scoring-file")?.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (file) loadScoring(file);
  });
  document.querySelectorAll("[data-zoom]").forEach((button) => {
    button.addEventListener("click", () => setZoom(button.dataset.zoom));
  });
  document.querySelectorAll("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => {
      cancelKeyScroll();
      setStartSeconds(state.startSeconds + Number(button.dataset.jump));
    });
  });
  document.querySelector("#timeline")?.addEventListener("input", (event) => {
    cancelKeyScroll();
    setStartSeconds(Number(event.target.value));
  });
  document.querySelectorAll("[data-channel]").forEach((input) => {
    input.addEventListener("change", () => {
      rememberSidebarScroll();
      toggleChannel(Number(input.dataset.channel), input.checked);
    });
  });
  document.querySelector("[data-channels-clear]")?.addEventListener("click", () => clearSelectedChannels());
  document.querySelectorAll("[data-scale-mode]").forEach((input) => {
    input.addEventListener("click", () => {
      const channelId = Number(input.dataset.scaleMode);
      const defaults = scaleDefaults(channelId);
      updateScale(channelId, {
        mode: input.dataset.scaleModeValue === "manual" ? "manual" : "auto",
        range: defaults.range.toFixed(2),
        center: defaults.center.toFixed(2)
      });
    });
  });
  document.querySelectorAll("[data-scale-input]").forEach((input) => {
    input.addEventListener("input", () => {
      updateScaleDraft(Number(input.dataset.scaleInput), {
        mode: "manual",
        [input.dataset.scaleField]: input.value
      });
    });
    input.addEventListener("change", () => commitScaleDraft());
    input.addEventListener("blur", () => commitScaleDraft());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  });
  document.querySelectorAll("[data-scale-step]").forEach((button) => {
    button.addEventListener("click", () => {
      nudgeScale(Number(button.dataset.scaleStep), button.dataset.scaleField, Number(button.dataset.scaleDelta));
    });
  });
  document.querySelectorAll("[data-event-key]").forEach((input) => {
    input.addEventListener("change", () => toggleEventVisibility(input.dataset.eventKey, input.checked));
  });
  document.querySelectorAll("[data-events-all]").forEach((button) => {
    button.addEventListener("click", () => setAllEventsVisible(button.dataset.eventsAll === "show"));
  });
  document.querySelector(".sidebar")?.addEventListener("scroll", () => rememberSidebarScroll());
  const activeCanvas = document.querySelector("#psg-canvas");
  activeCanvas?.addEventListener("wheel", (event) => {
    if (!state.study) return;
    cancelKeyScroll();
    event.preventDefault();
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    setStartSeconds(state.startSeconds + (delta / 300) * state.zoomSeconds);
  }, { passive: false });
  activeCanvas?.addEventListener("pointerdown", (event) => {
    cancelKeyScroll();
    hideTooltip();
    const channelRegion = channelRegionAt(event);
    if (channelRegion && event.button === 0) {
      activeCanvas.setPointerCapture(event.pointerId);
      const target = channelDropTargetAt(event);
      laneDrag = {
        channelId: channelRegion.item.id,
        targetBeforeId: target.beforeId,
        pointerId: event.pointerId
      };
      activeCanvas.classList.add("reordering-lanes");
      showLaneDropIndicator(target.y);
      return;
    }
    activeCanvas.setPointerCapture(event.pointerId);
    dragStart = { x: event.clientX, start: state.startSeconds };
  });
  activeCanvas?.addEventListener("pointermove", (event) => {
    updateTimeCursor(event);
    if (laneDrag) {
      const target = channelDropTargetAt(event);
      laneDrag.targetBeforeId = target.beforeId;
      showLaneDropIndicator(target.y);
      hideTooltip();
      return;
    }
    if (!dragStart) {
      const region = findHoverRegion(event);
      if (region) showTooltip(event, region);
      else hideTooltip();
      return;
    }
    if (!state.study) return;
    const width = activeCanvas.getBoundingClientRect().width;
    const dx = event.clientX - dragStart.x;
    setStartSeconds(dragStart.start - (dx / width) * state.zoomSeconds);
  });
  activeCanvas?.addEventListener("pointerup", () => {
    if (laneDrag) {
      reorderChannel(laneDrag.channelId, laneDrag.targetBeforeId);
      laneDrag = null;
      activeCanvas.classList.remove("reordering-lanes");
      hideLaneDropIndicator();
      return;
    }
    dragStart = null;
  });
  activeCanvas?.addEventListener("pointerleave", () => {
    dragStart = null;
    laneDrag = null;
    activeCanvas.classList.remove("reordering-lanes");
    hideLaneDropIndicator();
    hideTooltip();
    hideTimeCursor();
  });
}

document.addEventListener("keydown", handleNavigationKeydown);

window.addEventListener("resize", () => {
  cancelKeyScroll();
  requestWindow();
  queueRender();
});

render();
