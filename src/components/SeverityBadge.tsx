import type { Severity } from "../types";

const symbols: Record<Severity, string> = { High: "!", Medium: "▲", Low: "●", Informational: "i", "Not Evaluated": "—" };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`severity severity-${severity.toLowerCase().replace(" ", "-")}`}><span aria-hidden="true">{symbols[severity]}</span>{severity}</span>;
}
