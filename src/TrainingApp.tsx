import { useEffect, useMemo, useRef, useState } from "react"
import { BOT_PRESETS } from "./bots/presets"
import {
  createTrainingSeeds,
  evaluateScriptedBotWeights,
  summarizeScriptedBotWeightEvaluation,
  type ScriptedBotWeightEvaluationSummary,
} from "./bots/training"
import type {
  ScriptedBotLeverImportanceResults,
  ScriptedBotTrainingHistoryEntry,
  ScriptedBotTrainingResults,
} from "./bots/training"
import {
  fetchAutotuneStatus,
  forceStopAutotune,
  cancelTraining,
  fetchTrainingImportance,
  fetchTrainingPresets,
  fetchTrainingStatus,
  getDefaultSessionServerUrl,
  promoteAutotuneRunToStickbug,
  startTrainingImportance,
  startAutotune,
  stopAutotune,
  type AutotuneControlStatus,
  type TrainingImportanceStatus,
  startTraining,
  type TrainingPresetStatus,
  type TrainingStartRequest,
  type TrainingStatus,
} from "./network/sessionSync"
import { buildEstimatedCityLinkProfitabilityRows } from "./engine/cityLinkProfitability"
import type { ScriptedBotWeights } from "./bots/scriptedBot"

type MetricPoint = {
  label: string
  value: number
}

const TRAINING_PLAYER_COUNT_OPTIONS = [1, 2, 3, 4] as const
type TrainingPlayerCount = (typeof TRAINING_PLAYER_COUNT_OPTIONS)[number]

type LeverImpactMetricKey = "passengerDrop" | "scoreDrop" | "winRateDrop"

type LeverImpactChartRow = {
  key: string
  label: string
  description: string
  group: string
  delta: number
  lowExplanation: string
  highExplanation: string
  passengerDrop: number | null
  scoreDrop: number | null
  winRateDrop: number | null
}

type ModeComparisonEntry = {
  playerCount: TrainingPlayerCount
  results: ScriptedBotTrainingResults | null
  importance: ScriptedBotLeverImportanceResults | null
}

type AutotuneRunRecord = {
  cycle: number
  playerCount: TrainingPlayerCount
  modeCycle: number
  profile: "refine" | "explore" | "deep"
  startedFromScratch: boolean
  opponent: string
  promoted: boolean
  benchmarkScore: number
  generatedAt: string
  final: {
    score: number
    winRate: number
    averagePassengers: number
    averagePassengerMargin: number
    averageRank: number
    sampleCount: number
    weights: ScriptedBotWeights
  }
}

type AutotuneChampionPromotion = {
  cycle: number
  playerCount: TrainingPlayerCount
  benchmarkScore: number
  generatedAt: string
  score: number
  winRate: number
  averagePassengers: number
  averagePassengerMargin: number
  sampleCount: number
}

type AutotuneHistory = {
  version: 1
  updatedAt: string
  runs: AutotuneRunRecord[]
  championPromotions: AutotuneChampionPromotion[]
}

type AutotuneStatus = {
  version: 1
  startedAt: string
  updatedAt: string
  cycle: number
  modeCycles: Record<`${TrainingPlayerCount}p`, number>
  currentRun: null | {
    cycle: number
    playerCount: TrainingPlayerCount
    modeCycle: number
    profile: "refine" | "explore" | "deep"
    startedFromScratch: boolean
    opponent: string
    startedAt: string
  }
  recentRuns: AutotuneRunRecord[]
  champions?: Partial<
    Record<
      `${TrainingPlayerCount}p`,
      | null
      | {
          cycle: number
          benchmark: {
            score: number
            winRate: number
            averagePassengers: number
            averagePassengerMargin: number
            sampleCount: number
          }
          training: {
            generatedAt: string
            final: {
              score: number
              winRate: number
              averagePassengers: number
              averagePassengerMargin: number
              sampleCount: number
            }
          }
        }
    >
  >
}
const REFRESH_MS = 3000

const LEVER_IMPACT_METRICS: Record<
  LeverImpactMetricKey,
  { label: string; description: string; digits: number }
> = {
  passengerDrop: {
    label: "Passengers drop",
    description: "Positive means keeping the trained value moves more passengers than reverting it.",
    digits: 2,
  },
  scoreDrop: {
    label: "Score drop",
    description: "Positive means the trained value improves the overall training score.",
    digits: 2,
  },
  winRateDrop: {
    label: "Win-rate drop",
    description: "Positive means the trained value improves win rate when the rest of the bot stays the same.",
    digits: 3,
  },
}

type WeightLabelInfo = {
  label: string
  description: string
  group: string
  lowExplanation: string
  highExplanation: string
}

type BotDecisionBranch = {
  title: string
  when: string
  actions: string[]
  leverKeys: Array<keyof ScriptedBotWeights>
  notes?: string[]
}

type BotDecisionPhase = {
  phase: string
  summary: string
  branches: BotDecisionBranch[]
}

const WEIGHT_LABELS: Record<string, WeightLabelInfo> = {
  vehiclePriorityBus: {
    label: "Bus buy priority",
    description: "How strongly the bot prefers buying buses during equipment.",
    group: "Vehicle buying",
    lowExplanation: "Buses are only worth it when they clearly unlock passenger gains.",
    highExplanation: "Lean hard into buses because cheap coverage can snowball passenger reach.",
  },
  vehiclePriorityTrain: {
    label: "Train buy priority",
    description: "How strongly the bot prefers buying trains during equipment.",
    group: "Vehicle buying",
    lowExplanation: "Only buy trains when a rail plan is obviously worth the spend.",
    highExplanation: "Push trains early because rail capacity may pay off in future passengers.",
  },
  vehiclePriorityAir: {
    label: "Air buy priority",
    description: "How strongly the bot prefers buying planes during equipment.",
    group: "Vehicle buying",
    lowExplanation: "Use planes for targeted high-value jumps when they clearly grow passengers.",
    highExplanation: "Favor planes because long jumps can open strong passenger markets quickly.",
  },
  claimRailBaseScore: {
    label: "Rail city-link base score",
    description: "Baseline attractiveness of claiming a rail city link before city and cost modifiers.",
    group: "Route claiming",
    lowExplanation: "Rail needs extra proof before the bot commits to expensive track.",
    highExplanation: "Rail starts attractive even before city size or cost tweaks kick in.",
  },
  claimAirBaseScore: {
    label: "Air city-link base score",
    description: "Baseline attractiveness of claiming an air city link before city and cost modifiers.",
    group: "Route claiming",
    lowExplanation: "Use air for selective city links where range creates a clear passenger payoff.",
    highExplanation: "Air city links are broadly appealing even before detailed checks.",
  },
  claimPopulationPerMillionScore: {
    label: "Population weight",
    description: "How much the bot values high-population metro pairs when choosing city links.",
    group: "Route claiming",
    lowExplanation: "Small and medium cities are fine if they fit the network well.",
    highExplanation: "Chase the biggest city pairs because passengers matter most there.",
  },
  claimNewCityBonus: {
    label: "New city bonus",
    description: "Reward for city links that connect cities the bot is not already serving.",
    group: "Route claiming",
    lowExplanation: "Deepen existing corridors instead of stretching for new dots on the map.",
    highExplanation: "Reach fresh cities fast because new endpoints can unlock more passengers.",
  },
  claimFirstModeBonus: {
    label: "First city-link of mode bonus",
    description: "Reward for starting a new transport mode in the network.",
    group: "Route claiming",
    lowExplanation: "Build around proven modes and expand the network with the tools already working.",
    highExplanation: "Branch into a new mode early if it could open new passenger angles.",
  },
  claimRailCostPenaltyPerMillion: {
    label: "Rail cost penalty",
    description: "How much the bot discounts expensive rail construction.",
    group: "Route claiming",
    lowExplanation: "Expensive rail is fine if the city link looks good for passengers.",
    highExplanation: "Favor cheaper rail lines because cost matters a lot alongside passenger upside.",
  },
  claimPacificPreference: {
    label: "Pacific preference",
    description: "How much the bot likes city links that touch Pacific cities.",
    group: "Regional strategy",
    lowExplanation: "Pacific city links need stronger passenger reasons to stand out.",
    highExplanation: "Pacific city links get extra credit when the bot compares options.",
  },
  claimMountainPreference: {
    label: "Mountain preference",
    description: "How much the bot likes city links that touch Mountain cities.",
    group: "Regional strategy",
    lowExplanation: "Mountain city links need stronger passenger reasons to stand out.",
    highExplanation: "Mountain city links get extra credit when the bot compares options.",
  },
  claimSouthPreference: {
    label: "South preference",
    description: "How much the bot likes city links that touch South cities.",
    group: "Regional strategy",
    lowExplanation: "South city links need stronger passenger reasons to stand out.",
    highExplanation: "South city links get extra credit when the bot compares options.",
  },
  claimSoutheastPreference: {
    label: "Southeast preference",
    description: "How much the bot likes city links that touch Southeast cities.",
    group: "Regional strategy",
    lowExplanation: "Southeast city links need stronger passenger reasons to stand out.",
    highExplanation: "Southeast city links get extra credit when the bot compares options.",
  },
  claimMidwestPreference: {
    label: "Midwest preference",
    description: "How much the bot likes city links that touch Midwest cities.",
    group: "Regional strategy",
    lowExplanation: "Midwest city links need stronger passenger reasons to stand out.",
    highExplanation: "Midwest city links get extra credit when the bot compares options.",
  },
  claimNortheastPreference: {
    label: "Northeast preference",
    description: "How much the bot likes city links that touch Northeast cities.",
    group: "Regional strategy",
    lowExplanation: "Northeast city links need stronger passenger reasons to stand out.",
    highExplanation: "Northeast city links get extra credit when the bot compares options.",
  },
  claimSameRegionLinkBonus: {
    label: "Same-region city-link bonus",
    description: "Bonus for city links whose two endpoints stay in the same primary region.",
    group: "Regional strategy",
    lowExplanation: "Mixed-region city links can compete evenly when they move more passengers.",
    highExplanation: "City links that stay inside one region get extra credit for regional focus.",
  },
  claimNewRegionBonus: {
    label: "New-region expansion bonus",
    description: "Bonus for city links that expand the network into a region the player is not already serving.",
    group: "Regional strategy",
    lowExplanation: "Build deeper inside the current regions before branching into a new one.",
    highExplanation: "Expand into new regions earlier when that can open fresh passenger markets.",
  },
  claimLongDistancePreference: {
    label: "Long-distance city-link preference",
    description: "How much the bot prefers longer city links that fall into higher distance payout buckets.",
    group: "Route claiming",
    lowExplanation: "Prefer shorter city links when they can serve passengers efficiently.",
    highExplanation: "Prefer longer city links when bigger distance payouts can justify the reach.",
  },
  buyBusOwnedCityBonus: {
    label: "Bus city-card bonus",
    description: "Extra appetite for buses when the bot already holds many city cards.",
    group: "Vehicle buying",
    lowExplanation: "Use city cards as one input and buy buses when the passenger city link is strong.",
    highExplanation: "Loaded with city cards? Turn them into bus city links quickly.",
  },
  buyTrainPotentialClaimBonus: {
    label: "Train opportunity bonus",
    description: "Extra appetite for trains when promising rail claims are available.",
    group: "Vehicle buying",
    lowExplanation: "Buy trains when a rail opportunity looks clearly worth the investment.",
    highExplanation: "If a good rail line is waiting, buy trains now to cash in on it.",
  },
  buyTrainFallbackOwnedCityBonus: {
    label: "Train fallback bonus",
    description: "Fallback train preference when the bot has enough city cards but no great rail claim yet.",
    group: "Vehicle buying",
    lowExplanation: "Let the next strong rail opportunity lead the train purchase timing.",
    highExplanation: "City cards alone are enough reason to prepare with trains anyway.",
  },
  buyTrainNoClaimPenalty: {
    label: "Train no-opportunity penalty",
    description: "Penalty for buying trains when there are no worthwhile rail claims.",
    group: "Vehicle buying",
    lowExplanation: "The bot will still speculate on trains before the perfect city link appears.",
    highExplanation: "Keep cash flexible and buy trains alongside a near-term city-link plan.",
  },
  buyAirPotentialClaimBonus: {
    label: "Air opportunity bonus",
    description: "Extra appetite for planes when promising air claims are available.",
    group: "Vehicle buying",
    lowExplanation: "Even with a possible air city link, planes must clear a high bar.",
    highExplanation: "A promising air city link is a strong signal to buy planes immediately.",
  },
  buyAirFallbackOwnedCityBonus: {
    label: "Air fallback bonus",
    description: "Fallback plane preference when the bot has enough city cards but no great air claim yet.",
    group: "Vehicle buying",
    lowExplanation: "Buy planes when city cards line up with a city link that can pay off soon.",
    highExplanation: "Enough city cards can justify prepping air city links before the best moment.",
  },
  buyAirNoClaimPenalty: {
    label: "Air no-opportunity penalty",
    description: "Penalty for buying planes when there are no worthwhile air claims.",
    group: "Vehicle buying",
    lowExplanation: "The bot is willing to pre-buy planes and trust future passenger demand.",
    highExplanation: "Buy planes when an air city link can help passengers soon.",
  },
  buyDuplicateVehiclePenalty: {
    label: "Duplicate vehicle penalty",
    description: "How much the bot avoids stacking more of the same vehicle type.",
    group: "Vehicle buying",
    lowExplanation: "Doubling down on one vehicle type is acceptable if it serves passengers best.",
    highExplanation: "Keep the fleet mixed instead of overcommitting to one transport mode.",
  },
  buyFirstTrainBonus: {
    label: "First train bonus",
    description: "Reward for adding the first train to the fleet.",
    group: "Vehicle buying",
    lowExplanation: "The first train should earn its keep; no rush to add rail capability.",
    highExplanation: "Get one train on the board early to unlock rail passenger options.",
  },
  buyFirstAirBonus: {
    label: "First air bonus",
    description: "Reward for adding the first plane to the fleet.",
    group: "Vehicle buying",
    lowExplanation: "Planes can wait until the network clearly needs long-distance reach.",
    highExplanation: "Add one plane early because range can unlock new passenger pools.",
  },
  earlyExpansionMultiplier: {
    label: "Early expansion multiplier",
    description: "How aggressively the bot values new-city expansion in the early game.",
    group: "Stage strategy",
    lowExplanation: "Start compact and efficient before stretching for more cities.",
    highExplanation: "Expand fast early to build a larger passenger map before rivals do.",
  },
  midExpansionMultiplier: {
    label: "Mid expansion multiplier",
    description: "How aggressively the bot values new-city expansion in the mid game.",
    group: "Stage strategy",
    lowExplanation: "Midgame should focus on strengthening city links you already own.",
    highExplanation: "Keep spreading outward in midgame to keep passenger growth alive.",
  },
  lateExpansionMultiplier: {
    label: "Late expansion multiplier",
    description: "How aggressively the bot values new-city expansion in the late game.",
    group: "Stage strategy",
    lowExplanation: "Late game favors strengthening existing city links and collecting their passenger value.",
    highExplanation: "Even late, new cities may still be worth it for a passenger swing.",
  },
  earlyPopulationMultiplier: {
    label: "Early passenger multiplier",
    description: "How much the bot values large-population endpoints in the early game.",
    group: "Stage strategy",
    lowExplanation: "Prefer efficient city links that build the network.",
    highExplanation: "Connect major cities early so their passenger volume can pay off across more turns.",
  },
  midPopulationMultiplier: {
    label: "Mid passenger multiplier",
    description: "How much the bot values large-population endpoints in the mid game.",
    group: "Stage strategy",
    lowExplanation: "Midgame can value fit and efficiency over pure city size.",
    highExplanation: "Midgame should keep steering toward the biggest passenger hubs.",
  },
  latePopulationMultiplier: {
    label: "Late passenger multiplier",
    description: "How much the bot values large-population endpoints in the late game.",
    group: "Stage strategy",
    lowExplanation: "Late game values reliable city links that fit the network and score steady passengers.",
    highExplanation: "Late game should hunt the largest remaining passenger payoffs.",
  },
  earlyReadyOperationsScore: {
    label: "Early stop-building score",
    description: "How willing the bot is to stop building city links and finish Operations early in the game.",
    group: "Stage strategy",
    lowExplanation: "Keep building early; more city links now can mean more passengers later.",
    highExplanation: "After the required setup is done, finish Operations sooner instead of adding more low-value city links.",
  },
  midReadyOperationsScore: {
    label: "Mid stop-building score",
    description: "How willing the bot is to stop building city links and finish Operations in the middle game.",
    group: "Stage strategy",
    lowExplanation: "In midgame, keep pressing expansion before ending Operations.",
    highExplanation: "Midgame should stop sooner and cash in existing passenger city links.",
  },
  lateReadyOperationsScore: {
    label: "Late stop-building score",
    description: "How willing the bot is to stop building city links and finish Operations late in the game.",
    group: "Stage strategy",
    lowExplanation: "Late turns should squeeze in every last city-link opportunity.",
    highExplanation: "After the required setup is done, finish Operations sooner and focus on the profitable city links already in the network.",
  },
  earlyClaimBudget: {
    label: "Early city-link budget",
    description: "Maximum city links the bot tries to build in one Operations turn early in the game.",
    group: "Stage strategy",
    lowExplanation: "Build just a little early and stay selective with cash.",
    highExplanation: "Spend bigger early to grab more passenger territory in one turn.",
  },
  midClaimBudget: {
    label: "Mid city-link budget",
    description: "Maximum city links the bot tries to build in one Operations turn in the middle game.",
    group: "Stage strategy",
    lowExplanation: "Midgame building stays tight and disciplined.",
    highExplanation: "Midgame can still support a burst of new city-link building.",
  },
  lateClaimBudget: {
    label: "Late city-link budget",
    description: "Maximum city links the bot tries to build in one Operations turn late in the game.",
    group: "Stage strategy",
    lowExplanation: "Late game keeps spending tight and adds city links selectively.",
    highExplanation: "Late game is still willing to spend big for a final passenger push.",
  },
}

