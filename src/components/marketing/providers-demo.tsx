"use client"

import { cn } from "@/lib/utils"
import { AgentGlyph } from "./agent-primitives"
import { DEMO_PROVIDERS } from "./agent-data"
import { DemoWindow } from "./primitives"

/**
 * What TabDump observes today, and what it does not.
 *
 * This section exists because the agent domain is genuinely provider-neutral —
 * `Agent.provider` is an opaque string the domain never interprets, and the
 * Claude Code reader lives entirely outside it, reaching the domain through one
 * adapter seam. That is a real architectural property and worth showing.
 *
 * It is also the exact place a product page starts lying. Four logos in a row
 * reads as four integrations; there is one. So the two groups are separated
 * structurally rather than by wording: `status` is a field on the data, the
 * supported provider gets a filled card and the rest get an explicitly empty
 * one, and no row can be added without choosing which side it belongs on.
 */

export function ProvidersDemo() {
  const supported = DEMO_PROVIDERS.filter((p) => p.status === "supported")
  const planned = DEMO_PROVIDERS.filter((p) => p.status === "planned")

  return (
    <DemoWindow
      chrome="app"
      title="Agents — providers"
      label="Which agent providers TabDump can observe"
    >
      <div className="flex flex-col gap-5 p-4 sm:p-5">
        <section>
          <p className="m-label">Observed today</p>
          <ul className="mt-3 flex flex-col gap-2">
            {supported.map((provider) => (
              <li
                key={provider.id}
                className="flex items-center gap-3 rounded-xl border border-[color-mix(in_oklch,var(--primary),transparent_55%)] bg-accent-subtle px-3.5 py-3"
              >
                <AgentGlyph className="size-7" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.9375rem] font-medium text-foreground">
                    {provider.name}
                  </span>
                  <span className="block text-body-sm text-tertiary">{provider.note}</span>
                </span>
                <span
                  className="m-num shrink-0 rounded-full border border-subtle px-2 py-0.5 text-[0.625rem] tracking-[0.04em] uppercase"
                  style={{ color: "var(--m-agent-good)" }}
                >
                  Supported
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <p className="m-label">Not yet</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-3">
            {planned.map((provider) => (
              <li
                key={provider.id}
                className={cn(
                  "flex flex-col gap-1 rounded-xl border border-dashed border-subtle px-3.5 py-3",
                  // Visibly unfilled. A planned provider that looked like a
                  // shipped one would be the whole problem this layout exists
                  // to avoid.
                  "bg-transparent"
                )}
              >
                <span className="text-body-sm text-muted-foreground">{provider.name}</span>
                <span className="m-num text-[0.625rem] tracking-[0.04em] text-tertiary uppercase">
                  No adapter yet
                </span>
              </li>
            ))}
          </ul>
        </section>

        <p className="text-meta text-tertiary">
          Reading is local and one-way. TabDump opens session files that are already on the
          machine it runs on and keeps a short summary of what it found — no transcript, no
          prompt, no tool output. Where there is nothing to read, it reports that rather than
          pretending.
        </p>
      </div>
    </DemoWindow>
  )
}
