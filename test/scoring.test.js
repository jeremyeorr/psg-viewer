import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRows, normalizeStage, parseSeconds } from "../src/scoring/normalize.js";
import { parseXmlScoring } from "../src/scoring/xmlImporter.js";

test("parseSeconds handles numeric seconds and clock strings", () => {
  assert.equal(parseSeconds("90"), 90);
  assert.equal(parseSeconds("01:02"), 62);
  assert.equal(parseSeconds("01:02:03"), 3723);
  assert.equal(parseSeconds("bad", 7), 7);
});

test("normalizeStage maps common PSG labels", () => {
  assert.equal(normalizeStage("0"), "W");
  assert.equal(normalizeStage("Stage 2"), "N2");
  assert.equal(normalizeStage("REM"), "REM");
  assert.equal(normalizeStage("4"), "N3");
});

test("normalizeRows separates stage epochs and scored events", () => {
  const result = normalizeRows([
    { Epoch: "1", Stage: "W" },
    { Epoch: "2", Stage: "N2" },
    { Start: "42", Duration: "11", "Event Type": "Respiratory", Event: "Hypopnea", Channel: "Airflow" }
  ], "csv");

  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[1].onset, 30);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "Respiratory");
  assert.equal(result.events[0].subtype, "Hypopnea");
  assert.equal(result.events[0].channel, "Airflow");
});

test("normalizeRows preserves Excel serial timing origin for EDF alignment", () => {
  const result = normalizeRows([
    { Event: "Wake", Duration: 30, "Start Time": 44901.03888888889 },
    { Event: "Hypopnea", Duration: 10, "Start Time": 44901.03923611111 }
  ], "xls");

  assert.equal(result.timing.type, "excelSerial");
  assert.equal(result.stages[0].onset, 0);
  assert.equal(result.stages[0].sourceOnset, 44901.03888888889);
  assert.match(new Date(result.stages[0].absoluteUnixMs).toISOString(), /^2022-12-06T00:56:00/);
  assert.equal(Math.round(result.events[0].onset), 30);
  assert.match(new Date(result.timing.originUnixMs).toISOString(), /^2022-12-06T00:56:00/);
});

test("parseXmlScoring handles NSRR-style stages and scored events", async () => {
  const xml = `
    <PSGAnnotation>
      <SleepStages>
        <SleepStage>0</SleepStage>
        <SleepStage>2</SleepStage>
        <SleepStage>5</SleepStage>
      </SleepStages>
      <ScoredEvents>
        <ScoredEvent>
          <EventType>Respiratory</EventType>
          <EventConcept>Obstructive apnea</EventConcept>
          <Start>60</Start>
          <Duration>12.5</Duration>
          <SignalLocation>Airflow</SignalLocation>
        </ScoredEvent>
      </ScoredEvents>
    </PSGAnnotation>`;
  const result = await parseXmlScoring(xml);
  assert.deepEqual(result.stages.map((stage) => stage.stage), ["W", "N2", "REM"]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].onset, 60);
  assert.equal(result.events[0].duration, 12.5);
});
