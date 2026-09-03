# SQL Evaluate Black-Box Review: Spill Triage Identity and Workbook Variance

You are independently evaluating SQL Evaluate as a DBA-facing product. Use only the running application and the evidence files in this folder.

Do not inspect application source code, automated tests, git history, other fixture folders, prior conversations, or generated implementation plans. Do not inspect a saved case ZIP directly; reopen it through SQL Evaluate. Base every conclusion on behavior you personally observe in the application.

SQL Evaluate is intended to operate entirely offline. It must not connect to SQL Server, execute SQL, remove plans from cache, or make server changes.

## Exercise

1. Open SQL Evaluate and start a new **Spill Triage** case.
2. Import `spill-review.xlsx` without importing any plans.
3. Review the candidate list and Data Quality section completely.
4. Record:
   - Which workbook sheets were recognized as spill evidence and which were ignored.
   - Whether the application found a header below the beginning of a worksheet.
   - The imported and rankable row counts.
   - The complete ranking order and the displayed reason for the first candidate.
   - How an exact ranking tie was resolved.
   - Whether the highest cumulative candidate is also the highest per-execution candidate.
   - How total-backed, average-only, zero, malformed, warning-only, invalid-time, and explicitly unit-labeled spill values were handled.
   - Whether unknown columns were disclosed or preserved.
   - Whether cached plan variants sharing query-level identity remained distinguishable.
   - The precise statement about what importing exactly ten rows does and does not prove.
5. Inspect any cache-removal text. Determine whether it is presented as provenance, advice, or an executable action.
6. Import `evidence-a.sqlplan` through `evidence-e.sqlplan` one at a time, in filename order.
7. After each import, inspect every candidate that could plausibly relate to the new evidence. Record:
   - Which candidate, plan, and statement connected.
   - The displayed match quality and exact identity explanation.
   - Every candidate that remained ambiguous or uncorrelated.
   - Whether conflicting identifiers blocked a connection.
   - Whether query-hash-only or similar SQL text was incorrectly accepted as proof.
   - Whether two plan variants sharing a query hash remained separate.
8. For every connected plan, distinguish compile-time evidence from runtime evidence.
9. For actual runtime evidence, record:
   - The spilling operator and node ID.
   - Spill level, thread count, pages written and read, and memory-grant details.
   - Every unavailable metric that remained labeled as unavailable.
   - The feeding estimate error, its estimated and actual rows, and its distance from the spill.
   - Whether evidence from another statement in the same plan was incorrectly attributed to the matched statement.
10. Save the case ZIP, reload the application, reopen the ZIP through SQL Evaluate, and verify that ranking, selected candidate, imported plans, correlation state, and Data Quality information survive.
11. Exercise candidate selection using Tab and Enter without clicking candidate buttons.
12. Repeat the important review steps at a 375×812 viewport. Check for page-level horizontal scrolling, inaccessible primary information, clipped controls, missing labels, focus loss, and states communicated only by color.
13. Review the browser console for application errors.

## Report Format

Return a concise report with these sections:

1. **Workbook import and candidate ranking**
2. **Plan correlation matrix**
3. **Actual versus estimated evidence**
4. **Persistence, Data Quality, and safety**
5. **Accessibility and narrow-screen usability**
6. **Defects or misleading claims**
7. **Overall verdict**

For the correlation matrix, include candidate, evidence filename, connection state, match quality, and the application’s displayed reason.

For every defect include:

- Severity: Critical, High, Medium, or Low
- Exact reproduction steps
- Observed behavior and displayed evidence
- Expected safe behavior
- DBA-facing impact

If no defect is found in an area, say so explicitly. Do not call any candidate a root cause unless the supplied evidence proves causation.
