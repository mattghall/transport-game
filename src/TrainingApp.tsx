import { useEffect, useMemo, useState } from "react"
import { BOT_PRESETS } from "./bots/presets"
import type {
  ScriptedBotLeverImportanceResults,
  ScriptedBotTrainingHistoryEntry,
  ScriptedBotTrainingResults,
} from "./bots/training"
import {
  fetchAutotuneStatus,
  cancelTraining,
  fetchTrainingImportance,
  fetchTrainingPresets,
  fetchTrainingStatus,
  getDefaultSessionServerUrl,
  promoteTrainingPreset,
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

type MetricPoint = {
  label: string
  value: number
}

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
  playerCount: 2 | 3 | 4
  results: ScriptedBotTrainingResults | null
  importance: ScriptedBotLeverImportanceResults | null
}

type AutotuneStatus = {
  version: 1
  startedAt: string
  updatedAt: string
  cycle: number
  modeCycles: Record<"2p" | "3p" | "4p", number>
  currentRun: null | {
    cycle: number
    playerCount: 2 | 3 | 4
    modeCycle: number
    profile: "refine" | "explore" | "deep"
    startedFromScratch: boolean
    opponent: "default" | "champion"
    startedAt: string
  }
  recentRuns: Array<{
    cycle: number
    playerCount: 2 | 3 | 4
    modeCycle: number
    profile: "refine" | "explore" | "deep"
    startedFromScratch: boolean
    opponent: "default" | "champion"
    promoted: boolean
    benchmarkScore: number
    generatedAt: string
    final: {
      score: number
      winRate: number
      averagePassengers: number
      averageRank: number
      sampleCount: number
    }
  }>
}

