import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usMap } from "./data/maps/usMap"
import { loadUserDecks } from "./data/deckData"
import {
  type AlternativeCoachingRating,
  clearCurrentCoachingSession,
  type CoachingDecision,
  type CoachingSession,
  type TopChoiceCoachingRating,
  generateDecisionId,
  generateSessionId,
  persistCoachingSession,
  saveCurrentCoachingSession,
  summarizeCoachingSession,
} from "./data/coachingStorage"
import { selectVehicleCoachingCandidates } from "./data/coachingCandidates"
import {
  compareOperationsReviewOutcomes,
  summarizeOperationsReviewOutcome,
  type OperationsReviewComparison,
  type OperationsReviewOutcome,
} from "./data/coachingReview"
import {
  createGameState,
  DEFAULT_STARTING_MONEY,
} from "./engine/createGameState"
import {
  addBureaucracyServiceSplit,
  advanceTurn,
  buyVehicleCard,
  claimRoute,
  deleteBureaucracyServicePod,
  exchangeVehicleCard,
  markOperationsReady,
  setBureaucracyRouteVehicleCard,
  setBureaucracyServicePodCities,
} from "./engine/actions"
import { buildPlayerBureaucracySummary, findPlayerBureaucracyPlan } from "./engine/bureaucracy"
import { getPendingBotPlayerId } from "./bots/actions"
import { applyBotAction, getBotLegalActions } from "./bots/actions"
import {
  fetchManagedBotPresetStore,
  getPlayerBotPreset,
  createPresetBotController,
  type BotPresetId,
  BOT_PRESET_IDS,
  getBotPresetLabel,
} from "./bots/presets"
import {
  getTopScoredBotCandidates,
  simulateOperationsPlan,
  type ScoredBotCandidate,
  type KeepCityScoreBreakdown,
  type BuyVehicleScoreBreakdown,
  type DrawCityScoreBreakdown,
} from "./bots/scriptedBot"
import type { BotAction } from "./bots/types"
import {
  appendActionLog,
  getAdvanceTurnLogMessage,
  getBotActionLogMessage,
  getPhaseDiscardLogMessage,
  getNextLocalViewingPlayerId,
} from "./game/gameHelpers"
import type { GameState } from "./engine/types"
import { normalizeGameState } from "./engine/normalizeGameState"
import Board from "./ui/Board"
import { PLAYER_SETUP_PRESETS, MAX_SETUP_PLAYERS } from "./gameSetup/defaultPlayers"

// ── Types ────────────────────────────────────────────────────────────────────

type DecisionTypeKey = "operations" | "vehicles" | "cities" | "end-turn"
type PodAlternativeMode = "add-city" | "remove-city" | "delete-pod"

const DECISION_TYPE_LABELS: Record<DecisionTypeKey, string> = {
  operations: "Operations (route claims, service pods)",
  vehicles: "Vehicles (buy vehicle)",
  cities: "City cards (draw & keep)",
  "end-turn": "End turn / pass",
}

function getDecisionType(actionType: string): DecisionTypeKey {
  switch (actionType) {
    case "claim-route":
    case "create-service-pod":
    case "remove-pod-city":
    case "delete-service-pod":
    case "assign-pod-vehicle":
    case "add-second-vehicle-to-pod":
    case "ready-operations":
      return "operations"
    case "buy-vehicle":
    case "exchange-vehicle":
      return "vehicles"
    case "draw-city-offer":
    case "keep-city-offer":
    case "confirm-add-city-picks":
      return "cities"
    default:
      return "end-turn"
  }
}

function getCandidateActionKey(candidate: ScoredBotCandidate) {
  return JSON.stringify(candidate.action)
}

function getPodActionTargetRouteId(action: BotAction): string | null {
  switch (action.type) {
    case "create-service-pod":
      return action.routeId
    case "remove-pod-city":
      return action.sourceRouteId
    case "delete-service-pod":
      return action.routeId
    default:
      return null
  }
}

function getPodActionCorridorId(action: BotAction): string | null {
  switch (action.type) {
    case "create-service-pod":
    case "remove-pod-city":
    case "delete-service-pod":
      return action.corridorId
    default:
      return null
  }
}

function getPodActionFinalCityIds(
  action: BotAction,
  selectedCityIdsByRouteId: Record<string, string[]>,
): string[] | null {
  switch (action.type) {
    case "create-service-pod":
      return action.cityIds
    case "remove-pod-city":
      return (selectedCityIdsByRouteId[action.sourceRouteId] ?? []).filter(cityId => cityId !== action.cityId)
    case "delete-service-pod":
      return []
    default:
      return null
  }
}

function isStrictSuperset(candidateCityIds: string[], baseCityIds: string[]) {
  return candidateCityIds.length > baseCityIds.length && baseCityIds.every(cityId => candidateCityIds.includes(cityId))
}

function isStrictSubset(candidateCityIds: string[], baseCityIds: string[]) {
  return candidateCityIds.length < baseCityIds.length && candidateCityIds.every(cityId => baseCityIds.includes(cityId))
}

function getPodVehicleTypeLabel(mode: "rail" | "air" | "bus") {
  return mode === "rail" ? "train" : mode
}

function isPodBatchAction(action: BotAction) {
  return action.type === "create-service-pod" ||
    action.type === "remove-pod-city" ||
    action.type === "assign-pod-vehicle" ||
    action.type === "add-second-vehicle-to-pod"
}

type PendingPodProposal = {
  vehicleTypeLabel: string
  proposedCityIds: string[]
  cityIdsByCandidateIndex: Record<number, string[]>
  addOptionIndexes: number[]
  removeOptionIndexes: number[]
  deleteOptionIndex: number | null
}

type PendingPodReview = {
  botPlayerId: string
  botPlayerName: string
  corridorId: string
  routeId: string
}

function buildPodProposalDecision(
  game: GameState,
  playerId: string,
  chosenAction: BotAction,
  allCandidates: ScoredBotCandidate[],
): { candidates: ScoredBotCandidate[]; podProposal: PendingPodProposal } | null {
  const routeId = getPodActionTargetRouteId(chosenAction)
  const corridorId = getPodActionCorridorId(chosenAction)
  if (!routeId || !corridorId) {
    return null
  }

  const summary = buildPlayerBureaucracySummary(game, playerId)
  const routePlans = summary?.routePlans ?? []
  const corridorPlans = routePlans.filter(plan => plan.corridorId === corridorId)
  const selectedCityIdsByRouteId = Object.fromEntries(
    routePlans.map(plan => [plan.id, plan.selectedCityIds]),
  )
  const routePlan = routePlans.find(plan => plan.id === routeId) ?? null
  const representativePlan = routePlan ?? corridorPlans[0] ?? null
  if (!representativePlan) {
    return null
  }

  const proposedCityIds = getPodActionFinalCityIds(chosenAction, selectedCityIdsByRouteId)
  if (!proposedCityIds) {
    return null
  }

  const relatedCandidates = allCandidates.filter(candidate => {
    if (candidate.action.type !== "create-service-pod" && candidate.action.type !== "remove-pod-city") {
      return false
    }
    return (
      getPodActionCorridorId(candidate.action) === corridorId &&
      getPodActionTargetRouteId(candidate.action) === routeId
    )
  })

  const orderedCandidates: ScoredBotCandidate[] = []
  const seenCityKeys = new Set<string>()
  const chosenKey = JSON.stringify(chosenAction)

  const pushCandidate = (candidate: ScoredBotCandidate | null) => {
    if (!candidate) return
    const cityIds = getPodActionFinalCityIds(candidate.action, selectedCityIdsByRouteId)
    if (!cityIds) return
    const cityKey = cityIds.join("|")
    if (seenCityKeys.has(cityKey)) return
    orderedCandidates.push(candidate)
    seenCityKeys.add(cityKey)
  }

  pushCandidate(
    relatedCandidates.find(candidate => JSON.stringify(candidate.action) === chosenKey) ??
      allCandidates.find(candidate => JSON.stringify(candidate.action) === chosenKey) ??
      {
        action: chosenAction,
        label: `Proposed pod: ${proposedCityIds.join(" – ")}`,
        score: relatedCandidates[0]?.score ?? 0,
        breakdown: null,
      },
  )

  relatedCandidates
    .filter(candidate => JSON.stringify(candidate.action) !== chosenKey)
    .sort((a, b) => b.score - a.score)
    .forEach(pushCandidate)

  if (routePlan) {
    const deleteCandidate: ScoredBotCandidate = {
      action: { type: "delete-service-pod", corridorId, routeId },
      label: "Delete pod",
      score: (orderedCandidates[0]?.score ?? 0) - 25,
      breakdown: null,
    }
    pushCandidate(deleteCandidate)
  }

  const cityIdsByCandidateIndex: Record<number, string[]> = {}
  const addOptionIndexes: number[] = []
  const removeOptionIndexes: number[] = []
  let deleteOptionIndex: number | null = null

  orderedCandidates.forEach((candidate, index) => {
    const cityIds = getPodActionFinalCityIds(candidate.action, selectedCityIdsByRouteId) ?? []
    cityIdsByCandidateIndex[index] = cityIds
    if (candidate.action.type === "delete-service-pod") {
      deleteOptionIndex = index
      return
    }
    if (isStrictSuperset(cityIds, proposedCityIds)) {
      addOptionIndexes.push(index)
    } else if (isStrictSubset(cityIds, proposedCityIds)) {
      removeOptionIndexes.push(index)
    }
  })

  return {
    candidates: orderedCandidates,
    podProposal: {
      vehicleTypeLabel: getPodVehicleTypeLabel(representativePlan.route.mode),
      proposedCityIds,
      cityIdsByCandidateIndex,
      addOptionIndexes,
      removeOptionIndexes,
      deleteOptionIndex,
    },
  }
}

function buildPendingPodReviewDecision(
  game: GameState,
  review: PendingPodReview,
  weights: Partial<Record<string, number>>,
): PendingDecision | null {
  const summary = buildPlayerBureaucracySummary(game, review.botPlayerId)
  const plan = summary?.routePlans.find(
    candidate =>
      candidate.id === review.routeId &&
      candidate.corridorId === review.corridorId &&
      !candidate.isDisconnected &&
      candidate.selectedCityIds.length >= 2,
  ) ?? null
  if (!plan) {
    return null
  }

  const legalActions = getBotLegalActions(game, review.botPlayerId)
  const allCandidates = getTopScoredBotCandidates(game, review.botPlayerId, weights, Math.max(legalActions.length, 1))
  const podProposalDecision = buildPodProposalDecision(
    game,
    review.botPlayerId,
    {
      type: "create-service-pod",
      corridorId: plan.corridorId,
      routeId: plan.id,
      cityIds: plan.selectedCityIds,
    },
    allCandidates,
  )
  if (!podProposalDecision) {
    return null
  }

  return {
    botPlayerId: review.botPlayerId,
    botPlayerName: review.botPlayerName,
    decisionType: "operations",
    candidates: podProposalDecision.candidates,
    chosenIndex: 0,
    nextPlannedLabel: null,
    operationsPlan: null,
    podProposal: podProposalDecision.podProposal,
    operationsReview: false,
    vehicleReview: false,
    operationsReviewBaseline: null,
    operationsReviewEdits: [],
  }
}

