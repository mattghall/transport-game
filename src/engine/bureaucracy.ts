import {
  getAffordableFleetSize,
  getBalanceAdjustmentPerTrip,
  getCityDemandAbsorptionSize,
  getCityDemandSize,
  getCrewCostForTrips,
  getFuelPriceMultiplier,
  getWeeklyMaintenanceCostForCard,
} from "./economy"
import { getImplicitBusRoutes } from "./playerNetwork"
import { getOwnedVehicleCountForCard } from "./playerVehicles"
import {
  calculateRealFuelFromUnits,
  calculateRouteDistanceMiles,
  calculateRouteTripsPerWeek,
} from "./trips"
import type {
  FuelBurnUnit,
  GameState,
  Player,
  PurchasableResource,
  RouteModeBreakdown,
  Route,
  RouteMode,
  VehicleCard,
  VehicleType,
} from "./types"

export type BureaucracyRoutePlan = {
  id: string
  corridorId: string
  slotIndex: number
  isDisconnected: boolean
  routes: Route[]
  corridorSegmentPairs: Array<[string, string]>
  route: Route
  serviceLabel: string
  cityAName: string
  cityBName: string
  cityIds: string[]
  availableCityIds: string[]
  selectedCityIds: string[]
  cityCubeDemands: {
    cityId: string
    cityName: string
    outboundCubes: number
    inboundCubes: number
  }[]
  segmentCount: number
  canAddSplitService: boolean
  combinedDemand: number
  populationPerMile: number | null
  totalOutboundCubes: number
  totalInboundCubes: number
  cubeCapacityPerTrip: number
  movableDemandCubes: number
  movedCubes: number
  vehicleCard: VehicleCard | null
  demandFleetSize: number
  selectedFleetSize: number
  statsFuelResource: PurchasableResource | null
  statsFuelBurnUnit: FuelBurnUnit | null
  distanceMiles: number | null
  maxTripsByTime: number
  maxFuelUnitsByTime: number
  weeklyFuelBurnReal: number
  weeklyFuelBurnUnits: number
  selectedFuelUnits: number
  selectedTrips: number
  passengersPerTrip: number
  passengersServed: number
  simplifiedPayoutMultiplier: number
  simplifiedCityStatuses: SimplifiedFlowCityStatus[]
  simplifiedLedgerEntries: SimplifiedFlowLedgerEntry[]
  fuelResource: PurchasableResource | null
  fuelBurnUnit: FuelBurnUnit | null
  tripFuelBurnReal: number
  tripFuelBurnUnits: number
  totalFuelBurnReal: number
  totalFuelBurnUnits: number
  crewCost: number
  maintenanceCost: number
  balanceAdjustmentCost: number
  fuelCost: number
  baseOperatingCost: number
  revenue: number
  operatingCost: number
  netRevenue: number
}

type CityCubeDemand = {
  cityId: string
  cityName: string
  outboundCubes: number
  inboundCubes: number
}

type SimplifiedFlowCityStatus = {
  cityId: string
  cityName: string
  size: number
  outboundCubes: number
  inboundCubes: number
  filledCubes: number
}

type SimplifiedFlowLedgerEntry = {
  id: string
  originCityId: string
  originCityName: string
  destinationCityId: string
  destinationCityName: string
  cubeCount: number
  passengers: number
  payoutMultiplier: number
  farePerPassenger: number
  payout: number
  pathCityIds: string[]
  pathLabels: string[]
}

type SimplifiedFlowPlan = {
  cityStatuses: SimplifiedFlowCityStatus[]
  ledgerEntries: SimplifiedFlowLedgerEntry[]
  totalPayoutMultiplier: number
  totalPayout: number
}

type CubeTransferDemand = {
  cityCubeDemands: CityCubeDemand[]
  totalOutboundCubes: number
  totalInboundCubes: number
  movableDemandCubes: number
}

type ServiceGroup = {
  id: string
  routes: Route[]
  cityIds: string[]
  mode: RouteMode
  railTraction?: Route["railTraction"]
}

type ServiceSlot = {
  id: string
  corridorId: string
  slotIndex: number
  serviceGroup: ServiceGroup
  canAddSplitService: boolean
  isDisconnected: boolean
}

function createEmptyRouteModeBreakdown(): RouteModeBreakdown {
  return {
    bus: 0,
    rail: 0,
    air: 0,
  }
}

export function isValidServicePodSelection(
  cityIds: string[],
  corridorSegmentPairs: Array<[string, string]>,
  options?: { allowSingleCity?: boolean },
) {
  const normalizedCityIds = [...new Set(cityIds)]

  if (normalizedCityIds.length === 0) {
    return true
  }

  if (normalizedCityIds.length === 1) {
    return options?.allowSingleCity ?? true
  }

  const cityIdSet = new Set(normalizedCityIds)
  const adjacency = new Map<string, string[]>()

  for (const cityId of normalizedCityIds) {
    adjacency.set(cityId, [])
  }

  for (const [cityAId, cityBId] of corridorSegmentPairs) {
    if (!cityIdSet.has(cityAId) || !cityIdSet.has(cityBId)) {
      continue
    }

    adjacency.get(cityAId)?.push(cityBId)
    adjacency.get(cityBId)?.push(cityAId)
  }

  const visited = new Set<string>()
  const queue = [normalizedCityIds[0]]

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

  return normalizedCityIds.every(cityId => visited.has(cityId))
}

export type PlayerBureaucracySummary = {
  player: Player
  routePlans: BureaucracyRoutePlan[]
  passengersServedByMode: RouteModeBreakdown
  podCountByMode: RouteModeBreakdown
  fuelUsedUnits: Record<PurchasableResource, number>
  fuelUsedReal: Record<PurchasableResource, number>
  fuelRemainingUnits: Record<PurchasableResource, number>
  fuelRemainingReal: Record<PurchasableResource, number>
  totalCrewCost: number
  totalMaintenanceCost: number
  totalBalanceAdjustmentCost: number
  totalFuelCost: number
  totalPassengersServed: number
  totalRevenue: number
  totalOperatingCost: number
  netRevenue: number
}

function getVehicleTypeForRouteMode(mode: RouteMode): VehicleType {
  switch (mode) {
    case "rail":
      return "train"
    case "air":
      return "air"
    case "bus":
      return "bus"
  }
}

function getBureaucracyPlanningPriority(mode: RouteMode) {
  switch (mode) {
    case "air":
      return 0
    case "rail":
      return 1
    case "bus":
      return 2
  }
}

function getCityName(game: GameState, cityId: string) {
  return game.cities.find(city => city.id === cityId)?.name ?? cityId
}

function getOwnedVehicleCards(game: GameState, player: Player) {
  return player.ownedVehicleCardIds
    .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
    .filter((card): card is VehicleCard => card !== null)
    .sort((cardA, cardB) => cardA.number - cardB.number)
}

