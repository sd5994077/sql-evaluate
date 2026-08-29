/// <reference lib="webworker" />
import { processInputFiles } from "./lib/processFiles";

function runtimeError(error: unknown): string {
  return `Worker runtime phase failed: ${error instanceof Error ? error.message : String(error || "Unknown worker error")}`;
}

self.onmessage = async (event: MessageEvent<{ files: File[] }>) => {
  try {
    const result = await processInputFiles(event.data.files, {
      onProgress: (fileName) => self.postMessage({ type: "progress", fileName }),
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
