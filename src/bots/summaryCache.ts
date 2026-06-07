import { buildPlayerBureaucracySummary } from "../engine/bureaucracy"
import type { GameState } from "../engine/types"

// WeakMap-based cache so the same game state object never triggers duplicate
// buildPlayerBureaucracySummary calls within the same decision cycle.
// Entries are automatically GC'd when the game state object is no longer referenced.
const summaryCache = new WeakMap<
  GameState,
  Map<string, ReturnType<typeof buildPlayerBureaucracySummary>>
>()

export function getCachedBureaucracySummary(game: GameState, playerId: string) {
  let playerMap = summaryCache.get(game)
  if (!playerMap) {
    playerMap = new Map()
    summaryCache.set(game, playerMap)
  }
  if (!playerMap.has(playerId)) {
    playerMap.set(playerId, buildPlayerBureaucracySummary(game, playerId))
  }
  return playerMap.get(playerId)
}
