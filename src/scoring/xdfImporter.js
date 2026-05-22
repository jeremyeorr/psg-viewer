import { DEFAULT_EPOCH_LENGTH, normalizeStage, parseSeconds } from "./normalize.js?v=20260522-xdf";

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagText(body, tagName) {
  const match = body.match(new RegExp(`<(?:[\\w.-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tagName}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]*>/g, "")) : "";
}

function elements(text, tagName) {
  return Array.from(
    text.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tagName}>`, "gi"))
  ).map((match) => match[1]);
}

function parseXdfDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const trimmedFraction = text.replace(/(\.\d{3})\d+/, "$1");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmedFraction);
  const unixMs = Date.parse(hasZone ? trimmedFraction : `${trimmedFraction}Z`);
  return Number.isFinite(unixMs) ? unixMs : null;
}

function formatClass(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function labelWithClass(base, className) {
  const formattedClass = formatClass(className);
  return formattedClass ? `${formattedClass} ${base}` : base;
}

function inferOriginUnixMs(text) {
  const session = elements(text, "Session")[0] || "";
  return parseXdfDateTime(tagText(session, "StartTime")) || parseXdfDateTime(tagText(text, "StartTime"));
}

function parseXdfStages(text, epochLength, originUnixMs) {
  return elements(text, "SleepStage")
    .map((body) => {
      const epochNumber = Number.parseInt(tagText(body, "EpochNumber"), 10);
      const stage = normalizeStage(tagText(body, "Stage"));
      if (!Number.isFinite(epochNumber) || !stage) return null;
      const onset = Math.max(0, epochNumber - 1) * epochLength;
      return {
        onset,
        duration: epochLength,
        stage,
        label: tagText(body, "Stage"),
        absoluteUnixMs: Number.isFinite(originUnixMs) ? originUnixMs + onset * 1000 : undefined
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.onset - b.onset);
}

function timedEvent(body, options, originUnixMs, warnings) {
  const absoluteUnixMs = parseXdfDateTime(tagText(body, "Time"));
  if (!Number.isFinite(absoluteUnixMs)) {
    if (body.includes("<")) warnings.push(`Skipped Polysmith ${options.label} without readable Time.`);
    return null;
  }
  const className = tagText(body, "Class");
  const label = options.labelFor ? options.labelFor(body, className) : labelWithClass(options.label, className);
  return {
    onset: Number.isFinite(originUnixMs) ? (absoluteUnixMs - originUnixMs) / 1000 : 0,
    duration: parseSeconds(tagText(body, "Duration"), 0) || 0,
    type: options.type,
    subtype: options.subtypeFor ? options.subtypeFor(body, className) : options.subtype || label,
    channel: tagText(body, "Channel") || tagText(body, "Input") || undefined,
    label,
    absoluteUnixMs
  };
}

function parseXdfEvents(text, originUnixMs, warnings) {
  const eventSpecs = [
    {
      tag: "Apnea",
      type: "Respiratory",
      label: "Apnea",
      subtypeFor: (_body, className) => labelWithClass("Apnea", className)
    },
    {
      tag: "Hypopnea",
      type: "Respiratory",
      label: "Hypopnea",
      subtypeFor: (_body, className) => labelWithClass("Hypopnea", className)
    },
    { tag: "Desaturation", type: "SpO2", label: "Desaturation" },
    { tag: "Microarousal", type: "Arousal", label: "Arousal" },
    { tag: "LegMovement", type: "Limb", label: "Leg Movement" },
    { tag: "Snore", type: "Snore", label: "Snore" },
    {
      tag: "Arrhythmia",
      type: "Cardiac",
      label: "Arrhythmia",
      labelFor: (body) => tagText(body, "Class") || tagText(body, "Type") || "Arrhythmia"
    }
  ];

  const events = [];
  for (const spec of eventSpecs) {
    for (const body of elements(text, spec.tag)) {
      const event = timedEvent(body, spec, originUnixMs, warnings);
      if (event) events.push(event);
    }
  }

  for (const body of elements(text, "Note")) {
    const absoluteUnixMs = parseXdfDateTime(tagText(body, "Time"));
    const label = tagText(body, "NoteText") || "Note";
    if (!Number.isFinite(absoluteUnixMs)) {
      warnings.push(`Skipped Polysmith note "${label}" without readable Time.`);
      continue;
    }
    events.push({
      onset: Number.isFinite(originUnixMs) ? (absoluteUnixMs - originUnixMs) / 1000 : 0,
      duration: 0,
      type: "Note",
      subtype: "Note",
      label,
      absoluteUnixMs
    });
  }

  return events.sort((a, b) => a.onset - b.onset);
}

export async function parseXdfScoring(fileOrText) {
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const warnings = [];
  const epochLength = parseSeconds(tagText(text, "EpochLength"), DEFAULT_EPOCH_LENGTH) || DEFAULT_EPOCH_LENGTH;
  const originUnixMs = inferOriginUnixMs(text);
  const stages = parseXdfStages(text, epochLength, originUnixMs);
  const events = parseXdfEvents(text, originUnixMs, warnings);

  if (!Number.isFinite(originUnixMs)) warnings.push("Polysmith XDF session start time was not found; scoring may not align to EDF clock time.");
  if (!stages.length) warnings.push("No Polysmith XDF sleep stages were found.");
  if (!events.length) warnings.push("No Polysmith XDF scored events were found.");

  return {
    stages,
    events,
    warnings,
    sourceFormat: "xdf",
    epochLength,
    timing: {
      type: Number.isFinite(originUnixMs) ? "absolute" : "relative",
      originUnixMs: Number.isFinite(originUnixMs) ? originUnixMs : undefined
    }
  };
}
