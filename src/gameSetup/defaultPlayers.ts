import type { GameSetupPlayer } from "../engine/createGameState"

export const PLAYER_SETUP_PRESETS: GameSetupPlayer[] = [
  { id: "p1", name: "Player 1", color: "#457b9d" },
  { id: "p2", name: "Player 2", color: "#e96620" },
  { id: "p3", name: "Player 3", color: "#6f42c1" },
  { id: "p4", name: "Player 4", color: "#2a9d8f" },
  { id: "p5", name: "Player 5", color: "#e63946" },
  { id: "p6", name: "Player 6", color: "#ffb703" },
]

export const MAX_SETUP_PLAYERS = PLAYER_SETUP_PRESETS.length

export function createDefaultSetupPlayers() {
  return PLAYER_SETUP_PRESETS.slice(0, 1).map(player => ({ ...player }))
}
