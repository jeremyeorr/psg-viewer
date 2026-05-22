import { DEFAULT_EPOCH_LENGTH, normalizeRows, normalizeStage, parseSeconds } from "./normalize.js";

function textFromNode(node, tagName) {
  const child = Array.from(node.children || []).find((candidate) => candidate.tagName.toLowerCase() === tagName.toLowerCase());
  return child ? child.textContent.trim() : "";
}

function attributesAndChildren(node) {
  const row = {};
  for (const attribute of Array.from(node.attributes || [])) row[attribute.name] = attribute.value;
  for (const child of Array.from(node.children || [])) {
    if (child.children.length === 0) row[child.tagName] = child.textContent.trim();
  }
  return row;
}

function parseWithDom(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("XML scoring file is not well-formed.");
  const stages = [];
  const events = [];
  const warnings = [];

  const sleepStageNodes = Array.from(doc.querySelectorAll("SleepStages > SleepStage"));
  if (sleepStageNodes.length) {
    sleepStageNodes.forEach((node, index) => {
      stages.push({
        onset: index * DEFAULT_EPOCH_LENGTH,
        duration: DEFAULT_EPOCH_LENGTH,
        stage: normalizeStage(node.textContent.trim()),
        label: node.textContent.trim()
      });
    });
  }

  const stageRows = Array.from(doc.querySelectorAll("Stage, SleepStage, Epoch"))
    .filter((node) => node.parentElement?.tagName !== "SleepStages")
    .map(attributesAndChildren);
  if (!stages.length && stageRows.length) {
    stages.push(...normalizeRows(stageRows, "xml").stages);
  }

  const eventNodes = Array.from(doc.querySelectorAll("ScoredEvent, Event, RespiratoryEvent, Arousal, LimbMovement"));
  for (const node of eventNodes) {
    const row = attributesAndChildren(node);
    const onset = parseSeconds(row.Start ?? row.Onset ?? row.start ?? row.onset ?? textFromNode(node, "Start"), null);
    const duration = parseSeconds(row.Duration ?? row.duration ?? textFromNode(node, "Duration"), 0);
    const type = row.EventType || row.Type || row.type || node.tagName || "Event";
    const subtype = row.EventConcept || row.Name || row.EventName || row.name || "";
    const channel = row.SignalLocation || row.Channel || row.channel || "";
    if (onset === null) {
      warnings.push(`Skipped ${node.tagName} without readable onset.`);
      continue;
    }
    events.push({
      onset,
      duration,
      type: String(type).trim(),
      subtype: String(subtype).trim() || undefined,
      channel: String(channel).trim() || undefined,
      label: String(subtype || type).trim()
    });
  }

  return {
    stages: stages.sort((a, b) => a.onset - b.onset),
    events: events.sort((a, b) => a.onset - b.onset),
    warnings,
    sourceFormat: "xml",
    epochLength: DEFAULT_EPOCH_LENGTH
  };
}

function parseXmlFallback(text) {
  const stages = [];
  const events = [];
  const stageMatches = text.matchAll(/<SleepStage[^>]*>(.*?)<\/SleepStage>/gis);
  let index = 0;
  for (const match of stageMatches) {
    stages.push({
      onset: index * DEFAULT_EPOCH_LENGTH,
      duration: DEFAULT_EPOCH_LENGTH,
      stage: normalizeStage(stripXml(match[1])),
      label: stripXml(match[1])
    });
    index += 1;
  }

  const eventMatches = text.matchAll(/<ScoredEvent[^>]*>(.*?)<\/ScoredEvent>/gis);
  for (const match of eventMatches) {
    const body = match[1];
    const onset = parseSeconds(tag(body, "Start"), null);
    if (onset === null) continue;
    const type = tag(body, "EventType") || "Event";
    const subtype = tag(body, "EventConcept");
    events.push({
      onset,
      duration: parseSeconds(tag(body, "Duration"), 0),
      type,
      subtype: subtype || undefined,
      channel: tag(body, "SignalLocation") || undefined,
      label: subtype || type
    });
  }

  return { stages, events, warnings: [], sourceFormat: "xml", epochLength: DEFAULT_EPOCH_LENGTH };
}

function tag(text, name) {
  const match = text.match(new RegExp(`<${name}[^>]*>(.*?)<\\/${name}>`, "is"));
  return match ? stripXml(match[1]) : "";
}

function stripXml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export async function parseXmlScoring(fileOrText) {
  const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
  return typeof DOMParser !== "undefined" ? parseWithDom(text) : parseXmlFallback(text);
}
