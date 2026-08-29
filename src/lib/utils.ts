export function makeId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${value}`;
}

export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.toUpperCase() === "NULL") return null;
  return text;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asText(value);
  if (!text) return null;
  const normalized = text.replace(/,/g, "").trim();
  const scaled = normalized.match(/^([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*([KMGTPE])?(?:I?B)?$/i);
  if (scaled) {
    const base = Number(scaled[1]);
    const power = scaled[2] ? "KMGTPE".indexOf(scaled[2].toUpperCase()) + 1 : 0;
    const number = base * 1000 ** power;
    return Number.isFinite(number) ? number : null;
  }
  const match = normalized.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

export function excelDateToIso(value: number): string | null {
  if (!Number.isFinite(value) || value < 1 || value > 100000) return null;
  const milliseconds = Math.round((value - 25569) * 86400000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function asIsoDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number") return excelDateToIso(value);
  const text = asText(value);
  if (!text) return null;
  const parsed = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function durationTextToSeconds(value: unknown): number | null {
  const text = asText(value);
  if (!text) return null;
  const match = text.match(/^(?:(\d+)\s+)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]) + Number(`0.${match[5] ?? 0}`);
}

export function differenceSeconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function percentile(values: number[], value: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const below = sorted.filter((candidate) => candidate <= value).length;
  return below / sorted.length;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  if (rounded < 3600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  if (rounded < 86400) return `${Math.floor(rounded / 3600)}h ${Math.round((rounded % 3600) / 60)}m`;
  return `${Math.floor(rounded / 86400)}d ${Math.round((rounded % 86400) / 3600)}h`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatTempdbPages(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const megabytes = value * 8 / 1024;
  const size = megabytes >= 1024
    ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(megabytes / 1024)} GB`
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(megabytes)} MB`;
  return `${formatNumber(value)} pages (${size})`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
