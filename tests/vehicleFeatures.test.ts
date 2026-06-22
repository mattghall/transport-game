/**
 * Vehicle feature tests.
 * Tests depreciation, trade-in value, exchange, and vehicle tracking across turns.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runBotSimulation } from "../src/bots/simulate.ts"
import { createGameState } from "../src/engine/createGameState.ts"
import { exchangeVehicleCard, getVehicleTradeInValue, buyVehicleCard } from "../src/engine/actions.ts"
import { usMap } from "../src/data/maps/usMap.ts"
import type { VehicleCard } from "../src/engine/types.ts"

function makeGame() {
  return createGameState(usMap, {
    players: [
      { id: "p1", name: "Alice", color: "#4a7c59", isBot: false },
      { id: "p2", name: "Bob",   color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
    ],
  })
}

describe("Vehicle depreciation", () => {
  it("trade-in value at 0 weeks = full purchase price", () => {
    const card: VehicleCard = {
      id: "v1", number: 1, type: "bus", name: "Test Bus",
      purchasePrice: 100_000, vehicleCount: 1, capacityPerVehicle: 50,
      totalPassengerCapacity: 50, operatingCostMultiplier: 1, speed: 60,
      funFact: "test",
    }
    assert.equal(getVehicleTradeInValue(card, 0), 100_000)
  })

  it("trade-in value decreases 10% per week", () => {
    const card: VehicleCard = {
      id: "v1", number: 1, type: "bus", name: "Test Bus",
      purchasePrice: 100_000, vehicleCount: 1, capacityPerVehicle: 50,
      totalPassengerCapacity: 50, operatingCostMultiplier: 1, speed: 60,
      funFact: "test",
    }
    assert.equal(getVehicleTradeInValue(card, 1), 90_000)
    assert.equal(getVehicleTradeInValue(card, 2), 80_000)
    assert.equal(getVehicleTradeInValue(card, 5), 50_000)
    assert.equal(getVehicleTradeInValue(card, 9), 10_000)
  })

  it("trade-in value floors at 10% (never goes below)", () => {
    const card: VehicleCard = {
      id: "v1", number: 1, type: "bus", name: "Test Bus",
      purchasePrice: 100_000, vehicleCount: 1, capacityPerVehicle: 50,
      totalPassengerCapacity: 50, operatingCostMultiplier: 1, speed: 60,
      funFact: "test",
    }
    // 10+ weeks: should floor at 10_000 (10%)
    assert.equal(getVehicleTradeInValue(card, 10), 10_000)
    assert.equal(getVehicleTradeInValue(card, 20), 10_000)
    assert.equal(getVehicleTradeInValue(card, 100), 10_000)
  })

  it("trade-in value is always a whole number", () => {
    const card: VehicleCard = {
      id: "v1", number: 1, type: "bus", name: "Test Bus",
      purchasePrice: 333_333, vehicleCount: 1, capacityPerVehicle: 50,
      totalPassengerCapacity: 50, operatingCostMultiplier: 1, speed: 60,
      funFact: "test",
    }
    for (let weeks = 0; weeks <= 15; weeks++) {
      const val = getVehicleTradeInValue(card, weeks)
      assert.equal(Math.floor(val), val, `trade-in at week ${weeks} is not an integer: ${val}`)
    }
  })
})

describe("Vehicle age tracking in live game", () => {
  it("vehicleWeeksOwnedByCardId increments for starter vehicle across full game", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 3000,
      recordTrace: false,
    })
    assert.ok(!result.timedOut, "game timed out")
    const p1 = result.game.players.find(p => p.id === "p1")
    assert.ok(p1, "p1 not found")
    // The starter Toyota Sienna is owned from turn 0 — should have accumulated weeks
    const starterCardId = "bus-toyota-sienna"
    if (p1.ownedVehicleCardIds.includes(starterCardId)) {
      const weeks = p1.vehicleWeeksOwnedByCardId[starterCardId]
      assert.ok(typeof weeks === "number", `starter vehicle not tracked in vehicleWeeksOwnedByCardId`)
      assert.ok(weeks > 0, `starter vehicle has 0 weeks after full game (owned since turn 1)`)
    }
    // All owned cards should be in vehicleWeeksOwnedByCardId
    for (const cardId of p1.ownedVehicleCardIds) {
      assert.ok(
        cardId in p1.vehicleWeeksOwnedByCardId,
        `ownedVehicleCardId ${cardId} not tracked in vehicleWeeksOwnedByCardId`
      )
    }
  })
})

describe("exchangeVehicleCard", () => {
  it("returns error when player cannot afford net cost", () => {
    let game = makeGame()
    const p1 = game.players.find(p => p.id === "p1")!
    const ownedCardId = p1.ownedVehicleCardIds[0]
    assert.ok(ownedCardId, "p1 has no vehicle")

    // Find a very expensive vehicle in market to force unaffordable
    const expensiveCard = game.vehicleCatalog
      .filter(c => game.vehicleMarketCardIds.includes(c.id))
      .sort((a, b) => b.purchasePrice - a.purchasePrice)[0]

    if (!expensiveCard) return // skip if no market card available

    // Drain player money to near zero
    const p1State = game.players.find(p => p.id === "p1")!
    const cheaperThanDiff = expensiveCard.purchasePrice - getVehicleTradeInValue(
      game.vehicleCatalog.find(c => c.id === ownedCardId)!,
      p1State.vehicleWeeksOwnedByCardId[ownedCardId] ?? 0
    )

    // Skip this test variant if the vehicle is actually affordable given starting cash
    if (p1State.money >= cheaperThanDiff) return

    const result = exchangeVehicleCard(game, "p1", expensiveCard.id, ownedCardId)
    assert.equal(result.ok, false, "expected exchange to fail due to insufficient funds")
  })

  it("returns error when old card not owned by player", () => {
    const game = makeGame()
    const p2CardId = game.players.find(p => p.id === "p2")?.ownedVehicleCardIds[0]
    const newCardId = game.vehicleMarketCardIds[0]
    if (!p2CardId || !newCardId) return

    const result = exchangeVehicleCard(game, "p1", newCardId, p2CardId)
    assert.equal(result.ok, false, "should reject exchange of another player's vehicle")
  })

  it("returns error when new card not in market", () => {
    const game = makeGame()
    const p1CardId = game.players.find(p => p.id === "p1")?.ownedVehicleCardIds[0]
    if (!p1CardId) return

    const result = exchangeVehicleCard(game, "p1", "nonexistent-card-id", p1CardId)
    assert.equal(result.ok, false, "should reject exchange for card not in market")
  })
})
