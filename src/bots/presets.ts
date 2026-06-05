import type { GameState, Player } from "../engine/types"
import { createScriptedBot, type ScriptedBotWeights } from "./scriptedBot"
import type { BotAction, BotController } from "./types"
import type { ScriptedBotTrainingResults } from "./training"

export const BOT_PRESET_IDS = ["bot-avg", "bot-best", "bot-chaos"] as const
export type BotPresetId = (typeof BOT_PRESET_IDS)[number]

export const DEFAULT_BOT_PRESET_ID: BotPresetId = "bot-avg"
export const MANAGED_BOT_PRESETS_PATH = "/training-results/bot-presets.json"

export const BEST_BOT_WEIGHTS: ScriptedBotWeights = {
  vehiclePriorityBus: 65.38630117382854,
  vehiclePriorityTrain: 58.92507260646672,
  vehiclePriorityAir: 56.39172507561744,
  claimRailBaseScore: 83.92690184339882,
  claimAirBaseScore: 81.08902858868241,
  claimPopulationPerMillionScore: 5.217553819917764,
  claimNewCityBonus: 16.025491999462247,
  claimFirstModeBonus: 30.775275547988713,
  claimRailCostPenaltyPerMillion: 1.902319767108808,
  buyBusOwnedCityBonus: 5.059903667370479,
  buyTrainPotentialClaimBonus: 38.80726578099032,
  buyTrainFallbackOwnedCityBonus: 6.749551630578935,
  buyTrainNoClaimPenalty: 4.999358127266168,
  buyAirPotentialClaimBonus: 24.688598528938986,
  buyAirFallbackOwnedCityBonus: 14.62854427471757,
  buyAirNoClaimPenalty: 34.294325980544095,
  buyDuplicateVehiclePenalty: 18.027136463671923,
  buyFirstTrainBonus: 45.74513889631877,
  buyFirstAirBonus: 29.829800845123827,
  earlyExpansionMultiplier: 1.923786298263197,
  midExpansionMultiplier: 0.5993810786306857,
  lateExpansionMultiplier: 0.5875558276474477,
  earlyPopulationMultiplier: 0.9426064217525223,
  midPopulationMultiplier: 0.7097678910630445,
  latePopulationMultiplier: 1.8453381974250078,
  earlyReadyOperationsScore: 66.84483872540295,
  midReadyOperationsScore: 161.75093347951773,
  lateReadyOperationsScore: 269.81666499736417,
  earlyClaimBudget: 2.3417058870506784,
  midClaimBudget: 2.480065156829854,
  lateClaimBudget: 1.6523259414670368,
}

export const BOT_PRESETS: ReadonlyArray<{
  id: BotPresetId
  label: string
  description: string
}> = [
  {
    id: "bot-avg",
    label: "Malcolm Gladwell",
    description: "The baseline scripted bot.",
  },
  {
    id: "bot-best",
    label: "Stickbug",
    description: "The strongest trained preset from the current saved run.",
  },
  {
    id: "bot-chaos",
    label: "Chaos agent",
    description: "A pseudo-random bot that picks from the legal actions unpredictably.",
  },
] as const

export const MANAGED_BOT_PRESET_IDS = ["bot-avg", "bot-best"] as const
export type ManagedBotPresetId = (typeof MANAGED_BOT_PRESET_IDS)[number]

export type ManagedBotPresetEntry = {
  presetId: ManagedBotPresetId
  weights: ScriptedBotWeights
  promotedAt: string
  sourceTrainingGeneratedAt: string
  sourceSummary: Pick<
    ScriptedBotTrainingResults["final"],
    | "score"
    | "winRate"
    | "averageRank"
    | "averagePassengers"
    | "averageConnectedCities"
    | "averageMoney"
    | "timeoutRate"
    | "sampleCount"
  >
  sourceConfig: ScriptedBotTrainingResults["config"]
}

export type ManagedBotPresetStore = {
  version: 1
  updatedAt: string
  presets: Partial<Record<ManagedBotPresetId, ManagedBotPresetEntry>>
}

export function normalizeBotPresetId(value: string | null | undefined): BotPresetId {
  return BOT_PRESET_IDS.find(presetId => presetId === value) ?? DEFAULT_BOT_PRESET_ID
}

