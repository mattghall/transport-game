/**
 * Train bot weights from coaching session ratings.
 *
 * Loads coaching session files from public/training-results/coaching-sessions/,
 * converts saved coaching feedback into pairwise preferences and heuristic
 * outcome adjustments, and nudges the scripted-bot weights accordingly.
 *
 * Usage: npm run train:coached
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  mergeScriptedBotWeights,
  type BuyVehicleScoreBreakdown,
  type ClaimRouteScoreBreakdown,
  type DrawCityScoreBreakdown,
  type KeepCityScoreBreakdown,
  type ScriptedBotWeights,
} from "../src/bots/scriptedBot.ts"
import { MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS, SCRIPTED_BOT_LEVER_METADATA } from "../src/bots/leverMetadata.ts"
import type { BotAction } from "../src/bots/types.ts"
import type { OperationsReviewComparison } from "../src/data/coachingReview.ts"

const COACHING_SESSIONS_DIR = resolve(process.cwd(), "public/training-results/coaching-sessions")
const TRAINING_RESULTS_DIR = resolve(process.cwd(), "public/training-results")

type CoachingDecision = {
  id: string
  botPlayerId: string
  decisionType: string
  week: number
  phase: string
  weightsSnapshot: Partial<ScriptedBotWeights>
  candidates: Array<{
    action: BotAction
    score: number
    label: string
    breakdown: ClaimRouteScoreBreakdown | KeepCityScoreBreakdown | BuyVehicleScoreBreakdown | DrawCityScoreBreakdown | null
  }>
  botChoiceIndex?: number
  chosenIndex: number
  rating:
    | "accept"
    | "reject"
    | "fine"
    | "good"
    | "great"
    | "slightly-better"
    | "better"
    | "way-better"
  preferredIndex: number | null
  reviewEdits?: string[]
  operationsReviewComparison?: OperationsReviewComparison
}

type CoachingSession = {
  id: string
  decisions: CoachingDecision[]
}

type PairwisePreference = {
  sessionId: string
  decisionId: string
  preferred: CoachingDecision["candidates"][number]
  rejected: CoachingDecision["candidates"][number]
  strength: number
  source: string
}

type WeightAdjustments = Partial<Record<keyof ScriptedBotWeights, { total: number; evidence: number }>>

type TrainingSignals = {
  preferences: PairwisePreference[]
  operationsReviewDecisions: number
  alternativePreferences: number
  topChoicePreferences: number
}

type WeightFeatureMap = Partial<Record<keyof ScriptedBotWeights, number>>

const ALTERNATIVE_STRENGTH: Record<"slightly-better" | "better" | "way-better", number> = {
  "slightly-better": 0.75,
  better: 1.15,
  "way-better": 1.75,
}

const TOP_CHOICE_STRENGTH: Record<"fine" | "good" | "great", number> = {
  fine: 0.35,
  good: 0.75,
  great: 1.15,
}

function addFeature(
  features: WeightFeatureMap,
  key: keyof ScriptedBotWeights,
  value: number,
) {
  if (!Number.isFinite(value) || value === 0) {
    return
  }
  features[key] = (features[key] ?? 0) + value
}

function extractCandidateFeatures(
  candidate: CoachingDecision["candidates"][number],
): WeightFeatureMap | null {
  if (!candidate.breakdown) {
    return null
  }

  const features: WeightFeatureMap = {}
  const { action, breakdown } = candidate

  if ("kind" in breakdown && breakdown.kind === "keep-city") {
    addFeature(features, "keepCityPopulationScore", breakdown.populationScore)
    addFeature(features, "keepCityNetworkProximityScore", breakdown.networkProximityScore)
    addFeature(features, "keepCityRegionMatchScore", breakdown.regionMatchScore)
    addFeature(features, "keepCityAdjacencyPotentialScore", breakdown.adjacencyPotentialScore)
    return features
  }

  if ("kind" in breakdown && breakdown.kind === "draw-city") {
    addFeature(features, "drawRegionDeckSizeScore", breakdown.deckSizeScore)
    addFeature(features, "drawRegionOwnedCityBonus", breakdown.ownedInRegionScore)
    addFeature(features, "drawRegionOpponentCityPenalty", -breakdown.opponentPenalty)
    addFeature(features, "drawRegionBigCityScarcityBonus", breakdown.bigCityScarcityScore)
    return features
  }

  if ("kind" in breakdown && breakdown.kind === "buy-vehicle") {
    if (breakdown.vehicleType === "bus") {
      addFeature(features, "vehiclePriorityBus", breakdown.typePriority)
      addFeature(features, "buyBusOwnedCityBonus", breakdown.cityBonus)
    } else if (breakdown.vehicleType === "train") {
      addFeature(features, "vehiclePriorityTrain", breakdown.typePriority)
      if (breakdown.cityBonusReason.includes("rail claim opportunities")) {
        addFeature(features, "buyTrainPotentialClaimBonus", breakdown.cityBonus)
      } else if (breakdown.cityBonusReason.includes("existing rail network")) {
        addFeature(features, "buyTrainFallbackOwnedCityBonus", breakdown.cityBonus)
      } else if (breakdown.cityBonusReason.includes("no rail claims")) {
        addFeature(features, "buyTrainNoClaimPenalty", breakdown.cityBonus)
      }
      addFeature(features, "buyFirstTrainBonus", breakdown.firstOfTypeBonus)
    } else if (breakdown.vehicleType === "air") {
      addFeature(features, "vehiclePriorityAir", breakdown.typePriority)
      if (breakdown.cityBonusReason.includes("air claim opportunities")) {
        addFeature(features, "buyAirPotentialClaimBonus", breakdown.cityBonus)
      } else if (breakdown.cityBonusReason.includes("fallback")) {
        addFeature(features, "buyAirFallbackOwnedCityBonus", breakdown.cityBonus)
      } else if (breakdown.cityBonusReason.includes("no air claims")) {
        addFeature(features, "buyAirNoClaimPenalty", breakdown.cityBonus)
      }
      addFeature(features, "buyFirstAirBonus", breakdown.firstOfTypeBonus)
    }
    addFeature(features, "buyVehicleCapacityScore", breakdown.totalPassengerCapacity / 100)
    addFeature(features, "buyVehicleSpeedScore", breakdown.speed / 10)
    addFeature(features, "buyDuplicateVehiclePenalty", -breakdown.duplicatePenalty)
    return features
  }

  if (action.type === "claim-route") {
    addFeature(
      features,
      action.mode === "rail" ? "claimRailBaseScore" : "claimAirBaseScore",
      breakdown.modeBase,
    )
    addFeature(features, "claimPopulationPerMillionScore", breakdown.populationScore)
    addFeature(features, "claimFirstModeBonus", breakdown.firstModeBonus)
    addFeature(features, "claimSameRegionLinkBonus", breakdown.sameRegionLinkBonus)
    addFeature(features, "claimLongDistancePreference", breakdown.longDistancePreference)
    addFeature(features, "claimNewRegionBonus", breakdown.newRegionBonus)
    addFeature(features, "claimAdjacentNetworkBonus", breakdown.adjacentNetworkBonus)
    addFeature(features, "claimOpponentBlockPenalty", -breakdown.opponentBlockPenalty)
    addFeature(features, "claimConnectorWastePenaltyMultiplier", -breakdown.connectorWastePenalty)
    addFeature(features, "claimDisconnectedRailPenalty", -breakdown.disconnectedRailPenalty)
    addFeature(features, "claimRailCostPenaltyPerMillion", -breakdown.costPenalty)
    return features
  }

  return Object.keys(features).length > 0 ? features : null
}

function boundedInfluence(delta: number, scale = 30) {
  return Math.tanh(delta / scale)
}

function applyFeatureDelta(
  adjustments: WeightAdjustments,
  key: keyof ScriptedBotWeights,
  influence: number,
) {
  if (!Number.isFinite(influence) || influence === 0) {
    return
  }

  const current = adjustments[key] ?? { total: 0, evidence: 0 }
  adjustments[key] = {
    total: current.total + influence,
    evidence: current.evidence + 1,
  }
}

function addPairwisePreferenceAdjustments(
  adjustments: WeightAdjustments,
  preference: PairwisePreference,
) {
  const preferredFeatures = extractCandidateFeatures(preference.preferred)
  const rejectedFeatures = extractCandidateFeatures(preference.rejected)
  if (!preferredFeatures && !rejectedFeatures) {
    return
  }

  for (const key of MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS) {
    const preferredValue = preferredFeatures?.[key] ?? 0
    const rejectedValue = rejectedFeatures?.[key] ?? 0
    const delta = preferredValue - rejectedValue
    applyFeatureDelta(adjustments, key, preference.strength * boundedInfluence(delta))
  }
}

function addOperationsReviewAdjustments(
  adjustments: WeightAdjustments,
  decision: CoachingDecision,
) {
  const comparison = decision.operationsReviewComparison
  if (!comparison) {
    return
  }

  const combinedImpact =
    boundedInfluence(comparison.delta.totalPassengersServed, 35) +
    boundedInfluence(comparison.delta.netRevenue / 1_000_000, 6) +
    boundedInfluence(-comparison.delta.stuckCubeCount, 6)
  const overall = combinedImpact / 3

  if (!Number.isFinite(overall) || overall === 0) {
    return
  }

  applyFeatureDelta(adjustments, "podPassengerGainScore", overall)
  applyFeatureDelta(adjustments, "podDisconnectedCityReductionBonus", overall)

  for (const edit of decision.reviewEdits ?? []) {
    if (edit.startsWith("assigned ")) {
      applyFeatureDelta(adjustments, "podUnstaffedPodPenalty", overall)
      applyFeatureDelta(adjustments, "podHasCompatibleVehicleBonus", overall)
    } else if (edit.startsWith("set pod cities")) {
      applyFeatureDelta(adjustments, "podCityCountScore", overall)
      applyFeatureDelta(adjustments, "podPopulationPerDistanceScore", overall)
    } else if (edit.startsWith("added split service")) {
      applyFeatureDelta(adjustments, "podSplitBaseScore", overall)
      applyFeatureDelta(adjustments, "podDemandPerMileScore", overall)
    } else if (edit.startsWith("deleted ")) {
      applyFeatureDelta(adjustments, "podAdditionalRoutePenalty", overall)
    } else if (edit.startsWith("claimed a rail route")) {
      applyFeatureDelta(adjustments, "claimRailBaseScore", overall)
    } else if (edit.startsWith("claimed a air route")) {
      applyFeatureDelta(adjustments, "claimAirBaseScore", overall)
    }
  }
}

export function loadAllSessions(): CoachingSession[] {
  if (!existsSync(COACHING_SESSIONS_DIR)) {
    return []
  }

  return readdirSync(COACHING_SESSIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        return JSON.parse(readFileSync(resolve(COACHING_SESSIONS_DIR, f), "utf8")) as CoachingSession
      } catch {
        return null
      }
    })
    .filter((s): s is CoachingSession => s !== null)
}

export function extractTrainingSignals(sessions: CoachingSession[]): TrainingSignals {
  const preferences: PairwisePreference[] = []
  let operationsReviewDecisions = 0
  let alternativePreferences = 0
  let topChoicePreferences = 0

  for (const session of sessions) {
    for (const decision of session.decisions) {
      const chosenCandidate = decision.candidates[decision.chosenIndex] ?? null
      const botChoiceCandidate = decision.candidates[decision.botChoiceIndex ?? 0] ?? null

      if (
        decision.preferredIndex !== null &&
        (decision.rating === "slightly-better" || decision.rating === "better" || decision.rating === "way-better")
      ) {
        const preferredCandidate = decision.candidates[decision.preferredIndex] ?? null
        if (preferredCandidate && botChoiceCandidate) {
          preferences.push({
            sessionId: session.id,
            decisionId: decision.id,
            preferred: preferredCandidate,
            rejected: botChoiceCandidate,
            strength: ALTERNATIVE_STRENGTH[decision.rating],
            source: "alternative-preference",
          })
          alternativePreferences++
        }
      }

      if (
        chosenCandidate &&
        decision.preferredIndex === null &&
        (decision.rating === "fine" || decision.rating === "good" || decision.rating === "great") &&
        decision.candidates.length > 1
      ) {
        const strength = TOP_CHOICE_STRENGTH[decision.rating]
        decision.candidates.forEach((candidate, index) => {
          if (index === decision.chosenIndex) {
            return
          }
          preferences.push({
            sessionId: session.id,
            decisionId: decision.id,
            preferred: chosenCandidate,
            rejected: candidate,
            strength,
            source: decision.decisionType === "vehicles-review" ? "manual-vehicle-review" : "top-choice-rating",
          })
          topChoicePreferences++
        })
      }

      if (decision.decisionType === "operations-review" && decision.operationsReviewComparison) {
        operationsReviewDecisions++
      }
    }
  }

  return {
    preferences,
    operationsReviewDecisions,
    alternativePreferences,
    topChoicePreferences,
  }
}

export function deriveCoachedWeights(sessions: CoachingSession[]) {
  const signals = extractTrainingSignals(sessions)

  const champPath = resolve(TRAINING_RESULTS_DIR, "champion-4p.json")
  let baseWeights: ScriptedBotWeights
  if (existsSync(champPath)) {
    try {
      const champData = JSON.parse(readFileSync(champPath, "utf8")) as { training?: { weights?: Partial<ScriptedBotWeights> } }
      baseWeights = mergeScriptedBotWeights(champData.training?.weights ?? {})
    } catch {
      baseWeights = { ...DEFAULT_SCRIPTED_BOT_WEIGHTS }
    }
  } else {
    baseWeights = { ...DEFAULT_SCRIPTED_BOT_WEIGHTS }
  }

  const adjustments: WeightAdjustments = {}
  for (const preference of signals.preferences) {
    addPairwisePreferenceAdjustments(adjustments, preference)
  }
  for (const session of sessions) {
    for (const decision of session.decisions) {
      if (decision.decisionType === "operations-review") {
        addOperationsReviewAdjustments(adjustments, decision)
      }
    }
  }

  const nextWeights: ScriptedBotWeights = { ...baseWeights }
  const changedWeights: Array<{ key: keyof ScriptedBotWeights; before: number; after: number; evidence: number }> = []

  for (const key of MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS) {
    const adjustment = adjustments[key]
    if (!adjustment || adjustment.evidence === 0) {
      continue
    }

    const metadata = SCRIPTED_BOT_LEVER_METADATA[key]
    const averageInfluence = adjustment.total / adjustment.evidence
    const learningScale = Math.min(3, 0.5 + adjustment.evidence / 6)
    const delta = averageInfluence * metadata.mutationStep * learningScale
    if (!Number.isFinite(delta) || delta === 0) {
      continue
    }

    const before = nextWeights[key] as number
    const unclampedAfter = before + delta
    const after = metadata.minimum !== undefined
      ? Math.max(metadata.minimum, unclampedAfter)
      : unclampedAfter

    if (after !== before) {
      nextWeights[key] = after
      changedWeights.push({ key, before, after, evidence: adjustment.evidence })
    }
  }

  changedWeights.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))

  return {
    baseWeights,
    nextWeights,
    changedWeights,
    signals,
  }
}

async function main() {
  console.log("Loading coaching sessions...")
  const sessions = loadAllSessions()

  if (sessions.length === 0) {
    console.log("No coaching session files found in", COACHING_SESSIONS_DIR)
    console.log("Coaching now auto-persists session snapshots, so play a session and try again.")
    process.exit(0)
  }

  const totalDecisions = sessions.reduce((sum, s) => sum + s.decisions.length, 0)
  const { baseWeights, nextWeights, changedWeights, signals } = deriveCoachedWeights(sessions)

  console.log(
    `Loaded ${sessions.length} sessions, ${totalDecisions} decisions, ` +
    `${signals.alternativePreferences} alternative prefs, ${signals.topChoicePreferences} top-choice prefs, ` +
    `${signals.operationsReviewDecisions} operations reviews`,
  )

  if (changedWeights.length === 0) {
    console.log("No usable coaching weight signals were found.")
    process.exit(0)
  }

  const outputPath = resolve(TRAINING_RESULTS_DIR, "coached-weights.json")
  writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    sessions: sessions.length,
    totalDecisions,
    alternativePreferences: signals.alternativePreferences,
    topChoicePreferences: signals.topChoicePreferences,
    operationsReviewDecisions: signals.operationsReviewDecisions,
    changedWeights: changedWeights.slice(0, 20),
    baseWeights,
    weights: nextWeights,
  }, null, 2))

  console.log(`Saved coached weights to ${outputPath}`)
  console.log("Largest coached changes:")
  for (const change of changedWeights.slice(0, 10)) {
    console.log(
      `  ${change.key}: ${change.before.toFixed(3)} -> ${change.after.toFixed(3)} ` +
      `(evidence ${change.evidence})`,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
