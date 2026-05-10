import {
  getBalanceAdjustmentPerTrip,
  getCombinedDemandForCityIds,
  getFuelPriceMultiplier,
  getWeeklyCrewCostForCard,
  getWeeklyMaintenanceCostForCard,
} from "./economy"
import {
  calculateRealFuelFromUnits,
  calculateRouteTripsPerWeek,
} from "./trips"
import type {
  FuelBurnUnit,
  GameState,
  Player,
  PurchasableResource,
  Route,
  RouteMode,
  VehicleCard,
  VehicleType,
} from "./types"

export type BureaucracyRoutePlan = {
  id: string
  corridorId: string
  slotIndex: number
  routes: Route[]
  route: Route
  serviceLabel: string
  cityAName: string
  cityBName: string
  cityIds: string[]
  availableCityIds: string[]
  selectedCityIds: string[]
  segmentCount: number
  canAddSplitService: boolean
  combinedDemand: number
  vehicleCard: VehicleCard | null
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
}

export type PlayerBureaucracySummary = {
  player: Player
  routePlans: BureaucracyRoutePlan[]
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

function getCityName(game: GameState, cityId: string) {
  return game.cities.find(city => city.id === cityId)?.name ?? cityId
}

function getOwnedVehicleCards(game: GameState, player: Player) {
  return player.ownedVehicleCardIds
    .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
    .filter((card): card is VehicleCard => card !== null)
    .sort((cardA, cardB) => cardA.number - cardB.number)
}

function buildServiceGroupId(routes: Route[]) {
  return `service:${routes.map(route => route.id).sort().join("|")}`
}

function getOtherCityId(route: Route, cityId: string) {
  return route.cityA === cityId ? route.cityB : route.cityA
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

function splitConnectedRoutesIntoServiceGroups(routes: Route[]) {
  if (routes.length <= 1) {
    return routes.map(buildSingleRouteServiceGroup)
  }

  const routesByCityId = new Map<string, Route[]>()

  for (const route of routes) {
    routesByCityId.set(route.cityA, [...(routesByCityId.get(route.cityA) ?? []), route])
    routesByCityId.set(route.cityB, [...(routesByCityId.get(route.cityB) ?? []), route])
  }

  const degreeEntries = [...routesByCityId.entries()].map(([cityId, linkedRoutes]) => ({
    cityId,
    degree: linkedRoutes.length,
  }))
  const endpoints = degreeEntries
    .filter(entry => entry.degree === 1)
    .map(entry => entry.cityId)
    .sort((cityA, cityB) => cityA.localeCompare(cityB))
  const isLinear = degreeEntries.every(entry => entry.degree <= 2) && endpoints.length === 2

  if (!isLinear) {
    return routes.map(buildSingleRouteServiceGroup)
  }

  const orderedRoutes: Route[] = []
  const orderedCityIds = [endpoints[0]]
  const visitedRouteIds = new Set<string>()
  let currentCityId = endpoints[0]

  while (orderedRoutes.length < routes.length) {
    const nextRoute = (routesByCityId.get(currentCityId) ?? [])
      .filter(route => !visitedRouteIds.has(route.id))
      .sort((routeA, routeB) => routeA.id.localeCompare(routeB.id))[0]

    if (!nextRoute) {
      return routes.map(buildSingleRouteServiceGroup)
    }

    visitedRouteIds.add(nextRoute.id)
    orderedRoutes.push(nextRoute)
    currentCityId = getOtherCityId(nextRoute, currentCityId)
    orderedCityIds.push(currentCityId)
  }

  return [
    {
      id: buildServiceGroupId(orderedRoutes),
      routes: orderedRoutes,
      cityIds: orderedCityIds,
      mode: orderedRoutes[0].mode,
      railTraction: orderedRoutes[0].railTraction,
    },
  ]
}

function buildOwnedServiceGroups(game: GameState, player: Player) {
  const ownedRoutes = game.routes
    .filter(route => route.ownerId === player.id)
    .sort((routeA, routeB) => routeA.id.localeCompare(routeB.id))
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

    connectedGroups.push(...splitConnectedRoutesIntoServiceGroups(componentRoutes))
  }

  return [...connectedGroups, ...airGroups].sort((groupA, groupB) => groupA.id.localeCompare(groupB.id))
}

function buildServiceSlotId(corridorId: string, slotIndex: number) {
  return `${corridorId}:slot:${slotIndex}`
}

function normalizeSelectedCityIds(availableCityIds: string[], requestedCityIds: string[] | undefined) {
  const filteredCityIds = (requestedCityIds ?? []).filter(cityId => availableCityIds.includes(cityId))
  const uniqueCityIds = [...new Set(filteredCityIds)]

  if (uniqueCityIds.length < 2) {
    return uniqueCityIds
  }

  const selectedIndices = uniqueCityIds
    .map(cityId => availableCityIds.indexOf(cityId))
    .filter(index => index >= 0)
    .sort((indexA, indexB) => indexA - indexB)

  return availableCityIds.slice(selectedIndices[0], selectedIndices[selectedIndices.length - 1] + 1)
}

function buildServiceSlots(
  game: GameState,
  player: Player,
  ownedCards: VehicleCard[],
) {
  const serviceGroups = buildOwnedServiceGroups(game, player)
  const ownedCardCountsByType: Record<VehicleType, number> = {
    air: ownedCards.filter(card => card.type === "air").length,
    train: ownedCards.filter(card => card.type === "train").length,
    bus: ownedCards.filter(card => card.type === "bus").length,
  }
  const serviceSlots: ServiceSlot[] = []

  for (const serviceGroup of serviceGroups) {
    const vehicleType = getVehicleTypeForRouteMode(serviceGroup.mode)
    const slotCount = serviceGroup.mode === "air"
      ? 1
      : Math.max(1, game.bureaucracyServiceSlotCountsByCorridorId[serviceGroup.id] ?? 1)
    const canAddSplitService =
      serviceGroup.mode !== "air" && slotCount < ownedCardCountsByType[vehicleType]

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      serviceSlots.push({
        id: buildServiceSlotId(serviceGroup.id, slotIndex),
        corridorId: serviceGroup.id,
        slotIndex,
        serviceGroup,
        canAddSplitService: canAddSplitService && slotIndex === slotCount - 1,
      })
    }
  }

  return serviceSlots.sort((slotA, slotB) => slotA.id.localeCompare(slotB.id))
}

