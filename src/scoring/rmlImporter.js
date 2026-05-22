import { DEFAULT_EPOCH_LENGTH, normalizeStage, parseSeconds } from "./normalize.js?v=20260522-rml2";

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function attributes(text) {
  const result = {};
  for (const match of text.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function tagText(body, tagName) {
  const match = body.match(new RegExp(`<(?:[\\w.-]+:)?${tagName}\\b[^>]*>(.*?)<\\/(?:[\\w.-]+:)?${tagName}>`, "is"));
  return match ? decodeXml(match[1].replace(/<[^>]*>/g, "")) : "";
}

function eventLabel(attrs, body) {
  if (attrs.CustomEventTypeName) return attrs.CustomEventTypeName;
  if (attrs.Type === "BodyPositionOverride") return tagText(body, "BodyPosition") || "Position";
  if (attrs.Type === "Comment") return tagText(body, "Comment") || "Comment";
  return attrs.Type || attrs.Family || "Event";
}

function eventChannel(body) {
  return tagText(body, "Input") || tagText(body, "Channel") || tagText(body, "SignalLocation") || "";
}

function shouldSkipEvent(attrs) {
  return attrs.Family === "User" && ["Gain", "ChannelFail"].includes(attrs.Type);
}

function parseRmlEvents(text, warnings) {
  const events = [];
  const eventPattern = /<Event\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Event>)/g;
  for (const match of text.matchAll(eventPattern)) {
    const attrs = attributes(match[1]);
    const body = match[2] || "";
    const onset = parseSeconds(attrs.Start, null);
    if (onset === null) {
      warnings.push(`Skipped RML event "${attrs.Type || attrs.Family || "Event"}" without readable Start.`);
      continue;
    }
    if (shouldSkipEvent(attrs)) continue;

    const label = eventLabel(attrs, body);
    const type = attrs.Type === "BodyPositionOverride" ? "Position" : attrs.Family || attrs.Type || "Event";
    const subtype = attrs.Type === "BodyPositionOverride" ? label : attrs.CustomEventTypeName || attrs.Type || "";
    events.push({
      onset,
      duration: parseSeconds(attrs.Duration, 0) || 0,
      type,
      subtype: subtype || undefined,
      channel: eventChannel(body) || undefined,
      label
    });
  }

  const positionPattern = /<BodyPositionItem\b([^>]*)\/?>/g;
  for (const match of text.matchAll(positionPattern)) {
    const attrs = attributes(match[1]);
    const onset = parseSeconds(attrs.Start, null);
    if (onset === null) continue;
    events.push({
      onset,
      duration: DEFAULT_EPOCH_LENGTH,
      type: "Position",
      subtype: attrs.Position || undefined,
      label: attrs.Position || "Position"
    });
  }

  return events.sort((a, b) => a.onset - b.onset);
}

function parseRmlStages(text) {
  const stageStarts = [];
  for (const match of text.matchAll(/<Stage\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1]);
    const onset = parseSeconds(attrs.Start, null);
    if (onset === null) continue;
    stageStarts.push({
      onset,
      stage: normalizeStage(attrs.Type),
      label: attrs.Type || ""
    });
  }

  stageStarts.sort((a, b) => a.onset - b.onset);
  return stageStarts.map((stage, index) => {
    const next = stageStarts[index + 1];
    return {
      ...stage,
      duration: next ? Math.max(DEFAULT_EPOCH_LENGTH, next.onset - stage.onset) : DEFAULT_EPOCH_LENGTH
    };
  });
}

export async function parseRmlScoring(fileOrText) {
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  const warnings = [];
  const stages = parseRmlStages(text);
  const events = parseRmlEvents(text, warnings);
  if (!stages.length) warnings.push("No RML sleep stages were found.");
  if (!events.length) warnings.push("No RML scored events were found.");

  return {
    stages,
    events,
    warnings,
    sourceFormat: "rml",
    epochLength: DEFAULT_EPOCH_LENGTH,
    timing: { type: "relative" }
  };
}
