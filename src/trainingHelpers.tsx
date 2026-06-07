/* eslint-disable react-refresh/only-export-components */

import type {
  ScriptedBotLeverImportanceResults,
  ScriptedBotTrainingHistoryEntry,
  ScriptedBotTrainingResults,
} from "./bots/training"
export type MetricPoint = {
  label: string
  value: number
}

export type LeverImpactMetricKey = "passengerDrop" | "scoreDrop" | "winRateDrop"

export type LeverImpactChartRow = {
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
  baselineValue: number
  finalValue: number
  importanceRank: number | null
}

type WeightLabelInfo = {
  label: string
  description: string
  group: string
  lowExplanation: string
  highExplanation: string
}

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

export const WEIGHT_LABELS: Record<string, WeightLabelInfo> = {
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
  podSplitBaseScore: {
    label: "Pod creation base score",
    description: "Baseline appetite for creating an extra pod inside an existing city-link network.",
    group: "Pod planning",
    lowExplanation: "Only split the network into pods when the resulting service shape is clearly better.",
    highExplanation: "Look aggressively for extra pod opportunities inside the same network.",
  },
  podCityCountScore: {
    label: "Pod size preference",
    description: "How much the bot values pods that cover more cities.",
    group: "Pod planning",
    lowExplanation: "Keep pods tight and selective instead of stretching them wider.",
    highExplanation: "Favor larger pods that can touch more cities in one service pattern.",
  },
  podPopulationPerMillionScore: {
    label: "Pod big-city preference",
    description: "How much the bot values total city population inside a pod.",
    group: "Pod planning",
    lowExplanation: "A pod can be worthwhile even without the very biggest cities.",
    highExplanation: "Load pods with the biggest cities available in the network.",
  },
  podPopulationPerDistanceScore: {
    label: "Pod population-per-distance preference",
    description: "How much the bot prefers pods that pack more population into fewer miles.",
    group: "Pod planning",
    lowExplanation: "Longer pods are acceptable if they still fit the network well.",
    highExplanation: "Prefer dense pods where city population is high relative to the route distance.",
  },
  podDemandScore: {
    label: "Pod demand preference",
    description: "How much the bot values pods with stronger movable demand.",
    group: "Pod planning",
    lowExplanation: "Pod structure matters even when immediate demand is modest.",
    highExplanation: "Pods should chase the corridors with the strongest available demand.",
  },
  podDemandPerMileScore: {
    label: "Pod demand-per-mile preference",
    description: "How much the bot prefers pods where demand is concentrated into fewer miles (high pax/mi efficiency).",
    group: "Pod planning",
    lowExplanation: "Distance is not a major concern — pods with spread-out cities are fine.",
    highExplanation: "Prefer compact pods with lots of demand per mile of track.",
  },
  podNetRevenueScore: {
    label: "Pod net-revenue preference",
    description: "How much the bot values pods that produce stronger net operating revenue.",
    group: "Pod planning",
    lowExplanation: "A pod can still be worth it without maximizing immediate net revenue.",
    highExplanation: "Prefer pods that are projected to earn the most after costs.",
  },
  podAdditionalRoutePenalty: {
    label: "Extra pod penalty",
    description: "How much the bot avoids creating too many pods in the same corridor.",
    group: "Pod planning",
    lowExplanation: "Split freely if extra pods look useful.",
    highExplanation: "Stay disciplined and only add another pod when it clearly pays off.",
  },
  podRemoveCityBaseScore: {
    label: "Pod city removal base score",
    description: "Baseline score for removing a zero-demand city from a pod into the disconnected slot. Cities that would reduce total network passengers are never removed.",
    group: "Pod planning",
    lowExplanation: "Only remove a dead-weight city when efficiency gains are large.",
    highExplanation: "Lean toward removing zero-demand cities even without large efficiency gains.",
  },
  podRemovePassengersPerDistanceGainScore: {
    label: "Removal passengers-per-mile gain score",
    description: "How much the bot values improvement in passengers per mile when evaluating removing a city from a pod.",
    group: "Pod planning",
    lowExplanation: "Passengers-per-mile improvement barely influences removal decisions.",
    highExplanation: "Strongly prefer removing cities that drag down the pod's passengers-per-mile ratio.",
  },
  podRemoveNetRevenueGainScore: {
    label: "Removal net revenue gain score",
    description: "How much the bot values improvement in pod net revenue per $1M when evaluating removing a city.",
    group: "Pod planning",
    lowExplanation: "Revenue improvement alone is not enough to justify removing a city.",
    highExplanation: "Removing cities that cost more to serve than they earn is a strong signal.",
  },
}

export function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function formatMetric(value: number, digits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "—"
}

export function formatWholeNumber(value: number) {
  return Number.isFinite(value) ? Math.trunc(value).toLocaleString("en-US") : "—"
}

export function formatPercent(value: number) {
  return Number.isFinite(value) ? `${Math.round(value * 100).toLocaleString("en-US")}%` : "—"
}

export function formatWeightDelta(delta: number) {
  if (!Number.isFinite(delta)) {
    return "—"
  }

  return `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  })}`
}

export function formatWholeDelta(delta: number) {
  if (!Number.isFinite(delta)) {
    return "—"
  }

  const truncated = Math.trunc(delta)
  return `${truncated > 0 ? "+" : ""}${truncated.toLocaleString("en-US")}`
}

export function formatPercentDelta(delta: number) {
  if (!Number.isFinite(delta)) {
    return "—"
  }

  const roundedPercent = Math.round(delta * 100)
  return `${roundedPercent > 0 ? "+" : ""}${roundedPercent.toLocaleString("en-US")}%`
}

