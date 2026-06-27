import {
  canPlayerEditOperations,
  canPlayerPickCities,
  canPlayerStartPhaseByPipeline,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedOperations,
  hasPlayerCompletedPurchaseEquipment,
} from "../engine/actions"
import { applyBotAction, getBotLegalActions, getPendingBotPlayerId } from "../bots/actions"
import type { BotAction } from "../bots/types"
import { createPresetBotController, DEFAULT_BOT_PRESET_ID, getPlayerBotPreset, normalizeBotPresetId } from "../bots/presets"
import { MAX_SETUP_PLAYERS, PLAYER_SETUP_PRESETS } from "../gameSetup/defaultPlayers"
import type { GameSetupPlayer } from "../engine/createGameState"
import type { GameActionLogEntry, GameState, WeeklyPhase } from "../engine/types"

// ── Phase label ──────────────────────────────────────────────────────────────

export function formatPhaseLabel(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "purchase equipment"
    case "add-city":
      return "add city"
    case "operations":
      return "operations"
    case "bureaucracy":
      return "bureaucracy"
  }
}

// ── Action log helpers ───────────────────────────────────────────────────────

export function appendActionLog(
  previousGame: GameState,
  nextGame: GameState,
  message: string,
  playerId: string | null = previousGame.currentPlayerId,
) {
  const playerName =
    (playerId && previousGame.players.find(player => player.id === playerId)?.name) ?? "System"
  const entry: GameActionLogEntry = {
    id: `action-${previousGame.actionLog.length + 1}`,
    playerId,
    playerName,
    week: previousGame.currentWeek,
    phase: previousGame.currentPhase,
    message,
  }

  return {
    ...nextGame,
    actionLog: [...nextGame.actionLog, entry],
  }
}

export function getAdvanceTurnLogMessage(previousGame: GameState, nextGame: GameState) {
  const nextPlayer = nextGame.players.find(player => player.id === nextGame.currentPlayerId)

  if (
    previousGame.currentPhase === "purchase-equipment" &&
    nextGame.currentPhase === "purchase-equipment"
  ) {
    return "finished purchasing"
  }

  return nextGame.currentWeek !== previousGame.currentWeek
    ? `advanced to year ${nextGame.currentWeek} ${formatPhaseLabel(nextGame.currentPhase)}`
    : nextGame.currentPhase !== previousGame.currentPhase
      ? `advanced to ${formatPhaseLabel(nextGame.currentPhase)}`
      : `ended turn, next player ${nextPlayer?.name ?? nextGame.currentPlayerId}`
}

export function getPhaseDiscardLogMessage(previousGame: GameState, nextGame: GameState) {
  const burnedVehicleCards =
    previousGame.currentPhase === "purchase-equipment" &&
    nextGame.currentPhase === "add-city" &&
    previousGame.vehicleMarketCardIds.length !== nextGame.vehicleMarketCardIds.length
      ? previousGame.vehicleMarketCardIds
          .filter(cardId => !nextGame.vehicleMarketCardIds.includes(cardId))
          .map(cardId => previousGame.vehicleCatalog.find(card => card.id === cardId) ?? null)
          .filter((card): card is NonNullable<typeof card> => card !== null)
          .sort((cardA, cardB) => cardA.type.localeCompare(cardB.type) || cardA.number - cardB.number)
      : []
  const messages = [
    ...burnedVehicleCards.map(
      card =>
        `removed vehicle #${card.number} ${card.name} from the ${card.type} deck because nobody bought a ${card.type === "air" ? "plane" : card.type} this year`,
    ),
  ]

  return messages.length > 0 ? messages.join("; ") : null
}

