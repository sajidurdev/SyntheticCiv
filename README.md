# Synthetic Civilization Simulator

An emergent, deterministic world simulation for studying how local agent behavior becomes macro civilization dynamics.

This project is intentionally built as a simulation laboratory, not a scripted game and not an LLM-driven world.

## Project Intention

The intention behind this codebase is to make complex social dynamics understandable and testable:

- Model a living synthetic world where trade, conflict, migration, diplomacy, and collapse emerge from rules.
- Keep behavior reproducible so changes can be validated scientifically, not just visually.
- Provide a readable world-map UI so people can inspect what happened and why.
- Keep architecture modular so systems can evolve safely without rewriting the engine.

## What We Used (And Why)

- Node.js + built-in `http` server:
  - zero runtime framework lock-in
  - simple, predictable deployment
- Vanilla browser UI (`canvas` + plain JS/CSS/HTML):
  - high-performance rendering for dense world visuals
  - no frontend framework coupling
- Seeded RNG + explicit tick pipeline:
  - deterministic runs and reproducible debugging
- Domain modules (`systems/`, `settlements/`, `civilizations/`, `core/`):
  - scalable architecture with clear responsibility boundaries

## What This Is

- Deterministic simulation engine with seeded randomness.
- Emergent multi-system world model.
- Observatory-style UI for real-time and replay analysis.
- Regression-aware sandbox for long-run balancing.

## What This Is Not

- Not a quest/story script engine.
- Not AI-generated narrative control.
- Not hard territory conquest with fixed borders.

## Repository Structure

```text
.
|- server.js                    # runtime loop + HTTP API + static hosting
|- public/
|  |- index.html                # dashboard shell
|  |- app.js                    # map rendering, UI interactions, timeline/replay
|  |- styles.css                # dashboard styling
|- src/
|  |- core/
|  |  |- simulation/
|  |  |  |- Simulation.js       # orchestrator and deterministic tick order
|  |  |  |- methods/            # split engine responsibilities
|  |  |  |  |- agents.js
|  |  |  |  |- settlements.js
|  |  |  |  |- civilizations.js
|  |  |  |  |- systems.js
|  |  |  |  |- state.js
|  |- settlements/              # settlement-level modeling
|  |- civilizations/            # civ strategy, policy, culture, alignment, factions
|  |- systems/                  # economy, demographics, influence, shocks, eras...
|- scripts/
|  |- regressionSweep.js        # automated sweep/regression checks
|- data/
|  |- .gitkeep                  # keeps runtime data dir in git
|  |- latest.json               # runtime-generated persistence snapshot (ignored)
```

## Quick Start

### Requirements

- Node.js 18+ (Node 20+ recommended)
- npm

### Install

```bash
npm install
```

### Run

```bash
npm start
```

Open `http://localhost:3000`.

## Runtime Model

`server.js` runs `sim.step()` every 50ms (about 20 ticks/sec), serves the dashboard, and exposes API endpoints.

- Save cadence: every 500 ticks (atomic write to `data/latest.json`).
- Snapshot cadence: every 2 ticks (configurable in `Simulation` constructor).
- Keyframe cadence: every 20 ticks (used for compact replay continuity).

Optional debug controls:

- `SIM_DEBUG=1` enables periodic simulation diagnostics.
- `SIM_DEBUG_VERBOSE=1` enables detailed diagnostic breakdown lines.
- `SIM_DEBUG_EVERY=<ticks>` changes debug interval (default `1000` when debug is enabled).

## Deterministic Tick Pipeline

Each tick is executed in a fixed order inside `Simulation.step()`:

1. Advance tick and clear transient event containers.
2. Regenerate world resources.
3. Periodic settlement detection (`detectInterval`).
4. Decay per-agent relation memory.
5. Rebuild spatial hash.
6. Update agents (movement/action intent).
7. Rebuild spatial hash again (post-move).
8. Refresh settlement membership and migration transitions.
9. Process pair interactions (trade/cooperate/conflict/contact).
10. Compute settlement metrics from transitions.
11. Apply alignment settlement effects.
12. Update frontier pressure.
13. Run regional influence.
14. Run influence saturation.
15. Build trade routes for this tick.
16. Run innovation using current routes.
17. Run shock system.
18. Update route momentum and route pressure effects.
19. Run economy step.
20. Apply post-split support.
21. Update stress axes.
22. Refresh influence strengths.
23. Apply settlement fission (split logic).
24. Run demographics (birth/death).
25. Refresh influence and stress again after demographics.
26. Update civilizations and their clustering/matrices.
27. Update cultures and strategies.
28. Run civilization policy updates.
29. Re-run regional influence and saturation (civilization phase).
30. Apply regional and border tension deltas.
31. Update settlement beliefs/perception.
32. Smooth civilization relations (EMA).
33. Sync civilization matrices.
34. Update strategic alignment.
35. Update era history and milestones.
36. Capture snapshot/keyframe/save flags by interval.

