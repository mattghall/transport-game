import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { createInitialRandomState } from "../src/engine/random.ts"
import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  type ScriptedBotWeights,
} from "../src/bots/scriptedBot.ts"
import {
  evaluateScriptedBotWeights,
  mutateScriptedBotWeights,
  summarizeScriptedBotWeightEvaluation,
  type ScriptedBotTrainingHistoryEntry,
  type ScriptedBotTrainingResults,
} from "../src/bots/training.ts"

const iterations = Number.parseInt(process.argv[2] ?? "12", 10)
const gamesPerCandidate = Number.parseInt(process.argv[3] ?? "8", 10)
const baseSeed = Number.parseInt(process.argv[4] ?? "1", 10)
const candidatesPerIteration = Number.parseInt(process.argv[5] ?? "6", 10)
const mutationSeed = Number.parseInt(process.argv[6] ?? `${baseSeed}`, 10)
const maxSteps = Number.parseInt(process.argv[7] ?? "2000", 10)
const outputPath = resolve(process.cwd(), "public/training-results/latest.json")

function roundWeights(weights: ScriptedBotWeights) {
  return Object.fromEntries(
    Object.entries(weights).map(([key, value]) => [key, Number(value.toFixed(3))]),
  ) as ScriptedBotWeights
}

function createSeeds(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => start + index)
}

let randomState = createInitialRandomState(mutationSeed)
let best = evaluateScriptedBotWeights({
  seeds: createSeeds(baseSeed, gamesPerCandidate),
  candidateWeights: DEFAULT_SCRIPTED_BOT_WEIGHTS,
  maxSteps,
})
const baselineSummary = summarizeScriptedBotWeightEvaluation(best)
const history: ScriptedBotTrainingHistoryEntry[] = []

function writeTrainingResults() {
  const payload: ScriptedBotTrainingResults = {
    generatedAt: new Date().toISOString(),
    config: {
      iterations,
      gamesPerCandidate,
      baseSeed,
      candidatesPerIteration,
      mutationSeed,
      maxSteps,
      outputPath,
    },
    baseline: baselineSummary,
    history,
    final: summarizeScriptedBotWeightEvaluation(best),
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  const tempOutputPath = `${outputPath}.tmp`
  writeFileSync(tempOutputPath, JSON.stringify(payload, null, 2))
  renameSync(tempOutputPath, outputPath)
}

writeTrainingResults()

console.log(
  JSON.stringify(
    {
      stage: "baseline",
      score: Number(baselineSummary.score.toFixed(3)),
      winRate: Number(baselineSummary.winRate.toFixed(3)),
      averageRank: Number(baselineSummary.averageRank.toFixed(3)),
      averagePassengers: Number(baselineSummary.averagePassengers.toFixed(3)),
      averageConnectedCities: Number(baselineSummary.averageConnectedCities.toFixed(3)),
      timeoutRate: Number(baselineSummary.timeoutRate.toFixed(3)),
      maxSteps,
      weights: roundWeights(baselineSummary.weights),
    },
    null,
    2,
  ),
)

for (let iteration = 0; iteration < iterations; iteration += 1) {
  const temperature = Math.max(0.2, 1 - iteration / Math.max(iterations, 1))
  const candidates = Array.from({ length: Math.max(candidatesPerIteration, 1) }, (_, candidateIndex) => {
    const mutated = mutateScriptedBotWeights(best.weights, randomState, temperature)
    randomState = mutated.randomState

    return evaluateScriptedBotWeights({
      seeds: createSeeds(
        baseSeed + (iteration + 1) * gamesPerCandidate + candidateIndex * gamesPerCandidate,
        gamesPerCandidate,
      ),
      candidateWeights: mutated.weights,
      maxSteps,
    })
  }).sort((evaluationA, evaluationB) => evaluationB.score - evaluationA.score)

  const candidateBest = candidates[0]
  const candidateSummary = candidateBest ? summarizeScriptedBotWeightEvaluation(candidateBest) : null

  if (candidateBest && candidateBest.score > best.score) {
    best = candidateBest
  }
  const bestSummary = summarizeScriptedBotWeightEvaluation(best)

  history.push({
    iteration: iteration + 1,
    temperature,
    best: bestSummary,
    candidate: candidateSummary,
  })
  writeTrainingResults()

  console.log(
    JSON.stringify(
      {
        stage: "iteration",
        iteration: iteration + 1,
        temperature: Number(temperature.toFixed(3)),
        bestScore: Number(bestSummary.score.toFixed(3)),
        candidateScore: Number((candidateSummary?.score ?? Number.NEGATIVE_INFINITY).toFixed(3)),
        bestWinRate: Number(bestSummary.winRate.toFixed(3)),
        bestAveragePassengers: Number(bestSummary.averagePassengers.toFixed(3)),
        bestAverageRank: Number(bestSummary.averageRank.toFixed(3)),
        maxSteps,
      },
      null,
      2,
    ),
  )
}

const finalSummary = summarizeScriptedBotWeightEvaluation(best)
writeTrainingResults()

console.log(
  JSON.stringify(
    {
      stage: "final",
      score: Number(finalSummary.score.toFixed(3)),
      winRate: Number(finalSummary.winRate.toFixed(3)),
      averageRank: Number(finalSummary.averageRank.toFixed(3)),
      averagePassengers: Number(finalSummary.averagePassengers.toFixed(3)),
      averageConnectedCities: Number(finalSummary.averageConnectedCities.toFixed(3)),
      averageMoney: Number(finalSummary.averageMoney.toFixed(3)),
      timeoutRate: Number(finalSummary.timeoutRate.toFixed(3)),
      sampleCount: finalSummary.sampleCount,
      maxSteps,
      outputPath,
      weights: roundWeights(finalSummary.weights),
    },
    null,
    2,
  ),
)
