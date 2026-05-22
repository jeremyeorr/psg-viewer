import { channelColor, formatDuration } from "../domain/channels.js";

const LEFT_GUTTER = 154;
const TOP_AXIS = 22;
const STAGE_TOP = 25;
const STAGE_HEIGHT = 22;
const POSITION_TOP = 49;
const POSITION_HEIGHT = 22;
const RESPIRATORY_TOP = 73;
const RESPIRATORY_HEIGHT = 26;
const EVENT_TOP = 101;
const EVENT_HEIGHT = 26;
const WAVEFORM_TOP = 130;
const DEFAULT_LANE_HEIGHT = 108;
const MIN_LANE_HEIGHT = 7;
const EVENT_ROW_HEIGHT = 8;
const EVENT_ROW_GAP = 2;

const STAGE_COLORS = {
  W: "#d7a62d",
  N1: "#7db2d8",
  N2: "#3f80c2",
  N3: "#245a95",
  REM: "#a65ccf",
  Unknown: "#98a2b3"
};

const EVENT_COLORS = {
  respiratory: "#c23b5a",
  apnea: "#c23b5a",
  hypopnea: "#d36b2d",
  arousal: "#7c5cc4",
  limb: "#1f9d87",
  desat: "#2680a6",
  event: "#667085"
};

const POSITION_COLORS = {
  supine: "#344054",
  prone: "#7a5af8",
  left: "#2e90fa",
  right: "#12b76a",
  upright: "#f79009",
  position: "#667085"
};

export function requiredCanvasHeight(channelCount) {
  return WAVEFORM_TOP + Math.max(1, channelCount) * DEFAULT_LANE_HEIGHT + 12;
}

function setupCanvas(canvas, width, height) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function xForTime(time, start, duration, width) {
  return LEFT_GUTTER + ((time - start) / duration) * (width - LEFT_GUTTER - 18);
}

function formatClockTime(seconds, recordingStart) {
  if (!recordingStart) return formatDuration(seconds);
  const startMs = Date.parse(recordingStart);
  if (!Number.isFinite(startMs)) return formatDuration(seconds);
  const date = new Date(startMs + seconds * 1000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function eventColor(event) {
  const text = `${event.type || ""} ${event.subtype || ""}`.toLowerCase();
  const key = Object.keys(EVENT_COLORS).find((candidate) => text.includes(candidate));
  return EVENT_COLORS[key || "event"];
}

function eventLabel(event) {
  return String(event.label || event.subtype || event.type || "Event").trim();
}

function isRespiratoryEvent(event) {
  const text = `${event.type || ""} ${event.subtype || ""} ${event.label || ""}`.toLowerCase();
  return ["respiratory", "apnea", "hypopnea", "rera", "central", "obstructive", "mixed apnea"].some((term) => text.includes(term));
}

function positionLabel(event) {
  return String(event.label || event.subtype || event.type || "").trim();
}

function positionKey(event) {
  const label = positionLabel(event).toLowerCase();
  const text = `${event.type || ""} ${event.subtype || ""} ${event.label || ""}`.toLowerCase();
  if (text.includes("supine")) return "supine";
  if (text.includes("prone")) return "prone";
  if (text.includes("upright") || text.includes("sitting") || text.includes("standing")) return "upright";
  if (!text.includes("leg") && !text.includes("limb")) {
    if (text.includes("left lateral") || label === "left" || text.includes("left side")) return "left";
    if (text.includes("right lateral") || label === "right" || text.includes("right side")) return "right";
  }
  if (text.includes("position") || text.includes("body")) return "position";
  return "";
}

function isPositionEvent(event) {
  return Boolean(positionKey(event));
}

function addRegion(regions, item, x, y, width, height, label, kind) {
  regions.push({ x, y, width, height, label, kind, item });
}

function visibleTimedEvents(events, startSeconds, durationSeconds) {
  const endSeconds = startSeconds + durationSeconds;
  return events
    .map((event) => ({ event, end: event.onset + Math.max(1, event.duration || 1) }))
    .filter(({ event, end }) => end >= startSeconds && event.onset <= endSeconds)
    .sort((a, b) => a.event.onset - b.event.onset || b.end - a.end);
}

function assignOverlapLevels(events, maxLevels) {
  const levelEnds = [];
  return events.map(({ event, end }) => {
    let level = levelEnds.findIndex((levelEnd) => event.onset >= levelEnd);
    if (level === -1) level = levelEnds.length;
    const hiddenLevel = level >= maxLevels;
    if (hiddenLevel) level = maxLevels - 1;
    levelEnds[level] = Math.max(levelEnds[level] || 0, end);
    return { event, end, level, hiddenLevel };
  });
}

function drawTimeAxis(context, width, height, startSeconds, durationSeconds, recordingStart) {
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, width, TOP_AXIS);
  context.strokeStyle = "#d0d5dd";
  context.beginPath();
  context.moveTo(0, TOP_AXIS + 0.5);
  context.lineTo(width, TOP_AXIS + 0.5);
  context.stroke();

  const plotWidth = width - LEFT_GUTTER - 18;
  const tickCount = Math.max(2, Math.floor(plotWidth / 140));
  context.font = "12px system-ui, sans-serif";
  context.fillStyle = "#475467";
  context.textBaseline = "middle";
  for (let tick = 0; tick <= tickCount; tick += 1) {
    const x = LEFT_GUTTER + (tick / tickCount) * plotWidth;
    const time = startSeconds + (tick / tickCount) * durationSeconds;
    context.fillText(formatClockTime(time, recordingStart), x + 4, 12);
    context.strokeStyle = "#eaecf0";
    context.beginPath();
    context.moveTo(x + 0.5, TOP_AXIS);
    context.lineTo(x + 0.5, height);
    context.stroke();
  }
}

function drawStageStrip(context, width, startSeconds, durationSeconds, scoring, regions, recordingStart) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, STAGE_TOP, width, STAGE_HEIGHT);
  context.fillStyle = "#344054";
  context.font = "12px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText("Stage", 16, STAGE_TOP + STAGE_HEIGHT / 2);

  for (const stage of scoring?.stages || []) {
    const end = stage.onset + stage.duration;
    if (end < startSeconds || stage.onset > startSeconds + durationSeconds) continue;
    const x = xForTime(Math.max(stage.onset, startSeconds), startSeconds, durationSeconds, width);
    const x2 = xForTime(Math.min(end, startSeconds + durationSeconds), startSeconds, durationSeconds, width);
    context.fillStyle = STAGE_COLORS[stage.stage] || STAGE_COLORS.Unknown;
    context.fillRect(x, STAGE_TOP + 3, Math.max(1, x2 - x), STAGE_HEIGHT - 6);
    addRegion(regions, stage, x, STAGE_TOP + 3, Math.max(1, x2 - x), STAGE_HEIGHT - 6, `${stage.stage} · ${formatClockTime(stage.onset, recordingStart)} · ${Math.round(stage.duration)}s`, "stage");
    if (x2 - x > 24) {
      context.fillStyle = "#ffffff";
      context.font = "11px system-ui, sans-serif";
      context.fillText(stage.stage, x + 4, STAGE_TOP + STAGE_HEIGHT / 2);
    }
  }
}

