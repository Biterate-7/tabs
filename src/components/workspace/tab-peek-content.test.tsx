import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabPeekContent } from "./tab-peek-content";
import type { Section } from "@/lib/sections/types";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return { url: "https://example.com", normalizedUrl: "https://example.com", domain: "example.com", category: "other", ...over };
}

function makeSection(over: Partial<Section> & { id: string }): Section {
  return { parentId: null, name: "Untitled", source: "user", createdAt: 0, updatedAt: 0, ...over };
}

describe("TabPeekContent section move", () => {
  it("offers a Move to section submenu when sections are provided, and selecting a leaf calls onMoveToSection", async () => {
    const onMoveToSection = vi.fn();
    const onCategoryChange = vi.fn();
    const sections = [makeSection({ id: "school", name: "School" }), makeSection({ id: "research", name: "Research" })];
    const user = userEvent.setup();

    render(
      <TabPeekContent
        tab={makeTab({ id: "1" })}
        context={null}
        onCategoryChange={onCategoryChange}
        sections={sections}
        onMoveToSection={onMoveToSection}
      />
    );

    await user.click(screen.getByRole("button", { name: "More actions for example.com" }));
    await user.hover(await screen.findByRole("menuitem", { name: "Move to section" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Research" }));

    expect(onMoveToSection).toHaveBeenCalledWith("1", "research");
  });

  it("omits the Move to section submenu when no sections exist", async () => {
    const onCategoryChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TabPeekContent
        tab={makeTab({ id: "1" })}
        context={null}
        onCategoryChange={onCategoryChange}
        sections={[]}
        onMoveToSection={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "More actions for example.com" }));
    expect(screen.queryByRole("menuitem", { name: "Move to section" })).toBeNull();
  });

  it("does not render the actions menu at all when onCategoryChange is omitted (Graph's gate)", () => {
    render(<TabPeekContent tab={makeTab({ id: "1" })} context={null} sections={[]} />);
    expect(screen.queryByRole("button", { name: "More actions for example.com" })).toBeNull();
  });
});
