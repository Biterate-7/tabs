/**
 * A stand-in for `@anthropic-ai/claude-agent-sdk`, as a real module on disk.
 *
 * `sdk-runtime.ts` loads the SDK through a dynamic `import()` of a module
 * specifier, so the honest way to test it is to give it a *different real
 * module* rather than to `vi.mock` the package. That keeps the load path, the
 * failure path and the options object exactly as they are in production — a
 * mock of the package would let a change to how the specifier is resolved
 * pass unnoticed.
 *
 * It records the options it was called with and yields nothing, which is all
 * the credential tests need: the assertion is about what reached `options.env`,
 * not about what the agent said.
 */

export type RecordedCall = {
  prompt: unknown;
  options: Record<string, unknown>;
};

const calls: RecordedCall[] = [];

export function recordedCalls(): readonly RecordedCall[] {
  return calls;
}

export function resetRecordedCalls(): void {
  calls.length = 0;
}

export function query(params: { prompt: unknown; options?: Record<string, unknown> }) {
  calls.push({ prompt: params.prompt, options: params.options ?? {} });

  // An immediately-exhausted stream: the run starts and ends, which is enough
  // for `start()` to resolve and for the handle's lifecycle to be exercised.
  const iterator = {
    async next() {
      return { done: true as const, value: undefined };
    },
    async return() {
      return { done: true as const, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      return undefined;
    },
  };

  return iterator;
}
