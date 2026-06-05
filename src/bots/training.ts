import { buildVictoryStandings } from "../engine/economy"
import { randomFloatFromState } from "../engine/random"
import { PLAYER_SETUP_PRESETS } from "../gameSetup/defaultPlayers"
import type { GameSetupPlayer } from "../engine/createGameState"
import { runBotSimulation } from "./simulate"
import {
  createScriptedBot,
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  mergeScriptedBotWeights,
  type ScriptedBotWeights,
} from "./scriptedBot"

const WEIGHT_MUTATION_STEP: Record<keyof ScriptedBotWeights, number> = {
  vehiclePriorityBus: 18,
  vehiclePriorityTrain: 18,
  vehiclePriorityAir: 18,
  claimRailBaseScore: 24,
  claimAirBaseScore: 24,
  claimPopulationPerMillionScore: 2.5,
  claimNewCityBonus: 10,
  claimFirstModeBonus: 10,
  claimRailCostPenaltyPerMillion: 1,
  buyBusOwnedCityBonus: 2,
  buyTrainPotentialClaimBonus: 14,
  buyTrainFallbackOwnedCityBonus: 6,
  buyTrainNoClaimPenalty: 12,
  buyAirPotentialClaimBonus: 14,
  buyAirFallbackOwnedCityBonus: 6,
  buyAirNoClaimPenalty: 12,
  buyDuplicateVehiclePenalty: 4,
  buyFirstTrainBonus: 10,
  buyFirstAirBonus: 10,
  earlyExpansionMultiplier: 0.25,
  midExpansionMultiplier: 0.2,
  lateExpansionMultiplier: 0.2,
  earlyPopulationMultiplier: 0.2,
  midPopulationMultiplier: 0.2,
  latePopulationMultiplier: 0.25,
  earlyReadyOperationsScore: 20,
  midReadyOperationsScore: 24,
  lateReadyOperationsScore: 28,
  earlyClaimBudget: 1,
  midClaimBudget: 1,
  lateClaimBudget: 1,
}

const WEIGHT_MINIMUM: Partial<Record<keyof ScriptedBotWeights, number>> = {
  claimPopulationPerMillionScore: 0,
  claimRailCostPenaltyPerMillion: 0,
  buyBusOwnedCityBonus: 0,
  buyTrainFallbackOwnedCityBonus: 0,
  buyAirFallbackOwnedCityBonus: 0,
  buyDuplicateVehiclePenalty: 0,
  earlyExpansionMultiplier: 0.1,
  midExpansionMultiplier: 0.1,
  lateExpansionMultiplier: 0.1,
  earlyPopulationMultiplier: 0.1,
  midPopulationMultiplier: 0.1,
  latePopulationMultiplier: 0.1,
  earlyReadyOperationsScore: 0,
  midReadyOperationsScore: 0,
  lateReadyOperationsScore: 0,
  earlyClaimBudget: 0,
  midClaimBudget: 0,
  lateClaimBudget: 0,
}

export type ScriptedBotWeightSample = {
  seed: number
  candidatePlayerId: string
  rank: number
  passengers: number
  connectedCities: number
  money: number
  timedOut: boolean
}

export type ScriptedBotWeightEvaluation = {
  weights: ScriptedBotWeights
  score: number
  winRate: number
  averageRank: number
  averagePassengers: number
  averageConnectedCities: number
  averageMoney: number
  timeoutRate: number
  samples: ScriptedBotWeightSample[]
}

export type ScriptedBotWeightEvaluationSummary = {
  score: number
  winRate: number
  averageRank: number
  averagePassengers: number
  averageConnectedCities: number
  averageMoney: number
  timeoutRate: number
  sampleCount: number
  weights: ScriptedBotWeights
}

export type ScriptedBotTrainingHistoryEntry = {
  iteration: number
  temperature: number
  best: ScriptedBotWeightEvaluationSummary
  candidate: ScriptedBotWeightEvaluationSummary | null
}