export function getBotActionLogMessage(
  previousGame: GameState,
  nextGame: GameState,
  action: BotAction,
) {
  return action.type === "buy-vehicle"
    ? (() => {
        const card = previousGame.vehicleCatalog.find(vehicleCard => vehicleCard.id === action.cardId)
        return card
          ? `purchased ${action.quantity} vehicle${action.quantity === 1 ? "" : "s"} of #${card.number} ${card.name}`
          : "purchased a vehicle"
      })()
    : action.type === "draw-city-offer"
      ? `drew 4 city cards from the ${action.region} deck`
      : action.type === "keep-city-offer"
        ? "picked 2 city cards from the draw"
        : action.type === "confirm-add-city-picks"
          ? nextGame.currentPhase === "operations"
            ? "confirmed city picks and opened Operations for every player"
            : `confirmed city picks; ${nextGame.players.find(player => player.id === nextGame.currentPlayerId)?.name ?? nextGame.currentPlayerId} is selecting cities`
          : action.type === "create-service-pod"
            ? (() => {
                const cityMap = new Map(previousGame.cities.map(city => [city.id, city]))
                const cityLabel = action.cityIds
                  .map(cityId => cityMap.get(cityId)?.name ?? cityId)
                  .join(" - ")
                return `created a service pod for ${cityLabel}`
              })()
            : action.type === "delete-service-pod"
              ? "deleted a service pod"
            : action.type === "ready-operations"
              ? nextGame.currentPhase === "bureaucracy"
                ? "finished operations planning and advanced to bureaucracy"
                : "finished operations planning"
              : action.type === "ready-bureaucracy"
                ? nextGame.currentPhase === "purchase-equipment"
                  ? "finished bureaucracy review and advanced to purchase equipment"
                  : "finished bureaucracy review"
                : getAdvanceTurnLogMessage(previousGame, nextGame)
}

// ── Bot turn runner ──────────────────────────────────────────────────────────

export function runBotTurns(game: GameState, botPlayerIds: ReadonlySet<string>) {
  let nextGame = game
  let hasChanged = false

  while (true) {
    const actingBotPlayerId = getPendingBotPlayerId(nextGame, botPlayerIds)

    if (!actingBotPlayerId) {
      break
    }

    const legalActions = getBotLegalActions(nextGame, actingBotPlayerId)

    if (legalActions.length === 0) {
      break
    }

    const action = createPresetBotController(
      actingBotPlayerId,
      getPlayerBotPreset(nextGame.players.find(player => player.id === actingBotPlayerId) ?? null),
      nextGame.botPresetWeightsById,
    ).pickAction({
      game: nextGame,
      playerId: actingBotPlayerId,
      legalActions,
      phase: nextGame.currentPhase,
    })
    const advancedGame = applyBotAction(nextGame, actingBotPlayerId, action)
    const discardMessage =
      action.type === "end-turn" ? getPhaseDiscardLogMessage(nextGame, advancedGame) : null
    const actionMessage = getBotActionLogMessage(nextGame, advancedGame, action)
    const fullMessage = discardMessage ? `${actionMessage}; ${discardMessage}` : actionMessage

    nextGame = appendActionLog(nextGame, advancedGame, fullMessage, actingBotPlayerId)
    hasChanged = true
  }

  return {
    game: nextGame,
    hasChanged,
  }
}

// ── Viewing player helpers ───────────────────────────────────────────────────

export function getDefaultLocalViewingPlayerId(game: GameState) {
  const humanPlayers = game.players.filter(player => !player.isBot)

  if (humanPlayers.length === 0) {
    return null
  }

  if (game.currentPhase === "purchase-equipment") {
    return (
      humanPlayers.find(player => canPlayerPickCities(game, player.id))?.id ??
      humanPlayers.find(player => canPlayerEditOperations(game, player.id) && !hasPlayerCompletedOperations(game, player.id))?.id ??
      humanPlayers.find(
        player =>
          !hasPlayerCompletedPurchaseEquipment(game, player.id) &&
          canPlayerStartPhaseByPipeline(game, player.id, "purchase-equipment"),
      )?.id ??
      humanPlayers[0]?.id ??
      null
    )
  }

  if (game.currentPhase === "operations") {
    return (
      humanPlayers.find(player => canPlayerEditOperations(game, player.id) && !hasPlayerCompletedOperations(game, player.id))
        ?.id ??
      humanPlayers[0]?.id ??
      null
    )
  }

  if (game.currentPhase === "bureaucracy") {
    return (
      humanPlayers.find(player => !hasPlayerCompletedBureaucracy(game, player.id))?.id ??
      humanPlayers[0]?.id ??
      null
    )
  }

  if (game.currentPhase === "add-city") {
    return (
      humanPlayers.find(player => canPlayerPickCities(game, player.id))?.id ??
      humanPlayers.find(player => canPlayerEditOperations(game, player.id) && !hasPlayerCompletedOperations(game, player.id))
        ?.id ??
      humanPlayers.find(player => player.id === game.currentPlayerId)?.id ??
      humanPlayers[0]?.id ??
      null
    )
  }

  return humanPlayers.find(player => player.id === game.currentPlayerId)?.id ?? humanPlayers[0]?.id ?? null
}

