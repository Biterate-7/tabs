# Phase 18 — Living AI Agents & Agent World

Phases 11–17 built a model of agent work and a way to say which providers can
be observed. What none of them built is a way to say **who is acting**, in a
form a person recognises without reading.

Phase 18 adds two layers for that, and nothing else:

```
src/lib/agents/
├── visual/     who an agent is, and how a state looks     ← identity
└── world/      where agents stand while they work         ← the room
```

Both are pure presentation. Neither can observe, drive, start, stop or
message anything; neither writes to the agent domain; and the generic domain
still does not know a provider exists. `visual/security.test.ts` fails the
build if any of that changes.

> **The world described below is now drawn in isometric**, with named rooms
> and a craft-derived placement. Everything this document says about states,
> derivation, handoffs, motion policy and accessibility still holds — only the
> presentation changed. See
> [phase-18-2-the-isometric-agent-world.md](./phase-18-2-the-isometric-agent-world.md)
> for what replaced §4's flat station grid and §5's scenery.

---

## 1. Where the pieces live

```
src/lib/agents/visual/
├── types.ts          AgentVisualState, AgentVisualIdentity, WorldCharacterConfig
├── states.ts         domain status → visual state, and how each state reads
├── animation.ts      the motion policy, and which keyframe a state gets
├── marks.tsx         the provider marks (original geometric devices)
├── registry.ts       the mechanism: register, look up, fall back
├── catalog.ts        THE one provider-aware module
└── app-identities.ts the application's lazily-seeded singleton

src/lib/agents/world/
├── types.ts          zones, stations, characters, handoffs, the scene
├── themes.ts         four environments, on one shared station grid
├── layout.ts         slot assignment, overlap prevention, density caps
├── handoffs.ts       observed transfers between runs — never invented
├── scene.ts          domain index + settings → a world
├── settings.ts       what the user can change
└── persistence.ts    tabdump:agent-world:v1 (preferences only)

src/components/agents/
├── agent-icon.tsx            <AgentIcon connector state size />
├── agent-identity.tsx        <AgentIdentity> <AgentStatus> <AgentAvatar>
├── agent-character.tsx       <AgentCharacter> — one parametric figure
├── agent-activity-list.tsx   who is working, and on what
├── agent-world.tsx           <AgentWorld /> — the stage and its agents
├── agent-world-stage.tsx     scenery, station labels, handoff trails
├── agent-world-detail.tsx    one agent, in full
└── agent-tone.ts             tone → class, in one place

src/hooks/
├── use-agent-motion.ts       how much motion is allowed right now
└── use-agent-world.ts        the world, ready to render
```

---

## 2. Two vocabularies, kept apart

The central modelling decision is that **a visual state is not a run status**,
and collapsing them would be wrong in both directions.

A run status is a fact about the domain. `blocked` and `failed` are different
facts and stay different facts — `AGENT_STATUS_VISUALS` in the canvas renderer
is unchanged by this phase, and every surface that shows a status still shows
its own word.

A visual state is a question about *motion*: should this mark move, and how.
`blocked` and `failed` deserve the same answer, so they share one visual
state. The distinction is never lost, because the word is always there.

### The nine states, and what produces each

| state | produced by | reads as |
|---|---|---|
| `idle` | a cancelled run; a connected provider with no work; anything unmapped | ○ Idle |
| `queued` | a work item still `pending` | ◌ Queued |
| `starting` | a connector `connecting` or `reconnecting` | ◍ Starting |
| `thinking` | a `working` run with **no** named activity and no active work item | ◑ Thinking |
| `working` | a `working` run **with** one | ▶ Working |
| `communicating` | a live run in an observed handoff with another live run | ⇄ Handing off |
| `waiting` | a `waiting` run | ◷ Waiting |
| `success` | a `completed` run; a completed work item | ✓ Completed |
| `error` | a `failed` or `blocked` run; a blocked work item; a connector error | ▲ Needs attention |

The derivation worth defending is `working` vs `thinking`. Both come from a
run whose status is `working`; what separates them is whether the run has told
us *what* it is doing — `currentActivity` is a sanitised one-liner the
provider supplied, and an active work item is a named unit of work. A run with
neither is live and silent.

This is a claim about TabDump's observation, not about the model's cognition.
We cannot see an agent think, and nothing pretends we can: `thinking` carries
the description *"Running, and has not reported what it is working on"*, and
that sentence is what the detail card and screen readers read out.

### What has no visual state

There is no state for "connected". A connector that is connected and has
observed nothing is **idle**, exactly as `connectors/health.ts` already
reports it. Animating it would be the app implying activity that has not
happened.

---

## 3. Adding a connector

Four things, none of them outside the provider's own files and two catalogs.

