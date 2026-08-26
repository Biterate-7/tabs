import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourceCard } from "./source-card";
import type { AskSource } from "@/lib/ai/types";

const openTabMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser/open-tab", () => ({ openTab: openTabMock }));

function makeSource(over: Partial<AskSource> = {}): AskSource {
  return {
    tabId: "1",
    title: "Some page",
    url: "https://example.com/page",
    domain: "example.com",
    ...over,
  };
}

describe("SourceCard", () => {
  it("shows the title and domain", () => {
    render(<SourceCard source={makeSource()} />);
    expect(screen.getByText("Some page")).toBeTruthy();
    expect(screen.getByText(/example\.com/)).toBeTruthy();
  });

  it("routes the click through the extension-aware openTab, not a raw window.open", async () => {
    const user = userEvent.setup();
    render(<SourceCard source={makeSource({ url: "https://example.com/page" })} />);

    await user.click(screen.getByRole("button"));

    expect(openTabMock).toHaveBeenCalledWith("https://example.com/page");
  });
});
