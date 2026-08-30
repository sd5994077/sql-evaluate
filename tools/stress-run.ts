/**
 * Stress-suite runner for SQL Evaluate.
 *
 * Runs every fixtures/STRESS-XX package through the real ingestion + analysis
 * pipeline and checks the result against the expectations table below (which is
 * the visible half of the private stress answer key). Prints a PASS/FAIL line
 * per case and exits non-zero if any case regresses.
 *
 * Run it the same way as tools/blinded-summary.ts, e.g.:
 *     npx tsx tools/stress-run.ts
 */
import { File } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { processInputFiles } from "../src/lib/processFiles";

// The threshold-profile argument is optional on some builds; pass the default when it exists.
let options: Record<string, unknown> = {};
try {
  const mod: Record<string, unknown> = await import("../src/rules/thresholdProfiles");
  if (mod.DEFAULT_THRESHOLD_PROFILE_SNAPSHOT) options = { thresholdProfile: mod.DEFAULT_THRESHOLD_PROFILE_SNAPSHOT };
} catch {
  /* older build: processInputFiles(files) needs no options */
}

interface Expect {
  note: string;
  /** ruleId -> exact expected [severity, confidence]; use "*" to accept any. */
  findings: Array<{ ruleId: string; severity?: string; confidence?: string; titleIncludes?: string; count?: number }>;
  /** ruleIds that must NOT appear at all. */
  absent?: string[];
  notEvaluatedRulesInclude?: string[];
  notEvaluatedFindingCount?: number;
  unknownColumnsInclude?: string[];
  dqWarningIncludes?: string[];
  /** a ruleId whose finding must carry >=1 relatedFindings entry mentioning this text */
  relatedIncludes?: Array<{ ruleId: string; reasonIncludes: string }>;
  /** a ruleId whose finding must have NO relatedFindings */
  relatedEmpty?: string[];
  maxActionableFindings?: number;
}

const EXPECT: Record<string, Expect> = {
  "STRESS-01": {
    note: "Blocking persistence 45s sits between the 15s and 60s marks -> Medium, not High. A large victim wait must not override.",
    findings: [{ ruleId: "WIA-BLOCKING", severity: "Medium", titleIncludes: "root blocker" }],
    absent: [],
  },
  "STRESS-02": {
    note: "Exactly 5 distinct victims of one root in a single capture -> High/High even with persistence 0.",
    findings: [{ ruleId: "WIA-BLOCKING", severity: "High", confidence: "High" }],
  },
  "STRESS-03": {
    note: "Negative blocking_session_id owners: -2/-3 are Medium context; -5 is Informational and must not be escalated or 'killed'.",
    findings: [
      { ruleId: "WIA-BLOCKING-SPECIAL", severity: "Medium", titleIncludes: "-2" },
      { ruleId: "WIA-BLOCKING-SPECIAL", severity: "Medium", titleIncludes: "-3" },
      { ruleId: "WIA-BLOCKING-SPECIAL", severity: "Informational", titleIncludes: "-5" },
    ],
    absent: ["WIA-BLOCKING"],
  },
  "STRESS-04": {
    note: "THREADPOOL exhaustion and RESOURCE_SEMAPHORE_QUERY_COMPILE pressure are distinct conditions in one capture; two findings, no generic wait.",
    findings: [
      { ruleId: "WIA-WORKER-EXHAUSTION", severity: "High" },
      { ruleId: "WIA-COMPILE-PRESSURE", severity: "High" },
    ],
    absent: ["WIA-WAIT"],
  },
  "STRESS-05": {
    note: "Benign / zero-duration waits only (ASYNC_NETWORK_IO with no time, WAITFOR). No actionable finding at all.",
    findings: [],
    absent: ["WIA-WAIT", "WIA-BLOCKING", "WIA-TRANSACTION", "WIA-RESOURCE"],
    maxActionableFindings: 0,
  },
  "STRESS-06": {
    note: "wait_info / blocking_session_id / open_tran_count absent + estimated-only plan -> four Not Evaluated results; the resource check still runs.",
    findings: [{ ruleId: "WIA-RESOURCE", severity: "Medium" }],
    notEvaluatedRulesInclude: ["Blocking chains", "Actionable waits", "Open transactions"],
    notEvaluatedFindingCount: 4,
    absent: ["WIA-BLOCKING", "WIA-WAIT", "WIA-TRANSACTION"],
  },
  "STRESS-07": {
    note: "Multi-sheet XLSX; the capture is on the 2nd sheet. The sleeping head blocker with an open transaction must still be found.",
    findings: [
      { ruleId: "WIA-BLOCKING", severity: "High", confidence: "High" },
      { ruleId: "WIA-TRANSACTION", severity: "High" },
    ],
  },
  "STRESS-08": {
    note: "UTF-16LE + tab-delimited + grouped-integer parenthesised wait + delta-only resource columns must all parse.",
    findings: [{ ruleId: "WIA-WAIT", titleIncludes: "PAGEIOLATCH_SH" }],
  },
  "STRESS-09": {
    note: "Duplicate wait_info header + genuinely unknown columns. No crash; disclose both; use the first wait_info (ignore the 999999 decoy).",
    findings: [
      { ruleId: "WIA-BLOCKING", severity: "Medium" },
      { ruleId: "WIA-WAIT", titleIncludes: "LCK_M_X" },
    ],
    unknownColumnsInclude: ["sql_text_full", "node_id"],
    dqWarningIncludes: ["Duplicate columns"],
  },
  "STRESS-10": {
    note: "Two statements: memory-grant ratio exactly 8x -> High; ratio 7.94x -> Medium. Boundary must split cleanly.",
    findings: [{ ruleId: "PLAN-MEMORY-GRANT", count: 2 }],
  },
  "STRESS-11": {
    note: "Estimate ratio 100x on a 100k-row operator -> one High finding. Operators with 12x/90x ratios but < 10k rows stay silent.",
    findings: [{ ruleId: "PLAN-ESTIMATE", severity: "High", count: 1 }],
  },
  "STRESS-12": {
    note: "Embedded actual plan (same request, in window) is correlated; a standalone plan for a different query is contextual only.",
    findings: [
      { ruleId: "PLAN-SPILL" },
      { ruleId: "PLAN-MEMORY-GRANT", count: 2 },
    ],
    relatedIncludes: [{ ruleId: "PLAN-SPILL", reasonIncludes: "Embedded plan from the affected activity row" }],
  },
};

