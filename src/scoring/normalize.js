const ONSET_ALIASES = ["onset", "start", "starttime", "startsec", "seconds", "time"];
const DURATION_ALIASES = ["duration", "dur", "durationsec", "length"];
const STAGE_ALIASES = ["stage", "sleepstage", "sleep stage", "stages"];
const EVENT_TYPE_ALIASES = ["eventtype", "type", "category", "event category"];
const EVENT_NAME_ALIASES = ["event", "eventname", "eventconcept", "name", "description", "label"];
const CHANNEL_ALIASES = ["channel", "signallocation", "signal", "location"];
const EPOCH_ALIASES = ["epoch", "epochnumber", "epoch index"];

export const DEFAULT_EPOCH_LENGTH = 30;

function keyFor(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactKey(value) {
  return keyFor(value).replace(/\s+/g, "");
}

function findKey(row, aliases) {
  const entries = Object.keys(row);
  for (const alias of aliases) {
    const direct = entries.find((key) => keyFor(key) === keyFor(alias) || compactKey(key) === compactKey(alias));
    if (direct) return direct;
  }
  return entries.find((key) => aliases.some((alias) => compactKey(key).includes(compactKey(alias))));
}

export function parseSeconds(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  const numeric = Number.parseFloat(text);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(text)) return numeric;
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
  if (match) {
    const hours = match[3] ? Number(match[1]) : 0;
    const minutes = match[3] ? Number(match[2]) : Number(match[1]);
    const seconds = match[3] ? Number(match[3]) : Number(match[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return fallback;
}

export function normalizeStage(value) {
  const text = String(value ?? "").trim();
  const key = compactKey(text);
  if (!text) return null;
  if (["0", "w", "wake", "awake"].includes(key)) return "W";
  if (["1", "n1", "s1", "stage1", "nrem1", "nonrem1"].includes(key)) return "N1";
  if (["2", "n2", "s2", "stage2", "nrem2", "nonrem2"].includes(key)) return "N2";
  if (["3", "n3", "s3", "stage3", "nrem3", "nonrem3"].includes(key)) return "N3";
  if (["4", "n4", "s4", "stage4", "nonrem4"].includes(key)) return "N3";
  if (["5", "r", "rem", "stage5"].includes(key)) return "REM";
  if (["9", "?", "unknown", "movement", "mt", "notscored", "unscored"].includes(key)) return "Unknown";
  return text.toUpperCase();
}

function isKnownStage(value) {
  return ["W", "N1", "N2", "N3", "REM"].includes(normalizeStage(value));
}

export function normalizeRows(rows, sourceFormat = "tabular") {
  const stages = [];
  const events = [];
  const warnings = [];
  const epochLength = inferEpochLength(rows) || DEFAULT_EPOCH_LENGTH;

  rows.forEach((row, index) => {
    const stageKey = findKey(row, STAGE_ALIASES);
    const eventTypeKey = findKey(row, EVENT_TYPE_ALIASES);
    const eventNameKey = findKey(row, EVENT_NAME_ALIASES);
    const onsetKey = findKey(row, ONSET_ALIASES);
    const durationKey = findKey(row, DURATION_ALIASES);
    const channelKey = findKey(row, CHANNEL_ALIASES);
    const epochKey = findKey(row, EPOCH_ALIASES);
    const onset = parseSeconds(row[onsetKey], null);
    const duration = parseSeconds(row[durationKey], null);

    const stageLikeValue = stageKey ? row[stageKey] : eventNameKey ? row[eventNameKey] : "";
    const eventNameIsStage = !stageKey && eventNameKey && isKnownStage(stageLikeValue) && (!duration || duration >= 10);

    if ((stageKey && row[stageKey] !== "") || eventNameIsStage) {
      const stage = normalizeStage(stageLikeValue);
      const epochNumber = Number.parseInt(row[epochKey], 10);
      const stageOnset = onset ?? (Number.isFinite(epochNumber) ? Math.max(0, epochNumber - 1) * epochLength : stages.length * epochLength);
      stages.push({
        onset: stageOnset,
        duration: duration || epochLength,
        stage,
        label: String(stageLikeValue)
      });
      return;
    }

    if (eventTypeKey || eventNameKey) {
      if (onset === null) {
        warnings.push(`Row ${index + 1} has an event but no readable onset.`);
        return;
      }
      const type = String(row[eventTypeKey] || row[eventNameKey] || "Event").trim();
      const subtype = eventTypeKey && eventNameKey ? String(row[eventNameKey] || "").trim() : "";
      events.push({
        onset,
        duration: duration || 0,
        type,
        subtype: subtype || undefined,
        channel: channelKey ? String(row[channelKey] || "").trim() || undefined : undefined,
        label: subtype || type
      });
      return;
    }

    if (Object.values(row).some((value) => String(value ?? "").trim())) {
      warnings.push(`Row ${index + 1} did not match a stage or event shape.`);
    }
  });

  const timing = normalizeExcelSerialOnsets(stages, events);

  return {
    stages: stages.sort((a, b) => a.onset - b.onset),
    events: events.sort((a, b) => a.onset - b.onset),
    warnings,
    sourceFormat,
    epochLength,
    timing
  };
}

function normalizeExcelSerialOnsets(stages, events) {
  const timed = [...stages, ...events].filter((item) => Number.isFinite(item.onset));
  if (!timed.length) return { type: "relative" };
  const minOnset = Math.min(...timed.map((item) => item.onset));
  const maxOnset = Math.max(...timed.map((item) => item.onset));
  const looksLikeExcelSerial = minOnset > 20000 && maxOnset - minOnset < 2;
  if (!looksLikeExcelSerial) return { type: "relative" };
  for (const item of timed) {
    const serial = item.onset;
    item.sourceOnset = serial;
    item.absoluteUnixMs = excelSerialToUnixMs(serial);
    item.onset = (serial - minOnset) * 86400;
  }
  return {
    type: "excelSerial",
    originSerial: minOnset,
    originUnixMs: excelSerialToUnixMs(minOnset)
  };
}

function excelSerialToUnixMs(serial) {
  return (serial - 25569) * 86400 * 1000;
}

function inferEpochLength(rows) {
  const possibleKeys = ["epochlength", "epoch length", "epochduration", "epoch duration"];
  for (const row of rows) {
    const key = findKey(row, possibleKeys);
    const value = parseSeconds(row[key], null);
    if (value && value >= 5 && value <= 120) return value;
  }
  return null;
}
