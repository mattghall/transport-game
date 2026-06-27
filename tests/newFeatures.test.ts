/**
 * New feature integration tests.
 * Covers turn timer, auto-play bot handoff, and action log.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createGameState } from "../src/engine/createGameState.ts"
import { normalizeGameState } from "../src/engine/normalizeGameState.ts"
import { claimRoute, exchangeVehicleCard, setBureaucracyRouteVehicleCard, setBureaucracyServicePodCities } from "../src/engine/actions.ts"
import { buildPlayerBureaucracySummary } from "../src/engine/bureaucracy.ts"
import { runBotSimulation } from "../src/bots/simulate.ts"
import { usMap } from "../src/data/maps/usMap.ts"
import { getBotLegalActions } from "../src/bots/actions.ts"
import { getCachedBureaucracySummary } from "../src/bots/summaryCache.ts"
import { getTopScoredBotCandidates } from "../src/bots/scriptedBot.ts"
import { collapseVehicleQuantityCandidates, selectVehicleCoachingCandidates } from "../src/data/coachingCandidates.ts"
import { compareOperationsReviewOutcomes, summarizeOperationsReviewOutcome } from "../src/data/coachingReview.ts"
import { deriveCoachedWeights, extractTrainingSignals } from "../scripts/trainFromCoaching.ts"

function makeGame(overrides: Parameters<typeof createGameState>[1] = {}) {
  return createGameState(usMap, {
    players: [
      { id: "p1", name: "Alice", color: "#4a7c59", isBot: false },
      { id: "p2", name: "Bob",   color: "#7c4a4a", isBot: true, botPreset: "bot-avg" },
    ],
    ...overrides,
  })
}

function makeTexasRailBotGame(
  ownedCityCardIds = [
    "austin",
    "san_antonio",
    "houston",
    "dallas_fort_worth",
    "corpus_christi",
    "shreveport",
    "new_orleans",
  ],
) {
  const game = createGameState(usMap, {
    players: [
      { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
    ],
  })
  const trainCard = game.vehicleCatalog.find(card => card.type === "train")
  assert.ok(trainCard, "expected a train card in the vehicle catalog")

  const player = game.players[0]
  player.phase = "operations"
  player.ownedCityCardIds = ownedCityCardIds
  player.ownedVehicleCardIds = [trainCard!.id]
  player.ownedVehicleCountsByCardId = { [trainCard!.id]: 1 }
  player.vehicleWeeksOwnedByCardId = { [trainCard!.id]: 0 }
  game.currentPlayerId = player.id
  game.currentPhase = "operations"
  game.routes.push({
    id: "test-austin-houston",
    cityA: "austin",
    cityB: "houston",
    mode: "rail",
    ownerId: player.id,
  })

  return game
}

function makeNoTrackTrainPurchaseGame() {
  const game = createGameState(usMap, {
    players: [
      { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
    ],
  })
  const player = game.players[0]
  player.phase = "purchase-equipment"
  player.money = 200_000_000
  player.ownedCityCardIds = ["seattle", "phoenix", "miami"]
  player.ownedVehicleCardIds = []
  player.ownedVehicleCountsByCardId = {}
  player.vehicleWeeksOwnedByCardId = {}
  game.currentPlayerId = player.id
  game.currentPhase = "purchase-equipment"
  const busCard = game.vehicleCatalog.find(card => card.type === "bus")
  const trainCard = game.vehicleCatalog.find(card => card.type === "train")
  assert.ok(busCard, "expected a bus card in the vehicle catalog")
  assert.ok(trainCard, "expected a train card in the vehicle catalog")
  game.vehicleMarketCardIds = [trainCard!.id, busCard!.id]
  return game
}

function makeOwnedBusRebuyGame() {
  const game = createGameState(usMap, {
    players: [
      { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
    ],
  })
  const player = game.players[0]
  const busCard = game.vehicleCatalog.find(card => card.type === "bus")
  assert.ok(busCard, "expected a bus card in the vehicle catalog")
  player.phase = "purchase-equipment"
  player.money = 200_000_000
  player.ownedCityCardIds = ["seattle", "phoenix", "miami", "atlanta"]
  player.ownedVehicleCardIds = [busCard!.id]
  player.ownedVehicleCountsByCardId = { [busCard!.id]: 1 }
  player.vehicleWeeksOwnedByCardId = { [busCard!.id]: 0 }
  game.currentPlayerId = player.id
  game.currentPhase = "purchase-equipment"
  game.vehicleMarketCardIds = []
  return game
}

function makeUnderusedRailPodGame() {
  let game = createGameState(usMap, {
    players: [
      { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
    ],
  })
  const trainCard = game.vehicleCatalog.find(card => card.type === "train")
  assert.ok(trainCard, "expected a train card in the vehicle catalog")

  const player = game.players[0]
  player.phase = "operations"
  player.money = 200_000_000
  player.ownedCityCardIds = ["atlanta", "charlotte", "nashville", "raleigh_durham"]
  player.ownedVehicleCardIds = [trainCard!.id]
  player.ownedVehicleCountsByCardId = { [trainCard!.id]: 1 }
  player.vehicleWeeksOwnedByCardId = { [trainCard!.id]: 0 }
  game.currentPlayerId = player.id
  game.currentPhase = "operations"

  const atlantaCharlotte = claimRoute(game, { mode: "rail", cityIds: ["atlanta", "charlotte"] }, player.id)
  assert.ok(atlantaCharlotte.ok, "expected Atlanta–Charlotte rail claim to succeed")
  game = atlantaCharlotte.game
  const atlantaNashville = claimRoute(game, { mode: "rail", cityIds: ["atlanta", "nashville"] }, player.id)
  assert.ok(atlantaNashville.ok, "expected Atlanta–Nashville rail claim to succeed")
  game = atlantaNashville.game
  const charlotteRaleigh = claimRoute(game, { mode: "rail", cityIds: ["charlotte", "raleigh_durham"] }, player.id)
  assert.ok(charlotteRaleigh.ok, "expected Charlotte–Raleigh rail claim to succeed")
  game = charlotteRaleigh.game

  const summary = getCachedBureaucracySummary(game, player.id)
  assert.ok(summary, "expected a bureaucracy summary")
  const railPlan = summary!.routePlans.find(plan => !plan.isDisconnected && plan.route.mode === "rail")
  assert.ok(railPlan, "expected a rail service plan")
  const setCitiesResult = setBureaucracyServicePodCities(
    game,
    railPlan!.corridorId,
    [railPlan!.id],
    ["atlanta", "charlotte"],
    player.id,
  )
  assert.ok(setCitiesResult.ok, "expected to seed a two-city rail pod")
  game = setCitiesResult.game
  const assignTrainResult = setBureaucracyRouteVehicleCard(game, railPlan!.id, trainCard!.id, player.id)
  assert.ok(assignTrainResult.ok, "expected to assign the train to the seeded rail pod")
  game = assignTrainResult.game

  return game
}

function makeDisconnectedRailNoTrainGame() {
  const game = createGameState(usMap, {
    players: [
      { id: "p1", name: "Bot A", color: "#4a7c59", isBot: true, botPreset: "bot-avg" },
    ],
  })
  const player = game.players[0]
  player.phase = "operations"
  player.money = 200_000_000
  player.ownedCityCardIds = ["austin", "houston", "atlanta", "charlotte"]
  player.ownedVehicleCardIds = []
  player.ownedVehicleCountsByCardId = {}
  player.vehicleWeeksOwnedByCardId = {}
  game.currentPlayerId = player.id
  game.currentPhase = "operations"
  game.routes.push({
    id: "test-austin-houston",
    cityA: "austin",
    cityB: "houston",
    mode: "rail",
    ownerId: player.id,
  })

  return game
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
    const normalized = normalizeGameState(game)
    assert.equal(normalized.turnTimerSeconds, 90)
  })

  it("normalizing a game without turnTimerSeconds defaults to 0", () => {
    const game: ReturnType<typeof makeGame> & { turnTimerSeconds?: number } = makeGame()
    delete game.turnTimerSeconds
    const normalized = normalizeGameState(game)
    assert.equal(normalized.turnTimerSeconds, 0)
  })

  it("normalizing preserves non-null turnTimerExpiresAt", () => {
    const game: ReturnType<typeof makeGame> & { turnTimerExpiresAt?: number | null } = makeGame()
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
    const game: ReturnType<typeof makeGame> & { autoPlayUntilWeek?: number } = makeGame()
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

describe("Bot rail claim efficiency", () => {
  it("keeps Austin–San Antonio available as a legal rail follow-up in the Texas triangle", () => {
    const game = makeTexasRailBotGame()
    const legalRailClaims = getBotLegalActions(game, "p1")
      .filter(action => action.type === "claim-route" && action.mode === "rail")
      .map(action => [...action.cityIds].sort().join("|"))

    assert.ok(
      legalRailClaims.includes(["austin", "san_antonio"].sort().join("|")),
      "expected Austin–San Antonio to remain in the bot's rail claim candidates",
    )
  })

  it("prefers the shorter Austin–San Antonio rail link over a second long Houston spoke", () => {
    const game = makeTexasRailBotGame(["austin", "san_antonio", "houston"])
    const topRailClaim = getTopScoredBotCandidates(game, "p1", {}, 10)
      .find(candidate => candidate.action.type === "claim-route" && candidate.action.mode === "rail")

    assert.ok(topRailClaim, "expected a rail claim candidate")
    assert.deepEqual(
      [...topRailClaim.action.cityIds].sort(),
      ["austin", "san_antonio"],
      "expected the bot to prefer Austin–San Antonio as the next rail build",
    )
  })

  it("does not prefer buying a train before it has any practical rail path", () => {
    const game = makeNoTrackTrainPurchaseGame()
    const topBuyCandidate = getTopScoredBotCandidates(game, "p1", {}, 10)
      .find(candidate => candidate.action.type === "buy-vehicle")

    assert.ok(topBuyCandidate, "expected at least one buy candidate")
    assert.equal(topBuyCandidate.action.type, "buy-vehicle")
    const boughtCard = game.vehicleCatalog.find(card => card.id === topBuyCandidate.action.cardId)
    assert.ok(boughtCard, "expected the chosen market card to exist")
    assert.notEqual(
      boughtCard.type,
      "train",
      "expected the bot to avoid buying a train without an immediate rail use",
    )
  })

  it("includes multi-quantity bus purchases when the rules allow them", () => {
    const game = makeNoTrackTrainPurchaseGame()
    const legalBusBuys = getBotLegalActions(game, "p1")
      .filter(action => action.type === "buy-vehicle")
      .map(action => ({
        quantity: action.quantity,
        type: game.vehicleCatalog.find(card => card.id === action.cardId)?.type ?? "unknown",
      }))
      .filter(action => action.type === "bus")

    assert.ok(
      legalBusBuys.some(action => action.quantity > 1),
      "expected bus purchase options with quantity above 1 when bus rules allow multi-buy",
    )
  })

  it("includes buying more of an already owned vehicle model", () => {
    const game = makeOwnedBusRebuyGame()
    const legalBuys = getBotLegalActions(game, "p1")
      .filter(action => action.type === "buy-vehicle")

    assert.ok(
      legalBuys.some(action => action.cardId === game.players[0]!.ownedVehicleCardIds[0]),
      "expected the bot to see rebuy options for an already owned vehicle model",
    )
  })

  it("prefers expanding an underused rail pod before leaving connected rail cities disconnected", () => {
    const game = makeUnderusedRailPodGame()
    const topCandidate = getTopScoredBotCandidates(game, "p1", {}, 10)[0]

    assert.ok(topCandidate, "expected a top candidate")
    assert.equal(topCandidate.action.type, "create-service-pod")
    assert.ok(
      topCandidate.action.cityIds.includes("atlanta") &&
      topCandidate.action.cityIds.includes("charlotte") &&
      topCandidate.action.cityIds.length >= 3 &&
      topCandidate.action.cityIds.some(cityId => cityId === "nashville" || cityId === "raleigh_durham"),
      "expected the bot to expand the existing rail pod instead of leaving every extra connected rail city disconnected",
    )
  })

  it("lets training weights control the disconnected-rail penalty", () => {
    const game = makeDisconnectedRailNoTrainGame()
    const disconnectedClaimKey = ["atlanta", "charlotte"].sort().join("|")

    const penalizedClaim = getTopScoredBotCandidates(
      game,
      "p1",
      { claimDisconnectedRailPenalty: 1_000 },
      10,
    ).find(
      candidate =>
        candidate.action.type === "claim-route" &&
        candidate.action.mode === "rail" &&
        [...candidate.action.cityIds].sort().join("|") === disconnectedClaimKey,
    )
    const unpenalizedClaim = getTopScoredBotCandidates(
      game,
      "p1",
      { claimDisconnectedRailPenalty: 0 },
      10,
    ).find(
      candidate =>
        candidate.action.type === "claim-route" &&
        candidate.action.mode === "rail" &&
        [...candidate.action.cityIds].sort().join("|") === disconnectedClaimKey,
    )

    assert.ok(penalizedClaim, "expected the disconnected rail claim to remain scoreable")
    assert.ok(unpenalizedClaim, "expected the disconnected rail claim to remain scoreable")
    assert.ok(
      unpenalizedClaim.score > penalizedClaim.score,
      "expected lowering the disconnected-rail penalty weight to improve that rail claim's score",
    )
  })

  it("measures reviewed operations against the bot's original plan", () => {
    const botPlanGame = makeUnderusedRailPodGame()
    const botPlanSummary = buildPlayerBureaucracySummary(botPlanGame, "p1")
    assert.ok(botPlanSummary, "expected a bureaucracy summary for the bot plan")

    const railPlan = botPlanSummary!.routePlans.find(plan => !plan.isDisconnected && plan.route.mode === "rail")
    assert.ok(railPlan, "expected a rail plan to expand during review")

    const reviewedPod = setBureaucracyServicePodCities(
      botPlanGame,
      railPlan!.corridorId,
      [railPlan!.id],
      [railPlan!.cityIds[0]!],
      "p1",
    )
    assert.ok(reviewedPod.ok, "expected reviewed pod edit to succeed")

    const reviewedSummary = buildPlayerBureaucracySummary(reviewedPod.game, "p1")
    assert.ok(reviewedSummary, "expected a bureaucracy summary for the reviewed plan")

    const comparison = compareOperationsReviewOutcomes(
      summarizeOperationsReviewOutcome(botPlanSummary!),
      summarizeOperationsReviewOutcome(reviewedSummary!),
    )

    assert.ok(
      comparison.reviewedPlan.totalPassengersServed < comparison.botPlan.totalPassengersServed,
      "expected the edited plan to change the measured passenger outcome",
    )
    assert.equal(
      comparison.delta.totalPassengersServed,
      comparison.reviewedPlan.totalPassengersServed - comparison.botPlan.totalPassengersServed,
      "expected the comparison delta to match the passenger difference",
    )
    assert.equal(
      comparison.delta.podCount,
      comparison.reviewedPlan.podCount - comparison.botPlan.podCount,
      "expected the comparison delta to track pod-count changes too",
    )
  })

  it("collapses duplicate buy quantities down to one coaching option per vehicle model", () => {
    const collapsed = collapseVehicleQuantityCandidates([
      {
        action: { type: "buy-vehicle", cardId: "train-1", quantity: 1 },
        score: Number.NEGATIVE_INFINITY,
        label: "Buy 1x train",
        breakdown: null,
      },
      {
        action: { type: "buy-vehicle", cardId: "train-1", quantity: 2 },
        score: Number.NEGATIVE_INFINITY,
        label: "Buy 2x train",
        breakdown: null,
      },
      {
        action: { type: "buy-vehicle", cardId: "train-1", quantity: 3 },
        score: Number.NEGATIVE_INFINITY,
        label: "Buy 3x train",
        breakdown: null,
      },
      {
        action: { type: "end-turn" },
        score: 0,
        label: "End turn",
        breakdown: null,
      },
    ])

    const buyCandidates = collapsed.filter(candidate => candidate.action.type === "buy-vehicle")
    assert.equal(buyCandidates.length, 1, "expected only one buy option per vehicle model")
    assert.equal(buyCandidates[0]?.action.quantity, 1, "expected tied quantities to keep the smaller purchase")
  })

  it("limits vehicle coaching choices to the top five collapsed options", () => {
    const selected = selectVehicleCoachingCandidates([
      { action: { type: "buy-vehicle", cardId: "v1", quantity: 1 }, score: 100, label: "v1", breakdown: null },
      { action: { type: "buy-vehicle", cardId: "v2", quantity: 1 }, score: 90, label: "v2", breakdown: null },
      { action: { type: "buy-vehicle", cardId: "v3", quantity: 1 }, score: 80, label: "v3", breakdown: null },
      { action: { type: "buy-vehicle", cardId: "v4", quantity: 1 }, score: 70, label: "v4", breakdown: null },
      { action: { type: "buy-vehicle", cardId: "v5", quantity: 1 }, score: 60, label: "v5", breakdown: null },
      { action: { type: "buy-vehicle", cardId: "v6", quantity: 1 }, score: 50, label: "v6", breakdown: null },
      { action: { type: "buy-vehicle", cardId: "v2", quantity: 2 }, score: 40, label: "v2x2", breakdown: null },
    ])

    assert.equal(selected.length, 5, "expected only the top five vehicle options to remain")
    assert.deepEqual(
      selected.map(candidate => candidate.action.type === "buy-vehicle" ? candidate.action.cardId : "other"),
      ["v1", "v2", "v3", "v4", "v5"],
      "expected top-five selection after collapsing duplicate quantities",
    )
  })

  it("turns top-choice coaching ratings into trainable preferences", () => {
    const signals = extractTrainingSignals([
      {
        id: "session-1",
        decisions: [
          {
            id: "decision-1",
            botPlayerId: "p1",
            decisionType: "vehicles",
            week: 1,
            phase: "purchase-equipment",
            weightsSnapshot: {},
            candidates: [
              {
                action: { type: "buy-vehicle", cardId: "bus-a", quantity: 1 },
                score: 10,
                label: "Buy bus A",
                breakdown: {
                  kind: "buy-vehicle",
                  cardNumber: 1,
                  cardName: "Bus A",
                  vehicleType: "bus",
                  typePriority: 40,
                  totalPassengerCapacity: 40,
                  speed: 40,
                  operatingCostMultiplier: 1,
                  purchasePriceM: 5,
                  pricePenalty: 5,
                  cityBonus: 8,
                  cityBonusReason: "4 owned cities × 2",
                  duplicatePenalty: 0,
                  duplicateCount: 0,
                  firstOfTypeBonus: 0,
                },
              },
              {
                action: { type: "buy-vehicle", cardId: "train-a", quantity: 1 },
                score: 8,
                label: "Buy train A",
                breakdown: {
                  kind: "buy-vehicle",
                  cardNumber: 2,
                  cardName: "Train A",
                  vehicleType: "train",
                  typePriority: 30,
                  totalPassengerCapacity: 200,
                  speed: 90,
                  operatingCostMultiplier: 1,
                  purchasePriceM: 15,
                  pricePenalty: 15,
                  cityBonus: -20,
                  cityBonusReason: "penalty: no rail claims or existing rail network to justify a train",
                  duplicatePenalty: 0,
                  duplicateCount: 0,
                  firstOfTypeBonus: 0,
                },
              },
            ],
            botChoiceIndex: 0,
            chosenIndex: 0,
            rating: "great",
            preferredIndex: null,
          },
        ],
      },
    ])

    assert.equal(signals.topChoicePreferences, 1, "expected top-choice ratings to generate preferences")
    assert.equal(signals.preferences.length, 1, "expected one pairwise preference from the top-choice rating")
  })

  it("uses coaching signals to adjust bot weights", () => {
    const result = deriveCoachedWeights([
      {
        id: "session-1",
        decisions: [
          {
            id: "decision-1",
            botPlayerId: "p1",
            decisionType: "vehicles",
            week: 1,
            phase: "purchase-equipment",
            weightsSnapshot: {},
            candidates: [
              {
                action: { type: "buy-vehicle", cardId: "bus-a", quantity: 1 },
                score: 10,
                label: "Buy bus A",
                breakdown: {
                  kind: "buy-vehicle",
                  cardNumber: 1,
                  cardName: "Bus A",
                  vehicleType: "bus",
                  typePriority: 40,
                  totalPassengerCapacity: 40,
                  speed: 40,
                  operatingCostMultiplier: 1,
                  purchasePriceM: 5,
                  pricePenalty: 5,
                  cityBonus: 8,
                  cityBonusReason: "4 owned cities × 2",
                  duplicatePenalty: 0,
                  duplicateCount: 0,
                  firstOfTypeBonus: 0,
                },
              },
              {
                action: { type: "buy-vehicle", cardId: "train-a", quantity: 1 },
                score: 8,
                label: "Buy train A",
                breakdown: {
                  kind: "buy-vehicle",
                  cardNumber: 2,
                  cardName: "Train A",
                  vehicleType: "train",
                  typePriority: 30,
                  totalPassengerCapacity: 200,
                  speed: 90,
                  operatingCostMultiplier: 1,
                  purchasePriceM: 15,
                  pricePenalty: 15,
                  cityBonus: -20,
                  cityBonusReason: "penalty: no rail claims or existing rail network to justify a train",
                  duplicatePenalty: 0,
                  duplicateCount: 0,
                  firstOfTypeBonus: 0,
                },
              },
            ],
            botChoiceIndex: 1,
            chosenIndex: 0,
            rating: "better",
            preferredIndex: 0,
          },
        ],
      },
    ])

    assert.ok(result.changedWeights.length > 0, "expected coaching feedback to produce weight changes")
  })
})

describe("Vehicle exchange purchase limit", () => {
  it("counts exchanging a vehicle as the player's one purchase for the turn", () => {
    const game = makeGame()
    const player = game.players[0]
    player.phase = "purchase-equipment"
    player.money = 200_000_000
    game.currentPhase = "purchase-equipment"
    game.currentPlayerId = player.id

    const oldBus = game.vehicleCatalog.find(card => card.type === "bus")
    const newBus = game.vehicleCatalog.find(card => card.type === "bus" && card.id !== oldBus?.id)
    assert.ok(oldBus, "expected an owned bus candidate")
    assert.ok(newBus, "expected a replacement bus candidate")

    player.ownedVehicleCardIds = [oldBus!.id]
    player.ownedVehicleCountsByCardId = { [oldBus!.id]: 1 }
    player.vehicleWeeksOwnedByCardId = { [oldBus!.id]: 0 }
    player.inventory.vehicles.buses = 1
    game.vehicleMarketCardIds = [newBus!.id]

    const exchangeResult = exchangeVehicleCard(game, newBus!.id, oldBus!.id, player.id)
    assert.ok(exchangeResult.ok, "expected vehicle exchange to succeed")
    assert.ok(exchangeResult.game.purchasedVehiclePlayerIds.includes(player.id), "expected exchange to consume the player's purchase slot")
    assert.equal(exchangeResult.game.hasPurchasedVehicleThisPhase, true)
    assert.equal(exchangeResult.game.purchasedVehicleTypesThisPhase[newBus!.type], true)

    const legalActions = getBotLegalActions(exchangeResult.game, player.id)
    assert.deepEqual(
      legalActions.map(action => action.type),
      ["end-turn"],
      "expected the player to be limited to ending turn after an exchange",
    )
  })
})
