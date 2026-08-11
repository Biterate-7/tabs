import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SortControl } from "./sort-control";

describe("SortControl", () => {
  it("opens the menu on click and shows all sort options", async () => {
    const user = userEvent.setup();
    render(<SortControl value="recent" onChange={() => {}} />);

    await user.click(screen.getByRole("button", { name: /recently added/i }));

    expect(await screen.findByText("Title")).toBeTruthy();
    expect(screen.getByText("Domain")).toBeTruthy();
    expect(screen.getByText("Category")).toBeTruthy();
  });

  it("calls onChange with the selected sort key", async () => {
    const user = userEvent.setup();
    let selected: string | null = null;
    render(<SortControl value="recent" onChange={(v) => (selected = v)} />);

    await user.click(screen.getByRole("button", { name: /recently added/i }));
    await user.click(await screen.findByText("Domain"));

    expect(selected).toBe("domain");
  });
});
