import {
  getBalanceAdjustmentPerTrip,
  getCityDemandAbsorptionSize,
  getCityDemandSize,
  getCrewCostForTrips,
  getFuelPriceMultiplier,
  getWeeklyMaintenanceCostForCard,
} from "./economy"
import { debugLog } from "./debugLogger"
import { getImplicitBusRoutes } from "./playerNetwork"
import { getOwnedVehicleCountForCard } from "./playerVehicles"
import {
  calculateFuelUnitsFromReal,
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
  finalDestinationCubeCount: number
  passengers: number
  payoutMultiplier: number
  farePerPassenger: number
  payout: number
  pathCityIds: string[]
  pathLabels: string[]
  mode: RouteMode
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
  stuckCubesByCity: Array<{
    cityId: string
    cityName: string
    stuckCubeCount: number
    wantedDestinations: Array<{ destCityId: string; destCityName: string; cubeCount: number }>
  }>
  outboundIntentByCity: Array<{
    cityId: string
    destinations: Array<{ destCityId: string; destCityName: string; cubeCount: number }>
  }>
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


// ========================
// NEW BUREAUCRACY ENGINE
// ========================

const WORKING_HOURS_PER_WEEK_BY_TYPE: Record<VehicleType, number> = {
  bus: 60,
  train: 80,
  air: 70,
}

const BASE_FUEL_BURN_PER_HOUR_LOCAL: Record<VehicleType, number> = {
  air: 6000,
  train: 100,
  bus: 10,
}

const FUEL_RESOURCE_BY_TYPE_LOCAL: Record<VehicleType, PurchasableResource> = {
  air: "jetFuel",
  train: "diesel",
  bus: "diesel",
}

const FUEL_BURN_UNIT_BY_TYPE_LOCAL: Record<VehicleType, FuelBurnUnit> = {
  air: "pounds",
  train: "gallons",
  bus: "gallons",
}

type NetworkGraph = Map<string, Set<string>>
type NextHopTable = Map<string, Map<string, string | null>>
// cityId -> destCityId -> cubeCount (cubes at cityId wanting to go to destCityId)
type CubeState = Map<string, Map<string, number>>

type SegmentWeekResult = {
  cityAId: string
  cityBId: string
  distanceMiles: number
  cubesAtoB: number
  cubesBtoA: number
  cubesAtoBFinal: number
  cubesBtoAFinal: number
  tripsRun: number
}

type PodWeekResult = {
  serviceSlotId: string
  mode: RouteMode
  segments: SegmentWeekResult[]
}

type PodSimInput = {
  serviceSlotId: string
  vehicleCard: VehicleCard
  mode: RouteMode
  fleetSize: number
  activeSegments: Array<{ cityA: string; cityB: string; distanceMiles: number }>
}

function buildPlayerNetworkGraph(game: GameState, player: Player): NetworkGraph {
  const graph: NetworkGraph = new Map()
  const addEdge = (a: string, b: string) => {
    if (!graph.has(a)) graph.set(a, new Set())
    if (!graph.has(b)) graph.set(b, new Set())
    graph.get(a)!.add(b)
    graph.get(b)!.add(a)
  }
  for (const route of [
    ...game.routes.filter(r => r.ownerId === player.id),
    ...getImplicitBusRoutes(game, player),
  ]) {
    addEdge(route.cityA, route.cityB)
  }
  return graph
}

function getNetworkComponents(graph: NetworkGraph): string[][] {
  const visited = new Set<string>()
  const components: string[][] = []
  for (const cityId of graph.keys()) {
    if (visited.has(cityId)) continue
    const component: string[] = []
    const queue = [cityId]
    while (queue.length > 0) {
      const cur = queue.shift()!
      if (visited.has(cur)) continue
      visited.add(cur)
      component.push(cur)
      for (const nb of graph.get(cur) ?? []) {
        if (!visited.has(nb)) queue.push(nb)
      }
    }
    components.push(component)
  }
  return components
}

function buildNextHopTable(graph: NetworkGraph, cityIds: string[]): NextHopTable {
  const table: NextHopTable = new Map()
  for (const start of cityIds) {
    const hopMap = new Map<string, string | null>()
    const visited = new Set([start])
    const queue: Array<{ city: string; firstHop: string }> = []
    for (const nb of graph.get(start) ?? []) {
      if (!visited.has(nb)) {
        visited.add(nb)
        queue.push({ city: nb, firstHop: nb })
      }
    }
    while (queue.length > 0) {
      const { city, firstHop } = queue.shift()!
      hopMap.set(city, firstHop)
      for (const nb of graph.get(city) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb)
          queue.push({ city: nb, firstHop })
        }
      }
    }
    table.set(start, hopMap)
  }
  return table
}

