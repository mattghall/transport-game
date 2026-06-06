import type { GameState, WeeklyPhase } from "./types"

type LegacyWeeklyPhase = WeeklyPhase | "claim-routes"

type LegacyGameState = Omit<GameState, "currentPhase" | "addCityReadyPlayerIds" | "actionLog"> & {
  currentPhase: LegacyWeeklyPhase
  addCityReadyPlayerIds?: string[]
  claimRoutesReadyPlayerIds?: string[]
  actionLog: Array<Omit<GameState["actionLog"][number], "phase"> & { phase: LegacyWeeklyPhase }>
}

export function normalizeWeeklyPhase(phase: LegacyWeeklyPhase): WeeklyPhase {
  return phase === "claim-routes" ? "add-city" : phase
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
