import { getConnectedCityIds } from "../engine/economy"
import type { GameState } from "../engine/types"

export type BotGameStage = "early" | "mid" | "late"

export const MAX_BOT_OPERATION_CITY_CANDIDATES = 8

export function getBotGameStage(game: Pick<GameState, "currentWeek" | "operatingConfig">): BotGameStage {
  const totalWeeks = Math.max(game.operatingConfig.totalWeeks, 1)
  const normalizedProgress = totalWeeks <= 1 ? 1 : (game.currentWeek - 1) / (totalWeeks - 1)

  if (normalizedProgress < 1 / 3) {
    return "early"
  }

  if (normalizedProgress < 2 / 3) {
    return "mid"
  }

  return "late"
}

export function getOwnedCityPairs(
  game: Pick<GameState, "cities" | "players" | "routes">,
  playerId: string,
  maxCityCount = MAX_BOT_OPERATION_CITY_CANDIDATES,
): Array<[string, string]> {
  const player = game.players.find(candidate => candidate.id === playerId) ?? null

  if (!player || player.ownedCityCardIds.length < 2) {
    return []
  }

  const cityMap = new Map(game.cities.map(city => [city.id, city]))
  const connectedCityIdSet = new Set(getConnectedCityIds(game as GameState, playerId))
  const prioritizedOwnedCityIds = [...new Set(player.ownedCityCardIds)]
    .sort((cityIdA, cityIdB) => {
      const cityA = cityMap.get(cityIdA)
      const cityB = cityMap.get(cityIdB)
      const scoreA =
        (connectedCityIdSet.has(cityIdA) ? 0 : 10_000_000) +
        (cityA?.population ?? cityA?.size ?? 0)
      const scoreB =
        (connectedCityIdSet.has(cityIdB) ? 0 : 10_000_000) +
        (cityB?.population ?? cityB?.size ?? 0)
      return scoreB - scoreA
    })
    .slice(0, Math.max(maxCityCount, 2))
  const pairs: Array<[string, string]> = []

  for (let firstIndex = 0; firstIndex < prioritizedOwnedCityIds.length - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < prioritizedOwnedCityIds.length; secondIndex += 1) {
      pairs.push([prioritizedOwnedCityIds[firstIndex], prioritizedOwnedCityIds[secondIndex]])
    }
  }

  return pairs
}