This fixed sequence is the core determinism contract.

## Core Systems Explained

### Agents (`src/core/simulation/methods/agents.js`)

- Utility-driven decisions over gather, move, trade, cooperate, and conflict.
- Traits and psychological state influence action scoring.
- Spatially constrained contact for performance and realism.

Why: local decision rules create emergent macro patterns without scripts.

### Settlements (`src/core/simulation/methods/settlements.js`, `src/settlements/*`)

- Cluster detection and membership tracking.
- Per-tick settlement metrics (pressure, stability, migration, stress axes).
- Frontier pressure and belief/perception model.

Why: settlements are the bridge layer between agents and civilizations.

### Civilizations (`src/core/simulation/methods/civilizations.js`, `src/civilizations/*`)

- Settlement clustering into civs.
- Policy/culture/faction/alignment updates.
- Trade route graph, diplomacy lines, relation deltas, and era transitions.

Why: this converts local settlement change into strategic world behavior.

### Economy (`src/systems/economy.js`)

- Resource production/consumption by settlement.
- Trade-route transfer based on per-capita gaps and reliability.
- Economic stress and profile updates.

Why: economy creates long-horizon constraints and feedback loops.

### Demographics (`src/systems/demographics.js`)

- Birth/death rate modeling with stress and capacity effects.
- Deterministic reservoir handling for stable reproducibility.

Why: population pressure is a central driver of expansion and collapse.

### Influence + Saturation (`src/systems/influenceField.js`, `src/systems/regionalInfluence.js`, `src/systems/influenceSaturation.js`)

- Spatial influence propagation from settlements/civs.
- Regional dominance, drift, and overlap pressure.
- Saturation penalties and split incentives.

Why: influence explains map-level structure beyond raw population.

### Shocks + Innovation (`src/systems/shocks.js`, `src/systems/innovation.js`)

- Risk-based shock ignition and timed effects.
- Knowledge growth and route-based diffusion.

Why: introduces nonlinear disruption and adaptation cycles.

### Era History (`src/systems/eraHistory.js`)

- Classifies periods (Expansion/Crisis/Stabilization/Collapse/Emergence).
- Emits milestone entries from sustained multi-signal deltas.

Why: helps humans interpret long runs without reading raw telemetry.

## UI and World Map Guide

The dashboard in `public/app.js` is an observatory, not just a renderer.

- Settlement nodes: active population centers.
- Trade links: blue, thickness tracks route volume.
- Diplomacy links: gold solid for active channel, red dashed for hostility.
- Migration/knowledge links: cyan dashed variants.
- Link mode bar: `All`, `Trade`, `Diplomacy`, `Migration`, `Knowledge` to isolate channels.
- Inspector panel: selected settlement diagnostics including Trade Health, Conflict Risk, and stress signals.
- Timeline + replay: inspect historical ticks and era transitions.

## API Surface

### `GET /api/state?since=<tick>`

Returns incremental snapshots and recent events.

Response includes:

- `currentTick`
- `latestTick`
- `snapshots[]`
- `eraHistory`
- `recentEvents[]`

### `GET /api/config`

Returns world dimensions and current agent count.

## Persistence and Reproducibility

- Save file: `data/latest.json`
- Schema: payload/state version `2`
- Persistence includes:
  - full simulation state
  - RNG state
  - rolling windows and route memory
  - keyframes + recent events
- `data/latest.json` is runtime-generated and ignored by git (`.gitignore`).

On restart, if schema matches, simulation hydrates and continues from exact deterministic state.

## Regression and Sweep

Run before publishing:

```bash
npm run sweep
npm run regression
```

Example with stricter gate:

```bash
npm run regression -- --runs 10 --ticks 8000 --minPassRate 0.8
```

The regression script validates multi-seed stability bands for:

- conflict/stability/pressure ranges
- active settlement count
- births and deaths rates
- interaction utilization

## Safe Extension Guidelines

- Preserve tick order in `Simulation.step()`.
- Keep seeded RNG calls in deterministic paths.
- Avoid hidden side effects in UI code.
- Add new systems as modules, not monolith patches.
- Prefer bounded algorithms for per-tick loops.
- Validate with multi-seed regression, not single-run visuals.

## Public-Ready Checklist

- `npm start` boots cleanly.
- `npm run regression` passes target pass rate.
- No stale/unused legacy modules in public surface.
- README reflects actual API, runtime cadence, and architecture.
- UI map semantics are understandable without source reading.

## License

MIT
