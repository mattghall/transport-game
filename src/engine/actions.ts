import type {
  City,
  CityDeckRegion,
  GameState,
  PurchasableResource,
  Route,
  RouteMode,
  VehicleCard,
  VehicleType,
  WeeklyPhase,
} from "./types"
import { CITY_DECK_REGIONS } from "./types"
import {
  applyBureaucracyFuelConsumption,
  buildDisconnectedServiceSlotId,
  buildServiceSlotId,
  buildPlayerBureaucracySummary,
  findPlayerBureaucracyPlan,
  getMaxFuelUnitsCapacityForPlayer,
  getMaxFuelUnitsForRoute,
  isValidServicePodSelection,
  migrateBureaucracyServiceState,
} from "./bureaucracy"
import {
  calculateConnectionBonus,
  getFuelPriceMultiplier,
  getRailUpgradeCost,
} from "./economy"
import { shuffleWithRandomState } from "./random"
import { calculateDistanceMiles } from "./trips"

export type ConnectionOption = {
  mode: RouteMode
  valid: boolean
  reason?: string
}

export type ClaimRouteInput = {
  mode: RouteMode
  cityIds: string[]
  segmentPairs?: Array<[string, string]>
}

export type DrawCityOfferResult =
  | {
      ok: true
      game: GameState
      region: CityDeckRegion
      cityIds: string[]
    }
  | {
      ok: false
      error: string
    }

export type CityOfferSelectionResult =
  | {
      ok: true
      game: GameState
      cityIds: string[]
    }
  | {
      ok: false
      error: string
    }

export type ReadyPhaseResult =
  | {
      ok: true
      game: GameState
      playerId: string
      advancedPhase: boolean
    }
  | {
      ok: false
      error: string
    }

export type ResolvedRouteSelection =
  | {
      ok: true
      cityIds: string[]
      segmentPairs: Array<[string, string]>
    }
  | {
      ok: false
      error: string
    }

type ClaimRouteCostInput = {
  cityIds: string[]
  mode: RouteMode
  segmentPairs?: Array<[string, string]>
}

export type ClaimRouteResult =
  | {
      ok: true
      game: GameState
      routes: Route[]
      cost: number
      connectionBonus: number
      newCityIds: string[]
    }
  | {
      ok: false
      error: string
    }

const CONNECTION_MODES: RouteMode[] = ["rail", "air", "bus"]
const MARKET_SLOT_CAPACITY: Record<PurchasableResource, number> = {
  diesel: 6,
  jetFuel: 6,
}
const FUEL_MARKET_PRICES: Record<PurchasableResource, number[]> = {
  diesel: [3000, 3000, 3000, 4000, 4000, 5000, 6000, 7000],
  jetFuel: [30000, 30000, 35000, 35000, 40000, 45000, 50000, 60000],
}

const STEP_ONE_REFILL: Record<PurchasableResource, number> = {
  diesel: 6,
  jetFuel: 3,
}

const WEEKLY_PHASES: WeeklyPhase[] = [
  "purchase-equipment",
  "add-city",
  "operations",
  "bureaucracy",
]
const VISIBLE_ROUTE_CARD_COUNT = 3
const CITY_DRAW_COUNT = 4
const VEHICLE_PURCHASE_LIMITS: Record<VehicleType, number> = {
  bus: 6,
  train: 3,
  air: 1,
}
const EMPTY_VEHICLE_PURCHASES_BY_TYPE = {
  bus: false,
  train: false,
  air: false,
} as const
const EMPTY_ROUTE_CLAIMS_BY_MODE = {
  bus: false,
  rail: false,
  air: false,
} as const
const EARLY_VEHICLE_MARKET_SLOTS: Record<VehicleType, number> = {
  bus: 2,
  train: 2,
  air: 0,
}
const LATE_VEHICLE_MARKET_SLOTS: Record<VehicleType, number> = {
  bus: 2,
  train: 2,
  air: 2,
}

