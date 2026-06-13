/**
 * Async, parallel wrappers around the bot training evaluation functions.
 * Uses a worker-thread pool to distribute game simulations across all CPU cores.
 */
import { Worker } from "worker_threads"
import { cpus } from "os"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"
import {
  createTrainingPlayers,
  createTrainingSeeds,
  mutateScriptedBotWeights,
  summarizeScriptedBotWeightEvaluation,
  type ScriptedBotLeverImportanceEntry,
  type ScriptedBotLeverImportanceResults,
  type ScriptedBotTrainingRunOptions,
  type ScriptedBotTrainingResults,
  type ScriptedBotWeightEvaluation,
  type ScriptedBotWeightSample,
} from "../src/bots/training.ts"
import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  mergeScriptedBotWeights,
  type ScriptedBotWeights,
} from "../src/bots/scriptedBot.ts"
import {
  MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS,
  FROZEN_SCRIPTED_BOT_WEIGHT_KEYS,
  applyFrozenScriptedBotWeights,
} from "../src/bots/leverMetadata.ts"
import { createInitialRandomState } from "../src/engine/random.ts"
import type { SimWorkerTask, SimWorkerResponse } from "./simulationWorker.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WORKER_FILE = resolve(__dirname, "simulationWorker.ts")
const WORKER_EXEC_ARGS = ["--import", "tsx/esm"]

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

type PoolWorkerEntry = {
  worker: Worker
  busy: boolean
  resolve?: (sample: ScriptedBotWeightSample) => void
  reject?: (err: Error) => void
}

type QueuedTask = {
  task: SimWorkerTask
  resolve: (sample: ScriptedBotWeightSample) => void
  reject: (err: Error) => void
}

export class SimWorkerPool {
  private entries: PoolWorkerEntry[]
  private queue: QueuedTask[]

  constructor(size = Math.max(1, cpus().length - 1)) {
    this.queue = []
    this.entries = Array.from({ length: size }, () => this.spawnWorker())
  }

  private spawnWorker(): PoolWorkerEntry {
    const entry: PoolWorkerEntry = {
      worker: new Worker(WORKER_FILE, { execArgv: WORKER_EXEC_ARGS }),
      busy: false,
    }
    entry.worker.on("message", (msg: SimWorkerResponse) => {
      const { resolve, reject } = entry
      entry.busy = false
      entry.resolve = undefined
      entry.reject = undefined
      if (msg.ok) {
        resolve!(msg.result)
      } else {
        reject!(new Error(msg.error))
      }
      this.drain()
    })
    entry.worker.on("error", err => {
      entry.reject?.(err instanceof Error ? err : new Error(String(err)))
      entry.busy = false
      entry.resolve = undefined
      entry.reject = undefined
      this.drain()
    })
    return entry
  }

  private drain() {
    for (const entry of this.entries) {
      if (!entry.busy && this.queue.length > 0) {
        const queued = this.queue.shift()!
        entry.busy = true
        entry.resolve = queued.resolve
        entry.reject = queued.reject
        entry.worker.postMessage(queued.task)
      }
    }
  }

  run(task: SimWorkerTask): Promise<ScriptedBotWeightSample> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject })
      this.drain()
    })
  }

  get size(): number {
    return this.entries.length
  }

  async terminate(): Promise<void> {
    await Promise.all(this.entries.map(e => e.worker.terminate()))
  }
}

// ---------------------------------------------------------------------------
// Parallel evaluation
// ---------------------------------------------------------------------------

export type ParallelEvalOptions = {
  seeds: number[]
  candidateWeights: Partial<ScriptedBotWeights>
  opponentWeights?: Partial<ScriptedBotWeights>
  opponentPoolWeights?: Partial<ScriptedBotWeights>[]
  playerCount?: number
  maxSteps?: number
}

export async function parallelEvaluateScriptedBotWeights(
  options: ParallelEvalOptions,
  pool: SimWorkerPool,
): Promise<ScriptedBotWeightEvaluation> {
  const players = createTrainingPlayers(options.playerCount)
  const resolvedCandidateWeights = mergeScriptedBotWeights(options.candidateWeights)
  const resolvedOpponentPool =
    options.opponentPoolWeights && options.opponentPoolWeights.length > 0
      ? options.opponentPoolWeights.map(w => mergeScriptedBotWeights(w))
      : [mergeScriptedBotWeights(options.opponentWeights ?? DEFAULT_SCRIPTED_BOT_WEIGHTS)]

  const samples = await Promise.all(
    options.seeds.map((seed, index) =>
      pool.run({
        seed,
        taskIndex: index,
        players,
        candidateWeights: resolvedCandidateWeights,
        opponentWeights: resolvedOpponentPool,
        maxSteps: options.maxSteps ?? 2_000,
      }),
    ),
  )

  return aggregateSamples(resolvedCandidateWeights, samples, options.playerCount)
}

