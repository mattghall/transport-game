import type { GameState, PlayerState, WeeklyPhase } from "./types"

type LegacyWeeklyPhase = WeeklyPhase | "claim-routes" | "purchase-fuel"
type LegacyPlayerState = Omit<PlayerState, "phase"> & { phase?: WeeklyPhase }

type LegacyGameState = Omit<
  GameState,
  | "currentPhase"
  | "players"
  | "bureaucracyReadyPlayerIds"
  | "purchasedVehiclePlayerIds"
  | "claimedRoutePlayerIdsThisTurn"
  | "claimedRouteCountsByPlayerIdThisTurn"
  | "actionLog"
> & {
  currentPhase: LegacyWeeklyPhase
  players: LegacyPlayerState[]
  purchaseEquipmentReadyPlayerIds?: string[]
  addCityReadyPlayerIds?: string[]
  operationsReadyPlayerIds?: string[]
  bureaucracyReadyPlayerIds?: string[]
  claimRoutesReadyPlayerIds?: string[]
  purchasedVehiclePlayerIds?: string[]
  hasPurchasedVehicleThisTurn?: boolean
  claimedRoutePlayerIdsThisTurn?: string[]
  claimedRouteCountsByPlayerIdThisTurn?: Record<string, number>
  actionLog: Array<Omit<GameState["actionLog"][number], "phase"> & { phase: LegacyWeeklyPhase }>
}

export function normalizeWeeklyPhase(phase: LegacyWeeklyPhase): WeeklyPhase {
  if (phase === "claim-routes") {
    return "add-city"
  }

  if (phase === "purchase-fuel") {
    return "bureaucracy"
  }

  return phase
}

function derivePlayerPhase(game: LegacyGameState, playerId: string): WeeklyPhase {
  const addCityReadyPlayerIds = game.addCityReadyPlayerIds ?? game.claimRoutesReadyPlayerIds ?? []
  const operationsReadyPlayerIds = game.operationsReadyPlayerIds ?? []
  const bureaucracyReadyPlayerIds = game.bureaucracyReadyPlayerIds ?? []

  if (bureaucracyReadyPlayerIds.includes(playerId)) return "bureaucracy"
  if (operationsReadyPlayerIds.includes(playerId)) return "bureaucracy"
  if (addCityReadyPlayerIds.includes(playerId)) return "operations"
  if ((game.purchaseEquipmentReadyPlayerIds ?? []).includes(playerId)) return "add-city"

  return normalizeWeeklyPhase(game.currentPhase ?? "purchase-equipment")
}

export function normalizeGameState(game: LegacyGameState): GameState {
  return {
    ...game,
    players: game.players.map(player => ({
      ...player,
      phase: player.phase ?? derivePlayerPhase(game, player.id),
    })),
    currentPhase: normalizeWeeklyPhase(game.currentPhase),
    bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds ?? [],
    purchasedVehiclePlayerIds:
      game.purchasedVehiclePlayerIds ??
      (game.hasPurchasedVehicleThisTurn ? [game.currentPlayerId] : []),
    claimedRoutePlayerIdsThisTurn: game.claimedRoutePlayerIdsThisTurn ?? [],
    claimedRouteCountsByPlayerIdThisTurn: game.claimedRouteCountsByPlayerIdThisTurn ?? {},
    actionLog: game.actionLog.map(entry => ({
      ...entry,
      phase: normalizeWeeklyPhase(entry.phase),
    })),
  }
}
