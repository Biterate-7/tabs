import { vi } from "vitest";

/**
 * Test-only fake of everything src/lib/favicon/client.ts touches: fetch()
 * of the resolver, blob: URLs, and image decoding (jsdom never loads
 * images). Every <img> probe — the loader's and Base UI's Avatar's — goes
 * through the fake `Image`, so tests decide per URL what happens.
 */

/** What the resolver answers for a host. */
export type ServiceOutcome =
  | "icon" // 200 + image bytes that decode
  | "undecodable" // 200 + image bytes the browser can't decode
  | "not-found" // 200 + { icon: null, reason: "not-found" }
  | "unreachable" // 200 + { icon: null, reason: "unreachable" }
  | "server-error" // 500
  | "offline" // fetch rejects
  | "hang"; // never answers

export type ImageOutcome = "load" | "error" | "hang";

export function installFakeFaviconNetwork(outcomes: {
  service?: (host: string) => ServiceOutcome;
  image?: (src: string) => ImageOutcome;
}) {
  const fetched: string[] = [];
  const images: string[] = [];
  const blobs = new Map<string, "load" | "error">();
  const revoked: string[] = [];
  let blobCount = 0;

  const serviceFor = outcomes.service ?? (() => "not-found");
  const imageFor = outcomes.image ?? (() => "error");

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    const host = new URL(url, "http://localhost").searchParams.get("host") ?? "";
    const outcome = serviceFor(host);
    if (outcome === "offline") throw new TypeError("Failed to fetch");
    if (outcome === "hang") {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      );
    }
    if (outcome === "server-error") return new Response("boom", { status: 500 });
    if (outcome === "icon" || outcome === "undecodable") {
      const response = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
      // The fake Image decodes a blob URL iff its Blob was marked decodable here.
      const blob = async () => Object.assign(new Blob(["png"], { type: "image/png" }), { __decodes: outcome === "icon" });
      return Object.assign(response, { blob });
    }
    return Response.json({ icon: null, reason: outcome });
  });

  const OriginalImage = window.Image;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = "auto";
    referrerPolicy = "";
    crossOrigin: string | null = null;
    naturalWidth = 0;
    complete = false;
    private current = "";

    get src() {
      return this.current;
    }

    set src(value: string) {
      this.current = value;
      if (!value) return;
      images.push(value);
      const outcome = value.startsWith("blob:") ? (blobs.get(value) ?? "error") : imageFor(value);
      queueMicrotask(() => {
        if (this.current !== value) return;
        if (outcome === "load") {
          this.naturalWidth = 32;
          this.complete = true;
          this.onload?.();
        } else if (outcome === "error") {
          this.complete = true;
          this.onerror?.();
        }
      });
    }
  }

  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  globalThis.fetch = fetchMock as typeof fetch;
  window.Image = FakeImage as unknown as typeof Image;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:hubble/${++blobCount}`;
    blobs.set(url, (blob as Blob & { __decodes?: boolean }).__decodes ? "load" : "error");
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
    blobs.set(url, "error");
  };

  return {
    fetched,
    images,
    revoked,
    /** Makes an already-issued blob URL stop decoding, as if it were revoked elsewhere. */
    breakBlob: (url: string) => blobs.set(url, "error"),
    restore: () => {
      globalThis.fetch = originalFetch;
      window.Image = OriginalImage;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}