function drawEventLane(context, width, top, height, label, events, startSeconds, durationSeconds, colorForEvent, regions, kind, recordingStart) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, top, width, height);
  context.fillStyle = "#344054";
  context.font = "12px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText(label, 16, top + height / 2);

  const maxLevels = Math.max(1, Math.floor((height - 6) / (EVENT_ROW_HEIGHT + EVENT_ROW_GAP)));
  const timedEvents = assignOverlapLevels(visibleTimedEvents(events, startSeconds, durationSeconds), maxLevels);
  for (const { event, end, level, hiddenLevel } of timedEvents) {
    const x = xForTime(Math.max(event.onset, startSeconds), startSeconds, durationSeconds, width);
    const x2 = xForTime(Math.min(end, startSeconds + durationSeconds), startSeconds, durationSeconds, width);
    const barWidth = Math.max(2, x2 - x);
    const y = top + 4 + level * (EVENT_ROW_HEIGHT + EVENT_ROW_GAP);
    context.fillStyle = colorForEvent(event);
    context.fillRect(x, y, barWidth, EVENT_ROW_HEIGHT);
    if (hiddenLevel) {
      context.fillStyle = "rgba(16, 24, 40, 0.28)";
      context.fillRect(x, y, barWidth, EVENT_ROW_HEIGHT);
    }
    const tooltip = `${eventLabel(event)} · ${formatClockTime(event.onset, recordingStart)} · ${Math.round(event.duration || 0)}s${event.channel ? ` · ${event.channel}` : ""}`;
    addRegion(regions, event, x, y, barWidth, EVENT_ROW_HEIGHT, tooltip, kind);
    if (barWidth > 60 && !hiddenLevel) {
      context.save();
      context.beginPath();
      context.rect(x, y, barWidth, EVENT_ROW_HEIGHT);
      context.clip();
      context.fillStyle = "#ffffff";
      context.font = "9px system-ui, sans-serif";
      context.fillText(eventLabel(event), x + 4, y + EVENT_ROW_HEIGHT / 2);
      context.restore();
    }
  }
}

