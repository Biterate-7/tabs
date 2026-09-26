"use client"

import { useMemo, useState } from "react"
import { CheckSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { GraphLinkDialog } from "@/components/graph/graph-link-dialog"
import { CreateSectionDialog } from "@/components/workspace/create-section-dialog"
import { DeleteSectionDialog } from "@/components/workspace/delete-section-dialog"
import { RenameSectionDialog } from "@/components/workspace/rename-section-dialog"
import { AttentionStrip } from "@/components/workspace/attention-strip"
import { CategoryFilterBar } from "@/components/workspace/category-filter-bar"
import { CleanupDialog } from "@/components/workspace/cleanup-dialog"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"
import { CollectionsSection } from "@/components/workspace/collections-section"
import { DeleteCollectionDialog } from "@/components/workspace/delete-collection-dialog"
import { FilteredTabList } from "@/components/workspace/filtered-tab-list"
import { GatherDialog } from "@/components/workspace/gather-dialog"
import { RenameCollectionDialog } from "@/components/workspace/rename-collection-dialog"
import { SectionGrid } from "@/components/workspace/section-grid"
import { SelectionToolbar } from "@/components/workspace/selection-toolbar"
import { SortControl } from "@/components/workspace/sort-control"
import { TabInspector } from "@/components/workspace/tab-inspector"
import { WorkspaceHeader } from "@/components/workspace/workspace-header"
import { WorkspaceOverview } from "@/components/workspace/workspace-overview"
import { getCollectionsForWorkspace } from "@/lib/collections/relations"
import { buildDependencyTree } from "@/lib/dependencies/tree"
import { buildSectionTree, findSectionTreeNode } from "@/lib/sections/tree"
import { rootSections } from "@/lib/sections/relations"
import { copyText, urlsText } from "@/lib/workspace/export"
import { dependenciesOf, usedBy } from "@/lib/dependencies/relations"
import { buildGraphNodes, buildWorkspaceLookup } from "@/lib/graph/relations"
import { applyCategoryChange } from "@/lib/sections/migrate"
import { computeAttention } from "@/lib/workspace/attention"
import { removeTabs } from "@/lib/workspace/cleanup"
import { filterTabs, sortTabs, type SortKey } from "@/lib/workspace/search"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { useHubbleDemo } from "./demo-provider"
import { currentWorkspace } from "./demo-state"

/**
 * The workspace, as WorkspaceView lays it out: the 48px view bar, the attention
 * strip and one line of facts, category pills with sort, collections, then the
 * section grid — or the filtered list while searching.
 *
 * Built from WorkspaceView's own children rather than WorkspaceView itself,
 * because WorkspaceView mounts the collection and dependency stores, which
 * read and write the visitor's real localStorage, and registers global
 * keyboard shortcuts. Everything here reads and writes the demo's state, and
 * filtering and sorting run through the product's own `filterTabs` and
 * `sortTabs`.
 */
export function DemoWorkspace() {
  const { state, dispatch, openUrl } = useHubbleDemo()
  const workspace = currentWorkspace(state)
  const tabs = workspace.tabs
  const sections = workspace.sections

  const [query, setQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<CategoryId | "all">("all")
  const [sortKey, setSortKey] = useState<SortKey>("recent")
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [addToCollectionId, setAddToCollectionId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [gatherTabIds, setGatherTabIds] = useState<string[] | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [inspectId, setInspectId] = useState<string | null>(null)
  const [recentlyAdded, setRecentlyAdded] = useState<Set<string>>(new Set())
  // `undefined` = closed; `null` = a new root section; a string = a subsection under it. As in WorkspaceView.
  const [createSectionParent, setCreateSectionParent] = useState<string | null | undefined>(undefined)
  const [renameSectionId, setRenameSectionId] = useState<string | null>(null)
  const [deleteSectionId, setDeleteSectionId] = useState<string | null>(null)
  const [dependencyFor, setDependencyFor] = useState<string | null>(null)

  const collections = useMemo(() => getCollectionsForWorkspace(state.collections, workspace.id), [state.collections, workspace.id])
  const tabsById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs])
  const expandedIds = useMemo(
    () => new Set(collections.map((c) => c.id).filter((id) => !collapsedIds.has(id))),
    [collections, collapsedIds]
  )
  const collectionNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of collections) for (const id of c.tabIds) map.set(id, c.name)
    return map
  }, [collections])

  const isBrowsing = query.trim() === "" && categoryFilter === "all" && sortKey === "recent"
  const resultTabs = useMemo(
    () => sortTabs(filterTabs(tabs, { query, categoryId: categoryFilter, sections }), sortKey),
    [tabs, query, categoryFilter, sections, sortKey]
  )
  const attention = useMemo(() => computeAttention(tabs, sections), [tabs, sections])

  // The inspector's relationship data, from the product's own dependency helpers.
  const nodes = useMemo(
    () => buildGraphNodes(state.store.workspaces.flatMap((w) => w.tabs), buildWorkspaceLookup(state.store.workspaces)),
    [state.store.workspaces]
  )
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const validTabIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])

  const copyUrls = (list: Tab[]) => void copyText(urlsText(list))

  const setTabs = (next: Tab[]) => dispatch({ type: "set-tabs", workspaceId: workspace.id, tabs: next })
  const updateTab = (id: string, change: (tab: Tab) => Tab) => setTabs(tabs.map((t) => (t.id === id ? change(t) : t)))

  const tabHandlers = {
    onCategoryChange: (id: string, category: CategoryId) => updateTab(id, (t) => applyCategoryChange(t, category)),
    onToggleFavorite: (id: string) => updateTab(id, (t) => ({ ...t, isFavorite: !t.isFavorite })),
    onNotesChange: (id: string, notes: string) => updateTab(id, (t) => ({ ...t, notes: notes.trim() || undefined })),
    onInspect: (id: string) => setInspectId(id),
    onAddDependency: (id: string) => setDependencyFor(id),
    onOpenTab: (id: string) => {
      const tab = tabsById.get(id)
      if (!tab) return
      openUrl(tab.url)
      updateTab(id, (t) => ({ ...t, lastAccessedAt: Date.now() }))
    },
  }

  function resetFilters() {
    setQuery("")
    setCategoryFilter("all")
    setSortKey("recent")
    setHighlightedIndex(-1)
  }

  function exitSelectionMode() {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setAddToCollectionId(null)
  }

  function markAdded(ids: string[]) {
    setRecentlyAdded(new Set(ids))
  }

  function handleGatherConfirm(name: string) {
    const ids = gatherTabIds ?? []
    dispatch({ type: "create-collection", name, tabIds: ids })
    if (ids.length > 0) {
      markAdded(ids)
      exitSelectionMode()
    }
    setGatherTabIds(null)
  }

  function addSelectedTo(collectionId: string) {
    const ids = [...selectedIds]
    dispatch({ type: "add-to-collection", id: collectionId, tabIds: ids })
    markAdded(ids)
    exitSelectionMode()
  }

  const renameSection = renameSectionId ? sections?.find((s) => s.id === renameSectionId) : undefined
  const deleteSectionTree = deleteSectionId && sections ? findSectionTreeNode(buildSectionTree(sections, tabs), deleteSectionId) : null

  const renameTarget = renameId ? collections.find((c) => c.id === renameId) : undefined
  const deleteTarget = deleteId ? collections.find((c) => c.id === deleteId) : undefined
  const addTarget = addToCollectionId ? collections.find((c) => c.id === addToCollectionId) : undefined

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <WorkspaceHeader
          tabs={tabs}
          searchValue={query}
          onSearch={(value) => {
            setQuery(value)
            setHighlightedIndex(-1)
          }}
          onSearchArrowDown={() => setHighlightedIndex((i) => Math.min(i + 1, resultTabs.length - 1))}
          onSearchArrowUp={() => setHighlightedIndex((i) => Math.max(i - 1, 0))}
          onSearchEnter={() => {
            const target = resultTabs[highlightedIndex]
            if (target) tabHandlers.onOpenTab(target.id)
          }}
          onCleanup={() => setCleanupOpen(true)}
          onRequestClear={() => setClearOpen(true)}
          onOpenPalette={() => dispatch({ type: "palette", open: true })}
          onOpenGraph={() => dispatch({ type: "navigate", view: "graph" })}
          onOpenSidebar={() => dispatch({ type: "mobile-sidebar", open: true })}
          currentWorkspace={workspace}
          allWorkspaces={state.store.workspaces}
          dependencies={state.dependencies}
          collections={collections}
        />

        <main className="mx-auto w-full max-w-(--tabdump-content-max-width) px-4 py-5 sm:px-6 sm:py-8">
          <AttentionStrip
            attention={attention}
            onCleanup={() => setCleanupOpen(true)}
            onViewOther={() => setCategoryFilter("other")}
          />
          <div className={attention ? "mt-5" : undefined}>
            <WorkspaceOverview tabs={tabs} />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <CategoryFilterBar
              tabs={tabs}
              value={categoryFilter}
              onChange={(value) => {
                setCategoryFilter(value)
                setHighlightedIndex(-1)
              }}
            />
            <div className="flex items-center gap-2">
              {!isBrowsing &&
                (selectionMode ? (
                  <Button variant="ghost" size="sm" onClick={exitSelectionMode}>
                    <X /> Cancel
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setSelectionMode(true)}>
                    <CheckSquare /> Select
                  </Button>
                ))}
              <SortControl
                value={sortKey}
                onChange={(value) => {
                  setSortKey(value)
                  setHighlightedIndex(-1)
                }}
              />
            </div>
          </div>

          {selectionMode && (selectedIds.size > 0 || addTarget) && (
            <div className="mt-4">
              <SelectionToolbar
                count={selectedIds.size}
                onRecategorize={(category) => {
                  setTabs(tabs.map((t) => (selectedIds.has(t.id) ? applyCategoryChange(t, category) : t)))
                  exitSelectionMode()
                }}
                onExportSelected={() => copyUrls(tabs.filter((t) => selectedIds.has(t.id)))}
                onOpenSelected={() => {
                  for (const tab of tabs) if (selectedIds.has(tab.id)) openUrl(tab.url)
                }}
                onRemoveSelected={() => {
                  setTabs(removeTabs(tabs, [...selectedIds]))
                  exitSelectionMode()
                }}
                onClear={exitSelectionMode}
                collections={collections.map((c) => ({ id: c.id, name: c.name }))}
                onAddToCollection={addSelectedTo}
                onGatherNew={() => setGatherTabIds([...selectedIds])}
                {...(addTarget ? { addToCollectionTarget: { name: addTarget.name, onConfirm: () => addSelectedTo(addTarget.id) } } : {})}
              />
            </div>
          )}

          <div className="mt-6 space-y-6">
            <CollectionsSection
              collections={collections}
              tabsById={tabsById}
              expandedIds={expandedIds}
              onToggleExpanded={(id) =>
                setCollapsedIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              {...(sections ? { sections } : {})}
              onMoveToSection={(tabId, sectionId) => dispatch({ type: "assign-section", workspaceId: workspace.id, tabId, sectionId })}
              onNewCollection={() => setGatherTabIds([])}
              onRename={setRenameId}
              onAddTabs={(id) => {
                setAddToCollectionId(id)
                setSelectionMode(true)
                setSelectedIds(new Set())
                // Adding needs a list to pick from: show every tab, as a search would.
                if (isBrowsing) setSortKey("title")
              }}
              onOpenAll={(id) => {
                const collection = collections.find((c) => c.id === id)
                for (const tabId of collection?.tabIds ?? []) {
                  const tab = tabsById.get(tabId)
                  if (tab) openUrl(tab.url)
                }
              }}
              onExport={(id) => {
                const collection = collections.find((c) => c.id === id)
                copyUrls((collection?.tabIds ?? []).flatMap((tabId) => tabsById.get(tabId) ?? []))
              }}
              onDelete={setDeleteId}
              onRemoveTab={(collectionId, tabId) => dispatch({ type: "remove-from-collection", id: collectionId, tabId })}
              onMoveTab={(tabId, collectionId) => dispatch({ type: "move-to-collection", tabId, id: collectionId })}
              onDropTab={(collectionId, tabId) => dispatch({ type: "add-to-collection", id: collectionId, tabIds: [tabId] })}
              {...tabHandlers}
              recentlyAddedIds={recentlyAdded}
            />

            {isBrowsing && sections ? (
              <SectionGrid
                sections={sections}
                tabs={tabs}
                onCategoryChange={tabHandlers.onCategoryChange}
                onSectionChange={(tabId, sectionId) => dispatch({ type: "assign-section", workspaceId: workspace.id, tabId, sectionId })}
                onDropTabOnSection={(sectionId, tabId) => dispatch({ type: "assign-section", workspaceId: workspace.id, tabId, sectionId })}
                onCreateSection={(parentId) => setCreateSectionParent(parentId)}
                onRenameSection={setRenameSectionId}
                onDeleteSection={setDeleteSectionId}
                onAddDependency={tabHandlers.onAddDependency}
                onInspect={tabHandlers.onInspect}
                onNotesChange={tabHandlers.onNotesChange}
                onToggleFavorite={tabHandlers.onToggleFavorite}
                onOpenTab={tabHandlers.onOpenTab}
                recentlyAddedIds={recentlyAdded}
              />
            ) : (
              <FilteredTabList
                tabs={resultTabs}
                highlightedIndex={highlightedIndex}
                onCategoryChange={tabHandlers.onCategoryChange}
                {...(sections ? { sections } : {})}
                onMoveToSection={(tabId, sectionId) => dispatch({ type: "assign-section", workspaceId: workspace.id, tabId, sectionId })}
                onClearFilters={resetFilters}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelected={(id) =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                    return next
                  })
                }
                onAddDependency={tabHandlers.onAddDependency}
                onInspect={tabHandlers.onInspect}
                onNotesChange={tabHandlers.onNotesChange}
                onToggleFavorite={tabHandlers.onToggleFavorite}
                onOpenTab={tabHandlers.onOpenTab}
                collectionNames={collectionNames}
                recentlyAddedIds={recentlyAdded}
              />
            )}
          </div>
        </main>
      </div>

      <CleanupDialog open={cleanupOpen} onOpenChange={setCleanupOpen} tabs={tabs} onRemove={(ids) => setTabs(removeTabs(tabs, ids))} />
      <ClearWorkspaceDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        onConfirm={() => {
          setClearOpen(false)
          setTabs([])
        }}
      />
      <GatherDialog
        open={gatherTabIds !== null}
        onOpenChange={(open) => !open && setGatherTabIds(null)}
        tabCount={gatherTabIds?.length ?? 0}
        onConfirm={handleGatherConfirm}
      />
      {renameTarget && (
        <RenameCollectionDialog
          key={renameTarget.id}
          open
          onOpenChange={(open) => !open && setRenameId(null)}
          currentName={renameTarget.name}
          onRename={(name) => {
            dispatch({ type: "rename-collection", id: renameTarget.id, name })
            setRenameId(null)
          }}
        />
      )}
      {deleteTarget && (
        <DeleteCollectionDialog
          open
          onOpenChange={(open) => !open && setDeleteId(null)}
          collectionName={deleteTarget.name}
          tabCount={deleteTarget.tabIds.length}
          onConfirm={() => {
            dispatch({ type: "delete-collection", id: deleteTarget.id })
            setDeleteId(null)
          }}
        />
      )}
      <TabInspector
        open={inspectId !== null}
        onOpenChange={(open) => !open && setInspectId(null)}
        node={inspectId ? (nodeById.get(inspectId) ?? null) : null}
        dependencies={inspectId ? dependenciesOf(inspectId, state.dependencies) : []}
        usedByDeps={inspectId ? usedBy(inspectId, state.dependencies) : []}
        tree={inspectId ? buildDependencyTree(inspectId, state.dependencies, validTabIds) : []}
        nodeById={nodeById}
        onSelectTab={setInspectId}
        onOpenTab={tabHandlers.onOpenTab}
        onAddDependency={() => inspectId && setDependencyFor(inspectId)}
        onRemoveDependency={(id) => dispatch({ type: "remove-dependency", id })}
        onChangeDependencyType={(id, dependencyType) => dispatch({ type: "set-dependency-type", id, dependencyType })}
      />
      <GraphLinkDialog
        open={dependencyFor !== null}
        onOpenChange={(open) => !open && setDependencyFor(null)}
        mode="dependency"
        sourceNode={dependencyFor ? (nodeById.get(dependencyFor) ?? null) : null}
        candidates={nodes.filter((n) => n.id !== dependencyFor)}
        existingDependencyTargetIds={
          new Set(dependencyFor ? dependenciesOf(dependencyFor, state.dependencies).map((d) => d.childTabId) : [])
        }
        onAddDependency={(childTabId, dependencyType) =>
          dependencyFor &&
          dispatch({ type: "add-dependency", parentTabId: dependencyFor, childTabId, ...(dependencyType ? { dependencyType } : {}) })
        }
      />
      <CreateSectionDialog
        open={createSectionParent !== undefined}
        onOpenChange={(open) => !open && setCreateSectionParent(undefined)}
        parentName={createSectionParent ? (sections?.find((s) => s.id === createSectionParent)?.name ?? null) : null}
        onCreate={(name) => {
          if (createSectionParent !== undefined) dispatch({ type: "create-section", parentId: createSectionParent, name })
          setCreateSectionParent(undefined)
        }}
      />
      {renameSection && (
        <RenameSectionDialog
          key={renameSection.id}
          open
          onOpenChange={(open) => !open && setRenameSectionId(null)}
          currentName={renameSection.name}
          onRename={(name) => {
            dispatch({ type: "rename-section", id: renameSection.id, name })
            setRenameSectionId(null)
          }}
        />
      )}
      {deleteSectionTree && sections && (
        <DeleteSectionDialog
          open
          onOpenChange={(open) => !open && setDeleteSectionId(null)}
          sectionName={deleteSectionTree.section.name}
          tabCount={deleteSectionTree.totalTabCount}
          otherRootSections={rootSections(sections)
            .filter((s) => s.id !== deleteSectionId)
            .map((s) => ({ id: s.id, name: s.name }))}
          onConfirm={(reassignTo) => {
            if (deleteSectionId) dispatch({ type: "delete-section", id: deleteSectionId, ...(reassignTo ? { reassignTo } : {}) })
            setDeleteSectionId(null)
          }}
        />
      )}
    </div>
  )
}
