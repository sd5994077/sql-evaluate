/* ------------------------------------------------------------------------- *
 * SQL Evaluate -- Browser-pane injection helpers
 *
 * SQL Evaluate has NO drag-drop path that works when driven programmatically:
 * every import is a hidden <input type="file">, and the Browser pane cannot
 * service the OS file-open dialog that a real click would raise. So we set
 * `input.files` directly with a DataTransfer and fire `change`.
 *
 * HOW TO USE (from a Claude Code session driving the Browser pane):
 *   1. Base64 a fixture in Bash:   base64 -w0 <fixture-path>
 *   2. Paste THIS whole file as the `text` of one mcp__Claude_Browser__javascript_tool call.
 *   3. Then call javascript_tool again with:
 *        window.__sqleval.injectFile("<BASE64>", "evidence.csv", "text/csv");
 *      Repeat for plan files with type "text/xml".
 *
 * Screenshots of this app come back blank in the Browser pane -- use
 * mcp__Claude_Browser__read_page / get_page_text / this tool to observe state.
 * ------------------------------------------------------------------------- */
(() => {
  const IMPORT_SELECTOR = '[data-testid="spill-triage-evidence-input"]';

  const b64ToFile = (b64, name, type) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type });
  };

  // Fail closed: never guess among the app's other hidden file inputs.
  const findImportInput = () => {
    const inputs = [...document.querySelectorAll(IMPORT_SELECTOR)];
    if (inputs.length !== 1) {
      throw new Error(
        `expected exactly one Spill Triage importer (${IMPORT_SELECTOR}); found ${inputs.length}`,
      );
    }
    return inputs[0];
  };

  const acceptsFile = (input, name) => {
    const normalizedName = name.toLowerCase();
    const extensions = input.accept
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.startsWith("."));
    return extensions.some((extension) => normalizedName.endsWith(extension));
  };

  const injectFile = (b64, name, type = "application/octet-stream") => {
    const input = findImportInput();
    if (!acceptsFile(input, name)) {
      throw new Error(`unsupported file for Spill Triage importer: ${name}`);
    }
    const dt = new DataTransfer();
    const file = b64ToFile(b64, name, type);
    dt.items.add(file);
    Object.defineProperty(input, "files", { value: dt.files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      status: "event-dispatched",
      targeted: IMPORT_SELECTOR,
      accepts: input.accept,
      file: name,
      bytes: file.size,
    };
  };

  window.__sqleval = { injectFile, findImportInput };
  return "sqleval inject helpers ready: window.__sqleval.injectFile(b64, name, type)";
})();
