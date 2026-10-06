import { describe, expect, it } from "vitest";
import { dragCarriesResources, HUBBLE_TABS_MIME, readDroppedResources } from "./drop";
import type { DataTransferLike } from "./drop";

function transfer(data: Record<string, string>, files: File[] = []): DataTransferLike {
  return { types: [...Object.keys(data), ...(files.length > 0 ? ["Files"] : [])], getData: (type) => data[type] ?? "", files };
}

describe("readDroppedResources", () => {
  it("reads a Chrome link/address-bar drag (uri-list + plain + html), keeping the anchor's title", () => {
    const dropped = readDroppedResources(
      transfer({
        "text/uri-list": "https://www.britannica.com/event/Cuban-missile-crisis",
        "text/plain": "https://www.britannica.com/event/Cuban-missile-crisis",
        "text/html": '<a href="https://www.britannica.com/event/Cuban-missile-crisis">Cuban missile crisis | Britannica</a>',
      })
    );
    expect(dropped.inputs).toEqual([{ url: "https://www.britannica.com/event/Cuban-missile-crisis", title: "Cuban missile crisis | Britannica" }]);
    expect(dropped.empty).toBe(false);
  });

  it("reads several tabs dragged from Firefox (x-moz-url pairs)", () => {
    const dropped = readDroppedResources(
      transfer({
        "text/x-moz-url": "https://a.example/1\nFirst\nhttps://a.example/2.pdf\nSecond\nhttps://youtu.be/dQw4w9WgXcQ\nThird",
        "text/uri-list": "https://a.example/1\r\nhttps://a.example/2.pdf\r\nhttps://youtu.be/dQw4w9WgXcQ",
      })
    );
    expect(dropped.inputs.map((input) => input.title)).toEqual(["First", "Second", "Third"]);
  });

  it("skips uri-list comments and blank lines", () => {
    const dropped = readDroppedResources(transfer({ "text/uri-list": "# a comment\r\n\r\nhttps://a.example/x\r\n" }));
    expect(dropped.inputs).toEqual([{ url: "https://a.example/x" }]);
  });

  it("reads Hubble's own extension payload", () => {
    const dropped = readDroppedResources(transfer({ [HUBBLE_TABS_MIME]: JSON.stringify([{ url: "https://a.example", title: "A" }, { nope: 1 }]) }));
    expect(dropped.inputs).toEqual([{ url: "https://a.example", title: "A" }]);
  });

  it("finds addresses in dragged text, and a lone schemeless address", () => {
    expect(readDroppedResources(transfer({ "text/plain": "see https://a.example/x, and (https://b.example/y)." })).inputs.map((input) => input.url)).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
    expect(readDroppedResources(transfer({ "text/plain": "example.org/paper" })).inputs).toEqual([{ url: "example.org/paper" }]);
  });

  it("does not turn a fragment's incidental links into sources", () => {
    const html = '<p>Read <a href="https://a.example/1">one</a> and <a href="https://a.example/2">two</a></p>';
    expect(readDroppedResources(transfer({ "text/html": html })).inputs).toEqual([]);
  });

  it("reports an empty drop (plain words) honestly", () => {
    const dropped = readDroppedResources(transfer({ "text/plain": "just some words" }));
    expect(dropped).toEqual({ inputs: [], files: [], empty: true });
  });

  it("passes files through", () => {
    const file = new File(["%PDF-1.4"], "crisis.pdf", { type: "application/pdf" });
    const dropped = readDroppedResources(transfer({}, [file]));
    expect(dropped.files).toEqual([file]);
    expect(dropped.empty).toBe(false);
  });

  it("survives getData throwing (protected drag data)", () => {
    const dropped = readDroppedResources({ types: ["text/uri-list"], getData: () => { throw new Error("protected"); } });
    expect(dropped.empty).toBe(true);
  });
});

describe("dragCarriesResources", () => {
  it("recognises links, files and text, and nothing else", () => {
    expect(dragCarriesResources({ types: ["text/uri-list"] })).toBe(true);
    expect(dragCarriesResources({ types: ["Files"] })).toBe(true);
    expect(dragCarriesResources({ types: ["text/x-moz-url"] })).toBe(true);
    expect(dragCarriesResources({ types: ["application/x-hubble-collection-tabs"] })).toBe(false);
    expect(dragCarriesResources(null)).toBe(false);
  });
});