const REFRESH_MS = 3000
const TRAINING_PLAYER_COUNT_OPTIONS = [2, 3, 4] as const

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
  const [isPromotingPreset, setIsPromotingPreset] = useState(false)
  const [importanceRequestedForRun, setImportanceRequestedForRun] = useState<string | null>(null)
  const [selectedImpactMetric, setSelectedImpactMetric] = useState<LeverImpactMetricKey>("passengerDrop")
  const [selectedModeImpactPlayerCount, setSelectedModeImpactPlayerCount] = useState<2 | 3 | 4>(4)

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

    if (importanceRequestedForRun === results.generatedAt) {
      return
    }

    const targetRun = results.generatedAt
    setImportanceRequestedForRun(targetRun)
    void startTrainingImportance(defaultServerUrl)
      .then(nextImportance => {
        setImportanceRequestedForRun(current => (current === targetRun ? null : current))
        setTrainingImportance(nextImportance)
        setError(null)
      })
      .catch(error => {
        window.setTimeout(() => {
          setImportanceRequestedForRun(current => (current === targetRun ? null : current))
        }, REFRESH_MS)
        setError(
          error instanceof Error
            ? error.message
            : "Could not start lever importance analysis.",
        )
      })
  }, [defaultServerUrl, importanceRequestedForRun, results, trainingImportance, trainingStatus?.isRunning])

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

  async function handlePromotePreset(presetId: "bot-avg" | "bot-best") {
    setIsPromotingPreset(true)

    try {
      const nextPresets = await promoteTrainingPreset(defaultServerUrl, { presetId })
      setTrainingPresets(nextPresets)
      setRefreshNonce(current => current + 1)
      setError(null)
    } catch (promotionError) {
      setError(
        promotionError instanceof Error
          ? promotionError.message
          : `Could not overwrite the ${presetId === "bot-best" ? "Stickbug" : "Malcolm Gladwell"} preset.`,
      )
    } finally {
      setIsPromotingPreset(false)
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
  const profitableCityLinks = useMemo(() => buildEstimatedCityLinkProfitabilityRows(20), [])
  const managedAveragePreset = trainingPresets?.presets["bot-avg"] ?? null
  const managedBestPreset = trainingPresets?.presets["bot-best"] ?? null
  const hasCurrentImportance =
    trainingImportance?.result?.sourceTrainingGeneratedAt === results?.generatedAt

  return (
    <div
      style={{
        minHeight: "100%",
        background: "#edf2ec",
        color: "#223024",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 1320,
          margin: "0 auto",
          padding: 24,
          display: "grid",
          gap: 16,
        }}
      >
        <div
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
              and ending Operations sooner. Final passengers moved are the dominant training signal.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(320px, 420px) minmax(320px, 1fr)",
            gap: 12,
          }}
        >
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 12,
              padding: 14,
              background: "#ffffff",
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <strong>Start a training run</strong>
              <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                This page talks to the local session server at <code>{defaultServerUrl}</code>. The run
                stays local, writes <code>public/training-results/latest.json</code>, and this dashboard
                refreshes every 3 seconds.
              </div>
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
                          ? Math.min(4, Math.max(2, Number(event.target.value) || 4))
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={handleStartAutotune}
                disabled={
                  trainingStatus?.isRunning ||
                  autotuneControlStatus?.isRunning ||
                  autotuneControlStatus?.status === "stopping" ||
                  autotuneControlStatus?.status === "unknown" ||
                  isSubmitting
                }
                style={{
                  borderRadius: 999,
                  border: "1px solid #24527a",
                  background:
                    trainingStatus?.isRunning ||
                    autotuneControlStatus?.isRunning ||
                    autotuneControlStatus?.status === "stopping" ||
                    autotuneControlStatus?.status === "unknown"
                      ? "#d9e3ee"
                      : "#24527a",
                  color: "#ffffff",
                  padding: "10px 16px",
                  fontWeight: 700,
                  cursor:
                    trainingStatus?.isRunning ||
                    autotuneControlStatus?.isRunning ||
                    autotuneControlStatus?.status === "stopping" ||
                    autotuneControlStatus?.status === "unknown"
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                Start autotune
              </button>
              <button
                type="button"
                onClick={handleStopAutotune}
                disabled={!autotuneControlStatus?.isRunning || autotuneControlStatus?.status === "stopping" || isSubmitting}
                style={{
                  borderRadius: 999,
                  border: "1px solid #8a1f1f",
                  background:
                    autotuneControlStatus?.isRunning && autotuneControlStatus?.status !== "stopping" ? "#fff4f4" : "#f8faf8",
                  color: "#8a1f1f",
                  padding: "10px 16px",
                  fontWeight: 700,
                  cursor:
                    autotuneControlStatus?.isRunning && autotuneControlStatus?.status !== "stopping" ? "pointer" : "not-allowed",
                }}
              >
                Stop autotune after cycle
              </button>
            </div>
            <div style={{ color: "#56635a", fontSize: 13, lineHeight: 1.45 }}>
              {autotuneControlStatus?.status === "stopping"
                ? "Autotune has been told to stop after the current cycle finishes."
                : autotuneControlStatus?.status === "unknown"
                  ? "The session server found an autotune status file that still shows a running cycle. Wait for it to clear before starting a new autotune loop."
                : autotuneControlStatus?.isRunning
                  ? "Autotune is running, so one-shot training controls are locked."
                  : "Use autotune for continuous 2p/3p/4p training, or start a one-shot run with the controls above."}
            </div>
            {error && <div style={{ color: "#9b1c1c", fontWeight: 700 }}>{error}</div>}
          </div>

          <div
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
              <span style={{ fontWeight: 700, color: trainingStatus?.isRunning ? "#24613a" : "#56635a" }}>
                {trainingStatus?.status ?? "unavailable"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
              <div>
                <div style={{ color: "#56635a", fontSize: 13 }}>PID</div>
                <div>{trainingStatus?.pid ?? "—"}</div>
              </div>
              <div>
                <div style={{ color: "#56635a", fontSize: 13 }}>Started</div>
                <div>{trainingStatus?.startedAt ? new Date(trainingStatus.startedAt).toLocaleString() : "—"}</div>
              </div>
              <div>
                <div style={{ color: "#56635a", fontSize: 13 }}>Finished</div>
                <div>{trainingStatus?.finishedAt ? new Date(trainingStatus.finishedAt).toLocaleString() : "—"}</div>
              </div>
              <div>
                <div style={{ color: "#56635a", fontSize: 13 }}>Exit</div>
                <div>
                  {trainingStatus?.exitCode ?? "—"}
                  {trainingStatus?.signal ? ` (${trainingStatus.signal})` : ""}
                </div>
              </div>
            </div>
            <div style={{ color: "#56635a", fontSize: 13 }}>
              Latest result file: <code>{trainingStatus?.outputPath ?? "public/training-results/latest.json"}</code>
            </div>
            <div
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
              {(trainingStatus?.logs?.length ?? 0) > 0
                ? trainingStatus?.logs.join("\n")
                : "No training logs yet."}
            </div>
            {results && (
              <div style={{ color: "#56635a", fontSize: 13 }}>
                Last updated {new Date(results.generatedAt).toLocaleString()} • maxSteps {results.config.maxSteps}
              </div>
            )}
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
            <strong>Autotune loop</strong>
            <div style={{ color: "#56635a", lineHeight: 1.45 }}>
              This watches the always-on bot trainer that rotates through 2-player, 3-player, and 4-player runs.
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

            <div
              style={{
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

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>Per-mode cycles</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
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

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ color: "#56635a", fontSize: 12, fontWeight: 700 }}>Recent autotune runs</div>
              <div style={{ color: "#56635a", fontSize: 12 }}>
                Updated {autotuneStatus?.updatedAt ? new Date(autotuneStatus.updatedAt).toLocaleString() : "—"}
              </div>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {(autotuneStatus?.recentRuns.length ?? 0) > 0 ? (
                autotuneStatus?.recentRuns.slice(0, 6).map(run => (
                  <div
                    key={`autotune-run-${run.cycle}`}
                    style={{
                      border: "1px solid #d8dfd5",
                      borderRadius: 10,
                      background: "#fbfcfb",
                      padding: 10,
                      display: "grid",
                      gap: 4,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <strong>
                        Cycle {run.cycle} • {run.playerCount}-player • {run.profile}
                      </strong>
                      <span style={{ fontWeight: 700, color: run.promoted ? "#2a7f3b" : "#56635a" }}>
                        {run.promoted ? "Champion improved" : "No promotion"}
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
                      <div>Passengers: <strong>{formatWholeNumber(run.final.averagePassengers)}</strong></div>
                      <div>Win rate: <strong>{formatPercent(run.final.winRate)}</strong></div>
                      <div>Score: <strong>{formatWholeNumber(run.final.score)}</strong></div>
                      <div>Benchmark: <strong>{formatWholeNumber(run.benchmarkScore)}</strong></div>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  No autotune runs recorded yet.
                </div>
              )}
            </div>
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
            <strong>Playable bot presets</strong>
            <div style={{ color: "#56635a", lineHeight: 1.45 }}>
              These are the presets the game can use right now. Promoting the latest training run overwrites
              the managed <strong>Stickbug</strong> or <strong>Malcolm Gladwell</strong> slot for future games without editing source files.
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
              const managedPresetId =
                preset.id === "bot-best"
                  ? "bot-best"
                  : preset.id === "bot-avg"
                    ? "bot-avg"
                    : null
              const managedPreset =
                preset.id === "bot-best"
                  ? managedBestPreset
                  : preset.id === "bot-avg"
                    ? managedAveragePreset
                    : null
              const managedPresetSource = managedPreset ? "Managed file" : "Built-in fallback"
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
                          {managedPreset
                            ? "Current playable preset summary"
                            : fallbackSummary
                              ? "Using current training baseline/final as the built-in comparison"
                              : "Run training once to populate comparison stats"}
                        </div>
                      </div>
                      {managedPreset ? (
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
                      <button
                        type="button"
                        onClick={() => managedPresetId ? void handlePromotePreset(managedPresetId) : undefined}
                        disabled={isSubmitting || isPromotingPreset || trainingStatus?.isRunning || !results}
                        style={{
                          borderRadius: 999,
                          border: "1px solid #24527a",
                          background:
                            isSubmitting || isPromotingPreset || trainingStatus?.isRunning || !results
                              ? "#d9e3ee"
                              : "#24527a",
                          color: "#ffffff",
                          padding: "10px 16px",
                          fontWeight: 700,
                          cursor:
                            isSubmitting || isPromotingPreset || trainingStatus?.isRunning || !results
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        Overwrite {preset.label} with latest training results
                      </button>
                      <div style={{ color: "#56635a", fontSize: 13 }}>
                        {trainingStatus?.isRunning
                          ? "Finish the active training run before promoting."
                          : results
                            ? `Latest completed run: ${new Date(results.generatedAt).toLocaleString()}`
                            : "Run training once to make the current results promotable."}
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
                  These cards compare the latest saved training run for each player count. Passenger delta is the
                  best cross-mode comparison. Raw score is shown for reference, but it is not directly comparable
                  across 2-player, 3-player, and 4-player games.
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
                Training score is intentionally passenger-first:
                <code> passengers + winRate*15000 - averageRank*2500 + connectedCities*125 + money/1,000,000 - timeoutRate*250,000</code>.
                That means the trainer mainly rewards total passengers moved by the end of the game, while still breaking close calls with
                wins, standings, network size, money, and whether the bot actually finishes.
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
          </>
        )}
      </div>
    </div>
  )
}
