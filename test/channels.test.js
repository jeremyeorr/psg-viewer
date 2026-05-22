import assert from "node:assert/strict";
import test from "node:test";
import { defaultVisibleChannelIds, orderChannelsForPsg } from "../src/domain/channels.js";

function channel(id, label) {
  return {
    id,
    label,
    normalizedLabel: label.toLowerCase(),
    sampleRate: 200,
    units: "uV",
    isAnnotation: false
  };
}

test("default PSG montage starts with four EEG channels and two EOG channels", () => {
  const channels = [
    channel(0, "ECG"),
    channel(1, "C3-M2"),
    channel(2, "E1-M2"),
    channel(3, "Right Leg Impedan"),
    channel(4, "F4-M1"),
    channel(5, "E2-M1"),
    channel(6, "F3-M2"),
    channel(7, "Right Leg"),
    channel(8, "C4-M1"),
    channel(9, "Nasal Pressure"),
    channel(10, "Saturation")
  ];
  const selected = new Set(defaultVisibleChannelIds(channels));
  const labels = orderChannelsForPsg(channels.filter((candidate) => selected.has(candidate.id))).map((candidate) => candidate.label);

  assert.deepEqual(labels.slice(0, 6), ["F3-M2", "F4-M1", "C3-M2", "C4-M1", "E1-M2", "E2-M1"]);
  assert.equal(labels.includes("Right Leg Impedan"), false);
  assert.equal(labels.includes("Right Leg"), true);
});
