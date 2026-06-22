/**
 * Full-game playthrough integration tests.
 * Exercises every phase in a complete 10-turn game for 1–4 players.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { runBotSimulation } from "../src/bots/simulate.ts"
import { BOT_PRESET_IDS } from "../src/bots/presets.ts"
import type { WeeklyPhase } from "../src/engine/types.ts"

const ALL_PHASES: WeeklyPhase[] = ["add-city", "operations", "purchase-equipment", "bureaucracy"]

function assertCompletedGame(result: ReturnType<typeof runBotSimulation>, label: string) {
  assert.ok(!result.timedOut, `${label}: simulation timed out at step ${result.steps}`)
  assert.ok(result.game.isGameOver, `${label}: game never reached isGameOver`)
  assert.ok(result.game.currentWeek >= result.game.operatingConfig.totalWeeks,
    `${label}: ended on week ${result.game.currentWeek}, expected >= ${result.game.operatingConfig.totalWeeks}`)
  assert.ok(result.winnerId !== null, `${label}: no winner found`)
}

function assertAllPhasesVisited(result: ReturnType<typeof runBotSimulation>, label: string) {
  const visitedPhases = new Set(result.trace.map(t => t.phase))
  for (const phase of ALL_PHASES) {
    assert.ok(visitedPhases.has(phase), `${label}: phase "${phase}" was never visited in trace`)
  }
}

describe("Full game playthroughs", () => {
  it("1-player game completes all 10 turns", () => {
    const result = runBotSimulation({
      players: [{ id: "p1", name: "Solo Bot", color: "#4a7c59", isBot: true, botPreset: "bot-avg" }],
      maxSteps: 3000,
      recordTrace: true,
    })
    assertCompletedGame(result, "1p")
    assertAllPhasesVisited(result, "1p")
  })

  it("2-player game completes all 10 turns", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 4000,
      recordTrace: true,
    })
    assertCompletedGame(result, "2p")
    assertAllPhasesVisited(result, "2p")
  })

  it("3-player game completes all 10 turns", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
        { id: "p3", name: "Bot C", color: "#4a5c7c", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 6000,
      recordTrace: true,
    })
    assertCompletedGame(result, "3p")
    assertAllPhasesVisited(result, "3p")
  })

  it("4-player game completes all 10 turns", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
        { id: "p3", name: "Bot C", color: "#4a5c7c", isBot: true, botPreset: "bot-avg" },
        { id: "p4", name: "Bot D", color: "#7c7a4a", isBot: true, botPreset: "bot-avg" },
      ],
      maxSteps: 8000,
      recordTrace: true,
    })
    assertCompletedGame(result, "4p")
    assertAllPhasesVisited(result, "4p")
  })

  it("game with chance cards disabled completes", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
      ],
      chanceCardsEnabled: false,
      maxSteps: 4000,
      recordTrace: true,
    })
    assertCompletedGame(result, "2p-no-chance")
    assert.ok(!result.game.chanceCardsEnabled, "chanceCardsEnabled should remain false")
  })

  it("every bot preset wins at least one solo game", () => {
    for (const preset of BOT_PRESET_IDS) {
      const result = runBotSimulation({
        players: [{ id: "p1", name: `${preset} Solo`, color: "#4a7c59", isBot: true, botPreset: preset }],
        maxSteps: 3000,
        recordTrace: false,
      })
      assertCompletedGame(result, `solo-${preset}`)
    }
  })

  it("2-player game with mixed bot presets completes", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Best Bot", color: "#4a7c59", isBot: true, botPreset: "bot-best" },
        { id: "p2", name: "Chaos Bot", color: "#7c4a4a", isBot: true, botPreset: "bot-chaos" },
      ],
      maxSteps: 4000,
      recordTrace: false,
    })
    assertCompletedGame(result, "2p-mixed-presets")
  })

  it("game produces non-zero passengers for winner", () => {
    const result = runBotSimulation({
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-best" },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-best" },
      ],
      maxSteps: 4000,
      recordTrace: false,
    })
    assertCompletedGame(result, "2p-best-passenger-check")
    const winner = result.game.players.find(p => p.id === result.winnerId)
    assert.ok(winner, "winner player not found")
    assert.ok(winner.totalPassengersServed > 0, `winner moved 0 passengers`)
  })

  it("deterministic: same seed produces same result", () => {
    const opts = {
      players: [
        { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" as const },
        { id: "p2", name: "Bot B", color: "#7c4a4a", isBot: true, botPreset: "bot-avg" as const },
      ],
      seed: 42,
      maxSteps: 4000,
      recordTrace: false,
    }
    const r1 = runBotSimulation(opts)
    const r2 = runBotSimulation(opts)
    assert.equal(r1.winnerId, r2.winnerId, "winner differs between runs with same seed")
    assert.equal(r1.steps, r2.steps, "step count differs between runs with same seed")
    assert.equal(
      r1.game.players.find(p => p.id === "p1")?.totalPassengersServed,
      r2.game.players.find(p => p.id === "p1")?.totalPassengersServed,
      "p1 passengers differ between seeded runs"
    )
  })
})
