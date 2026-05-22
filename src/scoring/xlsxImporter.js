import { normalizeRows } from "./normalize.js";
import { parseXlsScoring } from "./xlsImporter.js";

const TEXT_DECODER = new TextDecoder();

function readUint16(view, offset) {
  return view.getUint16(offset, true);
}

function readUint32(view, offset) {
  return view.getUint32(offset, true);
}

function decodeXml(bytes) {
  return TEXT_DECODER.decode(bytes);
}

function xmlEntityDecode(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress XLSX files. Try Chrome, Edge, or export scoring as XML/CSV.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(view) {
  for (let offset = view.byteLength - 22; offset >= Math.max(0, view.byteLength - 66000); offset -= 1) {
    if (readUint32(view, offset) === 0x06054b50) return offset;
  }
  throw new Error("XLSX ZIP directory was not found.");
}

async function readZipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = readUint16(view, eocd + 10);
  let centralOffset = readUint32(view, eocd + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, centralOffset) !== 0x02014b50) throw new Error("Invalid XLSX central directory.");
    const method = readUint16(view, centralOffset + 10);
    const compressedSize = readUint32(view, centralOffset + 20);
    const fileNameLength = readUint16(view, centralOffset + 28);
    const extraLength = readUint16(view, centralOffset + 30);
    const commentLength = readUint16(view, centralOffset + 32);
    const localOffset = readUint32(view, centralOffset + 42);
    const name = decodeXml(new Uint8Array(arrayBuffer, centralOffset + 46, fileNameLength));

    if (readUint32(view, localOffset) !== 0x04034b50) throw new Error(`Invalid XLSX local header for ${name}.`);
    const localNameLength = readUint16(view, localOffset + 26);
    const localExtraLength = readUint16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = new Uint8Array(arrayBuffer, dataOffset, compressedSize);
    const bytes = method === 0 ? compressed : method === 8 ? await inflateRaw(compressed) : null;
    if (bytes) entries.set(name, bytes);

    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return Array.from(xml.matchAll(/<si[^>]*>(.*?)<\/si>/gis)).map((match) => {
    const text = Array.from(match[1].matchAll(/<t[^>]*>(.*?)<\/t>/gis)).map((part) => part[1]).join("");
    return xmlEntityDecode(text);
  });
}

function columnIndex(cellRef) {
  const letters = String(cellRef || "").match(/[A-Z]+/i)?.[0] || "A";
  return letters.toUpperCase().split("").reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function cellValue(cellXml, sharedStrings) {
  const type = cellXml.match(/\st="([^"]+)"/i)?.[1];
  const inline = cellXml.match(/<t[^>]*>(.*?)<\/t>/is)?.[1];
  if (inline !== undefined) return xmlEntityDecode(inline);
  const raw = cellXml.match(/<v[^>]*>(.*?)<\/v>/is)?.[1] ?? "";
  if (type === "s") return sharedStrings[Number.parseInt(raw, 10)] ?? "";
  return xmlEntityDecode(raw);
}

function sheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>(.*?)<\/row>/gis)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>(.*?)<\/c>/gis)) {
      const ref = cellMatch[1].match(/\sr="([^"]+)"/i)?.[1];
      cells[columnIndex(ref)] = cellValue(cellMatch[0], sharedStrings);
    }
    if (cells.some((value) => String(value ?? "").trim())) rows.push(cells);
  }
  return rows;
}

function rowsToObjects(rows) {
  const headers = (rows[0] || []).map((value, index) => String(value || `Column ${index + 1}`).trim());
  return rows.slice(1).map((row) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = row[index] ?? "";
    });
    return object;
  });
}

export async function parseXlsxScoring(file) {
  if (/\.xls$/i.test(file.name) && !/\.xlsx$/i.test(file.name)) {
    return parseXlsScoring(file);
  }

  const entries = await readZipEntries(await file.arrayBuffer());
  const sharedStrings = parseSharedStrings(entries.has("xl/sharedStrings.xml") ? decodeXml(entries.get("xl/sharedStrings.xml")) : "");
  const firstSheetName = Array.from(entries.keys()).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  if (!firstSheetName) throw new Error("XLSX workbook did not include a worksheet.");
  const rows = rowsToObjects(sheetRows(decodeXml(entries.get(firstSheetName)), sharedStrings));
  const result = normalizeRows(rows, "xlsx");
  if (!rows.length) result.warnings.push("No scoring rows were found in the first worksheet.");
  return result;
}
