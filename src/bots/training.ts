import { buildVictoryStandings } from "../engine/economy"
import { createInitialRandomState, randomFloatFromState } from "../engine/random"
import { PLAYER_SETUP_PRESETS } from "../gameSetup/defaultPlayers"
import type { GameSetupPlayer } from "../engine/createGameState"
import {
  FROZEN_SCRIPTED_BOT_WEIGHT_KEYS,
  MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS,
  SCRIPTED_BOT_LEVER_METADATA,
  SCRIPTED_BOT_WEIGHT_KEYS,
  applyFrozenScriptedBotWeights,
} from "./leverMetadata"
import { runBotSimulation } from "./simulate"
import {
  createScriptedBot,
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  mergeScriptedBotWeights,
  type ScriptedBotWeights,
} from "./scriptedBot"

export type ScriptedBotWeightSample = {
  seed: number
  candidatePlayerId: string
  rank: number
  passengers: number
  opponentPassengers: number
  passengerMargin: number
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
  averagePassengerMargin: number
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
  averagePassengerMargin: number
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
    playerCount: number
    baseSeed: number
    candidatesPerIteration: number
    mutationSeed: number
    maxSteps: number
    outputPath: string
    mutableLeverKeys: Array<keyof ScriptedBotWeights>
    frozenLeverKeys: Array<keyof ScriptedBotWeights>
  }
  baseline: ScriptedBotWeightEvaluationSummary
  history: ScriptedBotTrainingHistoryEntry[]
  final: ScriptedBotWeightEvaluationSummary
}

export type ScriptedBotTrainingRunOptions = {
  iterations: number
  gamesPerCandidate: number
  playerCount: number
  baseSeed: number
  candidatesPerIteration: number
  mutationSeed: number
  maxSteps: number
  outputPath: string
  initialWeights?: Partial<ScriptedBotWeights>
  opponentWeights?: Partial<ScriptedBotWeights>
  opponentPoolWeights?: Partial<ScriptedBotWeights>[]
  frozenWeights?: Partial<ScriptedBotWeights>
  onIterationComplete?: (progress: {
    iteration: number
    totalIterations: number
    temperature: number
    best: ScriptedBotWeightEvaluationSummary
    candidate: ScriptedBotWeightEvaluationSummary | null
  }) => void
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
    playerCount: number
    baseSeed: number
    maxSteps: number
    outputPath: string
    mutableLeverKeys: Array<keyof ScriptedBotWeights>
    frozenLeverKeys: Array<keyof ScriptedBotWeights>
  }
}

function createTrainingPlayers(playerCount = 4): GameSetupPlayer[] {
  return PLAYER_SETUP_PRESETS.slice(0, playerCount).map((player, index) => ({
    ...player,
    name: `Bot ${index + 1}`,
    isBot: true,
  }))
}

export function createTrainingSeeds(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => start + index)
}

