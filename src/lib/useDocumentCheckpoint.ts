import { useState } from "react";

export function useDocumentCheckpoint<T>(document: T | null) {
  const [checkpoint, setCheckpoint] = useState<{ value: T | null; downloadedAt: string | null }>({ value: null, downloadedAt: null });
  const dirty = document !== null && document !== checkpoint.value;
  return {
    dirty,
    label: dirty ? checkpoint.downloadedAt ? "Changes since last download" : "Not yet downloaded" : checkpoint.downloadedAt ? "Download prepared" : "Opened from saved file",
    downloadedAt: checkpoint.downloadedAt,
    loaded: (value: T) => setCheckpoint({ value, downloadedAt: null }),
    downloaded: (value: T) => setCheckpoint({ value, downloadedAt: new Date().toISOString() }),
    reset: () => setCheckpoint({ value: null, downloadedAt: null }),
  };
}
