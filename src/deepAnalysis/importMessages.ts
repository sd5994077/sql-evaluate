import type { EvidenceImportMessage } from "./types";

export function isPlanImportMessage(message: EvidenceImportMessage): boolean {
  return message.code === "plan-invalid"
    || message.code === "plan-identity-missing"
    || /\.(?:sqlplan|xml)$/i.test(message.fileName);
}