const BOT_PHASE_DECISION_TREE: BotDecisionPhase[] = [
  {
    phase: "Purchase equipment",
    summary: "The bot compares visible vehicle market cards it can afford, scores each one, and can also pass with end turn.",
    branches: [
      {
        title: "Score each affordable vehicle card",
        when: "Runs whenever the current phase is purchase-equipment and the bot has not already bought a vehicle this turn.",
        actions: ["buy-vehicle (bus)", "buy-vehicle (train)", "buy-vehicle (air)", "end-turn"],
        leverKeys: [
          "vehiclePriorityBus",
          "vehiclePriorityTrain",
          "vehiclePriorityAir",
          "buyBusOwnedCityBonus",
          "buyTrainPotentialClaimBonus",
          "buyTrainFallbackOwnedCityBonus",
          "buyTrainNoClaimPenalty",
          "buyAirPotentialClaimBonus",
          "buyAirFallbackOwnedCityBonus",
          "buyAirNoClaimPenalty",
          "buyDuplicateVehiclePenalty",
          "buyFirstTrainBonus",
          "buyFirstAirBonus",
        ],
        notes: [
          "Only visible market cards the bot can afford are considered.",
          "The purchase price itself subtracts from the score, so expensive cards need stronger upside.",
        ],
      },
    ],
  },
  {
    phase: "Add city",
    summary: "This phase is a small state machine: first draw a city offer, then keep two cities, then confirm the picks.",
    branches: [
      {
        title: "Choose a region and draw a city offer",
        when: "If there is no active city offer yet.",
        actions: ["draw-city-offer"],
        leverKeys: [],
        notes: [
          "Region choice is currently heuristic-driven, based on deck size and owned city-card counts by region.",
          "No trained lever directly changes this branch yet.",
        ],
      },
      {
        title: "Keep the two cities from the offer",
        when: "If an active city offer exists and fewer than two cities have been kept.",
        actions: ["keep-city-offer"],
        leverKeys: [],
        notes: [
          "The bot currently keeps the top two offered cities by population/size.",
          "No trained lever directly changes this branch yet.",
        ],
      },
      {
        title: "Lock in the selected city cards",
        when: "If exactly two offered cities have already been kept.",
        actions: ["confirm-add-city-picks"],
        leverKeys: [],
        notes: ["This is a rules step, not a scored decision branch."],
      },
      {
        title: "Fallback pass",
        when: "If the active city offer is malformed and does not contain enough cities.",
        actions: ["end-turn"],
        leverKeys: [],
      },
    ],
  },
  {
    phase: "Operations",
    summary: "This is the main scored decision phase: the bot ranks rail and air city-link claims, but can stop building and ready operations instead.",
    branches: [
      {
        title: "Claim the best-looking rail or air city link",
        when: "If the bot can edit operations and there are legal rail or air claims from owned city-card pairs.",
        actions: ["claim-route (rail)", "claim-route (air)", "ready-operations"],
        leverKeys: [
          "claimRailBaseScore",
          "claimAirBaseScore",
          "claimPopulationPerMillionScore",
          "claimNewCityBonus",
          "claimFirstModeBonus",
          "claimRailCostPenaltyPerMillion",
          "claimPacificPreference",
          "claimMountainPreference",
          "claimSouthPreference",
          "claimSoutheastPreference",
          "claimMidwestPreference",
          "claimNortheastPreference",
          "claimSameRegionLinkBonus",
          "claimNewRegionBonus",
          "claimLongDistancePreference",
          "earlyExpansionMultiplier",
          "midExpansionMultiplier",
          "lateExpansionMultiplier",
          "earlyPopulationMultiplier",
          "midPopulationMultiplier",
          "latePopulationMultiplier",
          "earlyReadyOperationsScore",
          "midReadyOperationsScore",
          "lateReadyOperationsScore",
        ],
        notes: [
          "Buses are not claimed here; bus service comes from vehicle and city-card state instead of a manual operations claim.",
          "The bot only considers a trimmed set of the strongest candidate pairs before it scores them.",
        ],
      },
      {
        title: "Stop building once the turn budget is spent",
        when: "If claimed city links this turn already meet the current stage claim budget and ready-operations is legal.",
        actions: ["ready-operations"],
        leverKeys: ["earlyClaimBudget", "midClaimBudget", "lateClaimBudget"],
        notes: ["This early-exit gate happens before the bot ranks the remaining actions."],
      },
    ],
  },
  {
    phase: "Bureaucracy",
    summary: "Bots do not branch inside bureaucracy yet; they simply mark themselves ready once the phase reaches them.",
    branches: [
      {
        title: "Finish bureaucracy",
        when: "If the bot has not already completed bureaucracy this turn.",
        actions: ["ready-bureaucracy"],
        leverKeys: [],
        notes: ["No trained levers affect this phase right now."],
      },
    ],
  },
  {
    phase: "Purchase fuel",
    summary: "Bots currently do not make an explicit fuel-market choice and just advance the turn.",
    branches: [
      {
        title: "Pass through the fuel step",
        when: "Whenever the current phase is purchase-fuel.",
        actions: ["end-turn"],
        leverKeys: [],
        notes: ["No trained levers affect this phase right now."],
      },
    ],
  },
]

function formatMetric(value: number, digits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "—"
}

function formatWholeNumber(value: number) {
  return Number.isFinite(value) ? Math.trunc(value).toLocaleString("en-US") : "—"
}

function formatPercent(value: number) {
  return Number.isFinite(value) ? `${Math.round(value * 100).toLocaleString("en-US")}%` : "—"
}

