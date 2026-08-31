"use client"

import { useState } from "react"
import { Loader2, FolderTree, Copy as DuplicateIcon, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { resolveUncertainTab } from "@/lib/organize/edit"
import { describeOrganizationCounts } from "@/lib/organize/summarize"
import type { OrganizationPlan } from "@/lib/organize/types"
import type { Tab } from "@/lib/tabs/types"

const MAX_SAMPLE_TABS = 5
const MAX_UNCERTAIN_ROWS = 8

function tabLabel(tab: Tab | undefined, tabId: string): string {
  if (!tab) return tabId
  return tab.title?.trim() || tab.domain
}

/**
 * Standalone card offering a just-analyzed Auto-Organize plan for review —
 * shown automatically after an import, or on demand via the "Organize"
 * button (see workspace-header.tsx). This is the only AI-facing surface
 * left in TabDump: no chat, nothing to type — the user only ever approves,
 * edits (via the uncertain-tab quick-decision buttons), or dismisses a plan
 * that was already computed for them.
 */
export function AutoOrganizePanel({
  plan,
  tabsById,
  isApplying,
  onApply,
  onDismiss,
}: {
  plan: OrganizationPlan
  tabsById: Map<string, Tab>
  isApplying: boolean
  onApply: (editedPlan: OrganizationPlan) => void
  onDismiss: () => void
}) {
  const [editedPlan, setEditedPlan] = useState<OrganizationPlan>(plan)
  const { workspaceCount, groupCount, tabCount } = describeOrganizationCounts(editedPlan)

  function handleResolve(tabId: string, choice: { workspaceId?: string; name: string }) {
    setEditedPlan((prev) => resolveUncertainTab(prev, tabId, choice))
  }

  return (
    <div className="mb-6 space-y-3 rounded-lg border border-subtle bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-label text-tertiary">
          <FolderTree className="size-3.5" aria-hidden />
          Suggested organization
        </div>
        <IconButton aria-label="Dismiss suggestion" onClick={onDismiss} disabled={isApplying} className="size-6">
          <X className="size-3.5" />
        </IconButton>
      </div>

      <p className="text-body-sm text-foreground">{editedPlan.summary}</p>

      {editedPlan.workspaces.length > 0 && (
        <ul className="max-h-80 space-y-3 overflow-y-auto">
          {editedPlan.workspaces.map((workspace, i) => (
            <li key={i} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 break-words text-body-sm font-medium text-foreground">{workspace.proposedName}</span>
                <span className="shrink-0 text-meta text-tertiary">
                  {workspace.tabs.length} tab{workspace.tabs.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {workspace.tabs.slice(0, MAX_SAMPLE_TABS).map((t) => (
                  <li key={t.tabId} className="min-w-0 truncate text-meta text-tertiary">
                    · {tabLabel(tabsById.get(t.tabId), t.tabId)}
                  </li>
                ))}
                {workspace.tabs.length > MAX_SAMPLE_TABS && (
                  <li className="text-meta text-tertiary">· +{workspace.tabs.length - MAX_SAMPLE_TABS} more</li>
                )}
              </ul>
              {workspace.groups && workspace.groups.length > 0 && (
                <ul className="mt-1 space-y-1 border-l border-subtle pl-2">
                  {workspace.groups.map((group, gi) => (
                    <li key={gi} className="min-w-0">
                      <div className="break-words text-meta font-medium text-foreground">
                        {group.proposedName} · {group.tabIds.length} tab{group.tabIds.length === 1 ? "" : "s"}
                        {group.existingGroupId ? " (existing)" : ""}
                      </div>
                      <ul className="mt-0.5 space-y-0.5">
                        {group.tabIds.slice(0, MAX_SAMPLE_TABS).map((tabId) => (
                          <li key={tabId} className="min-w-0 truncate text-meta text-tertiary">
                            · {tabLabel(tabsById.get(tabId), tabId)}
                          </li>
                        ))}
                        {group.tabIds.length > MAX_SAMPLE_TABS && (
                          <li className="text-meta text-tertiary">· +{group.tabIds.length - MAX_SAMPLE_TABS} more</li>
                        )}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {editedPlan.uncertainTabs.length > 0 && (
        <div className="space-y-1.5 border-t border-subtle pt-2">
          <p className="text-label text-tertiary">
            {editedPlan.uncertainTabs.length} uncertain tab{editedPlan.uncertainTabs.length === 1 ? "" : "s"}
          </p>
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {editedPlan.uncertainTabs.slice(0, MAX_UNCERTAIN_ROWS).map((uncertain) => (
              <li key={uncertain.tabId} className="min-w-0 space-y-1">
                <p className="truncate text-body-sm text-foreground">{tabLabel(tabsById.get(uncertain.tabId), uncertain.tabId)}</p>
                <p className="truncate text-meta text-tertiary">Currently in &ldquo;{uncertain.currentWorkspaceName}&rdquo;</p>
                <div className="flex flex-wrap gap-1.5">
                  {uncertain.suggestions.map((s, si) => (
                    <button
                      key={si}
                      type="button"
                      onClick={() => handleResolve(uncertain.tabId, s)}
                      disabled={isApplying}
                      className="rounded-full border border-subtle px-2 py-0.5 text-meta text-foreground transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                    >
                      {s.name.startsWith("Keep in") ? "Keep" : s.name}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {editedPlan.uncertainTabs.length > MAX_UNCERTAIN_ROWS && (
            <p className="text-meta text-tertiary">+{editedPlan.uncertainTabs.length - MAX_UNCERTAIN_ROWS} more not shown.</p>
          )}
        </div>
      )}

      {editedPlan.duplicates.length > 0 && (
        <p className="flex items-center gap-1.5 text-meta text-tertiary">
          <DuplicateIcon className="size-3.5" aria-hidden />I found {editedPlan.duplicates.length} likely duplicate tab group{editedPlan.duplicates.length === 1 ? "" : "s"}.
        </p>
      )}

      {workspaceCount > 0 && (
        <p className="text-body-sm text-tertiary">
          {workspaceCount} workspace{workspaceCount === 1 ? "" : "s"}
          {groupCount > 0 ? ` and ${groupCount} group${groupCount === 1 ? "" : "s"}` : ""} would be created or updated. {tabCount} tab
          {tabCount === 1 ? "" : "s"} would be reorganized.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onApply(editedPlan)} disabled={isApplying || workspaceCount === 0}>
          {isApplying && <Loader2 className="animate-spin" aria-hidden />}
          Apply organization
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={isApplying}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
