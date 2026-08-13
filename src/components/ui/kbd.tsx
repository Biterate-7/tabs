import { cn } from "@/lib/utils"

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
        "inline-flex items-center gap-0.5 rounded-md border border-subtle bg-card px-1.5 py-0.5 text-meta text-tertiary",
        className
      )}
    >
      {parts.map((key, i) => (
        <span key={i}>{key}</span>
      ))}
    </kbd>
  )
}
