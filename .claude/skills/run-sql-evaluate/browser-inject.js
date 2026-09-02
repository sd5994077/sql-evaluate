/* ------------------------------------------------------------------------- *
 * SQL Evaluate -- Browser-pane injection helpers
 *
 * SQL Evaluate has NO drag-drop path that works when driven programmatically:
 * every import is a hidden <input type="file">, and the Browser pane cannot
 * service the OS file-open dialog that a real click would raise. So we set
 * `input.files` directly with a DataTransfer and fire `change`.
 *
 * HOW TO USE (from a Claude Code session driving the Browser pane):
 *   1. Base64 a fixture in Bash:   base64 -w0 fixtures/CLAUDE-SPILL-001/blitzcache-evidence.csv
 *   2. Paste THIS whole file as the `text` of one mcp__Claude_Browser__javascript_tool call.
 *   3. Then call javascript_tool again with:
 *        window.__sqleval.injectFile("<BASE64>", "blitzcache-evidence.csv", "text/csv");
 *      Repeat for evidence-a/b/c.sqlplan with type "text/xml".
 *
 * Screenshots of this app come back blank in the Browser pane -- use
 * mcp__Claude_Browser__read_page / get_page_text / this tool to observe state.
 * ------------------------------------------------------------------------- */
(() => {
  const b64ToFile = (b64, name, type) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type });
  };

  // Pick the Stage-1 Spill Triage / Stage-2 plan importer, NOT the landing-page
  // dropzone (which also accepts .zip/.json and treats a CSV as a who-is-active
  // capture) and NOT the InvestigationGuide input (#guide-evidence-input).
  // The one we want: accepts .sqlplan, rejects .zip/.json, has no id.
  const findImportInput = () => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    return (
      inputs.find(
        (i) =>
          /\.sqlplan/.test(i.accept) &&
          !/\.zip/.test(i.accept) &&
          !/\.json/.test(i.accept) &&
          !i.id,
      ) ||
      inputs.find((i) => /\.sqlplan/.test(i.accept) && !i.id) ||
      inputs[0]
    );
  };

  const injectFile = (b64, name, type = "application/octet-stream") => {
    const input = findImportInput();
    if (!input) throw new Error("no <input type=file> found -- is a Spill Triage case open?");
    const dt = new DataTransfer();
    dt.items.add(b64ToFile(b64, name, type));
    Object.defineProperty(input, "files", { value: dt.files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { targeted: input.accept, file: name, bytes: atob(b64).length };
  };

  window.__sqleval = { injectFile, findImportInput };
  return "sqleval inject helpers ready: window.__sqleval.injectFile(b64, name, type)";
})();