export function evaluateScriptedBotWeights(options: {
  seeds: number[]
  candidateWeights: Partial<ScriptedBotWeights>
  opponentWeights?: Partial<ScriptedBotWeights>
  opponentPoolWeights?: Partial<ScriptedBotWeights>[]
  playerCount?: number
  maxSteps?: number
}): ScriptedBotWeightEvaluation {
  const players = createTrainingPlayers(options.playerCount)
  const resolvedCandidateWeights = mergeScriptedBotWeights(options.candidateWeights)
  const resolvedOpponentPool =
    options.opponentPoolWeights && options.opponentPoolWeights.length > 0
      ? options.opponentPoolWeights.map(weights => mergeScriptedBotWeights(weights))
      : [mergeScriptedBotWeights(options.opponentWeights ?? DEFAULT_SCRIPTED_BOT_WEIGHTS)]
  const samples = options.seeds.map((seed, index) => {
    const candidatePlayerId = players[index % players.length]?.id ?? players[0].id
    let opponentSeatIndex = 0
    const botsByPlayerId = Object.fromEntries(
      players.map(player => [
        player.id,
        createScriptedBot(
          player.id,
          player.id === candidatePlayerId
            ? resolvedCandidateWeights
            : resolvedOpponentPool[(index + opponentSeatIndex++) % resolvedOpponentPool.length],
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
    const strongestOpponentStanding = standings.find(standing => standing.player.id !== candidatePlayerId)
    const passengers = candidateStanding?.player.totalPassengersServed ?? 0
    // In 1-player training there is no opponent, so the lead target is measured against zero.
    const opponentPassengers = strongestOpponentStanding?.player.totalPassengersServed ?? 0

    return {
      seed,
      candidatePlayerId,
      rank:
        candidateStanding === undefined
          ? standings.length + 1
          : standings.findIndex(standing => standing.player.id === candidatePlayerId) + 1,
      passengers,
      opponentPassengers,
      passengerMargin: passengers - opponentPassengers,
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
  const averagePassengerMargin =
    samples.reduce((total, sample) => total + sample.passengerMargin, 0) / sampleCount
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
    averagePassengerMargin,
    averageConnectedCities,
    averageMoney,
    timeoutRate,
    score:
      averagePassengers +
      averagePassengerMargin +
      winRate * 5_000 -
      averageRank * 1_000 +
      averageConnectedCities * 50 +
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
    averagePassengerMargin: evaluation.averagePassengerMargin,
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
  frozenWeights?: Partial<ScriptedBotWeights>,
) {
  const resolvedBaseWeights = applyFrozenScriptedBotWeights(baseWeights, frozenWeights)
  let nextRandomState = randomState
  const nextWeights = { ...resolvedBaseWeights }

  for (const key of SCRIPTED_BOT_WEIGHT_KEYS) {
    const nextRandom = randomFloatFromState(nextRandomState)
    nextRandomState = nextRandom.randomState
    const metadata = SCRIPTED_BOT_LEVER_METADATA[key]

    if (!metadata.enabled) {
      nextWeights[key] = resolvedBaseWeights[key]
      continue
    }

    const delta = (nextRandom.value * 2 - 1) * metadata.mutationStep * temperature
    const minimum = metadata.minimum
    nextWeights[key] =
      minimum === undefined
        ? resolvedBaseWeights[key] + delta
        : Math.max(minimum, resolvedBaseWeights[key] + delta)
  }

  return {
    weights: applyFrozenScriptedBotWeights(nextWeights, frozenWeights),
    randomState: nextRandomState,
  }
}

export function analyzeScriptedBotLeverImportance(options: {
  seeds: number[]
  finalWeights: Partial<ScriptedBotWeights>
  baselineWeights?: Partial<ScriptedBotWeights>
  opponentWeights?: Partial<ScriptedBotWeights>
  opponentPoolWeights?: Partial<ScriptedBotWeights>[]
  playerCount?: number
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
      opponentPoolWeights: options.opponentPoolWeights,
      playerCount: options.playerCount,
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
          opponentPoolWeights: options.opponentPoolWeights,
          playerCount: options.playerCount,
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

export function runScriptedBotTraining(options: ScriptedBotTrainingRunOptions): ScriptedBotTrainingResults {
  let randomState = createInitialRandomState(options.mutationSeed)
  const initialWeights = applyFrozenScriptedBotWeights(
    options.initialWeights ?? DEFAULT_SCRIPTED_BOT_WEIGHTS,
    options.frozenWeights,
  )
  let best = evaluateScriptedBotWeights({
    seeds: createTrainingSeeds(options.baseSeed, options.gamesPerCandidate),
    candidateWeights: initialWeights,
    opponentWeights: options.opponentWeights,
    opponentPoolWeights: options.opponentPoolWeights,
    playerCount: options.playerCount,
    maxSteps: options.maxSteps,
  })
  const baselineSummary = summarizeScriptedBotWeightEvaluation(best)
  const history: ScriptedBotTrainingHistoryEntry[] = []

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const temperature = Math.max(0.2, 1 - iteration / Math.max(options.iterations, 1))
    const candidates = Array.from(
      { length: Math.max(options.candidatesPerIteration, 1) },
      (_, candidateIndex) => {
        const mutated = mutateScriptedBotWeights(
          best.weights,
          randomState,
          temperature,
          options.frozenWeights,
        )
        randomState = mutated.randomState

        return evaluateScriptedBotWeights({
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
        })
      },
    ).sort((evaluationA, evaluationB) => evaluationB.score - evaluationA.score)

    const candidateBest = candidates[0]
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
      playerCount: options.playerCount,
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