function buildCubeTransferDemand(
  game: GameState,
  cityIds: string[],
  sharedDemandState?: {
    outboundCubesByCityId: Map<string, number>
    inboundCubesByCityId: Map<string, number>
  },
): CubeTransferDemand {
  const cityCubeDemands = [...new Set(cityIds)].map(cityId => {
    const city = game.cities.find(candidate => candidate.id === cityId)
    const outboundCubes =
      sharedDemandState?.outboundCubesByCityId.get(cityId) ??
      (city ? Math.max(0, getCityDemandSize(game, city)) : 0)
    const inboundCubes =
      sharedDemandState?.inboundCubesByCityId.get(cityId) ??
      (city ? getCityDemandAbsorptionSize(game, city) : 1)

    return {
      cityId,
      cityName: getCityName(game, cityId),
      outboundCubes,
      inboundCubes,
    }
  })
  const totalOutboundCubes = cityCubeDemands.reduce(
    (total, cityDemand) => total + cityDemand.outboundCubes,
    0,
  )
  const totalInboundCubes = cityCubeDemands.reduce(
    (total, cityDemand) => total + cityDemand.inboundCubes,
    0,
  )
  const movableDemandCubes = cityCubeDemands.reduce((bestTotal, cityDemand) => {
    const availableOtherInbound = totalInboundCubes - cityDemand.inboundCubes
    const blockedOutbound = Math.max(
      0,
      cityDemand.outboundCubes - availableOtherInbound,
    )

    return Math.min(bestTotal, totalOutboundCubes - blockedOutbound)
  }, Math.min(totalOutboundCubes, totalInboundCubes))

  return {
    cityCubeDemands,
    totalOutboundCubes,
    totalInboundCubes,
    movableDemandCubes: Math.max(0, movableDemandCubes),
  }
}

function getRouteDistanceMilesFromMap(
  game: GameState,
  cityAId: string,
  cityBId: string,
) {
  const cityA = game.cities.find(city => city.id === cityAId)
  const cityB = game.cities.find(city => city.id === cityBId)

  if (!cityA || !cityB) {
    return 0
  }

  const forwardConnection = cityA.adjacentCities?.find(adjacentCity => adjacentCity.id === cityBId)
  const reverseConnection = cityB.adjacentCities?.find(adjacentCity => adjacentCity.id === cityAId)

  return (
    forwardConnection?.distance ??
    reverseConnection?.distance ??
    calculateRouteDistanceMiles(game.cities, {
      id: `distance:${cityAId}:${cityBId}`,
      cityA: cityAId,
      cityB: cityBId,
      mode: "bus",
    }) ??
    0
  )
}

export function getPayoutMultiplierForDistance(distanceMiles: number) {
  if (distanceMiles <= 125) {
    return 2
  }

  if (distanceMiles <= 250) {
    return 4
  }

  return 6
}

const PAYOUT_DOLLARS_PER_WEIGHT = 7.5

export function getPayoutFarePerPassengerForDistance(distanceMiles: number) {
  return getPayoutMultiplierForDistance(distanceMiles) * PAYOUT_DOLLARS_PER_WEIGHT
}

