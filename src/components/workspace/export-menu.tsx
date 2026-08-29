"use client"

import { toast } from "sonner"
import { Copy, Download, FileText, FileJson } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { categoryCounts } from "@/lib/workspace/search"
import { buildExportText, copyText, downloadTextFile, urlsText } from "@/lib/workspace/export"
import { buildWorkspaceExport, downloadJsonFile, serializeWorkspaceExport } from "@/lib/workspace/json-export"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Collection } from "@/lib/collections/types"

function urlsLabel(n: number) {
  return `${n} URL${n === 1 ? "" : "s"}`
}

function jsonFilename(label: string) {
  return `tabdump-${label}-${new Date().toISOString().slice(0, 10)}.json`
}

export function ExportMenu({
  tabs,
  currentWorkspace,
  allWorkspaces,
  dependencies = [],
  collections = [],
}: {
  tabs: Tab[]
  /** Enables the JSON export items. Omitted (e.g. in isolated tab-list contexts) they simply don't render. */
  currentWorkspace?: Workspace
  allWorkspaces?: Workspace[]
  dependencies?: TabDependency[]
  collections?: Collection[]
}) {
  const counts = categoryCounts(tabs)

  async function handleCopyAll() {
    const ok = await copyText(urlsText(tabs))
    if (ok) toast.success(`Copied ${urlsLabel(tabs.length)}`)
    else toast.error("Couldn't copy to clipboard")
  }

  async function handleCopyCategory(id: CategoryId) {
    const categoryTabs = tabs.filter(
      (t) => ((t.category as CategoryId | undefined) ?? "other") === id
    )
    const ok = await copyText(urlsText(categoryTabs))
    if (ok) toast.success(`Copied ${urlsLabel(categoryTabs.length)}`)
    else toast.error("Couldn't copy to clipboard")
  }

  function handleExportTxt() {
    const ok = downloadTextFile("tabdump-export.txt", buildExportText(tabs))
    if (ok) toast.success("Workspace exported")
    else toast.error("Couldn't export workspace")
  }

  function handleExportWorkspaceJson() {
    if (!currentWorkspace) return
    const text = serializeWorkspaceExport(buildWorkspaceExport([currentWorkspace], dependencies, collections))
    const ok = downloadJsonFile(jsonFilename(currentWorkspace.name.toLowerCase().replace(/\s+/g, "-")), text)
    if (ok) toast.success("Workspace exported as JSON")
    else toast.error("Couldn't export workspace")
  }

  function handleExportAllJson() {
    if (!allWorkspaces) return
    const text = serializeWorkspaceExport(buildWorkspaceExport(allWorkspaces, dependencies, collections))
    const ok = downloadJsonFile(jsonFilename("all-workspaces"), text)
    if (ok) toast.success("All workspaces exported as JSON")
    else toast.error("Couldn't export workspaces")
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "sm" })}>
        <Download /> Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleCopyAll}>
          <Copy /> Copy all URLs
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Copy /> Copy category URLs
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {CATEGORY_ORDER.map((id) => (
              <DropdownMenuItem
                key={id}
                disabled={counts[id] === 0}
                onClick={() => handleCopyCategory(id)}
              >
                {CATEGORIES[id].name} ({counts[id]})
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={handleExportTxt}>
          <FileText /> Export TXT
        </DropdownMenuItem>
        {currentWorkspace && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleExportWorkspaceJson}>
              <FileJson /> Export workspace (JSON)
            </DropdownMenuItem>
            {allWorkspaces && allWorkspaces.length > 1 && (
              <DropdownMenuItem onClick={handleExportAllJson}>
                <FileJson /> Export all workspaces (JSON)
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