**1. A connector** — as Phase 17 describes (`connectors/providers/<name>.ts`
plus a registration in `connectors/catalog.ts`).

**2. A mark** in `visual/marks.tsx`. The drawing contract:

- a 24×24 viewBox, so every size is interchangeable;
- `stroke="currentColor"`, so the caller's tone decides the colour and a
  failing agent can be drawn in the error tone whatever its brand colour is;
- every stroke 1.5 units or thicker — the width that survives being
  rasterised at 14px on a 1× display;
- decorative unless given a `title`;
- exactly one element marked `data-agent-orbit`, which the CSS animates
  according to the state on an ancestor.

**3. A visual identity** in `visual/catalog.ts`:

```ts
{
  id: "acme-agent",
  displayName: ACME_DESCRIPTOR.displayName,  // read, never restated
  icon: AcmeMark,
  accentColor: "#ff8800",
  animations: { working: { keyframes: "agent-work-climb", durationMs: 1900, iterations: "infinite" } },
  character: { silhouette: "chevron", scale: 1, accessory: "spark" },
}
```

Everything but `id`, `displayName` and `icon` is optional. An identity with no
animations still animates correctly, and one with no character still appears
in the world — both fall back to the shared defaults.

**4. Tests.** `visual/identity.test.tsx` already asserts that every provider
in the connector catalogue has an identity, so forgetting step 3 fails the
build rather than rendering a blank.

### What does *not* change

The Agent World, the activity feed, the execution UI, the agent cards, the
settings UI, the registry, the animation engine, the layout engine and the
scene builder. `components/agents/extensibility.test.tsx` proves this by
registering a provider that exists in no catalogue and rendering it through
the real components; `visual/security.test.ts` fails the build if any module
outside `catalog.ts` mentions a provider by name.

### Branding

Every mark is an **original geometric device**, drawn for TabDump. None
reproduces, approximates or parodies a provider's real logo or mascot — that
is a constraint, not a style: a hand-drawn near-copy is both a trademark
problem and a worse design, because it invites a comparison it will always
lose. What a mark has to do is narrower and achievable: be distinguishable at
16px and stay stable, so people learn it the way they learn any other
interface convention.

If official, licensed assets become available, swapping one in means changing
`icon` on that provider's catalogue entry. No component imports a mark.

---

## 4. Adding a world theme

A theme is **data**. There is no theme-specific component, no theme-specific
layout rule, and no `switch (theme)` in the engine.

```ts
const LIBRARY: WorldTheme = {
  id: "library",
  name: "Library",
  description: "Reading desks, a reference room, and a stack.",
  spaceLabel: "library",          // used as the stage's accessible name
  stations: stationsFrom("library", {
    arrival: "Entrance",
    "work-a": "Reading desk",
    "work-b": "Reference desk",
    "work-c": "Study carrel",
    exchange: "Discussion room",
    waiting: "Waiting bench",
    done: "Returns",
    attention: "Enquiries",
  }),
  decor: decor("library", [
    atStation("work-a", "bench"),
    /* … */
  ]),
};
```

### The shared grid

All four shipped themes use `STATION_GRID`: the same eight places, the same
coordinates, the same capacities. Two things fall out of that:

- **Someone who has learnt to read one world can read all of them.** Arrival
  is always left, work is always the middle, finished work is always right,
  problems are always low-right.
- **The geometry is verified once.** Station clusters must clear one another,
  or a busy world draws one crowd on top of another.

A theme that genuinely needs its own arrangement can have one — the type takes
a plain `WorldStation[]`. It then has to satisfy the geometry tests itself.

### The geometry rules a theme must satisfy

`themes.test.ts` enforces all of these, deriving the numbers from the layout
engine's own slot spacing so that changing one re-checks every theme:

| rule | why |
|---|---|
| every zone has at least one station | a missing zone silently drops every character in that state |
| no two station clusters overlap | two full stations are two crowds |
| every cluster fits inside the stage margins | the clamp would squash two slots onto one point |
| no station within `TOP_MARGIN` of the top | a placement coordinate is the figure's **feet**, so a cluster reaches a full character height *above* its line |
| each work station has furniture at it | otherwise figures stand beside desks rather than at them |
| ambient scenery is a minority of the decor | §25: the active agent must dominate |

The top-margin rule is there because the first pass got it wrong: the exchange
zone was placed at `y: 0.10` and every agent in a meeting had its head through
the ceiling.

### There are no obstacles, and there is no pathfinding

The brief's layout list mentions obstacles. There are none, and adding them
would have been modelling a problem this design does not have: a character
does not *travel* to its station, it *is at* its station, and the browser
interpolates the change. Nothing can walk through a desk because nothing
walks. Scenery is drawn behind the figures and has no collision role at all,
which is why a theme can rearrange its furniture freely without anyone
re-deriving a navigation mesh.