function buildSimplifiedFlowPlan(
  game: GameState,
  cityIds: string[],
  routes: Route[],
  cityCubeDemands: CityCubeDemand[],
  movedCubes: number,
  passengersServed: number,
): SimplifiedFlowPlan {
  const cityStatusMap = new Map<string, SimplifiedFlowCityStatus>()

  for (const cityDemand of cityCubeDemands) {
    const city = game.cities.find(candidate => candidate.id === cityDemand.cityId)

    cityStatusMap.set(cityDemand.cityId, {
      cityId: cityDemand.cityId,
      cityName: cityDemand.cityName,
      size: city?.size ?? 0,
      outboundCubes: cityDemand.outboundCubes,
      inboundCubes: cityDemand.inboundCubes,
      filledCubes: 0,
    })
  }

  const adjacency = new Map<string, Array<{ cityId: string; distanceMiles: number }>>()

  for (const route of routes) {
    const distanceMiles = getRouteDistanceMilesFromMap(game, route.cityA, route.cityB)

    adjacency.set(route.cityA, [...(adjacency.get(route.cityA) ?? []), { cityId: route.cityB, distanceMiles }])
    adjacency.set(route.cityB, [...(adjacency.get(route.cityB) ?? []), { cityId: route.cityA, distanceMiles }])
  }

  const findShortestPath = (originCityId: string, destinationCityId: string) => {
    if (originCityId === destinationCityId) {
      return [originCityId]
    }

    const distances = new Map<string, number>(cityIds.map(cityId => [cityId, Number.POSITIVE_INFINITY]))
    const previous = new Map<string, string | null>(cityIds.map(cityId => [cityId, null]))
    const remaining = new Set(cityIds)

    distances.set(originCityId, 0)

    while (remaining.size > 0) {
      const currentCityId = [...remaining].sort((cityAId, cityBId) => {
        const distanceDifference =
          (distances.get(cityAId) ?? Number.POSITIVE_INFINITY) -
          (distances.get(cityBId) ?? Number.POSITIVE_INFINITY)

        if (distanceDifference !== 0) {
          return distanceDifference
        }

        return cityAId.localeCompare(cityBId)
      })[0]

      remaining.delete(currentCityId)

      if (currentCityId === destinationCityId) {
        break
      }

      for (const neighbor of adjacency.get(currentCityId) ?? []) {
        if (!remaining.has(neighbor.cityId)) {
          continue
        }

        const nextDistance =
          (distances.get(currentCityId) ?? Number.POSITIVE_INFINITY) +
          neighbor.distanceMiles

        if (nextDistance < (distances.get(neighbor.cityId) ?? Number.POSITIVE_INFINITY)) {
          distances.set(neighbor.cityId, nextDistance)
          previous.set(neighbor.cityId, currentCityId)
        }
      }
    }

    if (
      (distances.get(destinationCityId) ?? Number.POSITIVE_INFINITY) ===
      Number.POSITIVE_INFINITY
    ) {
      return null
    }

    const pathCityIds: string[] = []
    let currentCityId: string | null = destinationCityId

    while (currentCityId) {
      pathCityIds.unshift(currentCityId)
      currentCityId = previous.get(currentCityId) ?? null
    }

    return pathCityIds[0] === originCityId ? pathCityIds : null
  }

  // Process destinations smallest city first, largest last
  const destinationStatuses = [...cityStatusMap.values()].sort((cityA, cityB) => {
    if (cityA.size !== cityB.size) {
      return cityA.size - cityB.size
    }

    if (cityA.inboundCubes !== cityB.inboundCubes) {
      return cityA.inboundCubes - cityB.inboundCubes
    }

    return cityA.cityName.localeCompare(cityB.cityName)
  })
  const remainingOutboundByCityId = Object.fromEntries(
    [...cityStatusMap.values()].map(cityStatus => [cityStatus.cityId, cityStatus.outboundCubes]),
  )
  const passengersPerCube = movedCubes > 0 ? passengersServed / movedCubes : 0
  const ledgerEntries: SimplifiedFlowLedgerEntry[] = []
  let remainingMovableCubes = movedCubes

  // Pre-compute proportional cube allocation per destination based on inbound capacity
  const totalPodInbound = destinationStatuses.reduce((sum, s) => sum + s.inboundCubes, 0)
  const proportionalAllocationById = new Map<string, number>()
  let allocatedSoFar = 0
  destinationStatuses.forEach((dest, index) => {
    if (index < destinationStatuses.length - 1) {
      const alloc = totalPodInbound > 0
        ? Math.floor(dest.inboundCubes / totalPodInbound * movedCubes)
        : 0
      proportionalAllocationById.set(dest.cityId, alloc)
      allocatedSoFar += alloc
    } else {
      // Largest city absorbs any rounding remainder
      proportionalAllocationById.set(dest.cityId, Math.max(0, movedCubes - allocatedSoFar))
    }
  })

  for (const destinationStatus of destinationStatuses) {
    const proportionalAllocation = proportionalAllocationById.get(destinationStatus.cityId) ?? 0
    let remainingInbound = Math.min(
      proportionalAllocation,
      destinationStatus.inboundCubes - destinationStatus.filledCubes,
    )

    if (remainingInbound <= 0 || remainingMovableCubes <= 0) {
      continue
    }

    const originStatuses = [...cityStatusMap.values()].sort((cityA, cityB) => {
      if (cityB.outboundCubes !== cityA.outboundCubes) {
        return cityB.outboundCubes - cityA.outboundCubes
      }

      if (cityB.size !== cityA.size) {
        return cityB.size - cityA.size
      }

      return cityA.cityName.localeCompare(cityB.cityName)
    })

    for (const originStatus of originStatuses) {
      if (originStatus.cityId === destinationStatus.cityId) {
        continue
      }

      const remainingOriginOutbound = remainingOutboundByCityId[originStatus.cityId] ?? 0

      if (remainingOriginOutbound <= 0 || remainingInbound <= 0 || remainingMovableCubes <= 0) {
        continue
      }

      const pathCityIds = findShortestPath(originStatus.cityId, destinationStatus.cityId)

      if (!pathCityIds || pathCityIds.length < 2) {
        continue
      }

      const cubeCount = Math.min(
        remainingOriginOutbound,
        remainingInbound,
        remainingMovableCubes,
      )

      if (cubeCount <= 0) {
        continue
      }

      const pathLabels: string[] = []
      let payoutMultiplier = 0
      let farePerPassenger = 0

      for (let index = 0; index < pathCityIds.length - 1; index += 1) {
        const startCityId = pathCityIds[index]
        const endCityId = pathCityIds[index + 1]
        const distanceMiles = getRouteDistanceMilesFromMap(game, startCityId, endCityId)
        const segmentMultiplier = getPayoutMultiplierForDistance(distanceMiles)
        const segmentFarePerPassenger = getPayoutFarePerPassengerForDistance(distanceMiles)
        const startCityName =
          cityStatusMap.get(startCityId)?.cityName ?? getCityName(game, startCityId)
        const endCityName =
          cityStatusMap.get(endCityId)?.cityName ?? getCityName(game, endCityId)

        payoutMultiplier += segmentMultiplier
        farePerPassenger += segmentFarePerPassenger
        pathLabels.push(
          `${startCityName} -> ${endCityName} (${distanceMiles}mi x${segmentMultiplier} = $${segmentFarePerPassenger.toFixed(0)})`,
        )
      }

      const passengers = cubeCount * passengersPerCube
      const payout = passengers * farePerPassenger

      ledgerEntries.push({
        id: `${originStatus.cityId}:${destinationStatus.cityId}:${ledgerEntries.length}`,
        originCityId: originStatus.cityId,
        originCityName: originStatus.cityName,
        destinationCityId: destinationStatus.cityId,
        destinationCityName: destinationStatus.cityName,
        cubeCount,
        passengers,
        payoutMultiplier,
        farePerPassenger,
        payout,
        pathCityIds,
        pathLabels,
      })

      remainingOutboundByCityId[originStatus.cityId] = remainingOriginOutbound - cubeCount
      destinationStatus.filledCubes += cubeCount
      remainingInbound -= cubeCount
      remainingMovableCubes -= cubeCount
    }
  }

  return {
    cityStatuses: cityIds
      .map(cityId => cityStatusMap.get(cityId) ?? null)
      .filter((cityStatus): cityStatus is SimplifiedFlowCityStatus => cityStatus !== null),
    ledgerEntries,
    totalPayoutMultiplier: ledgerEntries.reduce(
      (total, entry) => total + entry.payoutMultiplier * entry.cubeCount,
      0,
    ),
    totalPayout: ledgerEntries.reduce((total, entry) => total + entry.payout, 0),
  }
}

function getCubeCapacityPerTrip(
  game: Pick<GameState, "operatingConfig">,
  vehicleCard: VehicleCard | null,
) {
  if (!vehicleCard) {
    return 0
  }

  return Math.max(
    1,
    Math.ceil(
      vehicleCard.totalPassengerCapacity /
        Math.max(game.operatingConfig.passengersPerDemandPoint, 1),
    ),
  )
}

function buildServiceGroupId(routes: Route[]) {
  return `service:${routes.map(route => route.id).sort().join("|")}`
}

function buildSingleRouteServiceGroup(route: Route): ServiceGroup {
  return {
    id: buildServiceGroupId([route]),
    routes: [route],
    cityIds: [route.cityA, route.cityB],
    mode: route.mode,
    railTraction: route.railTraction,
  }
}

function buildConnectedServiceGroup(routes: Route[]): ServiceGroup | null {
  if (routes.length === 0) {
    return null
  }

  const orderedRoutes = [...routes].sort((routeA, routeB) => routeA.id.localeCompare(routeB.id))
  const cityIds = [...new Set(orderedRoutes.flatMap(route => [route.cityA, route.cityB]))].sort(
    (cityA, cityB) => cityA.localeCompare(cityB),
  )

  return {
    id: buildServiceGroupId(orderedRoutes),
    routes: orderedRoutes,
    cityIds,
    mode: orderedRoutes[0].mode,
    railTraction: orderedRoutes[0].railTraction,
  }
}

