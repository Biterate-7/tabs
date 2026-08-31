import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryGrid } from "./category-grid";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "id",
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "projects",
    ...over,
  };
}

describe("CategoryGrid", () => {
  it("opens the category page when a card's 'view all' is clicked", async () => {
    const user = userEvent.setup();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];

    render(<CategoryGrid tabs={tabs} onCategoryChange={() => {}} />);

    await user.click(screen.getByRole("button", { name: /view all/i }));

    expect(screen.getByText("Tab 1")).toBeTruthy();
  });

  it("closes the category page when the user goes back", async () => {
    const user = userEvent.setup();
    const tabs = [makeTab({ id: "1", title: "Tab 1" })];

    render(<CategoryGrid tabs={tabs} onCategoryChange={() => {}} />);

    await user.click(screen.getByRole("button", { name: /view all/i }));
    await user.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.queryByText("Tab 1")).toBeNull();
  });
});
