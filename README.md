# Matt's Transport Game

Developer notes for the current codebase. This README is meant to help you **run, debug, and extend** the app, not explain player rules.

## Stack

- **UI:** React 19 + TypeScript
- **Bundler/dev server:** Vite
- **Map rendering:** SVG in the main game UI, React Leaflet in the rail comparison page
- **Game logic:** custom engine under `src/engine`

## Quick start

Install deps and start the app:

```bash
npm install
npm run dev
```

Useful scripts:

```bash
npm run build   # TypeScript compile + production bundle
npm run lint    # ESLint
npm run preview # Preview the production build
```

Main URLs while developing:

- `http://localhost:5173/` - main game
- `http://localhost:5173/compare.html` - map/rail comparison tool

## High-level architecture

The live app only uses code from **`src/`**.

### Main flow

1. `src/main.tsx` mounts `App`.
2. `src/App.tsx` owns the canonical `game` state and history stack.
3. `App.tsx` calls pure-ish engine functions from `src/engine/*`.
4. `App.tsx` passes the resulting state plus callbacks into `src/ui/Board.tsx`.
5. `Board.tsx` renders the map, side panels, and phase-specific controls.

The important separation is:

- **`src/ui/*`** decides what the player can click and what gets displayed.
- **`src/engine/*`** decides what those clicks mean and how `GameState` changes.

## Where the important logic lives

### App shell and state wiring

- **`src/App.tsx`**
  - Holds the main `game` state with `useState`
  - Owns undo history
  - Wires UI callbacks to engine actions like:
    - `buyVehicleCard`
    - `drawCityOffer`
    - `claimRoute`
    - `upgradeRailRoute`
    - `setBureaucracyRouteVehicleCard`
    - `setBureaucracyServiceCities`
    - `addBureaucracyServiceSplit`
    - `advanceTurn`
  - Adds action-log messages around engine results

### Initial game setup

- **`src/engine/createGameState.ts`**
  - Creates the initial `GameState`
  - Seeds players, chance deck, vehicle market, city decks, resource tracks
  - Defines the starting operating config and starting money
- **`src/gameSetup/defaultPlayers.ts`**
  - Shared default player presets for setup UI
  - Use this file when changing default names/colors/player count

### Core write operations

- **`src/engine/actions.ts`**
  - This is the main mutation layer for the game
  - If something changes `GameState`, it is probably here
  - Key entry points:
    - `advancePhase`
    - `advanceTurn`
    - `buyVehicleCard`
    - `drawCityOffer`
    - `setActiveCityOfferKeptCityIds`
    - `claimRoute`
    - `upgradeRailRoute`
    - `setBureaucracyRouteVehicleCard`
    - `setBureaucracyServiceCities`
    - `addBureaucracyServiceSplit`
    - `buyResource`

### Operations / bureaucracy / pod logic

- **`src/engine/bureaucracy.ts`**
  - Builds the per-player service summaries used by the UI
  - Computes pod groupings, route plans, capacity, stranded demand, payouts, and fuel usage
  - Important exports:
    - `buildPlayerBureaucracySummary`
    - `buildBureaucracySummaries`
    - `findPlayerBureaucracyPlan`
    - `applyBureaucracyFuelConsumption`

### Economic and movement math

- **`src/engine/economy.ts`**
  - Demand size / absorption rules
  - Connection bonuses
  - fleet and affordability helpers
  - rail upgrade cost
- **`src/engine/trips.ts`**
  - distance math
  - trip duration
  - trips per week
  - fuel burn calculations

### Types and core data model

- **`src/engine/types.ts`**
  - `GameState`
  - `Player`
  - `Route`
  - `WeeklyPhase`
  - `VehicleCard`
  - deck and market types

### Map data and rendering

- **`src/data/maps/usMap.ts`**
  - city definitions
  - adjacency graph
  - map metadata
- **`src/data/maps/usOutline.ts`**
  - outline polygon for the board SVG
- **`src/engine/projection.ts`**
  - lat/lng to board-space projection helpers
- **`src/engine/layout.ts`**
  - city label placement / collision logic
- **`src/ui/Board.tsx`**
  - main board renderer
  - phase-specific panels
  - route previews
  - map interactions

### Deck editing and persistence

- **`src/data/deckData.ts`**
  - starter deck definitions
  - import/export helpers
  - browser persistence for user-edited decks
  - localStorage key: `transport-game-user-decks-v1`
- **`src/data/chanceCards.ts`**
  - shipped chance cards
- **`src/ui/StartMenu.tsx`**
  - player setup UI
  - deck editor UI

## Current phase flow

The active weekly phase order is defined in `src/engine/actions.ts`:

1. `purchase-equipment`
2. `claim-routes`
3. `operations`
4. `bureaucracy`

Important note: the current codebase uses these phases a little differently than older docs implied.

- **`purchase-equipment`**
  - buy vehicle cards
- **`claim-routes`**
  - draw and keep city cards
  - this is more of a city-acquisition step right now
- **`operations`**
  - manual route building happens here
  - rail track building and air route claiming go through `claimRoute`
  - per-pod vehicle assignment and service splitting also happen here via the bureaucracy-related setters
- **`bureaucracy`**
  - read-only results / ledger view in the UI
  - end-of-phase resolution applies fuel consumption and advances the game economy

If phase behavior feels wrong, start in:

- `src/engine/actions.ts` for turn/phase gating
- `src/ui/Board.tsx` for what controls are exposed in each phase

## Debugging guide

### "Why did the game state change?"

Start with:

- `src/App.tsx` to see which callback fired
- `src/engine/actions.ts` to inspect the actual state mutation

### "Why is this pod / ledger / flow map weird?"

Start with:

- `src/engine/bureaucracy.ts` for grouping and summary logic
- `src/ui/Board.tsx` for presentation

### "Why is demand / money / cost / fleet math off?"

Start with:

- `src/engine/economy.ts`
- `src/engine/trips.ts`
- `src/engine/bureaucracy.ts`

### "Why is a route valid or invalid?"

Start with:

- `src/engine/actions.ts`
  - `resolveRouteSelection`
  - `resolveSegmentSelection`
  - `getConnectionOptions`
  - `claimRoute`

### "Why does the map look wrong?"

Start with:

- `src/data/maps/usMap.ts`
- `src/data/maps/usOutline.ts`
- `src/engine/projection.ts`
- `src/engine/layout.ts`
- `src/ui/Board.tsx`

### "Why did a deck / edited cards disappear?"

Start with:

- `src/data/deckData.ts`
- browser localStorage entry `transport-game-user-decks-v1`

## Compare tool

The compare page is separate from the main game UI:

- entry: `src/compare.tsx`
- UI: `src/CompareApp.tsx`

Use it when debugging:

- city adjacency
- rail-eligible links
- map geography against OpenRailwayMap

## About `.sim-build/`

`.sim-build/` is **not** part of the Vite app entry path. The main app imports from `src/`.

That directory is a JavaScript-side helper area for simulation/debug scripts like:

- `.sim-build/simulateBalance.js`

If you change core engine behavior in `src/`, treat `.sim-build/` as a separate support path that may also need manual updates if you still rely on those scripts.

## Current dev reality

- The main app entry point is `src/App.tsx`
- The engine mutation layer is `src/engine/actions.ts`
- Operations/bureaucracy summaries live in `src/engine/bureaucracy.ts`
- The main board UI is `src/ui/Board.tsx`
- There is currently **no test script** in `package.json`; the main built-in validation paths are `npm run build` and `npm run lint`