function buildOwnedServiceGroups(game: GameState, player: Player) {
  const explicitOwnedRoutes = game.routes
    .filter(route => route.ownerId === player.id && route.mode !== "bus")
    .sort((routeA, routeB) => routeA.id.localeCompare(routeB.id))
  const implicitBusRoutes = getImplicitBusRoutes(game, player)
  const ownedRoutes = [...explicitOwnedRoutes, ...implicitBusRoutes].sort((routeA, routeB) =>
    routeA.id.localeCompare(routeB.id),
  )
  const airGroups = ownedRoutes
    .filter(route => route.mode === "air")
    .map(buildSingleRouteServiceGroup)
  const busAndRailRoutes = ownedRoutes.filter(route => route.mode !== "air")
  const remainingRouteIds = new Set(busAndRailRoutes.map(route => route.id))
  const connectedGroups: ServiceGroup[] = []

  while (remainingRouteIds.size > 0) {
    const seedRoute = busAndRailRoutes.find(route => remainingRouteIds.has(route.id))

    if (!seedRoute) {
      break
    }

    const componentRoutes: Route[] = []
    const queue = [seedRoute]
    const componentCityIds = new Set<string>()

    while (queue.length > 0) {
      const currentRoute = queue.shift()

      if (!currentRoute || !remainingRouteIds.has(currentRoute.id)) {
        continue
      }

      remainingRouteIds.delete(currentRoute.id)
      componentRoutes.push(currentRoute)
      componentCityIds.add(currentRoute.cityA)
      componentCityIds.add(currentRoute.cityB)

      for (const candidate of busAndRailRoutes) {
        if (
          !remainingRouteIds.has(candidate.id) ||
          candidate.mode !== seedRoute.mode ||
          (candidate.mode === "rail"
            ? (candidate.railTraction ?? "diesel") !== (seedRoute.railTraction ?? "diesel")
            : false)
        ) {
          continue
        }

        if (componentCityIds.has(candidate.cityA) || componentCityIds.has(candidate.cityB)) {
          queue.push(candidate)
        }
      }
    }

    const connectedGroup = buildConnectedServiceGroup(componentRoutes)

    if (connectedGroup) {
      connectedGroups.push(connectedGroup)
    }
  }

  return [...connectedGroups, ...airGroups].sort((groupA, groupB) => groupA.id.localeCompare(groupB.id))
}

export function buildServiceSlotId(corridorId: string, slotIndex: number) {
  return `${corridorId}:slot:${slotIndex}`
}

export function buildDisconnectedServiceSlotId(corridorId: string) {
  return `${corridorId}:slot:disconnected`
}

function normalizeSelectedCityIds(availableCityIds: string[], requestedCityIds: string[] | undefined) {
  return [...new Set((requestedCityIds ?? []).filter(cityId => availableCityIds.includes(cityId)))]
}

function buildServiceSlots(
  game: GameState,
  player: Player,
) {
  const serviceGroups = buildOwnedServiceGroups(game, player)
  const serviceSlots: ServiceSlot[] = []

  for (const serviceGroup of serviceGroups) {
    const slotCount = Math.max(
      1,
      game.bureaucracyServiceSlotCountsByCorridorId[serviceGroup.id] ?? 1,
    )

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      serviceSlots.push({
        id: buildServiceSlotId(serviceGroup.id, slotIndex),
        corridorId: serviceGroup.id,
        slotIndex,
        serviceGroup,
        canAddSplitService: serviceGroup.cityIds.length > slotCount,
        isDisconnected: false,
      })
    }

    serviceSlots.push({
      id: buildDisconnectedServiceSlotId(serviceGroup.id),
      corridorId: serviceGroup.id,
      slotIndex: slotCount,
      serviceGroup,
      canAddSplitService: false,
      isDisconnected: true,
    })
  }

  return serviceSlots.sort((slotA, slotB) => {
    if (slotA.corridorId !== slotB.corridorId) {
      return slotA.corridorId.localeCompare(slotB.corridorId)
    }

    if (slotA.isDisconnected !== slotB.isDisconnected) {
      return slotA.isDisconnected ? 1 : -1
    }

    return slotA.slotIndex - slotB.slotIndex
  })
}

function assignVehicleCardsToServiceGroups(
  game: GameState,
  player: Player,
  ownedCards: VehicleCard[],
) {
  const serviceSlots = buildServiceSlots(game, player)
  const cardsById = new Map(ownedCards.map(card => [card.id, card]))
  const cardsByType: Record<VehicleType, VehicleCard[]> = {
    air: [],
    train: [],
    bus: [],
  }
  const explicitAssignmentsBySlotId: Record<string, VehicleCard | null> = {}
  const usedCardIds = new Set<string>()

  for (const serviceSlot of serviceSlots) {
    if (serviceSlot.isDisconnected) {
      explicitAssignmentsBySlotId[serviceSlot.id] = null
      continue
    }

    const assignedCardId = game.bureaucracyVehicleCardIdsByRouteId[serviceSlot.id]
    const assignedCard =
      assignedCardId === undefined ? null : cardsById.get(assignedCardId) ?? null

    if (
      assignedCard &&
      assignedCard.type === getVehicleTypeForRouteMode(serviceSlot.serviceGroup.mode) &&
      !usedCardIds.has(assignedCard.id)
    ) {
      explicitAssignmentsBySlotId[serviceSlot.id] = assignedCard
      usedCardIds.add(assignedCard.id)
      continue
    }

    explicitAssignmentsBySlotId[serviceSlot.id] = null
  }

  for (const card of ownedCards) {
    if (usedCardIds.has(card.id)) {
      continue
    }

    cardsByType[card.type].push(card)
  }

  return serviceSlots.map(serviceSlot => {
    const assignedCard = explicitAssignmentsBySlotId[serviceSlot.id]

    return {
      serviceSlot,
      vehicleCard:
        serviceSlot.isDisconnected
          ? null
          :
        assignedCard ??
        cardsByType[getVehicleTypeForRouteMode(serviceSlot.serviceGroup.mode)].shift() ??
        null,
    }
  })
}

type PersistedServiceSlotState = {
  corridorId: string
  slotIndex: number
  mode: RouteMode
  isDisconnected: boolean
  availableCityIds: string[]
  selectedCityIds: string[]
  assignedVehicleCardId: string | null
}

function buildPersistedServiceSlotStates(
  game: GameState,
  player: Player,
): PersistedServiceSlotState[] {
  return buildServiceSlots(game, player).map(serviceSlot => {
    const defaultSelectedCityIds =
      serviceSlot.isDisconnected
        ? []
        : serviceSlot.slotIndex === 0
          ? serviceSlot.serviceGroup.cityIds
          : []

    return {
      corridorId: serviceSlot.corridorId,
      slotIndex: serviceSlot.slotIndex,
      mode: serviceSlot.serviceGroup.mode,
      isDisconnected: serviceSlot.isDisconnected,
      availableCityIds: serviceSlot.serviceGroup.cityIds,
      selectedCityIds: normalizeSelectedCityIds(
        serviceSlot.serviceGroup.cityIds,
        game.bureaucracyServiceCityIdsByRouteId[serviceSlot.id] ?? defaultSelectedCityIds,
      ),
      assignedVehicleCardId: game.bureaucracyVehicleCardIdsByRouteId[serviceSlot.id] ?? null,
    }
  })
}