function aggregateSamples(
  weights: ScriptedBotWeights,
  samples: ScriptedBotWeightSample[],
  playerCount?: number,
): ScriptedBotWeightEvaluation {
  const sampleCount = Math.max(samples.length, 1)
  const wins = samples.filter(s => s.rank === 1).length
  const winRate = wins / sampleCount
  const averageRank = samples.reduce((t, s) => t + s.rank, 0) / sampleCount
  const averagePassengers = samples.reduce((t, s) => t + s.passengers, 0) / sampleCount
  const averagePassengerMargin = samples.reduce((t, s) => t + s.passengerMargin, 0) / sampleCount
  const averageConnectedCities = samples.reduce((t, s) => t + s.connectedCities, 0) / sampleCount
  const averageMoney = samples.reduce((t, s) => t + s.money, 0) / sampleCount
  const timeoutRate = samples.reduce((t, s) => t + (s.timedOut ? 1 : 0), 0) / sampleCount

  return {
    weights,
    winRate,
    averageRank,
    averagePassengers,
    averagePassengerMargin,
    averageConnectedCities,
    averageMoney,
    timeoutRate,
    score:
      averagePassengers +
      averagePassengerMargin * (playerCount === 1 ? 0.1 : 1) +
      winRate * 5_000 -
      averageRank * 1_000 +
      averageConnectedCities * 50 -
      timeoutRate * 250_000,
    samples,
  }
}

// ---------------------------------------------------------------------------
// Parallel training loop
// ---------------------------------------------------------------------------

