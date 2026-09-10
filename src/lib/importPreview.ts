export interface ImportPreviewItem {
  id: string;
  fileName: string;
  size: number;
  kind: string;
  usable: boolean;
  count: number;
  countLabel: string;
  worksheets: string[];
  selectedSheet?: string;
  selectableSheets?: string[];
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  recognized: string[];
  missing: string[];
  warnings: string[];
}

export function captureRange(values: Array<string | null | undefined>): { firstCapturedAt: string | null; lastCapturedAt: string | null } {
  const times = values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!))).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { firstCapturedAt: times[0] ?? null, lastCapturedAt: times.at(-1) ?? null };
}
