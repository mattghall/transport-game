import type { ActiveCityOffer, GameState, PlayerState, WeeklyPhase } from "./types"

type LegacyWeeklyPhase = WeeklyPhase | "claim-routes" | "purchase-fuel"
type LegacyPlayerState = Omit<PlayerState, "phase"> & { phase?: WeeklyPhase }
type LegacyActiveCityOffer = Omit<ActiveCityOffer, "playerId"> & { playerId?: string }

type LegacyGameState = Omit<
  GameState,
  | "currentPhase"
  | "players"
  | "bureaucracyReadyPlayerIds"
  | "purchasedVehiclePlayerIds"
  | "claimedRoutePlayerIdsThisTurn"
  | "claimedRouteCountsByPlayerIdThisTurn"
  | "actionLog"
  | "activeCityOffer"
> & {
  currentPhase: LegacyWeeklyPhase
  players: LegacyPlayerState[]
  activeCityOffer: LegacyActiveCityOffer | null
  bureaucracyReadyPlayerIds?: string[]
  purchasedVehiclePlayerIds?: string[]
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

export function normalizeGameState(game: LegacyGameState): GameState {
  const normalizedPhase = normalizeWeeklyPhase(game.currentPhase)
  return {
    ...game,
    players: game.players.map(player => ({
      ...player,
      phase: player.phase ?? normalizedPhase,
    })),
    currentPhase: normalizedPhase,
    activeCityOffer: game.activeCityOffer
      ? { ...game.activeCityOffer, playerId: game.activeCityOffer.playerId ?? game.currentPlayerId }
      : null,
    bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds ?? [],
    purchasedVehiclePlayerIds: game.purchasedVehiclePlayerIds ?? [],
    claimedRoutePlayerIdsThisTurn: game.claimedRoutePlayerIdsThisTurn ?? [],
    claimedRouteCountsByPlayerIdThisTurn: game.claimedRouteCountsByPlayerIdThisTurn ?? {},
    actionLog: game.actionLog.map(entry => ({
      ...entry,
      phase: normalizeWeeklyPhase(entry.phase),
    })),
  }
}
