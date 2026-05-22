import assert from "node:assert/strict";
import test from "node:test";
import { applyChannelOrder, defaultVisibleChannelIds, moveChannelInOrder, orderChannelsForPsg } from "../src/domain/channels.js";

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

test("custom channel order is layered over the PSG default order", () => {
  const channels = [
    channel(0, "F3-M2"),
    channel(1, "F4-M1"),
    channel(2, "C3-M2"),
    channel(3, "C4-M1"),
    channel(4, "E1-M2"),
    channel(5, "E2-M1")
  ];
  const ordered = applyChannelOrder(channels, [4, 0]);

  assert.deepEqual(ordered.map((candidate) => candidate.label), ["E1-M2", "F3-M2", "F4-M1", "C3-M2", "C4-M1", "E2-M1"]);
});

test("moveChannelInOrder returns a persisted full channel order", () => {
  const channels = [
    channel(0, "F3-M2"),
    channel(1, "F4-M1"),
    channel(2, "C3-M2"),
    channel(3, "C4-M1")
  ];
  const moved = moveChannelInOrder(channels, [], 2, 0);

  assert.deepEqual(applyChannelOrder(channels, moved).map((candidate) => candidate.label), ["C3-M2", "F3-M2", "F4-M1", "C4-M1"]);
});

test("moveChannelInOrder can move a channel to the end", () => {
  const channels = [
    channel(0, "F3-M2"),
    channel(1, "F4-M1"),
    channel(2, "C3-M2")
  ];
  const moved = moveChannelInOrder(channels, [], 0, null);

  assert.deepEqual(applyChannelOrder(channels, moved).map((candidate) => candidate.label), ["F4-M1", "C3-M2", "F3-M2"]);
});