function selectCoachingCandidates(
  allCandidates: ScoredBotCandidate[],
  decisionType: DecisionTypeKey,
): ScoredBotCandidate[] {
  if (decisionType === "vehicles") {
    return selectVehicleCoachingCandidates(
      allCandidates.filter(candidate => {
        const candidateType = getDecisionType(candidate.action.type)
        return candidateType === "vehicles" || candidate.action.type === "end-turn"
      }),
    )
  }

  if (decisionType === "operations") {
    const operationsCandidates = allCandidates.filter(
      candidate => getDecisionType(candidate.action.type) === "operations",
    )
    const topScore = operationsCandidates[0]?.score ?? 0
    const shortlisted = operationsCandidates.filter((candidate, index) =>
      index === 0 ||
      (isFinite(candidate.score) &&
        candidate.score > Number.NEGATIVE_INFINITY &&
        candidate.score > topScore - 200),
    )
    const representatives = [
      operationsCandidates.find(
        candidate => candidate.action.type === "claim-route" && candidate.action.mode === "rail",
      ),
      operationsCandidates.find(
        candidate => candidate.action.type === "claim-route" && candidate.action.mode === "air",
      ),
      operationsCandidates.find(candidate => candidate.action.type === "create-service-pod"),
      operationsCandidates.find(candidate => candidate.action.type === "assign-pod-vehicle"),
      operationsCandidates.find(candidate => candidate.action.type === "add-second-vehicle-to-pod"),
      operationsCandidates.find(candidate => candidate.action.type === "remove-pod-city"),
      operationsCandidates.find(candidate => candidate.action.type === "ready-operations"),
    ].filter((candidate): candidate is ScoredBotCandidate => candidate !== undefined)

    const deduped = new Map<string, ScoredBotCandidate>()
    for (const candidate of [...shortlisted, ...representatives]) {
      deduped.set(getCandidateActionKey(candidate), candidate)
    }

    return [...deduped.values()].sort((a, b) => b.score - a.score)
  }

  const topScore = allCandidates[0]?.score ?? 0
  return allCandidates.filter((candidate, index) =>
    index === 0 ||
    (isFinite(candidate.score) &&
      candidate.score > Number.NEGATIVE_INFINITY &&
      candidate.score > topScore - 200),
  )
}

function reorderCandidatesToChosenAction(
  candidates: ScoredBotCandidate[],
  allCandidates: ScoredBotCandidate[],
  chosenAction: ScoredBotCandidate["action"],
): ScoredBotCandidate[] {
  const chosenKey = JSON.stringify(chosenAction)
  const chosenCandidate =
    candidates.find(candidate => getCandidateActionKey(candidate) === chosenKey) ??
    allCandidates.find(candidate => getCandidateActionKey(candidate) === chosenKey) ??
    null

  if (!chosenCandidate) {
    return candidates
  }

  const reorderedCandidates = [
    chosenCandidate,
    ...candidates.filter(candidate => {
      if (getCandidateActionKey(candidate) === chosenKey) {
        return false
      }

      if (
        chosenCandidate.action.type === "buy-vehicle" &&
        candidate.action.type === "buy-vehicle" &&
        candidate.action.cardId === chosenCandidate.action.cardId
      ) {
        return false
      }

      return true
    }),
  ]

  return reorderedCandidates
}

function normalizeVehicleDecisionCandidates(decision: PendingDecision): PendingDecision {
  if (decision.decisionType !== "vehicles" || decision.vehicleReview || decision.podProposal) {
    return decision
  }

  const trimmedCandidates = selectVehicleCoachingCandidates(decision.candidates)
  if (
    trimmedCandidates.length === decision.candidates.length &&
    trimmedCandidates.every((candidate, index) => getCandidateActionKey(candidate) === getCandidateActionKey(decision.candidates[index]!))
  ) {
    return decision
  }

  return {
    ...decision,
    candidates: trimmedCandidates,
    chosenIndex: 0,
  }
}

type BotSlotConfig = {
  name: string
  presetId: BotPresetId
  paused: boolean
}

type CoachSettings = {
  bots: BotSlotConfig[]
  pausedDecisionTypes: Set<DecisionTypeKey>
}

type PendingDecision = {
  botPlayerId: string
  botPlayerName: string
  decisionType: DecisionTypeKey
  candidates: ScoredBotCandidate[]
  chosenIndex: number
  nextPlannedLabel: string | null
  operationsPlan: import("./bots/scriptedBot").OperationsPlan | null
  podProposal: PendingPodProposal | null
  operationsReview: boolean
  vehicleReview: boolean
  operationsReviewBaseline: OperationsReviewOutcome | null
  operationsReviewEdits: string[]
}

type AppPhase = "setup" | "playing" | "done"

type PersistedCoachAppState = {
  version: 1
  appPhase: AppPhase
  settings: {
    bots: BotSlotConfig[]
    pausedDecisionTypes: DecisionTypeKey[]
  }
  game: GameState | null
  viewingPlayerId: string | null
  pendingDecision: PendingDecision | null
  podReviewQueue: PendingPodReview[]
  session: CoachingSession | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const COACH_APP_STORAGE_KEY = "coaching-app-state-v1"

function createDefaultCoachSettings(): CoachSettings {
  return {
    bots: [
      { name: "Stickbug 1", presetId: "bot-best-3p", paused: true },
      { name: "Stickbug 2", presetId: "bot-best-3p", paused: true },
      { name: "Stickbug 3", presetId: "bot-best-3p", paused: true },
    ],
    pausedDecisionTypes: new Set<DecisionTypeKey>(["operations", "vehicles", "cities"]),
  }
}

function isBotPresetId(value: unknown): value is BotPresetId {
  return typeof value === "string" && BOT_PRESET_IDS.includes(value as BotPresetId)
}

function loadPersistedCoachAppState(): PersistedCoachAppState | null {
  try {
    const raw = sessionStorage.getItem(COACH_APP_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedCoachAppState>
    if (parsed.version !== 1) return null

    const defaultSettings = createDefaultCoachSettings()
    const bots = Array.isArray(parsed.settings?.bots) && parsed.settings.bots.length > 0
      ? parsed.settings.bots.slice(0, MAX_SETUP_PLAYERS).map((bot, index) => ({
          name:
            typeof bot?.name === "string" && bot.name.trim().length > 0
              ? bot.name
              : defaultSettings.bots[index]?.name ?? `Stickbug ${index + 1}`,
          presetId: isBotPresetId(bot?.presetId)
            ? bot.presetId
            : (defaultSettings.bots[index]?.presetId ?? "bot-best-3p"),
          paused: typeof bot?.paused === "boolean" ? bot.paused : true,
        }))
      : defaultSettings.bots
    const pausedDecisionTypes = new Set<DecisionTypeKey>(
      Array.isArray(parsed.settings?.pausedDecisionTypes)
        ? parsed.settings.pausedDecisionTypes.filter((key): key is DecisionTypeKey =>
            key === "operations" || key === "vehicles" || key === "cities" || key === "end-turn",
          )
        : [...defaultSettings.pausedDecisionTypes],
    )
    const normalizedGame = parsed.game ? normalizeGameState(parsed.game as GameState) : null
    const appPhase =
      parsed.appPhase === "playing" || parsed.appPhase === "done" || parsed.appPhase === "setup"
        ? parsed.appPhase
        : "setup"

    return {
      version: 1,
      appPhase:
        (appPhase === "playing" || appPhase === "done") && normalizedGame
          ? appPhase
          : "setup",
      settings: {
        bots,
        pausedDecisionTypes: pausedDecisionTypes.size > 0 ? [...pausedDecisionTypes] : [...defaultSettings.pausedDecisionTypes],
      },
      game: normalizedGame,
      viewingPlayerId: typeof parsed.viewingPlayerId === "string" ? parsed.viewingPlayerId : null,
      pendingDecision: parsed.pendingDecision
        ? normalizeVehicleDecisionCandidates({
            ...parsed.pendingDecision,
            operationsPlan: parsed.pendingDecision.operationsPlan ?? null,
            podProposal: parsed.pendingDecision.podProposal ?? null,
            operationsReview: parsed.pendingDecision.operationsReview ?? false,
            vehicleReview: parsed.pendingDecision.vehicleReview ?? false,
            operationsReviewBaseline: parsed.pendingDecision.operationsReviewBaseline ?? null,
            operationsReviewEdits: Array.isArray(parsed.pendingDecision.operationsReviewEdits)
              ? parsed.pendingDecision.operationsReviewEdits
              : [],
          } as PendingDecision)
        : null,
      podReviewQueue: Array.isArray(parsed.podReviewQueue) ? parsed.podReviewQueue : [],
      session: parsed.session ?? null,
    }
  } catch {
    return null
  }
}

function savePersistedCoachAppState(state: PersistedCoachAppState) {
  try {
    sessionStorage.setItem(COACH_APP_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // non-fatal
  }
}

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 18,
  border: "1px solid #d8dfd5",
  background: "#ffffff",
  padding: 24,
  boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
}

const BUTTON_PRIMARY: React.CSSProperties = {
  padding: "10px 20px",
  borderRadius: 999,
  border: "1px solid #223024",
  background: "#223024",
  color: "#ffffff",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 14,
}

const BUTTON_SECONDARY: React.CSSProperties = {
  padding: "10px 20px",
  borderRadius: 999,
  border: "1px solid #c7d0c4",
  background: "#ffffff",
  color: "#223024",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 14,
}

function formatScoreValue(value: number | null | undefined) {
  return typeof value === "number" ? value.toFixed(1) : "—"
}

function scorePts(n: number | null | undefined) {
  return typeof n === "number" ? `${n.toFixed(1)} pts` : "—"
}

function formatSignedCount(value: number) {
  const rounded = Math.round(value)
  return `${rounded >= 0 ? "+" : ""}${rounded.toLocaleString()}`
}

function formatMoneyMillions(value: number) {
  return `$${(value / 1_000_000).toFixed(1)}M`
}

function formatSignedMoneyMillions(value: number) {
  return `${value >= 0 ? "+" : "-"}$${(Math.abs(value) / 1_000_000).toFixed(1)}M`
}

function KeepCityBreakdownRow({ breakdown }: { breakdown: KeepCityScoreBreakdown }) {
  const popM = (breakdown.totalPopulation / 1_000_000).toFixed(2)
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 12, color: "#56635a", marginTop: 2 }}>
      <span title="Sum of both cities' populations × weight. Larger cities score higher.">
        Population: <strong>{popM}M</strong>
        <span style={{ color: "#8a9c8c" }}> × {breakdown.populationWeight} = {scorePts(breakdown.populationScore)}</span>
      </span>
      {breakdown.avgDistanceMiles !== null ? (
        <span title="Avg nearest distance from chosen cities to your existing network. Closer = more points (max bonus at 0 mi, zero at 2000+ mi).">
          Network: <strong>{breakdown.avgDistanceMiles.toLocaleString()} mi away</strong>
          <span style={{ color: "#8a9c8c" }}> × {breakdown.networkProximityWeight} = {scorePts(breakdown.networkProximityScore)}</span>
        </span>
      ) : (
        <span style={{ color: "#b0b8b2" }}>Network proximity: no owned cities yet</span>
      )}
      {breakdown.topRegion ? (
        <span title={`Cities in your top region (${breakdown.topRegion}) each add ${breakdown.regionMatchWeight} pts`}>
          Region ({breakdown.topRegion}): <strong>{breakdown.regionMatchCount} of 2 match</strong>
          <span style={{ color: "#8a9c8c" }}> × {breakdown.regionMatchWeight} = {scorePts(breakdown.regionMatchScore)}</span>
        </span>
      ) : (
        <span style={{ color: "#b0b8b2" }}>Region match: no concentration yet</span>
      )}
      <span title="Unclaimed adjacent routes = future connection potential. Opponent-claimed routes = blocked access (penalized ×2).">
        Adjacency: <strong style={{ color: breakdown.adjacencyPotential < 0 ? "#9b1c1c" : undefined }}>
          {breakdown.adjacencyPotential > 0 ? `+${breakdown.adjacencyPotential}` : breakdown.adjacencyPotential} open
        </strong>
        <span style={{ color: breakdown.adjacencyPotentialScore < 0 ? "#9b1c1c" : "#8a9c8c" }}> = {scorePts(breakdown.adjacencyPotentialScore)}</span>
      </span>
    </div>
  )
}