export type ResourcePurchaseResult =
  | {
      ok: true
      game: GameState
      resource: PurchasableResource
      quantity: number
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
      quantity: number
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

export type BureaucracyServiceCitiesResult =
  | {
      ok: true
      game: GameState
      routeId: string
      cityIds: string[]
    }
  | {
      ok: false
      error: string
    }

export type BureaucracyServiceSplitResult =
  | {
      ok: true
      game: GameState
      corridorId: string
    }
  | {
      ok: false
      error: string
    }

export type BureaucracyServiceCityMoveResult =
  | {
      ok: true
      game: GameState
      corridorId: string
      routeId: string
      cityId: string
      sourceRouteId: string | null
    }
  | {
      ok: false
      error: string
    }

export type BureaucracyServicePodDeleteResult =
  | {
      ok: true
      game: GameState
      corridorId: string
      routeId: string
      cityIds: string[]
      disconnectedCityIds: string[]
    }
  | {
      ok: false
      error: string
    }

export type RailUpgradeResult =
  | {
      ok: true
      game: GameState
      routeId: string
      cost: number
    }
  | {
      ok: false
      error: string
    }

export function getFuelUnitPrice(
  game: GameState,
  resource: PurchasableResource,
  marketIndex: number,
) {
  const basePrice = FUEL_MARKET_PRICES[resource][marketIndex]

  if (basePrice === undefined) {
    return null
  }

  const multiplier = getFuelPriceMultiplier(game, resource)
  return Math.max(100, Math.round((basePrice * multiplier) / 100) * 100)
}

export function getFuelPurchaseCost(
  game: GameState,
  resource: PurchasableResource,
  quantity: number,
) {
  const requestedQuantity = Math.max(0, Math.floor(quantity))

  if (requestedQuantity < 1) {
    return null
  }

  let remainingQuantity = requestedQuantity
  let totalCost = 0

  for (const [marketIndex, availableUnits] of game.resourceMarket[resource].entries()) {
    if (remainingQuantity === 0) {
      break
    }

    if (availableUnits <= 0) {
      continue
    }

    const unitPrice = getFuelUnitPrice(game, resource, marketIndex)

    if (unitPrice === null) {
      return null
    }

    const purchasedUnits = Math.min(availableUnits, remainingQuantity)
    totalCost += unitPrice * purchasedUnits
    remainingQuantity -= purchasedUnits
  }

  return remainingQuantity === 0 ? totalCost : null
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

function isGameLocked(game: GameState) {
  return game.isGameOver
}

function dedupePlayerIds(playerIds: string[]) {
  return [...new Set(playerIds)]
}

export function getPlayerById(game: GameState, playerId: string | null | undefined) {
  if (!playerId) {
    return null
  }

  return game.players.find(player => player.id === playerId) ?? null
}

export function hasPlayerCompletedAddCity(game: GameState, playerId: string | null | undefined) {
  return typeof playerId === "string" && game.addCityReadyPlayerIds.includes(playerId)
}

export function hasPlayerCompletedOperations(game: GameState, playerId: string | null | undefined) {
  return typeof playerId === "string" && game.operationsReadyPlayerIds.includes(playerId)
}

export function hasPlayerCompletedBureaucracy(game: GameState, playerId: string | null | undefined) {
  return typeof playerId === "string" && game.bureaucracyReadyPlayerIds.includes(playerId)
}

export function hasPlayerClaimedRouteThisTurn(game: GameState, playerId: string | null | undefined) {
  return typeof playerId === "string" && game.claimedRoutePlayerIdsThisTurn.includes(playerId)
}

export function isOperationsUnlockedForPlayer(game: GameState, playerId: string | null | undefined) {
  return (
    Boolean(playerId) &&
    (game.currentPhase === "add-city" || game.currentPhase === "operations") &&
    hasPlayerCompletedAddCity(game, playerId)
  )
}

export function canPlayerEditOperations(game: GameState, playerId: string | null | undefined) {
  return isOperationsUnlockedForPlayer(game, playerId) && !hasPlayerCompletedOperations(game, playerId)
}

function getOwnedVehicleCards(game: GameState, playerId = game.currentPlayerId) {
  const currentPlayer = getPlayerById(game, playerId)

  if (!currentPlayer) {
    return []
  }

  return currentPlayer.ownedVehicleCardIds
    .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
    .filter((card): card is VehicleCard => card !== null)
}

export function getVisibleVehicleMarketCountsByType(week: number) {
  return week >= 6 ? LATE_VEHICLE_MARKET_SLOTS : EARLY_VEHICLE_MARKET_SLOTS
}

export function getVisibleVehicleMarketCardIds(game: GameState) {
  const visibleCountsByType = getVisibleVehicleMarketCountsByType(game.currentWeek)
  const visibleCardIdsByType: Record<VehicleType, string[]> = {
    bus: [],
    train: [],
    air: [],
  }

  for (const cardId of game.vehicleMarketCardIds) {
    const card = game.vehicleCatalog.find(entry => entry.id === cardId)

    if (!card) {
      continue
    }

    if (visibleCardIdsByType[card.type].length >= visibleCountsByType[card.type]) {
      continue
    }

    visibleCardIdsByType[card.type].push(cardId)
  }

  return [
    ...visibleCardIdsByType.bus,
    ...visibleCardIdsByType.train,
    ...visibleCardIdsByType.air,
  ]
}

function isVisibleVehicleMarketCard(game: GameState, cardId: string) {
  return getVisibleVehicleMarketCardIds(game).includes(cardId)
}

function isOwnedVehicleCard(game: GameState, cardId: string) {
  return getCurrentPlayer(game)?.ownedVehicleCardIds.includes(cardId) ?? false
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

function getPairConnectionMetadata(
  game: GameState,
  cityAId: string,
  cityBId: string,
) {
  const cityA = getCityById(game.cities, cityAId)
  const cityB = getCityById(game.cities, cityBId)

  if (!cityA || !cityB) {
    return {
      adjacent: false,
      allowRail: false,
      cityA,
      cityB,
    }
  }

  const forwardConnection = cityA.adjacentCities?.find(adjacentCity => adjacentCity.id === cityBId)
  const reverseConnection = cityB.adjacentCities?.find(adjacentCity => adjacentCity.id === cityAId)
  const adjacent = Boolean(forwardConnection || reverseConnection)

  return {
    adjacent,
    allowRail:
      adjacent &&
      (forwardConnection?.allowRail ??
        reverseConnection?.allowRail ??
        true),
    cityA,
    cityB,
  }
}

function getRouteStructureError(
  game: GameState,
  cityIds: string[],
  mode: RouteMode,
) {
  if (cityIds.length < 2) {
    return "Choose at least two cities."
  }

  if (mode === "air") {
    return cityIds.length === 2
      ? undefined
      : "Air routes can only connect two owned city cards."
  }

  const missingCity = cityIds.find(cityId => !getCityById(game.cities, cityId))

  if (missingCity) {
    return `The selected city ${missingCity} could not be found.`
  }

  if (cityIds.length === 2) {
    const [cityAId, cityBId] = cityIds
    const { adjacent, allowRail, cityA, cityB } = getPairConnectionMetadata(game, cityAId, cityBId)

    if (!adjacent) {
      return `${cityA?.name ?? cityAId} and ${cityB?.name ?? cityBId} are not adjacent.`
    }

    if (mode === "rail" && !allowRail) {
      return `Rail is not allowed between ${cityA?.name ?? cityAId} and ${cityB?.name ?? cityBId}.`
    }
  }

  return undefined
}

function buildSelectionGraph(
  game: GameState,
  cityIds: string[],
  mode: RouteMode,
) {
  const adjacency = new Map<string, string[]>()

  for (const cityId of cityIds) {
    adjacency.set(cityId, [])
  }

  for (let index = 0; index < cityIds.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < cityIds.length; otherIndex += 1) {
      const cityAId = cityIds[index]
      const cityBId = cityIds[otherIndex]
      const { adjacent, allowRail } = getPairConnectionMetadata(game, cityAId, cityBId)

      if (!adjacent || (mode === "rail" && !allowRail)) {
        continue
      }

      adjacency.get(cityAId)?.push(cityBId)
      adjacency.get(cityBId)?.push(cityAId)
    }
  }

  return adjacency
}

function findHamiltonianPath(
  cityIds: string[],
  adjacency: Map<string, string[]>,
) {
  const normalizedCityIds = [...new Set(cityIds)]

  const tryFrom = (currentPath: string[]): string[] | null => {
    if (currentPath.length === normalizedCityIds.length) {
      return currentPath
    }

    const currentCityId = currentPath[currentPath.length - 1]
    const neighbors = adjacency.get(currentCityId) ?? []

    for (const neighborId of neighbors) {
      if (currentPath.includes(neighborId)) {
        continue
      }

      const result = tryFrom([...currentPath, neighborId])

      if (result) {
        return result
      }
    }

    return null
  }

  const orderedStarts = [...normalizedCityIds].sort((cityAId, cityBId) => {
    const degreeDifference = (adjacency.get(cityAId)?.length ?? 0) - (adjacency.get(cityBId)?.length ?? 0)

    if (degreeDifference !== 0) {
      return degreeDifference
    }

    return cityAId.localeCompare(cityBId)
  })

  for (const startCityId of orderedStarts) {
    const result = tryFrom([startCityId])

    if (result) {
      return result
    }
  }

  return null
}

function buildSegmentPairs(
  game: GameState,
  cityIds: string[],
  mode: RouteMode,
) {
  const segmentPairs: Array<[string, string]> = []

  for (let index = 0; index < cityIds.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < cityIds.length; otherIndex += 1) {
      const cityAId = cityIds[index]
      const cityBId = cityIds[otherIndex]
      const { adjacent, allowRail } = getPairConnectionMetadata(game, cityAId, cityBId)

      if (!adjacent || (mode === "rail" && !allowRail)) {
        continue
      }

      segmentPairs.push(normalizeRoutePair(cityAId, cityBId))
    }
  }

  return segmentPairs
}

function buildConnectivityGraph(
  cityIds: string[],
  segmentPairs: Array<[string, string]>,
) {
  const adjacency = new Map<string, string[]>()

  for (const cityId of cityIds) {
    adjacency.set(cityId, [])
  }

  for (const [cityAId, cityBId] of segmentPairs) {
    adjacency.get(cityAId)?.push(cityBId)
    adjacency.get(cityBId)?.push(cityAId)
  }

  return adjacency
}

function isConnectedSelection(
  cityIds: string[],
  adjacency: Map<string, string[]>,
) {
  if (cityIds.length === 0) {
    return false
  }

  const visited = new Set<string>()
  const queue = [cityIds[0]]

  while (queue.length > 0) {
    const cityId = queue.shift()

    if (!cityId || visited.has(cityId)) {
      continue
    }

    visited.add(cityId)

    for (const neighborId of adjacency.get(cityId) ?? []) {
      if (!visited.has(neighborId)) {
        queue.push(neighborId)
      }
    }
  }

  return cityIds.every(cityId => visited.has(cityId))
}

function dedupeSegmentPairs(segmentPairs: Array<[string, string]>) {
  const seen = new Set<string>()

  return segmentPairs.filter(([cityAId, cityBId]) => {
    const pairKey = normalizeRoutePair(cityAId, cityBId).join("|")

    if (seen.has(pairKey)) {
      return false
    }

    seen.add(pairKey)
    return true
  })
}

function getCurrentPlayerHandCityIds(
  game: GameState,
  currentPlayer = getCurrentPlayer(game),
) {
  return [
    ...new Set([
      ...(currentPlayer?.ownedCityCardIds ?? []),
      ...(game.activeCityOffer?.keptCityIds ?? []),
    ]),
  ]
}

function getPrimaryCityDeckRegion(city: Pick<City, "region">): CityDeckRegion | null {
  const primaryRegion = city.region?.[0]

  return primaryRegion && CITY_DECK_REGIONS.includes(primaryRegion as CityDeckRegion)
    ? (primaryRegion as CityDeckRegion)
    : null
}

function buildCityDeckRegionCenters(game: GameState) {
  return Object.fromEntries(
    CITY_DECK_REGIONS.map(region => {
      const regionCities = game.cities.filter(city => getPrimaryCityDeckRegion(city) === region)

      if (regionCities.length === 0) {
        return [region, null]
      }

      const latTotal = regionCities.reduce((total, city) => total + city.lat, 0)
      const lngTotal = regionCities.reduce((total, city) => total + city.lng, 0)

      return [
        region,
        {
          lat: latTotal / regionCities.length,
          lng: lngTotal / regionCities.length,
        },
      ]
    }),
  ) as Record<CityDeckRegion, { lat: number; lng: number } | null>
}

function getCityDeckFallbackOrder(game: GameState, region: CityDeckRegion) {
  const centers = buildCityDeckRegionCenters(game)
  const originCenter = centers[region]

  if (!originCenter) {
    return CITY_DECK_REGIONS.filter(candidate => candidate !== region)
  }

  return CITY_DECK_REGIONS.filter(candidate => candidate !== region).sort((regionA, regionB) => {
    const centerA = centers[regionA]
    const centerB = centers[regionB]

    if (!centerA && !centerB) {
      return regionA.localeCompare(regionB)
    }

    if (!centerA) {
      return 1
    }

    if (!centerB) {
      return -1
    }

    const distanceA = Math.hypot(originCenter.lat - centerA.lat, originCenter.lng - centerA.lng)
    const distanceB = Math.hypot(originCenter.lat - centerB.lat, originCenter.lng - centerB.lng)

    if (distanceA !== distanceB) {
      return distanceA - distanceB
    }

    return regionA.localeCompare(regionB)
  })
}

function applyKeptCityOfferToCurrentPlayer(game: GameState) {
  const keptCityIds = game.activeCityOffer?.keptCityIds ?? []

  if (keptCityIds.length !== 2) {
    return game
  }

  return {
    ...game,
    players: game.players.map(player =>
      player.id === game.currentPlayerId
        ? {
            ...player,
            ownedCityCardIds: [...new Set([...player.ownedCityCardIds, ...keptCityIds])],
          }
        : player,
    ),
  }
}

function returnUnkeptCityOfferCardsToDecks(game: GameState) {
  const activeCityOffer = game.activeCityOffer

  if (!activeCityOffer) {
    return game
  }

  const keptCityIdSet = new Set(activeCityOffer.keptCityIds)
  const nextDecks = { ...game.cityDeckCardIdsByRegion }
  let changed = false

  for (const cityId of activeCityOffer.cityIds) {
    if (keptCityIdSet.has(cityId)) {
      continue
    }

    const city = game.cities.find(candidate => candidate.id === cityId)
    const region = city ? getPrimaryCityDeckRegion(city) : null

    if (!region) {
      continue
    }

    nextDecks[region] = [...nextDecks[region], cityId]
    changed = true
  }

  return changed
    ? {
        ...game,
        cityDeckCardIdsByRegion: nextDecks,
      }
    : game
}

function getOrderedCityIdsFromSegmentPairs(segmentPairs: Array<[string, string]>) {
  const cityIds = [...new Set(segmentPairs.flat())]
  const adjacency = buildConnectivityGraph(cityIds, segmentPairs)
  const orderedStarts = [...cityIds].sort((cityAId, cityBId) => {
    const degreeDifference = (adjacency.get(cityAId)?.length ?? 0) - (adjacency.get(cityBId)?.length ?? 0)

    if (degreeDifference !== 0) {
      return degreeDifference
    }

    return cityAId.localeCompare(cityBId)
  })
  const startCityId = orderedStarts[0]

  if (!startCityId) {
    return []
  }

  const visited = new Set<string>()
  const orderedCityIds: string[] = []
  const queue = [startCityId]

  while (queue.length > 0) {
    const cityId = queue.shift()

    if (!cityId || visited.has(cityId)) {
      continue
    }

    visited.add(cityId)
    orderedCityIds.push(cityId)

    for (const neighborId of [...(adjacency.get(cityId) ?? [])].sort((cityAId, cityBId) =>
      cityAId.localeCompare(cityBId),
    )) {
      if (!visited.has(neighborId)) {
        queue.push(neighborId)
      }
    }
  }

  return orderedCityIds
}

export function resolveSegmentSelection(
  game: GameState,
  segmentPairs: Array<[string, string]>,
  mode: RouteMode,
): ResolvedRouteSelection {
  const normalizedSegmentPairs = dedupeSegmentPairs(
    segmentPairs.map(([cityAId, cityBId]) => normalizeRoutePair(cityAId, cityBId)),
  )

  if (normalizedSegmentPairs.length === 0) {
    return {
      ok: false,
      error: "Select at least one route segment.",
    }
  }

  for (const [cityAId, cityBId] of normalizedSegmentPairs) {
    const { adjacent, allowRail, cityA, cityB } = getPairConnectionMetadata(game, cityAId, cityBId)

    if (!adjacent) {
      return {
        ok: false,
        error: `${cityA?.name ?? cityAId} and ${cityB?.name ?? cityBId} are not adjacent.`,
      }
    }

    if (mode === "rail" && !allowRail) {
      return {
        ok: false,
        error: `Rail is not allowed between ${cityA?.name ?? cityAId} and ${cityB?.name ?? cityBId}.`,
      }
    }

    if (findExistingRoute(game.routes, cityAId, cityBId)) {
      return {
        ok: false,
        error: "One or more selected connections have already been claimed.",
      }
    }
  }

  const cityIds = [...new Set(normalizedSegmentPairs.flat())]
  const connectivityGraph = buildConnectivityGraph(cityIds, normalizedSegmentPairs)

  if (!isConnectedSelection(cityIds, connectivityGraph)) {
    return {
      ok: false,
      error: `The selected ${mode === "rail" ? "rail" : mode} segments must form one connected route.`,
    }
  }

  return {
    ok: true,
    cityIds: getOrderedCityIdsFromSegmentPairs(normalizedSegmentPairs),
    segmentPairs: normalizedSegmentPairs,
  }
}

export function getEffectiveClaimCityIds(
  game: GameState,
  mode: RouteMode,
  cityIds: string[],
  playerId = game.currentPlayerId,
) {
  const normalizedCityIds = [...new Set(cityIds)]

  if (mode !== "bus") {
    return normalizedCityIds
  }

  const currentPlayer = getPlayerById(game, playerId)
  const handCityIds = getCurrentPlayerHandCityIds(game, currentPlayer ?? undefined)

  if (!currentPlayer || handCityIds.length === 0) {
    return normalizedCityIds
  }

  if (normalizedCityIds.length !== 1) {
    return normalizedCityIds
  }

  const selectedCityId = normalizedCityIds[0]
  const implicitOwnedAnchorId = handCityIds.find(ownedCityId => {
    if (ownedCityId === selectedCityId) {
      return false
    }

    const { adjacent } = getPairConnectionMetadata(game, ownedCityId, selectedCityId)

    return adjacent && !findExistingRoute(game.routes, ownedCityId, selectedCityId)
  })

  if (!implicitOwnedAnchorId) {
    return normalizedCityIds
  }

  return [selectedCityId, implicitOwnedAnchorId]
}

export function resolveRouteSelection(
  game: GameState,
  cityIds: string[],
  mode: RouteMode,
): ResolvedRouteSelection {
  const normalizedCityIds = [...new Set(cityIds)]

  if (normalizedCityIds.length !== cityIds.length) {
    return {
      ok: false,
      error: "Each city can only be used once in the same route.",
    }
  }

  const structureError = getRouteStructureError(game, normalizedCityIds, mode)

  if (structureError) {
    return {
      ok: false,
      error: structureError,
    }
  }

  if (mode === "air") {
    const [cityAId, cityBId] = normalizeRoutePair(normalizedCityIds[0], normalizedCityIds[1])

    if (findExistingRoute(game.routes, cityAId, cityBId)) {
      return {
        ok: false,
        error: "That route has already been claimed.",
      }
    }

    return {
      ok: true,
      cityIds: [...normalizedCityIds].sort((cityAId, cityBId) => cityAId.localeCompare(cityBId)),
      segmentPairs: [[cityAId, cityBId]],
    }
  }

  const segmentPairs = buildSegmentPairs(game, normalizedCityIds, mode)
  const blockedSegment = segmentPairs.find(([cityAId, cityBId]) =>
    findExistingRoute(game.routes, cityAId, cityBId),
  )

  if (blockedSegment) {
    return {
      ok: false,
      error: "One or more selected connections have already been claimed.",
    }
  }

  if (segmentPairs.length === 0) {
    return {
      ok: false,
      error: `The selected cities cannot form one contiguous ${mode === "rail" ? "rail" : "bus"} route.`,
    }
  }

  const connectivityGraph = buildConnectivityGraph(normalizedCityIds, segmentPairs)

  if (!isConnectedSelection(normalizedCityIds, connectivityGraph)) {
    return {
      ok: false,
      error: `The selected cities cannot form one contiguous ${mode === "rail" ? "rail" : "bus"} route.`,
    }
  }

  const adjacency = buildSelectionGraph(game, normalizedCityIds, mode)
  const orderedCityIds = findHamiltonianPath(normalizedCityIds, adjacency)

  return {
    ok: true,
    cityIds: orderedCityIds ?? normalizedCityIds,
    segmentPairs,
  }
}

function getImplicitBusHandSegmentPairs(
  game: GameState,
  selectedCityIds: string[],
  playerId = game.currentPlayerId,
) {
  const currentPlayer = getPlayerById(game, playerId)
  const handCityIds = getCurrentPlayerHandCityIds(game, currentPlayer ?? undefined)

  if (!currentPlayer || handCityIds.length === 0) {
    return []
  }

  const selectedCityIdSet = new Set(selectedCityIds)
  const segmentPairs = handCityIds.flatMap(ownedCityId => {
    if (selectedCityIdSet.has(ownedCityId)) {
      return []
    }

    return selectedCityIds.flatMap(selectedCityId => {
      const { adjacent } = getPairConnectionMetadata(game, ownedCityId, selectedCityId)
      const segmentPair = normalizeRoutePair(ownedCityId, selectedCityId)

      if (!adjacent || findExistingRoute(game.routes, segmentPair[0], segmentPair[1])) {
        return []
      }

      return [segmentPair]
    })
  })

  return dedupeSegmentPairs(segmentPairs)
}

export function getClaimSegmentPairs(
  game: GameState,
  mode: RouteMode,
  cityIds: string[],
  playerId = game.currentPlayerId,
) {
  const effectiveCityIds = getEffectiveClaimCityIds(game, mode, cityIds, playerId)
  const resolvedSelection = resolveRouteSelection(game, effectiveCityIds, mode)

  if (!resolvedSelection.ok) {
    return []
  }

  if (mode !== "bus") {
    return resolvedSelection.segmentPairs
  }

  return dedupeSegmentPairs([
    ...resolvedSelection.segmentPairs,
    ...getImplicitBusHandSegmentPairs(game, cityIds, playerId),
  ])
}

function getRoutePairs(cityIds: string[]) {
  const pairs: Array<[string, string]> = []

  for (let index = 0; index < cityIds.length - 1; index += 1) {
    pairs.push([cityIds[index], cityIds[index + 1]])
  }

  return pairs
}

function isRouteCardBlockedByClaimedRoutes(game: GameState, routeCard: { cityIds: string[] }) {
  return getRoutePairs(routeCard.cityIds).some(([cityAId, cityBId]) =>
    findExistingRoute(game.routes, cityAId, cityBId),
  )
}

export function getAvailableRouteMarketCardIds(game: GameState, mode: RouteMode) {
  return game.routeMarketCardIdsByMode[mode].filter(cardId => {
    const routeCard = game.routeCatalog.find(card => card.id === cardId)

    if (!routeCard) {
      return false
    }

    return !isRouteCardBlockedByClaimedRoutes(game, routeCard)
  })
}

export function getVisibleRouteMarketCardIds(game: GameState, mode: RouteMode) {
  return getAvailableRouteMarketCardIds(game, mode).slice(0, VISIBLE_ROUTE_CARD_COUNT)
}

export function calculateClaimRouteCost(
  game: GameState,
  input: ClaimRouteCostInput,
  playerId = game.currentPlayerId,
) {
  if (input.mode !== "rail") {
    return 0
  }

  const resolvedSelection =
    input.segmentPairs && input.segmentPairs.length > 0
      ? resolveSegmentSelection(game, input.segmentPairs, input.mode)
      : resolveRouteSelection(
          game,
          getEffectiveClaimCityIds(game, input.mode, input.cityIds, playerId),
          input.mode,
        )

  if (!resolvedSelection.ok) {
    return 0
  }

  return resolvedSelection.segmentPairs.reduce((total, [cityAId, cityBId]) => {
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
  playerId = game.currentPlayerId,
): ConnectionOption[] {
  if (isGameLocked(game)) {
    return CONNECTION_MODES.map(mode => ({
      mode,
      valid: false,
      reason: "The game is over.",
    }))
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return CONNECTION_MODES.map(mode => ({
      mode,
      valid: false,
      reason: "Routes can only be claimed after you confirm picks and before you click Next player.",
    }))
  }

  if (cityIds.length < 1) {
    return CONNECTION_MODES.map(mode => ({
      mode,
      valid: false,
      reason: "Choose at least one city.",
    }))
  }

  const currentPlayer = getPlayerById(game, playerId)
  const ownedVehicleTypes = new Set(getOwnedVehicleCards(game, playerId).map(card => card.type))

  return CONNECTION_MODES.map(mode => {
    if (mode === "bus") {
      return {
        mode,
        valid: false,
        reason: "Bus routes are automatic from connected owned city cards. No bus build is required.",
      }
    }

    const effectiveCityIds = getEffectiveClaimCityIds(game, mode, cityIds, playerId)

    if (effectiveCityIds.length < 2) {
      return {
        mode,
        valid: false,
        reason: "Choose at least two connected cities.",
      }
    }

    const resolvedSelection = resolveRouteSelection(game, effectiveCityIds, mode)

    if (!resolvedSelection.ok) {
      return {
        mode,
        valid: false,
        reason: resolvedSelection.error,
      }
    }

    if (!ownedVehicleTypes.has(getVehicleTypeForMode(mode))) {
      return {
        mode,
        valid: false,
        reason: `Buy a ${mode === "rail" ? "train" : mode} vehicle card first.`,
      }
    }

    const claimCost = Math.ceil(
      calculateClaimRouteCost(game, { cityIds: effectiveCityIds, mode: "rail" }, playerId),
    )

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

function getNextPendingPlayerId(game: GameState, readyPlayerIds: string[]) {
  if (game.players.length <= 1) {
    return game.players[0]?.id ?? game.currentPlayerId
  }

  const readySet = new Set(readyPlayerIds)
  const currentPlayerIndex = game.players.findIndex(player => player.id === game.currentPlayerId)
  const safeCurrentPlayerIndex = currentPlayerIndex === -1 ? 0 : currentPlayerIndex

  for (let step = 1; step <= game.players.length; step += 1) {
    const candidate = game.players[(safeCurrentPlayerIndex + step) % game.players.length]

    if (!readySet.has(candidate.id)) {
      return candidate.id
    }
  }

  return game.players[safeCurrentPlayerIndex]?.id ?? game.currentPlayerId
}

export function getVehiclePurchaseLimit(type: VehicleType) {
  return VEHICLE_PURCHASE_LIMITS[type]
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

function getVehicleMarketBurnCardIds(game: GameState) {
  return (["bus", "train", "air"] as VehicleType[]).flatMap(type => {
    if (game.purchasedVehicleTypesThisPhase[type]) {
      return []
    }

    const cardToBurn = game.vehicleMarketCardIds
      .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
      .filter((card): card is VehicleCard => card !== null && card.type === type)
      .sort((cardA, cardB) => cardA.number - cardB.number)[0]

    return cardToBurn ? [cardToBurn.id] : []
  })
}

export function drawCityOffer(
  game: GameState,
  region: CityDeckRegion,
  playerId = game.currentPlayerId,
): DrawCityOfferResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (game.currentPhase !== "add-city") {
    return {
      ok: false,
      error: "City cards can only be drawn during the add city phase.",
    }
  }

  if (playerId !== game.currentPlayerId) {
    return {
      ok: false,
      error: "Only the active player can draw city cards.",
    }
  }

  if (hasPlayerClaimedRouteThisTurn(game, game.currentPlayerId)) {
    return {
      ok: false,
      error: "You already claimed a route this turn.",
    }
  }

  if (game.activeCityOffer) {
    return {
      ok: false,
      error: "Finish picking from the current city draw first.",
    }
  }

  const drawOrder = [region, ...getCityDeckFallbackOrder(game, region)]
  const nextDecks = { ...game.cityDeckCardIdsByRegion }
  const cityIds: string[] = []

  for (const drawRegion of drawOrder) {
    if (cityIds.length >= CITY_DRAW_COUNT) {
      break
    }

    const deck = nextDecks[drawRegion]
    const neededCards = CITY_DRAW_COUNT - cityIds.length
    const drawnCards = deck.slice(0, neededCards)

    cityIds.push(...drawnCards)
    nextDecks[drawRegion] = deck.slice(drawnCards.length)
  }

  if (cityIds.length < CITY_DRAW_COUNT) {
    return {
      ok: false,
      error: "There are not enough city cards left across the decks to draw 4 cards.",
    }
  }

  return {
    ok: true,
    region,
    cityIds,
    game: {
      ...game,
      cityDeckCardIdsByRegion: nextDecks,
      activeCityOffer: {
        region,
        cityIds,
        keptCityIds: [],
      },
    },
  }
}

export function setActiveCityOfferKeptCityIds(
  game: GameState,
  requestedCityIds: string[],
  playerId = game.currentPlayerId,
): CityOfferSelectionResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (game.currentPhase !== "add-city") {
    return {
      ok: false,
      error: "City cards can only be picked during the add city phase.",
    }
  }

  if (playerId !== game.currentPlayerId) {
    return {
      ok: false,
      error: "Only the active player can pick city cards.",
    }
  }

  if (!game.activeCityOffer) {
    return {
      ok: false,
      error: "Draw from a region deck first.",
    }
  }

  const cityIds = [...new Set(requestedCityIds)].filter(cityId =>
    game.activeCityOffer?.cityIds.includes(cityId),
  )

  if (cityIds.length > 2) {
    return {
      ok: false,
      error: "Keep exactly 2 city cards from the draw.",
    }
  }

  return {
    ok: true,
    cityIds,
    game: {
      ...game,
      activeCityOffer: {
        ...game.activeCityOffer,
        keptCityIds: cityIds,
      },
    },
  }
}

export function confirmAddCityPicks(game: GameState): ReadyPhaseResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (game.currentPhase !== "add-city") {
    return {
      ok: false,
      error: "City picks can only be confirmed during the add city phase.",
    }
  }

  if ((game.activeCityOffer?.keptCityIds.length ?? 0) !== 2) {
    return {
      ok: false,
      error: "Keep exactly 2 city cards from the draw first.",
    }
  }

  const gameWithKeptCityCards = returnUnkeptCityOfferCardsToDecks(
    applyKeptCityOfferToCurrentPlayer(game),
  )
  const migratedBureaucracyState = migrateBureaucracyServiceState(
    game,
    gameWithKeptCityCards,
  )
  const addCityReadyPlayerIds = dedupePlayerIds([
    ...game.addCityReadyPlayerIds,
    game.currentPlayerId,
  ])
  const advancedPhase = addCityReadyPlayerIds.length >= game.players.length
  const firstPlayerId = game.players[game.leadPlayerIndex]?.id ?? game.players[0]?.id ?? game.currentPlayerId

  return {
    ok: true,
    playerId: game.currentPlayerId,
    advancedPhase,
    game: {
      ...gameWithKeptCityCards,
      ...migratedBureaucracyState,
      addCityReadyPlayerIds,
      operationsReadyPlayerIds: game.operationsReadyPlayerIds.filter(playerId =>
        addCityReadyPlayerIds.includes(playerId),
      ),
      currentPhase: advancedPhase ? "operations" : "add-city",
      currentPlayerId: advancedPhase
        ? firstPlayerId
        : getNextPendingPlayerId(game, addCityReadyPlayerIds),
      activeCityOffer: null,
    },
  }
}

export function markOperationsReady(
  game: GameState,
  playerId: string,
): ReadyPhaseResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    if (hasPlayerCompletedOperations(game, playerId)) {
      return {
        ok: true,
        playerId,
        advancedPhase: false,
        game,
      }
    }

    return {
      ok: false,
      error: "Operations unlock after you confirm picks and lock once you click Next player.",
    }
  }

  const operationsReadyPlayerIds = dedupePlayerIds([
    ...game.operationsReadyPlayerIds,
    playerId,
  ])
  const advancedPhase = operationsReadyPlayerIds.length >= game.players.length
  const firstPlayerId = game.players[game.leadPlayerIndex]?.id ?? game.players[0]?.id ?? game.currentPlayerId

  return {
    ok: true,
    playerId,
    advancedPhase,
    game: {
      ...game,
      currentPhase: advancedPhase ? "bureaucracy" : game.currentPhase,
      currentPlayerId: advancedPhase ? firstPlayerId : game.currentPlayerId,
      operationsReadyPlayerIds: advancedPhase ? [] : operationsReadyPlayerIds,
      bureaucracyReadyPlayerIds: advancedPhase ? [] : game.bureaucracyReadyPlayerIds,
      activeCityOffer: advancedPhase ? null : game.activeCityOffer,
    },
  }
}

export function markBureaucracyReady(
  game: GameState,
  playerId: string,
): ReadyPhaseResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (game.currentPhase !== "bureaucracy") {
    return {
      ok: false,
      error: "Bureaucracy can only be advanced during the bureaucracy phase.",
    }
  }

  if (!getPlayerById(game, playerId)) {
    return {
      ok: false,
      error: `Player ${playerId} could not be found.`,
    }
  }

  if (hasPlayerCompletedBureaucracy(game, playerId)) {
    return {
      ok: true,
      playerId,
      advancedPhase: false,
      game,
    }
  }

  const bureaucracyReadyPlayerIds = dedupePlayerIds([
    ...game.bureaucracyReadyPlayerIds,
    playerId,
  ])
  const advancedPhase = bureaucracyReadyPlayerIds.length >= game.players.length

  return {
    ok: true,
    playerId,
    advancedPhase,
    game: advancedPhase
      ? advancePhase({
          ...game,
          bureaucracyReadyPlayerIds,
        })
      : {
          ...game,
          bureaucracyReadyPlayerIds,
        },
  }
}

export function advancePhase(game: GameState): GameState {
  if (isGameLocked(game)) {
    return game
  }

  const currentPhaseIndex = WEEKLY_PHASES.indexOf(game.currentPhase)
  const safePhaseIndex = currentPhaseIndex === -1 ? 0 : currentPhaseIndex
  const nextPhaseIndex = (safePhaseIndex + 1) % WEEKLY_PHASES.length
  const wrappedWeek = nextPhaseIndex === 0 ? game.currentWeek + 1 : game.currentWeek
  const nextLeadPlayerIndex =
    nextPhaseIndex === 0
      ? (game.leadPlayerIndex + 1) % Math.max(game.players.length, 1)
      : game.leadPlayerIndex
  const firstPlayerId = game.players[nextLeadPlayerIndex]?.id ?? game.currentPlayerId

  if (game.currentPhase === "purchase-equipment") {
    const burnedCardIds = getVehicleMarketBurnCardIds(game)
    const nextVehicleMarketCardIds =
      burnedCardIds.length === 0
        ? game.vehicleMarketCardIds
        : game.vehicleMarketCardIds.filter(cardId => !burnedCardIds.includes(cardId))

    return {
      ...game,
      currentWeek: wrappedWeek,
      currentPhase: WEEKLY_PHASES[nextPhaseIndex],
      leadPlayerIndex: nextLeadPlayerIndex,
      currentPlayerId: firstPlayerId,
      addCityReadyPlayerIds: [],
      operationsReadyPlayerIds: [],
      bureaucracyReadyPlayerIds: [],
      hasPurchasedVehicleThisTurn: false,
      hasPurchasedVehicleThisPhase: false,
      purchasedVehicleTypesThisPhase: EMPTY_VEHICLE_PURCHASES_BY_TYPE,
      claimedRoutePlayerIdsThisTurn: [],
      claimedRouteCountsByPlayerIdThisTurn: {},
      claimedRouteModesThisPhase: EMPTY_ROUTE_CLAIMS_BY_MODE,
      vehicleMarketCardIds: nextVehicleMarketCardIds,
      activeCityOffer: null,
    }
  }

  if (game.currentPhase === "add-city") {
    const gameWithKeptCityCards = returnUnkeptCityOfferCardsToDecks(
      applyKeptCityOfferToCurrentPlayer(game),
    )
    const migratedBureaucracyState = migrateBureaucracyServiceState(
      game,
      gameWithKeptCityCards,
    )

    return {
      ...gameWithKeptCityCards,
      ...migratedBureaucracyState,
      currentWeek: wrappedWeek,
      currentPhase: WEEKLY_PHASES[nextPhaseIndex],
      leadPlayerIndex: nextLeadPlayerIndex,
      currentPlayerId: firstPlayerId,
      addCityReadyPlayerIds: [],
      operationsReadyPlayerIds: [],
      bureaucracyReadyPlayerIds: [],
      hasPurchasedVehicleThisTurn: false,
      hasPurchasedVehicleThisPhase: false,
      purchasedVehicleTypesThisPhase: EMPTY_VEHICLE_PURCHASES_BY_TYPE,
      claimedRoutePlayerIdsThisTurn: [],
      claimedRouteCountsByPlayerIdThisTurn: {},
      claimedRouteModesThisPhase: EMPTY_ROUTE_CLAIMS_BY_MODE,
      activeCityOffer: null,
    }
  }

  if (game.currentPhase === "bureaucracy") {
    const resolvedGame = applyBureaucracyFuelConsumption(game)

    if (game.currentWeek >= game.operatingConfig.totalWeeks) {
      return {
        ...resolvedGame,
        isGameOver: true,
        leadPlayerIndex: nextLeadPlayerIndex,
        currentPlayerId: firstPlayerId,
        addCityReadyPlayerIds: [],
        operationsReadyPlayerIds: [],
        bureaucracyReadyPlayerIds: [],
        hasPurchasedVehicleThisTurn: false,
        hasPurchasedVehicleThisPhase: false,
        purchasedVehicleTypesThisPhase: EMPTY_VEHICLE_PURCHASES_BY_TYPE,
        claimedRoutePlayerIdsThisTurn: [],
        claimedRouteCountsByPlayerIdThisTurn: {},
        claimedRouteModesThisPhase: EMPTY_ROUTE_CLAIMS_BY_MODE,
        activeCityOffer: null,
      }
    }

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
    let nextDiscard = resolvedGame.activeChanceCardId
      ? [...resolvedGame.chanceDiscardCardIds, resolvedGame.activeChanceCardId]
      : [...resolvedGame.chanceDiscardCardIds]
    let nextDeck = [...resolvedGame.chanceDeckCardIds]
    let randomState = resolvedGame.randomState

    if (nextDeck.length === 0 && nextDiscard.length > 0) {
      const reshuffledDiscard = shuffleWithRandomState(nextDiscard, randomState)
      nextDeck = reshuffledDiscard.items
      nextDiscard = []
      randomState = reshuffledDiscard.randomState
    }

    const activeChanceCardId = nextDeck[0] ?? null

    return {
      ...resolvedGame,
      randomState,
      currentWeek: wrappedWeek,
      currentPhase: WEEKLY_PHASES[nextPhaseIndex],
      activeChanceCardId,
      chanceDeckCardIds: activeChanceCardId === null ? [] : nextDeck.slice(1),
      chanceDiscardCardIds: nextDiscard,
      leadPlayerIndex: nextLeadPlayerIndex,
      currentPlayerId: firstPlayerId,
      addCityReadyPlayerIds: [],
      operationsReadyPlayerIds: [],
      bureaucracyReadyPlayerIds: [],
      hasPurchasedVehicleThisTurn: false,
      hasPurchasedVehicleThisPhase: false,
      purchasedVehicleTypesThisPhase: EMPTY_VEHICLE_PURCHASES_BY_TYPE,
      claimedRoutePlayerIdsThisTurn: [],
      claimedRouteCountsByPlayerIdThisTurn: {},
      claimedRouteModesThisPhase: EMPTY_ROUTE_CLAIMS_BY_MODE,
      activeCityOffer: null,
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
    leadPlayerIndex: nextLeadPlayerIndex,
    currentPlayerId: firstPlayerId,
    addCityReadyPlayerIds: [],
    operationsReadyPlayerIds: [],
    bureaucracyReadyPlayerIds: [],
    hasPurchasedVehicleThisTurn: false,
    hasPurchasedVehicleThisPhase: false,
    purchasedVehicleTypesThisPhase: EMPTY_VEHICLE_PURCHASES_BY_TYPE,
    claimedRoutePlayerIdsThisTurn: [],
    claimedRouteCountsByPlayerIdThisTurn: {},
    claimedRouteModesThisPhase: EMPTY_ROUTE_CLAIMS_BY_MODE,
    activeCityOffer: null,
  }
}

export function buyResource(
  game: GameState,
  resource: PurchasableResource,
  quantity = 1,
): ResourcePurchaseResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (game.currentPhase !== "purchase-fuel") {
    return {
      ok: false,
      error: "Resources can only be bought during the purchase fuel phase.",
    }
  }

  const currentPlayer = getCurrentPlayer(game)
  const requestedQuantity = Math.max(0, Math.floor(quantity))

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

  if (requestedQuantity < 1) {
    return {
      ok: false,
      error: "Choose at least 1 fuel unit to buy.",
    }
  }

  if (resource === "diesel" && requestedQuantity !== 1 && requestedQuantity !== 10) {
    return {
      ok: false,
      error: "Diesel can only be bought in packs of 1 or 10.",
    }
  }

  if (resource === "jetFuel" && requestedQuantity !== 1) {
    return {
      ok: false,
      error: "Jet fuel can only be bought 1 unit at a time.",
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

  const cost = getFuelPurchaseCost(game, resource, requestedQuantity)

  if (cost === null) {
    return {
      ok: false,
      error: `There is not enough ${resource === "diesel" ? "diesel" : "jet fuel"} available for that purchase.`,
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

  if (currentPlayer.inventory.fuel[resource] + requestedQuantity > maxFuelUnitsCapacity) {
    return {
      ok: false,
      error: `You can only hold up to ${Math.floor(maxFuelUnitsCapacity)} ${resource === "diesel" ? "diesel" : "jet fuel"} units right now.`,
    }
  }

  const nextMarket = [...market]
  let remainingQuantity = requestedQuantity

  for (const [marketIndex, availableUnits] of nextMarket.entries()) {
    if (remainingQuantity === 0) {
      break
    }

    if (availableUnits <= 0) {
      continue
    }

    const purchasedUnits = Math.min(availableUnits, remainingQuantity)
    nextMarket[marketIndex] -= purchasedUnits
    remainingQuantity -= purchasedUnits
  }

  return {
    ok: true,
    resource,
    quantity: requestedQuantity,
    cost,
    game: {
      ...game,
      resourceMarket: {
        ...game.resourceMarket,
        [resource]: nextMarket,
      },
      resourceSupply: {
        ...game.resourceSupply,
        [resource]: game.resourceSupply[resource] + requestedQuantity,
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
              [resource]: player.inventory.fuel[resource] + requestedQuantity,
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
  const lastPlayerIndex =
    (game.leadPlayerIndex + game.players.length - 1) % game.players.length

  return currentPlayerIndex === -1 || currentPlayerIndex === lastPlayerIndex
}

export function advanceTurn(game: GameState): GameState {
  if (isGameLocked(game)) {
    return game
  }

  if (game.currentPhase === "add-city") {
    const result = confirmAddCityPicks(game)
    return result.ok ? result.game : game
  }

  if (game.currentPhase === "operations") {
    const result = markOperationsReady(game, game.currentPlayerId)
    return result.ok ? result.game : game
  }

  if (game.currentPhase === "bureaucracy") {
    const result = markBureaucracyReady(game, game.currentPlayerId)
    return result.ok ? result.game : game
  }

  if (isLastPlayerTurn(game)) {
    return advancePhase(game)
  }

  return {
    ...game,
    currentPlayerId: getNextPlayerId(game),
    hasPurchasedVehicleThisTurn: false,
    claimedRoutePlayerIdsThisTurn: [],
    activeCityOffer: null,
  }
}

export function buyVehicleCard(
  game: GameState,
  cardId: string,
  quantity = 1,
): VehiclePurchaseResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (game.currentPhase !== "purchase-equipment") {
    return {
      ok: false,
      error: "Vehicle cards can only be bought during the purchase equipment phase.",
    }
  }

  if (game.hasPurchasedVehicleThisTurn) {
    return {
      ok: false,
      error: "You can make only 1 vehicle purchase per turn.",
    }
  }

  const currentPlayer = getCurrentPlayer(game)

  if (!currentPlayer) {
    return {
      ok: false,
      error: "Current player could not be found.",
    }
  }

  const isOwnedCard = isOwnedVehicleCard(game, cardId)
  const isVisibleMarketCard = isVisibleVehicleMarketCard(game, cardId)

  if (!isVisibleMarketCard && !isOwnedCard) {
    return {
      ok: false,
      error: game.vehicleCatalog.some(vehicleCard => vehicleCard.id === cardId)
        ? "You can only buy visible market cards or vehicle models you already own."
        : "That vehicle card is no longer available.",
    }
  }

  const card = game.vehicleCatalog.find(vehicleCard => vehicleCard.id === cardId)

  if (!card) {
    return {
      ok: false,
      error: "That vehicle card could not be found.",
    }
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    return {
      ok: false,
      error: "Vehicle quantity must be at least 1.",
    }
  }

  const purchaseLimit = getVehiclePurchaseLimit(card.type)

  if (quantity > purchaseLimit) {
    return {
      ok: false,
      error: `You can buy at most ${purchaseLimit} ${card.type === "bus" ? "buses" : card.type === "train" ? "trains" : "plane"} at a time.`,
    }
  }

  const cost = card.purchasePrice * quantity

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
    quantity,
    cost,
    game: {
      ...game,
      hasPurchasedVehicleThisTurn: true,
      hasPurchasedVehicleThisPhase: true,
      purchasedVehicleTypesThisPhase: {
        ...game.purchasedVehicleTypesThisPhase,
        [card.type]: true,
      },
      vehicleMarketCardIds: isVisibleMarketCard
        ? game.vehicleMarketCardIds.filter(marketCardId => marketCardId !== card.id)
        : game.vehicleMarketCardIds,
      players: game.players.map(player => {
        if (player.id !== currentPlayer.id) {
          return player
        }

        return {
          ...player,
          money: player.money - cost,
          ownedVehicleCardIds: player.ownedVehicleCardIds.includes(card.id)
            ? player.ownedVehicleCardIds
            : [...player.ownedVehicleCardIds, card.id],
          ownedVehicleCountsByCardId: {
            ...player.ownedVehicleCountsByCardId,
            [card.id]: (player.ownedVehicleCountsByCardId[card.id] ?? 0) + quantity,
          },
          inventory: {
            ...player.inventory,
            vehicles: {
              ...player.inventory.vehicles,
              [inventoryKey]: player.inventory.vehicles[inventoryKey] + quantity,
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
  playerId = game.currentPlayerId,
): BureaucracyFuelUnitsResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Fuel units can only be planned after you confirm picks and before you click Next player.",
    }
  }

  const routePlan = findPlayerBureaucracyPlan(game, playerId, routeId)

  if (!routePlan) {
    return {
      ok: false,
      error: "That service line could not be found.",
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
  playerId = game.currentPlayerId,
): BureaucracyVehicleCardResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Vehicles can only be assigned after you confirm picks and before you click Next player.",
    }
  }

  const routePlan = findPlayerBureaucracyPlan(game, playerId, routeId)

  if (!routePlan) {
    return {
      ok: false,
      error: "That service line could not be found.",
    }
  }

  const currentPlayer = getPlayerById(game, playerId)

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

  if (vehicleCard.type !== getVehicleTypeForMode(routePlan.route.mode)) {
    return {
      ok: false,
      error: "That vehicle card cannot operate this service line.",
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

export function setBureaucracyServiceCities(
  game: GameState,
  routeId: string,
  cityIds: string[],
  playerId = game.currentPlayerId,
): BureaucracyServiceCitiesResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Service cities can only be updated after you confirm picks and before you click Next player.",
    }
  }

  const routePlan = findPlayerBureaucracyPlan(game, playerId, routeId)

  if (!routePlan) {
    return {
      ok: false,
      error: "That service line could not be found.",
    }
  }

  const summary = buildPlayerBureaucracySummary(game, playerId)
  const corridorPlans =
    summary?.routePlans.filter(plan => plan.corridorId === routePlan.corridorId) ?? []
  const disconnectedPlan = corridorPlans.find(plan => plan.isDisconnected) ?? null
  const nextSelections = { ...game.bureaucracyServiceCityIdsByRouteId }
  const normalizedCityIds = [...new Set(routePlan.availableCityIds.filter(cityId => cityIds.includes(cityId)))]

  nextSelections[routeId] = normalizedCityIds

  if (disconnectedPlan) {
    syncDisconnectedServiceCities(
      nextSelections,
      routePlan.availableCityIds,
      corridorPlans.filter(plan => !plan.isDisconnected).map(plan => plan.id),
      disconnectedPlan.id,
    )
  }

  return {
    ok: true,
    routeId,
    cityIds: normalizedCityIds,
    game: {
      ...game,
      bureaucracyServiceCityIdsByRouteId: nextSelections,
    },
  }
}

export function addBureaucracyServiceSplit(
  game: GameState,
  corridorId: string,
  playerId = game.currentPlayerId,
): BureaucracyServiceSplitResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Service splits can only be added after you confirm picks and before you click Next player.",
    }
  }

  return {
    ok: true,
    corridorId,
    game: {
      ...game,
      bureaucracyServiceSlotCountsByCorridorId: {
        ...game.bureaucracyServiceSlotCountsByCorridorId,
        [corridorId]: Math.max(1, game.bureaucracyServiceSlotCountsByCorridorId[corridorId] ?? 1) + 1,
      },
    },
  }
}

function syncDisconnectedServiceCities(
  nextSelections: Record<string, string[]>,
  availableCityIds: string[],
  activeRouteIds: string[],
  disconnectedRouteId: string,
) {
  const activeCityIds = new Set(
    activeRouteIds.flatMap(routeId => nextSelections[routeId] ?? []),
  )

  nextSelections[disconnectedRouteId] = availableCityIds.filter(
    cityId => !activeCityIds.has(cityId),
  )
}

export function deleteBureaucracyServicePod(
  game: GameState,
  corridorId: string,
  routeId: string,
  playerId = game.currentPlayerId,
): BureaucracyServicePodDeleteResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Routes can only be deleted after you confirm picks and before you click Next player.",
    }
  }

  const summary = buildPlayerBureaucracySummary(game, playerId)
  const corridorPlans =
    summary?.routePlans
      .filter(plan => plan.corridorId === corridorId)
      .sort((planA, planB) => planA.slotIndex - planB.slotIndex) ?? []
  const targetPlan = corridorPlans.find(plan => plan.id === routeId)
  const disconnectedPlan = corridorPlans.find(plan => plan.isDisconnected)

  if (!targetPlan || targetPlan.isDisconnected) {
    return {
      ok: false,
      error: "That route could not be found.",
    }
  }

  if (!disconnectedPlan) {
    return {
      ok: false,
      error: "The disconnected route could not be found.",
    }
  }

  const remainingPlans = corridorPlans.filter(
    plan => !plan.isDisconnected && plan.id !== routeId,
  )
  const deletedCityIds = targetPlan.selectedCityIds
  const nextSelections = { ...game.bureaucracyServiceCityIdsByRouteId }
  const nextVehicleAssignments = { ...game.bureaucracyVehicleCardIdsByRouteId }

  corridorPlans.forEach(plan => {
    delete nextSelections[plan.id]
    delete nextVehicleAssignments[plan.id]
  })

  remainingPlans.forEach((plan, slotIndex) => {
    const nextRouteId = buildServiceSlotId(corridorId, slotIndex)
    nextSelections[nextRouteId] = [...plan.selectedCityIds]

    if (plan.vehicleCard?.id) {
      nextVehicleAssignments[nextRouteId] = plan.vehicleCard.id
    }
  })

  if (remainingPlans.length === 0) {
    nextSelections[buildServiceSlotId(corridorId, 0)] = []
  }

  const disconnectedRouteId = buildDisconnectedServiceSlotId(corridorId)
  const remainingActiveRouteIds =
    remainingPlans.length === 0
      ? [buildServiceSlotId(corridorId, 0)]
      : remainingPlans.map((_, slotIndex) => buildServiceSlotId(corridorId, slotIndex))
  const remainingActiveCityIds = new Set(
    remainingActiveRouteIds.flatMap(routeCandidateId => nextSelections[routeCandidateId] ?? []),
  )
  syncDisconnectedServiceCities(
    nextSelections,
    targetPlan.availableCityIds,
    remainingActiveRouteIds,
    disconnectedRouteId,
  )

  const disconnectedCityIds = deletedCityIds.filter(cityCandidateId =>
    !remainingActiveCityIds.has(cityCandidateId),
  )

  return {
    ok: true,
    corridorId,
    routeId,
    cityIds: deletedCityIds,
    disconnectedCityIds,
    game: {
      ...game,
      bureaucracyServiceSlotCountsByCorridorId: {
        ...game.bureaucracyServiceSlotCountsByCorridorId,
        [corridorId]: Math.max(1, remainingPlans.length),
      },
      bureaucracyServiceCityIdsByRouteId: nextSelections,
      bureaucracyVehicleCardIdsByRouteId: nextVehicleAssignments,
    },
  }
}

export function moveBureaucracyServiceCity(
  game: GameState,
  corridorId: string,
  cityId: string,
  routeId: string,
  sourceRouteId: string | null = null,
  playerId = game.currentPlayerId,
): BureaucracyServiceCityMoveResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Route cities can only be moved after you confirm picks and before you click Next player.",
    }
  }

  const summary = buildPlayerBureaucracySummary(game, playerId)
  const corridorPlans =
    summary?.routePlans.filter(plan => plan.corridorId === corridorId) ?? []
  const targetPlan = corridorPlans.find(plan => plan.id === routeId)
  const disconnectedPlan = corridorPlans.find(plan => plan.isDisconnected) ?? null
  const sourcePlan =
    sourceRouteId === null ? null : corridorPlans.find(plan => plan.id === sourceRouteId) ?? null

  if (!targetPlan) {
    return {
      ok: false,
      error: "That target route could not be found.",
    }
  }

  if (!targetPlan.availableCityIds.includes(cityId)) {
    return {
      ok: false,
      error: "That city does not belong to this route group.",
    }
  }

  if (sourceRouteId !== null && !sourcePlan) {
    return {
      ok: false,
      error: "That source route could not be found.",
    }
  }

  const nextSelections = { ...game.bureaucracyServiceCityIdsByRouteId }

  corridorPlans.forEach(plan => {
    nextSelections[plan.id] = [...plan.selectedCityIds]
  })

  if (targetPlan.isDisconnected) {
    if (sourcePlan && !sourcePlan.isDisconnected) {
      nextSelections[sourcePlan.id] = sourcePlan.selectedCityIds.filter(
        selectedCityId => selectedCityId !== cityId,
      )
    }
  } else {
    nextSelections[routeId] = [...new Set([...(nextSelections[routeId] ?? []), cityId])]
  }

  if (
    !targetPlan.isDisconnected &&
    !isValidServicePodSelection(nextSelections[routeId] ?? [], targetPlan.corridorSegmentPairs)
  ) {
    return {
      ok: false,
      error: "That destination route would be disconnected. Routes with 2+ cities must stay connected.",
    }
  }

  if (disconnectedPlan) {
    syncDisconnectedServiceCities(
    nextSelections,
    targetPlan.availableCityIds,
    corridorPlans.filter(plan => !plan.isDisconnected).map(plan => plan.id),
    disconnectedPlan.id,
    )
  }

  return {
    ok: true,
    corridorId,
    routeId,
    cityId,
    sourceRouteId,
    game: {
    ...game,
    bureaucracyServiceCityIdsByRouteId: nextSelections,
    },
  }
}

