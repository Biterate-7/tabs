"use client"

import { Copy, ExternalLink, FolderInput, GitBranchPlus, Layers, Link2, Star, StickyNote, Trash2 } from "lucide-react"
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu"
import type { Tab } from "@/lib/tabs/types"

/** A saved tab behind a graph node, with what the graph needs to act on it. */
export type GraphTab = {
  workspaceId: string
  tab: Tab
  /** The section the organizer (or the person) filed it in. */
  section?: string
  /** The collection it is in, if any (a tab is in at most one). */
  collection?: { id: string; name: string }
  /** Its project's other collections, which it could join. */
  collections: readonly { id: string; name: string }[]
  /** The other projects it could move to — none for a read source, whose stored text belongs to its project. */
  projects: readonly { id: string; name: string }[]
}

/** Everything that can be done to a saved tab from the graph. Each goes to the same records the project view edits. */
export type GraphTabActions = {
  openPage: (newTab: boolean) => void
  copy: (clean: boolean) => void
  toggleFavorite: () => void
  editNote: () => void
  moveTo: (workspaceId: string) => void
  addToCollection: (collectionId: string) => void
  newCollection: () => void
  leaveCollection: () => void
  linkTo: () => void
  addDependency: () => void
  remove: () => void
}

/**
 * The saved-tab actions, as rows of a dropdown menu — the inspector's "More"
 * menu and a node's right-click menu are the same list, so a thing can be
 * done the same way from either.
 */
export function TabMenuItems({ graphTab, actions }: { graphTab: GraphTab; actions: GraphTabActions }) {
  const { tab } = graphTab
  return (
    <>
      <DropdownMenuItem onClick={() => actions.openPage(false)}>
        <ExternalLink /> Open page
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => actions.openPage(true)}>
        <ExternalLink /> Open in new tab
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => actions.copy(false)}>
        <Copy /> Copy link
      </DropdownMenuItem>
      {tab.normalizedUrl && tab.normalizedUrl !== tab.url && (
        <DropdownMenuItem onClick={() => actions.copy(true)}>
          <Copy /> Copy clean link
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={actions.toggleFavorite}>
        <Star fill={tab.isFavorite ? "currentColor" : "none"} fillOpacity={tab.isFavorite ? 0.2 : 1} /> {tab.isFavorite ? "Remove from favorites" : "Add to favorites"}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={actions.editNote}>
        <StickyNote /> {tab.notes ? "Edit note" : "Add note"}
      </DropdownMenuItem>
      {graphTab.projects.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderInput /> Move to project
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72">
            {graphTab.projects.map((project) => (
              <DropdownMenuItem key={project.id} onClick={() => actions.moveTo(project.id)}>
                {project.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Layers /> Collection
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-72">
          {graphTab.collections.map((collection) => (
            <DropdownMenuItem key={collection.id} onClick={() => actions.addToCollection(collection.id)}>
              {graphTab.collection ? `Move to ${collection.name}` : collection.name}
            </DropdownMenuItem>
          ))}
          {graphTab.collections.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={actions.newCollection}>New collection…</DropdownMenuItem>
          {graphTab.collection && <DropdownMenuItem onClick={actions.leaveCollection}>Remove from {graphTab.collection.name}</DropdownMenuItem>}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={actions.linkTo}>
        <Link2 /> Link to…
      </DropdownMenuItem>
      <DropdownMenuItem onClick={actions.addDependency}>
        <GitBranchPlus /> Add dependency…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={actions.remove}>
        <Trash2 /> Remove from project
      </DropdownMenuItem>
    </>
  )
}
