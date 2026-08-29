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
