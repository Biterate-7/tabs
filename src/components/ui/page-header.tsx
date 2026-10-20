import type { ReactNode } from "react"
import { PanelLeftOpen } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { cn } from "@/lib/utils"

/**
 * The bar every destination opens with: 48px, sticky, translucent over the
 * page so content scrolls under it rather than being cut by it.
 *
 *     [≡]  Library                                   [actions]
 *
 * `title` is the destination's name at the bar's size; a page that wants a
 * large title says it again in its own content (Home's greeting, a project's
 * name) — the bar keeps the place, the page keeps the voice. Below `md` the
 * sidebar is a drawer, so the bar carries its button.
 */
export function PageHeader({
  title,
  leading,
  actions,
  onOpenSidebar,
  className,
  children,
}: {
  title?: ReactNode
  /** Before the title: a back button, a breadcrumb. */
  leading?: ReactNode
  actions?: ReactNode
  onOpenSidebar?: () => void
  className?: string
  /** A second row under the bar: tabs, filters. */
  children?: ReactNode
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-(--hb-z-sticky) border-b border-subtle bg-[color-mix(in_oklab,var(--background)_82%,transparent)] backdrop-blur-md backdrop-saturate-150",
        className
      )}
    >
      <div className="flex h-12 items-center gap-2 px-3 sm:px-4">
        {onOpenSidebar && (
          <IconButton aria-label="Open sidebar" className="md:hidden" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </IconButton>
        )}
        {leading}
        {title && <div className="min-w-0 truncate text-h2 text-foreground">{title}</div>}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
      {children}
    </header>
  )
}