What the brief calls interaction zones are the stations themselves, and what
it calls collision prevention is the slot arithmetic above — a guarantee
rather than a simulation.

---

## 5. Why the world is DOM, not canvas

TabDump already has a canvas, and the graph layer is drawn on it. The world is
not, and the reason is accessibility before anything else.

Every agent in the world is a `<button>` with a complete accessible name —
who, what state, what task, where. Tab reaches them in layout order, Enter
opens the detail card, Escape closes it. A screen reader user gets the same
information a sighted one does, in the same order, without the layout having
to mean anything to them. A canvas would have needed every bit of that
rebuilt from nothing, and most canvas visualisations never do it.

The scenery *is* an SVG, and it is `aria-hidden` in its entirety — a screen
reader announcing "bench, bench, plant, rack" would stand between someone and
the agents they came for.

---

## 6. Performance: no JavaScript animation, anywhere

Every agent animation in this product is a CSS keyframe declared once in
`globals.css` under the `agent-` prefix. `visual/animation.ts` decides *which
one, how fast, and whether at all*; it never runs one.

That is the single most consequential decision in the phase. A visual system
driven by JavaScript needs one `requestAnimationFrame` loop per moving mark,
each waking the main thread sixty times a second, each holding a closure over
React state, each needing cancelling on unmount. Twenty agents would be twenty
of them — 1200 callbacks a second competing with the graph canvas's own render
loop. CSS animations on `transform` and `opacity` are composited off the main
thread, cost the same whether there is one or fifty, stop when the element
unmounts, and cannot leak a timer because there is no timer.

Movement between stations is the same idea: the layout says where a character
belongs, React writes one `transform`, and a CSS transition walks it there.
No easing maths, no per-frame React work.

Three further properties follow:

- **Motion cannot outlive a user asking for none.** The
  `prefers-reduced-motion` and `[data-motion="off"]` blocks in `globals.css`
  already flatten every animation in the document with `!important`, which
  beats even an inline `animation-duration`. Verified in a real browser: under
  reduced motion, 0 of 14 marks animate while every state, label and glyph is
  unchanged.
- **Nothing keeps processing when hidden.** A closed world is unmounted, so
  there is nothing to keep processing.
- **Scene building is bounded.** `layout.test.ts` and `scene.test.ts` assert
  that laying out fifty agents and building a thirty-agent scene each take
  well under one frame.

What was actually measured, and where:

