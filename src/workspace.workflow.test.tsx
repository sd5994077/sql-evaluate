// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { downloadBlob } from "./lib/report";
import { analyze } from "./rules/engine";
import { createDeepCaseArchive, createSpillTriageCase } from "./deepAnalysis/case";
import { prepareAnalysis, analyzePrepared } from "./lib/preparedAnalysis";
import type { PreparedAnalysis, PreviewWorkerRequest } from "./lib/preparedAnalysis";
import { updateCaseDetails } from "./deepAnalysis/metadata";

vi.mock("./lib/report", async (importOriginal) => ({ ...await importOriginal<typeof import("./lib/report")>(), downloadBlob: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.mocked(downloadBlob).mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function start() {
  const result = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Start Spill Triage" }));
  return result;
}
async function editNotes(notes: string) {
  fireEvent.click(screen.getByRole("button", { name: "Edit case details" }));
  fireEvent.change(screen.getByLabelText("Case notes"), { target: { value: notes } });
  fireEvent.click(screen.getByRole("button", { name: "Apply details" }));
}
function reportFile() {
  return new File([JSON.stringify(analyze([], [], []))], "replacement.sqleval.json");
}

describe("unfinished investigation workflow", () => {
  it("cancels a replacement without losing notes, then downloads the case before continuing", async () => {
    const { container } = await start();
    await editNotes("Private incident observations");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [reportFile()] } });
    const guard = await screen.findByRole("dialog", { name: "Protect unfinished work" });
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Case: Not yet downloaded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit case details" }));
    expect((screen.getByLabelText("Case notes") as HTMLTextAreaElement).value).toBe("Private incident observations");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(input, { target: { files: [reportFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Download and continue" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Edit case details" })).toBeNull());
    expect(vi.mocked(downloadBlob).mock.calls[0][0]).toMatch(/sqlevalcase.zip$/);
    expect(screen.getByText("Report: Opened from saved file")).toBeTruthy();
  });

  it("preserves current work when sensitive download is cancelled or fails", async () => {
    const { container } = await start();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    vi.mocked(confirm).mockReturnValue(false);
    fireEvent.change(input, { target: { files: [reportFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Download and continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Case: Not yet downloaded")).toBeTruthy();
    expect(downloadBlob).not.toHaveBeenCalled();
    vi.mocked(confirm).mockReturnValue(true);
    vi.mocked(downloadBlob).mockImplementation(() => { throw new Error("Download failed"); });
    fireEvent.change(input, { target: { files: [reportFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Download and continue" }));
    expect(await screen.findByText(/case could not be saved: Download failed/)).toBeTruthy();
    expect(screen.getByText("Case: Not yet downloaded")).toBeTruthy();
  });

  it("only working-case downloads checkpoint edits and installs a leave warning while dirty", async () => {
    await start();
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByText("Case: Not yet downloaded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save case ZIP" }));
    expect(await screen.findByText("Case: Download prepared")).toBeTruthy();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await editNotes("<script>literal notes</script>");
    expect(screen.getByText("Case: Changes since last download")).toBeTruthy();
    expect(document.querySelector(".case-notes script")).toBeNull();
  });

  it("opens a case as clean and leaves cancelled or duplicate-only previews unchanged", async () => {
    const original = updateCaseDetails(createSpillTriageCase(), { title: "Reopened incident", ticketReference: "", notes: "Keep these", status: "Closed" });
    const archive = await createDeepCaseArchive(original, []);
    const { container } = render(<App />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Choose files" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File([new Uint8Array(archive.bytes)], archive.fileName)] } });
    expect(await screen.findByText("Case: Opened from saved file")).toBeTruthy();
    const input = container.querySelector('[data-testid="spill-triage-evidence-input"]')!;
    const file = new File(["Total Spills,Plan Handle\n10,0xAAA"], "spills.csv");
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Import selected evidence" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Case: Opened from saved file")).toBeTruthy();
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Import selected evidence" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Import selected evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Save case ZIP" }));
    await screen.findByText("Case: Download prepared");
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText(/Identical evidence is already in this case/);
    expect((screen.getByRole("button", { name: "Import selected evidence" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Case: Download prepared")).toBeTruthy();
  });
});

describe("main analysis preview workflow", () => {
  function installWorker() {
    class LocalWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      batch: PreparedAnalysis | null = null;
      terminated = false;
      postMessage(request: PreviewWorkerRequest) {
        void (async () => {
          if (request.type === "discard") { this.batch = null; return; }
          if (request.type === "prepare") {
            this.batch = await prepareAnalysis(request.files, request.sheets);
            if (!this.terminated) this.onmessage?.({ data: { type: "prepared", requestId: request.requestId, previews: this.batch.previews } } as MessageEvent);
          } else {
            const report = await analyzePrepared(this.batch!, request.selectedIds, request.thresholdProfile);
            if (!this.terminated) this.onmessage?.({ data: { type: "complete", requestId: request.requestId, report, errors: [] } } as MessageEvent);
          }
        })();
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal("Worker", LocalWorker);
  }

  it("previews without replacing, appends original evidence, and guards the report", async () => {
    installWorker();
    const { container } = render(<App />);
    const button = await screen.findByRole("button", { name: "Choose files" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["session_id,collection_time\n51,2026-09-05T10:00:00Z"], "original.csv")] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Analyze selected files" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Report: Not yet downloaded")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Analyze selected files" }));
    await screen.findByText("Report: Not yet downloaded");
    fireEvent.change(input, { target: { files: [new File(["session_id,collection_time\n72,2026-09-05T10:00:02Z"], "additional.csv")] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Analyze selected files" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Import destination"), { target: { value: "append" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Analyze selected files" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("checkbox", { name: "original.csv" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Analyze selected files" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and continue" }));
    await screen.findByText("original.csv + additional.csv");
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const jsonCall = vi.mocked(downloadBlob).mock.calls.at(-1)!;
    expect(JSON.parse(String(jsonCall[1])).inputs.map((item: { fileName: string }) => item.fileName)).toEqual(["original.csv", "additional.csv"]);
    expect(screen.getByText("Report: Download prepared")).toBeTruthy();
  });
});