export function getBotPresetLabel(value: string | null | undefined) {
  const presetId = normalizeBotPresetId(value)
  return BOT_PRESETS.find(preset => preset.id === presetId)?.label ?? "Malcolm Gladwell"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function isScriptedBotWeights(value: unknown): value is ScriptedBotWeights {
  if (!isRecord(value)) {
    return false
  }

  return Object.keys(BEST_BOT_WEIGHTS).every(key => isFiniteNumber(value[key]))
}

function parseManagedBotPresetEntry(value: unknown): ManagedBotPresetEntry | null {
  if (!isRecord(value)) {
    return null
  }

  if (
    !MANAGED_BOT_PRESET_IDS.includes(value.presetId as ManagedBotPresetId) ||
    typeof value.promotedAt !== "string" ||
    typeof value.sourceTrainingGeneratedAt !== "string" ||
    !isScriptedBotWeights(value.weights) ||
    !isRecord(value.sourceSummary) ||
    !isRecord(value.sourceConfig)
  ) {
    return null
  }

  const sourceSummary = value.sourceSummary
  const sourceConfig = value.sourceConfig

  if (
    !isFiniteNumber(sourceSummary.score) ||
    !isFiniteNumber(sourceSummary.winRate) ||
    !isFiniteNumber(sourceSummary.averageRank) ||
    !isFiniteNumber(sourceSummary.averagePassengers) ||
    !isFiniteNumber(sourceSummary.averageConnectedCities) ||
    !isFiniteNumber(sourceSummary.averageMoney) ||
    !isFiniteNumber(sourceSummary.timeoutRate) ||
    !isFiniteNumber(sourceSummary.sampleCount) ||
    !isFiniteNumber(sourceConfig.iterations) ||
    !isFiniteNumber(sourceConfig.gamesPerCandidate) ||
    !isFiniteNumber(sourceConfig.baseSeed) ||
    !isFiniteNumber(sourceConfig.candidatesPerIteration) ||
    !isFiniteNumber(sourceConfig.mutationSeed) ||
    !isFiniteNumber(sourceConfig.maxSteps) ||
    typeof sourceConfig.outputPath !== "string"
  ) {
    return null
  }

  return {
    presetId: value.presetId as ManagedBotPresetId,
    promotedAt: value.promotedAt,
    sourceTrainingGeneratedAt: value.sourceTrainingGeneratedAt,
    weights: value.weights,
    sourceSummary: {
      score: sourceSummary.score,
      winRate: sourceSummary.winRate,
      averageRank: sourceSummary.averageRank,
      averagePassengers: sourceSummary.averagePassengers,
      averageConnectedCities: sourceSummary.averageConnectedCities,
      averageMoney: sourceSummary.averageMoney,
      timeoutRate: sourceSummary.timeoutRate,
      sampleCount: sourceSummary.sampleCount,
    },
    sourceConfig: {
      iterations: sourceConfig.iterations,
      gamesPerCandidate: sourceConfig.gamesPerCandidate,
      baseSeed: sourceConfig.baseSeed,
      candidatesPerIteration: sourceConfig.candidatesPerIteration,
      mutationSeed: sourceConfig.mutationSeed,
      maxSteps: sourceConfig.maxSteps,
      outputPath: sourceConfig.outputPath,
    },
  }
}

export function parseManagedBotPresetStore(value: unknown): ManagedBotPresetStore | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== "string" || !isRecord(value.presets)) {
    return null
  }

  const presetRecord = value.presets

  const presets = Object.fromEntries(
    MANAGED_BOT_PRESET_IDS.flatMap(presetId => {
      const parsedPreset = parseManagedBotPresetEntry(presetRecord[presetId])
      return parsedPreset ? [[presetId, parsedPreset]] : []
    }),
  ) as Partial<Record<ManagedBotPresetId, ManagedBotPresetEntry>>

  return {
    version: 1,
    updatedAt: value.updatedAt,
    presets,
  }
}

export async function fetchManagedBotPresetStore() {
  let response: Response

  try {
    response = await fetch(`${MANAGED_BOT_PRESETS_PATH}?tick=${Date.now()}`, {
      cache: "no-store",
    })
  } catch {
    return null
  }

  if (!response.ok) {
    return null
  }

  try {
    return parseManagedBotPresetStore(await response.json())
  } catch {
    return null
  }
}

export async function fetchManagedBotPresetWeightOverrides() {
  const store = await fetchManagedBotPresetStore()
  return Object.fromEntries(
    MANAGED_BOT_PRESET_IDS.flatMap(presetId => {
      const preset = store?.presets[presetId]
      return preset ? [[presetId, preset.weights]] : []
    }),
  ) satisfies Partial<Record<BotPresetId, ScriptedBotWeights>>
}

function hashText(value: string) {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash
}

function buildChaosSeed(game: GameState, playerId: string, legalActions: BotAction[]) {
  return hashText(
    JSON.stringify({
      randomState: game.randomState,
      week: game.currentWeek,
      phase: game.currentPhase,
      playerId,
      currentPlayerId: game.currentPlayerId,
      actionLogCount: game.actionLog.length,
      legalActions,
    }),
  )
}

export function createChaosBot(id: string): BotController {
  return {
    id,
    pickAction: ({ game, playerId, legalActions }) => {
      if (legalActions.length === 0) {
        throw new Error(`Chaos agent ${id} was asked to act with no legal actions.`)
      }

      const actionIndex = buildChaosSeed(game, playerId, legalActions) % legalActions.length
      return legalActions[actionIndex]
    },
  }
}

export function createPresetBotController(
  id: string,
  presetId: string | null | undefined,
  weightOverridesByPresetId: Partial<Record<BotPresetId, ScriptedBotWeights>> = {},
): BotController {
  switch (normalizeBotPresetId(presetId)) {
    case "bot-best":
      return createScriptedBot(id, weightOverridesByPresetId["bot-best"] ?? BEST_BOT_WEIGHTS)
    case "bot-chaos":
      return createChaosBot(id)
    case "bot-avg":
      return createScriptedBot(id, weightOverridesByPresetId["bot-avg"] ?? {})
  }
}

export function getPlayerBotPreset(player: Pick<Player, "isBot" | "botPreset"> | null | undefined) {
  if (!player?.isBot) {
    return undefined
  }

  return normalizeBotPresetId(player.botPreset)
}
