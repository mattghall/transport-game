import { useEffect, useMemo, useState } from "react"
import { BOT_PRESETS } from "./bots/presets"
import type {
  ScriptedBotLeverImportanceResults,
  ScriptedBotTrainingResults,
} from "./bots/training"
import {
  fetchAutotuneStatus,
  forceStopAutotune,
  fetchTrainingImportance,
  fetchTrainingPresets,
  getLocalSessionServerUrl,
  promoteAutotuneRunToStickbug,
  resetAutotuneData,
  startAutotune,
  stopAutotune,
  type AutotuneControlStatus,
  type TrainingImportanceStatus,
  type TrainingPresetStatus,
} from "./network/sessionSync"
import { buildEstimatedCityLinkProfitabilityRows } from "./engine/cityLinkProfitability"
import type { ScriptedBotWeights } from "./bots/scriptedBot"
import {
  buildLeverImpactRows,
  fetchOptionalJson,
  formatDuration,
  formatMetric,
  formatPercent,
  formatPercentDelta,
  formatWholeDelta,
  formatWholeNumber,
  getDeltaColor,
  AllChampionsLeverChart,
  LeverImpactComparisonChart,
  WEIGHT_LABELS,
} from "./trainingHelpers"

const TRAINING_PLAYER_COUNT_OPTIONS = [1, 2, 3, 4] as const
type TrainingPlayerCount = (typeof TRAINING_PLAYER_COUNT_OPTIONS)[number]

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

type ModeComparisonEntry = {
  playerCount: TrainingPlayerCount
  results: ScriptedBotTrainingResults | null
  importance: ScriptedBotLeverImportanceResults | null
}

