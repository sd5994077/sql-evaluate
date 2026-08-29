import { headerScore } from "../schema";

export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = bytes.subarray(2).slice();
    for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    return new TextDecoder("utf-16le").decode(swapped);
  }
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) count += 1;
  }
  return count;
}

export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 8);
  const candidates = [",", "\t", ";"];
  return candidates
    .map((delimiter) => ({ delimiter, score: lines.reduce((total, line) => total + countDelimiter(line, delimiter), 0) }))
    .sort((a, b) => b.score - a.score)[0]?.delimiter ?? ",";
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): unknown[][] {
  const rows: unknown[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

export function findHeaderRow(rows: unknown[][]): number {
  let best = { index: -1, score: 0 };
  rows.slice(0, 20).forEach((row, index) => {
    const score = headerScore(row);
    if (score > best.score) best = { index, score };
  });
  return best.score >= 2 ? best.index : -1;
}
