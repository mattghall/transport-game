import type { GameState, Player, Route } from "./types"

function buildImplicitBusRouteId(cityAId: string, cityBId: string) {
  return `implicit-bus:${[cityAId, cityBId].sort().join(":")}`
}

export function getImplicitBusRoutes(game: GameState, player: Player): Route[] {
  const ownedCityIdSet = new Set(player.ownedCityCardIds)

  if (ownedCityIdSet.size < 2) {
    return []
  }

  const existingPairKeys = new Set(
    game.routes
      .filter(route => route.ownerId === player.id && route.mode === "bus")
      .map(route => [route.cityA, route.cityB].sort().join("|")),
  )

  return game.cities.flatMap(city =>
    (city.adjacentCities ?? []).flatMap(adjacentCity => {
      if (!ownedCityIdSet.has(city.id) || !ownedCityIdSet.has(adjacentCity.id)) {
        return []
      }

      const pairKey = [city.id, adjacentCity.id].sort().join("|")

      if (existingPairKeys.has(pairKey)) {
        return []
      }

      existingPairKeys.add(pairKey)

      return [
        {
          id: buildImplicitBusRouteId(city.id, adjacentCity.id),
          cityA: city.id,
          cityB: adjacentCity.id,
          mode: "bus" as const,
          railTraction: undefined,
          ownerId: player.id,
        },
      ]
    }),
  )
}

export function getPlayerOwnedNetworkRoutes(game: GameState, playerId: string) {
  const player = game.players.find(candidate => candidate.id === playerId)

  if (!player) {
    return []
  }

  const explicitOwnedRoutes = game.routes.filter(route => route.ownerId === player.id)
  const implicitBusRoutes = getImplicitBusRoutes(game, player)

  return [...explicitOwnedRoutes, ...implicitBusRoutes].sort((routeA, routeB) =>
    routeA.id.localeCompare(routeB.id),
  )
}

export function getPlayerConnectedCityIds(game: GameState, playerId: string) {
  const connectedCityIds = new Set<string>()

  for (const route of getPlayerOwnedNetworkRoutes(game, playerId)) {
    connectedCityIds.add(route.cityA)
    connectedCityIds.add(route.cityB)
  }

  return [...connectedCityIds]
}
