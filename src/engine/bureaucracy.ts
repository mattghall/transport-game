import {
  getCombinedDemandForRoute,
  getOperatingCostPerTrip,
  getPassengersPerTrip,
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
  route: Route
  cityAName: string
  cityBName: string
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
  revenue: number
  operatingCost: number
  netRevenue: number
}

export type PlayerBureaucracySummary = {
  player: Player
  routePlans: BureaucracyRoutePlan[]
  fuelUsedUnits: Record<PurchasableResource, number>
  fuelUsedReal: Record<PurchasableResource, number>
  fuelRemainingUnits: Record<PurchasableResource, number>
  fuelRemainingReal: Record<PurchasableResource, number>
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

function assignVehicleCardsToRoutes(
  game: GameState,
  player: Player,
  ownedCards: VehicleCard[],
) {
  const ownedRoutes = game.routes
    .filter(route => route.ownerId === player.id)
    .sort((routeA, routeB) => routeA.id.localeCompare(routeB.id))
  const cardsById = new Map(ownedCards.map(card => [card.id, card]))
  const cardsByType: Record<VehicleType, VehicleCard[]> = {
    air: [],
    train: [],
    bus: [],
  }
  const explicitAssignmentsByRouteId: Record<string, VehicleCard | null> = {}
  const usedCardIds = new Set<string>()

  for (const route of ownedRoutes) {
    const assignedCardId = game.bureaucracyVehicleCardIdsByRouteId[route.id]
    const assignedCard =
      assignedCardId === undefined ? null : cardsById.get(assignedCardId) ?? null

    if (
      assignedCard &&
      assignedCard.type === getVehicleTypeForRouteMode(route.mode) &&
      !usedCardIds.has(assignedCard.id)
    ) {
      explicitAssignmentsByRouteId[route.id] = assignedCard
      usedCardIds.add(assignedCard.id)
      continue
    }

    explicitAssignmentsByRouteId[route.id] = null
  }

  for (const card of ownedCards) {
    if (usedCardIds.has(card.id)) {
      continue
    }

    cardsByType[card.type].push(card)
  }

  return ownedRoutes.map(route => {
    const assignedCard = explicitAssignmentsByRouteId[route.id]

    return {
      route,
      vehicleCard:
        assignedCard ?? cardsByType[getVehicleTypeForRouteMode(route.mode)].shift() ?? null,
    }
  })
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
  const remainingFuelUnits: Record<PurchasableResource, number> = {
    diesel: player.inventory.fuel.diesel,
    jetFuel: player.inventory.fuel.jetFuel,
  }

  const routePlans = assignVehicleCardsToRoutes(game, player, ownedCards).map(
    ({ route, vehicleCard }) => {
      const statsVehicleCard =
        vehicleCard ??
        ownedCards.find(card => card.type === getVehicleTypeForRouteMode(route.mode)) ??
        null
      const requestedFuelUnits = Math.max(
        0,
        game.bureaucracyFuelUnitsByRouteId[route.id] ?? 0,
      )
      const routeTripSummary =
        vehicleCard === null
          ? null
          : calculateRouteTripsPerWeek(game, route, vehicleCard)
      const statsRouteTripSummary =
        statsVehicleCard === null
          ? null
          : calculateRouteTripsPerWeek(game, route, statsVehicleCard)
      const maxFuelUnitsByTime =
        routeTripSummary && routeTripSummary.fuelResource !== null
          ? Math.ceil(routeTripSummary.tripFuelUnits * routeTripSummary.tripsPerWeek)
          : 0
      const maxFuelUnitsByInventory = routeTripSummary?.fuelResource
        ? Math.floor(remainingFuelUnits[routeTripSummary.fuelResource])
        : 0
      const selectedFuelUnits =
        routeTripSummary === null || routeTripSummary.fuelResource === null
          ? 0
          : Math.min(requestedFuelUnits, maxFuelUnitsByTime, maxFuelUnitsByInventory)
      const selectedTrips =
        routeTripSummary === null
          ? 0
          : routeTripSummary.fuelResource === null
            ? routeTripSummary.tripsPerWeek
            : Math.min(
                routeTripSummary.tripsPerWeek,
                Math.floor(
                  (selectedFuelUnits + 1e-9) /
                    Math.max(routeTripSummary.tripFuelUnits, 0.000001),
                ),
              )
      const passengersPerTrip =
        statsVehicleCard === null ? 0 : getPassengersPerTrip(game, route, statsVehicleCard)
      const passengersServed =
        vehicleCard === null
          ? 0
          : selectedTrips * getPassengersPerTrip(game, route, vehicleCard)
      const revenue =
        (routeTripSummary?.distanceMiles ?? 0) *
        passengersServed *
        game.operatingConfig.revenuePerPassengerMile[route.mode]
      const totalFuelBurnReal = routeTripSummary?.fuelResource
        ? calculateRealFuelFromUnits(
            selectedFuelUnits,
            routeTripSummary.fuelResource,
            game,
          )
        : 0
      const operatingCost =
        vehicleCard === null ? 0 : selectedTrips * getOperatingCostPerTrip(game, route)

      if (routeTripSummary?.fuelResource) {
        remainingFuelUnits[routeTripSummary.fuelResource] = Math.max(
          0,
          remainingFuelUnits[routeTripSummary.fuelResource] - selectedFuelUnits,
        )
      }

      return {
        route,
        cityAName: getCityName(game, route.cityA),
        cityBName: getCityName(game, route.cityB),
        combinedDemand: getCombinedDemandForRoute(game, route),
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
    diesel: Math.max(0, player.inventory.fuel.diesel - fuelUsedUnits.diesel),
    jetFuel: Math.max(0, player.inventory.fuel.jetFuel - fuelUsedUnits.jetFuel),
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

export function getMaxFuelUnitsForRoute(game: GameState, routeId: string) {
  const route = game.routes.find(candidate => candidate.id === routeId)

  if (!route?.ownerId) {
    return 0
  }

  const summary = buildPlayerBureaucracySummary(game, route.ownerId)
  const targetPlan = summary?.routePlans.find(plan => plan.route.id === routeId)

  if (!summary || !targetPlan || !targetPlan.vehicleCard || !targetPlan.fuelResource) {
    return 0
  }

  const otherFuelUsage = summary.routePlans
    .filter(
      plan =>
        plan.route.id !== routeId && plan.fuelResource === targetPlan.fuelResource,
    )
    .reduce((total, plan) => total + plan.totalFuelBurnUnits, 0)

  const availableFuelUnits = Math.max(
    0,
    summary.player.inventory.fuel[targetPlan.fuelResource] - otherFuelUsage,
  )

  return Math.max(
    0,
    Math.min(targetPlan.maxFuelUnitsByTime, Math.floor(availableFuelUnits)),
  )
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
        inventory: {
          ...player.inventory,
          fuel: {
            diesel: Math.max(
              0,
              player.inventory.fuel.diesel - summary.fuelUsedUnits.diesel,
            ),
            jetFuel: Math.max(
              0,
              player.inventory.fuel.jetFuel - summary.fuelUsedUnits.jetFuel,
            ),
          },
        },
      }
    }),
  }
}