export async function runScriptedBotTrainingParallel(
  options: ScriptedBotTrainingRunOptions,
  pool: SimWorkerPool,
): Promise<ScriptedBotTrainingResults> {
  let randomState = createInitialRandomState(options.mutationSeed)
  const initialWeights = applyFrozenScriptedBotWeights(
    options.initialWeights ?? DEFAULT_SCRIPTED_BOT_WEIGHTS,
    options.frozenWeights,
  )

  let best = await parallelEvaluateScriptedBotWeights(
    {
      seeds: createTrainingSeeds(options.baseSeed, options.gamesPerCandidate),
      candidateWeights: initialWeights,
      opponentWeights: options.opponentWeights,
      opponentPoolWeights: options.opponentPoolWeights,
      playerCount: options.playerCount,
      maxSteps: options.maxSteps,
    },
    pool,
  )

  const baselineSummary = summarizeScriptedBotWeightEvaluation(best)
  const history = []

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const initialTemp = options.initialTemperature ?? 1
    const temperature = Math.max(0.2, initialTemp * (1 - iteration / Math.max(options.iterations, 1)))

    // Evaluate all candidates for this iteration in parallel
    const candidateEvals = await Promise.all(
      Array.from({ length: Math.max(options.candidatesPerIteration, 1) }, (_, candidateIndex) => {
        const mutated = mutateScriptedBotWeights(best.weights, randomState, temperature, options.frozenWeights)
        randomState = mutated.randomState
        return parallelEvaluateScriptedBotWeights(
          {
            seeds: createTrainingSeeds(
              options.baseSeed +
                (iteration + 1) * options.gamesPerCandidate +
                candidateIndex * options.gamesPerCandidate,
              options.gamesPerCandidate,
            ),
            candidateWeights: mutated.weights,
            opponentWeights: options.opponentWeights,
            opponentPoolWeights: options.opponentPoolWeights,
            playerCount: options.playerCount,
            maxSteps: options.maxSteps,
          },
          pool,
        )
      }),
    )

    const candidatesSorted = candidateEvals.sort((a, b) => b.score - a.score)
    const candidateBest = candidatesSorted[0]
    const candidateSummary = candidateBest ? summarizeScriptedBotWeightEvaluation(candidateBest) : null

    if (candidateBest && candidateBest.score > best.score) {
      best = candidateBest
    }

    history.push({
      iteration: iteration + 1,
      temperature,
      best: summarizeScriptedBotWeightEvaluation(best),
      candidate: candidateSummary,
    })
    options.onIterationComplete?.({
      iteration: iteration + 1,
      totalIterations: options.iterations,
      temperature,
      best: summarizeScriptedBotWeightEvaluation(best),
      candidate: candidateSummary,
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    config: {
      iterations: options.iterations,
      gamesPerCandidate: options.gamesPerCandidate,
      playerCount: options.playerCount ?? 4,
      baseSeed: options.baseSeed,
      candidatesPerIteration: options.candidatesPerIteration,
      mutationSeed: options.mutationSeed,
      maxSteps: options.maxSteps,
      outputPath: options.outputPath,
      mutableLeverKeys: MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS,
      frozenLeverKeys: [...FROZEN_SCRIPTED_BOT_WEIGHT_KEYS],
    },
    baseline: baselineSummary,
    history,
    final: summarizeScriptedBotWeightEvaluation(best),
  }
}

export async function parallelEvaluateChampionBenchmark(
  playerCount: number,
  weights: Partial<ScriptedBotWeights>,
  gamesPerCandidate: number,
  pool: SimWorkerPool,
) {
  return summarizeScriptedBotWeightEvaluation(
    await parallelEvaluateScriptedBotWeights(
      {
        seeds: createTrainingSeeds(9000 + playerCount * 100, gamesPerCandidate),
        candidateWeights: mergeScriptedBotWeights(weights),
        opponentWeights: DEFAULT_SCRIPTED_BOT_WEIGHTS,
        playerCount,
        maxSteps: 1600,
      },
      pool,
    ),
  )
}

export async function parallelAnalyzeScriptedBotLeverImportance(
  options: {
    seeds: number[]
    finalWeights: Partial<ScriptedBotWeights>
    baselineWeights?: Partial<ScriptedBotWeights>
    opponentWeights?: Partial<ScriptedBotWeights>
    opponentPoolWeights?: Partial<ScriptedBotWeights>[]
    playerCount?: number
    maxSteps?: number
  },
  pool: SimWorkerPool,
): Promise<{ reference: ReturnType<typeof summarizeScriptedBotWeightEvaluation>; rows: ScriptedBotLeverImportanceEntry[] }> {
  const resolvedFinalWeights = mergeScriptedBotWeights(options.finalWeights)
  const resolvedBaselineWeights = mergeScriptedBotWeights(
    options.baselineWeights ?? DEFAULT_SCRIPTED_BOT_WEIGHTS,
  )
  const evalOptions = {
    opponentWeights: options.opponentWeights ?? resolvedBaselineWeights,
    opponentPoolWeights: options.opponentPoolWeights,
    playerCount: options.playerCount,
    maxSteps: options.maxSteps,
  }

  // Evaluate reference + all ablations in parallel
  const keys = Object.keys(resolvedFinalWeights) as Array<keyof ScriptedBotWeights>
  const [reference, ...ablatedResults] = await Promise.all([
    parallelEvaluateScriptedBotWeights({ seeds: options.seeds, candidateWeights: resolvedFinalWeights, ...evalOptions }, pool),
    ...keys.map(key =>
      parallelEvaluateScriptedBotWeights(
        { seeds: options.seeds, candidateWeights: { ...resolvedFinalWeights, [key]: resolvedBaselineWeights[key] }, ...evalOptions },
        pool,
      ),
    ),
  ])

  const referenceSummary = summarizeScriptedBotWeightEvaluation(reference)

  const rows: ScriptedBotLeverImportanceEntry[] = keys
    .map((key, index) => {
      const ablated = summarizeScriptedBotWeightEvaluation(ablatedResults[index])
      return {
        key,
        baselineValue: resolvedBaselineWeights[key],
        finalValue: resolvedFinalWeights[key],
        delta: resolvedFinalWeights[key] - resolvedBaselineWeights[key],
        ablated,
        scoreDrop: referenceSummary.score - ablated.score,
        passengerDrop: referenceSummary.averagePassengers - ablated.averagePassengers,
        winRateDrop: referenceSummary.winRate - ablated.winRate,
        timeoutIncrease: ablated.timeoutRate - referenceSummary.timeoutRate,
        rank: 0,
      }
    })
    .sort(
      (a, b) =>
        b.passengerDrop - a.passengerDrop ||
        b.scoreDrop - a.scoreDrop ||
        b.winRateDrop - a.winRateDrop ||
        b.timeoutIncrease - a.timeoutIncrease ||
        Math.abs(b.delta) - Math.abs(a.delta),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }))

  return { reference: referenceSummary, rows }
}

export async function parallelBuildImportanceResults(
  results: ScriptedBotTrainingResults,
  pool: SimWorkerPool,
  opponentPoolWeights?: Partial<ScriptedBotWeights>[],
): Promise<ScriptedBotLeverImportanceResults> {
  const { reference, rows } = await parallelAnalyzeScriptedBotLeverImportance(
    {
      seeds: createTrainingSeeds(results.config.baseSeed, results.config.gamesPerCandidate),
      finalWeights: results.final.weights,
      baselineWeights: results.baseline.weights,
      opponentWeights: results.baseline.weights,
      opponentPoolWeights,
      playerCount: results.config.playerCount,
      maxSteps: results.config.maxSteps,
    },
    pool,
  )

  return {
    generatedAt: new Date().toISOString(),
    sourceTrainingGeneratedAt: results.generatedAt,
    reference,
    rows,
    config: {
      gamesPerCandidate: results.config.gamesPerCandidate,
      playerCount: results.config.playerCount,
      baseSeed: results.config.baseSeed,
      maxSteps: results.config.maxSteps,
      outputPath: results.config.outputPath,
      mutableLeverKeys: results.config.mutableLeverKeys,
      frozenLeverKeys: results.config.frozenLeverKeys,
    },
  }
}
