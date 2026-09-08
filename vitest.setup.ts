import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver; cmdk's Command component uses one internally
// to measure list height. A no-op stub is sufficient for tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom also has no scrollIntoView; cmdk calls it when the selected item
// changes.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Nor Element.getAnimations — @base-ui/react's ScrollArea (used by
// CleanupDialog/CategorySheet) now reaches this call now that
// ResizeObserver above is defined and its viewport-tracking effect runs.
if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// Nor requestAnimationFrame — the Graph View's canvas render loop drives its
// physics tick from it. A setTimeout-based stand-in is enough for tests that
// mount it; components cancel their loop on unmount via cancelAnimationFrame,
// so this never leaks a pending timer past a test's cleanup().
if (typeof globalThis.requestAnimationFrame === "undefined") {
  let nextHandle = 0;
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const handle = ++nextHandle;
    const timeoutId = setTimeout(() => {
      pending.delete(handle);
      callback(performance.now());
    }, 16);
    pending.set(handle, timeoutId);
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle: number) => {
    const timeoutId = pending.get(handle);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      pending.delete(handle);
    }
  };
}

// Nor the Pointer Capture APIs — sonner's toast swipe-to-dismiss handling
// calls `setPointerCapture` on pointerdown. Without a stub, userEvent's
// realistic pointer-event simulation throws from inside React's event
// dispatch, which surfaces as an uncaught exception that can bleed into
// whichever test happens to be running next.
if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
}

// jsdom implements window.postMessage, but not faithfully: it delivers the
// event with `origin: ""` and `source: null`, where a real browser sets them
// to the posting window's origin and the window itself. Every one of the
// extension bridge's listeners (content-script.js, useExtensionImport,
// useExtensionWorkspaceQuery, lib/browser/bridge.ts) checks exactly those two
// fields before trusting a message — that check is the bridge's only sender
// authentication — so without this shim any test that drives the bridge
// through its real API silently receives nothing.
//
// Delivery stays asynchronous, via a task rather than a microtask, because
// the ordering between "a payload is posted" and "a listener is attached" is
// the whole subject of the import-handshake tests; making it synchronous
// would fake away the race they exist to pin down.
if (typeof window !== "undefined") {
  const realOrigin = window.location.origin;
  window.postMessage = function postMessage(message: unknown) {
    setTimeout(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: message, origin: realOrigin, source: window })
      );
    }, 0);
  } as typeof window.postMessage;
}
