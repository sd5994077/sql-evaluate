import type { CaseDetails, DeepAnalysisCase } from "./types";

export function validateCaseDetails(value: unknown): CaseDetails {
  if (!value || typeof value !== "object") throw new Error("Case details must be an object.");
  const fields = value as Partial<CaseDetails>;
  if (typeof fields.title !== "string" || !fields.title.trim() || fields.title.length > 200) throw new Error("Case title must contain 1–200 characters.");
  if (typeof fields.ticketReference !== "string" || fields.ticketReference.length > 200) throw new Error("Ticket reference must be at most 200 characters.");
  if (typeof fields.notes !== "string" || fields.notes.length > 20_000) throw new Error("Case notes must be at most 20,000 characters.");
  if (!["Investigating", "Waiting for evidence", "Closed"].includes(fields.status ?? "")) throw new Error("Case status is invalid.");
  return { title: fields.title.trim(), ticketReference: fields.ticketReference, notes: fields.notes, status: fields.status! };
}

export function updateCaseDetails(deepCase: DeepAnalysisCase, value: unknown, now = new Date().toISOString()): DeepAnalysisCase {
  const details = validateCaseDetails(value);
  if (details.title === deepCase.title && details.ticketReference === (deepCase.ticketReference ?? "") && details.notes === (deepCase.notes ?? "") && details.status === (deepCase.status ?? "Investigating")) return deepCase;
  return { ...deepCase, ...details, schemaVersion: "1.5", updatedAt: now, events: [...deepCase.events, { occurredAt: now, type: "Case details changed", summary: "Human case details updated; diagnostic evidence states are unchanged." }] };
}