export function claimRoute(
  game: GameState,
  input: ClaimRouteInput,
  playerId = game.currentPlayerId,
): ClaimRouteResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Routes can only be claimed after you confirm picks and before you click Next player.",
    }
  }

  const currentPlayer = getPlayerById(game, playerId)

  if (!currentPlayer) {
    return {
      ok: false,
      error: "Current player could not be found.",
    }
  }

  const cityIds = input.cityIds

  if (input.mode === "bus") {
    return {
      ok: false,
      error: "Bus routes are automatic from connected owned city cards. Build rail track or air links in Operations instead.",
    }
  }

  const effectiveCityIds = getEffectiveClaimCityIds(game, input.mode, cityIds, playerId)
  const handCityIds = getCurrentPlayerHandCityIds(game, currentPlayer)

  if (cityIds.some(cityId => !handCityIds.includes(cityId))) {
    return {
      ok: false,
      error: `${input.mode === "air" ? "Air" : "Rail"} routes must use city cards you already own.`,
    }
  }

  const resolvedSelection =
    input.mode === "rail" && input.segmentPairs && input.segmentPairs.length > 0
      ? resolveSegmentSelection(game, input.segmentPairs, input.mode)
      : resolveRouteSelection(game, effectiveCityIds, input.mode)

  if (!resolvedSelection.ok) {
    return {
      ok: false,
      error: resolvedSelection.error,
    }
  }

  const orderedCityIds = resolvedSelection.cityIds
  const segmentPairs =
    input.mode === "rail" && input.segmentPairs && input.segmentPairs.length > 0
      ? resolvedSelection.segmentPairs
      : getClaimSegmentPairs(game, input.mode, cityIds, playerId)
  const ownedVehicleTypes = new Set(getOwnedVehicleCards(game, playerId).map(card => card.type))

  if (!ownedVehicleTypes.has(getVehicleTypeForMode(input.mode))) {
    return {
      ok: false,
      error: `Buy a ${input.mode === "rail" ? "train" : input.mode} vehicle card first.`,
    }
  }

  const cost = Math.ceil(
    calculateClaimRouteCost(game, {
      cityIds: orderedCityIds,
      mode: input.mode,
      segmentPairs: input.segmentPairs,
    }, playerId),
  )
  const connectionBonus = calculateConnectionBonus(game, currentPlayer.id, orderedCityIds)

  if (currentPlayer.money < cost) {
    return {
      ok: false,
      error: "You do not have enough money to build that route.",
    }
  }

  const routes: Route[] = segmentPairs.map(([cityAId, cityBId]) => {
    const [cityA, cityB] = normalizeRoutePair(cityAId, cityBId)

    return {
      id: buildRouteId(cityA, cityB, input.mode),
      cityA,
      cityB,
      mode: input.mode,
      railTraction: input.mode === "rail" ? ("diesel" as const) : undefined,
      ownerId: playerId,
    }
  })
  const claimedGame = {
    ...game,
    routes: [...game.routes, ...routes],
    activeCityOffer: null,
    claimedRoutePlayerIdsThisTurn: dedupePlayerIds([
      ...game.claimedRoutePlayerIdsThisTurn,
      playerId,
    ]),
    claimedRouteCountsByPlayerIdThisTurn: {
      ...game.claimedRouteCountsByPlayerIdThisTurn,
      [playerId]: (game.claimedRouteCountsByPlayerIdThisTurn[playerId] ?? 0) + 1,
    },
    claimedRouteModesThisPhase: {
      ...game.claimedRouteModesThisPhase,
      [input.mode]: true,
    },
    players: game.players.map(player =>
      player.id === currentPlayer.id
        ? {
            ...player,
            money: player.money - cost + connectionBonus.totalBonus,
            startingCityId: player.startingCityId ?? orderedCityIds[0],
          }
        : player,
    ),
  }
  const migratedBureaucracyState = migrateBureaucracyServiceState(game, claimedGame)

  return {
    ok: true,
    cost,
    connectionBonus: connectionBonus.totalBonus,
    newCityIds: connectionBonus.newlyConnectedCityIds,
    routes,
    game: {
      ...claimedGame,
      ...migratedBureaucracyState,
    },
  }
}

