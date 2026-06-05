import { mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  analyzeScriptedBotLeverImportance,
  type ScriptedBotLeverImportanceResults,
  type ScriptedBotTrainingResults,
} from "../src/bots/training.ts"
import type { ScriptedBotWeights } from "../src/bots/scriptedBot.ts"

const inputPath = resolve(process.cwd(), "public/training-results/latest.json")
const outputPath = resolve(process.cwd(), "public/training-results/latest-importance.json")

function createSeeds(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => start + index)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isValidWeights(value: unknown): value is ScriptedBotWeights {
  return (
    isRecord(value) &&
    Object.values(value).every(entry => typeof entry === "number" && Number.isFinite(entry))
  )
}

const parsedResults = JSON.parse(readFileSync(inputPath, "utf8")) as ScriptedBotTrainingResults

if (
  typeof parsedResults.generatedAt !== "string" ||
  !isRecord(parsedResults.config) ||
  !isRecord(parsedResults.baseline) ||
  !isRecord(parsedResults.final) ||
  !isValidWeights(parsedResults.baseline.weights) ||
  !isValidWeights(parsedResults.final.weights)
) {
  throw new Error("Latest training results are missing the data needed for lever importance analysis.")
}

const { reference, rows } = analyzeScriptedBotLeverImportance({
  seeds: createSeeds(parsedResults.config.baseSeed, parsedResults.config.gamesPerCandidate),
  finalWeights: parsedResults.final.weights,
  baselineWeights: parsedResults.baseline.weights,
  opponentWeights: parsedResults.baseline.weights,
  maxSteps: parsedResults.config.maxSteps,
})

const payload: ScriptedBotLeverImportanceResults = {
  generatedAt: new Date().toISOString(),
  sourceTrainingGeneratedAt: parsedResults.generatedAt,
  reference,
  rows,
  config: {
    gamesPerCandidate: parsedResults.config.gamesPerCandidate,
    baseSeed: parsedResults.config.baseSeed,
    maxSteps: parsedResults.config.maxSteps,
    outputPath,
  },
}

mkdirSync(dirname(outputPath), { recursive: true })
const temporaryPath = `${outputPath}.tmp`
writeFileSync(temporaryPath, JSON.stringify(payload, null, 2))
renameSync(temporaryPath, outputPath)
console.log(JSON.stringify(payload))