function drawEvents(context, width, startSeconds, durationSeconds, scoring, regions) {
  const events = (scoring?.events || []).filter((event) => !isPositionEvent(event) && !isRespiratoryEvent(event));
  drawEventLane(context, width, EVENT_TOP, EVENT_HEIGHT, "Events", events, startSeconds, durationSeconds, eventColor, regions, "event", scoring?.recordingStart);
}

function drawRespiratory(context, width, startSeconds, durationSeconds, scoring, regions) {
  const events = (scoring?.events || []).filter((event) => !isPositionEvent(event) && isRespiratoryEvent(event));
  drawEventLane(context, width, RESPIRATORY_TOP, RESPIRATORY_HEIGHT, "Respiratory", events, startSeconds, durationSeconds, eventColor, regions, "respiratory", scoring?.recordingStart);
}

function drawPosition(context, width, startSeconds, durationSeconds, scoring, regions, recordingStart) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, POSITION_TOP, width, POSITION_HEIGHT);
  context.fillStyle = "#344054";
  context.font = "12px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText("Position", 16, POSITION_TOP + POSITION_HEIGHT / 2);

  for (const event of scoring?.events || []) {
    const key = positionKey(event);
    if (!key) continue;
    const end = event.onset + Math.max(1, event.duration || 1);
    if (end < startSeconds || event.onset > startSeconds + durationSeconds) continue;
    const x = xForTime(Math.max(event.onset, startSeconds), startSeconds, durationSeconds, width);
    const x2 = xForTime(Math.min(end, startSeconds + durationSeconds), startSeconds, durationSeconds, width);
    const barWidth = Math.max(2, x2 - x);
    context.fillStyle = POSITION_COLORS[key] || POSITION_COLORS.position;
    context.fillRect(x, POSITION_TOP + 5, barWidth, POSITION_HEIGHT - 10);
    addRegion(regions, event, x, POSITION_TOP + 5, barWidth, POSITION_HEIGHT - 10, `${positionLabel(event) || "Position"} · ${formatClockTime(event.onset, recordingStart)} · ${Math.round(event.duration || 0)}s`, "position");
    if (barWidth > 42) {
      context.save();
      context.beginPath();
      context.rect(x, POSITION_TOP, barWidth, POSITION_HEIGHT);
      context.clip();
      context.fillStyle = "#ffffff";
      context.font = "11px system-ui, sans-serif";
      context.fillText(positionLabel(event) || "Position", x + 4, POSITION_TOP + POSITION_HEIGHT / 2);
      context.restore();
    }
  }
}

