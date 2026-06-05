import type { GameSetupPlayer } from "../engine/createGameState"
import { MAX_SETUP_PLAYERS, PLAYER_SETUP_PRESETS } from "./defaultPlayers"

export type LocalGameMode = "solo" | "vs-bot" | "bot-only"

export function clampLocalBotCount(botCount: number) {
  return Math.max(1, Math.min(MAX_SETUP_PLAYERS, Math.floor(botCount)))
}

export function createLocalPlayers({
  mode,
  playerName,
  botCount = 1,
}: {
  mode: LocalGameMode
  playerName: string
  botCount?: number
}): GameSetupPlayer[] {
  const normalizedBotCount = clampLocalBotCount(botCount)
  const humanPlayer = {
    ...PLAYER_SETUP_PRESETS[0],
    name: playerName,
    isBot: false,
  }

  if (mode === "solo") {
    return [humanPlayer]
  }

  if (mode === "bot-only") {
    return PLAYER_SETUP_PRESETS.slice(0, normalizedBotCount).map((player, index) => ({
      ...player,
      name: normalizedBotCount === 1 ? "Bot" : `Bot ${index + 1}`,
      isBot: true,
    }))
  }

  return [
    humanPlayer,
    ...PLAYER_SETUP_PRESETS.slice(1, 1 + normalizedBotCount).map((player, index) => ({
      ...player,
      name: normalizedBotCount === 1 ? "Bot" : `Bot ${index + 1}`,
      isBot: true,
    })),
  ]
}
