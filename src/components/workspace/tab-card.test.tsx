import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabCard } from "./tab-card";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: "1",
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

describe("TabCard interaction states", () => {
  it("shows an Inspect action when onInspect is provided, and calls it with the tab id", async () => {
    const user = userEvent.setup();
    const onInspect = vi.fn();
    render(
      <TabCard
        tab={makeTab({ id: "1", domain: "github.com" })}
        onCategoryChange={vi.fn()}
        onInspect={onInspect}
      />
    );

    await user.click(screen.getByRole("button", { name: "More actions for github.com" }));
    await user.click(await screen.findByText("Inspect…"));

    expect(onInspect).toHaveBeenCalledWith("1");
  });

  it("omits the Inspect action entirely when onInspect isn't provided", async () => {
    const user = userEvent.setup();
    render(<TabCard tab={makeTab({ id: "1", domain: "github.com" })} onCategoryChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "More actions for github.com" }));

    expect(screen.queryByText("Inspect…")).toBeNull();
  });

  it("still renders the tab normally when isRecentlyAdded/selected are unset", () => {
    render(<TabCard tab={makeTab({ id: "1", domain: "github.com" })} onCategoryChange={vi.fn()} />);
    expect(screen.getAllByText("github.com").length).toBeGreaterThan(0);
  });
});