export function migrateBureaucracyServiceState(
  previousGame: GameState,
  nextGame: GameState,
) {
  const bureaucracyServiceSlotCountsByCorridorId: Record<string, number> = {}
  const bureaucracyServiceCityIdsByRouteId: Record<string, string[]> = {}
  const bureaucracyVehicleCardIdsByRouteId: Record<string, string> = {}

  for (const nextPlayer of nextGame.players) {
    const previousPlayer = previousGame.players.find(player => player.id === nextPlayer.id)

    if (!previousPlayer) {
      continue
    }

    const previousSlotStates = buildPersistedServiceSlotStates(previousGame, previousPlayer)
    const nextServiceGroups = buildOwnedServiceGroups(nextGame, nextPlayer)

    for (const nextServiceGroup of nextServiceGroups) {
      const matchingPreviousSlotGroups = Array.from(
        previousSlotStates
          .filter(
            slot =>
              slot.mode === nextServiceGroup.mode &&
              slot.availableCityIds.some(cityId => nextServiceGroup.cityIds.includes(cityId)),
          )
          .reduce((groups, slot) => {
            const currentGroup = groups.get(slot.corridorId) ?? []
            currentGroup.push(slot)
            groups.set(slot.corridorId, currentGroup)
            return groups
          }, new Map<string, PersistedServiceSlotState[]>()),
      )
      const matchingPreviousSlots =
        matchingPreviousSlotGroups
          .sort(([, slotGroupA], [, slotGroupB]) => {
            const overlapA = new Set(slotGroupA.flatMap(slot => slot.availableCityIds))
            const overlapB = new Set(slotGroupB.flatMap(slot => slot.availableCityIds))
            const overlapScoreA = nextServiceGroup.cityIds.filter(cityId => overlapA.has(cityId)).length
            const overlapScoreB = nextServiceGroup.cityIds.filter(cityId => overlapB.has(cityId)).length

            if (overlapScoreA !== overlapScoreB) {
              return overlapScoreB - overlapScoreA
            }

            return slotGroupA[0]?.corridorId.localeCompare(slotGroupB[0]?.corridorId ?? "") ?? 0
          })[0]?.[1]
          ?.sort((slotA, slotB) => slotA.slotIndex - slotB.slotIndex) ?? []

      if (matchingPreviousSlots.length === 0) {
        continue
      }

      const corridorSegmentPairs = nextServiceGroup.routes.map(
        route => [route.cityA, route.cityB] as [string, string],
      )
      const migratedSlots = matchingPreviousSlots
        .filter(slot => !slot.isDisconnected)
        .map(slot => ({
        selectedCityIds: slot.selectedCityIds.filter(cityId =>
          nextServiceGroup.cityIds.includes(cityId),
        ),
        assignedVehicleCardId: slot.assignedVehicleCardId,
        }))
      const migratedDisconnectedCityIds =
        matchingPreviousSlots
          .find(slot => slot.isDisconnected)
          ?.selectedCityIds.filter(cityId => nextServiceGroup.cityIds.includes(cityId)) ?? []
      const assignedCityIds = new Set(
        [...migratedSlots.flatMap(slot => slot.selectedCityIds), ...migratedDisconnectedCityIds],
      )

      for (const cityId of nextServiceGroup.cityIds) {
        if (assignedCityIds.has(cityId)) {
          continue
        }

        const firstLegalSlot =
          migratedSlots.find(slot =>
            isValidServicePodSelection(
              [...slot.selectedCityIds, cityId],
              corridorSegmentPairs,
            ),
          ) ?? migratedSlots[0]

        firstLegalSlot.selectedCityIds = [...firstLegalSlot.selectedCityIds, cityId]
        assignedCityIds.add(cityId)
      }

      bureaucracyServiceSlotCountsByCorridorId[nextServiceGroup.id] = Math.max(
        1,
        migratedSlots.length,
      )

      migratedSlots.forEach((slot, slotIndex) => {
        const nextSlotId = buildServiceSlotId(nextServiceGroup.id, slotIndex)
        bureaucracyServiceCityIdsByRouteId[nextSlotId] = slot.selectedCityIds

        if (slot.assignedVehicleCardId) {
          bureaucracyVehicleCardIdsByRouteId[nextSlotId] = slot.assignedVehicleCardId
        }
      })

      bureaucracyServiceCityIdsByRouteId[buildDisconnectedServiceSlotId(nextServiceGroup.id)] =
        migratedDisconnectedCityIds
    }
  }

  return {
    bureaucracyServiceSlotCountsByCorridorId,
    bureaucracyServiceCityIdsByRouteId,
    bureaucracyVehicleCardIdsByRouteId,
  }
}

function getFuelCostPerRealUnit(game: GameState, resource: PurchasableResource) {
  return (
    game.operatingConfig.fuelPricePerRealUnit[resource] *
    getFuelPriceMultiplier(game, resource)
  )
}

function calculateServiceGroupTripSummary(
  game: GameState,
  serviceGroup: ServiceGroup,
  vehicleCard: VehicleCard,
) {
  if (serviceGroup.routes.length === 1) {
    return calculateRouteTripsPerWeek(game, serviceGroup.routes[0], vehicleCard)
  }

  const segmentSummaries = serviceGroup.routes
    .map(route => calculateRouteTripsPerWeek(game, route, vehicleCard))
    .filter(summary => summary !== null)

  if (segmentSummaries.length !== serviceGroup.routes.length || segmentSummaries.length === 0) {
    return null
  }

  const totalDistanceMiles = segmentSummaries.reduce(
    (total, summary) => total + summary.distanceMiles,
    0,
  )
  const totalTripDurationHours = segmentSummaries.reduce(
    (total, summary) => total + summary.tripDurationHours,
    0,
  )
  const tripsPerWeek = totalTripDurationHours <= 0
    ? 0
    : Math.floor(
        (game.operatingConfig.hoursPerDay *
          game.operatingConfig.daysPerWeek *
          game.operatingConfig.weeksPerPeriod) /
          totalTripDurationHours,
      )
  const fuelResource = segmentSummaries[0].fuelResource
  const fuelBurnUnit = segmentSummaries[0].fuelBurnUnit
  const tripFuelBurn = segmentSummaries.reduce(
    (total, summary) => total + summary.tripFuelBurn,
    0,
  )

  return {
    distanceMiles: totalDistanceMiles,
    tripDurationHours: totalTripDurationHours,
    tripsPerWeek,
    fuelResource,
    fuelBurnUnit,
    tripFuelBurn,
    weeklyFuelBurn: tripFuelBurn * tripsPerWeek,
    tripFuelUnits:
      fuelResource === null
        ? 0
        : segmentSummaries.reduce((total, summary) => total + summary.tripFuelUnits, 0),
  }
}

