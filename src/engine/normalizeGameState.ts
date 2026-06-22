import type { ActiveCityOffer, GameState, PlayerState, WeeklyPhase } from "./types"

type LegacyWeeklyPhase = WeeklyPhase | "claim-routes" | "purchase-fuel"
type LegacyPlayerState = Omit<PlayerState, "phase" | "vehicleWeeksOwnedByCardId"> & { phase?: WeeklyPhase; vehicleWeeksOwnedByCardId?: Record<string, number> }
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
  | "chanceCardsEnabled"
  | "turnTimerSeconds"
  | "turnTimerExpiresAt"
  | "autoPlayUntilWeek"
> & {
  currentPhase: LegacyWeeklyPhase
  players: LegacyPlayerState[]
  activeCityOffer: LegacyActiveCityOffer | null
  chanceCardsEnabled?: boolean
  bureaucracyReadyPlayerIds?: string[]
  purchasedVehiclePlayerIds?: string[]
  claimedRoutePlayerIdsThisTurn?: string[]
  claimedRouteCountsByPlayerIdThisTurn?: Record<string, number>
  actionLog: Array<Omit<GameState["actionLog"][number], "phase"> & { phase: LegacyWeeklyPhase }>
  turnTimerSeconds?: number
  turnTimerExpiresAt?: number | null
  autoPlayUntilWeek?: number
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
      vehicleWeeksOwnedByCardId: player.vehicleWeeksOwnedByCardId ?? {},
    })),
    currentPhase: normalizedPhase,
    activeCityOffer: game.activeCityOffer
      ? { ...game.activeCityOffer, playerId: game.activeCityOffer.playerId ?? game.currentPlayerId }
      : null,
    bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds ?? [],
    purchasedVehiclePlayerIds: game.purchasedVehiclePlayerIds ?? [],
    claimedRoutePlayerIdsThisTurn: game.claimedRoutePlayerIdsThisTurn ?? [],
    claimedRouteCountsByPlayerIdThisTurn: game.claimedRouteCountsByPlayerIdThisTurn ?? {},
    chanceCardsEnabled: game.chanceCardsEnabled ?? true,
    turnTimerSeconds: game.turnTimerSeconds ?? 0,
    turnTimerExpiresAt: game.turnTimerExpiresAt ?? null,
    autoPlayUntilWeek: game.autoPlayUntilWeek ?? 0,
    actionLog: game.actionLog.map(entry => ({
      ...entry,
      phase: normalizeWeeklyPhase(entry.phase),
    })),
  }
}
