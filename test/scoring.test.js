import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRows, normalizeStage, parseSeconds } from "../src/scoring/normalize.js";
import { parseRmlScoring } from "../src/scoring/rmlImporter.js";
import { parseXdfScoring } from "../src/scoring/xdfImporter.js";
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
  assert.equal(normalizeStage("NonREM1"), "N1");
  assert.equal(normalizeStage("NonREM2"), "N2");
  assert.equal(normalizeStage("NotScored"), "Unknown");
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

test("parseRmlScoring handles Sleepware stages and events", async () => {
  const rml = `
    <PatientStudy>
      <ScoringData>
        <Events>
          <Event Family="Respiratory" Type="ObstructiveApnea" Start="2888.5" Duration="13.5">
            <Input>Flow Patient</Input>
          </Event>
          <Event Family="User" Type="BodyPositionOverride" Start="2806" Duration="1273">
            <BodyPosition>Right</BodyPosition>
          </Event>
          <Event Family="User" Type="Gain" Start="0" Duration="0" />
        </Events>
        <StagingData>
          <Stage Type="Wake" Start="2820" />
          <Stage Type="NonREM1" Start="2880" />
          <Stage Type="NonREM2" Start="2910" />
        </StagingData>
      </ScoringData>
    </PatientStudy>
  `;
  const result = await parseRmlScoring(rml);

  assert.equal(result.sourceFormat, "rml");
  assert.deepEqual(result.stages.map((stage) => stage.stage), ["W", "N1", "N2"]);
  assert.equal(result.stages[0].duration, 60);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].label, "Right");
  assert.equal(result.events[1].type, "Respiratory");
  assert.equal(result.events[1].label, "ObstructiveApnea");
  assert.equal(result.events[1].channel, "Flow Patient");
});

test("parseXdfScoring handles Polysmith absolute stages and events", async () => {
  const xdf = `
    <xdf:OpenXDF xmlns:xdf="http://www.openxdf.org/xdf" xmlns:nti="http://www.neurotronics.com/nti">
      <xdf:EpochLength>30</xdf:EpochLength>
      <xdf:Session>
        <xdf:StartTime>2024-03-06T22:27:06.589000000000000</xdf:StartTime>
      </xdf:Session>
      <xdf:SleepStages>
        <xdf:SleepStage><xdf:EpochNumber>2</xdf:EpochNumber><xdf:Stage>1</xdf:Stage></xdf:SleepStage>
        <xdf:SleepStage><xdf:EpochNumber>1</xdf:EpochNumber><xdf:Stage>W</xdf:Stage></xdf:SleepStage>
      </xdf:SleepStages>
      <xdf:Hypopneas>
        <xdf:Hypopnea>
          <xdf:Time>2024-03-06T22:33:46.589000700000000</xdf:Time>
          <xdf:Duration>36.4</xdf:Duration>
          <xdf:Class>mixed</xdf:Class>
        </xdf:Hypopnea>
      </xdf:Hypopneas>
      <xdf:NoteEvents>
        <xdf:Note>
          <xdf:Time>2024-03-06T22:28:57.588999899999997</xdf:Time>
          <xdf:NoteText>Lights out</xdf:NoteText>
        </xdf:Note>
      </xdf:NoteEvents>
    </xdf:OpenXDF>`;

  const result = await parseXdfScoring(xdf);

  assert.equal(result.sourceFormat, "xdf");
  assert.equal(result.timing.type, "absolute");
  assert.deepEqual(result.stages.map((stage) => stage.stage), ["W", "N1"]);
  assert.equal(result.stages[1].onset, 30);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[1].type, "Respiratory");
  assert.equal(result.events[1].label, "Mixed Hypopnea");
  assert.equal(Math.round(result.events[1].onset), 400);
  assert.match(new Date(result.events[1].absoluteUnixMs).toISOString(), /^2024-03-06T22:33:46/);
});
