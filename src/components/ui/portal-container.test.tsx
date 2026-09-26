import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PortalContainerContext } from "./portal-container"

function Scoped({ children }: { children: React.ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <PortalContainerContext.Provider value={node}>{children}</PortalContainerContext.Provider>
      <div ref={setNode} data-testid="scope" />
    </>
  )
}

describe("PortalContainerContext", () => {
  it("leaves overlays in <body> when nothing provides a container, as in the app", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Plain</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const dialog = screen.getByRole("dialog")
    expect(dialog.closest("[data-testid='scope']")).toBeNull()
    expect(document.body.contains(dialog)).toBe(true)
  })

  it("mounts dialogs and tooltips into the provided container", async () => {
    render(
      <Scoped>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Scoped</DialogTitle>
          </DialogContent>
        </Dialog>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Tip</TooltipContent>
        </Tooltip>
      </Scoped>
    )
    const dialog = await screen.findByRole("dialog")
    expect(dialog.closest("[data-testid='scope']")).not.toBeNull()
    expect((await screen.findByText("Tip")).closest("[data-testid='scope']")).not.toBeNull()
  })
})