export type ScriptedBotTrainingResults = {
  generatedAt: string
  config: {
    iterations: number
    gamesPerCandidate: number
    baseSeed: number
    candidatesPerIteration: number
    mutationSeed: number
    maxSteps: number
    outputPath: string
  }
  baseline: ScriptedBotWeightEvaluationSummary
  history: ScriptedBotTrainingHistoryEntry[]
  final: ScriptedBotWeightEvaluationSummary
}

export type ScriptedBotLeverImportanceEntry = {
  key: keyof ScriptedBotWeights
  baselineValue: number
  finalValue: number
  delta: number
  ablated: ScriptedBotWeightEvaluationSummary
  scoreDrop: number
  passengerDrop: number
  winRateDrop: number
  timeoutIncrease: number
  rank: number
}

export type ScriptedBotLeverImportanceResults = {
  generatedAt: string
  sourceTrainingGeneratedAt: string
  reference: ScriptedBotWeightEvaluationSummary
  rows: ScriptedBotLeverImportanceEntry[]
  config: {
    gamesPerCandidate: number
    baseSeed: number
    maxSteps: number
    outputPath: string
  }
}

function createTrainingPlayers(playerCount = 4): GameSetupPlayer[] {
  return PLAYER_SETUP_PRESETS.slice(0, playerCount).map((player, index) => ({
    ...player,
    name: `Bot ${index + 1}`,
    isBot: true,
  }))
}

export function evaluateScriptedBotWeights(options: {
  seeds: number[]
  candidateWeights: Partial<ScriptedBotWeights>
  opponentWeights?: Partial<ScriptedBotWeights>
  playerCount?: number
  maxSteps?: number
}): ScriptedBotWeightEvaluation {
  const players = createTrainingPlayers(options.playerCount)
  const resolvedCandidateWeights = mergeScriptedBotWeights(options.candidateWeights)
  const resolvedOpponentWeights = mergeScriptedBotWeights(
    options.opponentWeights ?? DEFAULT_SCRIPTED_BOT_WEIGHTS,
  )
  const samples = options.seeds.map((seed, index) => {
    const candidatePlayerId = players[index % players.length]?.id ?? players[0].id
    const botsByPlayerId = Object.fromEntries(
      players.map(player => [
        player.id,
        createScriptedBot(
          player.id,
          player.id === candidatePlayerId ? resolvedCandidateWeights : resolvedOpponentWeights,
        ),
      ]),
    )
    const result = runBotSimulation({
      seed,
      players,
      maxSteps: options.maxSteps ?? 2_000,
      recordTrace: false,
      botsByPlayerId,
    })
    const standings = buildVictoryStandings(result.game)
    const candidateStanding = standings.find(standing => standing.player.id === candidatePlayerId)

    return {
      seed,
      candidatePlayerId,
      rank:
        candidateStanding === undefined
          ? standings.length + 1
          : standings.findIndex(standing => standing.player.id === candidatePlayerId) + 1,
      passengers: candidateStanding?.player.totalPassengersServed ?? 0,
      connectedCities: candidateStanding?.connectedCities ?? 0,
      money: candidateStanding?.player.money ?? 0,
      timedOut: result.timedOut,
    }
  })
  const sampleCount = Math.max(samples.length, 1)
  const wins = samples.filter(sample => sample.rank === 1).length
  const winRate = wins / sampleCount
  const averageRank = samples.reduce((total, sample) => total + sample.rank, 0) / sampleCount
  const averagePassengers =
    samples.reduce((total, sample) => total + sample.passengers, 0) / sampleCount
  const averageConnectedCities =
    samples.reduce((total, sample) => total + sample.connectedCities, 0) / sampleCount
  const averageMoney = samples.reduce((total, sample) => total + sample.money, 0) / sampleCount
  const timeoutRate =
    samples.reduce((total, sample) => total + (sample.timedOut ? 1 : 0), 0) / sampleCount

  return {
    weights: resolvedCandidateWeights,
    winRate,
    averageRank,
    averagePassengers,
    averageConnectedCities,
    averageMoney,
    timeoutRate,
    score:
      averagePassengers +
      winRate * 15_000 -
      averageRank * 2_500 +
      averageConnectedCities * 125 +
      averageMoney / 1_000_000 -
      timeoutRate * 250_000,
    samples,
  }
}