const root = resolve(process.cwd(), "fixtures");
const ACTIONABLE = new Set(["Critical", "High", "Medium", "Low"]);
let failures = 0;

for (const caseId of readdirSync(root).filter((n) => /^STRESS-\d+$/.test(n)).sort()) {
  const dir = resolve(root, caseId);
  const names = readdirSync(dir).filter((n) => /\.(?:csv|tsv|xlsx|sqlplan)$/i.test(n)).sort();
  const files = names.map((n) => new File([readFileSync(resolve(dir, n))], n));
  const result = await processInputFiles(files as never, options as never);
  const problems: string[] = [];

  if (result.type === "error") {
    console.log(`FAIL  ${caseId}  pipeline error: ${result.errors.join("; ")}`);
    failures += 1;
    continue;
  }
  const report = result.report;
  const spec = EXPECT[caseId];
  const byRule = (id: string) => report.findings.filter((f) => f.ruleId === id);

  if (result.errors.length) problems.push(`unexpected parse errors: ${result.errors.join("; ")}`);

  for (const want of spec?.findings ?? []) {
    const hits = byRule(want.ruleId).filter((f) =>
      (!want.severity || f.severity === want.severity) &&
      (!want.confidence || f.confidence === want.confidence) &&
      (!want.titleIncludes || f.title.toLowerCase().includes(want.titleIncludes.toLowerCase())));
    if (want.count !== undefined) {
      if (byRule(want.ruleId).length !== want.count) problems.push(`${want.ruleId}: expected ${want.count}, got ${byRule(want.ruleId).length}`);
    } else if (!hits.length) {
      problems.push(`missing ${want.ruleId}${want.severity ? ` (${want.severity})` : ""}${want.titleIncludes ? ` ~"${want.titleIncludes}"` : ""}`);
    }
  }
  for (const id of spec?.absent ?? []) if (byRule(id).length) problems.push(`unexpected ${id} (${byRule(id).length})`);
  for (const r of spec?.notEvaluatedRulesInclude ?? []) if (!report.dataQuality.notEvaluatedRules.includes(r)) problems.push(`notEvaluatedRules missing "${r}"`);
  if (spec?.notEvaluatedFindingCount !== undefined) {
    const count = report.findings.filter((finding) => finding.severity === "Not Evaluated").length;
    if (count !== spec.notEvaluatedFindingCount) problems.push(`Not Evaluated findings: expected ${spec.notEvaluatedFindingCount}, got ${count}`);
  }
  for (const c of spec?.unknownColumnsInclude ?? []) if (!report.dataQuality.unknownColumns.includes(c)) problems.push(`unknownColumns missing "${c}"`);
  for (const w of spec?.dqWarningIncludes ?? []) if (!report.dataQuality.warnings.some((x) => x.includes(w))) problems.push(`dq warnings missing "${w}"`);
  for (const r of spec?.relatedIncludes ?? []) {
    const ok = byRule(r.ruleId).some((f) => (f.relatedFindings ?? []).some((rf: { reason: string }) => rf.reason.includes(r.reasonIncludes)));
    if (!ok) problems.push(`${r.ruleId} not related via "${r.reasonIncludes}"`);
  }
  for (const id of spec?.relatedEmpty ?? []) if (byRule(id).some((f) => (f.relatedFindings ?? []).length)) problems.push(`${id} should have no related findings`);
  if (spec?.maxActionableFindings !== undefined) {
    const n = report.findings.filter((f) => ACTIONABLE.has(f.severity)).length;
    if (n > spec.maxActionableFindings) problems.push(`${n} actionable findings > allowed ${spec.maxActionableFindings}`);
  }

  const sev = Object.fromEntries(["Critical", "High", "Medium", "Low", "Informational", "Not Evaluated"].map((s) => [s, report.findings.filter((f) => f.severity === s).length]));
  const line = `${caseId}  C${sev.Critical} H${sev.High} M${sev.Medium} L${sev.Low} I${sev.Informational} NE${sev["Not Evaluated"]}  ::  ${report.findings.filter((f) => f.severity !== "Not Evaluated").slice(0, 3).map((f) => f.ruleId).join(", ")}`;
  if (problems.length) { console.log(`FAIL  ${line}\n        - ${problems.join("\n        - ")}`); failures += 1; }
  else console.log(`PASS  ${line}`);
}

console.log(`\n${failures ? failures + " case(s) FAILED" : "all stress cases passed"}`);
process.exit(failures ? 1 : 0);