export function upgradeRailRoute(
  game: GameState,
  routeId: string,
  playerId = game.currentPlayerId,
): RailUpgradeResult {
  if (isGameLocked(game)) {
    return {
      ok: false,
      error: "The game is over.",
    }
  }

  if (!canPlayerEditOperations(game, playerId)) {
    return {
      ok: false,
      error: "Rail upgrades can only be purchased after you confirm picks and before you click Next player.",
    }
  }

  const route = game.routes.find(candidate => candidate.id === routeId)

  if (!route?.ownerId) {
    return {
      ok: false,
      error: "That route could not be found.",
    }
  }

  if (route.ownerId !== playerId) {
    return {
      ok: false,
      error: "You can only upgrade your own rail routes.",
    }
  }

  if (route.mode !== "rail") {
    return {
      ok: false,
      error: "Only rail routes can be electrified.",
    }
  }

  if (route.railTraction === "electric") {
    return {
      ok: false,
      error: "That rail route is already electrified.",
    }
  }

  const currentPlayer = getPlayerById(game, playerId)

  if (!currentPlayer) {
    return {
      ok: false,
      error: "Current player could not be found.",
    }
  }

  const cost = getRailUpgradeCost(game, route)

  if (currentPlayer.money < cost) {
    return {
      ok: false,
      error: "You do not have enough money to electrify that route.",
    }
  }

  return {
    ok: true,
    routeId,
    cost,
    game: {
      ...game,
      routes: game.routes.map(candidate =>
        candidate.id === routeId
          ? {
              ...candidate,
              railTraction: "electric",
            }
          : candidate,
      ),
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
