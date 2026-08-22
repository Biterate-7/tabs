import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryCard } from "./category-card";
import type { Tab } from "@/lib/tabs/types";

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

describe("CategoryCard", () => {
  it("shows the resolved title instead of the domain", () => {
    const tabs = [
      makeTab({ id: "1", domain: "github.com", title: "GitHub · Change Password" }),
    ];
    render(
      <CategoryCard
        categoryId="projects"
        tabs={tabs}
        presence="standard"
        onViewAll={() => {}}
      />
    );

    expect(screen.getByText("GitHub · Change Password")).toBeTruthy();
    expect(screen.queryByText("github.com")).toBeNull();
  });

  it("falls back to the domain when a tab has no resolved title", () => {
    const tabs = [makeTab({ id: "1", domain: "vercel.com", title: undefined })];
    render(
      <CategoryCard
        categoryId="projects"
        tabs={tabs}
        presence="standard"
        onViewAll={() => {}}
      />
    );

    expect(screen.getByText("vercel.com")).toBeTruthy();
  });

  it("renders titles and domain fallbacks together for mixed tabs", () => {
    const tabs = [
      makeTab({ id: "1", domain: "github.com", title: "GitHub · Change Password" }),
      makeTab({ id: "2", domain: "vercel.com", title: undefined }),
      makeTab({ id: "3", domain: "mail.google.com", title: "Inbox (4) — Gmail" }),
    ];
    render(
      <CategoryCard
        categoryId="projects"
        tabs={tabs}
        presence="standard"
        onViewAll={() => {}}
      />
    );

    expect(screen.getByText("GitHub · Change Password")).toBeTruthy();
    expect(screen.getByText("vercel.com")).toBeTruthy();
    expect(screen.getByText("Inbox (4) — Gmail")).toBeTruthy();
    expect(screen.queryByText("github.com")).toBeNull();
    expect(screen.queryByText("mail.google.com")).toBeNull();
  });

  it("still shows the tab count and view-all control", () => {
    const tabs = [makeTab({ id: "1", domain: "github.com", title: "GitHub" })];
    render(
      <CategoryCard
        categoryId="projects"
        tabs={tabs}
        presence="standard"
        onViewAll={() => {}}
      />
    );

    expect(screen.getByText("1 tab")).toBeTruthy();
    expect(screen.getByRole("button", { name: /view all 1 projects tab/i })).toBeTruthy();
  });
});
