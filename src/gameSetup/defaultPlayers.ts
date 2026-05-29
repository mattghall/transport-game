import type { GameSetupPlayer } from "../engine/createGameState"

export const PLAYER_SETUP_PRESETS: GameSetupPlayer[] = [
  { id: "p1", name: "Matt", color: "#457b9d" },
  // { id: "p2", name: "Sarah", color: "#e96620" },
  // { id: "p3", name: "MILLY", color: "#6f42c1" },
  // { id: "p4", name: "Jordan", color: "#2a9d8f" },
]

export const MAX_SETUP_PLAYERS = PLAYER_SETUP_PRESETS.length

export function createDefaultSetupPlayers() {
  return PLAYER_SETUP_PRESETS.slice(0, 1).map(player => ({ ...player }))
}
