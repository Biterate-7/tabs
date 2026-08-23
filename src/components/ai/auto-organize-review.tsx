"use client"

import { useState } from "react"
import { Loader2, FolderTree, Copy as DuplicateIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { resolveUncertainTab } from "@/lib/organize/edit"
import { describeOrganizationCounts } from "@/lib/organize/summarize"
import type { PendingOrganizePreview, OrganizationPlan } from "@/lib/ai/types"
import type { Tab } from "@/lib/tabs/types"

const MAX_SAMPLE_TABS = 5;
const MAX_UNCERTAIN_ROWS = 8;

function tabLabel(tab: Tab | undefined, tabId: string): string {
  if (!tab) return tabId;
  return tab.title?.trim() || tab.domain;
}

/**
 * Renders one proposed Auto-Organize plan inside the Ask TabDump
 * conversation — the Auto-Organize counterpart to ActionPreviewCard, kept
 * as its own component (rather than reusing ActionPreviewCard) per
 * AGENTS.md section 8's distinct review layout (per-workspace tab samples,
 * groups, an uncertain-tabs section with quick-decision buttons), while
 * still following the same visual language (border-subtle card, text-label
 * header, Apply/Cancel button pair).
 *
 * `onApply` receives the (possibly locally-edited, via uncertain-tab quick
 * decisions) plan to apply — see resolveUncertainTab. Everything here is
 * local component state until Apply is actually clicked; Cancel always
 * discards edits along with the whole proposal.
 */
export function AutoOrganizeReview({
  preview,
  tabsById,
  onApply,
  onCancel,
}: {
  preview: PendingOrganizePreview
  tabsById: Map<string, Tab>
  onApply: (editedPlan: OrganizationPlan) => void
  onCancel: () => void
}) {
  const [editedPlan, setEditedPlan] = useState<OrganizationPlan>(preview.plan)
  const isAwaiting = preview.status === "awaiting"
  const isApplying = preview.status === "applying"
  const isResolved = !isAwaiting && !isApplying

  const plan = isAwaiting || isApplying ? editedPlan : preview.plan

  if (plan.noopReason) {
    return (
      <div className="rounded-lg border border-subtle p-3">
        <div className="flex items-center gap-1.5 text-label text-tertiary">
          <FolderTree className="size-3.5" aria-hidden />
          Auto-organize
        </div>
        <p className="mt-2 text-body-sm text-foreground">{plan.noopReason}</p>
      </div>
    )
  }

  const { workspaceCount, groupCount, tabCount } = describeOrganizationCounts(plan)

  function handleResolve(tabId: string, choice: { workspaceId?: string; name: string }) {
    setEditedPlan((prev) => resolveUncertainTab(prev, tabId, choice))
  }

  return (
    <div
      className={`space-y-3 rounded-lg border border-subtle p-3 transition-opacity duration-(--duration-fast) ${
        isResolved ? "opacity-60" : ""
      }`}
      data-status={preview.status}
    >
      <div className="flex items-center gap-1.5 text-label text-tertiary">
        <FolderTree className="size-3.5" aria-hidden />
        Auto-organize
      </div>

      {plan.workspaces.length > 0 && (
        <ul className="max-h-80 space-y-3 overflow-y-auto">
          {plan.workspaces.map((workspace, i) => (
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

      {plan.uncertainTabs.length > 0 && (
        <div className="space-y-1.5 border-t border-subtle pt-2">
          <p className="text-label text-tertiary">
            {plan.uncertainTabs.length} uncertain tab{plan.uncertainTabs.length === 1 ? "" : "s"}
          </p>
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {plan.uncertainTabs.slice(0, MAX_UNCERTAIN_ROWS).map((uncertain) => (
              <li key={uncertain.tabId} className="min-w-0 space-y-1">
                <p className="truncate text-body-sm text-foreground">{tabLabel(tabsById.get(uncertain.tabId), uncertain.tabId)}</p>
                <p className="truncate text-meta text-tertiary">Currently in &ldquo;{uncertain.currentWorkspaceName}&rdquo;</p>
                {isAwaiting && (
                  <div className="flex flex-wrap gap-1.5">
                    {uncertain.suggestions.map((s, si) => (
                      <button
                        key={si}
                        type="button"
                        onClick={() => handleResolve(uncertain.tabId, s)}
                        className="rounded-full border border-subtle px-2 py-0.5 text-meta text-foreground transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:bg-muted"
                      >
                        {s.name.startsWith("Keep in") ? "Keep" : s.name}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {plan.uncertainTabs.length > MAX_UNCERTAIN_ROWS && (
            <p className="text-meta text-tertiary">+{plan.uncertainTabs.length - MAX_UNCERTAIN_ROWS} more not shown.</p>
          )}
        </div>
      )}

      {plan.duplicates.length > 0 && (
        <p className="flex items-center gap-1.5 text-meta text-tertiary">
          <DuplicateIcon className="size-3.5" aria-hidden />I found {plan.duplicates.length} likely duplicate tab group{plan.duplicates.length === 1 ? "" : "s"}.
        </p>
      )}

      {workspaceCount > 0 && (
        <p className="text-body-sm text-tertiary">
          {workspaceCount} workspace{workspaceCount === 1 ? "" : "s"}
          {groupCount > 0 ? ` and ${groupCount} group${groupCount === 1 ? "" : "s"}` : ""} would be created or updated. {tabCount} tab
          {tabCount === 1 ? "" : "s"} would be reorganized.
        </p>
      )}

      {(isAwaiting || isApplying) && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onApply(editedPlan)} disabled={isApplying || workspaceCount === 0}>
            {isApplying && <Loader2 className="animate-spin" aria-hidden />}
            Apply organization
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={isApplying}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
