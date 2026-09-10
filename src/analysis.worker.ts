/// <reference lib="webworker" />
import { processInputFiles } from "./lib/processFiles";
import { prepareAnalysis, analyzePrepared } from "./lib/preparedAnalysis";
import type { PreparedAnalysis, PreviewWorkerRequest } from "./lib/preparedAnalysis";
import type { AnalysisWorkerRequest } from "./types";

let prepared: PreparedAnalysis | null = null;
let generation = 0;
let latestRequestId: number | undefined;
self.onmessage = async (event: MessageEvent<AnalysisWorkerRequest | PreviewWorkerRequest>) => {
  const request = event.data;
  const token = ++generation;
  latestRequestId = "requestId" in request ? request.requestId : undefined;
  try {
    if (!("type" in request)) {
      self.postMessage(await processInputFiles(request.files, { thresholdProfile: request.thresholdProfile }));
      return;
    }
    if (request.type === "discard") { prepared = null; return; }
    if (request.type === "prepare") {
      const batch = await prepareAnalysis(request.files, request.sheets, (fileName) => {
        if (token === generation) self.postMessage({ type: "progress", requestId: request.requestId, fileName });
      });
      if (token !== generation) return;
      prepared = batch;
      self.postMessage({ type: "prepared", requestId: request.requestId, previews: batch.previews });
    } else {
      if (!prepared) throw new Error("The import preview has expired. Select the files again.");
      const report = await analyzePrepared(prepared, request.selectedIds, request.thresholdProfile);
      if (token === generation) self.postMessage({ type: "complete", requestId: request.requestId, report, errors: [] });
    }
  } catch (error) {
    if (token === generation) self.postMessage({ type: "error", requestId: "requestId" in request ? request.requestId : undefined, errors: [`Worker processing failed: ${error instanceof Error ? error.message : String(error)}`] });
  }
};
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  self.postMessage({ type: "error", requestId: latestRequestId, errors: ["Worker runtime failed. Select the files again."] });
});
