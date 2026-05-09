import type {
  City,
  GameState,
  PurchasableResource,
  Route,
  RouteMode,
  VehicleCard,
  VehicleType,
  WeeklyPhase,
} from "./types"
import {
  applyBureaucracyFuelConsumption,
  getMaxFuelUnitsCapacityForPlayer,
  getMaxFuelUnitsForRoute,
} from "./bureaucracy"
import { calculateDistanceMiles } from "./trips"

export type ConnectionOption = {
  mode: RouteMode
  valid: boolean
  reason?: string
}

export type ClaimRouteInput = {
  cityIds: string[]
  mode: RouteMode
}

export type ClaimRouteResult =
  | {
      ok: true
      game: GameState
      routes: Route[]
      cost: number
    }
  | {
      ok: false
      error: string
    }

const CONNECTION_MODES: RouteMode[] = ["rail", "air", "bus"]
const MARKET_SLOT_CAPACITY: Record<PurchasableResource, number> = {
  diesel: 3,
  jetFuel: 6,
}
const FUEL_MARKET_PRICES: Record<PurchasableResource, number[]> = {
  diesel: [3000, 3000, 3000, 4000, 4000, 5000, 6000, 7000],
  jetFuel: [30000, 30000, 35000, 35000, 40000, 45000, 50000, 60000],
}

const STEP_ONE_REFILL: Record<PurchasableResource, number> = {
  diesel: 3,
  jetFuel: 3,
}

const WEEKLY_PHASES: WeeklyPhase[] = [
  "purchase-equipment",
  "claim-routes",
  "purchase-fuel",
  "bureaucracy",
]
const PURCHASABLE_VEHICLE_CARD_COUNT = 4

export type ResourcePurchaseResult =
  | {
      ok: true
      game: GameState
      resource: PurchasableResource
      cost: number
    }
  | {
      ok: false
      error: string
    }

export type VehiclePurchaseResult =
  | {
      ok: true
      game: GameState
      card: VehicleCard
      cost: number
    }
  | {
      ok: false
      error: string
    }

export type BureaucracyFuelUnitsResult =
  | {
      ok: true
      game: GameState
      routeId: string
      fuelUnits: number
    }
  | {
      ok: false
      error: string
    }

export type BureaucracyVehicleCardResult =
  | {
      ok: true
      game: GameState
      routeId: string
      vehicleCardId: string | null
    }
  | {
      ok: false
      error: string
    }

export function getFuelUnitPrice(
  resource: PurchasableResource,
  marketIndex: number,
) {
  return FUEL_MARKET_PRICES[resource][marketIndex] ?? null
}

function getVehicleTypeForMode(mode: RouteMode): VehicleType {
  switch (mode) {
    case "rail":
      return "train"
    case "air":
      return "air"
    case "bus":
      return "bus"
  }
}

function getFuelResourceForVehicleType(type: VehicleType): PurchasableResource {
  return type === "air" ? "jetFuel" : "diesel"
}

function getOwnedVehicleCards(game: GameState) {
  const currentPlayer = getCurrentPlayer(game)

  if (!currentPlayer) {
    return []
  }

  return currentPlayer.ownedVehicleCardIds
    .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
    .filter((card): card is VehicleCard => card !== null)
}

function getCityById(cities: City[], cityId: string) {
  return cities.find(city => city.id === cityId)
}

function normalizeRoutePair(cityAId: string, cityBId: string) {
  return [cityAId, cityBId].sort() as [string, string]
}

function buildRouteId(cityAId: string, cityBId: string, mode: RouteMode) {
  const [startCityId, endCityId] = normalizeRoutePair(cityAId, cityBId)

  return `${mode}:${startCityId}:${endCityId}`
}

function findExistingRoute(routes: Route[], cityAId: string, cityBId: string) {
  const [startCityId, endCityId] = normalizeRoutePair(cityAId, cityBId)

  return routes.find(route => {
    const [routeStartCityId, routeEndCityId] = normalizeRoutePair(
      route.cityA,
      route.cityB,
    )

    return (
      routeStartCityId === startCityId &&
      routeEndCityId === endCityId
    )
  })
}

