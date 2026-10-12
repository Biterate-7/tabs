import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { loadCollectionState, saveCollectionState } from "@/lib/collections/persistence"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace } from "@/lib/workspace/types"

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>()
  const fn = Object.assign(vi.fn(() => "toast-id"), { error: vi.fn(), warning: vi.fn(() => "toast-id"), success: vi.fn(), info: vi.fn(), dismiss: vi.fn() })
  return { ...actual, toast: fn }
})

const tab = (id: string, url: string, title: string): Tab => ({ id, url, normalizedUrl: url, domain: new URL(url).hostname, title, category: "other" })

const biology: Workspace = {
  id: "bio",
  name: "Biology",
  tabs: [
    tab("t1", "https://a.example/mitosis", "Mitosis stages"),
    tab("t2", "https://b.example/mitosis2", "Mitosis vs meiosis"),
    tab("t3", "https://c.example/enzymes", "Enzyme kinetics"),
    tab("t4", "https://d.example/enzymes2", "Enzyme inhibition"),
    tab("t5", "https://e.example/random", "Weekend plans"),
    tab("t6", "https://f.example/kept", "Already filed"),
  ],
  createdAt: 1,
  updatedAt: 1,
}
const physics: Workspace = { id: "phys", name: "Physics", tabs: [tab("p1", "https://g.example/x", "Mitosis is not physics")], createdAt: 1, updatedAt: 1 }

function renderSubject(props: Partial<Parameters<typeof WorkspaceView>[0]> = {}) {
  return render(
    <WorkspaceView tabs={biology.tabs} onTabsChange={vi.fn()} onClear={vi.fn()} currentWorkspace={biology} allWorkspaces={[biology, physics]} {...props} />
  )
}

const own = (workspaceId: string) => loadCollectionState().collections.filter((collection) => collection.workspaceId === workspaceId)

async function openOrganize(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions" }))
  await user.click(await screen.findByRole("menuitem", { name: "Organize tabs" }))
  return screen.findByRole("dialog", { name: "Organize this subject" })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(toast).mockClear()
  saveCollectionState({
    version: 1,
    collections: [
      { id: "kept", workspaceId: "bio", name: "Filed", tabIds: ["t6"], createdAt: 1, updatedAt: 1 },
      { id: "other", workspaceId: "phys", name: "Mitosis", tabIds: ["p1"], createdAt: 1, updatedAt: 1 },
    ],
  })
})

describe("Organize this subject", () => {
  it("turns loose tabs into collections, leaves filed tabs and other subjects alone, and saves", async () => {
    const user = userEvent.setup()
    const onTabsChange = vi.fn()
    renderSubject({ onTabsChange })
    const dialog = await openOrganize(user)
    expect(within(dialog).getAllByRole("textbox", { name: "Group name" }).map((input) => (input as HTMLInputElement).value)).toEqual(["Mitosis", "Enzyme"])
    expect(within(dialog).getByText(/In Filed/)).toBeTruthy()
    expect(dialog.querySelector("[data-smart-footer]")!.textContent).toBe("Puts 4 tabs into 2 collections (2 new). 2 stay as they are.")

    await user.click(within(dialog).getByRole("button", { name: "Organize 4 tabs" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Organize this subject" })).toBeNull())

    await waitFor(() =>
      expect(own("bio").map((collection) => [collection.name, collection.tabIds])).toEqual([
        ["Filed", ["t6"]],
        ["Mitosis", ["t1", "t2"]],
        ["Enzyme", ["t3", "t4"]],
      ])
    )
    expect(own("phys")).toEqual([{ id: "other", workspaceId: "phys", name: "Mitosis", tabIds: ["p1"], createdAt: 1, updatedAt: 1 }])
    expect(toast).toHaveBeenCalledWith("Organized 4 tabs into 2 collections (2 new)", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }))
    // Collections only: no tab record — id, title, resource, content — is rewritten.
    expect(onTabsChange).not.toHaveBeenCalled()
  })

  it("Undo puts the subject's collections back exactly", async () => {
    const user = userEvent.setup()
    renderSubject()
    const dialog = await openOrganize(user)
    await user.click(within(dialog).getByRole("button", { name: "Organize 4 tabs" }))
    await waitFor(() => expect(own("bio")).toHaveLength(3))

    const options = vi.mocked(toast).mock.calls.at(-1)![1] as unknown as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    await waitFor(() => expect(own("bio")).toEqual([{ id: "kept", workspaceId: "bio", name: "Filed", tabIds: ["t6"], createdAt: 1, updatedAt: 1 }]))
  })

  it("cancel changes nothing", async () => {
    const user = userEvent.setup()
    renderSubject()
    const before = loadCollectionState()
    const dialog = await openOrganize(user)
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("dialog", { name: "Organize this subject" })).toBeNull()
    expect(loadCollectionState()).toEqual(before)
    expect(toast).not.toHaveBeenCalled()
  })

  it("after a bulk import, offers to organize once — and only opens the review when asked", async () => {
    const user = userEvent.setup()
    const onDismissOrganizeOffer = vi.fn()
    renderSubject({ organizeOffer: 1, onDismissOrganizeOffer })
    const offer = await screen.findByText("These tabs look like 2 topics. Sort them into collections?")
    expect(screen.queryByRole("dialog")).toBeNull()
    await user.click(within(offer.closest("[data-smart-organize-offer]") as HTMLElement).getByRole("button", { name: "Review" }))
    expect(onDismissOrganizeOffer).toHaveBeenCalledOnce()
    expect(await screen.findByRole("dialog", { name: "Organize this subject" })).toBeTruthy()
  })
})
