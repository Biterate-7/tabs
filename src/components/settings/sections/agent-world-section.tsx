"use client"

import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { AgentCharacter } from "@/components/agents/agent-character"
import { useOptionalAppearanceContext } from "@/components/appearance-provider"
import { useAgentWorldSettings } from "@/hooks/use-agent-world"
import { allAgentVisualIdentities } from "@/lib/agents/visual/app-identities"
import {
  MAX_AGENT_SCALE,
  MIN_AGENT_SCALE,
  WORLD_EFFECT_KEYS,
  WORLD_EFFECT_LABELS,
  clampAgentScale,
  normalizeWorldName,
} from "@/lib/agents/world/settings"
import { WORLD_THEMES } from "@/lib/agents/world/themes"
import { cn } from "@/lib/utils"
import { FieldRow, SectionHeading, SectionStack, SliderRow } from "./section-ui"
import type { WorldThemeId } from "@/lib/agents/world/types"

/**
 * Settings → Agent World.
 *
 * Built from the settings surface's own primitives — `SectionHeading`,
 * `FieldRow`, `SliderRow`, `SegmentedControl`, `Switch`, `Slider` — rather
 * than a new design system, so it reads as part of TabDump rather than as a
 * control panel bolted on beside one.
 *
 * Every control here changes something the renderer actually consults. There
 * is no switch that stores a value nothing reads, which is why the effect
 * list is six items rather than a longer list of plausible-sounding toggles.
 *
 * The per-workspace controls appear only when Settings was opened over a
 * workspace. Offering "this workspace's theme" with no workspace in scope
 * would be a control that could not be obeyed.
 */

export type AgentWorldSectionProps = {
  /** The workspace Settings was opened over, when there is one. */
  workspaceId?: string
  /** Its name, so the per-workspace name field can show what it falls back to. */
  workspaceName?: string
}

/** The live preview: every shipped identity, drawn in the chosen style. */
function StylePreview({
  style,
  scale,
}: {
  style: Parameters<typeof AgentCharacter>[0]["style"]
  scale: number
}) {
  const identities = allAgentVisualIdentities()

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border border-subtle bg-background-secondary p-3">
      {identities.map((identity, index) => (
        <div key={identity.id} className="flex flex-col items-center gap-1">
          <span style={{ transform: `scale(${scale})` }} className="block">
            <AgentCharacter
              connector={identity.id}
              // One of each of the states worth previewing, so the preview
              // shows what the styles actually differ in rather than five
              // copies of a resting figure.
              state={(["working", "thinking", "idle", "success", "error"] as const)[index % 5]}
              style={style}
              size={44}
            />
          </span>
          <span className="max-w-24 truncate text-center text-meta text-tertiary">
            {identity.displayName}
          </span>
        </div>
      ))}
    </div>
  )
}

