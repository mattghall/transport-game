# Matt's Transport Game

Developer notes for the current codebase. This README is meant to help you **run, debug, and extend** the app, not explain player rules.

## Stack

- **UI:** React 19 + TypeScript
- **Bundler/dev server:** Vite
- **Map rendering:** SVG in the main game UI, React Leaflet in the rail comparison page
- **Game logic:** custom engine under `src/engine`

## Quick start

The session server is required for all gameplay. You need two terminals:

```bash
# Terminal 1 — UI dev server
npm install
npm run dev

# Terminal 2 — session server (game logic, bot runner)
npm run session-server
```

The session server runs on **port 8787**. The launcher shows "Session server: offline" and disables the lobby button if it isn't running.

To allow friends to join from outside your network, run a third terminal:

```powershell
# Terminal 3 — public tunnel (optional, Windows)
powershell -ExecutionPolicy Bypass -File start-transit.ps1
```

This starts a Cloudflare quick tunnel and updates `http://transit.trailmatt.com` to redirect to it. Share that URL with friends.

Useful scripts:

```bash
npm run build   # TypeScript compile + production bundle
npm run lint    # ESLint
npm run preview # Preview the production build
```

## Bot training

The session server (`npm run session-server`) also manages training subprocess lifecycle. With it running, open the training dashboard:

- `http://localhost:5173/training.html` — training dashboard
- `http://localhost:5173/admin.html` — admin controls (start/stop autotune, manage champions)

To run autotune directly from the terminal (bypasses the UI):

```bash
npm run autotune:bots
```

Champion weights are written to `public/training-results/champion-Xp.json` and promoted into `public/training-results/bot-presets.json`, which the game loads at runtime.

## All dev URLs

- `http://localhost:5173/` — main game
- `http://localhost:5173/training.html` — bot training dashboard
- `http://localhost:5173/admin.html` — admin / autotune control
- `http://localhost:5173/compare.html` — map/rail comparison tool
- `http://localhost:5173/manual-training.html` — manual bot weight editor

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
  - Holds the local `game` state (updated via SSE from the session server)
  - Owns undo history (local games only)
  - Wires UI callbacks to engine actions — each callback sends a `GameAction` descriptor to the session server via `POST /sessions/:id/action`
  - The server applies the action, runs any bot turns, and broadcasts the updated state to all clients via SSE

### Server-authoritative model

- **`server/sessionServer.mjs`**
  - Single source of truth for game state
  - Receives `GameAction` descriptors from clients, applies them via the engine, and SSE-broadcasts the result
  - Runs bot turns server-side after each human action
  - Validates turn ownership (`canPlayerAct`) — returns 403 if it's not the player's turn
- **`src/engine/gameActions.ts`**
  - Defines the `GameAction` union (16 action types) — the wire protocol for `POST /sessions/:id/action`
- **`src/network/sessionSync.ts`**
  - Client↔server HTTP + SSE communication
  - `postLanSessionAction()` — sends a `GameAction` to the server

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

Each player advances through phases **independently** each week — the pipeline allows players to be in different phases simultaneously, gated so player N can only start a phase once player N-1 has moved past it.

Phase order per player per week:

1. `purchase-equipment` — buy vehicle cards
2. `add-city` — draw 4 city cards from a regional deck, keep 2
3. `operations` — claim rail/air routes; configure service pods and vehicle assignments
4. `bureaucracy` — review projected revenue/costs; confirm to end your week

All four phases complete for all players before the week advances. The lead player rotates each week.

If phase behavior feels wrong, start in:

- `src/engine/actions.ts` for turn/phase gating (`canPlayerStartPhaseByPipeline`, `markPurchaseEquipmentReady`, `markOperationsReady`, `markBureaucracyReady`)
- `src/ui/Board.tsx` for what controls are exposed in each phase (`viewerPhase` drives all UI gating)

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

## Current dev reality

- The main app entry point is `src/App.tsx`
- The engine mutation layer is `src/engine/actions.ts`
- Operations/bureaucracy summaries live in `src/engine/bureaucracy.ts`
- The main board UI is `src/ui/Board.tsx`
- There is currently **no test script** in `package.json`; the main built-in validation paths are `npm run build` and `npm run lint`