export function buildPlayerBureaucracySummary(
  game: GameState,
  playerId: string,
): PlayerBureaucracySummary | null {
  const player = game.players.find(candidate => candidate.id === playerId)

  if (!player) {
    return null
  }

  const ownedCards = getOwnedVehicleCards(game, player)
  let remainingBudget = player.money
  const remainingOutboundCubesByCityId = new Map<string, number>()
  const remainingInboundCubesByCityId = new Map<string, number>()
  const ensureCityDemandState = (cityId: string) => {
    if (
      remainingOutboundCubesByCityId.has(cityId) &&
      remainingInboundCubesByCityId.has(cityId)
    ) {
      return
    }

    const city = game.cities.find(candidate => candidate.id === cityId)

    remainingOutboundCubesByCityId.set(
      cityId,
      city ? Math.max(0, getCityDemandSize(game, city)) : 0,
    )
    remainingInboundCubesByCityId.set(
      cityId,
      city ? getCityDemandAbsorptionSize(game, city) : 1,
    )
  }

  const routePlans = assignVehicleCardsToServiceGroups(game, player, ownedCards)
    .map((assignment, originalIndex) => ({
      ...assignment,
      originalIndex,
    }))
    .sort((assignmentA, assignmentB) => {
      const priorityDifference =
        getBureaucracyPlanningPriority(assignmentA.serviceSlot.serviceGroup.mode) -
        getBureaucracyPlanningPriority(assignmentB.serviceSlot.serviceGroup.mode)

      if (priorityDifference !== 0) {
        return priorityDifference
      }

      const cityCountDifference =
        assignmentA.serviceSlot.serviceGroup.cityIds.length -
        assignmentB.serviceSlot.serviceGroup.cityIds.length

      if (cityCountDifference !== 0) {
        return cityCountDifference
      }

      return assignmentA.originalIndex - assignmentB.originalIndex
    })
    .map(({ serviceSlot, vehicleCard, originalIndex }) => {
      const { serviceGroup } = serviceSlot
      const route = serviceGroup.routes[0]
      const defaultSelectedCityIds =
        serviceSlot.isDisconnected ? [] : serviceSlot.slotIndex === 0 ? serviceGroup.cityIds : []
      const selectedCityIds = normalizeSelectedCityIds(
        serviceGroup.cityIds,
        game.bureaucracyServiceCityIdsByRouteId[serviceSlot.id] ?? defaultSelectedCityIds,
      )
      const activeRoutes =
        !serviceSlot.isDisconnected && selectedCityIds.length >= 2
          ? serviceGroup.routes.filter(
              candidate =>
                selectedCityIds.includes(candidate.cityA) &&
                selectedCityIds.includes(candidate.cityB),
            )
          : []
      const activeServiceGroup: ServiceGroup = {
        ...serviceGroup,
        routes: activeRoutes,
        cityIds: selectedCityIds,
      }
      selectedCityIds.forEach(ensureCityDemandState)
      const statsVehicleCard =
        vehicleCard ??
        ownedCards.find(card => card.type === getVehicleTypeForRouteMode(route.mode)) ??
        null
      const requestedFuelUnitsOverride = game.bureaucracyFuelUnitsByRouteId[serviceSlot.id]
      const routeTripSummary =
        serviceSlot.isDisconnected || vehicleCard === null || activeRoutes.length === 0
          ? null
          : calculateServiceGroupTripSummary(game, activeServiceGroup, vehicleCard)
      const statsRouteTripSummary =
        serviceSlot.isDisconnected || statsVehicleCard === null || activeRoutes.length === 0
          ? null
          : calculateServiceGroupTripSummary(game, activeServiceGroup, statsVehicleCard)
      const cubeTransferDemand = buildCubeTransferDemand(game, selectedCityIds, {
        outboundCubesByCityId: remainingOutboundCubesByCityId,
        inboundCubesByCityId: remainingInboundCubesByCityId,
      })
      const routeDemandCubes = cubeTransferDemand.movableDemandCubes
      const statsCubeCapacityPerTrip = getCubeCapacityPerTrip(game, statsVehicleCard)
      const vehicleCubeCapacityPerTrip = getCubeCapacityPerTrip(game, vehicleCard)
      const fuelCostPerTrip =
        routeTripSummary?.fuelResource === null || routeTripSummary === null
          ? 0
          : routeTripSummary.tripFuelBurn *
            getFuelCostPerRealUnit(game, routeTripSummary.fuelResource)
      const balanceAdjustmentPerTrip =
        vehicleCard === null ? 0 : getBalanceAdjustmentPerTrip(game, route)
      const maxTripsPerVehicle = routeTripSummary?.tripsPerWeek ?? 0
      const demandFleetSize =
        vehicleCard === null ||
        routeDemandCubes <= 0 ||
        vehicleCubeCapacityPerTrip <= 0 ||
        maxTripsPerVehicle <= 0
          ? 0
          : Math.max(
              1,
              Math.ceil(
                routeDemandCubes /
                  Math.max(vehicleCubeCapacityPerTrip * maxTripsPerVehicle, 1),
              ),
            )
      const ownedFleetSize =
        vehicleCard === null ? 0 : getOwnedVehicleCountForCard(player, vehicleCard.id)
      const weeklyMaintenanceCostPerVehicle =
        vehicleCard === null ? 0 : getWeeklyMaintenanceCostForCard(game, vehicleCard, 1)
      const crewCostPerTrip =
        vehicleCard === null || routeTripSummary === null
          ? 0
          : getCrewCostForTrips(game, vehicleCard.type, routeTripSummary.tripDurationHours, 1)
      const fixedWeeklyCostPerVehicle = weeklyMaintenanceCostPerVehicle
      const variableTripCost = balanceAdjustmentPerTrip + fuelCostPerTrip + crewCostPerTrip
      const selectedFleetSize =
        vehicleCard === null || routeDemandCubes <= 0
          ? 0
          : getAffordableFleetSize({
              targetFleetSize: Math.min(demandFleetSize, ownedFleetSize),
              availableBudget: remainingBudget,
              fixedCostPerVehicle: fixedWeeklyCostPerVehicle,
              variableTripCost,
              maxTrips: maxTripsPerVehicle,
            })
      const maxUsefulTripsByDemand =
        selectedFleetSize <= 0 || vehicleCubeCapacityPerTrip <= 0
          ? 0
          : Math.ceil(
              routeDemandCubes /
                Math.max(vehicleCubeCapacityPerTrip, 1),
            )
      const maxTripsByTime =
        selectedFleetSize <= 0 ? 0 : maxTripsPerVehicle * selectedFleetSize
      const defaultFuelUnits =
        routeTripSummary?.fuelResource === null || routeTripSummary === null
          ? 0
          : Math.ceil(
              routeTripSummary.tripFuelUnits *
                Math.min(maxTripsByTime, maxUsefulTripsByDemand),
            )
      const maxFuelUnitsByTime =
        routeTripSummary?.fuelResource === null || routeTripSummary === null
          ? 0
          : Math.ceil(
              routeTripSummary.tripFuelUnits *
                Math.min(maxTripsByTime, maxUsefulTripsByDemand),
            )
      const cappedFuelUnits =
        routeTripSummary === null || routeTripSummary.fuelResource === null
          ? 0
          : Math.min(
              Math.max(
                0,
                requestedFuelUnitsOverride === undefined
                  ? defaultFuelUnits
                  : requestedFuelUnitsOverride,
              ),
              maxFuelUnitsByTime,
            )
      const weeklyMaintenanceCost =
        vehicleCard === null
          ? 0
          : getWeeklyMaintenanceCostForCard(game, vehicleCard, selectedFleetSize)
      const fixedWeeklyCost = weeklyMaintenanceCost
      const maxTripsByBudget =
        routeTripSummary === null || selectedFleetSize === 0
          ? 0
          : variableTripCost <= 0
            ? remainingBudget >= fixedWeeklyCost
              ? maxTripsByTime
              : 0
            : Math.max(
                0,
                Math.floor(
                  (remainingBudget - fixedWeeklyCost + 1e-9) /
                    Math.max(variableTripCost, 0.000001),
                ),
              )
      const selectedTrips =
        routeTripSummary === null
          ? 0
          : routeTripSummary.fuelResource === null
            ? Math.min(maxTripsByTime, maxTripsByBudget, maxUsefulTripsByDemand)
            : Math.min(
                maxTripsByTime,
                maxTripsByBudget,
                maxUsefulTripsByDemand,
                Math.floor(
                  (cappedFuelUnits + 1e-9) /
                    Math.max(routeTripSummary.tripFuelUnits, 0.000001),
                ),
              )
      const selectedFuelUnits =
        routeTripSummary?.fuelResource === null || routeTripSummary === null
          ? 0
          : Math.ceil(routeTripSummary.tripFuelUnits * selectedTrips)
      const movedCubes =
        selectedFleetSize <= 0 || vehicleCubeCapacityPerTrip <= 0
          ? 0
          : Math.min(routeDemandCubes, selectedTrips * vehicleCubeCapacityPerTrip)
      const passengersPerTrip =
        statsVehicleCard === null
          ? 0
          : statsVehicleCard.totalPassengerCapacity *
            Math.max(selectedFleetSize, vehicleCard ? 1 : Math.min(demandFleetSize, 1))
      const passengersServed =
        vehicleCard === null || selectedFleetSize === 0
          ? 0
          : Math.min(
              selectedTrips * vehicleCard.totalPassengerCapacity,
              movedCubes * game.operatingConfig.passengersPerDemandPoint,
            )
      const simplifiedFlowPlan = buildSimplifiedFlowPlan(
        game,
        selectedCityIds,
        activeRoutes,
        cubeTransferDemand.cityCubeDemands,
        movedCubes,
        passengersServed,
      )
      const movedOutboundByCityId = simplifiedFlowPlan.ledgerEntries.reduce(
        (totals, entry) => {
          totals.set(
            entry.originCityId,
            (totals.get(entry.originCityId) ?? 0) + entry.cubeCount,
          )
          return totals
        },
        new Map<string, number>(),
      )

      simplifiedFlowPlan.cityStatuses.forEach(cityStatus => {
        ensureCityDemandState(cityStatus.cityId)
        remainingOutboundCubesByCityId.set(
          cityStatus.cityId,
          Math.max(
            0,
            (remainingOutboundCubesByCityId.get(cityStatus.cityId) ?? 0) -
              (movedOutboundByCityId.get(cityStatus.cityId) ?? 0),
          ),
        )
        remainingInboundCubesByCityId.set(
          cityStatus.cityId,
          Math.max(
            0,
            (remainingInboundCubesByCityId.get(cityStatus.cityId) ?? 0) -
              cityStatus.filledCubes,
          ),
        )
      })
      const revenue = simplifiedFlowPlan.totalPayout
      const totalFuelBurnReal = routeTripSummary?.fuelResource
        ? routeTripSummary.tripFuelBurn * selectedTrips
        : 0
      const crewCost =
        vehicleCard === null || selectedTrips <= 0 || routeTripSummary === null
          ? 0
          : getCrewCostForTrips(
              game,
              vehicleCard.type,
              routeTripSummary.tripDurationHours,
              selectedTrips,
            )
      const maintenanceCost = selectedTrips > 0 ? weeklyMaintenanceCost : 0
      const balanceAdjustmentCost = selectedTrips * balanceAdjustmentPerTrip
      const fuelCost = totalFuelBurnReal
        ? totalFuelBurnReal * getFuelCostPerRealUnit(game, routeTripSummary!.fuelResource!)
        : 0
      const baseOperatingCost = crewCost + maintenanceCost + balanceAdjustmentCost
      const operatingCost = baseOperatingCost + fuelCost
      remainingBudget = Math.max(0, remainingBudget - operatingCost)

      return {
        originalIndex,
        id: serviceSlot.id,
        corridorId: serviceSlot.corridorId,
        slotIndex: serviceSlot.slotIndex,
        isDisconnected: serviceSlot.isDisconnected,
        routes: activeRoutes,
        corridorSegmentPairs: serviceGroup.routes.map(route => [route.cityA, route.cityB] as [string, string]),
        route,
        serviceLabel:
          serviceSlot.isDisconnected
            ? "Disconnected route"
            : selectedCityIds.length >= 2
            ? selectedCityIds.map(cityId => getCityName(game, cityId)).join(" - ")
            : `${serviceGroup.cityIds.map(cityId => getCityName(game, cityId)).join(" - ")} (select cities)`,
        cityAName: getCityName(game, route.cityA),
        cityBName: getCityName(game, route.cityB),
        cityIds: selectedCityIds,
        availableCityIds: serviceGroup.cityIds,
        selectedCityIds,
        cityCubeDemands: cubeTransferDemand.cityCubeDemands,
        segmentCount: activeRoutes.length,
        canAddSplitService: serviceSlot.canAddSplitService,
        combinedDemand: routeDemandCubes,
        populationPerMile: (() => {
          const dist = statsRouteTripSummary?.distanceMiles ?? null
          if (!dist || dist <= 0 || selectedCityIds.length < 2) return null
          const totalPop = selectedCityIds.reduce((sum, cityId) => {
            const city = game.cities.find(c => c.id === cityId)
            return sum + (city?.population ?? 0)
          }, 0)
          return totalPop / dist
        })(),
        totalOutboundCubes: cubeTransferDemand.totalOutboundCubes,
        totalInboundCubes: cubeTransferDemand.totalInboundCubes,
        cubeCapacityPerTrip: statsCubeCapacityPerTrip,
        movableDemandCubes: routeDemandCubes,
        movedCubes,
        vehicleCard,
        demandFleetSize,
        selectedFleetSize,
        statsFuelResource: statsRouteTripSummary?.fuelResource ?? null,
        statsFuelBurnUnit: statsRouteTripSummary?.fuelBurnUnit ?? null,
        distanceMiles: statsRouteTripSummary?.distanceMiles ?? null,
        maxTripsByTime: Math.min(
          (statsRouteTripSummary?.tripsPerWeek ?? 0) *
            Math.max(selectedFleetSize, vehicleCard ? 1 : Math.min(demandFleetSize, 1)),
          statsCubeCapacityPerTrip <= 0 || routeDemandCubes <= 0
            ? 0
            : Math.ceil(routeDemandCubes / statsCubeCapacityPerTrip),
        ),
        maxFuelUnitsByTime,
        weeklyFuelBurnReal: (statsRouteTripSummary?.weeklyFuelBurn ?? 0) * selectedFleetSize,
        weeklyFuelBurnUnits: statsRouteTripSummary?.fuelResource
          ? Math.ceil(
              statsRouteTripSummary.tripFuelUnits *
                statsRouteTripSummary.tripsPerWeek *
                selectedFleetSize,
            )
          : 0,
        selectedFuelUnits,
        selectedTrips,
        passengersPerTrip,
        passengersServed,
        simplifiedPayoutMultiplier: simplifiedFlowPlan.totalPayoutMultiplier,
        simplifiedCityStatuses: simplifiedFlowPlan.cityStatuses,
        simplifiedLedgerEntries: simplifiedFlowPlan.ledgerEntries,
        fuelResource: routeTripSummary?.fuelResource ?? null,
        fuelBurnUnit: routeTripSummary?.fuelBurnUnit ?? null,
        tripFuelBurnReal: routeTripSummary?.tripFuelBurn ?? 0,
        tripFuelBurnUnits: routeTripSummary?.tripFuelUnits ?? 0,
        totalFuelBurnReal,
        totalFuelBurnUnits: selectedFuelUnits,
        crewCost,
        maintenanceCost,
        balanceAdjustmentCost,
        fuelCost,
        baseOperatingCost,
        revenue,
        operatingCost,
        netRevenue: revenue - operatingCost,
      }
    })
    .sort((planA, planB) => planA.originalIndex - planB.originalIndex)
    .map(({ originalIndex: _originalIndex, ...plan }) => plan)

  const fuelUsedUnits: Record<PurchasableResource, number> = {
    diesel: 0,
    jetFuel: 0,
  }

  for (const plan of routePlans) {
    if (plan.fuelResource) {
      fuelUsedUnits[plan.fuelResource] += plan.totalFuelBurnUnits
    }
  }

  const fuelUsedReal: Record<PurchasableResource, number> = {
    diesel: calculateRealFuelFromUnits(fuelUsedUnits.diesel, "diesel", game),
    jetFuel: calculateRealFuelFromUnits(fuelUsedUnits.jetFuel, "jetFuel", game),
  }
  const passengersServedByMode = createEmptyRouteModeBreakdown()
  const podCountByMode = createEmptyRouteModeBreakdown()

  const fuelRemainingUnits: Record<PurchasableResource, number> = {
    diesel: 0,
    jetFuel: 0,
  }

  const fuelRemainingReal: Record<PurchasableResource, number> = {
    diesel: calculateRealFuelFromUnits(fuelRemainingUnits.diesel, "diesel", game),
    jetFuel: calculateRealFuelFromUnits(fuelRemainingUnits.jetFuel, "jetFuel", game),
  }

  for (const plan of routePlans) {
    const mode = plan.route.mode
    passengersServedByMode[mode] += plan.passengersServed

    if (
      !plan.isDisconnected &&
      plan.vehicleCard !== null &&
      plan.selectedCityIds.length >= 2 &&
      plan.routes.length > 0
    ) {
      podCountByMode[mode] += 1
    }
  }

  return {
    player,
    routePlans,
    passengersServedByMode,
    podCountByMode,
    fuelUsedUnits,
    fuelUsedReal,
    fuelRemainingUnits,
    fuelRemainingReal,
    totalCrewCost: routePlans.reduce((total, plan) => total + plan.crewCost, 0),
    totalMaintenanceCost: routePlans.reduce((total, plan) => total + plan.maintenanceCost, 0),
    totalBalanceAdjustmentCost: routePlans.reduce(
      (total, plan) => total + plan.balanceAdjustmentCost,
      0,
    ),
    totalFuelCost: routePlans.reduce((total, plan) => total + plan.fuelCost, 0),
    totalPassengersServed: routePlans.reduce(
      (total, plan) => total + plan.passengersServed,
      0,
    ),
    totalRevenue: routePlans.reduce((total, plan) => total + plan.revenue, 0),
    totalOperatingCost: routePlans.reduce(
      (total, plan) => total + plan.operatingCost,
      0,
    ),
    netRevenue: routePlans.reduce((total, plan) => total + plan.netRevenue, 0),
  }
}

