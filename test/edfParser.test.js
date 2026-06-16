import assert from "node:assert/strict";
import test from "node:test";
import { parseEdfHeader, readSignalWindow } from "../src/edf/edfParser.js";

function padded(value, width) {
  return String(value).padEnd(width, " ").slice(0, width);
}

function writeAscii(bytes, offset, value, width) {
  const text = padded(value, width);
  for (let index = 0; index < width; index += 1) bytes[offset + index] = text.charCodeAt(index);
}

function makeSyntheticEdf() {
  const signals = 2;
  const headerBytes = 256 + signals * 256;
  const records = 2;
  const recordDuration = 1;
  const samplesPerRecord = [4, 2];
  const bytesPerRecord = samplesPerRecord.reduce((sum, samples) => sum + samples * 2, 0);
  const buffer = new ArrayBuffer(headerBytes + records * bytesPerRecord);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  writeAscii(bytes, 0, "0", 8);
  writeAscii(bytes, 8, "TEST PATIENT", 80);
  writeAscii(bytes, 88, "TEST RECORDING", 80);
  writeAscii(bytes, 168, "01.01.26", 8);
  writeAscii(bytes, 176, "22.30.00", 8);
  writeAscii(bytes, 184, headerBytes, 8);
  writeAscii(bytes, 192, "EDF+C", 44);
  writeAscii(bytes, 236, records, 8);
  writeAscii(bytes, 244, recordDuration, 8);
  writeAscii(bytes, 252, signals, 4);

  let offset = 256;
  const writeArray = (values, width) => {
    values.forEach((value, index) => writeAscii(bytes, offset + index * width, value, width));
    offset += signals * width;
  };
  writeArray(["C3-A2", "Airflow"], 16);
  writeArray(["", ""], 80);
  writeArray(["uV", "L/s"], 8);
  writeArray([0, -1], 8);
  writeArray([10, 1], 8);
  writeArray([0, -100], 8);
  writeArray([100, 100], 8);
  writeArray(["", ""], 80);
  writeArray(samplesPerRecord, 8);
  writeArray(["", ""], 32);

  const values = [
    [0, 25, 50, 100, -100, 0],
    [100, 50, 25, 0, 100, -100]
  ];
  let sampleOffset = headerBytes;
  for (const record of values) {
    for (const value of record) {
      view.setInt16(sampleOffset, value, true);
      sampleOffset += 2;
    }
  }
  return buffer;
}

function makeSingleSignalEdf(samplesPerRecord, values) {
  const signals = 1;
  const headerBytes = 256 + signals * 256;
  const records = Math.ceil(values.length / samplesPerRecord);
  const recordDuration = 1;
  const bytesPerRecord = samplesPerRecord * 2;
  const buffer = new ArrayBuffer(headerBytes + records * bytesPerRecord);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  writeAscii(bytes, 0, "0", 8);
  writeAscii(bytes, 8, "TEST PATIENT", 80);
  writeAscii(bytes, 88, "TEST RECORDING", 80);
  writeAscii(bytes, 168, "01.01.26", 8);
  writeAscii(bytes, 176, "22.30.00", 8);
  writeAscii(bytes, 184, headerBytes, 8);
  writeAscii(bytes, 192, "", 44);
  writeAscii(bytes, 236, records, 8);
  writeAscii(bytes, 244, recordDuration, 8);
  writeAscii(bytes, 252, signals, 4);

  let offset = 256;
  const writeArray = (fieldValues, width) => {
    fieldValues.forEach((value, index) => writeAscii(bytes, offset + index * width, value, width));
    offset += signals * width;
  };
  writeArray(["Fast"], 16);
  writeArray([""], 80);
  writeArray(["uV"], 8);
  writeArray([-1000], 8);
  writeArray([1000], 8);
  writeArray([-1000], 8);
  writeArray([1000], 8);
  writeArray([""], 80);
  writeArray([samplesPerRecord], 8);
  writeArray([""], 32);

  let sampleOffset = headerBytes;
  for (let index = 0; index < records * samplesPerRecord; index += 1) {
    view.setInt16(sampleOffset, values[index] ?? 0, true);
    sampleOffset += 2;
  }

  return buffer;
}

test("parseEdfHeader reads metadata and mixed sample rates", () => {
  const study = parseEdfHeader(makeSyntheticEdf(), "synthetic.edf");
  assert.equal(study.fileName, "synthetic.edf");
  assert.equal(study.channels.length, 2);
  assert.equal(study.recordDuration, 1);
  assert.equal(study.numberOfRecords, 2);
  assert.equal(study.duration, 2);
  assert.equal(study.startDate, "01.01.26");
  assert.equal(study.startTime, "22.30.00");
  assert.equal(study.recordingStartLabel, "01 Jan 2026 22:30:00");
  assert.equal(study.bytesPerRecord, 12);
  assert.equal(study.channels[0].sampleRate, 4);
  assert.equal(study.channels[1].sampleRate, 2);
  assert.equal(study.channels[1].byteOffsetInRecord, 8);
  assert.match(study.warnings.join(" "), /EDF\+/);
});

test("readSignalWindow decodes only the selected visible interval", async () => {
  const buffer = makeSyntheticEdf();
  const study = parseEdfHeader(buffer, "synthetic.edf");
  const blob = new Blob([buffer]);
  const result = await readSignalWindow(blob, study, {
    channelIds: [0, 1],
    startSeconds: 0.5,
    durationSeconds: 1,
    targetPixelWidth: 8
  });

  assert.equal(result.channels.length, 2);
  assert.equal(result.channels[0].samplesRead, 4);
  assert.equal(result.channels[0].sourceSamples, 4);
  assert.equal(result.channels[0].displayDownsampled, false);
  assert.equal(result.channels[1].samplesRead, 2);
  assert.equal(result.channels[1].sourceSamples, 2);
  assert.equal(result.channels[1].displayDownsampled, false);
  assert.equal(result.bucketCount, 8);
  assert.equal(result.channels[0].visibleMin, 5);
  assert.equal(result.channels[0].visibleMax, 10);
  assert.equal(result.channels[1].visibleMin, 0);
  assert.equal(result.channels[1].visibleMax, 1);
});

test("readSignalWindow downsamples dense display buckets", async () => {
  const values = Array.from({ length: 1000 }, (_, index) => index);
  const buffer = makeSingleSignalEdf(1000, values);
  const study = parseEdfHeader(buffer, "fast.edf");
  const blob = new Blob([buffer]);
  const result = await readSignalWindow(blob, study, {
    channelIds: [0],
    startSeconds: 0,
    durationSeconds: 1,
    targetPixelWidth: 10
  });

  assert.equal(result.channels.length, 1);
  assert.equal(result.bucketCount, 10);
  assert.equal(result.channels[0].sourceSamples, 1000);
  assert.equal(result.channels[0].samplesRead, 120);
  assert.equal(result.channels[0].displayDownsampled, true);
  assert.equal(result.channels[0].visibleMin, 0);
  assert.equal(result.channels[0].visibleMax, 999);
  assert.match(result.warnings.join(" "), /Display downsampled 1 high-rate channel/);
});
