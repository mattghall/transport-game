# Matt's Transport Game

Browser-based board game inspired by **Ticket to Ride** and **Power Grid**. The app uses a React + TypeScript UI with a deterministic engine layer for map, route, economy, and operating rules.

## Demand cube rules

City size now affects **generation** and **absorption** differently:

- A city generates outbound cubes equal to its `size`.
- A city can absorb inbound cubes equal to `size + 1`.
- A `size: 0` city generates no cubes, but it can still absorb **1** cube.
- A `size: 1` city generates **1** cube and can absorb **2** cubes.

This means demand transfer is no longer perfectly symmetric. Small cities can still act as sinks even when they do not create their own outbound demand.

## Board display

- Demand tokens render in stacks above each city.
- Green cubes represent normal demand increments.
- Yellow cylinders are reserved for very large demand totals and only appear once a city reaches higher capacity.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```