function buildInitialCubeState(game: GameState, componentCityIds: string[]): CubeState {
  const state: CubeState = new Map()
  for (const srcId of componentCityIds) {
    const srcCity = game.cities.find(c => c.id === srcId)
    if (!srcCity) continue
    const demand = Math.max(0, getCityDemandSize(game, srcCity))
    if (demand <= 0) continue
    const others = componentCityIds.filter(id => id !== srcId)
    const totalPull = others.reduce((s, id) => {
      const city = game.cities.find(c => c.id === id)
      return s + (city?.size ?? 0)
    }, 0)
    if (totalPull <= 0) continue
    const destMap = new Map<string, number>()
    let allocated = 0
    others.forEach((destId, i) => {
      const destCity = game.cities.find(c => c.id === destId)
      const destSize = destCity?.size ?? 0
      const cubes =
        i < others.length - 1
          ? Math.floor((demand * destSize) / totalPull)
          : Math.max(0, demand - allocated)
      if (cubes > 0) destMap.set(destId, cubes)
      allocated += cubes
    })
    if (destMap.size > 0) state.set(srcId, destMap)
  }
  return state
}

function countCubesWantingSegment(
  cubeState: CubeState,
  nextHopTable: NextHopTable,
  fromCity: string,
  toCity: string,
): number {
  const dests = cubeState.get(fromCity)
  if (!dests) return 0
  const hops = nextHopTable.get(fromCity)
  if (!hops) return 0
  let count = 0
  for (const [destId, n] of dests) {
    if (hops.get(destId) === toCity) count += n
  }
  return count
}

function executeMoveCubesOnSegment(
  cubeState: CubeState,
  nextHopTable: NextHopTable,
  fromCity: string,
  toCity: string,
  max: number,
): { total: number; final: number } {
  const dests = cubeState.get(fromCity)
  if (!dests || max <= 0) return { total: 0, final: 0 }
  const hops = nextHopTable.get(fromCity)
  if (!hops) return { total: 0, final: 0 }
  let moved = 0
  let movedFinal = 0
  for (const [destId, n] of [...dests.entries()]) {
    if (moved >= max) break
    if (hops.get(destId) !== toCity) continue
    const take = Math.min(n, max - moved)
    const left = n - take
    if (left <= 0) dests.delete(destId)
    else dests.set(destId, left)
    if (destId !== toCity) {
      // En route — deposit at intermediate city
      if (!cubeState.has(toCity)) cubeState.set(toCity, new Map())
      const arriving = cubeState.get(toCity)!
      arriving.set(destId, (arriving.get(destId) ?? 0) + take)
    } else {
      movedFinal += take
    }
    moved += take
  }
  return { total: moved, final: movedFinal }
}

