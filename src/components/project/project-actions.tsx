"use client"

import { createContext, useContext } from "react"
import { FolderInput } from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import type { Tab } from "@/lib/tabs/types"

/**
 * "Add to project" from anywhere Hubble shows saved tabs (Hubble 2.0) — the
 * path from an old tab dump to project context. Adding a tab to its own
 * project makes it a source in place; adding it to another copies its
 * address there. Either way it goes through the one ingestion pipeline,
 * exactly as a Chrome drop would.
 */
export type ProjectActions = {
  /** The project on screen. */
  currentId: string
  projects: readonly { id: string; name: string }[]
  addTabs: (tabs: readonly Pick<Tab, "url" | "title">[], projectId: string) => void
}

const ProjectActionsContext = createContext<ProjectActions | null>(null)

export const ProjectActionsProvider = ProjectActionsContext.Provider

export function useProjectActions(): ProjectActions | null {
  return useContext(ProjectActionsContext)
}

/** The "Add to project" row for a dropdown menu. Nothing when there is no shell to send it to. */
export function AddToProjectSubmenu({ tabs }: { tabs: readonly Pick<Tab, "url" | "title" | "resource">[] }) {
  const actions = useProjectActions()
  if (!actions || tabs.length === 0) return null
  const allSources = tabs.every((tab) => tab.resource)
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput /> Add to project
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {actions.projects.map((project) => {
          const here = project.id === actions.currentId
          if (here && allSources) return null
          return (
            <DropdownMenuItem key={project.id} onClick={() => actions.addTabs(tabs, project.id)}>
              {here ? `${project.name} — use as source` : project.name}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
