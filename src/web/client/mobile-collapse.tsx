import React, { useState } from "react";

/**
 * A settings section that shows its current choice and opens on demand.
 *
 * The phone's 设置 page had a model list and a session list that could run for
 * screens of rows while the user came for one switch; the collapsed header
 * keeps the answer ("which model / which session") and hides the rest.
 */
export function MobileCollapse({ label, summary, ariaLabel, children, defaultOpen = false }: {
  label: string;
  /** What the section is currently set to, shown next to the label. */
  summary?: string;
  ariaLabel?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return <>
    <button type="button" className={`m-collapse ${open ? "open" : ""}`}
      aria-expanded={open} aria-label={ariaLabel ?? label} onClick={() => setOpen(current => !current)}>
      <span className="m-collapse-label">{label}</span>
      {summary && <span className="m-collapse-summary">{summary}</span>}
      <span className="m-collapse-mark" aria-hidden="true">{open ? "▴" : "▾"}</span>
    </button>
    {open && <div className="m-collapse-body">{children}</div>}
  </>;
}
