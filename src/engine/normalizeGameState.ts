import type { GameState, WeeklyPhase } from "./types"

type LegacyWeeklyPhase = WeeklyPhase | "claim-routes" | "purchase-fuel"

type LegacyGameState = Omit<GameState, "currentPhase" | "addCityReadyPlayerIds" | "actionLog"> & {
  currentPhase: LegacyWeeklyPhase
  addCityReadyPlayerIds?: string[]
  claimRoutesReadyPlayerIds?: string[]
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
  return {
    ...game,
    currentPhase: normalizeWeeklyPhase(game.currentPhase),
    addCityReadyPlayerIds: game.addCityReadyPlayerIds ?? game.claimRoutesReadyPlayerIds ?? [],
    actionLog: game.actionLog.map(entry => ({
      ...entry,
      phase: normalizeWeeklyPhase(entry.phase),
    })),
  }
}
