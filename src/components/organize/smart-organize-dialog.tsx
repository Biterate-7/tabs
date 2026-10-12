"use client"

import { useId, useState, type ReactNode } from "react"
import { Copy, Loader2, MoreHorizontal, Ungroup } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import {
  effectiveDestination,
  excludeExtraCopies,
  includeCopies,
  itemsById,
  locate,
  moveItem,
  moveItemToNewGroup,
  renameGroup,
  setDestination,
  summarize,
  ungroup,
  validateProposal,
} from "@/lib/organize/smart/edit"
import type { SmartPlace, SmartTarget } from "@/lib/organize/smart/edit"
import type { SmartDestination, SmartExclusionReason, SmartGroup, SmartItem, SmartMode, SmartProposal } from "@/lib/organize/smart/types"

/**
 * Smart Organize's review step: the proposal, editable, and nothing applied
 * until the person presses the one button that says exactly what will
 * happen. Every state the flow can be in renders here, so the two entry
 * points (open tabs from Home/⌘K, a subject's own tabs) look and behave the
 * same.
 */

export type SmartOrganizeStatus =
  | { kind: "loading"; message: string }
  /** The flow cannot run on this surface; `message` says why and what to do instead. */
  | { kind: "unavailable"; title: string; message: ReactNode }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready"; proposal: SmartProposal; note?: string }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

function itemLabel(item: SmartItem): string {
  return item.title || item.domain
}

const EXCLUSION_TEXT: Record<SmartExclusionReason, (item: SmartItem) => string> = {
  "already-saved": (item) => `Already in ${item.savedIn?.name ?? "Hubble"}`,
  "already-in-collection": (item) => `In ${item.inCollection?.name ?? "a collection"}`,
  duplicate: () => "Extra copy",
  you: () => "Left out",
}

