import { useEffect, useMemo, useState } from "react"
import { BOT_PRESETS } from "./bots/presets"
import type {
  ScriptedBotTrainingHistoryEntry,
  ScriptedBotTrainingResults,
} from "./bots/training"
import {
  cancelTraining,
  fetchTrainingImportance,
  fetchTrainingPresets,
  fetchTrainingStatus,
  getDefaultSessionServerUrl,
  promoteTrainingPreset,
  startTrainingImportance,
  type TrainingImportanceStatus,
  startTraining,
  type TrainingPresetStatus,
  type TrainingStartRequest,
  type TrainingStatus,
} from "./network/sessionSync"

type MetricPoint = {
  label: string
  value: number
}

type LeverImpactMetricKey = "passengerDrop" | "scoreDrop" | "winRateDrop"

type LeverImpactChartRow = {
  key: string
  label: string
  group: string
  delta: number
  lowExplanation: string
  highExplanation: string
  passengerDrop: number | null
  scoreDrop: number | null
  winRateDrop: number | null
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
  return Number.isFinite(value) ? value.toFixed(digits) : "—"
}

function formatWeightDelta(delta: number) {
  const rounded = Number(delta.toFixed(3))
  return `${rounded > 0 ? "+" : ""}${rounded}`
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

function LineChart({ title, points, color, suffix = "" }: { title: string; points: MetricPoint[]; color: string; suffix?: string }) {
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
          {formatMetric(points[points.length - 1]?.value ?? 0)}{suffix}
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
  const digits = LEVER_IMPACT_METRICS[metric].digits
  const rounded = Number(value.toFixed(digits))
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(digits)}`
}

function LeverImpactChart({
  rows,
  metric,
  onMetricChange,
}: {
  rows: LeverImpactChartRow[]
  metric: LeverImpactMetricKey
  onMetricChange: (metric: LeverImpactMetricKey) => void
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
        <strong>Lever impact graph</strong>
        <div style={{ color: "#56635a", lineHeight: 1.45 }}>
          {metricConfig.description} Green bars helped. Red bars mean the trained value is probably hurting that metric.
        </div>
      </div>

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

      {chartRows.length > 0 ? (
        <div style={{ display: "grid", gap: 8, maxHeight: 620, overflowY: "auto", paddingRight: 4 }}>
          {chartRows.map(row => {
            const barWidth = `${(Math.abs(row.value) / maxMagnitude) * 50}%`
            const isPositive = row.value >= 0
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
                  {row.lowExplanation}
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
                  {row.highExplanation}
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

export default function TrainingApp() {
  const defaultServerUrl = getDefaultSessionServerUrl()
  const [results, setResults] = useState<ScriptedBotTrainingResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null)
  const [trainingPresets, setTrainingPresets] = useState<TrainingPresetStatus | null>(null)
  const [trainingImportance, setTrainingImportance] = useState<TrainingImportanceStatus | null>(null)
  const [trainingRequest, setTrainingRequest] = useState<TrainingStartRequest>({
    iterations: 10,
    gamesPerCandidate: 8,
    baseSeed: 1,
    candidatesPerIteration: 6,
    mutationSeed: 1,
    maxSteps: 2000,
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isPromotingPreset, setIsPromotingPreset] = useState(false)
  const [importanceRequestedForRun, setImportanceRequestedForRun] = useState<string | null>(null)
  const [selectedImpactMetric, setSelectedImpactMetric] = useState<LeverImpactMetricKey>("passengerDrop")

  useEffect(() => {
    let cancelled = false

    async function reloadData() {
      const [resultsResponse, statusResponse, presetsResponse, importanceResponse] = await Promise.allSettled([
        fetch(`/training-results/latest.json?tick=${Date.now()}-${refreshNonce}`, {
          cache: "no-store",
        }),
        fetchTrainingStatus(defaultServerUrl),
        fetchTrainingPresets(defaultServerUrl),
        fetchTrainingImportance(defaultServerUrl),
      ])

      if (cancelled) {
        return
      }

      if (statusResponse.status === "fulfilled") {
        setTrainingStatus(statusResponse.value)
      } else {
        setError(statusResponse.reason instanceof Error ? statusResponse.reason.message : "Could not reach the training endpoint.")
      }

      if (presetsResponse.status === "fulfilled") {
        setTrainingPresets(presetsResponse.value)
      }

      if (importanceResponse.status === "fulfilled") {
        setTrainingImportance(importanceResponse.value)
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

    setImportanceRequestedForRun(results.generatedAt)
    void startTrainingImportance(defaultServerUrl)
      .then(nextImportance => {
        setTrainingImportance(nextImportance)
      })
      .catch(error => {
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
    if (!results) {
      return []
    }

    const importanceByKey = new Map(
      trainingImportance?.result?.sourceTrainingGeneratedAt === results.generatedAt
        ? trainingImportance.result.rows.map(row => [row.key, row] as const)
        : [],
    )

    return Object.entries(results.final.weights)
      .map(([key, finalValue]) => {
        const baselineValue = results.baseline.weights[key as keyof typeof results.baseline.weights]
        const importance = importanceByKey.get(key as keyof typeof results.final.weights)
        return {
          key,
          baselineValue,
          finalValue,
          delta: finalValue - baselineValue,
          importanceRank: importance?.rank ?? null,
          passengerDrop: importance?.passengerDrop ?? null,
          scoreDrop: importance?.scoreDrop ?? null,
          winRateDrop: importance?.winRateDrop ?? null,
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
  }, [results, trainingImportance])
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
                    onChange={event => handleTrainingRequestChange(field, Math.max(1, Number(event.target.value) || 1))}
                    disabled={trainingStatus?.isRunning || isSubmitting}
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
                disabled={trainingStatus?.isRunning || isSubmitting}
                style={{
                  borderRadius: 999,
                  border: "1px solid #223024",
                  background: trainingStatus?.isRunning ? "#c7d0c4" : "#223024",
                  color: "#ffffff",
                  padding: "10px 16px",
                  fontWeight: 700,
                  cursor: trainingStatus?.isRunning ? "not-allowed" : "pointer",
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
                      {managedPreset ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Passengers</div>
                            <div style={{ fontWeight: 700 }}>{formatMetric(managedPreset.sourceSummary.averagePassengers)}</div>
                          </div>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Win rate</div>
                            <div style={{ fontWeight: 700 }}>{formatMetric(managedPreset.sourceSummary.winRate)}</div>
                          </div>
                          <div>
                            <div style={{ color: "#56635a", fontSize: 12 }}>Score</div>
                            <div style={{ fontWeight: 700 }}>{formatMetric(managedPreset.sourceSummary.score)}</div>
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
              {[
                ["Baseline passengers", results.baseline.averagePassengers],
                ["Final passengers", results.final.averagePassengers],
                ["Final win rate", results.final.winRate],
                ["Final timeout rate", results.final.timeoutRate],
                ["Iterations", results.history.length],
                ["Games / candidate", results.config.gamesPerCandidate],
              ].map(([label, value]) => (
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
                  <strong style={{ fontSize: 24 }}>{typeof value === "number" ? formatMetric(value) : value}</strong>
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
              <LineChart title="Score" points={scoreSeries} color="#1d5d76" />
              <LineChart title="Passengers moved" points={passengerSeries} color="#2a7f3b" />
              <LineChart title="Win rate" points={winRateSeries} color="#8a5a00" />
              <LineChart title="Timeout rate" points={timeoutSeries} color="#9b1c1c" />
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
                    ? `Importance reference score ${formatMetric(trainingImportance?.result?.reference.score ?? 0)} on ${trainingImportance?.result?.config.gamesPerCandidate ?? 0} games.`
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
                          {row.passengerDrop === null ? "—" : formatMetric(row.passengerDrop)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.scoreDrop === null ? "—" : formatMetric(row.scoreDrop)}
                        </td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #edf2ec" }}>
                          {row.winRateDrop === null ? "—" : formatMetric(row.winRateDrop, 3)}
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
