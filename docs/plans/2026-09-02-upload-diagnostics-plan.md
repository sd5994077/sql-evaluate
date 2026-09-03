# Upload diagnostics and recovery plan

## Purpose

Make every local file import explain whether the file was accepted, skipped, preserved but unusable, or rejected. Messages must remain safe for captures and execution plans that may contain PHI or other sensitive data: never echo SQL text, XML attribute values, workbook cell contents, identifiers, or parser excerpts.

## Implemented baseline

- Reject empty and unsupported files before parsing.
- Process multi-file Deep Analysis imports independently so one unreadable file does not discard valid files selected with it.
- Report content-hash duplicates explicitly and explain that renaming does not bypass duplicate detection.
- Distinguish escaped Showplan XML, undecodable encoding, malformed XML, a missing ShowPlanXML root, and a plan with no supported statements.
- Report when Showplan parsed successfully but lacks correlation-ready stable identity.
- Display privacy-safe Deep Analysis import results in the application instead of leaving them only in hidden case provenance.
- Preserve invalid plan attachments in the sensitive working case for provenance while excluding them from plan assertions.

## Future functionality

- Add a local-only import inspector showing filename, size, detected format, encoding, parse state, statement count, and identity-field presence without displaying values.
- Offer an explicit local conversion preview for escaped Showplan XML; never transform or save it without user confirmation.
- Detect UTF-16 without a byte-order mark and other common SQL tooling encodings before asking the user to resave.
- Add a retry action for failed artifacts while retaining an auditable event history.
- Show which identity fields are present on the selected spill row and plan statement, plus the exact non-sensitive reason correlation was accepted or blocked.
- Add bounded support for namespace-prefixed Showplan roots and document supported SQL Server Showplan versions.
- Add accessible per-file progress and result summaries for large multi-file selections.
- Add telemetry-free diagnostic export containing only error codes, app version, file metadata, and structural booleans; require explicit user review before saving.

## Acceptance criteria for later work

- No diagnostic message contains source data or identifier values.
- Each selected file produces one visible terminal state: imported, skipped, preserved but unusable, or rejected.
- A failed file cannot prevent unrelated valid files in the same selection from importing.
- The user can distinguish XML validity from stable-identity correlation without opening developer tools.
- All behavior works offline and survives a case save/open round trip where applicable.
