import { cn } from "@/lib/utils"

/**
 * A key cap: 11px on the card tone, 4px corner, no border — the ⌘K chip
 * that sits inside the reference's search field.
 */
export function Kbd({
  keys,
  children,
  className,
}: {
  keys?: string[]
  children?: React.ReactNode
  className?: string
}) {
  const parts = keys ?? (children ? [String(children)] : [])
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-xs bg-surface-active px-1 font-sans text-meta text-muted-foreground",
        className
      )}
    >
      {parts.map((key, i) => (
        <span key={i}>{key}</span>
      ))}
    </kbd>
  )
}