export function SmartOrganizeDialog({
  open,
  onOpenChange,
  mode,
  status,
  places,
  applying = false,
  onRetry,
  onConfirm,
  onReviewDuplicates,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: SmartMode
  status: SmartOrganizeStatus
  /** Existing subjects (open-tabs) or this subject's collections (subject) a group can go to. */
  places: readonly SmartPlace[]
  applying?: boolean
  onRetry?: () => void
  onConfirm: (proposal: SmartProposal) => void
  /** Subject mode: opens Clean up, where saved copies can be removed. */
  onReviewDuplicates?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !applying && onOpenChange(next)}>
      <DialogContent className="flex max-h-[min(88vh,760px)] flex-col gap-0 p-0 sm:max-w-2xl" data-smart-organize>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>{mode === "open-tabs" ? "Organize open tabs" : "Organize this subject"}</DialogTitle>
          <DialogDescription className="text-body-sm">
            {mode === "open-tabs"
              ? "Grouped on this device from tab titles and addresses. Nothing changes until you confirm, and no tab is closed."
              : "Grouped on this device from tab titles and addresses. Nothing changes until you confirm, and nothing is removed."}
          </DialogDescription>
        </DialogHeader>

        {status.kind === "ready" ? (
          <SmartReview
            // A new analysis starts a new review; edits to an old one never leak into it.
            key={status.proposal.items.map((item) => item.id).join("|")}
            proposal={status.proposal}
            {...(status.note ? { note: status.note } : {})}
            places={places}
            applying={applying}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
            {...(onReviewDuplicates ? { onReviewDuplicates } : {})}
          />
        ) : (
          <>
            <div className="min-h-32 border-t border-subtle px-5 py-6" role={status.kind === "error" ? "alert" : "status"}>
              {status.kind === "loading" && (
                <p className="flex items-center gap-2 text-body-sm text-tertiary">
                  <Loader2 aria-hidden className="size-3.5 animate-spin" /> {status.message}
                </p>
              )}
              {status.kind === "unavailable" && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-body-sm font-medium text-foreground">{status.title}</p>
                  <div className="text-body-sm text-muted-foreground">{status.message}</div>
                </div>
              )}
              {status.kind === "error" && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-body-sm font-medium text-foreground">Couldn&rsquo;t organize these tabs</p>
                  <p className="text-body-sm text-muted-foreground">{status.message}</p>
                </div>
              )}
              {status.kind === "empty" && <p className="text-body-sm text-muted-foreground">{status.message}</p>}
            </div>
            <DialogFooter className="border-t border-subtle px-5 py-3">
              {(status.kind === "error" || status.kind === "unavailable") && onRetry && (
                <Button type="button" variant="secondary" size="lg" onClick={onRetry}>
                  Try again
                </Button>
              )}
              <Button type="button" variant="ghost" size="lg" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function destinationValue(destination: SmartDestination): string {
  switch (destination.kind) {
    case "new-subject":
    case "new-collection":
      return "new"
    case "subject":
      return `place:${destination.workspaceId}`
    case "collection":
      return `place:${destination.collectionId}`
  }
}

function SmartReview({
  proposal: initial,
  note,
  places,
  applying,
  onCancel,
  onConfirm,
  onReviewDuplicates,
}: {
  proposal: SmartProposal
  note?: string
  places: readonly SmartPlace[]
  applying: boolean
  onCancel: () => void
  onConfirm: (proposal: SmartProposal) => void
  onReviewDuplicates?: () => void
}) {
  const [proposal, setProposal] = useState(initial)
  const byId = itemsById(proposal)
  const summary = summarize(proposal, places)
  const problems = validateProposal(proposal)
  const unnamed = new Set(problems.map((problem) => problem.groupId))
  const mode = proposal.mode
  const placeWord = mode === "open-tabs" ? ["subject", "subjects"] : ["collection", "collections"]
  const pageWord = mode === "open-tabs" ? ["page", "pages"] : ["tab", "tabs"]
  const nothingToDo = proposal.groups.every((group) => group.itemIds.length === 0)

  const move = (itemId: string, target: SmartTarget) => setProposal((current) => moveItem(current, itemId, target))
  const toNewGroup = (itemId: string) => setProposal((current) => moveItemToNewGroup(current, itemId))

  const rowMenu = (item: SmartItem) => (
    <ItemMenu
      item={item}
      where={locate(proposal, item.id)}
      groups={proposal.groups}
      disabled={applying}
      onMove={(target) => move(item.id, target)}
      onNewGroup={() => toNewGroup(item.id)}
    />
  )

  const reviewItems = proposal.review.map((id) => byId.get(id)).filter((item) => item !== undefined)
  const excludedItems = proposal.excluded
    .map((entry) => ({ entry, item: byId.get(entry.itemId) }))
    .filter((row): row is { entry: (typeof proposal.excluded)[number]; item: SmartItem } => row.item !== undefined)

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-subtle px-5 py-4">
        <p className="text-body-sm text-foreground" data-smart-summary-line>
          {proposal.items.length === 0
            ? "Nothing to organize."
            : initial.excluded.length === initial.items.length
              ? mode === "open-tabs"
                ? "Everything open is already saved in Hubble."
                : "Every tab here is already in a collection."
              : nothingToDo
              ? `Looked at ${plural(proposal.items.length, pageWord[0]!, pageWord[1]!)}. Nothing clearly belongs together — you can still group them yourself below.`
              : `Looked at ${plural(proposal.items.length, pageWord[0]!, pageWord[1]!)} and found ${plural(summary.groups, "group", "groups")}.`}
        </p>
        {note && <p className="mt-1 text-meta text-tertiary">{note}</p>}

        {proposal.groups.length > 0 && (
          <ul className="mt-4 flex flex-col gap-3" aria-label="Suggested groups">
            {proposal.groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                items={group.itemIds.map((id) => byId.get(id)).filter((item) => item !== undefined)}
                mode={mode}
                places={places}
                invalid={unnamed.has(group.id)}
                disabled={applying}
                rowMenu={rowMenu}
                onRename={(name) => setProposal((current) => renameGroup(current, group.id, name))}
                onDestination={(destination) => setProposal((current) => setDestination(current, group.id, destination))}
                onUngroup={() => setProposal((current) => ungroup(current, group.id))}
              />
            ))}
          </ul>
        )}

        {reviewItems.length > 0 && (
          <section className="mt-5" aria-labelledby="smart-review-heading">
            <h3 id="smart-review-heading" className="text-label text-foreground">
              Not sure <span className="text-tertiary">· left as they are · {reviewItems.length}</span>
            </h3>
            <p className="mt-0.5 text-meta text-tertiary">
              {mode === "open-tabs" ? "These stay open in Chrome and aren't added. Move any of them into a group." : "These stay in the subject, outside any collection."}
            </p>
            <ul className="mt-1.5 flex flex-col">
              {reviewItems.map((item) => (
                <ItemRow key={item.id} item={item} menu={rowMenu(item)} />
              ))}
            </ul>
          </section>
        )}

        {proposal.duplicates.length > 0 && (
          <section className="mt-5" aria-labelledby="smart-duplicates-heading">
            <h3 id="smart-duplicates-heading" className="flex items-center gap-1.5 text-label text-foreground">
              <Copy aria-hidden className="size-3.5 text-tertiary" />
              {mode === "open-tabs" ? "Open more than once" : "Saved more than once"} <span className="text-tertiary">· {proposal.duplicates.length}</span>
            </h3>
            <p className="mt-0.5 text-meta text-tertiary">
              {mode === "open-tabs"
                ? "Hubble saves one copy of a page. Nothing is closed — tidy Chrome yourself if you like."
                : "Nothing is removed here. Clean up can remove saved copies, with your confirmation."}
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {proposal.duplicates.map((set) => {
                const first = byId.get(set.itemIds[0]!)
                if (!first) return null
                // Copies the duplicate toggle governs: not ones left out for another reason (already saved, by hand).
                const inPlay = set.itemIds.filter((id) => {
                  const where = locate(proposal, id)
                  return where?.kind !== "excluded" || where.reason === "duplicate"
                })
                const extrasOut = inPlay.length > 1 && inPlay.slice(1).every((id) => locate(proposal, id)?.kind === "excluded")
                const savedIn = set.itemIds.map((id) => byId.get(id)?.savedIn?.name ?? byId.get(id)?.inCollection?.name).find(Boolean)
                return (
                  <li key={set.itemIds.join("|")} className="flex min-w-0 items-center gap-2.5 rounded-xs px-2 py-1.5">
                    <TabFavicon domain={first.domain} {...(first.favicon ? { icon: first.favicon } : {})} size={16} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body-sm text-foreground">{itemLabel(first)}</span>
                      <span className="block truncate text-meta text-tertiary">
                        {set.itemIds.length} copies{set.exact ? "" : " · addresses differ slightly"}
                        {inPlay.length < 2 && savedIn ? ` · already in ${savedIn}` : ""}
                      </span>
                    </span>
                    {mode === "open-tabs" ? (
                      inPlay.length < 2 ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={applying}
                        onClick={() => setProposal((current) => (extrasOut ? includeCopies(current, set.itemIds) : excludeExtraCopies(current, set.itemIds)))}
                      >
                        {extrasOut ? "Include copies" : "Leave out copies"}
                      </Button>
                      )
                    ) : onReviewDuplicates ? (
                      <Button type="button" size="sm" variant="ghost" disabled={applying} onClick={onReviewDuplicates}>
                        Review in Clean up
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {excludedItems.length > 0 && (
          <section className="mt-5" aria-labelledby="smart-excluded-heading">
            <h3 id="smart-excluded-heading" className="text-label text-foreground">
              Not included <span className="text-tertiary">· {excludedItems.length}</span>
            </h3>
            <ul className="mt-1.5 flex flex-col">
              {excludedItems.map(({ entry, item }) => (
                <ItemRow key={item.id} item={item} detail={EXCLUSION_TEXT[entry.reason](item)} menu={rowMenu(item)} />
              ))}
            </ul>
          </section>
        )}
      </div>

      <DialogFooter className="flex-col items-stretch gap-2 border-t border-subtle px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-meta text-tertiary" aria-live="polite" data-smart-footer>
          {problems.length > 0
            ? "Give every group a name to continue."
            : summary.pages === 0
              ? "Nothing will change."
              : `${mode === "open-tabs" ? "Adds" : "Puts"} ${plural(summary.pages, pageWord[0]!, pageWord[1]!)} ${mode === "open-tabs" ? "to" : "into"} ${plural(summary.groups === 0 ? 0 : summary.created + summary.existing, placeWord[0]!, placeWord[1]!)}${summary.created > 0 ? ` (${summary.created} new)` : ""}.${summary.unchanged === 1 ? " 1 stays as it is." : summary.unchanged > 1 ? ` ${summary.unchanged} stay as they are.` : ""}`}
        </p>
        <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={applying}>
            Cancel
          </Button>
          <Button type="button" size="lg" disabled={applying || problems.length > 0 || summary.pages === 0} onClick={() => onConfirm(proposal)}>
            {applying && <Loader2 aria-hidden className="animate-spin" />}
            {summary.pages > 0 ? `Organize ${plural(summary.pages, pageWord[0]!, pageWord[1]!)}` : "Organize"}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

function GroupCard({
  group,
  items,
  mode,
  places,
  invalid,
  disabled,
  rowMenu,
  onRename,
  onDestination,
  onUngroup,
}: {
  group: SmartGroup
  items: SmartItem[]
  mode: SmartMode
  places: readonly SmartPlace[]
  invalid: boolean
  disabled: boolean
  rowMenu: (item: SmartItem) => ReactNode
  onRename: (name: string) => void
  onDestination: (destination: SmartDestination) => void
  onUngroup: () => void
}) {
  const nameId = useId()
  const effective = effectiveDestination(group, places)
  const newLabel = mode === "open-tabs" ? "New subject" : "New collection"
  const options = [
    { value: "new", label: newLabel },
    ...places.map((place) => ({ value: `place:${place.id}`, label: `Add to ${place.name}` })),
  ]
  return (
    <li>
      <section aria-labelledby={nameId} className="rounded-md border border-subtle bg-card px-3 py-2.5" data-smart-group>
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={nameId} className="sr-only">
            {group.name || "Unnamed group"}
          </h3>
          <Input
            aria-label="Group name"
            value={group.name}
            maxLength={80}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            onChange={(event) => onRename(event.target.value)}
            className="h-7 min-w-0 flex-1 basis-40 text-body-sm font-medium"
          />
          <span className="shrink-0 text-meta text-tertiary">{plural(items.length, "tab", "tabs")}</span>
          <div className="w-44 shrink-0">
            <Select
              value={destinationValue(group.destination)}
              options={options}
              className="h-7 text-body-sm"
              onValueChange={(value) => {
                if (value === "new") onDestination(mode === "open-tabs" ? { kind: "new-subject" } : { kind: "new-collection" })
                else {
                  const id = value.slice("place:".length)
                  onDestination(mode === "open-tabs" ? { kind: "subject", workspaceId: id } : { kind: "collection", collectionId: id })
                }
              }}
            />
          </div>
          <IconButton aria-label={`Leave the tabs in ${group.name || "this group"} as they are`} tooltip="Ungroup" disabled={disabled} onClick={onUngroup}>
            <Ungroup />
          </IconButton>
        </div>
        <p className="mt-1 text-meta text-tertiary">
          {group.reason}
          {(group.destination.kind === "new-subject" || group.destination.kind === "new-collection") &&
            effective.kind !== group.destination.kind &&
            ` · goes into your existing ${mode === "open-tabs" ? "subject" : "collection"} with this name`}
        </p>
        {items.length === 0 ? (
          <p className="mt-1.5 text-meta text-tertiary">No tabs — this group will be skipped.</p>
        ) : (
          <ul className="mt-1.5 flex flex-col">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} menu={rowMenu(item)} />
            ))}
          </ul>
        )}
      </section>
    </li>
  )
}

function ItemRow({ item, detail, menu }: { item: SmartItem; detail?: string; menu: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2.5 rounded-xs px-1 py-1 hover:bg-surface-hover" data-smart-item={item.id}>
      <TabFavicon domain={item.domain} {...(item.favicon ? { icon: item.favicon } : {})} size={16} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-sm text-foreground" title={item.url}>
          {itemLabel(item)}
        </span>
        <span className="block truncate text-meta text-tertiary">
          {item.domain}
          {detail ? ` · ${detail}` : ""}
        </span>
      </span>
      {menu}
    </li>
  )
}

function ItemMenu({
  item,
  where,
  groups,
  disabled,
  onMove,
  onNewGroup,
}: {
  item: SmartItem
  where: SmartTarget | null
  groups: readonly SmartGroup[]
  disabled: boolean
  onMove: (target: SmartTarget) => void
  onNewGroup: () => void
}) {
  const others = groups.filter((group) => !(where?.kind === "group" && where.groupId === group.id))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <IconButton aria-label={`Move ${itemLabel(item)}`} tooltip="Move">
            <MoreHorizontal />
          </IconButton>
        }
      />
      <DropdownMenuContent align="end" className="max-h-80 min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          {others.map((group) => (
            <DropdownMenuItem key={group.id} onClick={() => onMove({ kind: "group", groupId: group.id })}>
              <span className="truncate">{group.name.trim() || "Unnamed group"}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={onNewGroup}>New group</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {where?.kind !== "review" && <DropdownMenuItem onClick={() => onMove({ kind: "review" })}>Leave as it is</DropdownMenuItem>}
        {where?.kind !== "excluded" && <DropdownMenuItem onClick={() => onMove({ kind: "excluded" })}>Don&rsquo;t include</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
