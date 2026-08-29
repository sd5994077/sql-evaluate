import { File } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { processInputFiles } from "../src/lib/processFiles";

const root = resolve(process.cwd(), "fixtures");

for (const caseId of readdirSync(root).filter((name) => /^CASE-\d+$/.test(name)).sort()) {
  const directory = resolve(root, caseId);
  const names = readdirSync(directory).filter((name) => !name.startsWith("counters_") && /\.(?:csv|xlsx|sqlplan)$/i.test(name)).sort();
  const files = names.map((name) => new File([readFileSync(resolve(directory, name))], name));
  const result = await processInputFiles(files);
  if (result.type === "error") {
    console.log(JSON.stringify({ caseId, errors: result.errors }));
    continue;
  }
  const report = result.report;
  const counts = Object.fromEntries(["High", "Medium", "Low", "Informational", "Not Evaluated"].map((severity) => [severity, report.findings.filter((finding) => finding.severity === severity).length]));
  console.log(JSON.stringify({
    caseId,
    rows: report.records.length,
    captures: new Set(report.records.map((record) => record.collectionTime).filter(Boolean)).size,
    plans: report.plans.length,
    ...counts,
    primary: report.findings.filter((finding) => finding.severity !== "Not Evaluated").slice(0, 4).map((finding) => `${finding.ruleId}: ${finding.title}`),
    deepProfiles: [...new Set(report.findings.map((finding) => finding.deepAnalysisProfile).filter(Boolean))],
  }));
}