function assignVehicleCardsToServiceGroups(
  game: GameState,
  player: Player,
  ownedCards: VehicleCard[],
) {
  const serviceSlots = buildServiceSlots(game, player, ownedCards)
  const cardsById = new Map(ownedCards.map(card => [card.id, card]))
  const cardsByType: Record<VehicleType, VehicleCard[]> = {
    air: [],
    train: [],
    bus: [],
  }
  const explicitAssignmentsBySlotId: Record<string, VehicleCard | null> = {}
  const usedCardIds = new Set<string>()

  for (const serviceSlot of serviceSlots) {
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
        assignedCard ??
        cardsByType[getVehicleTypeForRouteMode(serviceSlot.serviceGroup.mode)].shift() ??
        null,
    }
  })
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
        (game.operatingConfig.hoursPerDay * game.operatingConfig.daysPerWeek) /
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

  const routePlans = assignVehicleCardsToServiceGroups(game, player, ownedCards).map(
    ({ serviceSlot, vehicleCard }) => {
      const { serviceGroup } = serviceSlot
      const route = serviceGroup.routes[0]
      const defaultSelectedCityIds = serviceSlot.slotIndex === 0 ? serviceGroup.cityIds : []
      const selectedCityIds = normalizeSelectedCityIds(
        serviceGroup.cityIds,
        game.bureaucracyServiceCityIdsByRouteId[serviceSlot.id] ?? defaultSelectedCityIds,
      )
      const selectedStartIndex = selectedCityIds.length >= 2
        ? serviceGroup.cityIds.indexOf(selectedCityIds[0])
        : -1
      const selectedEndIndex = selectedCityIds.length >= 2
        ? serviceGroup.cityIds.indexOf(selectedCityIds[selectedCityIds.length - 1])
        : -1
      const activeRoutes =
        selectedStartIndex >= 0 && selectedEndIndex > selectedStartIndex
          ? serviceGroup.routes.slice(selectedStartIndex, selectedEndIndex)
          : []
      const activeServiceGroup: ServiceGroup = {
        ...serviceGroup,
        routes: activeRoutes,
        cityIds: selectedCityIds,
      }
      const statsVehicleCard =
        vehicleCard ??
        ownedCards.find(card => card.type === getVehicleTypeForRouteMode(route.mode)) ??
        null
      const requestedFuelUnitsOverride = game.bureaucracyFuelUnitsByRouteId[serviceSlot.id]
      const routeTripSummary =
        vehicleCard === null || activeRoutes.length === 0
          ? null
          : calculateServiceGroupTripSummary(game, activeServiceGroup, vehicleCard)
      const statsRouteTripSummary =
        statsVehicleCard === null || activeRoutes.length === 0
          ? null
          : calculateServiceGroupTripSummary(game, activeServiceGroup, statsVehicleCard)
      const defaultFuelUnits =
        routeTripSummary?.fuelResource === null || routeTripSummary === null
          ? 0
          : Math.ceil(routeTripSummary.tripFuelUnits * routeTripSummary.tripsPerWeek)
      const maxFuelUnitsByTime =
        routeTripSummary && routeTripSummary.fuelResource !== null
          ? Math.ceil(routeTripSummary.tripFuelUnits * routeTripSummary.tripsPerWeek)
          : 0
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
      const fuelCostPerTrip =
        routeTripSummary?.fuelResource === null || routeTripSummary === null
          ? 0
          : routeTripSummary.tripFuelBurn *
            getFuelCostPerRealUnit(game, routeTripSummary.fuelResource)
      const balanceAdjustmentPerTrip =
        vehicleCard === null ? 0 : getBalanceAdjustmentPerTrip(game, route)
      const weeklyCrewCost = vehicleCard === null ? 0 : getWeeklyCrewCostForCard(game, vehicleCard)
      const weeklyMaintenanceCost =
        vehicleCard === null ? 0 : getWeeklyMaintenanceCostForCard(game, vehicleCard)
      const fixedWeeklyCost = weeklyCrewCost + weeklyMaintenanceCost
      const variableTripCost = balanceAdjustmentPerTrip + fuelCostPerTrip
      const maxTripsByBudget =
        routeTripSummary === null
          ? 0
          : variableTripCost <= 0
            ? remainingBudget >= fixedWeeklyCost
              ? routeTripSummary.tripsPerWeek
              : 0
            : Math.max(
                0,
                Math.floor((remainingBudget - fixedWeeklyCost + 1e-9) / variableTripCost),
              )
      const selectedTrips =
        routeTripSummary === null
          ? 0
          : routeTripSummary.fuelResource === null
            ? Math.min(routeTripSummary.tripsPerWeek, maxTripsByBudget)
            : Math.min(
                routeTripSummary.tripsPerWeek,
                maxTripsByBudget,
                Math.floor(
                  (cappedFuelUnits + 1e-9) /
                    Math.max(routeTripSummary.tripFuelUnits, 0.000001),
                ),
              )
      const selectedFuelUnits =
        routeTripSummary?.fuelResource === null || routeTripSummary === null
          ? 0
          : Math.ceil(routeTripSummary.tripFuelUnits * selectedTrips)
      const passengersPerTrip =
        statsVehicleCard === null
          ? 0
          : Math.min(
              statsVehicleCard.totalPassengerCapacity,
              getCombinedDemandForCityIds(game, selectedCityIds) *
                game.operatingConfig.passengersPerDemandPoint,
            )
      const passengersServed =
        vehicleCard === null
          ? 0
          : selectedTrips *
            Math.min(
              vehicleCard.totalPassengerCapacity,
              getCombinedDemandForCityIds(game, selectedCityIds) *
                game.operatingConfig.passengersPerDemandPoint,
            )
      const revenue =
        (routeTripSummary?.distanceMiles ?? 0) *
        passengersServed *
        game.operatingConfig.revenuePerPassengerMile[route.mode]
      const totalFuelBurnReal = routeTripSummary?.fuelResource
        ? routeTripSummary.tripFuelBurn * selectedTrips
        : 0
      const crewCost = selectedTrips > 0 ? weeklyCrewCost : 0
      const maintenanceCost = selectedTrips > 0 ? weeklyMaintenanceCost : 0
      const balanceAdjustmentCost = selectedTrips * balanceAdjustmentPerTrip
      const fuelCost = totalFuelBurnReal
        ? totalFuelBurnReal * getFuelCostPerRealUnit(game, routeTripSummary!.fuelResource!)
        : 0
      const baseOperatingCost = crewCost + maintenanceCost + balanceAdjustmentCost
      const operatingCost = baseOperatingCost + fuelCost
      remainingBudget = Math.max(0, remainingBudget - operatingCost)

        return {
        id: serviceSlot.id,
        corridorId: serviceSlot.corridorId,
        slotIndex: serviceSlot.slotIndex,
        routes: activeRoutes,
        route,
        serviceLabel:
          selectedCityIds.length >= 2
            ? selectedCityIds.map(cityId => getCityName(game, cityId)).join(" - ")
            : `${serviceGroup.cityIds.map(cityId => getCityName(game, cityId)).join(" - ")} (select cities)`,
        cityAName: getCityName(game, route.cityA),
        cityBName: getCityName(game, route.cityB),
        cityIds: selectedCityIds,
        availableCityIds: serviceGroup.cityIds,
        selectedCityIds,
        segmentCount: activeRoutes.length,
        canAddSplitService: serviceSlot.canAddSplitService,
        combinedDemand: getCombinedDemandForCityIds(game, selectedCityIds),
        vehicleCard,
        statsFuelResource: statsRouteTripSummary?.fuelResource ?? null,
        statsFuelBurnUnit: statsRouteTripSummary?.fuelBurnUnit ?? null,
        distanceMiles: statsRouteTripSummary?.distanceMiles ?? null,
        maxTripsByTime: statsRouteTripSummary?.tripsPerWeek ?? 0,
        maxFuelUnitsByTime,
        weeklyFuelBurnReal: statsRouteTripSummary?.weeklyFuelBurn ?? 0,
        weeklyFuelBurnUnits: statsRouteTripSummary?.fuelResource
          ? Math.ceil(
              statsRouteTripSummary.tripFuelUnits * statsRouteTripSummary.tripsPerWeek,
            )
          : 0,
        selectedFuelUnits,
        selectedTrips,
        passengersPerTrip,
        passengersServed,
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
    },
  )

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

  const fuelRemainingUnits: Record<PurchasableResource, number> = {
    diesel: 0,
    jetFuel: 0,
  }

  const fuelRemainingReal: Record<PurchasableResource, number> = {
    diesel: calculateRealFuelFromUnits(fuelRemainingUnits.diesel, "diesel", game),
    jetFuel: calculateRealFuelFromUnits(fuelRemainingUnits.jetFuel, "jetFuel", game),
  }

  return {
    player,
    routePlans,
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

      return {
        ...player,
        money: player.money + summary.netRevenue,
        totalPassengersServed:
          player.totalPassengersServed + summary.totalPassengersServed,
        operatingCosts: summary.totalOperatingCost,
        weeklyPayout: summary.totalRevenue,
        lastPeriodPassengersServed: summary.totalPassengersServed,
      }
    }),
  }
}
