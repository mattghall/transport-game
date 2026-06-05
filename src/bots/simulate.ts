import { createGameState, type CreateGameStateOptions } from "../engine/createGameState"
import { buildVictoryStandings } from "../engine/economy"
import type { GameState } from "../engine/types"
import { usMap } from "../data/maps/usMap"
import { createPresetBotController, DEFAULT_BOT_PRESET_ID } from "./presets"
import { PLAYER_SETUP_PRESETS } from "../gameSetup/defaultPlayers"
import { applyBotAction, getBotLegalActions, getNextBotPlayerId } from "./actions"
import type { BotAction, BotController } from "./types"

export type SimulationTraceEntry = {
  step: number
  playerId: string
  phase: GameState["currentPhase"]
  action: BotAction
}

export type SimulationOptions = CreateGameStateOptions & {
  seed?: number
  players?: CreateGameStateOptions["players"]
  maxSteps?: number
  recordTrace?: boolean
  botsByPlayerId?: Record<string, BotController>
}

export type SimulationResult = {
  game: GameState
  steps: number
  trace: SimulationTraceEntry[]
  winnerId: string | null
  timedOut: boolean
}

function getDefaultSimulationPlayers(playerCount = 4) {
  return PLAYER_SETUP_PRESETS.slice(0, playerCount).map((player, index) => ({
    ...player,
    name: `Bot ${index + 1}`,
    isBot: true,
    botPreset: DEFAULT_BOT_PRESET_ID,
  }))
}

function getBotController(game: GameState, playerId: string, botsByPlayerId: Record<string, BotController>) {
  return (
    botsByPlayerId[playerId] ??
    createPresetBotController(
      playerId,
      game.players.find(player => player.id === playerId)?.botPreset,
      game.botPresetWeightsById,
    )
  )
}

export function createSimulationGame(options: SimulationOptions = {}) {
  const players = options.players && options.players.length > 0
    ? options.players
    : getDefaultSimulationPlayers()

  return createGameState(usMap, {
    ...options,
    players,
    seed: options.seed,
  })
}

export function runBotSimulation(options: SimulationOptions = {}): SimulationResult {
  const trace: SimulationTraceEntry[] = []
  const botsByPlayerId =
    options.botsByPlayerId ??
    Object.fromEntries(
      (options.players ?? getDefaultSimulationPlayers()).map(player => [
        player.id,
        createPresetBotController(player.id, player.botPreset, options.botPresetWeightsById),
      ]),
    )
  let game = createSimulationGame(options)
  const maxSteps = options.maxSteps ?? 2_000
  const recordTrace = options.recordTrace ?? true

  for (let step = 1; step <= maxSteps; step += 1) {
    if (game.isGameOver) {
      const winnerId = buildVictoryStandings(game)[0]?.player.id ?? null
      return {
        game,
        steps: step - 1,
        trace,
        winnerId,
        timedOut: false,
      }
    }

    const playerId = getNextBotPlayerId(game)

    if (!playerId) {
      throw new Error(`No pending bot player found during ${game.currentPhase}.`)
    }

    const legalActions = getBotLegalActions(game, playerId)
    const bot = getBotController(game, playerId, botsByPlayerId)
    const action = bot.pickAction({
      game,
      playerId,
      legalActions,
      phase: game.currentPhase,
    })

    if (recordTrace) {
      trace.push({
        step,
        playerId,
        phase: game.currentPhase,
        action,
      })
    }
    game = applyBotAction(game, playerId, action)
  }

  return {
    game,
    steps: maxSteps,
    trace,
    winnerId: null,
    timedOut: true,
  }
}
