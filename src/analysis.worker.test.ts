import { File } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "./rules/thresholdProfiles";
import type { PreviewWorkerRequest } from "./lib/preparedAnalysis";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe("preview worker protocol", () => {
  it("keeps preparation separate from analysis and rejects discarded batches", async () => {
    const postMessage = vi.fn();
    const worker = { onmessage: null as null | ((event: MessageEvent<PreviewWorkerRequest>) => Promise<void>), postMessage, addEventListener: vi.fn() };
    vi.stubGlobal("self", worker);
    await import("./analysis.worker");
    await worker.onmessage!({ data: { type: "prepare", requestId: 7, files: [new File(["session_id,status\n51,running"], "activity.csv")], sheets: {} } } as MessageEvent<PreviewWorkerRequest>);
    expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: "prepared", requestId: 7 });
    expect(postMessage.mock.calls.some(([message]) => message.type === "complete")).toBe(false);
    await worker.onmessage!({ data: { type: "analyze", requestId: 7, selectedIds: ["0"], thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } } as MessageEvent<PreviewWorkerRequest>);
    expect(postMessage.mock.calls.at(-1)?.[0].errors).toEqual([]);
    expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: "complete", requestId: 7, report: { records: [expect.objectContaining({ sessionId: 51 })] } });
    await worker.onmessage!({ data: { type: "discard", requestId: 8 } } as MessageEvent<PreviewWorkerRequest>);
    await worker.onmessage!({ data: { type: "analyze", requestId: 8, selectedIds: ["0"], thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } } as MessageEvent<PreviewWorkerRequest>);
    expect(postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ type: "error", requestId: 8 });
  });

  it("does not publish late preparation after a discard", async () => {
    let release!: (value: ArrayBuffer) => void;
    const file = new File(["session_id,status\n51,running"], "slow.csv");
    vi.spyOn(file, "arrayBuffer").mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const postMessage = vi.fn();
    const worker = { onmessage: null as null | ((event: MessageEvent<PreviewWorkerRequest>) => Promise<void>), postMessage, addEventListener: vi.fn() };
    vi.stubGlobal("self", worker);
    await import("./analysis.worker");
    const preparation = worker.onmessage!({ data: { type: "prepare", requestId: 1, files: [file], sheets: {} } } as MessageEvent<PreviewWorkerRequest>);
    await worker.onmessage!({ data: { type: "discard", requestId: 2 } } as MessageEvent<PreviewWorkerRequest>);
    release(new TextEncoder().encode("session_id,status\n51,running").buffer);
    await preparation;
    expect(postMessage).not.toHaveBeenCalled();
  });
});
