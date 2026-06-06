import { mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  FROZEN_SCRIPTED_BOT_WEIGHT_KEYS,
  MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS,
} from "../src/bots/leverMetadata.ts"
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
  playerCount: parsedResults.config.playerCount ?? 4,
  maxSteps: parsedResults.config.maxSteps,
})

const payload: ScriptedBotLeverImportanceResults = {
  generatedAt: new Date().toISOString(),
  sourceTrainingGeneratedAt: parsedResults.generatedAt,
  reference,
  rows,
  config: {
    gamesPerCandidate: parsedResults.config.gamesPerCandidate,
    playerCount: parsedResults.config.playerCount ?? 4,
    baseSeed: parsedResults.config.baseSeed,
    maxSteps: parsedResults.config.maxSteps,
    outputPath,
    mutableLeverKeys: MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS,
    frozenLeverKeys: [...FROZEN_SCRIPTED_BOT_WEIGHT_KEYS],
  },
}

mkdirSync(dirname(outputPath), { recursive: true })
const modeOutputPath = resolve(
  process.cwd(),
  `public/training-results/latest-${parsedResults.config.playerCount ?? 4}p-importance.json`,
)

for (const path of [outputPath, modeOutputPath]) {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2))
  renameSync(temporaryPath, path)
}
console.log(JSON.stringify(payload))
