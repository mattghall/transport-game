/**
 * Game state initialization and normalization tests.
 * Verifies all required fields are present, typed correctly, and survive round-trips.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createGameState } from "../src/engine/createGameState.ts"
import { normalizeGameState } from "../src/engine/normalizeGameState.ts"
import { usMap } from "../src/data/maps/usMap.ts"
import type { GameState, WeeklyPhase } from "../src/engine/types.ts"

function makeGame(overrides: Parameters<typeof createGameState>[1] = {}) {
  return createGameState(usMap, {
    players: [
      { id: "p1", name: "Alice", color: "#4a7c59", isBot: false },
      { id: "p2", name: "Bob",   color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
    ],
    ...overrides,
  })
}

describe("Game state initialization", () => {
  it("creates a valid initial game state", () => {
    const game = makeGame()
    assert.ok(game, "createGameState returned null/undefined")
    assert.equal(game.currentWeek, 1)
    assert.equal(game.isGameOver, false)
    assert.equal(game.players.length, 2)
    assert.ok(game.cities.length > 0, "no cities loaded")
    // game.routes = player-claimed routes (empty at start); map routes are on game.map
    assert.ok(Array.isArray(game.routes), "routes should be an array")
  })

  it("all new fields are present with correct defaults", () => {
    const game = makeGame()
    assert.equal(typeof game.turnTimerSeconds, "number")
    assert.equal(game.turnTimerSeconds, 0)
    assert.equal(game.turnTimerExpiresAt, null)
    assert.equal(game.autoPlayUntilWeek, 0)
  })

  it("turn timer is set when configured in lobby", () => {
    const game = makeGame({ turnTimerSeconds: 60 })
    assert.equal(game.turnTimerSeconds, 60)
  })

  it("autoPlayUntilWeek is set when configured", () => {
    const game = makeGame({ autoPlayUntilWeek: 3 })
    assert.equal(game.autoPlayUntilWeek, 3)
  })

  it("every player has vehicleWeeksOwnedByCardId initialized", () => {
    const game = makeGame()
    for (const player of game.players) {
      assert.ok(
        typeof player.vehicleWeeksOwnedByCardId === "object" && player.vehicleWeeksOwnedByCardId !== null,
        `player ${player.id} missing vehicleWeeksOwnedByCardId`
      )
    }
  })

  it("starter bus vehicle is tracked in vehicleWeeksOwnedByCardId", () => {
    const game = makeGame()
    for (const player of game.players) {
      if (player.ownedVehicleCardIds.length > 0) {
        const cardId = player.ownedVehicleCardIds[0]
        assert.ok(
          cardId in player.vehicleWeeksOwnedByCardId,
          `player ${player.id} starter vehicle ${cardId} not tracked`
        )
        assert.equal(player.vehicleWeeksOwnedByCardId[cardId], 0, "starter vehicle should start at 0 weeks")
      }
    }
  })

  it("all required GameState array fields are arrays", () => {
    const game = makeGame()
    const arrayFields: (keyof GameState)[] = [
      "cities", "routes", "players", "chanceCatalog", "chanceDeckCardIds",
      "chanceDiscardCardIds", "vehicleCatalog", "vehicleMarketCardIds",
      "routeCatalog", "bureaucracyReadyPlayerIds", "purchasedVehiclePlayerIds",
      "claimedRoutePlayerIdsThisTurn", "actionLog",
    ]
    for (const field of arrayFields) {
      assert.ok(Array.isArray(game[field]), `${field} is not an array`)
    }
  })

  it("all required GameState object fields are objects", () => {
    const game = makeGame()
    const objectFields: (keyof GameState)[] = [
      "routeMarketCardIdsByMode", "cityDeckCardIdsByRegion",
      "bureaucracyFuelUnitsByRouteId", "bureaucracyVehicleCardIdsByRouteId",
      "bureaucracyServiceCityIdsByRouteId", "bureaucracyServiceSlotCountsByCorridorId",
      "resourceMarket", "resourceSupply",
      "purchasedVehicleTypesThisPhase", "claimedRouteCountsByPlayerIdThisTurn",
      "claimedRouteModesThisPhase",
    ]
    for (const field of objectFields) {
      const val = game[field]
      assert.ok(val !== null && typeof val === "object" && !Array.isArray(val),
        `${field} is not a plain object`)
    }
  })

  it("currentPhase is a valid WeeklyPhase", () => {
    const game = makeGame()
    const validPhases: WeeklyPhase[] = ["add-city", "operations", "purchase-equipment", "bureaucracy"]
    assert.ok(validPhases.includes(game.currentPhase), `invalid initial phase: ${game.currentPhase}`)
  })

  it("currentPlayerId is one of the player IDs", () => {
    const game = makeGame()
    const playerIds = game.players.map(p => p.id)
    assert.ok(playerIds.includes(game.currentPlayerId), `currentPlayerId ${game.currentPlayerId} not in players`)
  })
})

describe("normalizeGameState", () => {
  it("round-trips a fresh game state unchanged", () => {
    const game = makeGame()
    const normalized = normalizeGameState(game as any)
    assert.equal(normalized.currentWeek, game.currentWeek)
    assert.equal(normalized.players.length, game.players.length)
    assert.equal(normalized.currentPhase, game.currentPhase)
  })

  it("migrates legacy phase names", () => {
    const game = makeGame() as any
    const legacyGame = { ...game, currentPhase: "claim-routes" }
    const normalized = normalizeGameState(legacyGame)
    assert.equal(normalized.currentPhase, "add-city")
  })

  it("migrates legacy purchase-fuel phase to bureaucracy", () => {
    const game = makeGame() as any
    const legacyGame = { ...game, currentPhase: "purchase-fuel" }
    const normalized = normalizeGameState(legacyGame)
    assert.equal(normalized.currentPhase, "bureaucracy")
  })

  it("provides defaults for missing optional fields", () => {
    const game = makeGame() as any
    const stripped = {
      ...game,
      turnTimerSeconds: undefined,
      turnTimerExpiresAt: undefined,
      autoPlayUntilWeek: undefined,
      bureaucracyReadyPlayerIds: undefined,
      purchasedVehiclePlayerIds: undefined,
      claimedRoutePlayerIdsThisTurn: undefined,
      claimedRouteCountsByPlayerIdThisTurn: undefined,
      chanceCardsEnabled: undefined,
    }
    const normalized = normalizeGameState(stripped)
    assert.equal(normalized.turnTimerSeconds, 0)
    assert.equal(normalized.turnTimerExpiresAt, null)
    assert.equal(normalized.autoPlayUntilWeek, 0)
    assert.deepEqual(normalized.bureaucracyReadyPlayerIds, [])
    assert.deepEqual(normalized.purchasedVehiclePlayerIds, [])
    assert.deepEqual(normalized.claimedRoutePlayerIdsThisTurn, [])
    assert.deepEqual(normalized.claimedRouteCountsByPlayerIdThisTurn, {})
    assert.equal(normalized.chanceCardsEnabled, true)
  })

  it("fills in missing vehicleWeeksOwnedByCardId for legacy players", () => {
    const game = makeGame() as any
    const legacyGame = {
      ...game,
      players: game.players.map((p: any) => {
        const { vehicleWeeksOwnedByCardId: _, ...rest } = p
        return rest
      }),
    }
    const normalized = normalizeGameState(legacyGame)
    for (const player of normalized.players) {
      assert.ok(
        typeof player.vehicleWeeksOwnedByCardId === "object",
        `player ${player.id} still missing vehicleWeeksOwnedByCardId after normalization`
      )
    }
  })

  it("migrates legacy action log phase names", () => {
    const game = makeGame() as any
    const legacyGame = {
      ...game,
      actionLog: [
        { id: "a1", playerId: "p1", playerName: "Alice", week: 1, phase: "claim-routes", message: "test" },
        { id: "a2", playerId: "p1", playerName: "Alice", week: 1, phase: "purchase-fuel", message: "test" },
        { id: "a3", playerId: "p1", playerName: "Alice", week: 1, phase: "operations", message: "test" },
      ],
    }
    const normalized = normalizeGameState(legacyGame)
    assert.equal(normalized.actionLog[0].phase, "add-city")
    assert.equal(normalized.actionLog[1].phase, "bureaucracy")
    assert.equal(normalized.actionLog[2].phase, "operations")
  })
})
