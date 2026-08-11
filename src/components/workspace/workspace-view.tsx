import type { Tab } from "@/lib/tabs/types"

export function WorkspaceView({
  tabs,
}: {
  tabs: Tab[]
  onTabsChange: (tabs: Tab[]) => void
  onClear: () => void
}) {
  return <div className="p-6 text-foreground">{tabs.length} tabs</div>
}
