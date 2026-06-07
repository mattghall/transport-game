import { useEffect, useMemo, useRef, useState } from "react"
import type { ScriptedBotTrainingResults } from "./bots/training"
import {
  fetchTrainingImportance,
  fetchTrainingPresets,
  fetchTrainingStatus,
  getDefaultSessionServerUrl,
  startTraining,
  startTrainingImportance,
  stopTraining,
  type TrainingImportanceStatus,
  type TrainingStartRequest,
  type TrainingStatus,
} from "./network/sessionSync"
import {
  buildLeverImpactRows,
  buildMetricSeries,
  fetchOptionalJson,
  formatMetric,
  formatPercent,
  formatWeightDelta,
  formatWholeDelta,
  formatWholeNumber,
  LeverImpactChart,
  LineChart,
  type LeverImpactMetricKey,
} from "./trainingHelpers"

const REFRESH_MS = 3000

function IterationProgressBar({
  label,
  progress,
  color,
  idPrefix,
}: {
  label: string
  progress: TrainingStatus["progress"]
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

export default function ManualTrainingApp() {
  const serverUrl = getDefaultSessionServerUrl()
  const [results, setResults] = useState<ScriptedBotTrainingResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(null)
  const [trainingImportance, setTrainingImportance] = useState<TrainingImportanceStatus | null>(null)
  const [trainingRequest, setTrainingRequest] = useState<TrainingStartRequest>({
    iterations: 10,
    gamesPerCandidate: 8,
    playerCount: 4,
    baseSeed: 1,
    candidatesPerIteration: 6,
    mutationSeed: 1,
    maxSteps: 2000,
  })
  const [isTrainingSubmitting, setIsTrainingSubmitting] = useState(false)
  const [selectedImpactMetric, setSelectedImpactMetric] = useState<LeverImpactMetricKey>("passengerDrop")
  const importanceRequestedForRunRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function reloadData() {
      const tick = `${Date.now()}-${refreshNonce}`
      void fetchTrainingPresets(serverUrl).catch(() => null)
      const [resultsResponse, statusResponse, importanceResponse] = await Promise.allSettled([
        fetchOptionalJson<ScriptedBotTrainingResults>(`/training-results/latest.json?tick=${tick}`),
        fetchTrainingStatus(serverUrl),
        fetchTrainingImportance(serverUrl),
      ])

      if (cancelled) {
        return
      }

      if (statusResponse.status === "fulfilled") {
        setTrainingStatus(statusResponse.value)
      } else {
        setError(
          statusResponse.reason instanceof Error
            ? statusResponse.reason.message
            : "Could not reach the training endpoint.",
        )
      }

      if (importanceResponse.status === "fulfilled") {
        setTrainingImportance(importanceResponse.value)
      }

      if (resultsResponse.status === "fulfilled" && resultsResponse.value) {
        setResults(resultsResponse.value)
        if (statusResponse.status === "fulfilled") {
          setError(null)
        }
        return
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
  }, [refreshNonce, serverUrl])

  useEffect(() => {
    if (!results || trainingStatus?.isRunning || trainingImportance?.isRunning) {
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
    void startTrainingImportance(serverUrl)
      .then(nextImportance => {
        if (importanceRequestedForRunRef.current === targetRun) {
          importanceRequestedForRunRef.current = null
        }
        setTrainingImportance(nextImportance)
        setError(null)
      })
      .catch(nextError => {
        window.setTimeout(() => {
          if (importanceRequestedForRunRef.current === targetRun) {
            importanceRequestedForRunRef.current = null
          }
        }, REFRESH_MS)
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Could not start lever importance analysis.",
        )
      })
  }, [results, serverUrl, trainingImportance, trainingStatus?.isRunning])

  async function handleStartTraining() {
    setIsTrainingSubmitting(true)
    try {
      const nextStatus = await startTraining(serverUrl, trainingRequest)
      setTrainingStatus(nextStatus)
      setError(null)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start training.")
    } finally {
      setIsTrainingSubmitting(false)
    }
  }

  async function handleCancelTraining() {
    setIsTrainingSubmitting(true)
    try {
      const nextStatus = await stopTraining(serverUrl)
      setTrainingStatus(nextStatus)
      setError(null)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Could not cancel training.")
    } finally {
      setIsTrainingSubmitting(false)
    }
  }

  function handleTrainingRequestChange(field: keyof TrainingStartRequest, value: number) {
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
  const currentImportance =
    trainingImportance?.result?.sourceTrainingGeneratedAt === results?.generatedAt
      ? (trainingImportance?.result ?? null)
      : null
  const hasCurrentImportance = currentImportance !== null
  const weightRows = useMemo(
    () => buildLeverImpactRows(results, currentImportance),
    [currentImportance, results],
  )

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
            <h1 style={{ margin: 0, fontSize: 28 }}>Manual training dashboard</h1>
            <div style={{ color: "#56635a", maxWidth: 820, lineHeight: 1.45 }}>
              Run one-shot scripted bot training jobs on demand. These controls write the latest manual result to
              <code> public/training-results/latest.json</code> without changing the continuous autotune page.
            </div>
          </div>
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
              href="/training.html"
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
              ← Bot training
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
          </div>
        </div>

        <div
          id="manual-training-controls"
          style={{
            border: "1px solid #d8dfd5",
            borderRadius: 12,
            padding: 14,
            background: "#ffffff",
            display: "grid",
            gap: 10,
          }}
        >
          <strong style={{ color: "#223024" }}>Training parameters</strong>
          <div style={{ color: "#56635a", lineHeight: 1.45, fontSize: 13 }}>
            This page talks to the local session server at <code>{serverUrl}</code>. Manual runs write
            <code> public/training-results/latest.json</code>.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
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
                  disabled={trainingStatus?.isRunning || isTrainingSubmitting}
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
              onClick={() => void handleStartTraining()}
              disabled={trainingStatus?.isRunning || isTrainingSubmitting}
              style={{
                borderRadius: 999,
                border: "1px solid #223024",
                background: trainingStatus?.isRunning || isTrainingSubmitting ? "#c7d0c4" : "#223024",
                color: "#ffffff",
                padding: "10px 16px",
                fontWeight: 700,
                cursor: trainingStatus?.isRunning || isTrainingSubmitting ? "not-allowed" : "pointer",
              }}
            >
              Start training
            </button>
            <button
              type="button"
              onClick={() => void handleCancelTraining()}
              disabled={!trainingStatus?.isRunning || isTrainingSubmitting}
              style={{
                borderRadius: 999,
                border: "1px solid #c97a7a",
                background: trainingStatus?.isRunning ? "#fff4f4" : "#f8faf8",
                color: "#8a1f1f",
                padding: "10px 16px",
                fontWeight: 700,
                cursor: trainingStatus?.isRunning && !isTrainingSubmitting ? "pointer" : "not-allowed",
              }}
            >
              Cancel training
            </button>
          </div>
        </div>

        {error && <div style={{ color: "#9b1c1c", fontWeight: 700 }}>{error}</div>}

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
              {(trainingStatus.logs?.length ?? 0) > 0 ? trainingStatus.logs.join("\n") : "No training logs yet."}
            </div>
            {results && (
              <div style={{ color: "#56635a", fontSize: 13 }}>
                Last updated {new Date(results.generatedAt).toLocaleString()} • maxSteps {results.config.maxSteps}
              </div>
            )}
          </div>
        ) : null}

        {results && (
          <>
            <div style={{ color: "#56635a", fontSize: 13 }}>
              Last updated {new Date(results.generatedAt).toLocaleString()} • maxSteps {results.config.maxSteps}
            </div>
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
                    {label.toLowerCase().includes("rate")
                      ? formatPercent(value)
                      : label.toLowerCase().includes("lead")
                        ? formatWholeDelta(value)
                        : formatWholeNumber(value)}
                  </strong>
                </div>
              ))}
            </div>

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
                Last manual training run
              </summary>
              <div style={{ color: "#56635a", lineHeight: 1.45 }}>
                These charts show how the best candidate improved iteration-by-iteration during the <strong>last manually
                triggered training run</strong> (from <code>latest.json</code>). Each point is the best candidate found
                so far in that run — not autotune cycles. Point 0 is the baseline (default bot).
              </div>

              <div
                style={{
                  border: "1px solid #d8dfd5",
                  borderRadius: 8,
                  background: "#f6f8f6",
                  padding: "10px 14px",
                }}
              >
                <strong style={{ fontSize: 13 }}>Score model: </strong>
                <code style={{ fontSize: 12 }}>
                  passengers + passengerLead + winRate×5000 − avgRank×1000 + connectedCities×50 − timeoutRate×250,000
                </code>
                <div style={{ color: "#56635a", fontSize: 12, marginTop: 4 }}>
                  End-of-game cash is not scored — bots should spend money, not hoard it. In 1-player runs,
                  passengerLead is weighted at 0.1× to avoid double-counting.
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
            </details>

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
                Weight changes
              </summary>
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
            </details>
          </>
        )}
      </div>
    </div>
  )
}
