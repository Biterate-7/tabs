import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CleanupDialog } from "./cleanup-dialog";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com/page",
    normalizedUrl: "https://example.com/page",
    domain: "example.com",
    category: "other",
    confidence: 1,
    ...over,
  };
}

function renderDialog(tabs: Tab[]) {
  const onRemove = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <CleanupDialog
      open
      onOpenChange={onOpenChange}
      tabs={tabs}
      onRemove={onRemove}
    />
  );
  return { onRemove, onOpenChange };
}

const twoDuplicates: Tab[] = [
  makeTab({ id: "1", url: "https://a.com/x", normalizedUrl: "https://a.com/x", domain: "a.com" }),
  makeTab({ id: "2", url: "https://a.com/x", normalizedUrl: "https://a.com/x", domain: "a.com" }),
  makeTab({ id: "3", url: "https://b.com/y", normalizedUrl: "https://b.com/y", domain: "b.com" }),
];

describe("CleanupDialog — no duplicates", () => {
  it("says there is nothing to clean up and disables review", () => {
    renderDialog([
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://b.com" }),
    ]);

    expect(screen.getByText("Nothing to clean up.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review manually" })
    ).toHaveProperty("disabled", true);
  });
});

describe("CleanupDialog — summary stage", () => {
  it("shows the real workspace numbers and offers no removal control", () => {
    renderDialog(twoDuplicates);

    expect(screen.getByText("Your workspace can be cleaned up.")).toBeTruthy();
    expect(screen.getByText("tabs")).toBeTruthy();
    expect(screen.getByText("unique")).toBeTruthy();
    expect(screen.getByText("duplicates")).toBeTruthy();
    expect(screen.getByText("need review")).toBeTruthy();

    // removal is unreachable until the user has reviewed
    expect(screen.queryByRole("button", { name: /Remove selected/ })).toBeFalsy();
  });

  it("'Keep all' closes without removing anything", async () => {
    const user = userEvent.setup();
    const { onRemove, onOpenChange } = renderDialog(twoDuplicates);

    await user.click(screen.getByRole("button", { name: "Keep all" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe("CleanupDialog — review stage", () => {
  it("lists each duplicate group with its copy count and a kept copy", async () => {
    const user = userEvent.setup();
    renderDialog(twoDuplicates);

    await user.click(screen.getByRole("button", { name: "Review manually" }));

    expect(screen.getByText("2 copies")).toBeTruthy();
    expect(screen.getAllByText("Keep")).toHaveLength(1);
    expect(screen.getAllByText("Remove")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Remove selected (1)" })
    ).toBeTruthy();
  });

  it("groups tracking-parameter duplicates into one group", async () => {
    const user = userEvent.setup();
    renderDialog([
      makeTab({
        id: "1",
        url: "https://a.com/x?utm_source=news",
        normalizedUrl: "https://a.com/x",
        domain: "a.com",
      }),
      makeTab({
        id: "2",
        url: "https://a.com/x",
        normalizedUrl: "https://a.com/x",
        domain: "a.com",
      }),
    ]);

    await user.click(screen.getByRole("button", { name: "Review manually" }));

    expect(screen.getByText("2 copies")).toBeTruthy();
    expect(screen.getByText("https://a.com/x?utm_source=news")).toBeTruthy();
    expect(screen.getByText("https://a.com/x")).toBeTruthy();
  });

  it("handles many duplicates across several groups", async () => {
    const user = userEvent.setup();
    const many: Tab[] = [];
    for (let g = 0; g < 5; g++) {
      for (let c = 0; c < 4; c++) {
        many.push(
          makeTab({
            id: `${g}-${c}`,
            url: `https://site${g}.com/x`,
            normalizedUrl: `https://site${g}.com/x`,
            domain: `site${g}.com`,
          })
        );
      }
    }
    renderDialog(many);

    await user.click(screen.getByRole("button", { name: "Review manually" }));

    expect(screen.getAllByText("4 copies")).toHaveLength(5);
    // 20 tabs, 5 groups, keep 1 per group => 15 removed
    expect(
      screen.getByRole("button", { name: "Remove selected (15)" })
    ).toBeTruthy();
  });

  it("bounds the dialog to the viewport and makes only the group list scroll, with header and footer staying fixed", async () => {
    const user = userEvent.setup();
    const many: Tab[] = [];
    for (let g = 0; g < 17; g++) {
      many.push(
        makeTab({ id: `${g}-0`, url: `https://site${g}.com/x`, normalizedUrl: `https://site${g}.com/x`, domain: `site${g}.com` }),
        makeTab({ id: `${g}-1`, url: `https://site${g}.com/x`, normalizedUrl: `https://site${g}.com/x`, domain: `site${g}.com` })
      );
    }
    renderDialog(many);

    await user.click(screen.getByRole("button", { name: "Review manually" }));

    // The dialog itself is height-capped and clips overflow rather than
    // growing past the viewport — no way for content to escape unreachable.
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/max-h-\[85vh\]/);
    expect(dialog.className).toMatch(/overflow-hidden/);
    expect(dialog.className).toMatch(/flex-col/);

    // The group list is the scrollable region, given a definite (not
    // max-height-only, not flex-derived) height — percentage/flex-based
    // heights don't propagate down to the ScrollArea viewport in this UI
    // library, so a real `h-*` class is what actually makes it scrollable
    // (verified against a real browser: max-h-only and flex-1/min-h-0 both
    // silently fail to constrain the viewport, matching this project's
    // other working ScrollArea usage in CategorySheet).
    const scrollArea = document.body.querySelector('[data-slot="scroll-area"]');
    expect(scrollArea).toBeTruthy();
    expect(scrollArea!.className).toMatch(/h-\[45vh\]/);

    // Header/footer are marked shrink-0 so they don't get squeezed by the
    // scrollable middle region.
    expect(screen.getByText("Your workspace can be cleaned up.").closest('[data-slot="dialog-header"]')?.className).toMatch(/shrink-0/);
    expect(
      screen.getByRole("button", { name: "Back" }).closest('[data-slot="dialog-footer"]')?.className
    ).toMatch(/shrink-0/);

    // All 17 groups are present in the DOM (scrolled, not dropped).
    expect(screen.getAllByText("2 copies")).toHaveLength(17);
  });

  it("does not let a long URL force the row wider than the card (min-w-0 + flex-1 truncation)", async () => {
    const user = userEvent.setup();
    const longUrl =
      "https://example.com/a/very/long/path/segment/that/keeps/going/and/going?with=lots&of=query&params=to&make=it&even=longer&than=before";
    renderDialog([
      makeTab({ id: "1", url: longUrl, normalizedUrl: longUrl, domain: "example.com" }),
      makeTab({ id: "2", url: longUrl + "#2", normalizedUrl: longUrl, domain: "example.com" }),
    ]);

    await user.click(screen.getByRole("button", { name: "Review manually" }));

    const urlSpan = screen.getByText(longUrl);
    expect(urlSpan.className).toMatch(/min-w-0/);
    expect(urlSpan.className).toMatch(/flex-1/);
    expect(urlSpan.className).toMatch(/truncate/);
  });

  it("changing which copy is kept flips the Keep/Remove markers", async () => {
    const user = userEvent.setup();
    renderDialog(twoDuplicates);

    await user.click(screen.getByRole("button", { name: "Review manually" }));

    const copyButtons = screen.getAllByRole("button", {
      name: /Keep this copy of a\.com/,
    });
    expect(copyButtons[0].textContent).toBe("Keep");
    expect(copyButtons[1].textContent).toBe("Remove");

    await user.click(copyButtons[1]);

    expect(copyButtons[0].textContent).toBe("Remove");
    expect(copyButtons[1].textContent).toBe("Keep");
  });

  it("'Keep all' on a group excludes it from removal", async () => {
    const user = userEvent.setup();
    renderDialog(twoDuplicates);

    await user.click(screen.getByRole("button", { name: "Review manually" }));
    expect(
      screen.getByRole("button", { name: "Remove selected (1)" })
    ).toBeTruthy();

    await user.click(screen.getByRole("checkbox"));

    expect(
      screen.getByRole("button", { name: "Remove selected (0)" })
    ).toHaveProperty("disabled", true);
  });
});

describe("CleanupDialog — confirmation", () => {
  it("cancelling the confirmation removes nothing", async () => {
    const user = userEvent.setup();
    const { onRemove } = renderDialog(twoDuplicates);

    await user.click(screen.getByRole("button", { name: "Review manually" }));
    await user.click(screen.getByRole("button", { name: "Remove selected (1)" }));

    expect(await screen.findByText(/Remove 1 tab\?/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRemove).not.toHaveBeenCalled();
  });

  it("confirming removes exactly the non-kept copies", async () => {
    const user = userEvent.setup();
    const { onRemove, onOpenChange } = renderDialog(twoDuplicates);

    await user.click(screen.getByRole("button", { name: "Review manually" }));
    await user.click(screen.getByRole("button", { name: "Remove selected (1)" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(["2"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("actually dismisses both the dialog and the confirmation after confirming", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <CleanupDialog
          open={open}
          onOpenChange={setOpen}
          tabs={twoDuplicates}
          onRemove={onRemove}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Review manually" }));
    await user.click(screen.getByRole("button", { name: "Remove selected (1)" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(onRemove).toHaveBeenCalledWith(["2"]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeFalsy();
      expect(screen.queryByRole("alertdialog")).toBeFalsy();
    });
  });
});