type ChampionFileEntry = {
  playerCount: TrainingPlayerCount
  data: {
    updatedAt: string
    cycle: number
    playerCount: TrainingPlayerCount
    benchmark: {
      score: number
      winRate: number
      averageRank: number
      averagePassengers: number
      averagePassengerMargin: number
      averageConnectedCities: number
      sampleCount: number
    }
    training: ScriptedBotTrainingResults
  } | null
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
  durationMs?: number
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
              weights?: Partial<ScriptedBotWeights>
            }
          }
        }
    >
  >
}
const REFRESH_MS = 3000

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
        actions: ["claim-route (rail)", "claim-route (air)", "create-service-pod", "ready-operations"],
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
        title: "Create a pod from an existing network subset",
        when: "If a corridor has room for another pod and the bot can form a connected city subset inside it.",
        actions: ["create-service-pod", "ready-operations"],
        leverKeys: [
          "podSplitBaseScore",
          "podCityCountScore",
          "podPopulationPerMillionScore",
          "podPopulationPerDistanceScore",
          "podDemandScore",
          "podNetRevenueScore",
          "podAdditionalRoutePenalty",
        ],
        notes: [
          "Bots create pods as connected subsets inside an existing network corridor instead of manually dragging one city at a time.",
          "The pod candidate is scored against the resulting bureaucracy summary so the bot only keeps pod shapes that improve real service output.",
        ],
      },
      {
        title: "Remove an unprofitable or low-efficiency city from a pod",
        when: "If a pod has 3 or more cities and removing one city would leave the remaining cities connected.",
        actions: ["remove-pod-city", "ready-operations"],
        leverKeys: [
          "podRemoveCityBaseScore",
          "podRemovePassengersPerDistanceGainScore",
          "podRemoveNetRevenueGainScore",
        ],
        notes: [
          "The removed city is moved to the disconnected slot, not deleted.",
          "The bot only removes a city if the pod stays connected (2+ cities) after removal.",
          "Scoring compares passengers-per-mile and net revenue before and after the move.",
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
]

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
  progress: AutotuneControlStatus["progress"]
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
          // Merge runPoints with any promotionPoints not already covered (scratch-run promotions)
          // so that all visible dots are connected by the polyline.
          const runCycles = new Set(entry.runPoints.map(p => p.cycle))
          const mergedLinePoints = [
            ...entry.runPoints,
            ...entry.promotionPoints.filter(p => !runCycles.has(p.cycle)),
          ].sort((a, b) => a.cycle - b.cycle)
          const runPolylinePoints = buildPolylinePoints(
            mergedLinePoints,
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
              {mergedLinePoints.length >= 2 ? (
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

export default function TrainingApp() {
  const defaultServerUrl = getLocalSessionServerUrl()
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [autotuneControlStatus, setAutotuneControlStatus] = useState<AutotuneControlStatus | null>(null)
  const [trainingPresets, setTrainingPresets] = useState<TrainingPresetStatus | null>(null)
  const [trainingImportance, setTrainingImportance] = useState<TrainingImportanceStatus | null>(null)
  const [modeComparisons, setModeComparisons] = useState<ModeComparisonEntry[]>([])
  const [championFiles, setChampionFiles] = useState<ChampionFileEntry[]>([])
  const [autotuneStatus, setAutotuneStatus] = useState<AutotuneStatus | null>(null)
  const [autotuneHistory, setAutotuneHistory] = useState<AutotuneHistory | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [promotingAutotuneRunKey, setPromotingAutotuneRunKey] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [selectedModeImpactPlayerCount, setSelectedModeImpactPlayerCount] = useState<TrainingPlayerCount>(4)

  const currentRunStartedAt = autotuneStatus?.currentRun?.startedAt ?? null
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!currentRunStartedAt) { setElapsedSeconds(0); return }
    const update = () => setElapsedSeconds(Math.floor((Date.now() - new Date(currentRunStartedAt).getTime()) / 1000))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [currentRunStartedAt])

  useEffect(() => {
    let cancelled = false

    async function reloadData() {
      const tick = `${Date.now()}-${refreshNonce}`
      const [
        autotuneControlResponse,
        presetsResponse,
        importanceResponse,
        autotuneResponse,
        autotuneHistoryResponse,
        comparisonsResponse,
        championFilesResponse,
      ] = await Promise.allSettled([
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
              `/training-results/champion-${playerCount}p-importance.json?tick=${tick}`,
            ),
          })),
        ),
        Promise.all(
          TRAINING_PLAYER_COUNT_OPTIONS.map(async playerCount => ({
            playerCount,
            data: await fetchOptionalJson<ChampionFileEntry["data"]>(
              `/training-results/champion-${playerCount}p.json?tick=${tick}`,
            ),
          })),
        ),
      ])

      if (cancelled) {
        return
      }

      if (autotuneControlResponse.status === "fulfilled") {
        setAutotuneControlStatus(autotuneControlResponse.value)
        setError(null)
      } else {
        setError(
          autotuneControlResponse.reason instanceof Error
            ? autotuneControlResponse.reason.message
            : "Could not reach the training endpoint.",
        )
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
            importance: entry.importance ?? null,
          })),
        )
      }

      if (championFilesResponse.status === "fulfilled") {
        setChampionFiles(championFilesResponse.value)
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

  async function handleResetAutotuneData() {
    setIsSubmitting(true)
    setConfirmReset(false)
    try {
      await resetAutotuneData(defaultServerUrl)
      setRefreshNonce(current => current + 1)
      setError(null)
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Could not reset autotune data.")
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

  const latestManagedTrainingResults = useMemo(
    () => modeComparisons.find(entry => entry.playerCount === 4)?.results ?? null,
    [modeComparisons],
  )
  const selectedModeComparison = useMemo(() => {
    const entry = modeComparisons.find(e => e.playerCount === selectedModeImpactPlayerCount)
    const champion = championFiles.find(e => e.playerCount === selectedModeImpactPlayerCount)?.data ?? null
    const results = champion?.training ?? entry?.results ?? null
    const importance =
      entry?.importance ??
      (trainingImportance?.result?.sourceTrainingGeneratedAt === results?.generatedAt
        ? (trainingImportance?.result ?? null)
        : null)
    return { playerCount: selectedModeImpactPlayerCount, results, importance, champion }
  }, [championFiles, modeComparisons, selectedModeImpactPlayerCount, trainingImportance])
  const selectedModeImpactRows = useMemo(
    () => buildLeverImpactRows(selectedModeComparison.results, selectedModeComparison.importance, { skipTimestampCheck: true }),
    [selectedModeComparison],
  )
  const allChampionsLeverRows = useMemo(() => {
    const result: Partial<Record<number, ReturnType<typeof buildLeverImpactRows>>> = {}
    for (const pc of TRAINING_PLAYER_COUNT_OPTIONS) {
      const champion = championFiles.find(e => e.playerCount === pc)?.data ?? null
      const importance = modeComparisons.find(e => e.playerCount === pc)?.importance ?? null
      if (champion?.training) {
        result[pc] = buildLeverImpactRows(champion.training, importance, { skipTimestampCheck: true })
      }
    }
    return result
  }, [championFiles, modeComparisons])
  const effectiveAutotuneHistory = useMemo(
    () => mergeAutotuneHistories(autotuneHistory, buildAutotuneFallbackHistory(autotuneStatus)),
    [autotuneHistory, autotuneStatus],
  )
  const currentAutotuneCycle = useMemo(() => {
    // Only use run cycles (not champion promotion cycles) to anchor the window.
    // Champion promotions can have cycles from a previous autotune session, which
    // would inflate the window start and exclude all current-session runs.
    const runCycle = Math.max(
      0,
      ...(effectiveAutotuneHistory?.runs.map(run => run.cycle) ?? []),
    )

    return Math.max(autotuneStatus?.cycle ?? 0, runCycle)
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
  const managedStickbugPresets = ([1, 2, 3, 4] as const).map(playerCount => ({
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
    type StoredBenchmark = {
      score: number
      winRate: number
      averagePassengers: number
      averagePassengerMargin: number
    }
    return new Map<TrainingPlayerCount, StoredBenchmark | null>(
      currentChampionEntries.map(entry => {
        const previousChampion = (effectiveAutotuneHistory?.championPromotions ?? [])
          .filter(promotion => promotion.playerCount === entry.playerCount && promotion.cycle < entry.champion.cycle)
          .sort((runA, runB) => runB.cycle - runA.cycle)[0]

        if (!previousChampion) {
          return [entry.playerCount, null] as const
        }

        return [
          entry.playerCount,
          {
            score: previousChampion.benchmarkScore,
            winRate: previousChampion.winRate,
            averagePassengers: previousChampion.averagePassengers,
            averagePassengerMargin: previousChampion.averagePassengerMargin,
          },
        ] as const
      }),
    )
  }, [currentChampionEntries, effectiveAutotuneHistory])
  function buildAutotuneQueue(count: number) {
    if (!autotuneStatus) return []
    const PLAYER_COUNTS = [4, 3, 2, 1] as const
    const mc = { ...autotuneStatus.modeCycles }
    // If a run is active, advance past it so queue shows what comes AFTER
    let c = autotuneStatus.cycle
    if (autotuneStatus.currentRun) {
      c = autotuneStatus.currentRun.cycle
      const key = `${autotuneStatus.currentRun.playerCount}p` as `${TrainingPlayerCount}p`
      mc[key] = autotuneStatus.currentRun.modeCycle
    }
    const items: Array<{ cycle: number; playerCount: TrainingPlayerCount; modeCycle: number; profile: "refine" | "explore" | "deep"; startedFromScratch: boolean }> = []
    for (let i = 0; i < count; i++) {
      c += 1
      const playerCount = PLAYER_COUNTS[(c - 1) % PLAYER_COUNTS.length]
      const key = `${playerCount}p` as `${TrainingPlayerCount}p`
      mc[key] = (mc[key] ?? 0) + 1
      const modeCycle = mc[key]
      const hasChampion = !!autotuneStatus.champions?.[key]
      const startedFromScratch = !hasChampion || modeCycle % 5 === 0
      const profile: "refine" | "explore" | "deep" =
        startedFromScratch || modeCycle % 5 === 0 ? "deep" : modeCycle % 2 === 0 ? "explore" : "refine"
      items.push({ cycle: c, playerCount, modeCycle, profile, startedFromScratch })
    }
    return items
  }
  const canStartAutotune =
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
    const canPromoteStickbug = run.playerCount >= 1 && run.playerCount <= 4
    const isPromotingThisRun = promotingAutotuneRunKey === `${run.playerCount}-${run.generatedAt}`
    const previousChampion = (effectiveAutotuneHistory?.championPromotions ?? [])
      .filter(promotion => promotion.playerCount === run.playerCount && promotion.cycle < run.cycle)
      .sort((runA, runB) => runB.cycle - runA.cycle)[0] ?? null
    const promotedStickbugVariant = canPromoteStickbug
      ? trainingPresets?.presets[`bot-best-${run.playerCount}p` as `bot-best-${1 | 2 | 3 | 4}p`]
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
          {run.startedFromScratch ? "Started from scratch" : "Warm-started from champion"} • opponents: {run.opponent}{run.durationMs != null ? ` • ${formatDuration(run.durationMs)}` : ""}
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
          {options?.showPromotionAction && canPromoteStickbug ? (
            <div style={{ display: "flex", alignItems: "center" }}>
              <button
                type="button"
                onClick={() => void handlePromoteAutotuneRun({ playerCount: run.playerCount, generatedAt: run.generatedAt })}
                disabled={isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey}
                style={{
                  borderRadius: 999,
                  border: "1px solid #24527a",
                  background: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "#d9e3ee" : "#24527a",
                  color: "#ffffff",
                  padding: "4px 12px",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "not-allowed" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {isAlreadyPromoted ? "Promoted" : isPromotingThisRun ? "Promoting…" : "Promote Stickbug"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  function renderChampionCard(entry: {
    playerCount: TrainingPlayerCount
    champion: NonNullable<NonNullable<AutotuneStatus["champions"]>[`${TrainingPlayerCount}p`]>
  }) {
    const canPromoteStickbug = entry.playerCount >= 1 && entry.playerCount <= 4
    const generatedAt = entry.champion.training.generatedAt
    const isPromotingThisRun = promotingAutotuneRunKey === `${entry.playerCount}-${generatedAt}`
    const promotedStickbugVariant = canPromoteStickbug
      ? trainingPresets?.presets[`bot-best-${entry.playerCount}p` as `bot-best-${1 | 2 | 3 | 4}p`]
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
          {canPromoteStickbug ? (
            <div style={{ display: "flex", alignItems: "center" }}>
              <button
                type="button"
                onClick={() => void handlePromoteAutotuneRun({ playerCount: entry.playerCount, generatedAt })}
                disabled={isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey}
                style={{
                  borderRadius: 999,
                  border: "1px solid #24527a",
                  background: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "#d9e3ee" : "#24527a",
                  color: "#ffffff",
                  padding: "4px 12px",
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: isAlreadyPromoted || isSubmitting || !!promotingAutotuneRunKey ? "not-allowed" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {isAlreadyPromoted ? "Promoted" : isPromotingThisRun ? "Promoting…" : "Promote Stickbug"}
              </button>
            </div>
          ) : null}
        </div>
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
                href="/manual-training.html"
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
                Manual training →
              </a>
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
              {confirmReset ? (
                <>
                  <span style={{ alignSelf: "center", color: "#9b1c1c", fontWeight: 700, fontSize: 13 }}>
                    Delete all training history, cycles, and champion records? Promoted Stickbug models will not be affected.
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleResetAutotuneData()}
                    disabled={isSubmitting}
                    style={{
                      borderRadius: 999,
                      border: "1px solid #9b1c1c",
                      background: "#9b1c1c",
                      color: "#fff",
                      padding: "10px 16px",
                      fontWeight: 700,
                      cursor: isSubmitting ? "not-allowed" : "pointer",
                    }}
                  >
                    Yes, reset
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    style={{
                      borderRadius: 999,
                      border: "1px solid #c7d0c4",
                      background: "#ffffff",
                      color: "#223024",
                      padding: "10px 16px",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  disabled={isSubmitting || !!autotuneControlStatus?.isRunning}
                  style={{
                    borderRadius: 999,
                    border: "1px solid #c7d0c4",
                    background: "#ffffff",
                    color:
                      isSubmitting || autotuneControlStatus?.isRunning
                        ? "#aaa"
                        : "#9b1c1c",
                    padding: "10px 16px",
                    fontWeight: 700,
                    cursor:
                      isSubmitting || autotuneControlStatus?.isRunning
                        ? "not-allowed"
                        : "pointer",
                  }}
                >
                  Reset training data
                </button>
              )}
            </div>
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
                    ? "Autotune is running. Use Force stop / clear lock for an immediate emergency stop."
                    : "Use this page for continuous 1p/2p/3p/4p tuning, or open Manual training for a one-shot run."}
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
                  Started {new Date(autotuneStatus.currentRun.startedAt).toLocaleString()} • running for <strong>{formatDuration(elapsedSeconds * 1000)}</strong>
                </div>
                {(() => {
                  const currentPc = autotuneStatus.currentRun.playerCount
                  const modeImportance = modeComparisons.find(e => e.playerCount === currentPc)?.importance
                  const champion = autotuneStatus.champions?.[`${currentPc}p`]
                  if (!modeImportance || !champion) return null
                  const topLevers = modeImportance.rows
                    .filter(row => row.passengerDrop > 0)
                    .slice(0, 6)
                  if (topLevers.length === 0) return null
                  return (
                    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                      <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Top levers being optimized ({currentPc}p importance)
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "2px 10px", fontSize: 12, alignItems: "center" }}>
                        <span style={{ color: "#888", fontSize: 11 }}>Lever</span>
                        <span style={{ color: "#888", fontSize: 11, textAlign: "right" }}>Champion</span>
                        <span style={{ color: "#888", fontSize: 11, textAlign: "right" }}>Default</span>
                        <span style={{ color: "#888", fontSize: 11, textAlign: "right" }}>Pax loss if removed</span>
                        {topLevers.map(row => {
                          const championVal = champion.training.final.weights?.[row.key] ?? row.finalValue
                          return (
                            <>
                              <span key={`lk-${row.key}`} style={{ color: "#223024", fontFamily: "monospace", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.key}</span>
                              <span key={`lv-${row.key}`} style={{ color: "#223024", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatMetric(championVal, 2)}</span>
                              <span key={`lb-${row.key}`} style={{ color: "#56635a", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatMetric(row.baselineValue, 2)}</span>
                              <span key={`ld-${row.key}`} style={{ color: "#9b1c1c", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>−{formatWholeNumber(row.passengerDrop)}</span>
                            </>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </>
            ) : (
              <div style={{ color: "#56635a", fontSize: 13 }}>
                No autotune cycle is running right now.
              </div>
            )}
          </div>

          {autotuneStatus && (() => {
            const PLAYER_COUNT_COLORS: Record<TrainingPlayerCount, { bg: string; border: string; text: string }> = {
              1: { bg: "#eef4ff", border: "#6b9fe4", text: "#1e3a6e" },
              2: { bg: "#f0faf0", border: "#5a9e6f", text: "#1a4d2b" },
              3: { bg: "#fdf4e7", border: "#d4892a", text: "#6b3c0a" },
              4: { bg: "#fdf0f8", border: "#b96bb0", text: "#5a1a55" },
            }
            const PROFILE_LABELS: Record<string, string> = { deep: "deep", explore: "expl", refine: "rfn" }

            const lastRun = autotuneStatus.recentRuns.length > 0
              ? [...autotuneStatus.recentRuns].sort((a, b) => b.cycle - a.cycle)[0]
              : null
            const currentRun = autotuneStatus.currentRun
            const upcoming = buildAutotuneQueue(7)

            const renderStop = (
              item: { cycle: number; playerCount: TrainingPlayerCount; profile: string },
              variant: "past" | "current" | "upcoming",
              key: string,
            ) => {
              const colors = PLAYER_COUNT_COLORS[item.playerCount]
              const isPast = variant === "past"
              const isCurrent = variant === "current"
              return (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    opacity: isPast ? 0.4 : 1,
                    minWidth: isCurrent ? 72 : 56,
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: isCurrent ? 64 : 48,
                      height: isCurrent ? 64 : 48,
                      borderRadius: isCurrent ? 14 : 10,
                      border: `${isCurrent ? 3 : 2}px solid ${isPast ? "#bbb" : colors.border}`,
                      background: isPast ? "#f0f0f0" : colors.bg,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 2,
                      boxShadow: isCurrent ? "0 0 0 3px rgba(0,0,0,0.12)" : undefined,
                    }}
                  >
                    <span style={{ fontWeight: 800, fontSize: isCurrent ? 18 : 14, color: isPast ? "#888" : colors.text, lineHeight: 1 }}>
                      {item.playerCount}p
                    </span>
                    <span style={{ fontSize: 10, color: isPast ? "#aaa" : colors.text, fontWeight: 600, lineHeight: 1 }}>
                      {PROFILE_LABELS[item.profile] ?? item.profile}
                    </span>
                  </div>
                  <span style={{ fontSize: 10, color: isPast ? "#aaa" : "#56635a", fontWeight: isCurrent ? 700 : 400 }}>
                    #{item.cycle}
                  </span>
                </div>
              )
            }

            return (
              <div style={{ display: "flex", alignItems: "center", gap: 4, overflowX: "auto", padding: "4px 0" }}>
                {lastRun && !currentRun && renderStop(
                  { cycle: lastRun.cycle, playerCount: lastRun.playerCount as TrainingPlayerCount, profile: lastRun.profile },
                  "past", `past-${lastRun.cycle}`,
                )}
                {currentRun && renderStop(
                  { cycle: currentRun.cycle, playerCount: currentRun.playerCount, profile: currentRun.profile },
                  "current", `current-${currentRun.cycle}`,
                )}
                {upcoming.map((item, i) => (
                  <div key={`upcoming-${item.cycle}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {(i === 0) && (
                      <div style={{ width: 16, height: 2, background: "#c7d0c4", borderRadius: 1, flexShrink: 0 }} />
                    )}
                    {renderStop(item, "upcoming", `upcoming-${item.cycle}`)}
                    {i < upcoming.length - 1 && (
                      <div style={{ width: 16, height: 2, background: "#c7d0c4", borderRadius: 1, flexShrink: 0 }} />
                    )}
                  </div>
                ))}
              </div>
            )
          })()}

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

          <details id="recent-autotune-champions-div" style={{ display: "grid", gap: 8 }}>
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

          <details style={{ display: "grid", gap: 8 }}>
            <summary style={{ cursor: "pointer", fontWeight: 700, color: "#223024", listStylePosition: "inside" }}>
              Recent autotune runs
            </summary>
            <div style={{ color: "#56635a", fontSize: 12 }}>
              Updated {autotuneStatus?.updatedAt ? new Date(autotuneStatus.updatedAt).toLocaleString() : "—"}
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
          </details>
        </div>

        <details
          open
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
          <summary style={{ cursor: "pointer", fontWeight: 700, color: "#223024", listStylePosition: "inside" }}>
            Playable bot presets
          </summary>
          <div style={{ color: "#56635a", lineHeight: 1.45 }}>
            These are the presets the game can use right now. Stickbug variants are promoted from champion autotune
            runs, while Malcolm Gladwell is shown here as the current managed baseline when present.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
            }}
          >
            {BOT_PRESETS.map(preset => {
              const stickbugPlayerCount = (["bot-best-1p", "bot-best-2p", "bot-best-3p", "bot-best-4p"] as const)
                .indexOf(preset.id as never) >= 0
                ? (parseInt(preset.id.replace("bot-best-", "")) as 1 | 2 | 3 | 4)
                : null
              const stickbugEntry = stickbugPlayerCount !== null
                ? managedStickbugPresets.find(e => e.playerCount === stickbugPlayerCount) ?? null
                : null
              const isStickbugPreset = stickbugPlayerCount !== null
              const isManagedPreset = preset.id === "bot-best" || preset.id === "bot-avg" || isStickbugPreset
              const managedPreset = preset.id === "bot-avg" ? managedAveragePreset : null
              const badgeLabel = isStickbugPreset
                ? stickbugEntry?.preset ? "Promoted" : "Built-in fallback"
                : preset.id === "bot-best"
                  ? managedStickbugPresets.some(entry => entry.preset) ? "Managed variants" : "Built-in fallback"
                  : preset.id === "bot-avg"
                    ? managedPreset ? "Managed file" : "Built-in fallback"
                    : "Fixed"
              const fallbackSummary =
                preset.id === "bot-avg"
                  ? latestManagedTrainingResults?.baseline ?? null
                  : preset.id === "bot-best"
                    ? latestManagedTrainingResults?.final ?? null
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
                        background: isManagedPreset ? (isStickbugPreset && stickbugEntry?.preset ? "#eef6ff" : "#f3f6f3") : "#f3f6f3",
                        color: isManagedPreset ? (isStickbugPreset && stickbugEntry?.preset ? "#24527a" : "#56635a") : "#56635a",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {badgeLabel}
                    </div>
                  </div>

                  {isStickbugPreset ? (
                    stickbugEntry?.preset ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                        <div>
                          <div style={{ color: "#56635a", fontSize: 12 }}>Passengers</div>
                          <div style={{ fontWeight: 700 }}>{formatWholeNumber(stickbugEntry.preset.sourceSummary.averagePassengers)}</div>
                        </div>
                        <div>
                          <div style={{ color: "#56635a", fontSize: 12 }}>Win rate</div>
                          <div style={{ fontWeight: 700 }}>{formatPercent(stickbugEntry.preset.sourceSummary.winRate)}</div>
                        </div>
                        <div>
                          <div style={{ color: "#56635a", fontSize: 12 }}>Score</div>
                          <div style={{ fontWeight: 700 }}>{formatWholeNumber(stickbugEntry.preset.sourceSummary.score)}</div>
                        </div>
                        <div>
                          <div style={{ color: "#56635a", fontSize: 12 }}>Promoted</div>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{new Date(stickbugEntry.preset.promotedAt).toLocaleString()}</div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ color: "#56635a", fontSize: 13 }}>
                        No {stickbugPlayerCount}p Stickbug promoted yet — using built-in weights.
                      </div>
                    )
                  ) : isManagedPreset ? (
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
                          {managedPreset
                            ? "Current playable preset summary"
                            : fallbackSummary
                              ? "Using current training baseline as the built-in comparison"
                              : "Run training once to populate comparison stats"}
                        </div>
                      </div>
                      {managedPreset ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Win rate</div>
                            <div style={{ fontWeight: 700 }}>{formatPercent(managedPreset.sourceSummary.winRate)}</div>
                          </div>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Promoted</div>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{new Date(managedPreset.promotedAt).toLocaleString()}</div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ color: "#56635a", fontSize: 13 }}>
                          Malcolm Gladwell no longer has a dashboard overwrite button.
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: "#56635a", fontSize: 13 }}>
                      This preset is code-defined and not overwritten from the training dashboard.
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </details>

        <>
            <details
              id="compare-by-player-count-div"
              open
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 12,
              }}
            >
              <summary style={{ cursor: "pointer", fontWeight: 700, color: "#223024", listStylePosition: "inside" }}>
                Compare by player count
              </summary>
              <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                These cards show the <strong>current champion</strong> for each player count — the best bot
                ever promoted, evaluated on fixed benchmark seeds. Passenger lead and win rate reflect
                performance against the default bot pool.
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: 12,
                }}
              >
                {TRAINING_PLAYER_COUNT_OPTIONS.map(playerCount => {
                  const champion = championFiles.find(e => e.playerCount === playerCount)?.data ?? null
                  const importance = modeComparisons.find(e => e.playerCount === playerCount)?.importance ?? null
                  const topLevers = importance?.rows.slice(0, 3) ?? []

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
                        <strong>{playerCount}-player champion</strong>
                        <div style={{ color: "#56635a", fontSize: 13 }}>
                          {champion
                            ? `Promoted at cycle ${champion.cycle} · ${new Date(champion.updatedAt).toLocaleString()}`
                            : "No champion yet"}
                        </div>
                      </div>

                      {champion ? (
                        <>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                              gap: 8,
                            }}
                          >
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Passenger lead</div>
                              <div style={{ fontWeight: 700 }}>{formatWholeDelta(champion.benchmark.averagePassengerMargin)}</div>
                            </div>
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Passengers</div>
                              <div style={{ fontWeight: 700 }}>{formatWholeNumber(champion.benchmark.averagePassengers)}</div>
                            </div>
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Win rate</div>
                              <div style={{ fontWeight: 700 }}>{formatPercent(champion.benchmark.winRate)}</div>
                            </div>
                            <div>
                              <div style={{ color: "#56635a", fontSize: 12 }}>Avg rank</div>
                              <div style={{ fontWeight: 700 }}>#{champion.benchmark.averageRank.toFixed(1)}</div>
                            </div>
                          </div>

                          <div style={{ display: "grid", gap: 6 }}>
                            <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>
                              Top levers (latest importance run)
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
                                No importance data yet for this player count.
                              </div>
                            )}
                          </div>
                        </>
                      ) : (
                        <div style={{ color: "#56635a", fontSize: 13 }}>
                          No champion promoted yet for {playerCount}-player games.
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </details>

            <details
              open
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 12,
              }}
            >
              <summary style={{ cursor: "pointer", fontWeight: 700, color: "#223024", listStylePosition: "inside" }}>
                Lever impact by player count
              </summary>
              <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                Shows the lever importance snapshot from each <strong>promoted champion</strong>. Pick a player
                count to see which levers matter most — and how much removing each one costs in passengers,
                score, and win rate.
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
                <>
                  {selectedModeComparison.champion && (
                    <div style={{ color: "#56635a", fontSize: 13 }}>
                      Champion promoted at cycle {selectedModeComparison.champion.cycle} · {new Date(selectedModeComparison.champion.updatedAt).toLocaleString()}
                    </div>
                  )}
                  <LeverImpactComparisonChart
                    rows={selectedModeImpactRows}
                    title={`${selectedModeImpactPlayerCount}-player champion lever impact`}
                  />
                </>
              ) : (
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  No champion promoted yet for {selectedModeImpactPlayerCount}-player games.
                </div>
              )}
            </details>

            <AllChampionsLeverChart rowsByPlayerCount={allChampionsLeverRows} />

            <details
              open
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                background: "#ffffff",
                padding: 14,
                display: "grid",
                gap: 10,
              }}
            >
              <summary style={{ cursor: "pointer", fontWeight: 700, color: "#223024", listStylePosition: "inside" }}>
                Estimated profitable city links
              </summary>
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
            </details>

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
      </div>
    </div>
  )
}
