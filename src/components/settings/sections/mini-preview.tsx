import { FolderGit2, Link2, Search } from "lucide-react"

/**
 * A miniature TabDump composed from the same semantic Tailwind classes the
 * real UI uses — sidebar sliver, workspace switcher, tab cards, a graph
 * node/edge, a notes snippet, buttons, an input, and success/error text.
 * Because edits in the Custom tab already apply globally the moment they're
 * made (see use-appearance.ts), this needs no special wiring to stay live —
 * it just re-renders against whatever the current CSS vars resolve to.
 */
export function MiniPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-border shadow-md">
      <div className="flex h-64 bg-background text-foreground">
        <div className="flex w-16 flex-col gap-2 border-r border-subtle bg-background-secondary p-2">
          <div className="rounded-md bg-surface-selected px-1.5 py-1 text-center text-[0.55rem] font-medium text-foreground">Work</div>
          <div className="rounded-md px-1.5 py-1 text-center text-[0.55rem] text-muted-foreground">Personal</div>
          <div className="mt-auto flex items-center justify-center gap-1 rounded-md bg-surface-hover px-1.5 py-1 text-[0.55rem] text-muted-foreground">
            <FolderGit2 className="size-2.5" /> Graph
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-2 p-3">
          <div className="flex items-center gap-1.5 rounded-md border border-subtle bg-card px-2 py-1">
            <Search className="size-3 text-tertiary" />
            <span className="text-[0.6rem] text-muted-foreground">Search tabs…</span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-surface-selected px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-accent-subtle">
                <Link2 className="size-2 text-accent-text" />
              </span>
              <span className="truncate text-[0.65rem] font-medium text-foreground">Selected tab card</span>
            </div>
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[0.55rem] font-medium text-primary-foreground">Active</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg bg-card px-2 py-1.5">
            <span className="size-3.5 shrink-0 rounded-full bg-surface-hover" />
            <span className="truncate text-[0.65rem] text-muted-foreground">Another tab</span>
          </div>

          <svg viewBox="0 0 100 28" className="h-7 w-full">
            <line x1="8" y1="14" x2="50" y2="14" stroke="var(--graph-edge)" strokeWidth="1.5" opacity="0.6" />
            <line x1="50" y1="14" x2="92" y2="6" stroke="var(--graph-edge)" strokeWidth="1.5" opacity="0.6" />
            <circle cx="8" cy="14" r="4" fill="var(--graph-node)" />
            <circle cx="50" cy="14" r="5" fill="var(--graph-node-selected)" stroke="var(--background)" strokeWidth="1.5" />
            <circle cx="92" cy="6" r="4" fill="var(--graph-node)" />
          </svg>

          <div className="rounded-md bg-editor-background p-1.5">
            <p className="text-[0.6rem] font-medium text-foreground">Notes</p>
            <p className="mt-0.5 text-[0.55rem] text-editor-placeholder">Start writing…</p>
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-primary px-2 py-1 text-[0.6rem] font-medium text-primary-foreground">Primary</span>
            <span className="rounded-md border border-border bg-background px-2 py-1 text-[0.6rem] text-foreground">Secondary</span>
            <span className="rounded-md bg-success-subtle px-2 py-1 text-[0.6rem] text-success">Success</span>
            <span className="rounded-md bg-error-subtle px-2 py-1 text-[0.6rem] text-error">Error</span>
          </div>
        </div>
      </div>
    </div>
  )
}
