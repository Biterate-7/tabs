import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryFolder } from "./category-folder";
import type { Tab } from "@/lib/tabs/types";

/**
 * jsdom has no `AnimationEvent` constructor, so React's SimpleEventPlugin
 * falls back to feature-detecting a vendor-prefixed event name off a
 * throwaway element's `style` object (see react-dom's `getVendorPrefixedEventName`)
 * instead of the real `"animationend"` — in this jsdom build that resolves
 * to `"webkitAnimationEnd"`. Real browsers have `AnimationEvent` and use the
 * unprefixed name, so `handleAnimationEnd` in category-folder.tsx only ever
 * needs to check for `"animationend"`; dispatching both names here just
 * keeps this test robust to whichever one the current jsdom/React pairing
 * actually wires up.
 */
function fireAnimationEnd(element: Element, animationName: string) {
  for (const type of ["animationend", "webkitAnimationEnd"]) {
    const event = new Event(type, { bubbles: true, cancelable: false });
    Object.defineProperty(event, "animationName", { value: animationName });
    element.dispatchEvent(event);
  }
}

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "id",
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

describe("CategoryFolder", () => {
  it("shows the resolved title instead of the domain", () => {
    const tabs = [makeTab({ id: "1", domain: "github.com", title: "GitHub · Change Password" })];
    render(<CategoryFolder categoryId="projects" tabs={tabs} presence="standard" onViewAll={() => {}} />);

    expect(screen.getByText("GitHub · Change Password")).toBeTruthy();
    expect(screen.queryByText("github.com")).toBeNull();
  });

  it("falls back to the domain when a tab has no resolved title", () => {
    const tabs = [makeTab({ id: "1", domain: "vercel.com", title: undefined })];
    render(<CategoryFolder categoryId="projects" tabs={tabs} presence="standard" onViewAll={() => {}} />);

    expect(screen.getByText("vercel.com")).toBeTruthy();
  });

  it("shows a '+N more' indicator once the preview limit is exceeded", () => {
    const tabs = [1, 2, 3, 4, 5].map((n) =>
      makeTab({ id: String(n), domain: `site${n}.com`, title: `Site ${n}` })
    );
    render(<CategoryFolder categoryId="projects" tabs={tabs} presence="standard" onViewAll={() => {}} />);

    // presence="standard" previews 3 tabs, so 2 remain hidden.
    expect(screen.getByText("+2 more")).toBeTruthy();
  });

  it("still shows the tab count and an accessible open control", () => {
    const tabs = [makeTab({ id: "1", domain: "github.com", title: "GitHub" })];
    render(<CategoryFolder categoryId="projects" tabs={tabs} presence="standard" onViewAll={() => {}} />);

    expect(screen.getByText("1 tab")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open projects, 1 tab/i })).toBeTruthy();
  });

  it("does not navigate immediately on click — it waits for the open animation to finish", async () => {
    const user = userEvent.setup();
    const onViewAll = vi.fn();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];
    render(<CategoryFolder categoryId="projects" tabs={tabs} presence="standard" onViewAll={onViewAll} />);

    await user.click(screen.getByRole("button", { name: /open projects/i }));
    expect(onViewAll).not.toHaveBeenCalled();

    fireAnimationEnd(screen.getByRole("button", { name: /open projects/i }), "folder-card-open");
    expect(onViewAll).toHaveBeenCalledOnce();
  });

  it("ignores clicks while the open animation is already in progress", async () => {
    const user = userEvent.setup();
    const onViewAll = vi.fn();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];
    render(<CategoryFolder categoryId="projects" tabs={tabs} presence="standard" onViewAll={onViewAll} />);

    const button = screen.getByRole("button", { name: /open projects/i });
    await user.click(button);
    expect(button).toHaveProperty("disabled", true);

    fireAnimationEnd(button, "folder-card-open");
    expect(onViewAll).toHaveBeenCalledOnce();
  });

  it("disables the compact chip for an empty category but still opens non-empty ones", async () => {
    const user = userEvent.setup();
    const onViewAll = vi.fn();
    render(<CategoryFolder categoryId="other" tabs={[]} presence="compact" onViewAll={onViewAll} />);

    const chip = screen.getByRole("button", { name: /no tabs/i });
    expect(chip).toHaveProperty("disabled", true);
    await user.click(chip);
    expect(onViewAll).not.toHaveBeenCalled();
  });

  it("navigates immediately for the compact chip — no open animation for near-empty categories", async () => {
    const user = userEvent.setup();
    const onViewAll = vi.fn();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];
    render(<CategoryFolder categoryId="other" tabs={tabs} presence="compact" onViewAll={onViewAll} />);

    await user.click(screen.getByRole("button", { name: /view all 1 other tab/i }));
    expect(onViewAll).toHaveBeenCalledOnce();
  });
});
