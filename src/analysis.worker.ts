/// <reference lib="webworker" />
import { processInputFiles } from "./lib/processFiles";
import type { AnalysisWorkerRequest } from "./types";

function runtimeError(error: unknown): string {
  return `Worker runtime phase failed: ${error instanceof Error ? error.message : String(error || "Unknown worker error")}`;
}

self.onmessage = async (event: MessageEvent<AnalysisWorkerRequest>) => {
  try {
    const result = await processInputFiles(event.data.files, {
      onProgress: (fileName) => self.postMessage({ type: "progress", fileName }),
      thresholdProfile: event.data.thresholdProfile,
    });
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ type: "error", errors: [runtimeError(error)] });
  }
};

self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  self.postMessage({ type: "error", errors: [runtimeError(event.reason)] });
});