function drawWaveformLane(context, lane, channel, windowChannel, width, index, scaleState, laneHeight, regions) {
  const top = WAVEFORM_TOP + index * laneHeight;
  const mid = top + laneHeight / 2;
  const plotLeft = LEFT_GUTTER;
  const plotWidth = width - LEFT_GUTTER - 18;
  const color = channelColor(channel.label);
  const autoMin = windowChannel?.visibleMin ?? channel.physicalMin;
  const autoMax = windowChannel?.visibleMax ?? channel.physicalMax;
  const manualMode = scaleState?.mode === "manual";
  const manualRange = Number(scaleState?.range);
  const manualCenter = Number(scaleState?.center);
  const dataMin = manualMode && Number.isFinite(manualRange) && manualRange > 0
    ? (Number.isFinite(manualCenter) ? manualCenter : 0) - manualRange / 2
    : autoMin;
  const dataMax = manualMode && Number.isFinite(manualRange) && manualRange > 0
    ? (Number.isFinite(manualCenter) ? manualCenter : 0) + manualRange / 2
    : autoMax;
  const span = Math.max(1e-9, dataMax - dataMin);
  const center = (dataMax + dataMin) / 2;
  const yForValue = (value) => mid - ((value - center) / span) * (laneHeight * 0.76);

  context.fillStyle = index % 2 === 0 ? "#fcfcfd" : "#f8fafc";
  context.fillRect(0, top, width, laneHeight);
  context.strokeStyle = "#eaecf0";
  context.beginPath();
  context.moveTo(0, top + 0.5);
  context.lineTo(width, top + 0.5);
  context.stroke();
  context.strokeStyle = "#d0d5dd";
  context.beginPath();
  context.moveTo(plotLeft, mid + 0.5);
  context.lineTo(width - 18, mid + 0.5);
  context.stroke();
  addRegion(regions, channel, 0, top, LEFT_GUTTER, laneHeight, `Drag ${channel.label} to reorder`, "channel");

  const labelY = top + (laneHeight < 20 ? laneHeight / 2 : laneHeight < 48 ? laneHeight / 2 - 5 : 28);
  context.fillStyle = "#98a2b3";
  context.font = laneHeight < 20 ? "600 8px system-ui, sans-serif" : "600 12px system-ui, sans-serif";
  context.fillText("::", 6, labelY);

  context.fillStyle = "#101828";
  context.font = laneHeight < 20 ? "600 8px system-ui, sans-serif" : laneHeight < 48 ? "600 10px system-ui, sans-serif" : "600 12px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText(channel.label, 22, labelY);
  context.fillStyle = "#667085";
  context.font = laneHeight < 48 ? "9px system-ui, sans-serif" : "11px system-ui, sans-serif";
  if (laneHeight < 20) {
    context.fillText(channel.units || "", 118, top + laneHeight / 2);
  } else if (laneHeight < 48) {
    context.fillText(`${dataMin.toFixed(1)} to ${dataMax.toFixed(1)} ${channel.units || ""}`.trim(), 16, top + laneHeight / 2 + 8);
  } else {
    context.fillText(`${channel.sampleRate.toFixed(channel.sampleRate >= 10 ? 0 : 1)} Hz`, 16, top + 48);
    context.fillText(channel.units || "unitless", 16, top + 66);
    context.fillText(`${dataMin.toFixed(1)} to ${dataMax.toFixed(1)}`, 16, top + 84);
  }

  if (!windowChannel) {
    context.fillStyle = "#667085";
    context.fillText("Loading", plotLeft + 12, mid);
    return;
  }

  context.strokeStyle = color;
  context.lineWidth = 1.3;
  context.beginPath();
  let hasEnvelope = false;
  for (let bucket = 0; bucket < windowChannel.min.length; bucket += 1) {
    const min = windowChannel.min[bucket];
    const max = windowChannel.max[bucket];
    if (min === null || max === null) continue;
    if (min === max) continue;
    const x = plotLeft + (bucket / Math.max(1, windowChannel.min.length - 1)) * plotWidth;
    context.moveTo(x, yForValue(min));
    context.lineTo(x, yForValue(max));
    hasEnvelope = true;
  }
  if (hasEnvelope) context.stroke();

  context.beginPath();
  let hasLine = false;
  for (let bucket = 0; bucket < windowChannel.min.length; bucket += 1) {
    const min = windowChannel.min[bucket];
    const max = windowChannel.max[bucket];
    if (min === null || max === null) continue;
    const x = plotLeft + (bucket / Math.max(1, windowChannel.min.length - 1)) * plotWidth;
    const y = yForValue((min + max) / 2);
    if (!hasLine) {
      context.moveTo(x, y);
      hasLine = true;
    } else {
      context.lineTo(x, y);
    }
  }
  if (hasLine) context.stroke();
  context.lineWidth = 1;
}

export function renderPsgCanvas(canvas, state) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = Math.max(480, Math.floor(rect.width));
  const visibleChannels = state.visibleChannels;
  const availableHeight = Math.max(320, Math.floor(rect.height || requiredCanvasHeight(visibleChannels.length)));
  const laneHeight = Math.max(
    MIN_LANE_HEIGHT,
    Math.floor((availableHeight - WAVEFORM_TOP - 8) / Math.max(1, visibleChannels.length))
  );
  const height = availableHeight;
  const context = setupCanvas(canvas, width, height);
  const regions = [];
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  const recordingStart = state.recordingStart || state.scoring?.recordingStart;
  drawTimeAxis(context, width, height, state.startSeconds, state.zoomSeconds, recordingStart);
  drawStageStrip(context, width, state.startSeconds, state.zoomSeconds, state.scoring, regions, recordingStart);
  drawPosition(context, width, state.startSeconds, state.zoomSeconds, state.scoring, regions, recordingStart);
  drawRespiratory(context, width, state.startSeconds, state.zoomSeconds, state.scoring, regions);
  drawEvents(context, width, state.startSeconds, state.zoomSeconds, state.scoring, regions);

  const byChannelId = new Map((state.signalWindow?.channels || []).map((channel) => [channel.channelId, channel]));
  visibleChannels.forEach((channel, index) => {
    drawWaveformLane(
      context,
      null,
      channel,
      byChannelId.get(channel.id),
      width,
      index,
      state.channelScale[channel.id],
      laneHeight,
      regions
    );
  });

  return { width, height, regions };
}