export function AgentWorldSection({ workspaceId, workspaceName }: AgentWorldSectionProps) {
  const { settings, update, setEffect, setOverrideFor } = useAgentWorldSettings()
  const appearance = useOptionalAppearanceContext()

  const override = workspaceId ? settings.byWorkspace[workspaceId] : undefined

  return (
    <div>
      <SectionHeading
        title="Agent World"
        description="Watch connected agents work inside a small visual environment. Everything it shows comes from observed activity — nothing is simulated."
      />

      {/* The OS preference is stated rather than silently applied, so nobody
          has to wonder why the world is still. The same note the Motion
          section shows, for the same reason. */}
      {appearance?.prefersReducedMotion && (
        <p className="mb-3 rounded-lg border border-subtle bg-warning-subtle px-3 py-2 text-body-sm text-warning">
          Your system has reduced motion enabled — the world stays still regardless of the
          animation setting below. Every state is still shown as a word and a mark.
        </p>
      )}

      <SectionStack>
        <FieldRow
          label="Agent World"
          description="Show the world from the workspace graph. Agent activity is listed as text either way."
        >
          <Switch
            checked={settings.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
            aria-label="Agent World"
          />
        </FieldRow>

        <FieldRow label="Environment" description="Where your agents work." stacked>
          <div className="grid gap-2 sm:grid-cols-2">
            {WORLD_THEMES.map((theme) => {
              const active = settings.themeId === theme.id
              return (
                <button
                  key={theme.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ themeId: theme.id })}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    active
                      ? "border-primary/40 bg-primary/10"
                      : "border-subtle hover:border-border hover:bg-surface-hover"
                  )}
                >
                  <span className="block text-body-sm font-medium text-foreground">{theme.name}</span>
                  <span className="mt-0.5 block text-meta text-tertiary">{theme.description}</span>
                </button>
              )
            })}
          </div>
        </FieldRow>

        <FieldRow label="Agent style" description="How each agent is drawn." stacked>
          <div className="space-y-2.5">
            <SegmentedControl
              size="sm"
              value={settings.agentStyle}
              onValueChange={(agentStyle) => update({ agentStyle })}
              options={[
                { value: "minimal", label: "Icons" },
                { value: "character", label: "Characters" },
                { value: "pixel", label: "Pixel" },
                { value: "illustrated", label: "Illustrated" },
                { value: "futuristic", label: "Futuristic" },
              ]}
            />
            <StylePreview style={settings.agentStyle} scale={settings.agentScale} />
          </div>
        </FieldRow>

        <FieldRow label="Visual density" description="How much of the environment is drawn.">
          <SegmentedControl
            size="sm"
            value={settings.density}
            onValueChange={(density) => update({ density })}
            options={[
              { value: "minimal", label: "Minimal" },
              { value: "balanced", label: "Balanced" },
              { value: "detailed", label: "Detailed" },
            ]}
          />
        </FieldRow>

        <FieldRow
          label="Animation"
          description="Capped by Settings → Motion and by your system's reduced-motion preference."
        >
          <SegmentedControl
            size="sm"
            value={settings.animation}
            onValueChange={(animation) => update({ animation })}
            options={[
              { value: "off", label: "Off" },
              { value: "subtle", label: "Subtle" },
              { value: "full", label: "Full" },
            ]}
          />
        </FieldRow>

        <FieldRow label="Camera" description="What the view follows as work moves." stacked>
          <SegmentedControl
            size="sm"
            value={settings.camera}
            onValueChange={(camera) => update({ camera })}
            options={[
              { value: "static", label: "Static" },
              { value: "follow-active", label: "Follow active" },
              { value: "follow-workflow", label: "Follow all" },
              { value: "free", label: "Free" },
            ]}
          />
        </FieldRow>

        <SliderRow label="Agent size" valueLabel={`${Math.round(settings.agentScale * 100)}%`}>
          <Slider
            min={MIN_AGENT_SCALE}
            max={MAX_AGENT_SCALE}
            step={0.05}
            value={settings.agentScale}
            onValueChange={(agentScale) => update({ agentScale: clampAgentScale(agentScale) })}
            aria-label="Agent size"
          />
        </SliderRow>

        <FieldRow label="Effects" description="Each switch turns off one thing the world draws." stacked>
          <div className="grid gap-2 sm:grid-cols-2">
            {WORLD_EFFECT_KEYS.map((key) => (
              <label
                key={key}
                className="flex items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2"
              >
                <span className="text-body-sm text-foreground">{WORLD_EFFECT_LABELS[key]}</span>
                <Switch
                  checked={settings.effects[key]}
                  onCheckedChange={(value) => setEffect(key, value)}
                  aria-label={WORLD_EFFECT_LABELS[key]}
                />
              </label>
            ))}
          </div>
        </FieldRow>

        <FieldRow
          label="Keep idle agents visible"
          description="Show connected agents that have not started anything yet."
        >
          <Switch
            checked={settings.showIdleAgents}
            onCheckedChange={(showIdleAgents) => update({ showIdleAgents })}
            aria-label="Keep idle agents visible"
          />
        </FieldRow>

        <FieldRow
          label="Keep finished agents visible"
          description="Recently finished runs stay in the world instead of leaving as they end."
        >
          <Switch
            checked={settings.showCompleted}
            onCheckedChange={(showCompleted) => update({ showCompleted })}
            aria-label="Keep finished agents visible"
          />
        </FieldRow>

        <FieldRow
          label="Rearrange automatically"
          description="Agents move to a different part of the world as their work changes. Off keeps everyone where they are."
        >
          <Switch
            checked={settings.autoArrange}
            onCheckedChange={(autoArrange) => update({ autoArrange })}
            aria-label="Rearrange automatically"
          />
        </FieldRow>

        {workspaceId && (
          <>
            <FieldRow
              label="This workspace's world"
              description={`Overrides the environment for ${workspaceName ?? "this workspace"} only.`}
              stacked
            >
              <SegmentedControl
                size="sm"
                value={override?.themeId ?? "inherit"}
                onValueChange={(value) =>
                  setOverrideFor(workspaceId, {
                    themeId: value === "inherit" ? undefined : (value as WorldThemeId),
                  })
                }
                options={[
                  { value: "inherit", label: "Default" },
                  ...WORLD_THEMES.map((theme) => ({ value: theme.id, label: theme.name })),
                ]}
              />
            </FieldRow>

            <FieldRow
              label="World name"
              description={`Shown above the world. Falls back to ${workspaceName ?? "the workspace name"}.`}
              stacked
            >
              <Input
                value={override?.name ?? ""}
                placeholder={workspaceName ?? "Workspace"}
                onChange={(event) =>
                  setOverrideFor(workspaceId, { name: normalizeWorldName(event.target.value) })
                }
                aria-label="World name"
              />
            </FieldRow>
          </>
        )}
      </SectionStack>
    </div>
  )
}
