import { useRef, useState } from "react";

interface Props { disabled: boolean; onFiles(files: File[]): void; }

export function DropZone({ disabled, onFiles }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return <div
    className={`drop-zone ${dragging ? "dragging" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); if (!disabled) onFiles([...event.dataTransfer.files]); }}
  >
    <div className="drop-glyph" aria-hidden="true"><span>SQL</span></div>
    <div><strong>Drop a capture, plan, or saved case</strong><p>CSV · XLSX · SQLPLAN · XML · SQLEVAL.JSON · SQLEVALCASE.ZIP</p></div>
    <button className="button button-primary" disabled={disabled} onClick={() => input.current?.click()}>Choose files</button>
    <input ref={input} hidden multiple type="file" accept=".csv,.tsv,.xlsx,.xls,.sqlplan,.xml,.json,.sqleval.json,.sqlevalcase.zip,.zip" onChange={(event) => { onFiles([...event.target.files ?? []]); event.target.value = ""; }} />
  </div>;
}
