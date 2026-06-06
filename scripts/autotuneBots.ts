import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  mergeScriptedBotWeights,
  type ScriptedBotWeights,
} from "../src/bots/scriptedBot.ts"
import {
  FROZEN_SCRIPTED_BOT_WEIGHT_KEYS,
  MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS,
  applyFrozenScriptedBotWeights,
} from "../src/bots/leverMetadata.ts"
import {
  analyzeScriptedBotLeverImportance,
  createTrainingSeeds,
  evaluateScriptedBotWeights,
  runScriptedBotTraining,
  summarizeScriptedBotWeightEvaluation,
  type ScriptedBotLeverImportanceResults,
  type ScriptedBotTrainingResults,
} from "../src/bots/training.ts"

const TRAINING_RESULTS_DIR = resolve(process.cwd(), "public/training-results")
const LATEST_RESULTS_PATH = resolve(TRAINING_RESULTS_DIR, "latest.json")
const LATEST_IMPORTANCE_RESULTS_PATH = resolve(TRAINING_RESULTS_DIR, "latest-importance.json")
const AUTOTUNE_STATUS_PATH = resolve(TRAINING_RESULTS_DIR, "autotune-status.json")
const PLAYER_COUNTS = [4, 3, 2] as const
const MAX_CYCLES = Number.parseInt(process.argv[2] ?? "", 10)
const SHOULD_STOP_AFTER_MAX_CYCLES = Number.isFinite(MAX_CYCLES) && MAX_CYCLES > 0

type PlayerCount = (typeof PLAYER_COUNTS)[number]
type RunProfile = "refine" | "explore" | "deep"
type ChampionRecord = {
  version: 1
  updatedAt: string
  cycle: number
  playerCount: PlayerCount
  benchmark: ScriptedBotTrainingResults["final"]
  training: ScriptedBotTrainingResults
}
type AutotuneRunRecord = {
  cycle: number
  playerCount: PlayerCount
  modeCycle: number
  profile: RunProfile
  startedFromScratch: boolean
  opponent: "default" | "champion"
  promoted: boolean
  benchmarkScore: number
  generatedAt: string
  final: Pick<
    ScriptedBotTrainingResults["final"],
    "score" | "winRate" | "averagePassengers" | "averageRank" | "sampleCount"
  >
}
type AutotuneStatus = {
  version: 1
  startedAt: string
  updatedAt: string
  cycle: number
  modeCycles: Record<`${PlayerCount}p`, number>
  currentRun: null | {
    cycle: number
    playerCount: PlayerCount
    modeCycle: number
    profile: RunProfile
    startedFromScratch: boolean
    opponent: "default" | "champion"
    startedAt: string
  }
  recentRuns: AutotuneRunRecord[]
  champions: Record<`${PlayerCount}p`, ChampionRecord | null>
}

function modeKey(playerCount: PlayerCount) {
  return `${playerCount}p` as const
}

function createChampionPath(playerCount: PlayerCount) {
  return resolve(TRAINING_RESULTS_DIR, `champion-${playerCount}p.json`)
}

function createModeResultsPath(playerCount: PlayerCount) {
  return resolve(TRAINING_RESULTS_DIR, `latest-${playerCount}p.json`)
}

function createModeImportancePath(playerCount: PlayerCount) {
  return resolve(TRAINING_RESULTS_DIR, `latest-${playerCount}p-importance.json`)
}

function ensureOutputDirectory() {
  mkdirSync(TRAINING_RESULTS_DIR, { recursive: true })
}

function writeJsonFile(path: string, payload: unknown) {
  ensureOutputDirectory()
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2))
  renameSync(temporaryPath, path)
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isValidWeights(value: unknown): value is ScriptedBotWeights {
  return (
    isRecord(value) &&
    Object.entries(DEFAULT_SCRIPTED_BOT_WEIGHTS).every(([key]) =>
      isFiniteNumber((value as Record<string, unknown>)[key]),
    )
  )
}

function parseChampionRecord(value: unknown, playerCount: PlayerCount): ChampionRecord | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.updatedAt !== "string" ||
    !isFiniteNumber(value.cycle) ||
    value.playerCount !== playerCount ||
    !isRecord(value.benchmark) ||
    !isRecord(value.training) ||
    !isRecord(value.training.final) ||
    !isValidWeights(value.training.final.weights)
  ) {
    return null
  }

  return value as ChampionRecord
}

function loadChampion(playerCount: PlayerCount) {
  return parseChampionRecord(readJsonFile(createChampionPath(playerCount)), playerCount)
}

function loadChampions() {
  return Object.fromEntries(
    PLAYER_COUNTS.map(playerCount => [modeKey(playerCount), loadChampion(playerCount)]),
  ) as AutotuneStatus["champions"]
}

