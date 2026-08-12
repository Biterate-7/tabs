"use client"

import { toast } from "sonner"
import { Copy, Download, FileText } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { categoryCounts } from "@/lib/workspace/search"
import { buildExportText, copyText, downloadTextFile, urlsText } from "@/lib/workspace/export"
import type { Tab } from "@/lib/tabs/types"

function urlsLabel(n: number) {
  return `${n} URL${n === 1 ? "" : "s"}`
}

export function ExportMenu({ tabs }: { tabs: Tab[] }) {
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
