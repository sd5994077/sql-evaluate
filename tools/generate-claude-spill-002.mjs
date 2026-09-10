import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as XLSX from "xlsx";

const output = resolve(process.cwd(), "fixtures", "CLAUDE-SPILL-002", "spill-review.xlsx");
mkdirSync(dirname(output), { recursive: true });

const workbook = XLSX.utils.book_new();
workbook.Props = {
  Title: "SQL Evaluate CLAUDE-SPILL-002",
  Subject: "Synthetic Spill Triage black-box evidence",
  Author: "SQL Evaluate",
  CreatedDate: new Date("2026-09-02T15:00:00.000Z"),
};

XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ["Synthetic offline review package"],
  ["The workbook contains multiple result shapes. Review Data Quality before drawing conclusions."],
  ["No values in this workbook came from a production system."],
]), "Read Me");

XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ["Captured At", "CPU Percent", "Runnable Tasks"],
  [new Date("2026-09-02T14:55:00.000Z"), 42, 3],
  [new Date("2026-09-02T15:00:00.000Z"), 47, 4],
]), "CPU Snapshot");

const headers = [
  "TotalSpills",
  "AverageSpills",
  "Execution Count",
  "Last Executed",
  "Database Name",
  "Object Name",
  "PlanHandle",
  "SqlHandle",
  "Statement Start Offset",
  "Statement End Offset",
  "QueryHash",
  "QueryPlanHash",
  "DatabaseId",
  "Query Store Query Id",
  "Query Store Plan Id",
  "Warnings",
  "Remove Plan Handle From Cache",
  "Total Spill MiB",
  "Future Spill Class",
];

const rows = [
  [500000, 50000, 10, "2026-09-02 10:00:00", "AtlasOps", "dbo.AuroraProcess", null, null, null, null, null, null, 11, 7001, 7101, "Sort spill", null, null, "tier-a"],
  [500000, 50000, 10, "2026-09-02 10:00:00", "AtlasOps", "dbo.AuroraConflict", "0xAA02", null, null, null, "0xA200", "0xA2A", 11, 7002, 7102, "Hash spill", null, null, "tier-a"],
  [420000, null, 6, "2026-09-02 10:10:00", "AtlasOps", "dbo.BeaconBatch", null, "0x0300", 0, 200, "0xB300", "0xB3A", 11, null, null, "Sort spill", null, null, "tier-b"],
  [350000, 70000, 5, "2026-09-02 10:20:00", "ArchiveOps", "dbo.CipherLookup", null, null, null, null, "0xC400", "0xC4A", 7, null, null, "Sort spill", null, null, "tier-b"],
  [340000, 85000, 4, "2026-09-02 10:25:00", "ArchiveOps", "dbo.CipherLookup", null, null, null, null, "0xC400", "0xC4B", 7, null, null, "Hash spill", null, null, "tier-b-variant"],
  [90000, 90000, 1, "2026-09-02 10:30:00", "AtlasOps", "dbo.DeltaQueryHashOnly", null, null, null, null, "0xD600", null, 11, null, null, "Spill warning", null, null, "candidate-only"],
  [null, 120000, 2, "2026-09-02 10:40:00", "AtlasOps", "dbo.EchoAverageOnly", null, "0xE700", null, null, "0xE701", null, 11, null, null, "Sort spill", null, null, "average-only"],
  [0, 60000, 4, "2026-09-02 10:45:00", "AtlasOps", "dbo.FoxtrotInconsistent", "0xF800", null, null, null, "0xF801", "0xF8A", 11, null, null, "Spill warning", null, null, "inconsistent"],
  ["many", null, 15, "2026-09-02 10:50:00", "AtlasOps", "dbo.GolfMalformed", "0xG900", null, null, null, "0xG901", "0xG9A", 11, null, null, "Spill occurred", "DBCC FREEPROCCACHE (0xG900);", null, "malformed"],
  [null, null, 2, "recently", "AtlasOps", "dbo.HotelExplicitUnit", null, null, null, null, "0xH100", "0xH1A", 11, null, null, "Spill volume supplied in MiB", null, 800, "explicit-unit"],
];

const spillSheet = XLSX.utils.aoa_to_sheet([
  ["SQL Evaluate synthetic spill review"],
  ["Generated", new Date("2026-09-02T15:00:00.000Z")],
  ["Source", "Offline synthetic evidence"],
  ["Requested sort", "Spills"],
  ["Review note", "The result may be bounded."],
  headers,
  ...rows,
]);
spillSheet["!cols"] = headers.map((header) => ({ wch: Math.max(14, Math.min(34, header.length + 3)) }));
XLSX.utils.book_append_sheet(workbook, spillSheet, "Spill Review");

const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
writeFileSync(output, bytes);
console.log(`Wrote ${output}`);
