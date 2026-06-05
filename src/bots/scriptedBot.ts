import { getPlayerById, calculateClaimRouteCost, resolveRouteSelection } from "../engine/actions"
import { getConnectedCityIds } from "../engine/economy"
import { getPlayerOwnedNetworkRoutes } from "../engine/playerNetwork"
import type { VehicleType } from "../engine/types"
import { getBotLegalActions } from "./actions"
import type { BotAction, BotController } from "./types"

const VEHICLE_PRIORITY: Record<VehicleType, number> = {
  bus: 88,
  train: 58,
  air: 42,
}

function getOwnedCityPairs(game: Parameters<BotController["pickAction"]>[0]["game"], playerId: string) {
  const player = getPlayerById(game, playerId)

  if (!player || player.ownedCityCardIds.length < 2) {
    return []
  }

  const cityMap = new Map(game.cities.map(city => [city.id, city]))
  const ownedCityIds = [...new Set(player.ownedCityCardIds)].sort((cityIdA, cityIdB) => {
    const cityA = cityMap.get(cityIdA)
    const cityB = cityMap.get(cityIdB)
    return (cityB?.population ?? cityB?.size ?? 0) - (cityA?.population ?? cityA?.size ?? 0)
  })
  const pairs: Array<[string, string]> = []

  for (let firstIndex = 0; firstIndex < ownedCityIds.length - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < ownedCityIds.length; secondIndex += 1) {
      pairs.push([ownedCityIds[firstIndex], ownedCityIds[secondIndex]])
    }
  }

  return pairs
}

function countPotentialClaims(
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  mode: "rail" | "air",
) {
  const player = getPlayerById(game, playerId)

  if (!player) {
    return 0
  }

  const cityMap = new Map(game.cities.map(city => [city.id, city]))

  return getOwnedCityPairs(game, playerId).filter(([cityAId, cityBId]) => {
    if (mode === "rail") {
      const cityA = cityMap.get(cityAId)
      const railPairIsAdjacent = cityA?.adjacentCities?.some(adjacentCity => adjacentCity.id === cityBId) ?? false

      if (!railPairIsAdjacent) {
        return false
      }
    }

    const resolvedSelection = resolveRouteSelection(game, [cityAId, cityBId], mode)

    if (!resolvedSelection.ok) {
      return false
    }

    if (mode === "rail" && calculateClaimRouteCost(game, { mode, cityIds: [cityAId, cityBId] }) > player.money) {
      return false
    }

    return true
  }).length
}

function scoreClaimRouteAction(
  action: Extract<BotAction, { type: "claim-route" }>,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
) {
  const cityMap = new Map(game.cities.map(city => [city.id, city]))
  const connectedCityIdSet = new Set(getConnectedCityIds(game, playerId))
  const existingRoutesOfMode = getPlayerOwnedNetworkRoutes(game, playerId).filter(
    route => route.mode === action.mode,
  )
  const totalPopulation = action.cityIds.reduce(
    (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
    0,
  )
  const newCityCount = action.cityIds.filter(cityId => !connectedCityIdSet.has(cityId)).length
  const cost = calculateClaimRouteCost(game, {
    mode: action.mode,
    cityIds: action.cityIds,
  })

  return (
    (action.mode === "rail" ? 120 : 104) +
    totalPopulation / 200_000 +
    newCityCount * 24 +
    (existingRoutesOfMode.length === 0 ? 18 : 0) -
    cost / 1_000_000
  )
}

function scoreBotAction(action: BotAction, game: Parameters<BotController["pickAction"]>[0]["game"], playerId: string) {
  if (action.type === "claim-route") {
    return scoreClaimRouteAction(action, game, playerId)
  }

  if (action.type !== "buy-vehicle") {
    if (action.type === "ready-operations" || action.type === "end-turn") {
      return 0
    }

    return 10
  }

  const player = getPlayerById(game, playerId)
  const card = game.vehicleCatalog.find(vehicleCard => vehicleCard.id === action.cardId)

  if (!player || !card) {
    return Number.NEGATIVE_INFINITY
  }

  const ownedCityCount = player.ownedCityCardIds.length
  const ownedVehicleCount = player.ownedVehicleCardIds
    .map(cardId => game.vehicleCatalog.find(vehicleCard => vehicleCard.id === cardId) ?? null)
    .filter((vehicleCard): vehicleCard is NonNullable<typeof card> => vehicleCard !== null)
    .filter(vehicleCard => vehicleCard.type === card.type).length
  const potentialRailClaims = countPotentialClaims(game, playerId, "rail")
  const potentialAirClaims = countPotentialClaims(game, playerId, "air")
  const cityBonus =
    card.type === "bus"
      ? Math.min(ownedCityCount, 6) * 4
      : card.type === "train"
        ? potentialRailClaims > 0 ? 38 : ownedCityCount >= 4 ? 6 : -20
        : potentialAirClaims > 0 ? 34 : ownedCityCount >= 5 ? 8 : -24
  const firstOfTypeBonus =
    card.type === "train"
      ? ownedVehicleCount === 0 && potentialRailClaims > 0 ? 26 : 0
      : card.type === "air"
        ? ownedVehicleCount === 0 && potentialAirClaims > 0 ? 30 : 0
        : 0

  return (
    VEHICLE_PRIORITY[card.type] +
    cityBonus -
    ownedVehicleCount * 10 +
    firstOfTypeBonus -
    card.purchasePrice / 1_000_000
  )
}

export function createScriptedBot(id: string): BotController {
  return {
    id,
    pickAction({ game, playerId, legalActions }) {
      const availableActions = legalActions.length > 0 ? legalActions : getBotLegalActions(game, playerId)

      if (availableActions.length === 0) {
        return { type: "end-turn" }
      }

      return [...availableActions].sort(
        (actionA, actionB) =>
          scoreBotAction(actionB, game, playerId) -
          scoreBotAction(actionA, game, playerId),
      )[0]
    },
  }
}
