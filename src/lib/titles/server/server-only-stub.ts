// Test-only stand-in for the `server-only` package (see vitest.config.ts's
// alias). Next's bundler swaps `server-only` for a no-op when compiling the
// server graph and throws when compiling the client graph; outside of that
// bundler, vitest needs its own no-op so server-side title-resolution code
// can be tested directly.
export {};
