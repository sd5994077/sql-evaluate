import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function WorkflowDialog({ title, children, onCancel }: { title: string; children: ReactNode; onCancel(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const previous = returnFocus.current;
    const dialog = ref.current!;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
    return () => { if (dialog.close) dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="workflow-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); cancelRef.current(); }}>
    <div className="workflow-heading"><div><span>SQL EVALUATE / WORKSPACE</span><h2>{title}</h2></div><button type="button" aria-label="Close dialog" onClick={onCancel}>×</button></div>
    {children}
  </dialog>;
}