- **In a real browser** (headless Chrome against `next dev`, seeded through
  the app's own `localStorage` so the world rendered via the real code path):
  scenes of 7 and 29 simultaneous agents, at desktop and 412px widths, in
  normal and reduced-motion modes. No overlapping figures at either size; 10
  of 14 marks animating normally and 0 of 14 under reduced motion.
- **In tests**: separation (not mere distinctness) at 1, 2, 5, 10 and 18
  agents in one zone, at a full house across every zone, and in all four
  themes; scenes of 1, 5, 10, 20 and 30 agents; and the two timing assertions
  above.

---

## 7. Communication is derived, never invented

This is the part of the phase that could most easily have been faked. The easy
version — draw a line between any two agents on screen, send a dot along it —
would look exactly right and mean nothing.

TabDump's domain has **no agent-to-agent message**. Nothing it observes is one
agent talking to another. What the domain *does* record is real, directional
and enough:

1. **A shared file.** Two runs both touched the same `WorkArtifact`. The run
   that touched it first put something there; the run that touched it second
   found it.
2. **A passed tab.** One run `produced` a tab and another used the same tab as
   `context`. The roles are literally named "this run made it" and "this run
   read it".

A workspace where neither happened produces no handoffs and the world draws no
lines — which, for one agent working alone, is the correct picture.

Two refinements that matter:

- **Chains, not pairs.** Six runs that all touched `package.json` have fifteen
  pairs between them. Each artifact contributes a *chain* instead: sort its
  touches by time, connect consecutive ones. Five edges, each of which is the
  specific claim "this run picked the file up after that one".
- **`communicating` needs both ends live.** A single live run that once shared
  a file with a run that finished hours ago is working, not handing anything
  over. Requiring both ends also makes the state self-limiting: it ends when
  either side finishes, with no timer deciding when a conversation is over.

---

## 8. Settings

`Settings → Agent World`, persisted under `tabdump:agent-world:v1` and
registered in `SCOPED_STORAGE_KEYS`, so one account's world configuration is
invisible to another signed into the same browser.

| setting | values |
|---|---|
| Agent World | on / off |
| Environment | Office, City, Command center, Studio |
| Agent style | Icons, Characters, Pixel, Illustrated, Futuristic |
| Visual density | Minimal, Balanced, Detailed |
| Animation | Off, Subtle, Full |
| Camera | Static, Follow active, Follow all, Free (drag, wheel, arrows, `+`/`-`) |
| Agent size | 0.7×–1.5× |
| Effects | particles, handoff trails, ambient life, completion effects, status animation, scenery |
| Keep idle agents visible | on / off |
| Keep finished agents visible | on / off |
| Rearrange automatically | on / off |
| Per workspace | environment, world name |

Every control gates something the renderer actually consults. That constraint
did real work — the effect list is six switches rather than four because each
one was given a specific thing to turn off and the renderer was written to
honour it. A preferences panel whose controls do nothing is worse than a
smaller one.

**Motion is a floor, not a negotiation.** Three voices can each ask for less —
the OS via `prefers-reduced-motion`, the product via Settings → Motion, and
the world's own control — and the narrowest wins. `useAgentMotion` resolves
all three in one place, so they cannot be checked inconsistently.

**"Rearrange automatically", off**, does not remember where anybody was
standing. It selects a different pure zone mapping (`STABLE_ZONE_FOR_STATE`)
under which every live state shares one zone, so a run keeps its desk for its
whole working life and moves exactly once, when it actually finishes. A
remembered layout would have been a second source of truth about the same
scene, free to drift out of step with it and impossible to restore after a
reload.

---

## 9. Where it appears in the product

Not behind a demo route.

- **Settings → AI connectors** — each provider's mark leads its row and its
  detail page, drawn in the state its connector is in.
- **The workspace sidebar's AGENT section** — the connected-agent strip gains
  marks; a **NOW** list shows every live run with its agent's mark animating
  to that run's real state; an **Agent World** button opens the world.
- **The graph inspector** — the agent and run headers carry the acting
  agent's mark.
- **The Agent World** — a panel over the graph canvas, full-width on a phone.
  Deliberately not a route of its own: the point of watching agents work is to
  watch them work *on the workspace you are looking at*.

### Where a mark is deliberately absent

A mark is there to say *who is acting*. Where that is already unambiguous, one
is clutter, and §29's rule against noise applies as much to icons as to
animation.

So the run inspector's activity log, its file list and the agent inspector's
recent-runs list carry no marks: every row in each of them belongs to the one
agent already named at the top of that panel, and repeating its mark twelve
times down the column would add nothing but ink. The cross-agent surfaces —
the connector strip, the NOW list, the world, the settings list — are the ones
where "who" is a real question, and those all carry marks.

---

## 10. What was deliberately left out

- **Sound.** The brief allows it conditionally ("if sound is introduced").
  TabDump has a sound system, and adding world sound would have meant a
  setting most people would turn off once. Nothing here makes a noise.
- **A fifth and sixth agent style.** Five ship, and each is a genuinely
  different drawing of the same parametric figure — not one drawing behind
  five filters.
- **A per-character placement memory.** See §8.
- **Agent-to-agent messaging.** See §7. It is not observable, so it is not
  drawn.

---

## 11. Test coverage

| suite | what it pins |
|---|---|
| `visual/states.test.ts` | every state has a glyph, a word and a description; only ongoing states animate; every domain status maps |
| `visual/animation.test.ts` | the motion floor; an identity cannot loop a settled state; subtle drops ambient life first |
| `visual/identity.test.tsx` | every shipped provider has an identity; unknown providers fall back; marks are legible, colour-inheriting and titled correctly |
| `visual/security.test.ts` | no execution, no network, no storage; only the catalogue names a provider; the domain does not import the layer |
| `world/themes.test.ts` | every geometry rule in §4, for every theme |
| `world/layout.test.ts` | separation (not mere distinctness) at 1–18 agents and in every theme; append-only placement; density caps; layout cost |
| `world/handoffs.test.ts` | chains not pairs; direction; only visible runs; nothing invented |
| `world/scene.test.ts` | spawning, removal, state mapping, workspace isolation, idle stand-ins, communication, scale to 30, determinism |
| `world/persistence.test.ts` | round-trip, corruption tolerance, clamping, account scoping, field-by-field writes |
| `agents/agent-icon.test.tsx` | the presence primitives, fallbacks, accessible naming, motion gating |
| `agents/agent-world.test.tsx` | buttons, accessible names, keyboard selection and Escape, empty state, hidden counts, every effect switch |
| `agents/extensibility.test.tsx` | a provider from no catalogue, rendered end to end with no component change |
| `hooks/use-agent-world.test.tsx` | persistence through React, workspace-scoped selection, the derived clock |