function getSharedConnectionError(
  game: GameState,
  cityAId: string,
  cityBId: string,
) {
  if (cityAId === cityBId) {
    return "Choose two different cities."
  }

  const cityA = getCityById(game.cities, cityAId)
  const cityB = getCityById(game.cities, cityBId)

  if (!cityA || !cityB) {
    return "One or more selected cities could not be found."
  }

  if (findExistingRoute(game.routes, cityAId, cityBId)) {
    return "That route has already been claimed."
  }

  return undefined
}

function getRoutePairs(cityIds: string[]) {
  const pairs: Array<[string, string]> = []

  for (let index = 0; index < cityIds.length - 1; index += 1) {
    pairs.push([cityIds[index], cityIds[index + 1]])
  }

  return pairs
}

export function calculateClaimRouteCost(
  game: GameState,
  input: ClaimRouteInput,
) {
  if (input.mode !== "rail") {
    return 0
  }

  return getRoutePairs(input.cityIds).reduce((total, [cityAId, cityBId]) => {
    const cityA = getCityById(game.cities, cityAId)
    const cityB = getCityById(game.cities, cityBId)

    if (!cityA || !cityB) {
      return total
    }

    return (
      total +
      calculateDistanceMiles(cityA, cityB) * game.operatingConfig.railConstructionCostPerMile
    )
  }, 0)
}

export function getConnectionOptions(
  game: GameState,
  cityIds: string[],
): ConnectionOption[] {
  if (game.currentPhase !== "claim-routes") {
    return CONNECTION_MODES.map(mode => ({
      mode,
      valid: false,
      reason: "Routes can only be claimed during the claim routes phase.",
    }))
  }

  if (cityIds.length < 2) {
    return CONNECTION_MODES.map(mode => ({
      mode,
      valid: false,
      reason: "Choose at least two cities.",
    }))
  }

  const routePairs = getRoutePairs(cityIds)
  const claimCost = calculateClaimRouteCost(game, { cityIds, mode: "rail" })
  const sharedError = routePairs
    .map(([cityAId, cityBId]) => getSharedConnectionError(game, cityAId, cityBId))
    .find(error => error !== undefined)
  const currentPlayer = getCurrentPlayer(game)
  const ownedVehicleTypes = new Set(getOwnedVehicleCards(game).map(card => card.type))

  return CONNECTION_MODES.map(mode => {
    if (sharedError) {
      return {
        mode,
        valid: false,
        reason: sharedError,
      }
    }

    if (mode === "air" && cityIds.length > 2) {
      return {
        mode,
        valid: false,
        reason: "Plane routes can only connect two cities.",
      }
    }

    if (!ownedVehicleTypes.has(getVehicleTypeForMode(mode))) {
      return {
        mode,
        valid: false,
        reason: `Buy a ${mode === "rail" ? "train" : mode} vehicle card first.`,
      }
    }

    if (mode === "rail" && currentPlayer && currentPlayer.money < claimCost) {
      return {
        mode,
        valid: false,
        reason: "You do not have enough money to build that rail route.",
      }
    }

    return { mode, valid: true }
  })
}

export function getCurrentPlayer(game: GameState) {
  return (
    game.players.find(player => player.id === game.currentPlayerId) ??
    game.players[0]
  )
}

function refillResourceTrack(
  counts: number[],
  availableSupply: number,
  resource: PurchasableResource,
  unitsToAdd: number,
) {
  const nextCounts = [...counts]
  let remainingSupply = availableSupply
  let remainingUnitsToAdd = unitsToAdd

  for (let index = nextCounts.length - 1; index >= 0; index -= 1) {
    if (remainingSupply === 0 || remainingUnitsToAdd === 0) {
      break
    }

    const capacityLeft = MARKET_SLOT_CAPACITY[resource] - nextCounts[index]
    const unitsToPlace = Math.min(capacityLeft, remainingSupply, remainingUnitsToAdd)

    nextCounts[index] += unitsToPlace
    remainingSupply -= unitsToPlace
    remainingUnitsToAdd -= unitsToPlace
  }

  return {
    counts: nextCounts,
    remainingSupply,
  }
}

