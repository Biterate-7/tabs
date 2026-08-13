import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Icon className="size-6 text-tertiary" aria-hidden />
      <div className="space-y-1">
        <p className="text-body font-medium text-foreground">{title}</p>
        {description && (
          <p className="text-body-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