function formatWeightDelta(delta: number) {
  if (!Number.isFinite(delta)) {
    return "—"
  }

  return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  })}`
}

function formatWholeDelta(delta: number) {
  if (!Number.isFinite(delta)) {
    return "—"
  }

  const truncated = Math.trunc(delta)
  return `${truncated > 0 ? "+" : ""}${truncated.toLocaleString("en-US")}`
}

function formatPercentDelta(delta: number) {
  if (!Number.isFinite(delta)) {
    return "—"
  }

  const roundedPercent = Math.round(delta * 100)
  return `${roundedPercent > 0 ? "+" : ""}${roundedPercent.toLocaleString("en-US")}%`
}

function getDeltaColor(delta: number | null) {
  if (delta === null || !Number.isFinite(delta) || delta === 0) {
    return "#56635a"
  }

  return delta > 0 ? "#1f6f43" : "#9b1c1c"
}

function getBenchmarkGameCount(playerCount: TrainingPlayerCount) {
  switch (playerCount) {
    case 1:
      return 20
    case 2:
      return 16
    case 3:
      return 12
    case 4:
      return 10
  }
}

async function fetchOptionalJson<T>(path: string) {
  const response = await fetch(path, {
    cache: "no-store",
  })

  if (!response.ok) {
    return null
  }

  return (await response.json()) as T
}

function buildMetricSeries(
  baselineValue: number,
  history: ScriptedBotTrainingHistoryEntry[],
  selector: (entry: ScriptedBotTrainingHistoryEntry) => number,
): MetricPoint[] {
  return [
    { label: "Baseline", value: baselineValue },
    ...history.map(entry => ({
      label: `Iter ${entry.iteration}`,
      value: selector(entry),
    })),
  ]
}

function buildAutotuneFallbackHistory(status: AutotuneStatus | null): AutotuneHistory | null {
  if (!status) {
    return null
  }

  const championPromotions = (["1p", "2p", "3p", "4p"] as const)
    .map(key => {
      const champion = status.champions?.[key]

      if (!champion) {
        return null
      }

      return {
        cycle: champion.cycle,
        playerCount: Number.parseInt(key, 10) as TrainingPlayerCount,
        benchmarkScore: champion.benchmark.score,
        generatedAt: champion.training.generatedAt,
        score: champion.training.final.score,
        winRate: champion.training.final.winRate,
        averagePassengers: champion.training.final.averagePassengers,
        averagePassengerMargin: champion.training.final.averagePassengerMargin,
        sampleCount: champion.training.final.sampleCount,
      }
    })
    .filter((promotion): promotion is AutotuneChampionPromotion => promotion !== null)

  return {
    version: 1,
    updatedAt: status.updatedAt,
    runs: [...status.recentRuns].sort((runA, runB) => runA.cycle - runB.cycle),
    championPromotions,
  }
}

function mergeAutotuneHistories(
  primary: AutotuneHistory | null,
  secondary: AutotuneHistory | null,
): AutotuneHistory | null {
  if (!primary && !secondary) {
    return null
  }

  const runs = [...(primary?.runs ?? []), ...(secondary?.runs ?? [])]
  const championPromotions = [...(primary?.championPromotions ?? []), ...(secondary?.championPromotions ?? [])]

  return {
    version: 1,
    updatedAt: primary?.updatedAt ?? secondary?.updatedAt ?? new Date().toISOString(),
    runs: Array.from(new Map(runs.map(run => [run.cycle, run] as const)).values()).sort(
      (runA, runB) => runA.cycle - runB.cycle,
    ),
    championPromotions: Array.from(
      new Map(
        championPromotions.map(promotion => [`${promotion.playerCount}-${promotion.cycle}`, promotion] as const),
      ).values(),
    ).sort((runA, runB) => runA.cycle - runB.cycle),
  }
}

function buildPolylinePoints(
  points: Array<{ cycle: number; value: number }>,
  width: number,
  height: number,
  padding: number | { top: number; right: number; bottom: number; left: number },
  windowStart: number,
  windowEnd: number,
  minValue: number,
  range: number,
) {
  const resolvedPadding =
    typeof padding === "number"
      ? { top: padding, right: padding, bottom: padding, left: padding }
      : padding
  const plotWidth = width - resolvedPadding.left - resolvedPadding.right
  const plotHeight = height - resolvedPadding.top - resolvedPadding.bottom
  return points
    .map(point => {
      const x =
        resolvedPadding.left +
        ((point.cycle - windowStart) / Math.max(windowEnd - windowStart, 1)) * plotWidth
      const y =
        height -
        resolvedPadding.bottom -
        ((point.value - minValue) / range) * plotHeight
      return `${x},${y}`
    })
    .join(" ")
}

function IterationProgressBar({
  label,
  progress,
  color,
  idPrefix,
}: {
  label: string
  progress: TrainingStatus["progress"] | AutotuneControlStatus["progress"]
  color: string
  idPrefix?: string
}) {
  if (!progress) {
    return null
  }

  const percent = Math.max(0, Math.min(100, (progress.currentIteration / Math.max(progress.totalIterations, 1)) * 100))

  return (
    <div
      id={idPrefix ? `${idPrefix}-root` : undefined}
      style={{
        borderRadius: 10,
        border: "1px solid #d8dfd5",
        background: "#f5f8f5",
        padding: 12,
        display: "grid",
        gap: 8,
        gridColumn: "1 / -1",
      }}
    >
      <div
        id={idPrefix ? `${idPrefix}-header` : undefined}
        style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}
      >
        <strong>{label}</strong>
        <span style={{ color: "#56635a", fontSize: 13 }}>
          Iteration {progress.currentIteration} / {progress.totalIterations}
        </span>
      </div>
      <div
        id={idPrefix ? `${idPrefix}-track` : undefined}
        style={{
          height: 12,
          borderRadius: 999,
          background: "#dbe5d8",
          overflow: "hidden",
        }}
      >
        <div
          id={idPrefix ? `${idPrefix}-fill` : undefined}
          style={{
            width: `${percent}%`,
            height: "100%",
            borderRadius: 999,
            background: color,
          }}
        />
      </div>
      <div
        id={idPrefix ? `${idPrefix}-summary` : undefined}
        style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 12 }}
      >
        <span style={{ color: "#56635a" }}>{Math.round(percent)}% complete</span>
        <span style={{ color: "#56635a" }}>
          {progress.bestScore === null ? "Waiting for first completed iteration" : `Best score ${formatMetric(progress.bestScore, 0)}`}
          {progress.temperature === null ? "" : ` • temp ${formatMetric(progress.temperature, 2)}`}
        </span>
      </div>
    </div>
  )
}

function CombinedAutotuneLearningChart({
  series,
  windowStart,
  windowEnd,
}: {
  series: Array<{
    playerCount: TrainingPlayerCount
    runPoints: Array<{ cycle: number; value: number }>
    promotionPoints: Array<{ cycle: number; value: number }>
    lastPromotionCycle: number | null
  }>
  windowStart: number
  windowEnd: number
}) {
  const width = 640
  const height = 240
  const chartPadding = {
    top: 18,
    right: 20,
    bottom: 34,
    left: 74,
  }
  const plotWidth = width - chartPadding.left - chartPadding.right
  const plotHeight = height - chartPadding.top - chartPadding.bottom
  const lineColors: Record<TrainingPlayerCount, string> = {
    1: "#7c3aed",
    2: "#24527a",
    3: "#2a7f3b",
    4: "#c05621",
  }
  const values = series.flatMap(entry => [...entry.runPoints, ...entry.promotionPoints].map(point => point.value))

  if (values.length === 0) {
    return (
      <div
        style={{
          border: "1px solid #d8dfd5",
          borderRadius: 12,
          background: "#ffffff",
          padding: 12,
          display: "grid",
          gap: 8,
        }}
      >
        <strong>Benchmark trend by player count</strong>
        <div style={{ color: "#56635a", minHeight: 120, display: "grid", placeItems: "center" }}>
          No completed cycles yet.
        </div>
      </div>
    )
  }

  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const roundedWindowMidpoint = Math.round(((windowStart + windowEnd) / 2) / 25) * 25
  const xTicks = Array.from(
    new Set([
      Math.ceil(windowStart / 25) * 25,
      roundedWindowMidpoint,
      Math.floor(windowEnd / 25) * 25,
    ].filter(tick => tick >= windowStart && tick <= windowEnd)),
  )
  const yAxisMin = Math.floor(minValue / 50) * 50
  const yAxisMax = Math.ceil(maxValue / 50) * 50
  const yAxisRange = Math.max(yAxisMax - yAxisMin, 50)
  const yTicks = Array.from(
    new Set([
      yAxisMax,
      Math.round(((yAxisMin + yAxisMax) / 2) / 50) * 50,
      yAxisMin,
    ]),
  ).sort((left, right) => right - left)

  return (
    <div
      style={{
        border: "1px solid #d8dfd5",
        borderRadius: 12,
        background: "#ffffff",
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <strong>Benchmark trend by player count</strong>
        <span style={{ color: "#56635a", fontSize: 12 }}>Benchmark score</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`}>
        {yTicks.map((tick, index) => {
          const y = height - chartPadding.bottom - ((tick - yAxisMin) / yAxisRange) * plotHeight
          return (
            <g key={`y-tick-${index}`}>
              <line
                x1={chartPadding.left}
                y1={y}
                x2={width - chartPadding.right}
                y2={y}
                stroke={index === yTicks.length - 1 ? "#d8dfd5" : "#e8ede7"}
                strokeDasharray={index === yTicks.length - 1 ? undefined : "4 4"}
              />
              <text
                x={chartPadding.left - 8}
                y={y + 4}
                fontSize="11"
                textAnchor="end"
                fill="#56635a"
              >
                {formatMetric(tick, 0)}
              </text>
            </g>
          )
        })}
        <line
          x1={chartPadding.left}
          y1={chartPadding.top}
          x2={chartPadding.left}
          y2={height - chartPadding.bottom}
          stroke="#d8dfd5"
        />
        {series.map(entry => {
          const color = lineColors[entry.playerCount]
          const runPolylinePoints = buildPolylinePoints(
            entry.runPoints,
            width,
            height,
            chartPadding,
            windowStart,
            windowEnd,
            yAxisMin,
            yAxisRange,
          )

          return (
            <g key={`series-${entry.playerCount}`}>
              {entry.runPoints.length >= 2 ? (
            <polyline fill="none" stroke={color} strokeWidth="2" points={runPolylinePoints} />
              ) : null}
              {entry.runPoints.map(point => {
                const x =
                  chartPadding.left +
                  ((point.cycle - windowStart) / Math.max(windowEnd - windowStart, 1)) * plotWidth
            const y = height - chartPadding.bottom - ((point.value - yAxisMin) / yAxisRange) * plotHeight
                return <circle key={`run-${entry.playerCount}-${point.cycle}`} cx={x} cy={y} r="3.5" fill={color} />
              })}
              {entry.promotionPoints.map(point => {
                const x =
                  chartPadding.left +
                  ((point.cycle - windowStart) / Math.max(windowEnd - windowStart, 1)) * plotWidth
            const y = height - chartPadding.bottom - ((point.value - yAxisMin) / yAxisRange) * plotHeight
                const isLatestPromotion = entry.lastPromotionCycle === point.cycle
                return (
                  <g key={`promotion-${entry.playerCount}-${point.cycle}`}>
                    {isLatestPromotion ? (
                      <circle
                        cx={x}
                        cy={y}
                        r="9"
                        fill="none"
                        stroke={color}
                    strokeWidth="2.5"
                        opacity="0.95"
                      />
                    ) : null}
                    <circle
                      cx={x}
                      cy={y}
                      r="5"
                      fill={color}
                      stroke="#ffffff"
                      strokeWidth="2"
                    />
                  </g>
                )
              })}
            </g>
          )
        })}
        {xTicks.map(tick => {
          const x =
            chartPadding.left + ((tick - windowStart) / Math.max(windowEnd - windowStart, 1)) * plotWidth
          return (
            <g key={tick}>
              <line x1={x} y1={height - chartPadding.bottom} x2={x} y2={height - chartPadding.bottom + 5} stroke="#d8dfd5" />
              <text x={x} y={height - 10} fontSize="11" textAnchor="middle" fill="#56635a">
                {tick}
              </text>
            </g>
          )
        })}
      </svg>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", color: "#56635a", fontSize: 12 }}>
        {series.map(entry => (
          <span key={`legend-${entry.playerCount}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: lineColors[entry.playerCount], display: "inline-block" }} />
            {entry.playerCount}p
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              border: "3px solid #ffffff",
              background: "#56635a",
              display: "inline-block",
              boxShadow: "0 0 0 1px #56635a",
            }}
          />
          Ringed dot = latest promotion
        </span>
      </div>
    </div>
  )
}

function LineChart({
  title,
  points,
  color,
  formatter = formatWholeNumber,
}: {
  title: string
  points: MetricPoint[]
  color: string
  formatter?: (value: number) => string
}) {
  const width = 360
  const height = 160
  const padding = 20
  const values = points.map(point => point.value)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const range = maxValue - minValue || 1
  const polylinePoints = points
    .map((point, index) => {
      const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2)
      const y = height - padding - ((point.value - minValue) / range) * (height - padding * 2)
      return `${x},${y}`
    })
    .join(" ")

  return (
    <div
      style={{
        border: "1px solid #d8dfd5",
        borderRadius: 12,
        background: "#ffffff",
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>{title}</strong>
        <span style={{ color: "#56635a", fontSize: 13 }}>
          {formatter(points[points.length - 1]?.value ?? 0)}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#d8dfd5" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#d8dfd5" />
        <polyline fill="none" stroke={color} strokeWidth="3" points={polylinePoints} />
        {points.map((point, index) => {
          const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2)
          const y = height - padding - ((point.value - minValue) / range) * (height - padding * 2)
          return (
            <g key={point.label}>
              <circle cx={x} cy={y} r="4" fill={color} />
              <text x={x} y={height - 4} fontSize="10" textAnchor="middle" fill="#56635a">
                {index === 0 ? "B" : index}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function formatImpactMetric(metric: LeverImpactMetricKey, value: number) {
  if (!Number.isFinite(value)) {
    return "—"
  }

  if (metric === "winRateDrop") {
    const roundedPercent = Math.round(value * 100)
    return `${roundedPercent > 0 ? "+" : ""}${roundedPercent.toLocaleString("en-US")}%`
  }

  return `${value > 0 ? "+" : ""}${Math.trunc(value).toLocaleString("en-US")}`
}

function buildLeverImpactRows(
  results: ScriptedBotTrainingResults | null,
  importance: ScriptedBotLeverImportanceResults | null,
) {
  if (!results) {
    return []
  }

  const importanceByKey = new Map(
    importance?.sourceTrainingGeneratedAt === results.generatedAt
      ? importance.rows.map(row => [row.key, row] as const)
      : [],
  )

  return Object.entries(results.final.weights)
    .map(([key, finalValue]) => {
      const baselineValue = results.baseline.weights[key as keyof typeof results.baseline.weights]
      const impact = importanceByKey.get(key as keyof typeof results.final.weights)
      return {
        key,
        baselineValue,
        finalValue,
        delta: finalValue - baselineValue,
        importanceRank: impact?.rank ?? null,
        passengerDrop: impact?.passengerDrop ?? null,
        scoreDrop: impact?.scoreDrop ?? null,
        winRateDrop: impact?.winRateDrop ?? null,
        ...(WEIGHT_LABELS[key] ?? {
          label: key,
          description: "No description yet.",
          group: "Other",
          lowExplanation: "Lower values make the bot less eager to act on this lever.",
          highExplanation: "Higher values make the bot lean harder into this lever.",
        }),
      }
    })
    .sort((rowA, rowB) =>
      (rowA.importanceRank ?? Number.POSITIVE_INFINITY) - (rowB.importanceRank ?? Number.POSITIVE_INFINITY) ||
      rowB.group.localeCompare(rowA.group) ||
      Math.abs(rowB.delta) - Math.abs(rowA.delta),
    )
}

function LeverImpactChart({
  rows,
  metric,
  onMetricChange,
  title = "Lever impact graph",
  showMetricSelector = true,
}: {
  rows: LeverImpactChartRow[]
  metric: LeverImpactMetricKey
  onMetricChange: (metric: LeverImpactMetricKey) => void
  title?: string
  showMetricSelector?: boolean
}) {
  const metricConfig = LEVER_IMPACT_METRICS[metric]
  const chartRows = rows
    .map(row => ({
      ...row,
      value: row[metric],
    }))
    .filter((row): row is LeverImpactChartRow & { value: number } => row.value !== null)
    .sort((rowA, rowB) => Math.abs(rowB.value) - Math.abs(rowA.value))

  const maxMagnitude = Math.max(
    1,
    ...chartRows.map(row => Math.abs(row.value)),
  )

  return (
    <div
      style={{
        border: "1px solid #d8dfd5",
        borderRadius: 12,
        background: "#ffffff",
        padding: 14,
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <strong>{title}</strong>
        <div style={{ color: "#56635a", lineHeight: 1.45 }}>
          {metricConfig.description} Green bars helped. Red bars mean the trained value is probably hurting that metric.
          The right-side explanation always shows the direction that helps the selected metric more.
        </div>
      </div>

      {showMetricSelector && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(Object.entries(LEVER_IMPACT_METRICS) as Array<
            [LeverImpactMetricKey, (typeof LEVER_IMPACT_METRICS)[LeverImpactMetricKey]]
          >).map(([nextMetric, config]) => (
            <button
              key={nextMetric}
              type="button"
              onClick={() => onMetricChange(nextMetric)}
              style={{
                borderRadius: 999,
                border: `1px solid ${metric === nextMetric ? "#223024" : "#c7d0c4"}`,
                background: metric === nextMetric ? "#223024" : "#ffffff",
                color: metric === nextMetric ? "#ffffff" : "#223024",
                padding: "8px 12px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {config.label}
            </button>
          ))}
        </div>
      )}

      {chartRows.length > 0 ? (
        <div style={{ display: "grid", gap: 8, maxHeight: 620, overflowY: "auto", paddingRight: 4 }}>
          {chartRows.map(row => {
            const barWidth = `${(Math.abs(row.value) / maxMagnitude) * 50}%`
            const isPositive = row.value >= 0
            const helpfulDirectionIsHigh = row.value === 0 ? row.delta >= 0 : row.delta * row.value >= 0
            const leftExplanation = helpfulDirectionIsHigh ? row.lowExplanation : row.highExplanation
            const rightExplanation = helpfulDirectionIsHigh ? row.highExplanation : row.lowExplanation
            return (
              <div
                key={row.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(180px, 220px) minmax(220px, 1fr) minmax(340px, 1.3fr) minmax(220px, 1fr) 88px",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <div style={{ display: "grid", gap: 2 }}>
                  <div style={{ fontWeight: 700 }}>{row.label}</div>
                  <div style={{ color: "#56635a", fontSize: 12 }}>
                    {row.group} • delta {formatWeightDelta(row.delta)}
                  </div>
                </div>
                <div
                  style={{
                    color: "#56635a",
                    fontSize: 12,
                    lineHeight: 1.35,
                    textAlign: "right",
                  }}
                >
                  {leftExplanation}
                </div>
                <div
                  style={{
                    position: "relative",
                    height: 22,
                    borderRadius: 999,
                    background: "#f3f6f3",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      inset: "0 auto 0 50%",
                      width: 1,
                      background: "#bcc8bc",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: 3,
                      bottom: 3,
                      left: isPositive ? "50%" : `calc(50% - ${barWidth})`,
                      width: barWidth,
                      borderRadius: 999,
                      background: isPositive ? "#2a7f3b" : "#b63b3b",
                    }}
                  />
                </div>
                <div
                  style={{
                    color: "#56635a",
                    fontSize: 12,
                    lineHeight: 1.35,
                  }}
                >
                  {rightExplanation}
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 700,
                    color: isPositive ? "#2a7f3b" : "#9b1c1c",
                  }}
                >
                  {formatImpactMetric(metric, row.value)}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ color: "#56635a" }}>Run lever importance analysis to populate the graph.</div>
      )}
    </div>
  )
}

function LeverImpactComparisonChart({
  rows,
  title,
}: {
  rows: LeverImpactChartRow[]
  title: string
}) {
  const metrics = Object.entries(LEVER_IMPACT_METRICS) as Array<
    [LeverImpactMetricKey, (typeof LEVER_IMPACT_METRICS)[LeverImpactMetricKey]]
  >
  const metricColors: Record<LeverImpactMetricKey, string> = {
    passengerDrop: "#2a7f3b",
    scoreDrop: "#1d5d76",
    winRateDrop: "#8a5a00",
  }
  const chartRows = rows
    .filter(row => metrics.some(([metric]) => row[metric] !== null))
    .sort(
      (rowA, rowB) =>
        Math.abs(rowB.passengerDrop ?? 0) - Math.abs(rowA.passengerDrop ?? 0) ||
        (rowB.passengerDrop ?? Number.NEGATIVE_INFINITY) - (rowA.passengerDrop ?? Number.NEGATIVE_INFINITY),
    )
  const maxMagnitudeByMetric = Object.fromEntries(
    metrics.map(([metric]) => [
      metric,
      Math.max(
        1,
        ...chartRows.map(row => Math.abs(row[metric] ?? 0)),
      ),
    ]),
  ) as Record<LeverImpactMetricKey, number>

  return (
    <div
      style={{
        border: "1px solid #d8dfd5",
        borderRadius: 12,
        background: "#ffffff",
        padding: 14,
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <strong>{title}</strong>
        <div style={{ color: "#56635a", lineHeight: 1.45 }}>
          Each row shows how that saved bot’s trained value affects passengers, score, and win rate. Green bars help;
          bars extending left of center hurt.
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", color: "#56635a", fontSize: 12 }}>
        {metrics.map(([metric, config]) => (
          <div key={metric} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: metricColors[metric],
                display: "inline-block",
              }}
            />
            <span>{config.label}</span>
          </div>
        ))}
      </div>

      {chartRows.length > 0 ? (
        <div style={{ display: "grid", gap: 8, maxHeight: 620, overflowY: "auto", paddingRight: 4 }}>
          {chartRows.map(row => (
            (() => {
              const explanationValue = row.passengerDrop ?? 0
              const helpfulDirectionIsHigh =
                explanationValue === 0 ? row.delta >= 0 : row.delta * explanationValue >= 0
              const leftExplanation = helpfulDirectionIsHigh ? row.lowExplanation : row.highExplanation
              const rightExplanation = helpfulDirectionIsHigh ? row.highExplanation : row.lowExplanation

              return (
                <div
                  key={row.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(180px, 220px) minmax(220px, 1fr) minmax(360px, 1.2fr) minmax(220px, 1fr) 240px",
                    gap: 12,
                    alignItems: "center",
                    padding: "6px 0",
                  }}
                >
                  <div style={{ display: "grid", gap: 2 }}>
                    <div style={{ fontWeight: 700 }}>{row.label}</div>
                    <div style={{ color: "#56635a", fontSize: 12, lineHeight: 1.35 }}>{row.description}</div>
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      {row.group} • delta {formatWeightDelta(row.delta)}
                    </div>
                  </div>

                  <div
                    style={{
                      color: "#56635a",
                      fontSize: 12,
                      lineHeight: 1.35,
                      textAlign: "right",
                    }}
                  >
                    {leftExplanation}
                  </div>

                  <div
                    style={{
                      position: "relative",
                      height: 48,
                      borderRadius: 12,
                      background: "#f3f6f3",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        inset: "0 auto 0 50%",
                        width: 1,
                        background: "#bcc8bc",
                      }}
                    />
                    {metrics.map(([metric], index) => {
                      const value = row[metric]
                      if (value === null) {
                        return null
                      }

                      const barWidth = `${(Math.abs(value) / maxMagnitudeByMetric[metric]) * 50}%`
                      const isPositive = value >= 0

                      return (
                        <div
                          key={metric}
                          style={{
                            position: "absolute",
                            top: 7 + index * 13,
                            height: 10,
                            left: isPositive ? "50%" : `calc(50% - ${barWidth})`,
                            width: barWidth,
                            borderRadius: 999,
                            background: metricColors[metric],
                            opacity: isPositive ? 1 : 0.55,
                          }}
                        />
                      )
                    })}
                  </div>

                  <div
                    style={{
                      color: "#56635a",
                      fontSize: 12,
                      lineHeight: 1.35,
                    }}
                  >
                    {rightExplanation}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: 8,
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {metrics.map(([metric, config]) => {
                      const value = row[metric]
                      return (
                        <div key={metric} style={{ display: "grid", gap: 2 }}>
                          <div style={{ color: "#56635a" }}>{config.label}</div>
                          <div
                            style={{
                              fontWeight: 700,
                              color: value === null ? "#56635a" : value >= 0 ? metricColors[metric] : "#9b1c1c",
                            }}
                          >
                            {value === null ? "—" : formatImpactMetric(metric, value)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()
          ))}
        </div>
      ) : (
        <div style={{ color: "#56635a" }}>Run lever importance analysis to populate the graph.</div>
      )}
    </div>
  )
}

export default function TrainingApp() {
  const defaultServerUrl = getDefaultSessionServerUrl()
  const [results, setResults] = useState<ScriptedBotTrainingResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null)
  const [autotuneControlStatus, setAutotuneControlStatus] = useState<AutotuneControlStatus | null>(null)
  const [trainingPresets, setTrainingPresets] = useState<TrainingPresetStatus | null>(null)
  const [trainingImportance, setTrainingImportance] = useState<TrainingImportanceStatus | null>(null)
  const [modeComparisons, setModeComparisons] = useState<ModeComparisonEntry[]>([])
  const [autotuneStatus, setAutotuneStatus] = useState<AutotuneStatus | null>(null)
  const [autotuneHistory, setAutotuneHistory] = useState<AutotuneHistory | null>(null)
  const [trainingRequest, setTrainingRequest] = useState<TrainingStartRequest>({
    iterations: 10,
    gamesPerCandidate: 8,
    playerCount: 4,
    baseSeed: 1,
    candidatesPerIteration: 6,
    mutationSeed: 1,
    maxSteps: 2000,
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [promotingAutotuneRunKey, setPromotingAutotuneRunKey] = useState<string | null>(null)
  const importanceRequestedForRunRef = useRef<string | null>(null)
  const [selectedImpactMetric, setSelectedImpactMetric] = useState<LeverImpactMetricKey>("passengerDrop")
  const [selectedModeImpactPlayerCount, setSelectedModeImpactPlayerCount] = useState<TrainingPlayerCount>(4)

  useEffect(() => {
    let cancelled = false

    async function reloadData() {
      const tick = `${Date.now()}-${refreshNonce}`
      const [
        resultsResponse,
        statusResponse,
        autotuneControlResponse,
        presetsResponse,
        importanceResponse,
        autotuneResponse,
        autotuneHistoryResponse,
        comparisonsResponse,
      ] = await Promise.allSettled([
        fetch(`/training-results/latest.json?tick=${tick}`, {
          cache: "no-store",
        }),
        fetchTrainingStatus(defaultServerUrl),
        fetchAutotuneStatus(defaultServerUrl),
        fetchTrainingPresets(defaultServerUrl),
        fetchTrainingImportance(defaultServerUrl),
        fetchOptionalJson<AutotuneStatus>(`/training-results/autotune-status.json?tick=${tick}`),
        fetchOptionalJson<AutotuneHistory>(`/training-results/autotune-history.json?tick=${tick}`),
        Promise.all(
          TRAINING_PLAYER_COUNT_OPTIONS.map(async playerCount => ({
            playerCount,
            results: await fetchOptionalJson<ScriptedBotTrainingResults>(
              `/training-results/latest-${playerCount}p.json?tick=${tick}`,
            ),
            importance: await fetchOptionalJson<ScriptedBotLeverImportanceResults>(
              `/training-results/latest-${playerCount}p-importance.json?tick=${tick}`,
            ),
          })),
        ),
      ])

      if (cancelled) {
        return
      }

      if (statusResponse.status === "fulfilled") {
        setTrainingStatus(statusResponse.value)
      } else {
        setError(statusResponse.reason instanceof Error ? statusResponse.reason.message : "Could not reach the training endpoint.")
      }

      if (autotuneControlResponse.status === "fulfilled") {
        setAutotuneControlStatus(autotuneControlResponse.value)
      }

      if (presetsResponse.status === "fulfilled") {
        setTrainingPresets(presetsResponse.value)
      }

      if (importanceResponse.status === "fulfilled") {
        setTrainingImportance(importanceResponse.value)
      }

      if (autotuneResponse.status === "fulfilled") {
        setAutotuneStatus(autotuneResponse.value)
      }

      if (autotuneHistoryResponse.status === "fulfilled") {
        setAutotuneHistory(autotuneHistoryResponse.value)
      }

      if (comparisonsResponse.status === "fulfilled") {
        setModeComparisons(
          comparisonsResponse.value.map(entry => ({
            playerCount: entry.playerCount,
            results:
              entry.results?.config.playerCount === entry.playerCount
                ? entry.results
                : null,
            importance:
              entry.results &&
              entry.results.config.playerCount === entry.playerCount &&
              entry.importance?.sourceTrainingGeneratedAt === entry.results.generatedAt
                ? entry.importance
                : null,
          })),
        )
      }

      if (resultsResponse.status === "fulfilled") {
        if (resultsResponse.value.ok) {
          const nextResults = (await resultsResponse.value.json()) as ScriptedBotTrainingResults
          if (!cancelled) {
            setResults(nextResults)
            if (statusResponse.status === "fulfilled") {
              setError(null)
            }
          }
          return
        }
      }

      if (statusResponse.status === "fulfilled") {
        setError("No training results yet. Start a run below or use `npm run train:bots`.")
      }
    }

    void reloadData()
    const intervalId = window.setInterval(() => {
      void reloadData()
    }, REFRESH_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [defaultServerUrl, refreshNonce])

  useEffect(() => {
    if (!results) {
      return
    }

    if (trainingStatus?.isRunning) {
      return
    }

    if (trainingImportance?.isRunning) {
      return
    }

    if (trainingImportance?.result?.sourceTrainingGeneratedAt === results.generatedAt) {
      return
    }

    if (importanceRequestedForRunRef.current === results.generatedAt) {
      return
    }

    const targetRun = results.generatedAt
    importanceRequestedForRunRef.current = targetRun
    void startTrainingImportance(defaultServerUrl)
      .then(nextImportance => {
        if (importanceRequestedForRunRef.current === targetRun) {
          importanceRequestedForRunRef.current = null
        }
        setTrainingImportance(nextImportance)
        setError(null)
      })
      .catch(error => {
        window.setTimeout(() => {
          if (importanceRequestedForRunRef.current === targetRun) {
            importanceRequestedForRunRef.current = null
          }
        }, REFRESH_MS)
        setError(
          error instanceof Error
            ? error.message
            : "Could not start lever importance analysis.",
        )
      })
  }, [defaultServerUrl, results, trainingImportance, trainingStatus?.isRunning])

  async function handleStartTraining() {
    setIsSubmitting(true)
    try {
      const nextStatus = await startTraining(defaultServerUrl, trainingRequest)
      setTrainingStatus(nextStatus)
      setError(null)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start training.")
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleCancelTraining() {
    setIsSubmitting(true)
    try {
      const nextStatus = await cancelTraining(defaultServerUrl)
      setTrainingStatus(nextStatus)
      setError(null)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Could not cancel training.")
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleStartAutotune() {
    setIsSubmitting(true)
    try {
      const nextStatus = await startAutotune(defaultServerUrl)
      setAutotuneControlStatus(nextStatus)
      setError(null)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start autotune.")
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleStopAutotune() {
    setIsSubmitting(true)
    try {
      const nextStatus = await stopAutotune(defaultServerUrl)
      setAutotuneControlStatus(nextStatus)
      setError(null)
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Could not stop autotune.")
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleForceStopAutotune() {
    setIsSubmitting(true)
    try {
      const nextStatus = await forceStopAutotune(defaultServerUrl)
      setAutotuneControlStatus(nextStatus)
      setRefreshNonce(current => current + 1)
      setError(null)
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Could not force stop autotune.")
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handlePromoteAutotuneRun(target: { playerCount: number; generatedAt: string }) {
    const promotionKey = `${target.playerCount}-${target.generatedAt}`
    setPromotingAutotuneRunKey(promotionKey)

    try {
      const nextPresets = await promoteAutotuneRunToStickbug(defaultServerUrl, {
        playerCount: target.playerCount,
        generatedAt: target.generatedAt,
      })
      setTrainingPresets(nextPresets)
      setRefreshNonce(current => current + 1)
      setError(null)
    } catch (promotionError) {
      setError(promotionError instanceof Error ? promotionError.message : "Could not promote that autotune run into Stickbug.")
    } finally {
      setPromotingAutotuneRunKey(current => (current === promotionKey ? null : current))
    }
  }

  function handleTrainingRequestChange(
    field: keyof TrainingStartRequest,
    value: number,
  ) {
    setTrainingRequest(current => ({
      ...current,
      [field]: value,
    }))
  }

  const scoreSeries = useMemo(
    () =>
      results
        ? buildMetricSeries(results.baseline.score, results.history, entry => entry.best.score)
        : [],
    [results],
  )
  const passengerSeries = useMemo(
    () =>
      results
        ? buildMetricSeries(
            results.baseline.averagePassengers,
            results.history,
            entry => entry.best.averagePassengers,
          )
        : [],
    [results],
  )
  const passengerMarginSeries = useMemo(
    () =>
      results
        ? buildMetricSeries(
            results.baseline.averagePassengerMargin,
            results.history,
            entry => entry.best.averagePassengerMargin,
          )
        : [],
    [results],
  )
  const winRateSeries = useMemo(
    () =>
      results
        ? buildMetricSeries(results.baseline.winRate, results.history, entry => entry.best.winRate)
        : [],
    [results],
  )
  const timeoutSeries = useMemo(
    () =>
      results
        ? buildMetricSeries(
            results.baseline.timeoutRate,
            results.history,
            entry => entry.best.timeoutRate,
          )
        : [],
    [results],
  )
  const weightRows = useMemo(() => {
    const currentImportance =
      trainingImportance?.result && trainingImportance.result.sourceTrainingGeneratedAt === results?.generatedAt
        ? trainingImportance.result
        : null

    return buildLeverImpactRows(
      results,
      currentImportance,
    )
  }, [results, trainingImportance])
  const selectedModeComparison = useMemo(
    () =>
      modeComparisons.find(entry => entry.playerCount === selectedModeImpactPlayerCount) ?? {
        playerCount: selectedModeImpactPlayerCount,
        results: null,
        importance: null,
      },
    [modeComparisons, selectedModeImpactPlayerCount],
  )
  const selectedModeImpactRows = useMemo(
    () => buildLeverImpactRows(selectedModeComparison.results, selectedModeComparison.importance),
    [selectedModeComparison],
  )
  const effectiveAutotuneHistory = useMemo(
    () => mergeAutotuneHistories(autotuneHistory, buildAutotuneFallbackHistory(autotuneStatus)),
    [autotuneHistory, autotuneStatus],
  )
  const currentAutotuneCycle = useMemo(() => {
    const historyCycle = Math.max(
      0,
      ...(effectiveAutotuneHistory?.runs.map(run => run.cycle) ?? []),
      ...(effectiveAutotuneHistory?.championPromotions.map(run => run.cycle) ?? []),
    )

    return Math.max(autotuneStatus?.cycle ?? 0, historyCycle)
  }, [autotuneStatus, effectiveAutotuneHistory])
  const learningWindowStart = Math.max(1, currentAutotuneCycle - 99)
  const autotuneLearningRows = useMemo(
    () =>
      TRAINING_PLAYER_COUNT_OPTIONS.map(playerCount => {
        const runPoints = (effectiveAutotuneHistory?.runs ?? [])
          .filter(
            run =>
              run.playerCount === playerCount &&
              !run.startedFromScratch &&
              run.cycle >= learningWindowStart &&
              run.cycle <= currentAutotuneCycle,
          )
          .sort((runA, runB) => runA.cycle - runB.cycle)
          .map(run => ({
            cycle: run.cycle,
            value: run.benchmarkScore,
          }))
        const promotionPoints = (effectiveAutotuneHistory?.championPromotions ?? [])
          .filter(
            promotion =>
              promotion.playerCount === playerCount &&
              promotion.cycle >= learningWindowStart &&
              promotion.cycle <= currentAutotuneCycle,
          )
          .sort((runA, runB) => runA.cycle - runB.cycle)
          .map(promotion => ({
            cycle: promotion.cycle,
            value: promotion.benchmarkScore,
          }))
        const lastPromotion = (effectiveAutotuneHistory?.championPromotions ?? [])
          .filter(promotion => promotion.playerCount === playerCount)
          .sort((runA, runB) => runB.cycle - runA.cycle)[0] ?? null

        return {
          playerCount,
          runPoints,
          promotionPoints,
          lastPromotion,
          promotionAge: lastPromotion ? Math.max(0, currentAutotuneCycle - lastPromotion.cycle) : null,
        }
      }),
    [currentAutotuneCycle, effectiveAutotuneHistory, learningWindowStart],
  )
  const profitableCityLinks = useMemo(() => buildEstimatedCityLinkProfitabilityRows(20), [])
  const managedAveragePreset = trainingPresets?.presets["bot-avg"] ?? null
  const managedStickbugPresets = ([2, 3, 4] as const).map(playerCount => ({
    playerCount,
    preset: trainingPresets?.presets[`bot-best-${playerCount}p`] ?? null,
  }))
  const currentChampionEntries = useMemo(
    () =>
      TRAINING_PLAYER_COUNT_OPTIONS.map(playerCount => {
        const champion = autotuneStatus?.champions?.[`${playerCount}p`]
        return champion ? { playerCount, champion } : null
      }).filter(
        (
          entry,
        ): entry is {
          playerCount: TrainingPlayerCount
          champion: NonNullable<NonNullable<AutotuneStatus["champions"]>[`${TrainingPlayerCount}p`]>
        } => entry !== null,
      ),
    [autotuneStatus],
  )
  const displayedAutotuneRuns = useMemo(
    () => [...(autotuneStatus?.recentRuns ?? [])].sort((runA, runB) => runB.cycle - runA.cycle),
    [autotuneStatus],
  )
  const previousChampionBenchmarkByPlayerCount = useMemo(() => {
    return new Map<TrainingPlayerCount, ScriptedBotWeightEvaluationSummary | null>(
      currentChampionEntries.map(entry => {
        const previousChampion = (effectiveAutotuneHistory?.championPromotions ?? [])
          .filter(promotion => promotion.playerCount === entry.playerCount && promotion.cycle < entry.champion.cycle)
          .sort((runA, runB) => runB.cycle - runA.cycle)[0]

        if (!previousChampion) {
          return [entry.playerCount, null] as const
        }

        const previousChampionRun = (effectiveAutotuneHistory?.runs ?? []).find(
          run => run.playerCount === entry.playerCount && run.generatedAt === previousChampion.generatedAt,
        )

        if (!previousChampionRun) {
          return [entry.playerCount, null] as const
        }

        const benchmark = summarizeScriptedBotWeightEvaluation(
          evaluateScriptedBotWeights({
            seeds: createTrainingSeeds(9000 + entry.playerCount * 100, getBenchmarkGameCount(entry.playerCount)),
            candidateWeights: previousChampionRun.final.weights,
            playerCount: entry.playerCount,
            maxSteps: 2500,
          }),
        )

        return [entry.playerCount, benchmark] as const
      }),
    )
  }, [currentChampionEntries, effectiveAutotuneHistory])
  const hasCurrentImportance =
    trainingImportance?.result?.sourceTrainingGeneratedAt === results?.generatedAt
  const canStartAutotune =
    !trainingStatus?.isRunning &&
    !autotuneControlStatus?.isRunning &&
    autotuneControlStatus?.status !== "stopping" &&
    autotuneControlStatus?.status !== "unknown" &&
    !isSubmitting
  const canStopAutotune =
    !!autotuneControlStatus?.isRunning && autotuneControlStatus?.status !== "stopping" && !isSubmitting

  function renderAutotuneRunCard(
    run: AutotuneRunRecord,
    options?: {
      title?: string
      statusLabel?: string
      showPromotionAction?: boolean
    },
  ) {
    const canPromoteStickbug = run.playerCount === 2 || run.playerCount === 3 || run.playerCount === 4
    const isPromotingThisRun = promotingAutotuneRunKey === `${run.playerCount}-${run.generatedAt}`
    const previousChampion = (effectiveAutotuneHistory?.championPromotions ?? [])
      .filter(promotion => promotion.playerCount === run.playerCount && promotion.cycle < run.cycle)
      .sort((runA, runB) => runB.cycle - runA.cycle)[0] ?? null
    const promotedStickbugVariant = canPromoteStickbug
      ? run.playerCount === 2
        ? trainingPresets?.presets["bot-best-2p"]
        : run.playerCount === 3
          ? trainingPresets?.presets["bot-best-3p"]
          : trainingPresets?.presets["bot-best-4p"]
      : null
    const isAlreadyPromoted = promotedStickbugVariant?.sourceTrainingGeneratedAt === run.generatedAt
    const passengerDelta = previousChampion ? run.final.averagePassengers - previousChampion.averagePassengers : null
    const leadDelta = previousChampion ? run.final.averagePassengerMargin - previousChampion.averagePassengerMargin : null
    const winRateDelta = previousChampion ? run.final.winRate - previousChampion.winRate : null
    const scoreDelta = previousChampion ? run.final.score - previousChampion.score : null
    const benchmarkDelta = previousChampion ? run.benchmarkScore - previousChampion.benchmarkScore : null

    return (
      <div
        key={`autotune-run-${run.playerCount}-${run.generatedAt}`}
        style={{
          border: "1px solid #d8dfd5",
          borderRadius: 10,
          background: "#fbfcfb",
          padding: 10,
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <strong>{options?.title ?? `Cycle ${run.cycle} • ${run.playerCount}-player • ${run.profile}`}</strong>
          <span style={{ fontWeight: 700, color: run.promoted ? "#2a7f3b" : "#56635a" }}>
            {options?.statusLabel ?? (run.promoted ? "Champion improved" : "No promotion")}
          </span>
        </div>
        <div style={{ color: "#56635a", fontSize: 13 }}>
          {run.startedFromScratch ? "Started from scratch" : "Warm-started from champion"} • opponents: {run.opponent}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: 8,
            fontSize: 13,
          }}
        >
          <div>
            Passengers: <strong>{formatWholeNumber(run.final.averagePassengers)}</strong>
            {passengerDelta !== null ? (
              <span style={{ color: getDeltaColor(passengerDelta), fontSize: 12 }}>
                {" "}({formatWholeDelta(passengerDelta)})
              </span>
            ) : null}
          </div>
          <div>
            Lead: <strong>{formatWholeDelta(run.final.averagePassengerMargin)}</strong>
            {leadDelta !== null ? (
              <span style={{ color: getDeltaColor(leadDelta), fontSize: 12 }}>
                {" "}({formatWholeDelta(leadDelta)})
              </span>
            ) : null}
          </div>
          <div>
            Win rate: <strong>{formatPercent(run.final.winRate)}</strong>
            {winRateDelta !== null ? (
              <span style={{ color: getDeltaColor(winRateDelta), fontSize: 12 }}>
                {" "}({formatPercentDelta(winRateDelta)})
              </span>
            ) : null}
          </div>
          <div>
            Score: <strong>{formatWholeNumber(run.final.score)}</strong>
            {scoreDelta !== null ? (
              <span style={{ color: getDeltaColor(scoreDelta), fontSize: 12 }}>
                {" "}({formatWholeDelta(scoreDelta)})
              </span>
            ) : null}
          </div>
          <div>
            Benchmark: <strong>{formatWholeNumber(run.benchmarkScore)}</strong>
            {benchmarkDelta !== null ? (
              <span style={{ color: getDeltaColor(benchmarkDelta), fontSize: 12 }}>
                {" "}({formatWholeDelta(benchmarkDelta)})
              </span>
            ) : null}
          </div>
        </div>
        {options?.showPromotionAction && canPromoteStickbug ? (
          <div>
            <button
              type="button"
              onClick={() => void handlePromoteAutotuneRun({ playerCount: run.playerCount, generatedAt: run.generatedAt })}
              disabled={isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey}
              style={{
                borderRadius: 999,
                border: "1px solid #24527a",
                background: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "#d9e3ee" : "#24527a",
                color: "#ffffff",
                padding: "8px 14px",
                fontWeight: 700,
                cursor: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "not-allowed" : "pointer",
              }}
            >
              {isAlreadyPromoted ? "Promoted" : isPromotingThisRun ? "Promoting…" : "Promote Stickbug"}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  function renderChampionCard(entry: {
    playerCount: TrainingPlayerCount
    champion: NonNullable<NonNullable<AutotuneStatus["champions"]>[`${TrainingPlayerCount}p`]>
  }) {
    const canPromoteStickbug = entry.playerCount === 2 || entry.playerCount === 3 || entry.playerCount === 4
    const generatedAt = entry.champion.training.generatedAt
    const isPromotingThisRun = promotingAutotuneRunKey === `${entry.playerCount}-${generatedAt}`
    const promotedStickbugVariant = canPromoteStickbug
      ? entry.playerCount === 2
        ? trainingPresets?.presets["bot-best-2p"]
        : entry.playerCount === 3
          ? trainingPresets?.presets["bot-best-3p"]
          : trainingPresets?.presets["bot-best-4p"]
      : null
    const isAlreadyPromoted = promotedStickbugVariant?.sourceTrainingGeneratedAt === generatedAt
    const previousChampionBenchmark = previousChampionBenchmarkByPlayerCount.get(entry.playerCount) ?? null
    const passengerDelta = previousChampionBenchmark
      ? entry.champion.benchmark.averagePassengers - previousChampionBenchmark.averagePassengers
      : null
    const leadDelta = previousChampionBenchmark
      ? entry.champion.benchmark.averagePassengerMargin - previousChampionBenchmark.averagePassengerMargin
      : null
    const winRateDelta = previousChampionBenchmark
      ? entry.champion.benchmark.winRate - previousChampionBenchmark.winRate
      : null
    const scoreDelta = previousChampionBenchmark ? entry.champion.benchmark.score - previousChampionBenchmark.score : null

    return (
      <div
        key={`champion-${entry.playerCount}-${generatedAt}`}
        style={{
          border: "1px solid #d8dfd5",
          borderRadius: 10,
          background: "#fbfcfb",
          padding: 10,
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <strong>{`Current champion • ${entry.playerCount}-player`}</strong>
          <span style={{ fontWeight: 700, color: "#2a7f3b" }}>Current champion</span>
        </div>
        <div style={{ color: "#56635a", fontSize: 13 }}>
          Benchmark evaluation against the default bot on the fixed champion test set.
        </div>
        <div style={{ color: "#56635a", fontSize: 13 }}>
          Trained on cycle <strong>{entry.champion.cycle}</strong>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: 8,
            fontSize: 13,
          }}
        >
          <div>
            Passengers: <strong>{formatWholeNumber(entry.champion.benchmark.averagePassengers)}</strong>
            {passengerDelta !== null ? (
              <span style={{ color: getDeltaColor(passengerDelta), fontSize: 12 }}>
                {" "}({formatWholeDelta(passengerDelta)})
              </span>
            ) : null}
          </div>
          <div>
            Lead: <strong>{formatWholeDelta(entry.champion.benchmark.averagePassengerMargin)}</strong>
            {leadDelta !== null ? (
              <span style={{ color: getDeltaColor(leadDelta), fontSize: 12 }}>
                {" "}({formatWholeDelta(leadDelta)})
              </span>
            ) : null}
          </div>
          <div>
            Win rate: <strong>{formatPercent(entry.champion.benchmark.winRate)}</strong>
            {winRateDelta !== null ? (
              <span style={{ color: getDeltaColor(winRateDelta), fontSize: 12 }}>
                {" "}({formatPercentDelta(winRateDelta)})
              </span>
            ) : null}
          </div>
          <div>
            Benchmark score: <strong>{formatWholeNumber(entry.champion.benchmark.score)}</strong>
            {scoreDelta !== null ? (
              <span style={{ color: getDeltaColor(scoreDelta), fontSize: 12 }}>
                {" "}({formatWholeDelta(scoreDelta)})
              </span>
            ) : null}
          </div>
          <div>Samples: <strong>{formatWholeNumber(entry.champion.benchmark.sampleCount)}</strong></div>
        </div>
        {canPromoteStickbug ? (
          <div>
            <button
              type="button"
              onClick={() => void handlePromoteAutotuneRun({ playerCount: entry.playerCount, generatedAt })}
              disabled={isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey}
              style={{
                borderRadius: 999,
                border: "1px solid #24527a",
                background: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "#d9e3ee" : "#24527a",
                color: "#ffffff",
                padding: "8px 14px",
                fontWeight: 700,
                cursor: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "not-allowed" : "pointer",
              }}
            >
              {isAlreadyPromoted ? "Promoted" : isPromotingThisRun ? "Promoting…" : "Promote Stickbug"}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      id="training-app-root"
      style={{
        minHeight: "100%",
        background: "#edf2ec",
        color: "#223024",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        id="training-dashboard-content"
        style={{
          maxWidth: 1320,
          margin: "0 auto",
          padding: 24,
          display: "grid",
          gap: 16,
        }}
      >
        <div
          id="training-dashboard-header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "start",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "grid", gap: 6 }}>
            <h1 style={{ margin: 0, fontSize: 28 }}>Bot training dashboard</h1>
            <div style={{ color: "#56635a", maxWidth: 820, lineHeight: 1.45 }}>
              Full-game self-play tunes the scripted bot’s weights. Early game emphasizes expansion,
              middle game balances growth and efficiency, and late game shifts toward passenger-heavy city links
              and ending Operations sooner. The main goal is building a bigger passenger lead than the strongest opponent,
              not just maximizing the bot’s own raw passenger total.
            </div>
          </div>
          <div
            id="training-dashboard-header-actions"
            style={{ display: "grid", gap: 8, justifyItems: "end", minWidth: "min(100%, 320px)" }}
          >
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setRefreshNonce(current => current + 1)}
                style={{
                  borderRadius: 999,
                  border: "1px solid #223024",
                  background: "#223024",
                  color: "#ffffff",
                  padding: "10px 16px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Refresh now
              </button>
              <a
                href="/"
                style={{
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                  color: "#223024",
                  padding: "10px 16px",
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                Back to game
              </a>
            </div>
            <details
              id="manual-training-dropdown"
              open={trainingStatus?.isRunning ? true : undefined}
              style={{
                width: "min(100%, 320px)",
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 12,
                background: "#ffffff",
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  fontWeight: 700,
                  color: "#223024",
                  listStylePosition: "inside",
                }}
              >
                Manual training
              </summary>
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  marginTop: 12,
                }}
              >
                <div style={{ color: "#56635a", lineHeight: 1.45, fontSize: 13 }}>
                  This page talks to the local session server at <code>{defaultServerUrl}</code>. Manual runs write{" "}
                  <code>public/training-results/latest.json</code>.
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 10,
                  }}
                >
                  {([
                    ["iterations", "Iterations"],
                    ["gamesPerCandidate", "Games / candidate"],
                    ["playerCount", "Players / game"],
                    ["baseSeed", "Base seed"],
                    ["candidatesPerIteration", "Candidates / iteration"],
                    ["mutationSeed", "Mutation seed"],
                    ["maxSteps", "Max steps"],
                  ] as const).map(([field, label]) => (
                    <label key={field} style={{ display: "grid", gap: 4, fontSize: 13, color: "#56635a" }}>
                      <span>{label}</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={trainingRequest[field]}
                        onChange={event =>
                          handleTrainingRequestChange(
                            field,
                            field === "playerCount"
                              ? Math.min(4, Math.max(1, Number(event.target.value) || 4))
                              : Math.max(1, Number(event.target.value) || 1),
                          )
                        }
                        disabled={trainingStatus?.isRunning || autotuneControlStatus?.isRunning || isSubmitting}
                        style={{
                          borderRadius: 8,
                          border: "1px solid #c7d0c4",
                          padding: "9px 10px",
                          fontSize: 14,
                          color: "#223024",
                        }}
                      />
                    </label>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={handleStartTraining}
                    disabled={trainingStatus?.isRunning || autotuneControlStatus?.isRunning || isSubmitting}
                    style={{
                      borderRadius: 999,
                      border: "1px solid #223024",
                      background: trainingStatus?.isRunning || autotuneControlStatus?.isRunning ? "#c7d0c4" : "#223024",
                      color: "#ffffff",
                      padding: "10px 16px",
                      fontWeight: 700,
                      cursor: trainingStatus?.isRunning || autotuneControlStatus?.isRunning ? "not-allowed" : "pointer",
                    }}
                  >
                    Start training
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelTraining}
                    disabled={!trainingStatus?.isRunning || isSubmitting}
                    style={{
                      borderRadius: 999,
                      border: "1px solid #c97a7a",
                      background: trainingStatus?.isRunning ? "#fff4f4" : "#f8faf8",
                      color: "#8a1f1f",
                      padding: "10px 16px",
                      fontWeight: 700,
                      cursor: trainingStatus?.isRunning ? "pointer" : "not-allowed",
                    }}
                  >
                    Cancel training
                  </button>
                </div>
              </div>
            </details>
          </div>
        </div>

        <div
          id="training-dashboard-top-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: 12,
          }}
        >
          <div
            id="autotune-learning-div"
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 12,
              background: "#ffffff",
              padding: 14,
              display: "grid",
              gap: 12,
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <strong>Autotune learning over time</strong>
              <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                Last 100 global cycles ({learningWindowStart}-{Math.max(currentAutotuneCycle, learningWindowStart)}).
                Scratch restarts are excluded from the blue trend so the chart focuses on learned warm-start candidates;
                green markers show champion promotions.
              </div>
            </div>

            <div
              id="autotune-learning-summary-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 12,
              }}
            >
              {canStartAutotune ? (
                <button
                  type="button"
                  onClick={handleStartAutotune}
                  style={{
                    borderRadius: 12,
                    border: "1px solid #24527a",
                    background: "#24527a",
                    color: "#ffffff",
                    padding: "12px 14px",
                    fontWeight: 700,
                    cursor: "pointer",
                    minHeight: 0,
                    alignSelf: "stretch",
                  }}
                >
                  Start autotune
                </button>
              ) : canStopAutotune ? (
                <button
                  type="button"
                  onClick={handleStopAutotune}
                  style={{
                    borderRadius: 12,
                    border: "1px solid #8a1f1f",
                    background: "#fff4f4",
                    color: "#8a1f1f",
                    padding: "12px 14px",
                    fontWeight: 700,
                    cursor: "pointer",
                    minHeight: 0,
                    alignSelf: "stretch",
                  }}
                >
                  Stop autotune after cycle
                </button>
              ) : (
                <div
                  style={{
                    border: "1px dashed #d8dfd5",
                    borderRadius: 12,
                    background: "#fbfcfb",
                    padding: 12,
                    color: "#56635a",
                    display: "grid",
                    placeItems: "center",
                    textAlign: "center",
                    fontSize: 13,
                  }}
                >
                  {autotuneControlStatus?.status === "unknown"
                    ? "Autotune is locked. Use force stop / clear lock."
                    : "Autotune action unavailable right now."}
                </div>
              )}
              {autotuneLearningRows.slice(0, 2).map(entry => (
                <div
                  key={entry.playerCount}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    background: "#f8fbf8",
                    padding: 12,
                    display: "grid",
                    gap: 4,
                  }}
                >
                  <strong>{entry.playerCount}p summary</strong>
                  <div
                    style={{
                      color:
                        entry.promotionAge === null
                          ? "#7a5a12"
                          : entry.promotionAge <= 50
                            ? "#1f6f43"
                            : entry.promotionAge <= 100
                              ? "#8a6d1a"
                              : "#9b1c1c",
                      fontWeight: 700,
                    }}
                  >
                    {entry.lastPromotion
                      ? `Latest promotion: ${entry.lastPromotion.cycle}/${currentAutotuneCycle}`
                      : "No champion promotion recorded yet"}
                  </div>
                  <div style={{ color: "#56635a", fontSize: 12 }}>
                    {entry.lastPromotion
                      ? `Current champion benchmark: ${formatMetric(entry.lastPromotion.benchmarkScore, 0)}`
                      : "Need a completed promoted run to establish the first champion."}
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={handleForceStopAutotune}
                style={{
                  borderRadius: 12,
                  border: "1px solid #8a4f12",
                  background: "#fff7eb",
                  color: "#8a4f12",
                  padding: "12px 14px",
                  fontWeight: 700,
                  cursor: "pointer",
                  minHeight: 0,
                  alignSelf: "stretch",
                }}
              >
                Force stop / clear lock
              </button>
              {autotuneLearningRows.slice(2).map(entry => (
                <div
                  key={entry.playerCount}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    background: "#f8fbf8",
                    padding: 12,
                    display: "grid",
                    gap: 4,
                  }}
                >
                  <strong>{entry.playerCount}p summary</strong>
                  <div
                    style={{
                      color:
                        entry.promotionAge === null
                          ? "#7a5a12"
                          : entry.promotionAge <= 50
                            ? "#1f6f43"
                            : entry.promotionAge <= 100
                              ? "#8a6d1a"
                              : "#9b1c1c",
                      fontWeight: 700,
                    }}
                  >
                    {entry.lastPromotion
                      ? `Latest promotion: ${entry.lastPromotion.cycle}/${currentAutotuneCycle}`
                      : "No champion promotion recorded yet"}
                  </div>
                  <div style={{ color: "#56635a", fontSize: 12 }}>
                    {entry.lastPromotion
                      ? `Current champion benchmark: ${formatMetric(entry.lastPromotion.benchmarkScore, 0)}`
                      : "Need a completed promoted run to establish the first champion."}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ color: "#56635a", fontSize: 13, lineHeight: 1.45 }}>
              {autotuneControlStatus?.status === "stopping"
                ? "Autotune has been told to stop after the current cycle finishes."
                : autotuneControlStatus?.status === "unknown"
                  ? "The session server found an autotune status file that still shows a running cycle. Use Force stop / clear lock if you want to clear it immediately."
                  : autotuneControlStatus?.isRunning
                    ? "Autotune is running, so one-shot training controls are locked. Use Force stop / clear lock for an immediate emergency stop."
                    : "Use autotune for continuous 2p/3p/4p training, or expand Manual training for a one-shot run."}
            </div>
            {error && <div style={{ color: "#9b1c1c", fontWeight: 700 }}>{error}</div>}

            <div
              style={{
                display: "grid",
                gap: 12,
              }}
            >
              <CombinedAutotuneLearningChart
                series={autotuneLearningRows.map(entry => ({
                  playerCount: entry.playerCount,
                  runPoints: entry.runPoints,
                  promotionPoints: entry.promotionPoints,
                  lastPromotionCycle: entry.lastPromotion?.cycle ?? null,
                }))}
                windowStart={learningWindowStart}
                windowEnd={Math.max(currentAutotuneCycle, learningWindowStart)}
              />
            </div>
          </div>

          {trainingStatus?.isRunning ? (
            <div
              id="manual-training-status-div"
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                padding: 14,
                background: "#ffffff",
                display: "grid",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <strong>Run status</strong>
                <span style={{ fontWeight: 700, color: "#24613a" }}>{trainingStatus.status ?? "unavailable"}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                <div>
                  <div style={{ color: "#56635a", fontSize: 13 }}>PID</div>
                  <div>{trainingStatus.pid ?? "—"}</div>
                </div>
                <div>
                  <div style={{ color: "#56635a", fontSize: 13 }}>Started</div>
                  <div>{trainingStatus.startedAt ? new Date(trainingStatus.startedAt).toLocaleString() : "—"}</div>
                </div>
                <div>
                  <div style={{ color: "#56635a", fontSize: 13 }}>Finished</div>
                  <div>{trainingStatus.finishedAt ? new Date(trainingStatus.finishedAt).toLocaleString() : "—"}</div>
                </div>
                <div>
                  <div style={{ color: "#56635a", fontSize: 13 }}>Exit</div>
                  <div>
                    {trainingStatus.exitCode ?? "—"}
                    {trainingStatus.signal ? ` (${trainingStatus.signal})` : ""}
                  </div>
                </div>
              </div>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                Latest result file: <code>{trainingStatus.outputPath ?? "public/training-results/latest.json"}</code>
              </div>
              <IterationProgressBar
                idPrefix="manual-training-progress-panel"
                label="Training iteration progress"
                progress={trainingStatus.progress ?? null}
                color="#24613a"
              />
              <div
                id="training-run-log-panel"
                style={{
                  borderRadius: 10,
                  border: "1px solid #d8dfd5",
                  background: "#f5f8f5",
                  padding: 12,
                  minHeight: 180,
                  maxHeight: 260,
                  overflow: "auto",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                }}
              >
                {(trainingStatus.logs?.length ?? 0) > 0
                  ? trainingStatus.logs.join("\n")
                  : "No training logs yet."}
              </div>
              {results && (
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Last updated {new Date(results.generatedAt).toLocaleString()} • maxSteps {results.config.maxSteps}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div
          id="autotune-loop-div"
          style={{
            border: "1px solid #d8dfd5",
            borderRadius: 12,
            background: "#ffffff",
            padding: 14,
            display: "grid",
            gap: 12,
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <strong>Autotune loop</strong>
            <div style={{ color: "#56635a", lineHeight: 1.45 }}>
              This watches the always-on bot trainer that rotates through 1-player, 2-player, 3-player, and 4-player runs.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>Server status</div>
              <div style={{ fontWeight: 700 }}>{autotuneControlStatus?.status ?? "unavailable"}</div>
            </div>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>PID</div>
              <div style={{ fontWeight: 700 }}>{autotuneControlStatus?.pid ?? "—"}</div>
            </div>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>Started</div>
              <div style={{ fontWeight: 700 }}>
                {autotuneControlStatus?.startedAt ? new Date(autotuneControlStatus.startedAt).toLocaleString() : "—"}
              </div>
            </div>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>Finished</div>
              <div style={{ fontWeight: 700 }}>
                {autotuneControlStatus?.finishedAt ? new Date(autotuneControlStatus.finishedAt).toLocaleString() : "—"}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>Completed cycles</div>
              <div style={{ fontWeight: 700 }}>{autotuneStatus?.cycle ?? "—"}</div>
            </div>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>Current cycle</div>
              <div style={{ fontWeight: 700 }}>{autotuneStatus?.currentRun?.cycle ?? "—"}</div>
            </div>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>Current mode</div>
              <div style={{ fontWeight: 700 }}>
                {autotuneStatus?.currentRun ? `${autotuneStatus.currentRun.playerCount}-player` : "Idle"}
              </div>
            </div>
            <div>
              <div style={{ color: "#56635a", fontSize: 13 }}>Profile</div>
              <div style={{ fontWeight: 700 }}>{autotuneStatus?.currentRun?.profile ?? "—"}              </div>
            </div>
            <IterationProgressBar
              idPrefix="autotune-progress-panel"
              label="Current cycle iteration progress"
              progress={autotuneControlStatus?.progress ?? null}
              color="#24527a"
            />

            <div
              id="autotune-log-panel"
              style={{
                gridColumn: "1 / -1",
                borderRadius: 10,
                border: "1px solid #d8dfd5",
                background: "#f5f8f5",
                padding: 12,
                minHeight: 120,
                maxHeight: 220,
                overflow: "auto",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {(autotuneControlStatus?.logs?.length ?? 0) > 0
                ? autotuneControlStatus?.logs.join("\n")
                : "No autotune logs yet."}
            </div>
          </div>

          <div
            id="autotune-current-run-div"
            style={{
              borderRadius: 10,
              border: "1px solid #d8dfd5",
              background: "#f5f8f5",
              padding: 12,
              display: "grid",
              gap: 6,
            }}
          >
            {autotuneStatus?.currentRun ? (
              <>
                <div style={{ fontWeight: 700 }}>
                  Running cycle {autotuneStatus.currentRun.cycle} for {autotuneStatus.currentRun.playerCount}-player games
                </div>
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Mode cycle {autotuneStatus.currentRun.modeCycle} • {autotuneStatus.currentRun.startedFromScratch ? "starting from scratch" : "warm-starting from champion"} • opponents: {autotuneStatus.currentRun.opponent}
                </div>
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Started {new Date(autotuneStatus.currentRun.startedAt).toLocaleString()}
                </div>
              </>
            ) : (
              <div style={{ color: "#56635a", fontSize: 13 }}>
                No autotune cycle is running right now.
              </div>
            )}
          </div>

          <div id="autotune-mode-cycles-div" style={{ display: "grid", gap: 6 }}>
            <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>Per-mode cycles</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
              {TRAINING_PLAYER_COUNT_OPTIONS.map(playerCount => (
                <div
                  key={`autotune-${playerCount}`}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 10,
                    background: "#fbfcfb",
                    padding: 10,
                    display: "grid",
                    gap: 4,
                  }}
                >
                  <div style={{ color: "#56635a", fontSize: 12 }}>{playerCount}-player</div>
                  <div style={{ fontWeight: 700, fontSize: 20 }}>
                    {autotuneStatus?.modeCycles?.[`${playerCount}p`] ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <details id="recent-autotune-champions-div" open style={{ display: "grid", gap: 8 }}>
            <summary style={{ cursor: "pointer", fontWeight: 700, color: "#223024", listStylePosition: "inside" }}>
              Recent autotune champions
            </summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {currentChampionEntries.length > 0 ? (
                currentChampionEntries.map(entry => renderChampionCard(entry))
              ) : (
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  No autotune champions recorded yet.
                </div>
              )}
            </div>
          </details>

          <div id="recent-autotune-runs-div" style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>Recent autotune runs</div>
              <div style={{ color: "#56635a", fontSize: 12 }}>
                Updated {autotuneStatus?.updatedAt ? new Date(autotuneStatus.updatedAt).toLocaleString() : "—"}
              </div>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {displayedAutotuneRuns.length > 0 ? (
                displayedAutotuneRuns.map(run => renderAutotuneRunCard(run, { showPromotionAction: false }))
              ) : (
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  No autotune runs recorded yet.
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          id="playable-bot-presets-div"
          style={{
            border: "1px solid #d8dfd5",
            borderRadius: 12,
            background: "#ffffff",
            padding: 14,
            display: "grid",
            gap: 12,
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <strong>Playable bot presets</strong>
            <div style={{ color: "#56635a", lineHeight: 1.45 }}>
              These are the presets the game can use right now. Stickbug variants are promoted from champion autotune
              runs, while Malcolm Gladwell is shown here as the current managed baseline when present.
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 12,
            }}
          >
            {BOT_PRESETS.map(preset => {
              const isManagedPreset = preset.id === "bot-best" || preset.id === "bot-avg"
              const managedPreset = preset.id === "bot-avg" ? managedAveragePreset : null
              const managedPresetSource =
                preset.id === "bot-best"
                  ? managedStickbugPresets.some(entry => entry.preset)
                    ? "Managed 2p/3p/4p variants"
                    : "Built-in fallback"
                  : managedPreset
                    ? "Managed file"
                    : "Built-in fallback"
              const fallbackSummary =
                preset.id === "bot-avg"
                  ? results?.baseline ?? null
                  : preset.id === "bot-best"
                    ? results?.final ?? null
                    : null
              const passengerComparisonValue =
                managedPreset?.sourceSummary.averagePassengers ?? fallbackSummary?.averagePassengers ?? null

              return (
                <div
                  key={preset.id}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    padding: 14,
                    background: "#fbfcfb",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "start" }}>
                    <div style={{ display: "grid", gap: 4 }}>
                      <strong>{preset.label}</strong>
                      <div style={{ color: "#56635a", fontSize: 13 }}>{preset.description}</div>
                    </div>
                    <div
                      style={{
                        borderRadius: 999,
                        padding: "4px 10px",
                        background: isManagedPreset ? "#eef6ff" : "#f3f6f3",
                        color: isManagedPreset ? "#24527a" : "#56635a",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {isManagedPreset ? managedPresetSource : "Fixed"}
                    </div>
                  </div>

                  {isManagedPreset ? (
                    <>
                      <div style={{ color: "#56635a", fontSize: 13 }}>
                        Source file: <code>{trainingPresets?.outputPath ?? "public/training-results/bot-presets.json"}</code>
                      </div>
                      <div
                        style={{
                          borderRadius: 10,
                          border: "1px solid #d8dfd5",
                          background: "#f5f8f5",
                          padding: 10,
                          display: "grid",
                          gap: 4,
                        }}
                      >
                        <div style={{ color: "#56635a", fontSize: 12 }}>Average passengers</div>
                        <div style={{ fontWeight: 800, fontSize: 22 }}>
                          {passengerComparisonValue === null ? "—" : formatWholeNumber(passengerComparisonValue)}
                        </div>
                        <div style={{ color: "#56635a", fontSize: 12 }}>
                          {preset.id === "bot-best"
                            ? managedStickbugPresets.some(entry => entry.preset)
                              ? "Showing the active managed Stickbug lobby variants"
                              : fallbackSummary
                                ? "Using current training final as the built-in comparison until a Stickbug variant is promoted"
                                : "Run training once to populate comparison stats"
                            : managedPreset
                              ? "Current playable preset summary"
                              : fallbackSummary
                                ? "Using current training baseline/final as the built-in comparison"
                                : "Run training once to populate comparison stats"}
                        </div>
                      </div>
                      {preset.id === "bot-best" ? (
                        <div style={{ display: "grid", gap: 8 }}>
                          {managedStickbugPresets.map(entry => (
                            <div
                              key={`stickbug-${entry.playerCount}`}
                              style={{
                                borderRadius: 10,
                                border: "1px solid #d8dfd5",
                                background: "#ffffff",
                                padding: 10,
                                display: "grid",
                                gap: 6,
                              }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                                <strong>Stickbug {entry.playerCount}p</strong>
                                <span style={{ color: entry.preset ? "#24527a" : "#56635a", fontSize: 12, fontWeight: 700 }}>
                                  {entry.preset ? "Managed" : "Fallback"}
                                </span>
                              </div>
                              {entry.preset ? (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                                  <div>
                                    <div style={{ color: "#56635a", fontSize: 12 }}>Passengers</div>
                                    <div style={{ fontWeight: 700 }}>{formatWholeNumber(entry.preset.sourceSummary.averagePassengers)}</div>
                                  </div>
                                  <div>
                                    <div style={{ color: "#56635a", fontSize: 12 }}>Win rate</div>
                                    <div style={{ fontWeight: 700 }}>{formatPercent(entry.preset.sourceSummary.winRate)}</div>
                                  </div>
                                  <div>
                                    <div style={{ color: "#56635a", fontSize: 12 }}>Score</div>
                                    <div style={{ fontWeight: 700 }}>{formatWholeNumber(entry.preset.sourceSummary.score)}</div>
                                  </div>
                                  <div>
                                    <div style={{ color: "#56635a", fontSize: 12 }}>Promoted</div>
                                    <div style={{ fontWeight: 700, fontSize: 13 }}>{new Date(entry.preset.promotedAt).toLocaleString()}</div>
                                  </div>
                                </div>
                              ) : (
                                <div style={{ color: "#56635a", fontSize: 13 }}>
                                  No managed {entry.playerCount}p Stickbug has been promoted yet.
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : managedPreset ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Average passengers</div>
                            <div style={{ fontWeight: 700 }}>{formatWholeNumber(managedPreset.sourceSummary.averagePassengers)}</div>
                          </div>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Win rate</div>
                            <div style={{ fontWeight: 700 }}>{formatPercent(managedPreset.sourceSummary.winRate)}</div>
                          </div>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Score</div>
                            <div style={{ fontWeight: 700 }}>{formatWholeNumber(managedPreset.sourceSummary.score)}</div>
                          </div>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Promoted</div>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{new Date(managedPreset.promotedAt).toLocaleString()}</div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ color: "#56635a", fontSize: 13 }}>
                          No managed {preset.label} preset has been promoted yet. New games are still using the built-in {preset.label} weights.
                        </div>
                      )}
                      <div style={{ color: "#56635a", fontSize: 13 }}>
                        {preset.id === "bot-best"
                          ? "Use Recent autotune runs to promote champion Stickbug variants."
                          : "Malcolm Gladwell no longer has a dashboard overwrite button."}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: "#56635a", fontSize: 13 }}>
                      This preset is still code-defined and is not overwritten from the training dashboard.
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {results && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              {([
                ["Baseline lead", results.baseline.averagePassengerMargin],
                ["Final lead", results.final.averagePassengerMargin],
                ["Baseline passengers", results.baseline.averagePassengers],
                ["Final passengers", results.final.averagePassengers],
                ["Final win rate", results.final.winRate],
                ["Final timeout rate", results.final.timeoutRate],
                ["Iterations", results.history.length],
                ["Games / candidate", results.config.gamesPerCandidate],
                ["Players / game", results.config.playerCount ?? 4],
              ] as Array<[string, number]>).map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    background: "#ffffff",
                    padding: 14,
                    display: "grid",
                    gap: 4,
                  }}
                >
                  <div style={{ color: "#56635a", fontSize: 13 }}>{label}</div>
                  <strong style={{ fontSize: 24 }}>
                    {typeof value === "number"
                      ? label.toLowerCase().includes("rate")
                        ? formatPercent(value)
                        : label.toLowerCase().includes("lead")
                          ? formatWholeDelta(value)
                          : formatWholeNumber(value)
                      : value}
                  </strong>
                </div>
              ))}
            </div>

            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 12,
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <strong>Compare by player count</strong>
                <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                  These cards compare the latest saved training run for each player count. Passenger lead is the
                  best cross-mode comparison. Raw score is shown for reference, but it is not directly comparable
                  across different player counts.
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: 12,
                }}
              >
                {TRAINING_PLAYER_COUNT_OPTIONS.map(playerCount => {
                  const comparison = modeComparisons.find(entry => entry.playerCount === playerCount) ?? {
                    playerCount,
                    results: null,
                    importance: null,
                  }
                  const comparisonResults = comparison.results
                  const comparisonImportance = comparison.importance
                  const topLevers = comparisonImportance?.rows.slice(0, 3) ?? []

                  return (
                    <div
                      key={playerCount}
                      style={{
                        border: "1px solid #d8dfd5",
                        borderRadius: 12,
                        background: "#fbfcfb",
                        padding: 14,
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "grid", gap: 4 }}>
                        <strong>{playerCount}-player training</strong>
                        <div style={{ color: "#56635a", fontSize: 13 }}>
                          {comparisonResults
                            ? `Saved ${new Date(comparisonResults.generatedAt).toLocaleString()}`
                            : "No saved run yet"}
                        </div>
                      </div>

                      {comparisonResults ? (
                        <>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                              gap: 8,
                            }}
                          >
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Final lead</div>
                              <div style={{ fontWeight: 700 }}>{formatWholeDelta(comparisonResults.final.averagePassengerMargin)}</div>
                            </div>
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Final passengers</div>
                              <div style={{ fontWeight: 700 }}>{formatWholeNumber(comparisonResults.final.averagePassengers)}</div>
                            </div>
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Passenger delta</div>
                              <div
                                style={{
                                  fontWeight: 700,
                                  color:
                                    comparisonResults.final.averagePassengers - comparisonResults.baseline.averagePassengers >= 0
                                      ? "#2a7f3b"
                                      : "#9b1c1c",
                                }}
                              >
                                {formatWholeDelta(
                                  comparisonResults.final.averagePassengers - comparisonResults.baseline.averagePassengers,
                                )}
                              </div>
                            </div>
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Win rate</div>
                              <div style={{ fontWeight: 700 }}>{formatPercent(comparisonResults.final.winRate)}</div>
                            </div>
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Score</div>
                              <div style={{ fontWeight: 700 }}>{formatWholeNumber(comparisonResults.final.score)}</div>
                            </div>
                          </div>

                          <div style={{ display: "grid", gap: 6 }}>
                            <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>
                              Top levers for this mode
                            </div>
                            {topLevers.length > 0 ? (
                              topLevers.map(lever => (
                                <div
                                  key={`${playerCount}-${lever.key}`}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 8,
                                    fontSize: 13,
                                  }}
                                >
                                  <span>{WEIGHT_LABELS[lever.key]?.label ?? lever.key}</span>
                                  <span style={{ fontWeight: 700 }}>
                                    {formatWholeNumber(lever.passengerDrop)} passengers
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div style={{ color: "#56635a", fontSize: 13 }}>
                                Lever importance is not ready for this saved run yet.
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div style={{ color: "#56635a", fontSize: 13 }}>
                          Run and finish a {playerCount}-player training session to compare it here.
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 12,
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <strong>Lever impact by player count</strong>
                <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                  Each saved bot keeps its own lever-importance snapshot. Pick a player count to see one chart
                  where every lever row shows passengers, score, and win-rate impact together.
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {TRAINING_PLAYER_COUNT_OPTIONS.map(playerCount => (
                  <button
                    key={`mode-impact-${playerCount}`}
                    type="button"
                    onClick={() => setSelectedModeImpactPlayerCount(playerCount)}
                    style={{
                      borderRadius: 999,
                      border: `1px solid ${selectedModeImpactPlayerCount === playerCount ? "#223024" : "#c7d0c4"}`,
                      background: selectedModeImpactPlayerCount === playerCount ? "#223024" : "#ffffff",
                      color: selectedModeImpactPlayerCount === playerCount ? "#ffffff" : "#223024",
                      padding: "8px 12px",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {playerCount}-player
                  </button>
                ))}
              </div>

              {selectedModeComparison.results && selectedModeComparison.importance ? (
                <LeverImpactComparisonChart
                  rows={selectedModeImpactRows}
                  title={`${selectedModeImpactPlayerCount}-player saved bot impact`}
                />
              ) : (
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Finish a {selectedModeImpactPlayerCount}-player run and lever importance analysis to show this chart.
                </div>
              )}
            </div>

            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 8,
              }}
            >
              <strong>Score model</strong>
              <div style={{ color: "#56635a", lineHeight: 1.5 }}>
                Training score now rewards both production and margin:
                <code> passengers + passengerLead + winRate*5000 - averageRank*1000 + connectedCities*50 + money/1,000,000 - timeoutRate*250,000</code>.
                That means the trainer still wants to serve lots of passengers, but it also prefers finishing farther ahead of the strongest
                opponent instead of settling for low-scoring blocking lines. In 1-player training, opponent passengers are treated as zero.
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 12,
              }}
            >
              <LineChart title="Score" points={scoreSeries} color="#1d5d76" formatter={formatWholeNumber} />
              <LineChart title="Passenger lead" points={passengerMarginSeries} color="#24527a" formatter={formatWholeDelta} />
              <LineChart title="Passengers moved" points={passengerSeries} color="#2a7f3b" formatter={formatWholeNumber} />
              <LineChart title="Win rate" points={winRateSeries} color="#8a5a00" formatter={formatPercent} />
              <LineChart title="Timeout rate" points={timeoutSeries} color="#9b1c1c" formatter={formatPercent} />
            </div>

            <LeverImpactChart
              rows={weightRows}
              metric={selectedImpactMetric}
              onMetricChange={setSelectedImpactMetric}
            />

            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 10,
              }}
            >
              <strong>Estimated profitable city links</strong>
              <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                These estimates rank direct <strong>rail</strong> and <strong>air</strong> city links by
                modeled net revenue over one period using the current map, demand, fare buckets, and vehicle cards.
                Bus is excluded because bus service is automatic, not a claimed city link. Rail build cost is shown
                separately so you can compare operating profit against upfront construction cost.
              </div>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                This is a planning estimate, not a full-game simulation: it assumes the city link gets to use its own
                demand and best-fitting vehicle without competition from the rest of a live network.
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
                  <thead>
                    <tr>
                      {[
                        "Mode",
                        "City link",
                        "Distance",
                        "Best vehicle",
                        "Passengers / period",
                        "Revenue",
                        "Operating cost",
                        "Net revenue",
                        "Build cost",
                      ].map(header => (
                        <th
                          key={header}
                          style={{
                            textAlign: "left",
                            padding: "10px 8px",
                            borderBottom: "1px solid #d8dfd5",
                            fontSize: 13,
                            color: "#56635a",
                          }}
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {profitableCityLinks.map(row => (
                      <tr key={`${row.mode}:${row.cityAId}:${row.cityBId}`}>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec", fontWeight: 700 }}>
                          {row.mode}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.cityAName} - {row.cityBName}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {formatMetric(row.distanceMiles)} mi
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.bestVehicleName}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {formatMetric(row.estimatedPassengers)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          ${formatMetric(row.estimatedRevenue)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          ${formatMetric(row.estimatedOperatingCost)}
                        </td>
                        <td
                          style={{
                            padding: "10px 8px",
                            borderBottom: "1px solid #edf2ec",
                            fontWeight: 700,
                            color: row.estimatedNetRevenue >= 0 ? "#2a7f3b" : "#9b1c1c",
                          }}
                        >
                          ${formatMetric(row.estimatedNetRevenue)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.buildCost > 0 ? `$${formatMetric(row.buildCost)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 10,
              }}
            >
              <strong>Weight changes</strong>
              <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                Positive deltas mean the final bot values that behavior more than the baseline. Importance is measured by
                re-running the latest trained bot with one lever reverted to baseline at a time, then ranking the passenger
                and score drop from that ablation.
              </div>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                {trainingImportance?.isRunning
                  ? "Analyzing lever importance..."
                  : hasCurrentImportance
                    ? `Importance reference score ${formatWholeNumber(trainingImportance?.result?.reference.score ?? 0)} on ${trainingImportance?.result?.config.gamesPerCandidate ?? 0} games.`
                    : trainingImportance?.error
                      ? trainingImportance.error
                      : "Waiting for lever importance analysis to finish."}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
                  <thead>
                    <tr>
                      {["Rank", "Passengers drop", "Score drop", "Win-rate drop", "Group", "Lever", "Baseline", "Final", "Delta", "Meaning"].map(header => (
                        <th
                          key={header}
                          style={{
                            textAlign: "left",
                            padding: "10px 8px",
                            borderBottom: "1px solid #d8dfd5",
                            fontSize: 13,
                            color: "#56635a",
                          }}
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {weightRows.map(row => (
                      <tr key={row.key}>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec", fontWeight: 700 }}>
                          {row.importanceRank ?? "—"}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.passengerDrop === null ? "—" : formatWholeNumber(row.passengerDrop)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.scoreDrop === null ? "—" : formatWholeNumber(row.scoreDrop)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.winRateDrop === null ? "—" : formatPercent(row.winRateDrop)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec", fontWeight: 700 }}>{row.group}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>{row.label}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>{formatMetric(row.baselineValue, 3)}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>{formatMetric(row.finalValue, 3)}</td>
                        <td
                          style={{
                            padding: "10px 8px",
                            borderBottom: "1px solid #edf2ec",
                            color: row.delta > 0 ? "#2a7f3b" : row.delta < 0 ? "#9b1c1c" : "#56635a",
                            fontWeight: 700,
                          }}
                        >
                          {formatWeightDelta(row.delta)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec", color: "#56635a" }}>
                          {row.description}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div
              id="bot-decision-tree-div"
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 12,
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <strong>Bot decision tree by phase</strong>
                <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                  This is the current scripted bot flow at the bottom of the stack: what actions it can take in each
                  phase, what branch conditions unlock those actions, and which trained levers influence the choice.
                </div>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                {BOT_PHASE_DECISION_TREE.map(phase => (
                  <div
                    key={phase.phase}
                    style={{
                      border: "1px solid #d8dfd5",
                      borderRadius: 12,
                      background: "#fbfcfb",
                      padding: 14,
                      display: "grid",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "grid", gap: 4 }}>
                      <strong>{phase.phase}</strong>
                      <div style={{ color: "#56635a", lineHeight: 1.45 }}>{phase.summary}</div>
                    </div>

                    <div style={{ display: "grid", gap: 10 }}>
                      {phase.branches.map(branch => (
                        <div
                          key={`${phase.phase}-${branch.title}`}
                          style={{
                            borderLeft: "4px solid #c7d0c4",
                            paddingLeft: 12,
                            display: "grid",
                            gap: 8,
                          }}
                        >
                          <div style={{ display: "grid", gap: 4 }}>
                            <div style={{ fontWeight: 700 }}>{branch.title}</div>
                            <div style={{ color: "#56635a", fontSize: 13 }}>{branch.when}</div>
                          </div>

                          <div style={{ display: "grid", gap: 4 }}>
                            <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>Available actions</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                              {branch.actions.map(action => (
                                <span
                                  key={`${branch.title}-${action}`}
                                  style={{
                                    borderRadius: 999,
                                    border: "1px solid #c7d0c4",
                                    background: "#ffffff",
                                    padding: "4px 10px",
                                    fontSize: 12,
                                    fontWeight: 700,
                                    color: "#223024",
                                  }}
                                >
                                  {action}
                                </span>
                              ))}
                            </div>
                          </div>

                          <div style={{ display: "grid", gap: 4 }}>
                            <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>Influencing levers</div>
                            {branch.leverKeys.length > 0 ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                {branch.leverKeys.map(key => (
                                  <span
                                    key={`${branch.title}-${key}`}
                                    title={WEIGHT_LABELS[key]?.description ?? key}
                                    style={{
                                      borderRadius: 999,
                                      border: "1px solid #d7e5da",
                                      background: "#f1f7f2",
                                      padding: "4px 10px",
                                      fontSize: 12,
                                      color: "#24513a",
                                    }}
                                  >
                                    {WEIGHT_LABELS[key]?.label ?? key}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <div style={{ color: "#56635a", fontSize: 13 }}>
                                No trained levers currently affect this branch.
                              </div>
                            )}
                          </div>

                          {branch.notes && branch.notes.length > 0 ? (
                            <div style={{ display: "grid", gap: 4 }}>
                              <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>Notes</div>
                              <div style={{ display: "grid", gap: 4, color: "#56635a", fontSize: 13 }}>
                                {branch.notes.map(note => (
                                  <div key={`${branch.title}-${note}`}>- {note}</div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
