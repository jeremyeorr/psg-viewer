export const DEFAULT_ZOOM_SECONDS = 30;
export const ZOOM_WINDOWS = [30, 60, 120, 300, 600, "night"];

const CHANNEL_GROUPS = [
  { kind: "eeg", patterns: ["eeg", "c3", "c4", "f3", "f4", "o1", "o2"], color: "#2d6cdf" },
  { kind: "eog", patterns: ["eog", "loc", "roc", "leog", "reog", "e1", "e2"], color: "#1f9d87" },
  { kind: "chin", patterns: ["chin", "mentalis", "submental"], color: "#d36b2d" },
  { kind: "ecg", patterns: ["ecg", "ekg", "heart"], color: "#c23b5a" },
  { kind: "airflow", patterns: ["airflow", "flow", "nasal", "therm"], color: "#6a53a3" },
  { kind: "effort", patterns: ["thor", "abd", "chest", "effort", "belt"], color: "#8b7d2b" },
  { kind: "spo2", patterns: ["spo2", "sao2", "oxygen", "saturation"], color: "#2680a6" },
  { kind: "position", patterns: ["position", "body", "posangle"], color: "#667085" },
  { kind: "leg", patterns: ["leg", "tib", "lat", "rat"], color: "#9a4d7a" },
  { kind: "snore", patterns: ["snore", "sound"], color: "#7c5c36" }
];

const PSG_DISPLAY_PRESET = [
  { kind: "eeg", count: 4, preferred: ["f3 m2", "f4 m1", "c3 m2", "c4 m1", "o1 m2", "o2 m1", "f3", "f4", "c3", "c4", "o1", "o2"] },
  { kind: "eog", count: 2, preferred: ["e1 m2", "e2 m1", "loc", "roc", "e1", "e2", "leog", "reog"] },
  { kind: "chin", count: 1, preferred: ["chin", "mentalis", "submental"] },
  { kind: "ecg", count: 1, preferred: ["ecg", "ekg"] },
  { kind: "airflow", count: 1, preferred: ["nasal pressure", "airflow", "flow", "crip flow", "rip flow", "therm"] },
  { kind: "snore", count: 1, preferred: ["snore", "audio volume db", "audio volume"] },
  { kind: "effort", count: 1, preferred: ["thorax", "thor", "chest"] },
  { kind: "effort", count: 1, preferred: ["abdomen", "abdom", "abd"] },
  { kind: "spo2", count: 1, preferred: ["spo2", "saturation", "sao2"] },
  { kind: "position", count: 1, preferred: ["position", "posangle", "body"] },
  { kind: "leg", count: 2, preferred: ["left leg", "right leg", "leg"] }
];

export function normalizeChannelLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function classifyChannel(label) {
  const normalized = normalizeChannelLabel(label);
  if (isImpedanceChannel(label)) return { kind: "other", patterns: [], color: "#5d6b82" };
  return (
    CHANNEL_GROUPS.find((group) =>
      group.patterns.some((pattern) => normalized.includes(pattern))
    ) || { kind: "other", patterns: [], color: "#5d6b82" }
  );
}

export function channelColor(label) {
  return classifyChannel(label).color;
}

export function isImpedanceChannel(label) {
  return normalizeChannelLabel(label).includes("imped");
}

function scorePreferredLabel(channel, preset) {
  if (channel.isAnnotation || isImpedanceChannel(channel.label)) return Number.POSITIVE_INFINITY;
  const normalized = normalizeChannelLabel(channel.label);
  if (classifyChannel(channel.label).kind !== preset.kind) return Number.POSITIVE_INFINITY;
  const preferredIndex = preset.preferred.findIndex((label) => normalized === label || normalized.includes(label));
  const aliasScore = preferredIndex === -1 ? 100 : preferredIndex;
  const derivedBonus = /[a-z]\d\s+[am]\d/.test(normalized) ? -0.25 : 0;
  const rawPenalty = normalized.includes("raw") || normalized.includes("fast") ? 20 : 0;
  return aliasScore + derivedBonus + rawPenalty + channel.id / 10000;
}

function bestPresetIndex(channel) {
  let best = { index: PSG_DISPLAY_PRESET.length, score: Number.POSITIVE_INFINITY };
  PSG_DISPLAY_PRESET.forEach((preset, index) => {
    const score = scorePreferredLabel(channel, preset);
    if (score < best.score) best = { index, score };
  });
  return best;
}

export function orderChannelsForPsg(channels) {
  return [...channels].sort((a, b) => {
    const aOrder = bestPresetIndex(a);
    const bOrder = bestPresetIndex(b);
    if (aOrder.index !== bOrder.index) return aOrder.index - bOrder.index;
    if (aOrder.score !== bOrder.score) return aOrder.score - bOrder.score;
    return a.id - b.id;
  });
}

export function applyChannelOrder(channels, channelOrder = []) {
  const defaultOrdered = orderChannelsForPsg(channels);
  const byId = new Map(defaultOrdered.map((channel) => [channel.id, channel]));
  const used = new Set();
  const ordered = [];

  for (const rawId of channelOrder || []) {
    const id = Number(rawId);
    if (!byId.has(id) || used.has(id)) continue;
    ordered.push(byId.get(id));
    used.add(id);
  }

  for (const channel of defaultOrdered) {
    if (!used.has(channel.id)) ordered.push(channel);
  }

  return ordered;
}

export function moveChannelInOrder(channels, channelOrder, draggedId, targetId) {
  const orderedIds = applyChannelOrder(channels, channelOrder).map((channel) => channel.id);
  const fromIndex = orderedIds.indexOf(Number(draggedId));
  if (fromIndex === -1) return orderedIds;

  const [moved] = orderedIds.splice(fromIndex, 1);
  if (targetId === null || targetId === undefined) {
    orderedIds.push(moved);
    return orderedIds;
  }

  const insertIndex = orderedIds.indexOf(Number(targetId));
  if (insertIndex === -1) {
    orderedIds.splice(fromIndex, 0, moved);
    return orderedIds;
  }

  orderedIds.splice(insertIndex, 0, moved);
  return orderedIds;
}

export function defaultVisibleChannelIds(channels) {
  const selected = [];
  const used = new Set();

  for (const preset of PSG_DISPLAY_PRESET) {
    const candidates = channels
      .filter((channel) => !used.has(channel.id))
      .map((channel) => ({ channel, score: scorePreferredLabel(channel, preset) }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((a, b) => a.score - b.score || a.channel.id - b.channel.id)
      .slice(0, preset.count);

    for (const candidate of candidates) {
      selected.push(candidate.channel.id);
      used.add(candidate.channel.id);
    }
  }

  if (selected.length >= 4) return selected;
  return orderChannelsForPsg(channels)
    .filter((channel) => !channel.isAnnotation && !isImpedanceChannel(channel.label))
    .slice(0, 8)
    .map((channel) => channel.id);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
