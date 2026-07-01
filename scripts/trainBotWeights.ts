import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { dirname, resolve } from "node:path"
import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  type ScriptedBotWeights,
} from "../src/bots/scriptedBot.ts"
import { SimWorkerPool, runScriptedBotTrainingParallel } from "./parallelTraining.ts"

function parseCliArguments(argv: string[]) {
  const namedArgs = new Map<string, string>()
  const positionalArgs: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (!argument.startsWith("--")) {
      positionalArgs.push(argument)
      continue
    }

    const [rawKey, inlineValue] = argument.slice(2).split("=", 2)
    const nextValue = inlineValue ?? argv[index + 1]

    if (inlineValue === undefined && nextValue !== undefined && !nextValue.startsWith("--")) {
      namedArgs.set(rawKey, nextValue)
      index += 1
      continue
    }

    namedArgs.set(rawKey, inlineValue ?? "true")
  }

  const parseNumber = (namedKey: string, positionalIndex: number, fallback: number) => {
    const rawValue = namedArgs.get(namedKey) ?? positionalArgs[positionalIndex] ?? `${fallback}`
    const parsedValue = Number.parseInt(rawValue, 10)
    return Number.isFinite(parsedValue) ? parsedValue : fallback
  }

  return {
    iterations: parseNumber("iterations", 0, 12),
    gamesPerCandidate: parseNumber("gamesPerCandidate", 1, 8),
    playerCount: parseNumber("playerCount", 2, 4),
    baseSeed: parseNumber("baseSeed", 3, 1),
    candidatesPerIteration: parseNumber("candidatesPerIteration", 4, 6),
    mutationSeed: parseNumber("mutationSeed", 5, parseNumber("baseSeed", 3, 1)),
    maxSteps: parseNumber("maxSteps", 6, 2000),
    warmStartPath:
      namedArgs.get("warmStartPath") ??
      namedArgs.get("warmStart") ??
      positionalArgs[7],
  }
}

const {
  iterations,
  gamesPerCandidate,
  playerCount,
  baseSeed,
  candidatesPerIteration,
  mutationSeed,
  maxSteps,
  warmStartPath,
} = parseCliArguments(process.argv.slice(2))
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
  if (
    iterations < 1 ||
    gamesPerCandidate < 1 ||
    playerCount < 1 ||
    playerCount > 4 ||
    candidatesPerIteration < 1 ||
    maxSteps < 1
  ) {
    throw new Error(
      "Invalid training arguments. Expected iterations >= 1, gamesPerCandidate >= 1, playerCount between 1 and 4, candidatesPerIteration >= 1, and maxSteps >= 1.",
    )
  }

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
      if (existsSync(path)) unlinkSync(path)
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
