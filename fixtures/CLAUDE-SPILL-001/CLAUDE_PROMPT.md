# SQL Evaluate Black-Box Review: Spill Triage

You are evaluating SQL Evaluate as a DBA-facing product. Use the running application and only the evidence files in this folder.

Do not inspect application source code, automated tests, git history, or other fixtures to determine expected behavior. There is no answer key in this package. Base every conclusion on what the application displays and on the supplied evidence.

## Product boundaries

SQL Evaluate is an offline, local browser application. It must not connect to SQL Server, execute SQL, remove plans from cache, or make server changes.

The evidence represents a DBA export from a spill-focused `sp_BlitzCache` investigation plus several execution-plan files whose relevance has not been established for you.

## Exercise

1. Open SQL Evaluate and start a new **Spill Triage** case.
2. Import `blitzcache-evidence.csv`.
3. Review the complete candidate list and Data Quality information before importing any plan.
4. Record:
   - Which candidate SQL Evaluate asks you to investigate first.
   - The exact imported values and comparison rule used to justify that position.
   - Whether the candidate with the greatest cumulative impact is also the candidate with the greatest per-execution severity.
   - What the application says the imported row count does and does not prove.
   - How rows with missing, zero, malformed, or warning-only spill values are handled.
   - Whether cached plan variants remain distinguishable when query-level identity overlaps.
5. Import `evidence-a.sqlplan`, `evidence-b.sqlplan`, and `evidence-c.sqlplan`. You may import them one at a time if that makes changes in correlation state easier to observe.
6. Select relevant candidates and record:
   - Which plans, if any, become correlated.
   - The stable identifiers and match quality the application displays.
   - Any plan that remains ambiguous or uncorrelated and why.
   - Whether similar or partially overlapping query identity is incorrectly treated as a proven match.
7. For every correlated plan, distinguish compile-time evidence from runtime evidence.
8. Where actual runtime evidence is available, record:
   - Each spilling operator and node ID.
   - Spill pages or volume, spill level, thread count, and memory-grant details when supplied.
   - The earliest major row-estimate error identified as feeding the spill, including its estimated and actual rows.
9. Inspect any cache-removal command text and report whether SQL Evaluate presents it as provenance, routine remediation, or an executable action.
10. Exercise the candidate table with keyboard-only navigation and at a narrow browser width. Note missing labels, focus problems, horizontal-only primary information, or states conveyed only by color.

## Report format

Return a concise product-evaluation report with these sections:

1. **Candidate selection**
2. **Plan correlation**
3. **Actual versus estimated evidence**
4. **Data Quality and safety**
5. **Accessibility and usability**
6. **Defects or misleading claims**

For every defect, include reproduction steps, the displayed evidence, expected safe behavior, and severity. Do not describe a candidate as a proven root cause unless the supplied evidence actually establishes causation.