function DrawCityBreakdownRow({ breakdown }: { breakdown: DrawCityScoreBreakdown }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 12, color: "#56635a", marginTop: 2 }}>
      <span title="More cards remaining = more choices, scored higher">
        Deck size: <strong>{breakdown.deckSize} cards</strong>
        <span style={{ color: "#8a9c8c" }}> = {scorePts(breakdown.deckSizeScore)}</span>
      </span>
      <span title="Cities you already own in this region — drawing here extends your existing network">
        Your cities here: <strong>{breakdown.ownedInRegion}</strong>
        <span style={{ color: "#8a9c8c" }}> = {scorePts(breakdown.ownedInRegionScore)}</span>
      </span>
      {breakdown.opponentCitiesInRegion > 0 && (
        <span title="Opponents already own cities in this region — their network has a head start">
          Opponent cities: <strong style={{ color: "#9b1c1c" }}>{breakdown.opponentCitiesInRegion}</strong>
          <span style={{ color: "#9b1c1c" }}> = −{scorePts(breakdown.opponentPenalty)}</span>
        </span>
      )}
      {breakdown.bigCityScarcityScore > 0 && (
        <span title={`Deck is small (≤6 cards) but avg city pop is ${breakdown.bigCityScarcitySignal.toFixed(2)}M — high-value targets remain`}>
          Big city scarcity: <strong>{breakdown.bigCityScarcitySignal.toFixed(2)}M avg pop</strong>
          <span style={{ color: "#8a9c8c" }}> = {scorePts(breakdown.bigCityScarcityScore)}</span>
        </span>
      )}
    </div>
  )
}

function BuyVehicleBreakdownRow({ breakdown }: { breakdown: BuyVehicleScoreBreakdown }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 12, color: "#56635a", marginTop: 2 }}>
      <span style={{ color: "#8a9c8c" }}>
        Cap: <strong style={{ color: "#223024" }}>{breakdown.totalPassengerCapacity} pax</strong>
      </span>
      <span style={{ color: "#8a9c8c" }}>
        Speed: <strong style={{ color: "#223024" }}>{breakdown.speed}</strong>
      </span>
      <span style={{ color: "#8a9c8c" }}>
        Op cost: <strong style={{ color: "#223024" }}>{breakdown.operatingCostMultiplier}×</strong>
      </span>
      <span title={`All ${breakdown.vehicleType} vehicles share the same type priority`}>
        Type priority: <strong>{scorePts(breakdown.typePriority)}</strong>
      </span>
      {breakdown.cityBonus !== 0 && (
        <span title={breakdown.cityBonusReason}>
          Context bonus: <strong style={{ color: breakdown.cityBonus >= 0 ? "#1a6b28" : "#9b1c1c" }}>{scorePts(breakdown.cityBonus)}</strong>
          <span style={{ color: "#8a9c8c" }}> ({breakdown.cityBonusReason})</span>
        </span>
      )}
      {breakdown.firstOfTypeBonus > 0 && (
        <span>First {breakdown.vehicleType} bonus: <strong style={{ color: "#1a6b28" }}>{scorePts(breakdown.firstOfTypeBonus)}</strong></span>
      )}
      {breakdown.duplicatePenalty > 0 && (
        <span title={`Already own ${breakdown.duplicateCount} ${breakdown.vehicleType}(s)`}>
          Duplicate penalty: <strong style={{ color: "#9b1c1c" }}>−{scorePts(breakdown.duplicatePenalty)}</strong>
        </span>
      )}
      <span title="Price subtracted directly from score">
        Price: <strong style={{ color: "#9b1c1c" }}>−{breakdown.purchasePriceM.toFixed(2)}M</strong>
      </span>
    </div>
  )
}



