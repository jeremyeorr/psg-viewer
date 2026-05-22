import { normalizeChannelLabel } from "../domain/channels.js";

const FIXED_HEADER_BYTES = 256;
const EDF_INT16_BYTES = 2;

function ascii(buffer, start, length) {
  const bytes = new Uint8Array(buffer, start, length);
  let text = "";
  for (const byte of bytes) text += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : " ";
  return text.trim();
}

function numberField(buffer, start, length, fallback = 0) {
  const parsed = Number.parseFloat(ascii(buffer, start, length));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateTime(dateText, timeText) {
  const dateParts = String(dateText || "").split(".").map((part) => Number.parseInt(part, 10));
  const timeParts = String(timeText || "").split(".").map((part) => Number.parseInt(part, 10));
  if (dateParts.length !== 3 || timeParts.length !== 3 || dateParts.some(Number.isNaN) || timeParts.some(Number.isNaN)) {
    return null;
  }
  const [day, month, twoDigitYear] = dateParts;
  const year = twoDigitYear >= 85 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
  const [hour, minute, second] = timeParts;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

function formatEdfStartLabel(dateText, timeText) {
  const dateParts = String(dateText || "").split(".").map((part) => Number.parseInt(part, 10));
  const timeParts = String(timeText || "").split(".").map((part) => Number.parseInt(part, 10));
  if (dateParts.length !== 3 || timeParts.length !== 3 || dateParts.some(Number.isNaN) || timeParts.some(Number.isNaN)) {
    return "";
  }
  const [day, month, twoDigitYear] = dateParts;
  const year = twoDigitYear >= 85 ? 1900 + twoDigitYear : 2000 + twoDigitYear;
  const [hour, minute, second] = timeParts;
  const monthLabel = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] || String(month).padStart(2, "0");
  return `${String(day).padStart(2, "0")} ${monthLabel} ${year} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

export function parseEdfHeader(buffer, fileName = "recording.edf") {
  if (buffer.byteLength < FIXED_HEADER_BYTES) {
    throw new Error("EDF header is shorter than 256 bytes.");
  }

  const version = ascii(buffer, 0, 8);
  const patientId = ascii(buffer, 8, 80);
  const recordingId = ascii(buffer, 88, 80);
  const startDate = ascii(buffer, 168, 8);
  const startTime = ascii(buffer, 176, 8);
  const headerBytes = numberField(buffer, 184, 8, FIXED_HEADER_BYTES);
  const reserved = ascii(buffer, 192, 44);
  const numberOfRecords = numberField(buffer, 236, 8, 0);
  const recordDuration = numberField(buffer, 244, 8, 1);
  const numberOfSignals = numberField(buffer, 252, 4, 0);

  if (version && version !== "0") {
    throw new Error(`Unsupported EDF version "${version}".`);
  }
  if (numberOfSignals <= 0) {
    throw new Error("EDF file does not declare any signals.");
  }
  if (buffer.byteLength < headerBytes) {
    throw new Error("EDF signal header is incomplete.");
  }

  let offset = FIXED_HEADER_BYTES;
  const readArray = (width) => {
    const values = [];
    for (let index = 0; index < numberOfSignals; index += 1) {
      values.push(ascii(buffer, offset + index * width, width));
    }
    offset += numberOfSignals * width;
    return values;
  };

  const labels = readArray(16);
  const transducers = readArray(80);
  const units = readArray(8);
  const physicalMins = readArray(8).map(Number.parseFloat);
  const physicalMaxes = readArray(8).map(Number.parseFloat);
  const digitalMins = readArray(8).map(Number.parseFloat);
  const digitalMaxes = readArray(8).map(Number.parseFloat);
  const prefilters = readArray(80);
  const samplesPerRecords = readArray(8).map((value) => Number.parseInt(value, 10));
  readArray(32);

  let byteOffsetInRecord = 0;
  const warnings = [];
  const channels = labels.map((label, id) => {
    const samplesPerRecord = Number.isFinite(samplesPerRecords[id]) ? samplesPerRecords[id] : 0;
    const channelOffset = byteOffsetInRecord;
    byteOffsetInRecord += samplesPerRecord * EDF_INT16_BYTES;
    const normalizedLabel = normalizeChannelLabel(label);
    const isAnnotation = normalizedLabel.includes("annotation") || normalizedLabel.includes("edf annotations");

    if (samplesPerRecord <= 0) warnings.push(`${label || `Channel ${id + 1}`} has no samples per record.`);

    return {
      id,
      label: label || `Channel ${id + 1}`,
      normalizedLabel,
      units: units[id] || "",
      sampleRate: recordDuration > 0 ? samplesPerRecord / recordDuration : 0,
      samplesPerRecord,
      physicalMin: Number.isFinite(physicalMins[id]) ? physicalMins[id] : -1,
      physicalMax: Number.isFinite(physicalMaxes[id]) ? physicalMaxes[id] : 1,
      digitalMin: Number.isFinite(digitalMins[id]) ? digitalMins[id] : -32768,
      digitalMax: Number.isFinite(digitalMaxes[id]) ? digitalMaxes[id] : 32767,
      transducer: transducers[id] || "",
      prefiltering: prefilters[id] || "",
      byteOffsetInRecord: channelOffset,
      isAnnotation
    };
  });

  const bytesPerRecord = byteOffsetInRecord;
  const declaredRecords = numberOfRecords >= 0 ? numberOfRecords : 0;
  const duration = declaredRecords * recordDuration;
  if (reserved.toLowerCase().includes("edf+c") || reserved.toLowerCase().includes("edf+d")) {
    warnings.push("EDF+ annotation channels are recognized, but external scoring files are used for event overlays in v1.");
  }

  return {
    fileName,
    patientId,
    recordingId,
    startDate,
    startTime,
    recordingStart: parseDateTime(startDate, startTime),
    recordingStartLabel: formatEdfStartLabel(startDate, startTime),
    duration,
    recordDuration,
    numberOfRecords: declaredRecords,
    headerBytes,
    bytesPerRecord,
    channels,
    warnings
  };
}

function convertDigitalToPhysical(channel, digital) {
  const digitalRange = channel.digitalMax - channel.digitalMin;
  if (!Number.isFinite(digitalRange) || digitalRange === 0) return digital;
  return ((digital - channel.digitalMin) * (channel.physicalMax - channel.physicalMin)) / digitalRange + channel.physicalMin;
}

function createBuckets(bucketCount) {
  return {
    min: Array(bucketCount).fill(Number.POSITIVE_INFINITY),
    max: Array(bucketCount).fill(Number.NEGATIVE_INFINITY),
    samplesRead: 0
  };
}

export async function readSignalWindow(file, study, request) {
  const startSeconds = Math.max(0, request.startSeconds);
  const durationSeconds = Math.max(1, request.durationSeconds);
  const endSeconds = Math.min(study.duration || Number.POSITIVE_INFINITY, startSeconds + durationSeconds);
  const bucketCount = Math.max(1, Math.floor(request.targetPixelWidth || 800));
  const firstRecord = Math.max(0, Math.floor(startSeconds / study.recordDuration));
  const lastRecord = Math.min(
    Math.max(0, study.numberOfRecords - 1),
    Math.max(firstRecord, Math.ceil(endSeconds / study.recordDuration) - 1)
  );
  const sliceStart = study.headerBytes + firstRecord * study.bytesPerRecord;
  const sliceEnd = study.headerBytes + (lastRecord + 1) * study.bytesPerRecord;
  const buffer = await file.slice(sliceStart, sliceEnd).arrayBuffer();
  const view = new DataView(buffer);
  const channels = request.channelIds
    .map((id) => study.channels.find((channel) => channel.id === id))
    .filter(Boolean)
    .filter((channel) => !channel.isAnnotation);
  const bucketsByChannel = new Map(channels.map((channel) => [channel.id, createBuckets(bucketCount)]));
  const warnings = [];

  for (let record = firstRecord; record <= lastRecord; record += 1) {
    const recordStart = record * study.recordDuration;
    const recordOffset = (record - firstRecord) * study.bytesPerRecord;

    for (const channel of channels) {
      const buckets = bucketsByChannel.get(channel.id);
      const samples = channel.samplesPerRecord;
      const channelOffset = recordOffset + channel.byteOffsetInRecord;

      for (let sample = 0; sample < samples; sample += 1) {
        const sampleTime = recordStart + (sample / samples) * study.recordDuration;
        if (sampleTime < startSeconds || sampleTime >= endSeconds) continue;
        const byteOffset = channelOffset + sample * EDF_INT16_BYTES;
        if (byteOffset + EDF_INT16_BYTES > view.byteLength) continue;
        const digital = view.getInt16(byteOffset, true);
        const physical = convertDigitalToPhysical(channel, digital);
        const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor(((sampleTime - startSeconds) / durationSeconds) * bucketCount)));
        buckets.min[bucketIndex] = Math.min(buckets.min[bucketIndex], physical);
        buckets.max[bucketIndex] = Math.max(buckets.max[bucketIndex], physical);
        buckets.samplesRead += 1;
      }
    }
  }

  const resultChannels = channels.map((channel) => {
    const buckets = bucketsByChannel.get(channel.id);
    let visibleMin = Number.POSITIVE_INFINITY;
    let visibleMax = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < bucketCount; index += 1) {
      if (!Number.isFinite(buckets.min[index])) {
        buckets.min[index] = null;
        buckets.max[index] = null;
        continue;
      }
      visibleMin = Math.min(visibleMin, buckets.min[index]);
      visibleMax = Math.max(visibleMax, buckets.max[index]);
    }

    if (!Number.isFinite(visibleMin) || !Number.isFinite(visibleMax)) {
      visibleMin = channel.physicalMin;
      visibleMax = channel.physicalMax;
      warnings.push(`No samples found for ${channel.label} in the selected window.`);
    }

    return {
      channelId: channel.id,
      sampleRate: channel.sampleRate,
      samplesRead: buckets.samplesRead,
      min: buckets.min,
      max: buckets.max,
      visibleMin,
      visibleMax
    };
  });

  return {
    startSeconds,
    durationSeconds,
    bucketCount,
    channels: resultChannels,
    warnings
  };
}

export async function loadEdfStudy(file) {
  const fixedHeader = await file.slice(0, FIXED_HEADER_BYTES).arrayBuffer();
  const headerBytes = numberField(fixedHeader, 184, 8, FIXED_HEADER_BYTES);
  const fullHeader = await file.slice(0, headerBytes).arrayBuffer();
  return parseEdfHeader(fullHeader, file.name || "recording.edf");
}