function loadStatus(champions: AutotuneStatus["champions"]): AutotuneStatus {
  const existing = readJsonFile<AutotuneStatus>(AUTOTUNE_STATUS_PATH)

  if (!existing || !isRecord(existing) || existing.version !== 1 || typeof existing.startedAt !== "string") {
    return {
      version: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cycle: 0,
      modeCycles: {
        "2p": 0,
        "3p": 0,
        "4p": 0,
      },
      currentRun: null,
      recentRuns: [],
      champions,
    }
  }

  return {
    version: 1,
    startedAt: existing.startedAt,
    updatedAt: new Date().toISOString(),
    cycle: isFiniteNumber(existing.cycle) ? existing.cycle : 0,
    modeCycles: {
      "2p": isRecord(existing.modeCycles) && isFiniteNumber(existing.modeCycles["2p"]) ? existing.modeCycles["2p"] : 0,
      "3p": isRecord(existing.modeCycles) && isFiniteNumber(existing.modeCycles["3p"]) ? existing.modeCycles["3p"] : 0,
      "4p": isRecord(existing.modeCycles) && isFiniteNumber(existing.modeCycles["4p"]) ? existing.modeCycles["4p"] : 0,
    },
    currentRun: null,
    recentRuns: Array.isArray(existing.recentRuns) ? (existing.recentRuns as AutotuneRunRecord[]).slice(-18) : [],
    champions,
  }
}

function writeStatus(status: AutotuneStatus) {
  writeJsonFile(AUTOTUNE_STATUS_PATH, status)
}

function writeTrainingResults(results: ScriptedBotTrainingResults) {
  for (const path of [LATEST_RESULTS_PATH, createModeResultsPath(results.config.playerCount as PlayerCount)]) {
    writeJsonFile(path, results)
  }
}

function writeImportanceResults(
  playerCount: PlayerCount,
  sourceTraining: ScriptedBotTrainingResults,
  payload: ScriptedBotLeverImportanceResults,
) {
  writeJsonFile(LATEST_IMPORTANCE_RESULTS_PATH, payload)
  writeJsonFile(createModeImportancePath(playerCount), payload)
  console.log(
    JSON.stringify({
      stage: "importance",
      playerCount,
      sourceTrainingGeneratedAt: sourceTraining.generatedAt,
      generatedAt: payload.generatedAt,
    }),
  )
}

function getBenchmarkGameCount(playerCount: PlayerCount) {
  switch (playerCount) {
    case 2:
      return 16
    case 3:
      return 12
    case 4:
      return 10
  }
}

function getTrainingProfile(playerCount: PlayerCount, modeCycle: number, startedFromScratch: boolean) {
  const profile: RunProfile =
    startedFromScratch || modeCycle % 5 === 0 ? "deep" : modeCycle % 2 === 0 ? "explore" : "refine"
  const gamesPerCandidate =
    profile === "deep"
      ? getBenchmarkGameCount(playerCount)
      : playerCount === 2
        ? 12
        : playerCount === 3
          ? 10
          : 8

  return {
    profile,
    iterations: profile === "deep" ? 22 : profile === "explore" ? 16 : 10,
    gamesPerCandidate,
    candidatesPerIteration: profile === "refine" ? 5 : 7,
    maxSteps: profile === "deep" ? 2400 : 2000,
  }
}

function summarizeRunRecord(
  cycle: number,
  playerCount: PlayerCount,
  modeCycle: number,
  profile: RunProfile,
  startedFromScratch: boolean,
  opponent: "default" | "champion",
  promoted: boolean,
  benchmarkScore: number,
  results: ScriptedBotTrainingResults,
): AutotuneRunRecord {
  return {
    cycle,
    playerCount,
    modeCycle,
    profile,
    startedFromScratch,
    opponent,
    promoted,
    benchmarkScore,
    generatedAt: results.generatedAt,
    final: {
      score: results.final.score,
      winRate: results.final.winRate,
      averagePassengers: results.final.averagePassengers,
      averageRank: results.final.averageRank,
      sampleCount: results.final.sampleCount,
    },
  }
}

function createChampionRecord(
  playerCount: PlayerCount,
  cycle: number,
  training: ScriptedBotTrainingResults,
  benchmark: ScriptedBotTrainingResults["final"],
): ChampionRecord {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    cycle,
    playerCount,
    benchmark,
    training,
  }
}

function evaluateChampionBenchmark(playerCount: PlayerCount, weights: Partial<ScriptedBotWeights>) {
  return summarizeScriptedBotWeightEvaluation(
    evaluateScriptedBotWeights({
      seeds: createTrainingSeeds(9000 + playerCount * 100, getBenchmarkGameCount(playerCount)),
      candidateWeights: mergeScriptedBotWeights(weights),
      opponentWeights: DEFAULT_SCRIPTED_BOT_WEIGHTS,
      playerCount,
      maxSteps: 2500,
    }),
  )
}

function buildImportanceResults(results: ScriptedBotTrainingResults): ScriptedBotLeverImportanceResults {
  const { reference, rows } = analyzeScriptedBotLeverImportance({
    seeds: createTrainingSeeds(results.config.baseSeed, results.config.gamesPerCandidate),
    finalWeights: results.final.weights,
    baselineWeights: results.baseline.weights,
    opponentWeights: results.baseline.weights,
    playerCount: results.config.playerCount,
    maxSteps: results.config.maxSteps,
  })

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
      outputPath: LATEST_IMPORTANCE_RESULTS_PATH,
      mutableLeverKeys: MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS,
      frozenLeverKeys: [...FROZEN_SCRIPTED_BOT_WEIGHT_KEYS],
    },
  }
}

