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
  | "cityDemandMultipliersByCityId"
  | "turnTimerSeconds"
  | "turnTimerExpiresAt"
  | "autoPlayUntilWeek"
> & {
  currentPhase: LegacyWeeklyPhase
  players: LegacyPlayerState[]
  activeCityOffer: LegacyActiveCityOffer | null
  chanceCardsEnabled?: boolean
  cityDemandMultipliersByCityId?: Record<string, number>
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
    cityDemandMultipliersByCityId:
      game.cityDemandMultipliersByCityId ??
      Object.fromEntries((game.cities ?? []).map(city => [city.id, 1])),
    turnTimerSeconds: game.turnTimerSeconds ?? 0,
    turnTimerExpiresAt: game.turnTimerExpiresAt ?? null,
    autoPlayUntilWeek: game.autoPlayUntilWeek ?? 0,
    operatingConfig: {
      ...game.operatingConfig,
      simulationTicksPerPeriod: game.operatingConfig.simulationTicksPerPeriod ?? 4,
      weeksPerPeriod: game.operatingConfig.weeksPerPeriod ?? 52,
      cityDrawCount: game.operatingConfig.cityDrawCount ?? 4,
      cityTargetKeepCount: game.operatingConfig.cityTargetKeepCount ?? 2,
      cityMinimumKeepCount: game.operatingConfig.cityMinimumKeepCount ?? 1,
      dynamicDemand: {
        enabled: game.operatingConfig.dynamicDemand?.enabled ?? false,
        lowServiceThreshold: game.operatingConfig.dynamicDemand?.lowServiceThreshold ?? 0.25,
        lowServiceMultiplier: game.operatingConfig.dynamicDemand?.lowServiceMultiplier ?? 0.95,
        noServiceThreshold: game.operatingConfig.dynamicDemand?.noServiceThreshold ?? 0,
        noServiceMultiplier: game.operatingConfig.dynamicDemand?.noServiceMultiplier ?? 0.9,
        highServiceThreshold: game.operatingConfig.dynamicDemand?.highServiceThreshold ?? 0.75,
        highServiceMultiplier: game.operatingConfig.dynamicDemand?.highServiceMultiplier ?? 1.1,
        fullServiceThreshold: game.operatingConfig.dynamicDemand?.fullServiceThreshold ?? 1,
        fullServiceMultiplier: game.operatingConfig.dynamicDemand?.fullServiceMultiplier ?? 1.15,
      },
    },
    actionLog: game.actionLog.map(entry => ({
      ...entry,
      phase: normalizeWeeklyPhase(entry.phase),
    })),
  }
}