export default function CoachApp() {
  const restoredStateRef = useRef<PersistedCoachAppState | null>(loadPersistedCoachAppState())
  const restoredState = restoredStateRef.current
  const defaultSettings = useMemo(() => createDefaultCoachSettings(), [])
  const [appPhase, setAppPhase] = useState<AppPhase>(() => restoredState?.appPhase ?? "setup")
  const [settings, setSettings] = useState<CoachSettings>(() => ({
    bots: restoredState?.settings.bots ?? defaultSettings.bots,
    pausedDecisionTypes: new Set<DecisionTypeKey>(
      restoredState?.settings.pausedDecisionTypes ?? [...defaultSettings.pausedDecisionTypes],
    ),
  }))
  const [game, setGame] = useState<GameState | null>(() => restoredState?.game ?? null)
  const [viewingPlayerId, setViewingPlayerId] = useState<string | null>(() => restoredState?.viewingPlayerId ?? null)
  const [isPeriodSummaryVisible, setIsPeriodSummaryVisible] = useState(false)
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(() => restoredState?.pendingDecision ?? null)
  const [activePodAlternativeMode, setActivePodAlternativeMode] = useState<PodAlternativeMode | null>(null)
  const [podReviewQueue, setPodReviewQueue] = useState<PendingPodReview[]>(() => restoredState?.podReviewQueue ?? [])
  const [session, setSession] = useState<CoachingSession | null>(() => restoredState?.session ?? null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  const gameRef = useRef<GameState | null>(null)
  const pendingDecisionRef = useRef<PendingDecision | null>(null)
  const botTurnSignatureRef = useRef<string | null>(null)

  useEffect(() => { gameRef.current = game }, [game])
  useEffect(() => { pendingDecisionRef.current = pendingDecision }, [pendingDecision])
  useEffect(() => { setActivePodAlternativeMode(null) }, [pendingDecision])
  useEffect(() => {
    if (session) {
      saveCurrentCoachingSession(session)
    }
  }, [session])
  useEffect(() => {
    savePersistedCoachAppState({
      version: 1,
      appPhase,
      settings: {
        bots: settings.bots,
        pausedDecisionTypes: [...settings.pausedDecisionTypes],
      },
      game,
      viewingPlayerId,
      pendingDecision,
      podReviewQueue,
      session,
    })
  }, [appPhase, settings, game, viewingPlayerId, pendingDecision, podReviewQueue, session])

  // ── Setup helpers ──────────────────────────────────────────────────────────

  const updateBotSlot = useCallback((index: number, updates: Partial<BotSlotConfig>) => {
    setSettings(prev => ({
      ...prev,
      bots: prev.bots.map((bot, i) => i === index ? { ...bot, ...updates } : bot),
    }))
  }, [])

  const toggleDecisionType = useCallback((key: DecisionTypeKey) => {
    setSettings(prev => {
      const next = new Set(prev.pausedDecisionTypes)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return { ...prev, pausedDecisionTypes: next }
    })
  }, [])

  const startGame = useCallback(async () => {
    const decks = loadUserDecks()
    const presetStore = await fetchManagedBotPresetStore()
    const botPresetWeightsById: Record<string, Record<string, number>> = {}

    const players = settings.bots.slice(0, Math.min(settings.bots.length, MAX_SETUP_PLAYERS)).map((bot, index) => {
      const preset = PLAYER_SETUP_PRESETS[index]!
      const presetId = bot.presetId

      if (presetStore) {
        const overrides = presetStore[presetId as keyof typeof presetStore]
        if (overrides && typeof overrides === "object") {
          botPresetWeightsById[presetId] = overrides as Record<string, number>
        }
      }

      return {
        ...preset,
        name: bot.name,
        isBot: true,
        botPreset: presetId,
      }
    })

    const initialGame = createGameState(usMap, {
      players,
      vehicleCards: decks.vehicleCards,
      chanceCards: decks.chanceCards,
      startingMoney: DEFAULT_STARTING_MONEY,
      botPresetWeightsById,
    })

    const newSession: CoachingSession = {
      id: generateSessionId(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      playerCount: players.length,
      decisions: [],
    }

    setGame(initialGame)
    setViewingPlayerId(initialGame.players[0]?.id ?? null)
    setPodReviewQueue([])
    setSession(newSession)
    saveCurrentCoachingSession(newSession)
    botTurnSignatureRef.current = null
    setAppPhase("playing")
  }, [settings])

  // ── Bot turn loop ──────────────────────────────────────────────────────────

  const botPlayerIds = useMemo(
    () => new Set(game?.players.map(p => p.id) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [game?.players],
  )
  const boardGame = useMemo(() => {
    if (!game || !pendingDecision || game.currentPlayerId === pendingDecision.botPlayerId) {
      return game
    }

    return {
      ...game,
      currentPlayerId: pendingDecision.botPlayerId,
    }
  }, [game, pendingDecision])
  const cityNameById = useMemo(
    () => new Map((game?.cities ?? []).map(city => [city.id, city.name])),
    [game?.cities],
  )

  useEffect(() => {
    if (appPhase !== "playing" || !game || game.isGameOver || pendingDecision) {
      botTurnSignatureRef.current = null
      return
    }

    const pendingBotId = getPendingBotPlayerId(game, botPlayerIds)

    if (!pendingBotId) {
      if (game.isGameOver) {
        setAppPhase("done")
      }
      return
    }

    const turnSignature = JSON.stringify({
      week: game.currentWeek,
      phase: game.currentPhase,
      currentPlayerId: game.currentPlayerId,
      playerPhases: game.players.map(p => [p.id, p.phase]),
      bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds,
      pendingBotId,
    })

    if (botTurnSignatureRef.current === turnSignature) {
      return
    }

    botTurnSignatureRef.current = turnSignature

    const botSlotIndex = game.players.findIndex(p => p.id === pendingBotId)
    const botSlot = settings.bots[botSlotIndex] ?? null
    const shouldPause = botSlot?.paused ?? false

    const legalActions = getBotLegalActions(game, pendingBotId)
    if (legalActions.length === 0) return

    // Determine what type the top action is
    const botPlayer = game.players.find(p => p.id === pendingBotId) ?? null
    const controller = createPresetBotController(
      pendingBotId,
      getPlayerBotPreset(botPlayer),
      game.botPresetWeightsById,
    )
    const chosenAction = controller.pickAction({
      game,
      playerId: pendingBotId,
      legalActions,
      phase: game.currentPhase,
    })
    const weights = game.botPresetWeightsById?.[botSlot?.presetId ?? ""] ?? {}
    const allCandidates = getTopScoredBotCandidates(game, pendingBotId, weights, legalActions.length)
    const decisionType = getDecisionType(chosenAction.type)
    const podProposalDecision =
      chosenAction.type === "create-service-pod" || chosenAction.type === "remove-pod-city"
        ? buildPodProposalDecision(game, pendingBotId, chosenAction, allCandidates)
        : null
    const candidates = podProposalDecision
      ? podProposalDecision.candidates
      : reorderCandidatesToChosenAction(
          selectCoachingCandidates(allCandidates, decisionType),
          allCandidates,
          chosenAction,
        )

    const isPausedType = settings.pausedDecisionTypes.has(decisionType)

    // While the period summary is open, only allow ready-bureaucracy through.
    // All other actions wait until the user closes the summary.
    if (isPeriodSummaryVisible && chosenAction.type !== "ready-bureaucracy") {
      botTurnSignatureRef.current = null
      return
    }

    if (shouldPause && isPausedType && decisionType === "operations" && !isPeriodSummaryVisible) {
      let workingGame = game

      for (let step = 0; step < 40; step++) {
        const loopLegalActions = getBotLegalActions(workingGame, pendingBotId)
        if (loopLegalActions.length === 0) {
          break
        }
        const loopController = createPresetBotController(
          pendingBotId,
          getPlayerBotPreset(workingGame.players.find(p => p.id === pendingBotId) ?? null),
          workingGame.botPresetWeightsById,
        )
        const loopAction = loopController.pickAction({
          game: workingGame,
          playerId: pendingBotId,
          legalActions: loopLegalActions,
          phase: workingGame.currentPhase,
        })
        if (loopAction.type === "ready-operations" || loopAction.type === "end-turn") {
          break
        }

        const advancedGame = applyBotAction(workingGame, pendingBotId, loopAction)
        const actionMessage = getBotActionLogMessage(workingGame, advancedGame, loopAction)
        workingGame = appendActionLog(workingGame, advancedGame, actionMessage, pendingBotId)
      }

      const finalSummary = buildPlayerBureaucracySummary(workingGame, pendingBotId)

      botTurnSignatureRef.current = null
      setPodReviewQueue([])
      setGame(workingGame)
      setViewingPlayerId(prev => getNextLocalViewingPlayerId(workingGame, prev) ?? workingGame.players[0]?.id ?? prev)
      setPendingDecision({
        botPlayerId: pendingBotId,
        botPlayerName: botPlayer?.name ?? pendingBotId,
        decisionType: "operations",
        candidates: [],
        chosenIndex: 0,
        nextPlannedLabel: null,
        operationsPlan: null,
        podProposal: null,
        operationsReview: true,
        vehicleReview: false,
        operationsReviewBaseline: finalSummary ? summarizeOperationsReviewOutcome(finalSummary) : null,
        operationsReviewEdits: [],
      })
      return
    }

    if (shouldPause && isPausedType && isPodBatchAction(chosenAction) && !isPeriodSummaryVisible) {
      let workingGame = game
      const touchedCorridorIds = new Set<string>()

      for (let step = 0; step < 20; step++) {
        const loopLegalActions = getBotLegalActions(workingGame, pendingBotId)
        if (loopLegalActions.length === 0) {
          break
        }
        const loopController = createPresetBotController(
          pendingBotId,
          getPlayerBotPreset(workingGame.players.find(p => p.id === pendingBotId) ?? null),
          workingGame.botPresetWeightsById,
        )
        const loopAction = loopController.pickAction({
          game: workingGame,
          playerId: pendingBotId,
          legalActions: loopLegalActions,
          phase: workingGame.currentPhase,
        })
        if (!isPodBatchAction(loopAction)) {
          break
        }

        const actionCorridorId =
          getPodActionCorridorId(loopAction) ??
          (loopAction.type === "assign-pod-vehicle"
            ? buildPlayerBureaucracySummary(workingGame, pendingBotId)?.routePlans.find(plan => plan.id === loopAction.routeId)?.corridorId
            : null)
        if (actionCorridorId) {
          touchedCorridorIds.add(actionCorridorId)
        }

        const advancedGame = applyBotAction(workingGame, pendingBotId, loopAction)
        const actionMessage = getBotActionLogMessage(workingGame, advancedGame, loopAction)
        workingGame = appendActionLog(workingGame, advancedGame, actionMessage, pendingBotId)
      }

      const finalSummary = buildPlayerBureaucracySummary(workingGame, pendingBotId)
      const reviews: PendingPodReview[] =
        finalSummary?.routePlans
          .filter(
            plan =>
              touchedCorridorIds.has(plan.corridorId) &&
              !plan.isDisconnected &&
              plan.selectedCityIds.length >= 2,
          )
          .sort((planA, planB) => planA.corridorId.localeCompare(planB.corridorId) || planA.slotIndex - planB.slotIndex)
          .map(plan => ({
            botPlayerId: pendingBotId,
            botPlayerName: botPlayer?.name ?? pendingBotId,
            corridorId: plan.corridorId,
            routeId: plan.id,
          })) ?? []

      const [firstReview, ...remainingReviews] = reviews
      const firstDecision = firstReview ? buildPendingPodReviewDecision(workingGame, firstReview, weights) : null

      botTurnSignatureRef.current = null
      setGame(workingGame)
      setViewingPlayerId(prev => getNextLocalViewingPlayerId(workingGame, prev) ?? workingGame.players[0]?.id ?? prev)
      setPodReviewQueue(remainingReviews)
      setPendingDecision(firstDecision)
      return
    }

    // Pod proposals need explicit confirmation even if the bot only found one viable pod shape.
    const hasViableAlternatives = candidates.length > 1
    const shouldPauseForReview = hasViableAlternatives || podProposalDecision !== null
    if (shouldPause && isPausedType && shouldPauseForReview && !isPeriodSummaryVisible) {
      // For operations: compute plan asynchronously after pause is set (avoid blocking main thread)
      let operationsPlan: import("./bots/scriptedBot").OperationsPlan | null = null
      let nextPlannedLabel: string | null = null
      if (decisionType !== "operations") {
        // Peek one step ahead for non-operations decisions
        try {
          if (chosenAction) {
            const simGame = applyBotAction(game, pendingBotId, chosenAction)
            const nextPending = getPendingBotPlayerId(simGame, botPlayerIds)
            if (nextPending === pendingBotId) {
              const simWeights = simGame.botPresetWeightsById?.[botSlot?.presetId ?? ""] ?? {}
              const nextCandidates = getTopScoredBotCandidates(simGame, pendingBotId, simWeights, 1)
              nextPlannedLabel = nextCandidates[0]?.label ?? null
            }
          }
        } catch { /* ignore */ }
      }

      setPendingDecision({
        botPlayerId: pendingBotId,
        botPlayerName: botPlayer?.name ?? pendingBotId,
        decisionType,
        candidates,
        chosenIndex: 0,
        nextPlannedLabel,
        operationsPlan,
        podProposal: podProposalDecision?.podProposal ?? null,
        operationsReview: false,
        vehicleReview: false,
        operationsReviewBaseline: null,
        operationsReviewEdits: [],
      })
      return
    }

    // Auto-execute top action
    const commitId = window.setTimeout(() => {
      const currentGame = gameRef.current
      if (!currentGame || pendingDecisionRef.current) return

      const controller = createPresetBotController(
        pendingBotId,
        getPlayerBotPreset(currentGame.players.find(p => p.id === pendingBotId) ?? null),
        currentGame.botPresetWeightsById,
      )
      const action = controller.pickAction({
        game: currentGame,
        playerId: pendingBotId,
        legalActions: getBotLegalActions(currentGame, pendingBotId),
        phase: currentGame.currentPhase,
      })

      const advancedGame = applyBotAction(currentGame, pendingBotId, action)
      const discardMessage = action.type === "end-turn" ? getPhaseDiscardLogMessage(currentGame, advancedGame) : null
      const actionMessage = getBotActionLogMessage(currentGame, advancedGame, action)
      const nextGame = appendActionLog(currentGame, advancedGame, discardMessage ? `${actionMessage}; ${discardMessage}` : actionMessage, pendingBotId)

      botTurnSignatureRef.current = null
      setGame(nextGame)
      setViewingPlayerId(prev => getNextLocalViewingPlayerId(nextGame, prev) ?? nextGame.players[0]?.id ?? prev)
    }, 80)

    return () => window.clearTimeout(commitId)
  }, [appPhase, game, botPlayerIds, pendingDecision, isPeriodSummaryVisible, settings])

  // Compute operations plan asynchronously after pause is set (avoids blocking the main thread)
  useEffect(() => {
    if (!pendingDecision || pendingDecision.decisionType !== "operations" || pendingDecision.operationsPlan !== null) return
    const { botPlayerId } = pendingDecision
    const currentGame = gameRef.current
    if (!currentGame) return
    const botSlotIndex = currentGame.players.findIndex(p => p.id === botPlayerId)
    const botSlot = settings.bots[botSlotIndex] ?? null
    const weights = currentGame.botPresetWeightsById?.[botSlot?.presetId ?? ""] ?? {}
    let cancelled = false
    const id = window.setTimeout(() => {
      if (cancelled) return
      try {
        const plan = simulateOperationsPlan(currentGame, botPlayerId, weights)
        setPendingDecision(prev => prev ? { ...prev, operationsPlan: plan } : null)
      } catch { /* ignore */ }
    }, 0)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [pendingDecision, settings])

  const operationsReviewComparison = useMemo<OperationsReviewComparison | null>(() => {
    if (!game || !pendingDecision?.operationsReview || !pendingDecision.operationsReviewBaseline) {
      return null
    }

    const summary = buildPlayerBureaucracySummary(game, pendingDecision.botPlayerId)
    if (!summary) {
      return null
    }

    return compareOperationsReviewOutcomes(
      pendingDecision.operationsReviewBaseline,
      summarizeOperationsReviewOutcome(summary),
    )
  }, [game, pendingDecision])

  useEffect(() => {
    if (!pendingDecision) {
      return
    }

    const normalizedDecision = normalizeVehicleDecisionCandidates(pendingDecision)
    if (normalizedDecision !== pendingDecision) {
      setPendingDecision(normalizedDecision)
    }
  }, [pendingDecision])

  // Check for game over after each game update
  useEffect(() => {
    if (game?.isGameOver && appPhase === "playing" && !pendingDecision) {
      setAppPhase("done")
    }
  }, [game?.isGameOver, appPhase, pendingDecision])

  // ── Decision rating ────────────────────────────────────────────────────────

  const executeDecision = useCallback((
    decision: PendingDecision,
    chosenCandidateIndex: number,
    rating: TopChoiceCoachingRating | AlternativeCoachingRating,
    preferredIndex: number | null,
  ) => {
    const currentGame = gameRef.current
    if (!currentGame) return

    const candidate = decision.candidates[chosenCandidateIndex]
    if (!candidate) return

    const action = candidate.action
    const advancedGame = applyBotAction(currentGame, decision.botPlayerId, action)
    const discardMessage = action.type === "end-turn" ? getPhaseDiscardLogMessage(currentGame, advancedGame) : null
    const actionMessage = getBotActionLogMessage(currentGame, advancedGame, action)
    const nextGame = appendActionLog(currentGame, advancedGame, discardMessage ? `${actionMessage}; ${discardMessage}` : actionMessage, decision.botPlayerId)

    // Save rating to session
    const botPreset = currentGame.players.find(p => p.id === decision.botPlayerId)?.botPreset
    const weights = botPreset ? (currentGame.botPresetWeightsById?.[botPreset] ?? {}) : {}

    const coachDecision: CoachingDecision = {
      id: generateDecisionId(),
      sessionId: session?.id ?? "",
      timestamp: new Date().toISOString(),
      botPlayerId: decision.botPlayerId,
      botPlayerName: decision.botPlayerName,
      decisionType: decision.decisionType,
      week: currentGame.currentWeek,
      phase: currentGame.currentPhase,
      weightsSnapshot: weights,
      candidates: decision.candidates.map(c => ({
        action: c.action,
        score: c.score,
        label: c.label,
        breakdown: c.breakdown,
      })),
      botChoiceIndex: 0,
      chosenIndex: chosenCandidateIndex,
      rating,
      preferredIndex,
    }

    setSession(prev => {
      if (!prev) return prev
      const updated = { ...prev, decisions: [...prev.decisions, coachDecision] }
      saveCurrentCoachingSession(updated)
      return updated
    })

    let remainingPodReviews = podReviewQueue
    let nextPendingDecision: PendingDecision | null = null
    while (remainingPodReviews.length > 0 && !nextPendingDecision) {
      const [nextPodReview, ...rest] = remainingPodReviews
      remainingPodReviews = rest
      nextPendingDecision = buildPendingPodReviewDecision(
        nextGame,
        nextPodReview,
        botPreset ? (currentGame.botPresetWeightsById?.[botPreset] ?? {}) : {},
      )
    }

    botTurnSignatureRef.current = null
    setPodReviewQueue(remainingPodReviews)
    setPendingDecision(nextPendingDecision)
    setGame(nextGame)
    setViewingPlayerId(prev => getNextLocalViewingPlayerId(nextGame, prev) ?? nextGame.players[0]?.id ?? prev)
  }, [podReviewQueue, session])

  const handleRateTopChoice = useCallback((rating: TopChoiceCoachingRating) => {
    if (!pendingDecision) return
    executeDecision(pendingDecision, 0, rating, null)
  }, [pendingDecision, executeDecision])

  const handleRateAlternative = useCallback((
    preferredIndex: number,
    rating: AlternativeCoachingRating,
  ) => {
    if (!pendingDecision) return
    executeDecision(pendingDecision, preferredIndex, rating, preferredIndex)
  }, [pendingDecision, executeDecision])

  const handleSkip = useCallback(() => {
    if (!pendingDecision) return
    executeDecision(pendingDecision, 0, "fine", null)
  }, [pendingDecision, executeDecision])

  // ── Save session ───────────────────────────────────────────────────────────

  const handleSaveSession = useCallback(async () => {
    if (!session) return
    setIsSaving(true)
    try {
      const finalSession = { ...session, endedAt: new Date().toISOString() }
      await persistCoachingSession(finalSession)
      setSession(finalSession)
      setSaveMessage(`Saved: ${summarizeCoachingSession(finalSession)}`)
    } catch {
      setSaveMessage("Failed to save session.")
    } finally {
      setIsSaving(false)
    }
  }, [session])

  useEffect(() => {
    if (!session || session.decisions.length === 0) {
      return
    }

    const persistId = window.setTimeout(() => {
      void persistCoachingSession(session, { fallbackDownload: false })
    }, 800)

    return () => window.clearTimeout(persistId)
  }, [session])

  const resetToSetup = useCallback(() => {
    botTurnSignatureRef.current = null
    clearCurrentCoachingSession()
    try {
      sessionStorage.removeItem(COACH_APP_STORAGE_KEY)
    } catch {
      // non-fatal
    }
    setAppPhase("setup")
    setGame(null)
    setViewingPlayerId(null)
    setPendingDecision(null)
    setPodReviewQueue([])
    setSession(null)
    setSaveMessage(null)
    setIsPeriodSummaryVisible(false)
  }, [])

  const handleExitToSetup = useCallback(() => {
    const ratedDecisionCount = session ? session.decisions.length : 0
    const hasProgress =
      !!game ||
      !!pendingDecision ||
      !!session ||
      ratedDecisionCount > 0
    if (
      hasProgress &&
      !window.confirm("Exit this coaching session and discard the current in-progress game?")
    ) {
      return
    }
    resetToSetup()
  }, [game, pendingDecision, resetToSetup, session])

  // ── Board action handlers (view-only; no human players) ───────────────────
  // These stay read-only except during operations review, where we reuse the normal
  // pod-editing controls so coaching can tune the bot's finished layout directly.

  const noop = useCallback(() => ({ ok: false as const, error: "All players are bots." }), [])
  const noopVoid = useCallback(() => {}, [])
  const handleStartVehicleReview = useCallback(() => {
    setPendingDecision(prev => (
      prev && prev.decisionType === "vehicles"
        ? { ...prev, vehicleReview: true }
        : prev
    ))
  }, [])
  const handleCancelVehicleReview = useCallback(() => {
    setPendingDecision(prev => (
      prev && prev.decisionType === "vehicles"
        ? { ...prev, vehicleReview: false }
        : prev
    ))
  }, [])
  const appendOperationsReviewEdit = useCallback((message: string) => {
    setPendingDecision(prev =>
      prev && prev.operationsReview
        ? { ...prev, operationsReviewEdits: [...prev.operationsReviewEdits, message] }
        : prev,
    )
  }, [])
  const completeVehicleReviewDecision = useCallback((
    currentGame: GameState,
    decision: PendingDecision,
    finalGame: GameState,
    manualCandidate: ScoredBotCandidate,
  ) => {
    const botPreset = currentGame.players.find(player => player.id === decision.botPlayerId)?.botPreset
    const weights = botPreset ? (currentGame.botPresetWeightsById?.[botPreset] ?? {}) : {}
    const coachDecision: CoachingDecision = {
      id: generateDecisionId(),
      sessionId: session?.id ?? "",
      timestamp: new Date().toISOString(),
      botPlayerId: decision.botPlayerId,
      botPlayerName: decision.botPlayerName,
      decisionType: "vehicles-review",
      week: currentGame.currentWeek,
      phase: currentGame.currentPhase,
      weightsSnapshot: weights,
      candidates: [...decision.candidates, manualCandidate],
      botChoiceIndex: 0,
      chosenIndex: decision.candidates.length,
      rating: "good",
      preferredIndex: null,
      reviewEdits: [manualCandidate.label],
    }
    setSession(prev => {
      if (!prev) return prev
      const updated = { ...prev, decisions: [...prev.decisions, coachDecision] }
      saveCurrentCoachingSession(updated)
      return updated
    })
    botTurnSignatureRef.current = null
    setPendingDecision(null)
    setGame(finalGame)
    setViewingPlayerId(prev => getNextLocalViewingPlayerId(finalGame, prev) ?? finalGame.players[0]?.id ?? prev)
  }, [session])
  const handleCoachBuyVehicleCard = useCallback(async (cardId: string, quantity: number) => {
    const currentGame = gameRef.current
    const decision = pendingDecision
    if (!currentGame || !decision?.vehicleReview) {
      return { ok: false as const, error: "Manual vehicle review is not active." }
    }

    const actingPlayerId = decision.botPlayerId
    const botPreset = currentGame.players.find(player => player.id === actingPlayerId)?.botPreset
    const weights = botPreset ? (currentGame.botPresetWeightsById?.[botPreset] ?? {}) : {}
    const purchaseResult = buyVehicleCard(currentGame, cardId, quantity, actingPlayerId)
    if (!purchaseResult.ok) {
      return purchaseResult
    }

    const purchasedGame = appendActionLog(
      currentGame,
      purchaseResult.game,
      `purchased ${purchaseResult.quantity} vehicle${purchaseResult.quantity === 1 ? "" : "s"} of #${purchaseResult.card.number} ${purchaseResult.card.name}`,
      actingPlayerId,
    )
    const advancedGame = advanceTurn(purchasedGame, actingPlayerId)
    const finalGame = appendActionLog(
      purchasedGame,
      advancedGame,
      getAdvanceTurnLogMessage(purchasedGame, advancedGame),
      actingPlayerId,
    )
    const manualCandidate =
      getTopScoredBotCandidates(currentGame, actingPlayerId, weights, getBotLegalActions(currentGame, actingPlayerId).length)
        .find(candidate =>
          candidate.action.type === "buy-vehicle" &&
          candidate.action.cardId === cardId &&
          candidate.action.quantity === quantity,
        ) ?? {
          action: { type: "buy-vehicle" as const, cardId, quantity },
          score: 0,
          label: `Other: Buy ${quantity}× #${purchaseResult.card.number} ${purchaseResult.card.name}`,
          breakdown: null,
        }
    completeVehicleReviewDecision(currentGame, decision, finalGame, {
      ...manualCandidate,
      label: `Other: ${manualCandidate.label}`,
    })

    return {
      ok: true as const,
      card: purchaseResult.card,
      quantity: purchaseResult.quantity,
      cost: purchaseResult.cost,
      nextPhase: advancedGame.currentPhase,
      nextPlayerName:
        advancedGame.players.find(player => player.id === advancedGame.currentPlayerId)?.name ??
        advancedGame.currentPlayerId,
      advancedPhase: advancedGame.currentPhase !== purchasedGame.currentPhase,
    }
  }, [completeVehicleReviewDecision, pendingDecision])
  const handleCoachExchangeVehicleCard = useCallback(async (newCardId: string, oldCardId: string) => {
    const currentGame = gameRef.current
    const decision = pendingDecision
    if (!currentGame || !decision?.vehicleReview) {
      return { ok: false as const, error: "Manual vehicle review is not active." }
    }

    const actingPlayerId = decision.botPlayerId
    const botPreset = currentGame.players.find(player => player.id === actingPlayerId)?.botPreset
    const weights = botPreset ? (currentGame.botPresetWeightsById?.[botPreset] ?? {}) : {}
    const result = exchangeVehicleCard(currentGame, newCardId, oldCardId, actingPlayerId)
    if (!result.ok) {
      return result
    }

    const loggedGame = appendActionLog(
      currentGame,
      result.game,
      `exchanged #${result.oldCard.number} ${result.oldCard.name} for #${result.newCard.number} ${result.newCard.name}`,
      actingPlayerId,
    )
    const advancedGame = advanceTurn(loggedGame, actingPlayerId)
    const manualCandidate =
      getTopScoredBotCandidates(currentGame, actingPlayerId, weights, getBotLegalActions(currentGame, actingPlayerId).length)
        .find(candidate =>
          candidate.action.type === "exchange-vehicle" &&
          candidate.action.newCardId === newCardId &&
          candidate.action.oldCardId === oldCardId,
        ) ?? {
          action: { type: "exchange-vehicle" as const, newCardId, oldCardId },
          score: 0,
          label: `Replace #${result.oldCard.number} ${result.oldCard.name} with #${result.newCard.number} ${result.newCard.name}`,
          breakdown: null,
        }
    completeVehicleReviewDecision(currentGame, decision, advancedGame, {
      ...manualCandidate,
      label: `Other: ${manualCandidate.label}`,
    })

    return {
      ok: true as const,
      newCard: result.newCard,
      oldCard: result.oldCard,
      tradeInValue: result.tradeInValue,
      cost: result.cost,
    }
  }, [completeVehicleReviewDecision, pendingDecision])
  const handleCoachClaimRoute = useCallback(async (
    mode: "bus" | "rail" | "air",
    cityIds: string[],
    segmentPairs?: Array<[string, string]>,
  ) => {
    const baseGame = gameRef.current
    const actingPlayerId = pendingDecision?.operationsReview ? pendingDecision.botPlayerId : null
    if (!baseGame || !actingPlayerId) {
      return { ok: false as const, error: "Operations review is not active." }
    }
    const result = claimRoute(baseGame, { mode, cityIds, segmentPairs }, actingPlayerId)
    if (!result.ok) {
      return result
    }

    const routeLabel = result.routes
      .map(route => {
        const cityA = baseGame.cities.find(city => city.id === route.cityA)?.name ?? route.cityA
        const cityB = baseGame.cities.find(city => city.id === route.cityB)?.name ?? route.cityB
        return `${cityA} - ${cityB}`
      })
      .join(", ")
    const message = `claimed a ${mode} route across ${routeLabel}${result.connectionBonus > 0 ? ` and earned ${Math.round(result.connectionBonus).toLocaleString()}` : ""}`
    const nextGame = appendActionLog(baseGame, result.game, message, actingPlayerId)
    setGame(nextGame)
    appendOperationsReviewEdit(message)
    return {
      ok: true as const,
      game: nextGame,
      routes: result.routes,
      cost: result.cost,
      connectionBonus: result.connectionBonus,
      newCityIds: result.newCityIds,
      nextPhase: nextGame.currentPhase,
      nextPlayerName:
        nextGame.players.find(player => player.id === nextGame.currentPlayerId)?.name ??
        nextGame.currentPlayerId,
      advancedPhase: false,
    }
  }, [appendOperationsReviewEdit, pendingDecision])
  const handleCoachSetBureaucracyRouteVehicleCard = useCallback(async (routeId: string, vehicleCardId: string | null) => {
    const baseGame = gameRef.current
    const actingPlayerId = pendingDecision?.operationsReview ? pendingDecision.botPlayerId : null
    if (!baseGame || !actingPlayerId) {
      return { ok: false as const, error: "Operations review is not active." }
    }
    const result = setBureaucracyRouteVehicleCard(baseGame, routeId, vehicleCardId, actingPlayerId)
    if (!result.ok) {
      return result
    }
    const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
    const cardName =
      vehicleCardId === null
        ? "no vehicle"
        : baseGame.vehicleCatalog.find(card => card.id === vehicleCardId)?.name ?? vehicleCardId
    const nextGame = appendActionLog(baseGame, result.game, `assigned ${cardName} to ${plan?.serviceLabel ?? routeId}`, actingPlayerId)
    setGame(nextGame)
    appendOperationsReviewEdit(`assigned ${cardName} to ${plan?.serviceLabel ?? routeId}`)
    return { ...result, game: nextGame }
  }, [appendOperationsReviewEdit, pendingDecision])
  const handleCoachAddBureaucracyServiceSplit = useCallback(async (corridorId: string, initialCityIds?: string[]) => {
    const baseGame = gameRef.current
    const actingPlayerId = pendingDecision?.operationsReview ? pendingDecision.botPlayerId : null
    if (!baseGame || !actingPlayerId) {
      return { ok: false as const, error: "Operations review is not active." }
    }
    const result = addBureaucracyServiceSplit(baseGame, corridorId, actingPlayerId, initialCityIds)
    if (!result.ok) {
      return result
    }
    const nextGame = appendActionLog(baseGame, result.game, `added split service on corridor ${corridorId}`, actingPlayerId)
    setGame(nextGame)
    appendOperationsReviewEdit(`added split service on corridor ${corridorId}`)
    return { ...result, game: nextGame }
  }, [appendOperationsReviewEdit, pendingDecision])
  const handleCoachSetBureaucracyServicePodCities = useCallback(async (corridorId: string, routeIds: string[], cityIds: string[]) => {
    const baseGame = gameRef.current
    const actingPlayerId = pendingDecision?.operationsReview ? pendingDecision.botPlayerId : null
    if (!baseGame || !actingPlayerId) {
      return { ok: false as const, error: "Operations review is not active." }
    }
    const result = setBureaucracyServicePodCities(baseGame, corridorId, routeIds, cityIds, actingPlayerId)
    if (!result.ok) {
      return result
    }
    const cityLabel = cityIds
      .map(cityId => baseGame.cities.find(city => city.id === cityId)?.name ?? cityId)
      .join(", ")
    const nextGame = appendActionLog(baseGame, result.game, `set pod cities on corridor ${corridorId} to ${cityLabel || "none"}`, actingPlayerId)
    setGame(nextGame)
    appendOperationsReviewEdit(`set pod cities on corridor ${corridorId} to ${cityLabel || "none"}`)
    return { ...result, game: nextGame }
  }, [appendOperationsReviewEdit, pendingDecision])
  const handleCoachDeleteBureaucracyServicePod = useCallback(async (corridorId: string, routeId: string) => {
    const baseGame = gameRef.current
    const actingPlayerId = pendingDecision?.operationsReview ? pendingDecision.botPlayerId : null
    if (!baseGame || !actingPlayerId) {
      return { ok: false as const, error: "Operations review is not active." }
    }
    const result = deleteBureaucracyServicePod(baseGame, corridorId, routeId, actingPlayerId)
    if (!result.ok) {
      return result
    }
    const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
    const message =
      result.cityIds.length === 0
        ? "deleted an empty route"
        : result.disconnectedCityIds.length === 0
          ? `deleted ${plan?.serviceLabel ?? "a route"}`
          : `deleted ${plan?.serviceLabel ?? "a route"} and moved ${result.disconnectedCityIds.length} cities to disconnected`
    const nextGame = appendActionLog(baseGame, result.game, message, actingPlayerId)
    setGame(nextGame)
    appendOperationsReviewEdit(message)
    return { ...result, game: nextGame }
  }, [appendOperationsReviewEdit, pendingDecision])
  const handleAcceptOperationsReview = useCallback(() => {
    const currentGame = gameRef.current
    if (!currentGame || !pendingDecision?.operationsReview) {
      return
    }
    const actingPlayerId = pendingDecision.botPlayerId
    const result = markOperationsReady(currentGame, actingPlayerId)
    if (!result.ok) {
      return
    }
    const nextGame = appendActionLog(
      currentGame,
      result.game,
      result.advancedPhase ? "finished operations planning and advanced to bureaucracy" : "finished operations planning",
      actingPlayerId,
    )
    const coachDecision: CoachingDecision = {
      id: generateDecisionId(),
      sessionId: session?.id ?? "",
      timestamp: new Date().toISOString(),
      botPlayerId: pendingDecision.botPlayerId,
      botPlayerName: pendingDecision.botPlayerName,
      decisionType: "operations-review",
      week: currentGame.currentWeek,
      phase: currentGame.currentPhase,
      weightsSnapshot: {},
      candidates: [
        {
          action: { type: "ready-operations" },
          score: 0,
          label: "Accept reviewed operations layout",
          breakdown: null,
        },
      ],
      botChoiceIndex: 0,
      chosenIndex: 0,
      rating: "good",
      preferredIndex: null,
      reviewEdits: pendingDecision.operationsReviewEdits,
      operationsReviewComparison: operationsReviewComparison ?? undefined,
    }
    setSession(prev => {
      if (!prev) return prev
      const updated = { ...prev, decisions: [...prev.decisions, coachDecision] }
      saveCurrentCoachingSession(updated)
      return updated
    })
    botTurnSignatureRef.current = null
    setPendingDecision(null)
    setGame(nextGame)
    setViewingPlayerId(prev => getNextLocalViewingPlayerId(nextGame, prev) ?? nextGame.players[0]?.id ?? prev)
  }, [operationsReviewComparison, pendingDecision, session])
  const operationsInlineAction = pendingDecision?.operationsReview ? (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={handleAcceptOperationsReview}
          style={{ ...BUTTON_PRIMARY, padding: "8px 16px", fontSize: 13 }}
        >
          Accept operations
        </button>
        <button
          type="button"
          onClick={handleExitToSetup}
          style={{ ...BUTTON_SECONDARY, padding: "8px 14px", fontSize: 13 }}
        >
          Exit coaching
        </button>
        <span style={{ fontSize: 12, color: "#56635a" }}>
          Review the live pod layout here, then accept when it looks right.
        </span>
      </div>
      {operationsReviewComparison && (
        <div style={{ display: "flex", gap: "8px 16px", flexWrap: "wrap", fontSize: 12, color: "#4d5b50" }}>
          <span>
            Bot plan: <strong>{operationsReviewComparison.botPlan.totalPassengersServed.toLocaleString()} pax</strong>,{" "}
            <strong>{formatMoneyMillions(operationsReviewComparison.botPlan.netRevenue)}</strong> net,{" "}
            <strong>{operationsReviewComparison.botPlan.stuckCubeCount.toLocaleString()}</strong> stuck
          </span>
          <span>
            Your edits: <strong>{operationsReviewComparison.reviewedPlan.totalPassengersServed.toLocaleString()} pax</strong>,{" "}
            <strong>{formatMoneyMillions(operationsReviewComparison.reviewedPlan.netRevenue)}</strong> net,{" "}
            <strong>{operationsReviewComparison.reviewedPlan.stuckCubeCount.toLocaleString()}</strong> stuck
          </span>
          <span>
            Delta: <strong style={{ color: operationsReviewComparison.delta.totalPassengersServed >= 0 ? "#1a6b28" : "#9b1c1c" }}>
              {formatSignedCount(operationsReviewComparison.delta.totalPassengersServed)} pax
            </strong>,{" "}
            <strong style={{ color: operationsReviewComparison.delta.netRevenue >= 0 ? "#1a6b28" : "#9b1c1c" }}>
              {formatSignedMoneyMillions(operationsReviewComparison.delta.netRevenue)} net
            </strong>,{" "}
            <strong style={{ color: operationsReviewComparison.delta.stuckCubeCount <= 0 ? "#1a6b28" : "#9b1c1c" }}>
              {formatSignedCount(-operationsReviewComparison.delta.stuckCubeCount)} stuck improvement
            </strong>
          </span>
        </div>
      )}
    </div>
  ) : undefined

  // ── Render ─────────────────────────────────────────────────────────────────

  if (appPhase === "setup") {
    return (
      <div style={{ minHeight: "100vh", background: "#f3f6f2", padding: 24, overflowY: "auto" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "grid", gap: 20 }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#223024" }}>Bot Coaching</div>
          <div style={{ color: "#56635a" }}>
            Watch bots play and rate their decisions. Your ratings are saved and used to improve bot weights.
          </div>

          {/* Bot slots */}
          <div style={CARD_STYLE}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#223024", marginBottom: 16 }}>Bots</div>
            <div style={{ display: "grid", gap: 14 }}>
              {settings.bots.map((bot, index) => (
                <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 10, border: "1px solid #d8dfd5", background: "#fbfcfb" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#56635a", fontWeight: 700, marginBottom: 4 }}>Name</div>
                    <input
                      type="text"
                      value={bot.name}
                      onChange={e => updateBotSlot(index, { name: e.target.value })}
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #c7d0c4", fontSize: 14, width: "100%", boxSizing: "border-box" }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#56635a", fontWeight: 700, marginBottom: 4 }}>Preset</div>
                    <select
                      value={bot.presetId}
                      onChange={e => updateBotSlot(index, { presetId: e.target.value as BotPresetId })}
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #c7d0c4", fontSize: 14, width: "100%" }}
                    >
                      {BOT_PRESET_IDS.map(id => (
                        <option key={id} value={id}>{getBotPresetLabel(id)}</option>
                      ))}
                    </select>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#223024", cursor: "pointer", whiteSpace: "nowrap", paddingTop: 18 }}>
                    <input
                      type="checkbox"
                      checked={bot.paused}
                      onChange={e => updateBotSlot(index, { paused: e.target.checked })}
                    />
                    Pause for coaching
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Decision types */}
          <div style={CARD_STYLE}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#223024", marginBottom: 4 }}>Decision types to coach</div>
            <div style={{ color: "#56635a", fontSize: 14, marginBottom: 16 }}>
              Only paused bots will stop for these decision types.
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {(Object.entries(DECISION_TYPE_LABELS) as [DecisionTypeKey, string][]).map(([key, label]) => (
                <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#223024", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={settings.pausedDecisionTypes.has(key)}
                    onChange={() => toggleDecisionType(key)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void startGame()}
            style={BUTTON_PRIMARY}
          >
            Start coaching session
          </button>

          <a href="/training.html" style={{ color: "#56635a", fontSize: 13 }}>← Back to training</a>
        </div>
      </div>
    )
  }

  if (!game) return null

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      {appPhase === "playing" && !pendingDecision && (
        <div style={{ position: "absolute", top: 12, right: 12, zIndex: 60 }}>
          <button
            type="button"
            onClick={handleExitToSetup}
            style={{ ...BUTTON_SECONDARY, fontSize: 13, padding: "8px 14px" }}
          >
            Exit coaching
          </button>
        </div>
      )}

      {/* Board (view-only) */}
      <div style={{ pointerEvents: "auto" }}>
        <Board
          game={boardGame ?? game}
          viewingPlayerId={pendingDecision?.botPlayerId ?? viewingPlayerId}
          suppressPeriodSummary
          onPeriodSummaryVisibilityChange={setIsPeriodSummaryVisible}
          onClaimRoute={pendingDecision?.operationsReview ? handleCoachClaimRoute : noop}
          onDrawCityOffer={noop}
          onSetActiveCityOfferKeptCityIds={noop}
          onBuyVehicleCard={pendingDecision?.vehicleReview ? handleCoachBuyVehicleCard : noop}
          onUpgradeRailRoute={noop}
          onSetBureaucracyRouteVehicleCard={pendingDecision?.operationsReview ? handleCoachSetBureaucracyRouteVehicleCard : noop}
          onSetBureaucracyAirRouteCities={noop}
          onAddBureaucracyServiceSplit={pendingDecision?.operationsReview ? handleCoachAddBureaucracyServiceSplit : noop}
          onSetBureaucracyServicePodCities={pendingDecision?.operationsReview ? handleCoachSetBureaucracyServicePodCities : noop}
          onDeleteBureaucracyServicePod={pendingDecision?.operationsReview ? handleCoachDeleteBureaucracyServicePod : noop}
          onAdvanceTurn={noop}
          onExchangeVehicleCard={pendingDecision?.vehicleReview ? handleCoachExchangeVehicleCard : noop}
          onStopAutoPlay={noopVoid}
          operationsInlineAction={operationsInlineAction}
          onUndo={noopVoid}
          canUndo={false}
        />
      </div>

      {/* Decision panel */}
      {pendingDecision && !pendingDecision.operationsReview && (
        <div style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 440,
          background: "#ffffff",
          borderLeft: "2px solid #d8dfd5",
          zIndex: 50,
          padding: 20,
          overflowY: "auto",
          display: "grid",
          alignContent: "start",
          gap: 16,
          boxShadow: "-8px 0 32px rgba(0,0,0,0.15)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, color: "#56635a", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {pendingDecision.botPlayerName} · {DECISION_TYPE_LABELS[pendingDecision.decisionType] ?? pendingDecision.decisionType}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#223024", marginTop: 4 }}>
                  {pendingDecision.operationsReview
                    ? "Review operations"
                    : pendingDecision.vehicleReview
                      ? "Manual vehicle purchase"
                      : "Rate this decision"}
                </div>
                {pendingDecision.nextPlannedLabel && (
                  <div style={{ fontSize: 12, color: "#8a9c8c", marginTop: 4 }}>
                    If accepted → next planned: <em>{pendingDecision.nextPlannedLabel}</em>
                  </div>
                )}
                {pendingDecision.operationsPlan && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "#f2f6f2", borderRadius: 8, fontSize: 12, color: "#223024" }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Full operations plan:</div>
                    {pendingDecision.operationsPlan.routes.length > 0 && (
                      <div>
                        <span style={{ fontWeight: 600 }}>Build rail: </span>
                        {pendingDecision.operationsPlan.routes.map((r, i) => (
                          <span key={i}>{r.cityNames.join(" → ")}{i < pendingDecision.operationsPlan!.routes.length - 1 ? ", " : ""}</span>
                        ))}
                      </div>
                    )}
                    {pendingDecision.operationsPlan.pods.length > 0 && (
                      <div style={{ marginTop: 2 }}>
                        <span style={{ fontWeight: 600 }}>Service pods: </span>
                        {pendingDecision.operationsPlan.pods.map((p, i) => (
                          <span key={i}>[{p.cityNames.join(" – ")}]{i < pendingDecision.operationsPlan!.pods.length - 1 ? ", " : ""}</span>
                        ))}
                      </div>
                    )}
                    {pendingDecision.operationsPlan.otherLabels.length > 0 && (
                      <div style={{ marginTop: 2, color: "#56635a" }}>
                        {pendingDecision.operationsPlan.otherLabels.join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={handleExitToSetup}
                  style={{ ...BUTTON_SECONDARY, fontSize: 13, padding: "8px 12px" }}
                >
                  Exit
                </button>
                {!pendingDecision.operationsReview && !pendingDecision.vehicleReview && pendingDecision.decisionType !== "vehicles" && (
                  <button type="button" onClick={handleSkip} style={{ ...BUTTON_SECONDARY, fontSize: 13 }}>
                    Skip
                  </button>
                )}
              </div>
            </div>

            {/* Candidates */}
            {pendingDecision.operationsReview ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ border: "2px solid #223024", borderRadius: 12, padding: "14px 16px", background: "#f7fbf6", display: "grid", gap: 10 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#223024" }}>
                    Review the final Operations layout
                  </div>
                  <div style={{ fontSize: 13, color: "#56635a" }}>
                    The bot has already finished its rail builds and pod edits. Use the normal Operations panel to drag cities between pods or clean up the layout, then accept when the final pod plan looks right.
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={handleAcceptOperationsReview}
                      style={{ ...BUTTON_PRIMARY, padding: "8px 16px", fontSize: 13 }}
                    >
                      Accept
                    </button>
                  </div>
                </div>
              </div>
            ) : pendingDecision.vehicleReview ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ border: "2px solid #223024", borderRadius: 12, padding: "14px 16px", background: "#f7fbf6", display: "grid", gap: 10 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#223024" }}>
                    Use the normal purchase UI
                  </div>
                  <div style={{ fontSize: 13, color: "#56635a" }}>
                    The ranked list is hidden for now. Use the regular purchase-equipment controls on the board to buy any quantity of any vehicle, or replace a vehicle normally. Your manual choice will be saved as an <strong>Other</strong> vehicle review.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      type="button"
                      onClick={handleCancelVehicleReview}
                      style={{ ...BUTTON_SECONDARY, padding: "8px 14px", fontSize: 13 }}
                    >
                      Back to top 5
                    </button>
                  </div>
                </div>
              </div>
            ) : pendingDecision.podProposal ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div
                  style={{
                    border: "2px solid #223024",
                    borderRadius: 12,
                    padding: "12px 14px",
                    background: "#f7fbf6",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, background: "#223024", color: "#fff", borderRadius: 6, padding: "2px 7px", letterSpacing: 0.3 }}>
                        BOT CHOICE
                      </span>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "#223024" }}>
                        Propose final {pendingDecision.podProposal.vehicleTypeLabel} pod
                      </span>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#56635a", whiteSpace: "nowrap" }}>
                      Score: {pendingDecision.candidates[0] ? formatScoreValue(pendingDecision.candidates[0].score) : "—"}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {pendingDecision.podProposal.proposedCityIds.map(cityId => (
                      <span
                        key={cityId}
                        style={{ border: "1px solid #d8dfd5", borderRadius: 999, background: "#ffffff", padding: "3px 8px", fontSize: 12, color: "#223024" }}
                      >
                        {cityNameById.get(cityId) ?? cityId}
                      </span>
                    ))}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => handleRateTopChoice("good")}
                      style={{ ...BUTTON_PRIMARY, padding: "7px 14px", fontSize: 13 }}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => setActivePodAlternativeMode(current => current === "add-city" ? null : "add-city")}
                      style={{ ...BUTTON_SECONDARY, padding: "7px 14px", fontSize: 13 }}
                    >
                      Add city
                    </button>
                    <button
                      type="button"
                      onClick={() => setActivePodAlternativeMode(current => current === "remove-city" ? null : "remove-city")}
                      style={{ ...BUTTON_SECONDARY, padding: "7px 14px", fontSize: 13 }}
                    >
                      Remove city
                    </button>
                    <button
                      type="button"
                      onClick={() => setActivePodAlternativeMode(current => current === "delete-pod" ? null : "delete-pod")}
                      style={{ ...BUTTON_SECONDARY, padding: "7px 14px", fontSize: 13, borderColor: "#c7a0a0", color: "#9b1c1c" }}
                    >
                      Delete pod
                    </button>
                  </div>
                </div>

                {activePodAlternativeMode && (() => {
                  const optionIndexes =
                    activePodAlternativeMode === "add-city"
                      ? pendingDecision.podProposal.addOptionIndexes
                      : activePodAlternativeMode === "remove-city"
                        ? pendingDecision.podProposal.removeOptionIndexes
                        : pendingDecision.podProposal.deleteOptionIndex === null
                          ? []
                          : [pendingDecision.podProposal.deleteOptionIndex]

                  return (
                    <div style={{ display: "grid", gap: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#56635a", textTransform: "uppercase", letterSpacing: 0.4 }}>
                        {activePodAlternativeMode === "add-city"
                          ? "Add-city alternatives"
                          : activePodAlternativeMode === "remove-city"
                            ? "Remove-city alternatives"
                            : "Delete-pod alternative"}
                      </div>
                      {optionIndexes.length === 0 ? (
                        <div style={{ border: "1px solid #d8dfd5", borderRadius: 12, background: "#fbfcfb", padding: "12px 14px", fontSize: 13, color: "#56635a" }}>
                          No {activePodAlternativeMode === "delete-pod" ? "delete" : activePodAlternativeMode.replace("-", " ")} alternatives are available here.
                        </div>
                      ) : (
                        optionIndexes.map(index => {
                          const candidate = pendingDecision.candidates[index]
                          if (!candidate) return null
                          const cityIds = pendingDecision.podProposal?.cityIdsByCandidateIndex[index] ?? []
                          return (
                            <div
                              key={index}
                              style={{
                                border: "2px solid #d8dfd5",
                                borderRadius: 12,
                                padding: "12px 14px",
                                background: "#fbfcfb",
                                display: "grid",
                                gap: 8,
                              }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 15, fontWeight: 700, color: "#223024" }}>
                                  {candidate.action.type === "delete-service-pod"
                                    ? "Delete this pod"
                                    : `Propose final ${pendingDecision.podProposal?.vehicleTypeLabel} pod`}
                                </span>
                                <span style={{ fontSize: 14, fontWeight: 700, color: "#56635a", whiteSpace: "nowrap" }}>
                                  Score: {formatScoreValue(candidate.score)}
                                </span>
                              </div>
                              {candidate.action.type !== "delete-service-pod" && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                  {cityIds.map(cityId => (
                                    <span
                                      key={`${index}-${cityId}`}
                                      style={{ border: "1px solid #d8dfd5", borderRadius: 999, background: "#ffffff", padding: "3px 8px", fontSize: 12, color: "#223024" }}
                                    >
                                      {cityNameById.get(cityId) ?? cityId}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                <button
                                  type="button"
                                  onClick={() => handleRateAlternative(index, "slightly-better")}
                                  style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13, borderColor: "#c7d0c4", color: "#56635a" }}
                                >
                                  Slightly better
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRateAlternative(index, "better")}
                                  style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13, borderColor: "#c7a0a0", color: "#9b1c1c" }}
                                >
                                  Better
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRateAlternative(index, "way-better")}
                                  style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13, borderColor: "#9b1c1c", color: "#9b1c1c", fontWeight: 700 }}
                                >
                                  Way better
                                </button>
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )
                })()}
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gap: 10 }}>
                  {pendingDecision.candidates.map((candidate, index) => (
                    <div
                      key={index}
                      style={{
                        border: `2px solid ${index === 0 ? "#223024" : "#d8dfd5"}`,
                        borderRadius: 12,
                        padding: "12px 14px",
                        background: index === 0 ? "#f7fbf6" : "#fbfcfb",
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {index === 0 && (
                            <span style={{ fontSize: 11, fontWeight: 800, background: "#223024", color: "#fff", borderRadius: 6, padding: "2px 7px", letterSpacing: 0.3 }}>
                              BOT CHOICE
                            </span>
                          )}
                          <span style={{ fontSize: 15, fontWeight: index === 0 ? 800 : 600, color: "#223024" }}>
                            {candidate.label}
                          </span>
                        </div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "#56635a", whiteSpace: "nowrap" }}>
                          Score: {formatScoreValue(candidate.score)}
                        </span>
                      </div>

                      {candidate.breakdown && !("kind" in candidate.breakdown) && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 12, color: "#56635a" }}>
                          {candidate.breakdown.modeBase !== 0 && <span>Mode base: {scorePts(candidate.breakdown.modeBase)}</span>}
                          {candidate.breakdown.populationScore !== 0 && <span>Population: {scorePts(candidate.breakdown.populationScore)}</span>}
                          {candidate.breakdown.newCityBonus !== 0 && <span>New cities: {scorePts(candidate.breakdown.newCityBonus)}</span>}
                          {candidate.breakdown.firstModeBonus !== 0 && <span>First mode: {scorePts(candidate.breakdown.firstModeBonus)}</span>}
                          {candidate.breakdown.regionPreference !== 0 && <span>Region pref: {scorePts(candidate.breakdown.regionPreference)}</span>}
                          {candidate.breakdown.sameRegionLinkBonus !== 0 && <span>Same region: {scorePts(candidate.breakdown.sameRegionLinkBonus)}</span>}
                          {candidate.breakdown.longDistancePreference !== 0 && <span>Long distance: {scorePts(candidate.breakdown.longDistancePreference)}</span>}
                          {candidate.breakdown.newRegionBonus !== 0 && <span>New region: {scorePts(candidate.breakdown.newRegionBonus)}</span>}
                          {candidate.breakdown.adjacentNetworkBonus !== 0 && <span>Network ext. ×{candidate.breakdown.adjacentNetworkCount}: {scorePts(candidate.breakdown.adjacentNetworkBonus)}</span>}
                          {candidate.breakdown.opponentBlockPenalty !== 0 && <span style={{ color: "#9b1c1c" }}>Opponent block ×{candidate.breakdown.opponentBlockCount}: −{scorePts(candidate.breakdown.opponentBlockPenalty)}</span>}
                          {candidate.breakdown.costPenalty !== 0 && <span style={{ color: "#9b1c1c" }}>Cost penalty: −{scorePts(candidate.breakdown.costPenalty)}</span>}
                        </div>
                      )}

                      {candidate.breakdown && "kind" in candidate.breakdown && candidate.breakdown.kind === "keep-city" && (
                        <KeepCityBreakdownRow breakdown={candidate.breakdown} />
                      )}
                      {candidate.breakdown && "kind" in candidate.breakdown && candidate.breakdown.kind === "draw-city" && (
                        <DrawCityBreakdownRow breakdown={candidate.breakdown} />
                      )}
                      {candidate.breakdown && "kind" in candidate.breakdown && candidate.breakdown.kind === "buy-vehicle" && (
                        <BuyVehicleBreakdownRow breakdown={candidate.breakdown} />
                      )}

                      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                        {index === 0 ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleRateTopChoice("fine")}
                              style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13 }}
                            >
                              👍 Fine
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRateTopChoice("good")}
                              style={{ ...BUTTON_PRIMARY, padding: "7px 12px", fontSize: 13 }}
                            >
                              👍 Good
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRateTopChoice("great")}
                              style={{ ...BUTTON_PRIMARY, padding: "7px 12px", fontSize: 13, background: "#1f5f2c", borderColor: "#1f5f2c" }}
                            >
                              🔥 Great
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => handleRateAlternative(index, "slightly-better")}
                              style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13, borderColor: "#c7d0c4", color: "#56635a" }}
                            >
                              Slightly better
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRateAlternative(index, "better")}
                              style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13, borderColor: "#c7a0a0", color: "#9b1c1c" }}
                            >
                              Better
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRateAlternative(index, "way-better")}
                              style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13, borderColor: "#9b1c1c", color: "#9b1c1c", fontWeight: 700 }}
                            >
                              Way better
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {pendingDecision.decisionType === "vehicles" && (
                    <>
                      <div
                        style={{
                          border: "2px dashed #c7d0c4",
                          borderRadius: 12,
                          padding: "12px 14px",
                          background: "#fbfcfb",
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 15, fontWeight: 700, color: "#223024" }}>
                            Other
                          </span>
                          <span style={{ fontSize: 12, color: "#56635a" }}>
                            Use the regular purchase UI
                          </span>
                        </div>
                        <div style={{ fontSize: 13, color: "#56635a" }}>
                          Not seeing the quantity or vehicle you want in the top 5? Open the normal purchase-equipment controls and choose any legal buy or replace action there.
                        </div>
                        <div>
                          <button
                            type="button"
                            onClick={handleStartVehicleReview}
                            style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13 }}
                          >
                            Open normal UI
                          </button>
                        </div>
                      </div>
                      <div
                        style={{
                          border: "2px dashed #d8dfd5",
                          borderRadius: 12,
                          padding: "12px 14px",
                          background: "#fbfcfb",
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 15, fontWeight: 700, color: "#223024" }}>
                            Skip vehicle purchase
                          </span>
                          <span style={{ fontSize: 12, color: "#56635a" }}>
                            Continue with the bot&apos;s next step
                          </span>
                        </div>
                        <div style={{ fontSize: 13, color: "#56635a" }}>
                          Use this when you do not want to buy or replace a vehicle here and just want coaching to continue.
                        </div>
                        <div>
                          <button
                            type="button"
                            onClick={handleSkip}
                            style={{ ...BUTTON_SECONDARY, padding: "7px 12px", fontSize: 13 }}
                          >
                            Continue
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div style={{ fontSize: 12, color: "#8a9c8c" }}>
                  Rate the bot choice as fine/good/great, or pick an alternative and say whether it was slightly better, better, or way better.
                </div>
              </>
            )}
        </div>
      )}

      {/* Game over overlay */}
      {appPhase === "done" && !pendingDecision && (
        <div style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          background: "rgba(34, 48, 36, 0.6)",
          zIndex: 50,
        }}>
          <div style={{ ...CARD_STYLE, maxWidth: 480, width: "100%", gap: 16, display: "grid" }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#223024" }}>Game over</div>
            {session && (
              <div style={{ color: "#56635a", fontSize: 14 }}>
                {summarizeCoachingSession(session)}
              </div>
            )}
            {saveMessage && (
              <div style={{ fontSize: 13, color: "#1f5f2c", fontWeight: 700 }}>{saveMessage}</div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleSaveSession()}
                disabled={isSaving || session?.decisions.length === 0}
                style={{
                  ...BUTTON_PRIMARY,
                  opacity: isSaving || session?.decisions.length === 0 ? 0.5 : 1,
                  cursor: isSaving ? "wait" : "pointer",
                }}
              >
                {isSaving ? "Saving..." : "Save session"}
              </button>
              <button
                type="button"
                onClick={resetToSetup}
                style={BUTTON_SECONDARY}
              >
                New session
              </button>
              <a href="/training.html" style={{ ...BUTTON_SECONDARY, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                Back to training
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Coaching stats HUD */}
      {appPhase === "playing" && session && session.decisions.length > 0 && (
        <div style={{
          position: "absolute",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(34, 48, 36, 0.88)",
          color: "#ffffff",
          borderRadius: 14,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 700,
          zIndex: 10,
          whiteSpace: "nowrap",
        }}>
          🎓 {session.decisions.length} rated · {session.decisions.filter(d => d.preferredIndex === null).length} top-choice ratings · {session.decisions.filter(d => d.preferredIndex !== null).length} alternative picks
        </div>
      )}
    </div>
  )
}