export function summarizeScriptedBotWeightEvaluation(
  evaluation: ScriptedBotWeightEvaluation,
): ScriptedBotWeightEvaluationSummary {
  return {
    score: evaluation.score,
    winRate: evaluation.winRate,
    averageRank: evaluation.averageRank,
    averagePassengers: evaluation.averagePassengers,
    averageConnectedCities: evaluation.averageConnectedCities,
    averageMoney: evaluation.averageMoney,
    timeoutRate: evaluation.timeoutRate,
    sampleCount: evaluation.samples.length,
    weights: evaluation.weights,
  }
}

export function mutateScriptedBotWeights(
  baseWeights: Partial<ScriptedBotWeights>,
  randomState: number,
  temperature = 1,
) {
  const resolvedBaseWeights = mergeScriptedBotWeights(baseWeights)
  let nextRandomState = randomState
  const nextWeights = { ...resolvedBaseWeights }

  for (const key of Object.keys(resolvedBaseWeights) as Array<keyof ScriptedBotWeights>) {
    const nextRandom = randomFloatFromState(nextRandomState)
    nextRandomState = nextRandom.randomState
    const delta = (nextRandom.value * 2 - 1) * WEIGHT_MUTATION_STEP[key] * temperature
    const minimum = WEIGHT_MINIMUM[key]
    nextWeights[key] =
      minimum === undefined
        ? resolvedBaseWeights[key] + delta
        : Math.max(minimum, resolvedBaseWeights[key] + delta)
  }

  return {
    weights: nextWeights,
    randomState: nextRandomState,
  }
}

export function analyzeScriptedBotLeverImportance(options: {
  seeds: number[]
  finalWeights: Partial<ScriptedBotWeights>
  baselineWeights?: Partial<ScriptedBotWeights>
  opponentWeights?: Partial<ScriptedBotWeights>
  maxSteps?: number
}): {
  reference: ScriptedBotWeightEvaluationSummary
  rows: ScriptedBotLeverImportanceEntry[]
} {
  const resolvedFinalWeights = mergeScriptedBotWeights(options.finalWeights)
  const resolvedBaselineWeights = mergeScriptedBotWeights(
    options.baselineWeights ?? DEFAULT_SCRIPTED_BOT_WEIGHTS,
  )
  const reference = summarizeScriptedBotWeightEvaluation(
    evaluateScriptedBotWeights({
      seeds: options.seeds,
      candidateWeights: resolvedFinalWeights,
      opponentWeights: options.opponentWeights ?? resolvedBaselineWeights,
      maxSteps: options.maxSteps,
    }),
  )

  const rows = (Object.keys(resolvedFinalWeights) as Array<keyof ScriptedBotWeights>)
    .map(key => {
      const ablatedWeights = {
        ...resolvedFinalWeights,
        [key]: resolvedBaselineWeights[key],
      }
      const ablated = summarizeScriptedBotWeightEvaluation(
        evaluateScriptedBotWeights({
          seeds: options.seeds,
          candidateWeights: ablatedWeights,
          opponentWeights: options.opponentWeights ?? resolvedBaselineWeights,
          maxSteps: options.maxSteps,
        }),
      )

      return {
        key,
        baselineValue: resolvedBaselineWeights[key],
        finalValue: resolvedFinalWeights[key],
        delta: resolvedFinalWeights[key] - resolvedBaselineWeights[key],
        ablated,
        scoreDrop: reference.score - ablated.score,
        passengerDrop: reference.averagePassengers - ablated.averagePassengers,
        winRateDrop: reference.winRate - ablated.winRate,
        timeoutIncrease: ablated.timeoutRate - reference.timeoutRate,
        rank: 0,
      }
    })
    .sort((rowA, rowB) =>
      rowB.passengerDrop - rowA.passengerDrop ||
      rowB.scoreDrop - rowA.scoreDrop ||
      rowB.winRateDrop - rowA.winRateDrop ||
      rowB.timeoutIncrease - rowA.timeoutIncrease ||
      Math.abs(rowB.delta) - Math.abs(rowA.delta),
    )
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }))

  return {
    reference,
    rows,
  }
}
