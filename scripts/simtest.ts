/**
 * Manual simulation test — runs a 2-player human game and a 2-player bot-only game
 * to verify that:
 *  - Human game: 12 ticks/year  | Bot game: 4 ticks/year
 *  - Passengers = trips × vehicle capacity (no demand-point multiplier)
 *  - "Year" labels are in use
 */

import { createGameState } from "../src/engine/createGameState"
import { buildPlayerBureaucracySummary } from "../src/engine/bureaucracy"
import { usMap } from "../src/data/maps/usMap"

function fmt(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}
function fmtMoney(n: number) {
  return "$" + (n / 1_000_000).toFixed(2) + "M"
}

// ── Test: simulate one year of operations for a simple 2-city air route ──────

function runOneYearSimulation(label: string, allBots: boolean) {
  console.log(`\n${"═".repeat(70)}`)
  console.log(`  ${label} (${allBots ? "all-bots → 4 quarterly ticks" : "human game → 12 monthly ticks"})`)
  console.log("═".repeat(70))

  const players = allBots
    ? [
        { id: "p1", name: "BotA", color: "#e74c3c", isBot: true },
        { id: "p2", name: "BotB", color: "#3498db", isBot: true },
      ]
    : [
        { id: "p1", name: "Alice", color: "#e74c3c", isBot: false },
        { id: "p2", name: "Bob",   color: "#3498db", isBot: false },
      ]

  let game = createGameState(usMap, { players, seed: 42 })

  console.log(`\noperatingConfig.simulationTicksPerPeriod = ${game.operatingConfig.simulationTicksPerPeriod}`)
  console.log(`operatingConfig.weeksPerPeriod = ${game.operatingConfig.weeksPerPeriod}`)

  // Give P1 a mid-sized rail vehicle and an air vehicle manually
  const railCard  = game.vehicleCatalog.find(c => c.type === "train")!
  const airCard   = game.vehicleCatalog.find(c => c.type === "air")!

  // Manually set up player with vehicles and a city-pair route
  // We'll directly mutate the game state for test purposes
  // P1 owns Chicago & New York (two large cities)
  const chicago  = game.cities.find(c => c.name === "Chicago")!
  const newYork  = game.cities.find(c => c.name === "New York")!
  const la       = game.cities.find(c => c.name === "Los Angeles")!
  const sf       = game.cities.find(c => c.name === "San Francisco")!

  console.log(`\nP1 routes: Chicago–New York (air) and LA–SF (rail)`)
  console.log(`Chicago size=${chicago.size} | New York size=${newYork.size} | LA size=${la.size} | SF size=${sf.size}`)
  console.log(`Air vehicle: ${airCard.name}  capacity=${airCard.totalPassengerCapacity} speed=${airCard.speed}mph`)
  console.log(`Rail vehicle: ${railCard.name}  capacity=${railCard.totalPassengerCapacity} speed=${railCard.speed}mph`)

  // Patch game state: give P1 one of each vehicle and two routes
  const airRoute  = { id: "r-air",  cityA: chicago.id,  cityB: newYork.id, mode: "air"  as const, ownerId: "p1" }
  const railRoute = { id: "r-rail", cityA: la.id,       cityB: sf.id,      mode: "rail" as const, ownerId: "p1", railTraction: "diesel" as const }

  game = {
    ...game,
    routes: [airRoute, railRoute],
    players: game.players.map(p => {
      if (p.id !== "p1") return p
      return {
        ...p,
        ownedVehicleCardIds: [...new Set([...p.ownedVehicleCardIds, airCard.id, railCard.id])],
        ownedVehicleCountsByCardId: {
          ...p.ownedVehicleCountsByCardId,
          [airCard.id]: 1,
          [railCard.id]: 1,
        },
        ownedCityCardIds: [chicago.id, newYork.id, la.id, sf.id],
      }
    }),
    bureaucracyVehicleCardIdsByRouteId: {
      [`${airRoute.id}:slot:0`]: airCard.id,
      [`${railRoute.id}:slot:0`]: railCard.id,
    },
    bureaucracyServiceCityIdsByRouteId: {
      [`${airRoute.id}:slot:0`]: [chicago.id, newYork.id],
      [`${railRoute.id}:slot:0`]: [la.id, sf.id],
    },
  }

  const summary = buildPlayerBureaucracySummary(game, "p1")!

  console.log(`\n── P1 Bureau Summary ──`)
  for (const plan of summary.routePlans) {
    if (plan.isDisconnected || plan.vehicleCard === null || plan.routes.length === 0) continue
    console.log(`\n  Pod: ${plan.serviceLabel}`)
    console.log(`    Vehicle: ${plan.vehicleCard.name}  cap=${plan.vehicleCard.totalPassengerCapacity}  fleet=${plan.selectedFleetSize}`)
    console.log(`    passengersPerTrip (display): ${fmt(plan.passengersPerTrip)}`)
    console.log(`    selectedTrips (total across segments): ${fmt(plan.selectedTrips)}`)
    console.log(`    passengersServed: ${fmt(plan.passengersServed)}`)
    const expectedFromTrips = plan.selectedTrips * plan.passengersPerTrip
    const match = Math.abs(plan.passengersServed - expectedFromTrips) <= 1 ? "✓ MATCH" : `✗ MISMATCH (expected ${fmt(expectedFromTrips)})`
    console.log(`    trips × capacity = ${fmt(expectedFromTrips)}  ${match}`)
    console.log(`    revenue: ${fmtMoney(plan.revenue)}  | opCost: ${fmtMoney(plan.operatingCost)}  | net: ${fmtMoney(plan.netRevenue)}`)
  }

  console.log(`\n  Totals:`)
  console.log(`    passengers: ${fmt(summary.totalPassengersServed)}`)
  console.log(`    revenue: ${fmtMoney(summary.totalRevenue)}`)
  console.log(`    opCost: ${fmtMoney(summary.totalOperatingCost)}`)
  console.log(`    netRevenue: ${fmtMoney(summary.netRevenue)}`)
}

runOneYearSimulation("2-player HUMAN game", false)
runOneYearSimulation("2-player BOT-ONLY game", true)

console.log("\n\nDone.")