export function getDeltaColor(delta: number | null) {
  if (delta === null || !Number.isFinite(delta) || delta === 0) {
    return "#56635a"
  }

  return delta > 0 ? "#1f6f43" : "#9b1c1c"
}

export async function fetchOptionalJson<T>(path: string) {
  const response = await fetch(path, {
    cache: "no-store",
  })

  if (!response.ok) {
    return null
  }

  return (await response.json()) as T
}

export function buildMetricSeries(
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

export function LineChart({
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

export function buildLeverImpactRows(
  results: ScriptedBotTrainingResults | null,
  importance: ScriptedBotLeverImportanceResults | null,
  { skipTimestampCheck = false } = {},
) {
  if (!results) {
    return []
  }

  const importanceByKey = new Map(
    importance && (skipTimestampCheck || importance.sourceTrainingGeneratedAt === results.generatedAt)
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

export function LeverImpactChart({
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
        {title}
      </summary>
      <div style={{ color: "#56635a", lineHeight: 1.45 }}>
        {metricConfig.description} Green bars helped. Red bars mean the trained value is probably hurting that metric.
        The right-side explanation always shows the direction that helps the selected metric more.
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
    </details>
  )
}

export function LeverImpactComparisonChart({
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

const PLAYER_COUNT_COLORS: Record<number, { bar: string; label: string }> = {
  1: { bar: "#3b82c4", label: "1p" },
  2: { bar: "#2a7f3b", label: "2p" },
  3: { bar: "#c47a1a", label: "3p" },
  4: { bar: "#8b3ab8", label: "4p" },
}

export function AllChampionsLeverChart({
  rowsByPlayerCount,
}: {
  rowsByPlayerCount: Partial<Record<number, LeverImpactChartRow[]>>
}) {
  const playerCounts = [1, 2, 3, 4].filter(pc => rowsByPlayerCount[pc]?.length)

  // Collect all lever keys that appear in any champion with non-null passengerDrop
  const allKeys = Array.from(
    new Set(
      playerCounts.flatMap(pc =>
        (rowsByPlayerCount[pc] ?? [])
          .filter(r => r.passengerDrop !== null)
          .map(r => r.key),
      ),
    ),
  )

  if (allKeys.length === 0 || playerCounts.length === 0) {
    return (
      <div style={{ color: "#56635a", fontSize: 13 }}>
        No champion importance data available yet.
      </div>
    )
  }

  // Build lookup: key → pc → passengerDrop
  const dropByKeyAndPc: Record<string, Partial<Record<number, number>>> = {}
  for (const pc of playerCounts) {
    for (const row of rowsByPlayerCount[pc] ?? []) {
      if (row.passengerDrop !== null) {
        if (!dropByKeyAndPc[row.key]) dropByKeyAndPc[row.key] = {}
        dropByKeyAndPc[row.key][pc] = row.passengerDrop
      }
    }
  }

  // Sort levers by max passengerDrop across all champions
  const sortedKeys = allKeys.sort((a, b) => {
    const maxA = Math.max(...playerCounts.map(pc => Math.abs(dropByKeyAndPc[a]?.[pc] ?? 0)))
    const maxB = Math.max(...playerCounts.map(pc => Math.abs(dropByKeyAndPc[b]?.[pc] ?? 0)))
    return maxB - maxA
  })

  const maxDrop = Math.max(
    1,
    ...sortedKeys.flatMap(key =>
      playerCounts.map(pc => Math.abs(dropByKeyAndPc[key]?.[pc] ?? 0)),
    ),
  )

  const labelForKey = (key: string) => WEIGHT_LABELS[key]?.label ?? key
  const BAR_HEIGHT = 10
  const BAR_GAP = 3

  return (
    <div style={{ border: "1px solid #d8dfd5", borderRadius: 12, background: "#ffffff", padding: 14, display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <strong>All champions — passenger drop per lever</strong>
        <div style={{ color: "#56635a", lineHeight: 1.45, fontSize: 13 }}>
          How many passengers each champion loses if a lever is removed. Levers sorted by highest impact across any champion.
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {playerCounts.map(pc => (
          <div key={pc} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <div style={{ width: 16, height: 10, borderRadius: 3, background: PLAYER_COUNT_COLORS[pc].bar }} />
            <span>{pc}-player</span>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 600 }}>
          {sortedKeys.map(key => (
            <div
              key={key}
              style={{
                display: "grid",
                gridTemplateColumns: "180px 1fr",
                gap: 8,
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <div style={{ fontSize: 12, color: "#223024", textAlign: "right", paddingRight: 8, lineHeight: 1.3 }}>
                {labelForKey(key)}
              </div>
              <div style={{ display: "grid", gap: BAR_GAP + "px" }}>
                {playerCounts.map(pc => {
                  const drop = dropByKeyAndPc[key]?.[pc] ?? null
                  const width = drop !== null ? Math.abs(drop) / maxDrop * 100 : 0
                  return (
                    <div key={pc} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div
                        style={{
                          height: BAR_HEIGHT,
                          width: `${width}%`,
                          minWidth: drop !== null && drop !== 0 ? 2 : 0,
                          background: PLAYER_COUNT_COLORS[pc].bar,
                          borderRadius: 3,
                          opacity: drop === null ? 0 : 1,
                        }}
                        title={drop !== null ? `${PLAYER_COUNT_COLORS[pc].label}: ${drop.toFixed(0)} passengers` : "no data"}
                      />
                      {drop !== null && (
                        <span style={{ fontSize: 10, color: "#56635a", whiteSpace: "nowrap" }}>
                          {drop.toFixed(0)}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