export function buildBureaucracySummaries(game: GameState) {
  return game.players
    .map(player => buildPlayerBureaucracySummary(game, player.id))
    .filter((summary): summary is PlayerBureaucracySummary => summary !== null)
}

export function findPlayerBureaucracyPlan(
  game: GameState,
  playerId: string,
  planId: string,
) {
  return buildPlayerBureaucracySummary(game, playerId)?.routePlans.find(plan => plan.id === planId) ?? null
}

export function getMaxFuelUnitsForRoute(game: GameState, routeId: string) {
  const route = game.routes.find(candidate => candidate.id === routeId)

  if (!route?.ownerId) {
    return 0
  }

  const summary = buildPlayerBureaucracySummary(game, route.ownerId)
  const targetPlan = summary?.routePlans.find(plan => plan.id === routeId)

  if (!summary || !targetPlan || !targetPlan.vehicleCard || !targetPlan.fuelResource) {
    return 0
  }

  return Math.max(0, targetPlan.maxFuelUnitsByTime)
}

export function getMaxFuelUnitsCapacityForPlayer(
  game: GameState,
  playerId: string,
  resource: PurchasableResource,
) {
  const summary = buildPlayerBureaucracySummary(game, playerId)

  if (!summary) {
    return 0
  }

  return summary.routePlans
    .filter(plan => plan.statsFuelResource === resource)
    .reduce((total, plan) => total + plan.weeklyFuelBurnUnits, 0)
}

export function applyBureaucracyFuelConsumption(game: GameState): GameState {
  const summaries = buildBureaucracySummaries(game)

  return {
    ...game,
    bureaucracyFuelUnitsByRouteId: {},
    players: game.players.map(player => {
      const summary = summaries.find(candidate => candidate.player.id === player.id)

      if (!summary) {
        return player
      }

      const nextMoney = player.money + summary.netRevenue

      return {
        ...player,
        money: nextMoney,
        totalPassengersServed:
          player.totalPassengersServed + summary.totalPassengersServed,
        operatingCosts: summary.totalOperatingCost,
        weeklyPayout: summary.totalRevenue,
        lastPeriodPassengersServed: summary.totalPassengersServed,
        periodHistory: [
          ...(player.periodHistory ?? []),
          {
            period: game.currentWeek,
            passengersServed: summary.totalPassengersServed,
            passengersServedByMode: summary.passengersServedByMode,
            podCountByMode: summary.podCountByMode,
            grossRevenue: summary.totalRevenue,
            operatingCosts: summary.totalOperatingCost,
            netRevenue: summary.netRevenue,
            endingCash: nextMoney,
          },
        ],
      }
    }),
  }
}
