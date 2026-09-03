// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface InjectResult {
  status: string;
  targeted: string;
  accepts: string;
  file: string;
  bytes: number;
}

interface SqlEvaluateHarness {
  findImportInput(): HTMLInputElement;
  injectFile(base64: string, name: string, type?: string): InjectResult;
}

const source = readFileSync(
  resolve(process.cwd(), ".claude/skills/run-sql-evaluate/browser-inject.js"),
  "utf8",
);

function installHarness(body: string) {
  document.body.innerHTML = body;
  class DataTransferStub {
    files: File[] = [];
    items = { add: (file: File) => { this.files.push(file); } };
  }
  Object.defineProperty(window, "DataTransfer", { value: DataTransferStub, configurable: true });
  window.eval(source);
  return (window as unknown as { __sqleval: SqlEvaluateHarness }).__sqleval;
}

const importer = '<input data-testid="spill-triage-evidence-input" type="file" accept=".csv,.sqlplan,.xml">';

describe("browser injection harness", () => {
  it("selects only the stable Spill Triage importer", () => {
    const harness = installHarness(`<input type="file" accept=".csv,.zip">${importer}`);
    expect(harness.findImportInput().dataset.testid).toBe("spill-triage-evidence-input");
  });

  it("fails when the stable importer is missing or ambiguous", () => {
    const missing = installHarness('<input type="file" accept=".csv,.zip">');
    expect(() => missing.findImportInput()).toThrow(/found 0/);

    const duplicate = installHarness(`${importer}${importer}`);
    expect(() => duplicate.findImportInput()).toThrow(/found 2/);
  });

  it("rejects unsupported filenames before dispatch", () => {
    const harness = installHarness(importer);
    expect(() => harness.injectFile("e30=", "case.zip", "application/zip")).toThrow(/unsupported file/);
  });

  it("dispatches a supported file and reports dispatch-only status", () => {
    const harness = installHarness(importer);
    const input = harness.findImportInput();
    let changes = 0;
    input.addEventListener("change", () => { changes += 1; });

    const result = harness.injectFile("YSxi", "evidence.csv", "text/csv");

    expect(changes).toBe(1);
    expect(result).toMatchObject({
      status: "event-dispatched",
      targeted: '[data-testid="spill-triage-evidence-input"]',
      file: "evidence.csv",
      bytes: 3,
    });
  });
});