export function getNextLocalViewingPlayerId(game: GameState, currentSelectedPlayerId: string | null = null) {
  const humanPlayers = game.players.filter(player => !player.isBot)

  if (humanPlayers.length === 0) {
    return null
  }

  if (
    currentSelectedPlayerId &&
    humanPlayers.some(player => player.id === currentSelectedPlayerId)
  ) {
    if (game.currentPhase === "operations" && canPlayerEditOperations(game, currentSelectedPlayerId)) {
      return currentSelectedPlayerId
    }

    if (game.currentPhase === "bureaucracy" && !hasPlayerCompletedBureaucracy(game, currentSelectedPlayerId)) {
      return currentSelectedPlayerId
    }

    if (
      game.currentPhase === "add-city" &&
      (canPlayerPickCities(game, currentSelectedPlayerId) || canPlayerEditOperations(game, currentSelectedPlayerId))
    ) {
      return currentSelectedPlayerId
    }

    if (
      game.currentPhase === "purchase-equipment" &&
      (
        canPlayerPickCities(game, currentSelectedPlayerId) ||
        canPlayerEditOperations(game, currentSelectedPlayerId) ||
        (!hasPlayerCompletedPurchaseEquipment(game, currentSelectedPlayerId) &&
          canPlayerStartPhaseByPipeline(game, currentSelectedPlayerId, "purchase-equipment"))
      )
    ) {
      return currentSelectedPlayerId
    }
  }

  return getDefaultLocalViewingPlayerId(game)
}

// ── Setup helpers ────────────────────────────────────────────────────────────

export function clampSetupPlayerCount(playerCount: number) {
  return Math.max(1, Math.min(MAX_SETUP_PLAYERS, Math.floor(playerCount) || 1))
}

export function getDefaultSetupPlayerName(index: number, isBot: boolean) {
  return isBot ? `Bot ${index + 1}` : `Player ${index + 1}`
}

export function normalizeSetupPlayers(players: GameSetupPlayer[]) {
  return PLAYER_SETUP_PRESETS.slice(0, clampSetupPlayerCount(players.length)).map((preset, index) => {
    const existingPlayer = players[index]
    const isBot = existingPlayer?.isBot ?? false
    const trimmedName = existingPlayer?.name?.trim() ?? ""
    const existingBotPreset = existingPlayer?.botPreset
      ? normalizeBotPresetId(existingPlayer.botPreset)
      : undefined

    return {
      ...preset,
      ...existingPlayer,
      isBot,
      botPreset: isBot ? existingBotPreset ?? DEFAULT_BOT_PRESET_ID : existingBotPreset,
      name: trimmedName || getDefaultSetupPlayerName(index, isBot),
    }
  })
}

export function createSetupPlayers(playerCount: number, botSeatIndexes: number[] = []) {
  const botSeatIndexSet = new Set(botSeatIndexes)

  return normalizeSetupPlayers(
    PLAYER_SETUP_PRESETS.slice(0, clampSetupPlayerCount(playerCount)).map((player, index) => ({
      ...player,
      isBot: botSeatIndexSet.has(index),
      botPreset: botSeatIndexSet.has(index) ? DEFAULT_BOT_PRESET_ID : undefined,
      name: getDefaultSetupPlayerName(index, botSeatIndexSet.has(index)),
    })),
  )
}
