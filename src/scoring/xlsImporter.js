import { normalizeRows } from "./normalize.js?v=20260522-rml2";

const FREE_SECTOR = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const MINI_STREAM_CUTOFF = 4096;
const TEXT_DECODER = new TextDecoder("utf-8");

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function i32(value) {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function sectorOffset(sector, sectorSize) {
  return (sector + 1) * sectorSize;
}

function utf16le(bytes, start, length) {
  let text = "";
  for (let offset = start; offset + 1 < start + length; offset += 2) {
    const code = bytes[offset] | (bytes[offset + 1] << 8);
    if (code) text += String.fromCharCode(code);
  }
  return text;
}

function collectDifat(view, sectorSize) {
  const difat = [];
  const fatSectorCount = u32(view, 44);
  let nextDifatSector = u32(view, 68);
  let difatSectorCount = u32(view, 72);

  for (let index = 0; index < 109; index += 1) {
    const sector = u32(view, 76 + index * 4);
    if (sector !== FREE_SECTOR) difat.push(sector);
  }

  while (nextDifatSector !== END_OF_CHAIN && nextDifatSector !== FREE_SECTOR && difatSectorCount > 0) {
    const offset = sectorOffset(nextDifatSector, sectorSize);
    const entries = sectorSize / 4 - 1;
    for (let index = 0; index < entries; index += 1) {
      const sector = u32(view, offset + index * 4);
      if (sector !== FREE_SECTOR) difat.push(sector);
    }
    nextDifatSector = u32(view, offset + entries * 4);
    difatSectorCount -= 1;
  }

  return difat.slice(0, fatSectorCount);
}

function buildFat(view, difat, sectorSize) {
  const fat = [];
  for (const sector of difat) {
    if (sector === FAT_SECTOR || sector === DIFAT_SECTOR || sector === FREE_SECTOR) continue;
    const offset = sectorOffset(sector, sectorSize);
    for (let index = 0; index < sectorSize / 4; index += 1) {
      fat.push(u32(view, offset + index * 4));
    }
  }
  return fat;
}

function readChain(bytes, view, fat, startSector, sectorSize, size = null) {
  const chunks = [];
  const seen = new Set();
  let sector = startSector;
  while (sector !== END_OF_CHAIN && sector !== FREE_SECTOR && sector !== undefined && !seen.has(sector)) {
    seen.add(sector);
    const offset = sectorOffset(sector, sectorSize);
    chunks.push(bytes.slice(offset, offset + sectorSize));
    sector = fat[sector];
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return size === null ? output : output.slice(0, size);
}

function parseDirectory(bytes) {
  const entries = [];
  for (let offset = 0; offset + 128 <= bytes.length; offset += 128) {
    const nameLength = u16(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset + 64);
    if (nameLength < 2) continue;
    const name = utf16le(bytes, offset, nameLength - 2);
    const type = bytes[offset + 66];
    const startSector = u32(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset + 116);
    const streamSize = u32(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset + 120);
    entries.push({ name, type, startSector, streamSize });
  }
  return entries;
}

function extractWorkbookStream(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const signature = Array.from(bytes.slice(0, 8)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (signature !== "d0cf11e0a1b11ae1") throw new Error("Legacy XLS file is not an OLE compound document.");

  const sectorSize = 2 ** u16(view, 30);
  const difat = collectDifat(view, sectorSize);
  const fat = buildFat(view, difat, sectorSize);
  const firstDirectorySector = u32(view, 48);
  const directoryBytes = readChain(bytes, view, fat, firstDirectorySector, sectorSize);
  const entries = parseDirectory(directoryBytes);
  const workbook = entries.find((entry) => entry.type === 2 && /^(Workbook|Book)$/i.test(entry.name));
  if (!workbook) throw new Error("No Workbook stream was found in the XLS file.");
  if (workbook.streamSize < MINI_STREAM_CUTOFF) {
    throw new Error("Small-stream XLS workbooks are not supported by the lightweight parser.");
  }
  return readChain(bytes, view, fat, workbook.startSector, sectorSize, workbook.streamSize);
}

function decodeString(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = u16(view, offset);
  const flags = bytes[offset + 2];
  let cursor = offset + 3;
  const hasExtended = Boolean(flags & 0x04);
  const hasRichText = Boolean(flags & 0x08);
  const isUtf16 = Boolean(flags & 0x01);
  const richRuns = hasRichText ? u16(view, cursor) : 0;
  if (hasRichText) cursor += 2;
  const extendedSize = hasExtended ? u32(view, cursor) : 0;
  if (hasExtended) cursor += 4;
  const byteLength = length * (isUtf16 ? 2 : 1);
  const text = isUtf16 ? utf16le(bytes, cursor, byteLength) : TEXT_DECODER.decode(bytes.slice(cursor, cursor + byteLength));
  return {
    text,
    nextOffset: cursor + byteLength + richRuns * 4 + extendedSize
  };
}

function parseSharedStringTable(records, startIndex) {
  const chunks = [records[startIndex].data];
  let index = startIndex + 1;
  while (records[index]?.id === 0x003c) {
    chunks.push(records[index].data);
    index += 1;
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uniqueCount = u32(view, 4);
  const strings = [];
  cursor = 8;
  while (strings.length < uniqueCount && cursor + 3 < bytes.length) {
    const parsed = decodeString(bytes, cursor);
    strings.push(parsed.text);
    cursor = parsed.nextOffset;
  }
  return strings;
}

function parseBiffRecords(workbookBytes) {
  const records = [];
  const view = new DataView(workbookBytes.buffer, workbookBytes.byteOffset, workbookBytes.byteLength);
  let offset = 0;
  while (offset + 4 <= workbookBytes.length) {
    const id = u16(view, offset);
    const length = u16(view, offset + 2);
    const dataStart = offset + 4;
    if (dataStart + length > workbookBytes.length) break;
    records.push({ id, data: workbookBytes.slice(dataStart, dataStart + length) });
    offset = dataStart + length;
  }
  return records;
}

function decodeRk(value) {
  const divided = Boolean(value & 0x01);
  const isInteger = Boolean(value & 0x02);
  let number;
  if (isInteger) {
    number = i32(value) >> 2;
  } else {
    return null;
  }
  return divided ? number / 100 : number;
}

function setCell(rows, rowIndex, colIndex, value) {
  if (!rows[rowIndex]) rows[rowIndex] = [];
  rows[rowIndex][colIndex] = value;
}

function rowsToObjects(rows) {
  const denseRows = rows.filter(Boolean);
  const headers = (denseRows[0] || []).map((value, index) => String(value || `Column ${index + 1}`).trim());
  return denseRows.slice(1).map((row) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = row[index] ?? "";
    });
    return object;
  });
}

function parseWorksheetRows(records, sharedStrings) {
  const rows = [];
  let inWorksheet = false;
  let sawWorksheet = false;

  for (const record of records) {
    const view = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength);
    if (record.id === 0x0809) {
      const streamType = record.data.length >= 4 ? u16(view, 2) : 0;
      inWorksheet = streamType === 0x0010 && !sawWorksheet;
      if (inWorksheet) sawWorksheet = true;
      continue;
    }
    if (record.id === 0x000a && inWorksheet) break;
    if (!inWorksheet) continue;

    if (record.id === 0x00fd && record.data.length >= 10) {
      setCell(rows, u16(view, 0), u16(view, 2), sharedStrings[u32(view, 6)] ?? "");
    } else if (record.id === 0x0203 && record.data.length >= 14) {
      setCell(rows, u16(view, 0), u16(view, 2), view.getFloat64(6, true));
    } else if (record.id === 0x027e && record.data.length >= 10) {
      const value = decodeRk(u32(view, 6));
      if (value !== null) setCell(rows, u16(view, 0), u16(view, 2), value);
    } else if (record.id === 0x0204 && record.data.length >= 9) {
      const parsed = decodeString(record.data, 6);
      setCell(rows, u16(view, 0), u16(view, 2), parsed.text);
    }
  }

  return rowsToObjects(rows);
}

export async function parseXlsRows(file) {
  const workbook = extractWorkbookStream(await file.arrayBuffer());
  const records = parseBiffRecords(workbook);
  let sharedStrings = [];
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].id === 0x00fc) {
      sharedStrings = parseSharedStringTable(records, index);
      break;
    }
  }
  return parseWorksheetRows(records, sharedStrings);
}

export async function parseXlsScoring(file) {
  const rows = await parseXlsRows(file);
  const result = normalizeRows(rows, "xls");
  if (!rows.length) result.warnings.push("No scoring rows were found in the first XLS worksheet.");
  return result;
}
