import { normalizeRows } from "./normalize.js?v=20260522-rml2";
import { parseRmlScoring } from "./rmlImporter.js?v=20260522-rml2";
import { parseXmlScoring } from "./xmlImporter.js?v=20260522-rml2";
import { parseXlsxScoring } from "./xlsxImporter.js?v=20260522-rml2";

function parseDelimited(text, delimiter) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function rowsToObjects(rows) {
  const headers = (rows[0] || []).map((value, index) => value.trim() || `Column ${index + 1}`);
  return rows.slice(1).map((row) => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = row[index] ?? "";
    });
    return object;
  });
}

export const scoringImporters = [
  {
    name: "Sleepware RML",
    canRead: (file) => /\.rml$/i.test(file.name || ""),
    parse: parseRmlScoring
  },
  {
    name: "XML",
    canRead: (file) => /\.xml$/i.test(file.name || "") || /xml/i.test(file.type || ""),
    parse: parseXmlScoring
  },
  {
    name: "Excel",
    canRead: (file) => /\.(xlsx|xls)$/i.test(file.name || ""),
    parse: parseXlsxScoring
  },
  {
    name: "Delimited",
    canRead: (file) => /\.(csv|tsv|txt)$/i.test(file.name || ""),
    parse: async (file) => {
      const text = await file.text();
      const delimiter = /\.tsv$/i.test(file.name || "") ? "\t" : ",";
      return normalizeRows(rowsToObjects(parseDelimited(text, delimiter)), delimiter === "\t" ? "tsv" : "csv");
    }
  }
];

export async function importScoring(file) {
  const importer = scoringImporters.find((candidate) => candidate.canRead(file));
  if (!importer) {
    throw new Error("Unsupported scoring format. Use RML, XML, XLSX, XLS, CSV, or TSV.");
  }
  return importer.parse(file);
}