export function advancePhase(game: GameState): GameState {
  const currentPhaseIndex = WEEKLY_PHASES.indexOf(game.currentPhase)
  const safePhaseIndex = currentPhaseIndex === -1 ? 0 : currentPhaseIndex
  const nextPhaseIndex = (safePhaseIndex + 1) % WEEKLY_PHASES.length
  const wrappedWeek = nextPhaseIndex === 0 ? game.currentWeek + 1 : game.currentWeek
  const firstPlayerId = game.players[0]?.id ?? game.currentPlayerId

  if (game.currentPhase === "bureaucracy") {
    const resolvedGame = applyBureaucracyFuelConsumption(game)
    const dieselRefill = refillResourceTrack(
      resolvedGame.resourceMarket.diesel,
      resolvedGame.resourceSupply.diesel,
      "diesel",
      STEP_ONE_REFILL.diesel,
    )
    const jetFuelRefill = refillResourceTrack(
      resolvedGame.resourceMarket.jetFuel,
      resolvedGame.resourceSupply.jetFuel,
      "jetFuel",
      STEP_ONE_REFILL.jetFuel,
    )

    return {
      ...resolvedGame,
      currentWeek: wrappedWeek,
      currentPhase: WEEKLY_PHASES[nextPhaseIndex],
      currentPlayerId: firstPlayerId,
      hasPurchasedVehicleThisTurn: false,
      resourceMarket: {
        diesel: dieselRefill.counts,
        jetFuel: jetFuelRefill.counts,
      },
      resourceSupply: {
        diesel: dieselRefill.remainingSupply,
        jetFuel: jetFuelRefill.remainingSupply,
      },
    }
  }

  return {
    ...game,
    currentWeek: wrappedWeek,
    currentPhase: WEEKLY_PHASES[nextPhaseIndex],
    currentPlayerId: firstPlayerId,
    hasPurchasedVehicleThisTurn: false,
  }
}

export function buyResource(
  game: GameState,
  resource: PurchasableResource,
): ResourcePurchaseResult {
  if (game.currentPhase !== "purchase-fuel") {
    return {
      ok: false,
      error: "Resources can only be bought during the purchase fuel phase.",
    }
  }

  const currentPlayer = getCurrentPlayer(game)

  if (!currentPlayer) {
    return {
      ok: false,
      error: "Current player could not be found.",
    }
  }

  if (!getOwnedVehicleCards(game).some(
    card => getFuelResourceForVehicleType(card.type) === resource,
  )) {
    return {
      ok: false,
      error: `You do not own any vehicles that use ${resource === "diesel" ? "diesel" : "jet fuel"}.`,
    }
  }

  const market = game.resourceMarket[resource]
  const cheapestIndex = market.findIndex(units => units > 0)

  if (cheapestIndex === -1) {
    return {
      ok: false,
      error: `No ${resource === "diesel" ? "diesel" : "jet fuel"} is available to buy.`,
    }
  }

  const cost = getFuelUnitPrice(resource, cheapestIndex)

  if (cost === null) {
    return {
      ok: false,
      error: "That fuel price slot is invalid.",
    }
  }

  if (currentPlayer.money < cost) {
    return {
      ok: false,
      error: "You do not have enough money to buy that resource.",
    }
  }

  const maxFuelUnitsCapacity =
    getMaxFuelUnitsCapacityForPlayer(game, currentPlayer.id, resource) * 2

  if (currentPlayer.inventory.fuel[resource] + 1 > maxFuelUnitsCapacity) {
    return {
      ok: false,
      error: `You can only hold up to ${Math.floor(maxFuelUnitsCapacity)} ${resource === "diesel" ? "diesel" : "jet fuel"} units right now.`,
    }
  }

  const nextMarket = [...market]
  nextMarket[cheapestIndex] -= 1

  return {
    ok: true,
    resource,
    cost,
    game: {
      ...game,
      resourceMarket: {
        ...game.resourceMarket,
        [resource]: nextMarket,
      },
      resourceSupply: {
        ...game.resourceSupply,
        [resource]: game.resourceSupply[resource] + 1,
      },
      players: game.players.map(player => {
        if (player.id !== currentPlayer.id) {
          return player
        }

        return {
          ...player,
          money: player.money - cost,
          inventory: {
            ...player.inventory,
            fuel: {
              ...player.inventory.fuel,
              [resource]: player.inventory.fuel[resource] + 1,
            },
          },
        }
      }),
    },
  }
}