function runNetworkSimulation(
  game: GameState,
  cubeState: CubeState,
  nextHopTable: NextHopTable,
  sortedPods: PodSimInput[],
): PodWeekResult[][] {
  const weeklyResults: PodWeekResult[][] = []

  for (let week = 0; week < 4; week++) {
    const weekResults: PodWeekResult[] = []
    debugLog("simulation", `── Week ${week + 1} ──────────────────────`)

    for (const pod of sortedPods) {
      const { vehicleCard, fleetSize, activeSegments, serviceSlotId, mode } = pod
      debugLog("simulation", `Pod: ${serviceSlotId} | ${mode} | ${vehicleCard.name} ×${fleetSize}`, {
        activeSegments: activeSegments.map(s => `${s.cityA}→${s.cityB} (${s.distanceMiles.toFixed(0)}mi)`),
      })

      if (activeSegments.length === 0) {
        debugLog("simulation", `  → No active segments, skipping`)
        weekResults.push({ serviceSlotId, mode, segments: [] })
        continue
      }

      const totalWeeklyMiles =
        vehicleCard.speed * WORKING_HOURS_PER_WEEK_BY_TYPE[vehicleCard.type] * fleetSize
      const cubesPerTrip =
        Math.max(
          1,
          Math.ceil(
            vehicleCard.totalPassengerCapacity /
              Math.max(game.operatingConfig.passengersPerDemandPoint, 1),
          ),
        ) * fleetSize

      debugLog("simulation", `  Budget: ${totalWeeklyMiles.toFixed(0)} mi/wk | ${cubesPerTrip} cubes/trip | speed ${vehicleCard.speed}mph`)

      let remainingMiles = totalWeeklyMiles
      const segResults: SegmentWeekResult[] = []

      const segsWithDemand = activeSegments
        .map(seg => ({
          ...seg,
          demandAtoB: countCubesWantingSegment(cubeState, nextHopTable, seg.cityA, seg.cityB),
          demandBtoA: countCubesWantingSegment(cubeState, nextHopTable, seg.cityB, seg.cityA),
        }))
        .sort((a, b) => b.demandAtoB + b.demandBtoA - (a.demandAtoB + a.demandBtoA))

      for (const seg of segsWithDemand) {
        const totalDemand = seg.demandAtoB + seg.demandBtoA
        if (totalDemand <= 0 || seg.distanceMiles <= 0 || remainingMiles < seg.distanceMiles) {
          debugLog("simulation", `  Seg ${seg.cityA}↔${seg.cityB}: skipped (demand=${totalDemand} remaining=${remainingMiles.toFixed(0)}mi dist=${seg.distanceMiles.toFixed(0)}mi)`)
          continue
        }
        const maxTripsFromBudget = Math.floor(remainingMiles / seg.distanceMiles)
        const tripsNeeded = Math.ceil(totalDemand / cubesPerTrip)
        const tripsRun = Math.min(maxTripsFromBudget, tripsNeeded)
        if (tripsRun <= 0) continue

        const totalMovable = Math.min(totalDemand, tripsRun * cubesPerTrip)
        const cubesAtoBTarget =
          totalDemand > 0 ? Math.round((seg.demandAtoB / totalDemand) * totalMovable) : 0
        const cubesBtoATarget = totalMovable - cubesAtoBTarget

        const resultAtoB = executeMoveCubesOnSegment(
          cubeState, nextHopTable, seg.cityA, seg.cityB, cubesAtoBTarget,
        )
        const resultBtoA = executeMoveCubesOnSegment(
          cubeState, nextHopTable, seg.cityB, seg.cityA, cubesBtoATarget,
        )

        debugLog("simulation", `  Seg ${seg.cityA}↔${seg.cityB}: demand A→B=${seg.demandAtoB} B→A=${seg.demandBtoA} | maxTrips=${maxTripsFromBudget} needed=${tripsNeeded} run=${tripsRun} | moved A→B=${resultAtoB.total}(${resultAtoB.final} final) B→A=${resultBtoA.total}(${resultBtoA.final} final)`)

        remainingMiles -= tripsRun * seg.distanceMiles
        segResults.push({
          cityAId: seg.cityA,
          cityBId: seg.cityB,
          distanceMiles: seg.distanceMiles,
          cubesAtoB: resultAtoB.total,
          cubesBtoA: resultBtoA.total,
          cubesAtoBFinal: resultAtoB.final,
          cubesBtoAFinal: resultBtoA.final,
          tripsRun,
        })
      }

      weekResults.push({ serviceSlotId, mode, segments: segResults })
    }

    weeklyResults.push(weekResults)
  }

  return weeklyResults
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

const PAYOUT_DOLLARS_PER_WEIGHT = 22.5

export function getPayoutFarePerPassengerForDistance(distanceMiles: number) {
  return getPayoutMultiplierForDistance(distanceMiles) * PAYOUT_DOLLARS_PER_WEIGHT
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

    const storedCityIds = game.bureaucracyServiceCityIdsByRouteId[serviceSlot.id]
    const isSmallNetwork = serviceSlot.serviceGroup.cityIds.length === 2
    // For 2-city networks: slot 0 always auto-assigns both cities when they're all
    // sitting in DISCONNECTED (i.e. the stored disconnected list has both).
    let effectiveCityIds = storedCityIds ?? defaultSelectedCityIds
    if (isSmallNetwork) {
      if (!serviceSlot.isDisconnected && serviceSlot.slotIndex === 0 && (storedCityIds === undefined || storedCityIds.length === 0)) {
        const discId = buildDisconnectedServiceSlotId(serviceSlot.corridorId)
        const discCities = game.bureaucracyServiceCityIdsByRouteId[discId]
        if (!discCities || discCities.length >= serviceSlot.serviceGroup.cityIds.length) {
          effectiveCityIds = [...serviceSlot.serviceGroup.cityIds]
        }
      }
      if (serviceSlot.isDisconnected) {
        // If slot 0 is going to auto-fill both cities, clear the disconnected display
        const slot0Id = buildServiceSlotId(serviceSlot.corridorId, 0)
        const slot0Cities = game.bureaucracyServiceCityIdsByRouteId[slot0Id]
        const discCities = storedCityIds
        if ((!slot0Cities || slot0Cities.length === 0) && (!discCities || discCities.length >= serviceSlot.serviceGroup.cityIds.length)) {
          effectiveCityIds = []
        }
      }
    }

    return {
      corridorId: serviceSlot.corridorId,
      slotIndex: serviceSlot.slotIndex,
      mode: serviceSlot.serviceGroup.mode,
      isDisconnected: serviceSlot.isDisconnected,
      availableCityIds: serviceSlot.serviceGroup.cityIds,
      selectedCityIds: normalizeSelectedCityIds(
        serviceSlot.serviceGroup.cityIds,
        effectiveCityIds,
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
        // Brand-new corridor with no previous state.
        if (nextGame.currentWeek > 1) {
          const nextSlotId = buildServiceSlotId(nextServiceGroup.id, 0)
          bureaucracyServiceSlotCountsByCorridorId[nextServiceGroup.id] = 1
          if (nextServiceGroup.cityIds.length === 2) {
            // 2-city networks: auto-assign both cities to slot 0
            bureaucracyServiceCityIdsByRouteId[nextSlotId] = [...nextServiceGroup.cityIds]
            bureaucracyServiceCityIdsByRouteId[buildDisconnectedServiceSlotId(nextServiceGroup.id)] = []
          } else {
            // After round 1, explicitly store an empty slot so the UI doesn't auto-populate it.
            bureaucracyServiceCityIdsByRouteId[nextSlotId] = []
            bureaucracyServiceCityIdsByRouteId[buildDisconnectedServiceSlotId(nextServiceGroup.id)] =
              [...nextServiceGroup.cityIds]
          }
        }
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

        // After round 1, new cities always land in disconnected — the player must
        // explicitly drag them into a pod. Only in round 1 do we auto-fill underflow pods.
        const shouldAutoFill = nextGame.currentWeek <= 1
        const underflowSlot = shouldAutoFill
          ? migratedSlots.find(
              slot =>
                slot.selectedCityIds.length < 2 &&
                isValidServicePodSelection(
                  [...slot.selectedCityIds, cityId],
                  corridorSegmentPairs,
                ),
            )
          : undefined

        if (underflowSlot) {
          underflowSlot.selectedCityIds = [...underflowSlot.selectedCityIds, cityId]
        } else {
          migratedDisconnectedCityIds.push(cityId)
        }
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
  if (!player) return null

  const ownedCards = getOwnedVehicleCards(game, player)

  // Build assignments (vehicle cards → service slots)
  const assignments = assignVehicleCardsToServiceGroups(game, player, ownedCards).map(
    (assignment, originalIndex) => ({ ...assignment, originalIndex }),
  )

  // Build player-wide network graph and connected components
  const networkGraph = buildPlayerNetworkGraph(game, player)
  const components = getNetworkComponents(networkGraph)

  // Build shared cube state (passenger demand) and next-hop routing table
  const cubeState: CubeState = new Map()
  const nextHopTable: NextHopTable = new Map()
  for (const component of components) {
    for (const [cityId, destMap] of buildInitialCubeState(game, component)) {
      cubeState.set(cityId, destMap)
    }
    for (const [cityId, hopMap] of buildNextHopTable(networkGraph, component)) {
      nextHopTable.set(cityId, hopMap)
    }
  }

  // Snapshot initial demand per city before simulation runs (city → final-dest → cubes)
  const initialCubesByCity = new Map<string, number>()
  const initialDestsByCityId = new Map<string, Map<string, number>>()
  for (const [cityId, dests] of cubeState) {
    const total = [...dests.values()].reduce((s, n) => s + n, 0)
    if (total > 0) {
      initialCubesByCity.set(cityId, total)
      initialDestsByCityId.set(cityId, new Map(dests))
    }
  }

  debugLog("bureaucracy", `═══ Bureaucracy for ${player.name} ═══`)
  debugLog("bureaucracy", `Initial demand (cubes):`)
  for (const [cityId, total] of initialCubesByCity) {
    const cityName = getCityName(game, cityId)
    const dests = [...(initialDestsByCityId.get(cityId) ?? [])].map(([d, n]) => `${getCityName(game, d)}×${n}`).join(", ")
    debugLog("bureaucracy", `  ${cityName}: ${total} total → [${dests}]`)
  }

  // Sort assignments for simulation priority (air first, then rail, then bus)
  const sortedAssignments = [...assignments].sort((a, b) => {
    const pa = getBureaucracyPlanningPriority(a.serviceSlot.serviceGroup.mode)
    const pb = getBureaucracyPlanningPriority(b.serviceSlot.serviceGroup.mode)
    if (pa !== pb) return pa - pb
    const ca = a.serviceSlot.serviceGroup.cityIds.length
    const cb = b.serviceSlot.serviceGroup.cityIds.length
    if (ca !== cb) return ca - cb
    return a.originalIndex - b.originalIndex
  })

  // Build simulation inputs (active pods with vehicles and ≥2 selected cities)
  const podSimInputs: PodSimInput[] = []
  for (const { serviceSlot, vehicleCard } of sortedAssignments) {
    if (serviceSlot.isDisconnected || vehicleCard === null) {
      debugLog("bureaucracy", `Pod ${serviceSlot.id}: skipped (disconnected=${serviceSlot.isDisconnected} vehicle=${vehicleCard?.name ?? "none"})`)
      continue
    }
    const { serviceGroup } = serviceSlot
    const defaultSelectedCityIds = serviceSlot.slotIndex === 0 ? serviceGroup.cityIds : []
    const selectedCityIds = normalizeSelectedCityIds(
      serviceGroup.cityIds,
      game.bureaucracyServiceCityIdsByRouteId[serviceSlot.id] ?? defaultSelectedCityIds,
    )
    if (selectedCityIds.length < 2) {
      debugLog("bureaucracy", `Pod ${serviceSlot.id}: skipped (<2 selected cities: [${selectedCityIds.join(",")}])`)
      continue
    }
    const activeRoutes = serviceGroup.routes.filter(
      r => selectedCityIds.includes(r.cityA) && selectedCityIds.includes(r.cityB),
    )
    if (activeRoutes.length === 0) {
      debugLog("bureaucracy", `Pod ${serviceSlot.id}: skipped (no active routes for selected cities)`)
      continue
    }
    const fleetSize = getOwnedVehicleCountForCard(player, vehicleCard.id)
    if (fleetSize <= 0) {
      debugLog("bureaucracy", `Pod ${serviceSlot.id}: skipped (fleet size 0)`)
      continue
    }
    debugLog("bureaucracy", `Pod ${serviceSlot.id}: ${serviceGroup.mode} | ${vehicleCard.name} ×${fleetSize} | cities: [${selectedCityIds.join(",")}]`)
    podSimInputs.push({
      serviceSlotId: serviceSlot.id,
      vehicleCard,
      mode: serviceGroup.mode,
      fleetSize,
      activeSegments: activeRoutes.map(route => ({
        cityA: route.cityA,
        cityB: route.cityB,
        distanceMiles: getRouteDistanceMilesFromMap(game, route.cityA, route.cityB),
      })),
    })
  }

  // Run 4-week network simulation (mutates cubeState in place)
  const weeklyResults = runNetworkSimulation(game, cubeState, nextHopTable, podSimInputs)

  // Aggregate segment results across 4 weeks, keyed by serviceSlotId
  type AggSegKey = string
  type AggSegResult = SegmentWeekResult & { key: AggSegKey }
  const aggregatedByPod = new Map<string, Map<AggSegKey, AggSegResult>>()
  for (const weekPodResults of weeklyResults) {
    for (const podResult of weekPodResults) {
      if (!aggregatedByPod.has(podResult.serviceSlotId)) {
        aggregatedByPod.set(podResult.serviceSlotId, new Map())
      }
      const segMap = aggregatedByPod.get(podResult.serviceSlotId)!
      for (const seg of podResult.segments) {
        const key = `${seg.cityAId}:${seg.cityBId}`
        const existing = segMap.get(key)
        if (existing) {
          existing.cubesAtoB += seg.cubesAtoB
          existing.cubesBtoA += seg.cubesBtoA
          existing.cubesAtoBFinal += seg.cubesAtoBFinal
          existing.cubesBtoAFinal += seg.cubesBtoAFinal
          existing.tripsRun += seg.tripsRun
        } else {
          segMap.set(key, { ...seg, key })
        }
      }
    }
  }

  const passengersPerDemandPoint = game.operatingConfig.passengersPerDemandPoint

  const routePlans = assignments
    .sort((a, b) => {
      const pa = getBureaucracyPlanningPriority(a.serviceSlot.serviceGroup.mode)
      const pb = getBureaucracyPlanningPriority(b.serviceSlot.serviceGroup.mode)
      if (pa !== pb) return pa - pb
      const ca = a.serviceSlot.serviceGroup.cityIds.length
      const cb = b.serviceSlot.serviceGroup.cityIds.length
      if (ca !== cb) return ca - cb
      return a.originalIndex - b.originalIndex
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
              r => selectedCityIds.includes(r.cityA) && selectedCityIds.includes(r.cityB),
            )
          : []

      const statsVehicleCard =
        vehicleCard ??
        ownedCards.find(card => card.type === getVehicleTypeForRouteMode(route.mode)) ??
        null
      const activeServiceGroup: ServiceGroup = {
        ...serviceGroup,
        routes: activeRoutes,
        cityIds: selectedCityIds,
      }
      const statsRouteTripSummary =
        serviceSlot.isDisconnected || statsVehicleCard === null || activeRoutes.length === 0
          ? null
          : calculateServiceGroupTripSummary(game, activeServiceGroup, statsVehicleCard)

      const ownedFleetSize =
        vehicleCard === null ? 0 : getOwnedVehicleCountForCard(player, vehicleCard.id)
      const aggSegs = [...(aggregatedByPod.get(serviceSlot.id)?.values() ?? [])]
      const totalTripsRun = aggSegs.reduce((s, seg) => s + seg.tripsRun, 0)
      const totalCubeMoves = aggSegs.reduce(
        (s, seg) => s + seg.cubesAtoB + seg.cubesBtoA, 0,
      )
      const passengersServed = totalCubeMoves * passengersPerDemandPoint

      // Per-city departure counts (for city status fill display)
      const departedByCityId = new Map<string, number>()
      for (const seg of aggSegs) {
        departedByCityId.set(
          seg.cityAId,
          (departedByCityId.get(seg.cityAId) ?? 0) + seg.cubesAtoB,
        )
        departedByCityId.set(
          seg.cityBId,
          (departedByCityId.get(seg.cityBId) ?? 0) + seg.cubesBtoA,
        )
      }

      const cityCubeDemands = selectedCityIds.map(cityId => {
        const city = game.cities.find(c => c.id === cityId)
        return {
          cityId,
          cityName: getCityName(game, cityId),
          outboundCubes:
            initialCubesByCity.get(cityId) ??
            (city ? Math.max(0, getCityDemandSize(game, city)) : 0),
          inboundCubes: city ? getCityDemandAbsorptionSize(game, city) : 1,
        }
      })

      // Build ledger entries: one per segment direction (A→B and B→A)
      const simplifiedLedgerEntries: SimplifiedFlowLedgerEntry[] = []
      for (const seg of aggSegs) {
        const distMiles = seg.distanceMiles
        const multiplier = getPayoutMultiplierForDistance(distMiles)
        const farePerPassenger = getPayoutFarePerPassengerForDistance(distMiles)
        const cityAName = getCityName(game, seg.cityAId)
        const cityBName = getCityName(game, seg.cityBId)

        if (seg.cubesAtoB > 0) {
          const passengers = seg.cubesAtoB * passengersPerDemandPoint
          simplifiedLedgerEntries.push({
            id: `${serviceSlot.id}:${seg.cityAId}:${seg.cityBId}`,
            originCityId: seg.cityAId,
            originCityName: cityAName,
            destinationCityId: seg.cityBId,
            destinationCityName: cityBName,
            cubeCount: seg.cubesAtoB,
            finalDestinationCubeCount: seg.cubesAtoBFinal,
            passengers,
            payoutMultiplier: multiplier,
            farePerPassenger,
            payout: passengers * farePerPassenger,
            pathCityIds: [seg.cityAId, seg.cityBId],
            pathLabels: [
              `${cityAName} -> ${cityBName} (${Math.round(distMiles)}mi x${multiplier} = $${farePerPassenger.toFixed(0)})`,
            ],
            mode: serviceSlot.serviceGroup.mode,
          })
        }
        if (seg.cubesBtoA > 0) {
          const passengers = seg.cubesBtoA * passengersPerDemandPoint
          simplifiedLedgerEntries.push({
            id: `${serviceSlot.id}:${seg.cityBId}:${seg.cityAId}`,
            originCityId: seg.cityBId,
            originCityName: cityBName,
            destinationCityId: seg.cityAId,
            destinationCityName: cityAName,
            cubeCount: seg.cubesBtoA,
            finalDestinationCubeCount: seg.cubesBtoAFinal,
            passengers,
            payoutMultiplier: multiplier,
            farePerPassenger,
            payout: passengers * farePerPassenger,
            pathCityIds: [seg.cityBId, seg.cityAId],
            pathLabels: [
              `${cityBName} -> ${cityAName} (${Math.round(distMiles)}mi x${multiplier} = $${farePerPassenger.toFixed(0)})`,
            ],
            mode: serviceSlot.serviceGroup.mode,
          })
        }
      }

      const simplifiedCityStatuses: SimplifiedFlowCityStatus[] = selectedCityIds.map(cityId => {
        const city = game.cities.find(c => c.id === cityId)
        return {
          cityId,
          cityName: getCityName(game, cityId),
          size: city?.size ?? 0,
          outboundCubes:
            initialCubesByCity.get(cityId) ??
            (city ? Math.max(0, getCityDemandSize(game, city)) : 0),
          inboundCubes: city ? getCityDemandAbsorptionSize(game, city) : 1,
          filledCubes: departedByCityId.get(cityId) ?? 0,
        }
      })

      const revenue = simplifiedLedgerEntries.reduce((s, e) => s + e.payout, 0)

      const isElectricRail =
        vehicleCard?.type === "train" && serviceGroup.railTraction === "electric"

      const fuelResource =
        vehicleCard === null || isElectricRail
          ? null
          : vehicleCard.fuelResource === undefined
            ? FUEL_RESOURCE_BY_TYPE_LOCAL[vehicleCard.type]
            : vehicleCard.fuelResource

      const fuelBurnUnit =
        fuelResource === null || vehicleCard === null
          ? null
          : FUEL_BURN_UNIT_BY_TYPE_LOCAL[vehicleCard.type]

      let crewCost = 0
      let fuelBurnReal = 0
      const balanceAdjustmentPerTrip =
        vehicleCard === null ? 0 : getBalanceAdjustmentPerTrip(game, route)
      let balanceAdjustmentCost = 0

      if (vehicleCard !== null && totalTripsRun > 0) {
        for (const seg of aggSegs) {
          if (seg.tripsRun <= 0) continue
          const tripDurationHours =
            seg.distanceMiles / vehicleCard.speed +
            game.operatingConfig.loadingHours[vehicleCard.type]
          crewCost += getCrewCostForTrips(
            game, vehicleCard.type, tripDurationHours, seg.tripsRun,
          )
          if (fuelResource !== null) {
            fuelBurnReal +=
              tripDurationHours *
              BASE_FUEL_BURN_PER_HOUR_LOCAL[vehicleCard.type] *
              vehicleCard.operatingCostMultiplier *
              seg.tripsRun
          }
          balanceAdjustmentCost += balanceAdjustmentPerTrip * seg.tripsRun
        }
      }

      const maintenanceCost =
        vehicleCard === null || totalTripsRun <= 0
          ? 0
          : getWeeklyMaintenanceCostForCard(game, vehicleCard, ownedFleetSize)

      const fuelCost =
        fuelResource !== null && fuelBurnReal > 0
          ? fuelBurnReal * getFuelCostPerRealUnit(game, fuelResource)
          : 0

      const totalFuelBurnUnits =
        fuelResource !== null && fuelBurnReal > 0
          ? calculateFuelUnitsFromReal(fuelBurnReal, fuelResource, game)
          : 0

      const baseOperatingCost = crewCost + maintenanceCost + balanceAdjustmentCost
      const operatingCost = baseOperatingCost + fuelCost

      const statsFuelResource = statsRouteTripSummary?.fuelResource ?? null
      const statsFuelBurnUnit = statsRouteTripSummary?.fuelBurnUnit ?? null
      const singleTripFuelBurn = statsRouteTripSummary?.tripFuelBurn ?? 0
      const singleTripFuelUnits = statsRouteTripSummary?.tripFuelUnits ?? 0
      const maxFuelUnitsByTime =
        statsFuelResource !== null ? Math.ceil(singleTripFuelUnits * totalTripsRun) : 0
      const selectedFuelUnits = maxFuelUnitsByTime

      const combinedDemand = selectedCityIds.reduce((s, cityId) => {
        const city = game.cities.find(c => c.id === cityId)
        return s + (city ? Math.max(0, getCityDemandSize(game, city)) : 0)
      }, 0)
      const totalInboundCubes = selectedCityIds.reduce((s, cityId) => {
        const city = game.cities.find(c => c.id === cityId)
        return s + (city ? getCityDemandAbsorptionSize(game, city) : 1)
      }, 0)

      return {
        originalIndex,
        id: serviceSlot.id,
        corridorId: serviceSlot.corridorId,
        slotIndex: serviceSlot.slotIndex,
        isDisconnected: serviceSlot.isDisconnected,
        routes: activeRoutes,
        corridorSegmentPairs: serviceGroup.routes.map(
          r => [r.cityA, r.cityB] as [string, string],
        ),
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
        cityCubeDemands,
        segmentCount: activeRoutes.length,
        canAddSplitService: serviceSlot.canAddSplitService,
        combinedDemand,
        populationPerMile: (() => {
          const dist = statsRouteTripSummary?.distanceMiles ?? null
          if (!dist || dist <= 0 || selectedCityIds.length < 2) return null
          const totalPop = selectedCityIds.reduce((sum, cityId) => {
            const city = game.cities.find(c => c.id === cityId)
            return sum + (city?.population ?? 0)
          }, 0)
          return totalPop / dist
        })(),
        totalOutboundCubes: combinedDemand,
        totalInboundCubes,
        cubeCapacityPerTrip: getCubeCapacityPerTrip(game, statsVehicleCard),
        movableDemandCubes: totalCubeMoves,
        movedCubes: totalCubeMoves,
        vehicleCard,
        demandFleetSize: (() => {
          const cubesPerTrip = getCubeCapacityPerTrip(game, statsVehicleCard)
          const tripsPerPeriod = statsRouteTripSummary?.tripsPerWeek ?? 0
          // Each end-to-end trip serves cubes across all segments simultaneously,
          // so effective throughput scales with segment count
          const numSegments = Math.max(1, selectedCityIds.length - 1)
          const cubesPerVehiclePerPeriod = cubesPerTrip * tripsPerPeriod * numSegments
          if (cubesPerVehiclePerPeriod <= 0) return ownedFleetSize
          return Math.max(1, Math.ceil(combinedDemand / cubesPerVehiclePerPeriod))
        })(),
        selectedFleetSize: ownedFleetSize,
        statsFuelResource,
        statsFuelBurnUnit,
        distanceMiles: statsRouteTripSummary?.distanceMiles ?? null,
        maxTripsByTime: statsRouteTripSummary
          ? (statsRouteTripSummary.tripsPerWeek ?? 0) * ownedFleetSize
          : 0,
        maxFuelUnitsByTime,
        weeklyFuelBurnReal: (statsRouteTripSummary?.weeklyFuelBurn ?? 0) * ownedFleetSize,
        weeklyFuelBurnUnits: statsFuelResource
          ? Math.ceil(
              (statsRouteTripSummary?.tripFuelUnits ?? 0) *
                (statsRouteTripSummary?.tripsPerWeek ?? 0) *
                ownedFleetSize,
            )
          : 0,
        selectedFuelUnits,
        selectedTrips: totalTripsRun,
        passengersPerTrip:
          statsVehicleCard === null
            ? 0
            : statsVehicleCard.totalPassengerCapacity * ownedFleetSize,
        passengersServed,
        simplifiedPayoutMultiplier: simplifiedLedgerEntries.reduce(
          (s, e) => s + e.payoutMultiplier * e.cubeCount,
          0,
        ),
        simplifiedCityStatuses,
        simplifiedLedgerEntries,
        fuelResource,
        fuelBurnUnit,
        tripFuelBurnReal: singleTripFuelBurn,
        tripFuelBurnUnits: singleTripFuelUnits,
        totalFuelBurnReal: fuelBurnReal,
        totalFuelBurnUnits,
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
    .map(({ originalIndex: _idx, ...plan }) => plan)

  // Stuck cubes: any cubes remaining in cubeState after all 4 simulation weeks
  const stuckCubesByCity: PlayerBureaucracySummary["stuckCubesByCity"] = []
  for (const [cityId, destMap] of cubeState) {
    if (destMap.size === 0) continue
    const stuckCubeCount = [...destMap.values()].reduce((s, n) => s + n, 0)
    if (stuckCubeCount <= 0) continue
    stuckCubesByCity.push({
      cityId,
      cityName: getCityName(game, cityId),
      stuckCubeCount,
      wantedDestinations: [...destMap.entries()].map(([destId, count]) => ({
        destCityId: destId,
        destCityName: getCityName(game, destId),
        cubeCount: count,
      })),
    })
  }

  const fuelUsedUnits: Record<PurchasableResource, number> = { diesel: 0, jetFuel: 0 }
  for (const plan of routePlans) {
    if (plan.fuelResource) {
      fuelUsedUnits[plan.fuelResource] += plan.totalFuelBurnUnits
    }
  }
  const fuelUsedReal: Record<PurchasableResource, number> = {
    diesel: calculateRealFuelFromUnits(fuelUsedUnits.diesel, "diesel", game),
    jetFuel: calculateRealFuelFromUnits(fuelUsedUnits.jetFuel, "jetFuel", game),
  }
  const fuelRemainingUnits: Record<PurchasableResource, number> = { diesel: 0, jetFuel: 0 }
  const fuelRemainingReal: Record<PurchasableResource, number> = {
    diesel: calculateRealFuelFromUnits(fuelRemainingUnits.diesel, "diesel", game),
    jetFuel: calculateRealFuelFromUnits(fuelRemainingUnits.jetFuel, "jetFuel", game),
  }

  const passengersServedByMode = createEmptyRouteModeBreakdown()
  const podCountByMode = createEmptyRouteModeBreakdown()
  for (const plan of routePlans) {
    passengersServedByMode[plan.route.mode] += plan.passengersServed
    if (
      !plan.isDisconnected &&
      plan.vehicleCard !== null &&
      plan.selectedCityIds.length >= 2 &&
      plan.routes.length > 0
    ) {
      podCountByMode[plan.route.mode] += 1
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
      (total, plan) => total + plan.balanceAdjustmentCost, 0,
    ),
    totalFuelCost: routePlans.reduce((total, plan) => total + plan.fuelCost, 0),
    totalPassengersServed: routePlans.reduce((total, plan) => total + plan.passengersServed, 0),
    totalRevenue: routePlans.reduce((total, plan) => total + plan.revenue, 0),
    totalOperatingCost: routePlans.reduce((total, plan) => total + plan.operatingCost, 0),
    netRevenue: routePlans.reduce((total, plan) => total + plan.netRevenue, 0),
    stuckCubesByCity,
    outboundIntentByCity: [...initialDestsByCityId.entries()].map(([cityId, destMap]) => ({
      cityId,
      destinations: [...destMap.entries()]
        .map(([destCityId, cubeCount]) => ({
          destCityId,
          destCityName: getCityName(game, destCityId),
          cubeCount,
        }))
        .sort((a, b) => b.cubeCount - a.cubeCount),
    })),
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