function logRunStart(
  cycle: number,
  playerCount: PlayerCount,
  modeCycle: number,
  profile: RunProfile,
  startedFromScratch: boolean,
  opponent: "default" | "champion",
) {
  console.log(
    JSON.stringify({
      stage: "cycle-start",
      cycle,
      playerCount,
      modeCycle,
      profile,
      startedFromScratch,
      opponent,
    }),
  )
}

function logRunFinish(
  cycle: number,
  playerCount: PlayerCount,
  promoted: boolean,
  benchmarkScore: number,
  results: ScriptedBotTrainingResults,
) {
  console.log(
    JSON.stringify({
      stage: "cycle-finish",
      cycle,
      playerCount,
      promoted,
      benchmarkScore: Number(benchmarkScore.toFixed(3)),
      score: Number(results.final.score.toFixed(3)),
      winRate: Number(results.final.winRate.toFixed(3)),
      averagePassengers: Number(results.final.averagePassengers.toFixed(3)),
      averageRank: Number(results.final.averageRank.toFixed(3)),
      sampleCount: results.final.sampleCount,
    }),
  )
}

let shouldStop = false
process.on("SIGINT", () => {
  shouldStop = true
  console.log(JSON.stringify({ stage: "signal", signal: "SIGINT", message: "Stopping after current cycle." }))
})
process.on("SIGTERM", () => {
  shouldStop = true
  console.log(JSON.stringify({ stage: "signal", signal: "SIGTERM", message: "Stopping after current cycle." }))
})

const champions = loadChampions()
const status = loadStatus(champions)
writeStatus(status)

while (!shouldStop) {
  const cycle = status.cycle + 1
  const playerCount = PLAYER_COUNTS[(cycle - 1) % PLAYER_COUNTS.length]
  const playerModeKey = modeKey(playerCount)
  const modeCycle = status.modeCycles[playerModeKey] + 1
  const champion = status.champions[playerModeKey]
  const startedFromScratch = !champion || modeCycle % 5 === 0
  const profileConfig = getTrainingProfile(playerCount, modeCycle, startedFromScratch)
  const opponent = champion && modeCycle % 4 === 2 ? "champion" : "default"
  const baseSeed = 10_000 + cycle * 500
  const mutationSeed = 100_000 + cycle * 977
  const outputPath = createModeResultsPath(playerCount)
  const frozenWeights = champion?.training.final.weights

  status.currentRun = {
    cycle,
    playerCount,
    modeCycle,
    profile: profileConfig.profile,
    startedFromScratch,
    opponent,
    startedAt: new Date().toISOString(),
  }
  status.updatedAt = new Date().toISOString()
  writeStatus(status)

  logRunStart(cycle, playerCount, modeCycle, profileConfig.profile, startedFromScratch, opponent)

  const results = runScriptedBotTraining({
    iterations: profileConfig.iterations,
    gamesPerCandidate: profileConfig.gamesPerCandidate,
    playerCount,
    baseSeed,
    candidatesPerIteration: profileConfig.candidatesPerIteration,
    mutationSeed,
    maxSteps: profileConfig.maxSteps,
    outputPath,
    initialWeights: startedFromScratch
      ? applyFrozenScriptedBotWeights(DEFAULT_SCRIPTED_BOT_WEIGHTS, frozenWeights)
      : champion?.training.final.weights,
    opponentWeights: opponent === "champion" ? champion?.training.final.weights : DEFAULT_SCRIPTED_BOT_WEIGHTS,
    frozenWeights,
  })
  writeTrainingResults(results)

  const benchmark = evaluateChampionBenchmark(playerCount, results.final.weights)
  const promoted = !champion || benchmark.score > champion.benchmark.score

  if (promoted) {
    const nextChampion = createChampionRecord(playerCount, cycle, results, benchmark)
    status.champions[playerModeKey] = nextChampion
    writeJsonFile(createChampionPath(playerCount), nextChampion)
    writeImportanceResults(playerCount, results, buildImportanceResults(results))
  }

  status.cycle = cycle
  status.modeCycles[playerModeKey] = modeCycle
  status.currentRun = null
  status.updatedAt = new Date().toISOString()
  status.recentRuns = [
    summarizeRunRecord(
      cycle,
      playerCount,
      modeCycle,
      profileConfig.profile,
      startedFromScratch,
      opponent,
      promoted,
      benchmark.score,
      results,
    ),
    ...status.recentRuns,
  ].slice(0, 18)
  writeStatus(status)

  logRunFinish(cycle, playerCount, promoted, benchmark.score, results)

  if (SHOULD_STOP_AFTER_MAX_CYCLES && cycle >= MAX_CYCLES) {
    break
  }
}

status.currentRun = null
status.updatedAt = new Date().toISOString()
writeStatus(status)