function getNextPlayerId(game: GameState) {
  if (game.players.length === 0) {
    return game.currentPlayerId
  }

  const currentPlayerIndex = game.players.findIndex(
    player => player.id === game.currentPlayerId,
  )

  if (currentPlayerIndex === -1) {
    return game.players[0].id
  }

  return game.players[(currentPlayerIndex + 1) % game.players.length].id
}

function getVehicleInventoryKey(type: VehicleType) {
  switch (type) {
    case "bus":
      return "buses"
    case "train":
      return "trains"
    case "air":
      return "planes"
  }
}

export function isLastPlayerTurn(game: GameState) {
  if (game.players.length <= 1) {
    return true
  }

  const currentPlayerIndex = game.players.findIndex(
    player => player.id === game.currentPlayerId,
  )

  return currentPlayerIndex === -1 || currentPlayerIndex === game.players.length - 1
}

export function advanceTurn(game: GameState): GameState {
  if (isLastPlayerTurn(game)) {
    return advancePhase(game)
  }

  return {
    ...game,
    currentPlayerId: getNextPlayerId(game),
    hasPurchasedVehicleThisTurn: false,
  }
}

export function buyVehicleCard(
  game: GameState,
  cardId: string,
): VehiclePurchaseResult {
  if (game.currentPhase !== "purchase-equipment") {
    return {
      ok: false,
      error: "Vehicle cards can only be bought during the purchase equipment phase.",
    }
  }

  if (game.hasPurchasedVehicleThisTurn) {
    return {
      ok: false,
      error: "You can buy at most 1 vehicle card per turn.",
    }
  }

  const currentPlayer = getCurrentPlayer(game)

  if (!currentPlayer) {
    return {
      ok: false,
      error: "Current player could not be found.",
    }
  }

  if (!game.vehicleMarketCardIds.includes(cardId)) {
    return {
      ok: false,
      error: "That vehicle card is no longer available.",
    }
  }

  if (!game.vehicleMarketCardIds.slice(0, PURCHASABLE_VEHICLE_CARD_COUNT).includes(cardId)) {
    return {
      ok: false,
      error: "Only the first 4 vehicle cards are purchasable right now.",
    }
  }

  const card = game.vehicleCatalog.find(vehicleCard => vehicleCard.id === cardId)

  if (!card) {
    return {
      ok: false,
      error: "That vehicle card could not be found.",
    }
  }

  const cost = card.purchasePrice

  if (currentPlayer.money < cost) {
    return {
      ok: false,
      error: "You do not have enough money to buy that vehicle card.",
    }
  }

  const inventoryKey = getVehicleInventoryKey(card.type)

  return {
    ok: true,
    card,
    cost,
    game: {
      ...game,
      vehicleMarketCardIds: game.vehicleMarketCardIds.filter(id => id !== cardId),
      hasPurchasedVehicleThisTurn: true,
      players: game.players.map(player => {
        if (player.id !== currentPlayer.id) {
          return player
        }

        return {
          ...player,
          money: player.money - cost,
          ownedVehicleCardIds: [...player.ownedVehicleCardIds, card.id],
          inventory: {
            ...player.inventory,
            vehicles: {
              ...player.inventory.vehicles,
              [inventoryKey]: player.inventory.vehicles[inventoryKey] + card.vehicleCount,
            },
          },
        }
      }),
    },
  }
}

export function setBureaucracyRouteFuelUnits(
  game: GameState,
  routeId: string,
  requestedFuelUnits: number,
): BureaucracyFuelUnitsResult {
  if (game.currentPhase !== "bureaucracy") {
    return {
      ok: false,
      error: "Fuel units can only be planned during the bureaucracy phase.",
    }
  }

  const route = game.routes.find(candidate => candidate.id === routeId)

  if (!route?.ownerId) {
    return {
      ok: false,
      error: "That route could not be found.",
    }
  }

  if (route.ownerId !== game.currentPlayerId) {
    return {
      ok: false,
      error: "You can only plan trips for the current player's routes.",
    }
  }

  const sanitizedFuelUnits = Math.max(0, Math.floor(requestedFuelUnits))
  const maxFuelUnits = getMaxFuelUnitsForRoute(game, routeId)
  const fuelUnits = Math.min(sanitizedFuelUnits, maxFuelUnits)

  return {
    ok: true,
    routeId,
    fuelUnits,
    game: {
      ...game,
      bureaucracyFuelUnitsByRouteId: {
        ...game.bureaucracyFuelUnitsByRouteId,
        [routeId]: fuelUnits,
      },
    },
  }
}

