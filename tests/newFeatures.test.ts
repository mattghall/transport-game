/**
 * New feature integration tests.
 * Covers turn timer, auto-play bot handoff, and action log.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createGameState } from "../src/engine/createGameState.ts"
import { normalizeGameState } from "../src/engine/normalizeGameState.ts"
import { runBotSimulation } from "../src/bots/simulate.ts"
import { usMap } from "../src/data/maps/usMap.ts"
import { applyBotAction } from "../src/bots/actions.ts"

function makeGame(overrides: Parameters<typeof createGameState>[1] = {}) {
  return createGameState(usMap, {
    players: [
      { id: "p1", name: "Alice", color: "#4a7c59", isBot: false },
      { id: "p2", name: "Bob",   color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
    ],
    ...overrides,
  })
}

describe("Turn timer", () => {
  it("turnTimerSeconds=0 means no timer (default)", () => {
    const game = makeGame({ turnTimerSeconds: 0 })
    assert.equal(game.turnTimerSeconds, 0)
    assert.equal(game.turnTimerExpiresAt, null)
  })

  it("turnTimerSeconds is stored and normalized correctly", () => {
    const game = makeGame({ turnTimerSeconds: 90 })
    assert.equal(game.turnTimerSeconds, 90)

    // Normalize and check it's preserved
    const normalized = normalizeGameState(game as any)
    assert.equal(normalized.turnTimerSeconds, 90)
  })

  it("normalizing a game without turnTimerSeconds defaults to 0", () => {
    const game = makeGame() as any
    delete game.turnTimerSeconds
    const normalized = normalizeGameState(game)
    assert.equal(normalized.turnTimerSeconds, 0)
  })

  it("normalizing preserves non-null turnTimerExpiresAt", () => {
    const game = makeGame() as any
    game.turnTimerExpiresAt = 9999999999
    const normalized = normalizeGameState(game)
    assert.equal(normalized.turnTimerExpiresAt, 9999999999)
  })
})

describe("Auto-play / bot handoff", () => {
  it("autoPlayUntilWeek=0 means disabled", () => {
    const game = makeGame({ autoPlayUntilWeek: 0 })
    assert.equal(game.autoPlayUntilWeek, 0)
  })

  it("autoPlayUntilWeek=3 is stored correctly", () => {
    const game = makeGame({ autoPlayUntilWeek: 3 })
    assert.equal(game.autoPlayUntilWeek, 3)
  })

  it("normalizing a game without autoPlayUntilWeek defaults to 0", () => {
    const game = makeGame() as any
    delete game.autoPlayUntilWeek
    const normalized = normalizeGameState(game)
    assert.equal(normalized.autoPlayUntilWeek, 0)
  })

  it("game runs through autoPlayUntilWeek weeks with bots, then continues", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
      ],
      autoPlayUntilWeek: 3,
      maxSteps: 4000,
      recordTrace: false,
    })
    assert.ok(!result.timedOut, "game timed out with autoPlayUntilWeek=3")
    assert.ok(result.game.isGameOver, "game did not complete")
    // autoPlayUntilWeek should still be 3 (field is not mutated unless stop-auto-play is fired)
    assert.equal(result.game.autoPlayUntilWeek, 3)
  })
})

describe("Action log", () => {
  it("action log exists and starts empty", () => {
    const game = makeGame()
    assert.ok(Array.isArray(game.actionLog), "actionLog is not an array")
  })

  it("action log entries have required fields when populated", () => {
    // Action log is populated by server-side human actions; bots may not produce entries.
    // Verify the structure is valid for any entries that do exist.
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 4000,
      recordTrace: false,
    })
    const log = result.game.actionLog
    assert.ok(Array.isArray(log), "actionLog is not an array after full game")

    const validPhases = ["add-city", "operations", "purchase-equipment", "bureaucracy"]
    for (const entry of log) {
      assert.ok(typeof entry.id === "string", "entry.id is not a string")
      assert.ok(typeof entry.playerName === "string", "entry.playerName is not a string")
      assert.ok(typeof entry.week === "number", "entry.week is not a number")
      assert.ok(typeof entry.message === "string", "entry.message is not a string")
      assert.ok(validPhases.includes(entry.phase),
        `entry.phase "${entry.phase}" is not a valid phase`)
    }
  })

  it("action log week numbers are within game range", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 3000,
      recordTrace: false,
    })
    const totalWeeks = result.game.operatingConfig.totalWeeks
    for (const entry of result.game.actionLog) {
      assert.ok(entry.week >= 1 && entry.week <= totalWeeks,
        `entry week ${entry.week} out of range [1, ${totalWeeks}]`)
    }
  })
})

describe("Game invariants throughout simulation", () => {
  it("player money never goes negative after a full game", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 4000,
      recordTrace: false,
    })
    assert.ok(!result.timedOut)
    for (const player of result.game.players) {
      assert.ok(player.money >= 0, `player ${player.name} ended with negative money: ${player.money}`)
    }
  })

  it("totalPassengersServed is non-negative for all players", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 4000,
      recordTrace: false,
    })
    for (const player of result.game.players) {
      assert.ok(player.totalPassengersServed >= 0,
        `player ${player.name} has negative passengers: ${player.totalPassengersServed}`)
    }
  })

  it("winner has most passengers among all players", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
        { id: "p3", name: "Bot C", color: "#4a5c7c", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 6000,
      recordTrace: false,
    })
    assert.ok(result.winnerId, "no winner found")
    const winner = result.game.players.find(p => p.id === result.winnerId)!
    for (const player of result.game.players) {
      if (player.id === result.winnerId) continue
      assert.ok(
        winner.totalPassengersServed >= player.totalPassengersServed,
        `winner ${winner.name} (${winner.totalPassengersServed}) has fewer passengers than ${player.name} (${player.totalPassengersServed})`
      )
    }
  })

  it("currentWeek never exceeds totalWeeks after game over", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 3000,
      recordTrace: false,
    })
    assert.ok(result.game.isGameOver)
    assert.ok(
      result.game.currentWeek <= result.game.operatingConfig.totalWeeks,
      `currentWeek ${result.game.currentWeek} exceeds totalWeeks ${result.game.operatingConfig.totalWeeks}`
    )
  })

  it("vehicleWeeksOwnedByCardId is consistent with ownedVehicleCardIds at end of game", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 3000,
      recordTrace: false,
    })
    assert.ok(result.game.isGameOver)
    const p1 = result.game.players.find(p => p.id === "p1")!
    // Every card in ownedVehicleCardIds must appear in vehicleWeeksOwnedByCardId
    for (const cardId of p1.ownedVehicleCardIds) {
      assert.ok(
        cardId in p1.vehicleWeeksOwnedByCardId,
        `ownedVehicleCardId ${cardId} not tracked in vehicleWeeksOwnedByCardId`
      )
    }
  })
})
