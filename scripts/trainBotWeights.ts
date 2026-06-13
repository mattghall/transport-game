import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { dirname, resolve } from "node:path"
import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  type ScriptedBotWeights,
} from "../src/bots/scriptedBot.ts"
import { SimWorkerPool, runScriptedBotTrainingParallel } from "./parallelTraining.ts"

const iterations = Number.parseInt(process.argv[2] ?? "12", 10)
const gamesPerCandidate = Number.parseInt(process.argv[3] ?? "8", 10)
const playerCount = Number.parseInt(process.argv[4] ?? "4", 10)
const baseSeed = Number.parseInt(process.argv[5] ?? "1", 10)
const candidatesPerIteration = Number.parseInt(process.argv[6] ?? "6", 10)
const mutationSeed = Number.parseInt(process.argv[7] ?? `${baseSeed}`, 10)
const maxSteps = Number.parseInt(process.argv[8] ?? "2000", 10)
const warmStartPath = process.argv[9]
const outputPath = resolve(process.cwd(), "public/training-results/latest.json")
const modeOutputPath = resolve(process.cwd(), `public/training-results/latest-${playerCount}p.json`)

function roundWeights(weights: ScriptedBotWeights) {
  return Object.fromEntries(
    Object.entries(weights).map(([key, value]) => [key, Number(value.toFixed(3))]),
  ) as ScriptedBotWeights
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isValidWeights(value: unknown): value is Partial<ScriptedBotWeights> {
  return (
    isRecord(value) &&
    Object.values(value).every(entry => typeof entry === "number" && Number.isFinite(entry))
  )
}

function readWarmStartWeights(path: string | undefined) {
  if (!path) {
    return DEFAULT_SCRIPTED_BOT_WEIGHTS
  }

  const parsedValue = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as unknown

  if (isValidWeights(parsedValue)) {
    return parsedValue
  }

  if (isRecord(parsedValue) && isRecord(parsedValue.final) && isValidWeights(parsedValue.final.weights)) {
    return parsedValue.final.weights
  }

  if (isRecord(parsedValue) && isValidWeights(parsedValue.weights)) {
    return parsedValue.weights
  }

  throw new Error(`Warm-start file ${path} does not contain bot weights.`)
}

async function main() {
  const pool = new SimWorkerPool(Math.max(1, cpus().length - 1))
  try {
    const trainingResults = await runScriptedBotTrainingParallel(
      {
        iterations,
        gamesPerCandidate,
        playerCount,
        baseSeed,
        candidatesPerIteration,
        mutationSeed,
        maxSteps,
        outputPath,
        initialWeights: readWarmStartWeights(warmStartPath),
        frozenWeights: readWarmStartWeights(warmStartPath),
        onIterationComplete: progress => {
          console.log(
            JSON.stringify({
              stage: "iteration-progress",
              iteration: progress.iteration,
              totalIterations: progress.totalIterations,
              temperature: Number(progress.temperature.toFixed(3)),
              bestScore: Number(progress.best.score.toFixed(3)),
              candidateScore: Number((progress.candidate?.score ?? Number.NEGATIVE_INFINITY).toFixed(3)),
              bestWinRate: Number(progress.best.winRate.toFixed(3)),
              bestAveragePassengers: Number(progress.best.averagePassengers.toFixed(3)),
              bestAveragePassengerMargin: Number(progress.best.averagePassengerMargin.toFixed(3)),
              bestAverageRank: Number(progress.best.averageRank.toFixed(3)),
              maxSteps,
            }),
          )
        },
      },
      pool,
    )

    mkdirSync(dirname(outputPath), { recursive: true })
    for (const path of [outputPath, modeOutputPath]) {
      const tempOutputPath = `${path}.tmp`
      writeFileSync(tempOutputPath, JSON.stringify(trainingResults, null, 2))
      renameSync(tempOutputPath, path)
    }

    console.log(
      JSON.stringify(
        {
          stage: "baseline",
          score: Number(trainingResults.baseline.score.toFixed(3)),
          winRate: Number(trainingResults.baseline.winRate.toFixed(3)),
          averageRank: Number(trainingResults.baseline.averageRank.toFixed(3)),
          averagePassengers: Number(trainingResults.baseline.averagePassengers.toFixed(3)),
          averagePassengerMargin: Number(trainingResults.baseline.averagePassengerMargin.toFixed(3)),
          averageConnectedCities: Number(trainingResults.baseline.averageConnectedCities.toFixed(3)),
          timeoutRate: Number(trainingResults.baseline.timeoutRate.toFixed(3)),
          maxSteps,
          weights: roundWeights(trainingResults.baseline.weights),
        },
        null,
        2,
      ),
    )

    console.log(
      JSON.stringify(
        {
          stage: "final",
          score: Number(trainingResults.final.score.toFixed(3)),
          winRate: Number(trainingResults.final.winRate.toFixed(3)),
          averageRank: Number(trainingResults.final.averageRank.toFixed(3)),
          averagePassengers: Number(trainingResults.final.averagePassengers.toFixed(3)),
          averagePassengerMargin: Number(trainingResults.final.averagePassengerMargin.toFixed(3)),
          averageConnectedCities: Number(trainingResults.final.averageConnectedCities.toFixed(3)),
          averageMoney: Number(trainingResults.final.averageMoney.toFixed(3)),
          timeoutRate: Number(trainingResults.final.timeoutRate.toFixed(3)),
          sampleCount: trainingResults.final.sampleCount,
          maxSteps,
          outputPath,
          weights: roundWeights(trainingResults.final.weights),
        },
        null,
        2,
      ),
    )
  } finally {
    await pool.terminate()
  }
}

main().catch(err => {
  console.error(JSON.stringify({ stage: "fatal", error: String(err) }))
  process.exit(1)
})