export function setBureaucracyRouteVehicleCard(
  game: GameState,
  routeId: string,
  requestedVehicleCardId: string | null,
): BureaucracyVehicleCardResult {
  if (game.currentPhase !== "bureaucracy") {
    return {
      ok: false,
      error: "Vehicles can only be assigned during the bureaucracy phase.",
    }
  }

  const route = game.routes.find(candidate => candidate.id === routeId)

  if (!route?.ownerId) {
    return {
      ok: false,
      error: "That route could not be found.",
    }
  }

  if (route.ownerId !== game.currentPlayerId) {
    return {
      ok: false,
      error: "You can only assign vehicles for the current player's routes.",
    }
  }

  const currentPlayer = getCurrentPlayer(game)

  if (!currentPlayer) {
    return {
      ok: false,
      error: "Current player could not be found.",
    }
  }

  if (requestedVehicleCardId === null) {
    const nextAssignments = { ...game.bureaucracyVehicleCardIdsByRouteId }
    delete nextAssignments[routeId]

    return {
      ok: true,
      game: {
        ...game,
        bureaucracyVehicleCardIdsByRouteId: nextAssignments,
      },
      routeId,
      vehicleCardId: null,
    }
  }

  const vehicleCard = game.vehicleCatalog.find(card => card.id === requestedVehicleCardId)

  if (!vehicleCard || !currentPlayer.ownedVehicleCardIds.includes(vehicleCard.id)) {
    return {
      ok: false,
      error: "That vehicle card is not owned by the current player.",
    }
  }

  if (vehicleCard.type !== getVehicleTypeForMode(route.mode)) {
    return {
      ok: false,
      error: "That vehicle card cannot operate this route type.",
    }
  }

  const nextAssignments = Object.fromEntries(
    Object.entries(game.bureaucracyVehicleCardIdsByRouteId).filter(
      ([assignedRouteId, assignedVehicleCardId]) =>
        assignedRouteId !== routeId && assignedVehicleCardId !== vehicleCard.id,
    ),
  )

  nextAssignments[routeId] = vehicleCard.id

  return {
    ok: true,
    game: {
      ...game,
      bureaucracyVehicleCardIdsByRouteId: nextAssignments,
    },
    routeId,
    vehicleCardId: vehicleCard.id,
  }
}

export function claimRoute(
  game: GameState,
  input: ClaimRouteInput,
): ClaimRouteResult {
  const option = getConnectionOptions(game, input.cityIds)
    .find(connection => connection.mode === input.mode)

  if (!option?.valid) {
    return {
      ok: false,
      error: option?.reason ?? "That connection type is not available.",
    }
  }

  const currentPlayer = getCurrentPlayer(game)

  if (!currentPlayer) {
    return {
      ok: false,
      error: "Current player could not be found.",
    }
  }

  const cost = Math.ceil(calculateClaimRouteCost(game, input))

  if (currentPlayer.money < cost) {
    return {
      ok: false,
      error: "You do not have enough money to build that route.",
    }
  }

  const routes = getRoutePairs(input.cityIds).map(([cityAId, cityBId]) => {
    const [cityA, cityB] = normalizeRoutePair(cityAId, cityBId)

    return {
      id: buildRouteId(cityA, cityB, input.mode),
      cityA,
      cityB,
      mode: input.mode,
      ownerId: game.currentPlayerId,
    }
  })

  return {
    ok: true,
    cost,
    routes,
    game: {
      ...game,
      routes: [...game.routes, ...routes],
      players: game.players.map(player =>
        player.id === currentPlayer.id
          ? {
              ...player,
              money: player.money - cost,
            }
          : player,
      ),
    },
  }
}
