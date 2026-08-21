import type { ReactNode } from "react"

export function Header({ workspaceSwitcher }: { workspaceSwitcher?: ReactNode }) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-5">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          TabDump
        </span>
        {workspaceSwitcher}
      </div>
    </header>
  )
}
