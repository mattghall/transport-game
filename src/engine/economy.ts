import { calculateRouteDistanceMiles } from "./trips"
import type {
  ChanceCard,
  City,
  GameState,
  Player,
  PurchasableResource,
  RailTraction,
  Route,
  VehicleType,
  VehicleCard,
} from "./types"

export function getActiveChanceCard(game: GameState): ChanceCard | null {
  if (!game.activeChanceCardId) {
    return null
  }

  return (
    game.chanceCatalog.find(card => card.id === game.activeChanceCardId) ?? null
  )
}

export function getFuelPriceMultiplier(
  game: GameState,
  resource: PurchasableResource,
) {
  return getActiveChanceCard(game)?.fuelPriceMultiplier?.[resource] ?? 1
}

function cityMatchesDemandBoost(card: ChanceCard | null, city: City) {
  if (!card?.demandBoost || !city.region) {
    return false
  }

  return city.region.some(region => card.demandBoost?.regions.includes(region))
}

export function getCityDemandSize(game: GameState, city: City) {
  const activeChanceCard = getActiveChanceCard(game)

  if (!cityMatchesDemandBoost(activeChanceCard, city)) {
    return city.size
  }

  return city.size + (activeChanceCard?.demandBoost?.bonusPerCity ?? 0)
}

export function getCityDemandAbsorptionSize(game: GameState, city: City) {
  return Math.max(0, getCityDemandSize(game, city)) + 1
}

export function getCombinedDemandForCityIds(game: GameState, cityIds: string[]) {
  return cityIds.reduce((total, cityId) => {
    const city = game.cities.find(candidate => candidate.id === cityId)
    return total + (city ? getCityDemandSize(game, city) : 0)
  }, 0)
}

export function getCombinedDemandForRoute(game: GameState, route: Route) {
  return getCombinedDemandForCityIds(game, [route.cityA, route.cityB])
}

export function getDemandCapacityForCityIds(game: GameState, cityIds: string[]) {
  return getCombinedDemandForCityIds(game, cityIds) * game.operatingConfig.passengersPerDemandPoint
}

export function getFleetSizeForDemand(
  game: GameState,
  cityIds: string[],
  vehicleCard: VehicleCard,
  maxTripsPerPeriod = 1,
) {
  const demandCapacity = getDemandCapacityForCityIds(game, cityIds)
  const serviceCapacityPerVehicle =
    Math.max(vehicleCard.totalPassengerCapacity, 1) * Math.max(maxTripsPerPeriod, 1)

  if (demandCapacity <= 0) {
    return 0
  }

  return Math.max(1, Math.ceil(demandCapacity / serviceCapacityPerVehicle))
}

export function getPassengersPerTrip(
  game: GameState,
  route: Route,
  vehicleCard: VehicleCard,
  fleetSize = vehicleCard.vehicleCount,
) {
  const demandCapacity = getDemandCapacityForCityIds(game, [route.cityA, route.cityB])

  return Math.min(vehicleCard.totalPassengerCapacity * Math.max(fleetSize, 0), demandCapacity)
}

export function getPassengersPerTripForCityIds(
  game: GameState,
  cityIds: string[],
  vehicleCard: VehicleCard,
  fleetSize = vehicleCard.vehicleCount,
) {
  return Math.min(
    vehicleCard.totalPassengerCapacity * Math.max(fleetSize, 0),
    getDemandCapacityForCityIds(game, cityIds),
  )
}

export function getRailTraction(route: Route): RailTraction {
  return route.mode === "rail" ? route.railTraction ?? "diesel" : "diesel"
}

export function getHoursPerWeek(game: Pick<GameState, "operatingConfig">) {
  return (
    game.operatingConfig.hoursPerDay *
    game.operatingConfig.daysPerWeek *
    game.operatingConfig.weeksPerPeriod
  )
}

export function getCrewCostPerWeekPerVehicle(
  game: Pick<GameState, "operatingConfig">,
  type: VehicleType,
) {
  return (
    getHoursPerWeek(game) *
    game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle[type]
  )
}

export function getCrewCostForTrips(
  game: Pick<GameState, "operatingConfig">,
  type: VehicleType,
  tripDurationHours: number,
  tripCount: number,
) {
  if (tripDurationHours <= 0 || tripCount <= 0) {
    return 0
  }

  return (
    tripDurationHours *
    tripCount *
    game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle[type]
  )
}

export function getMaintenanceCostPerWeekPerVehicle(
  game: Pick<GameState, "operatingConfig">,
  type: VehicleType,
) {
  return (
    game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle[type] *
    game.operatingConfig.weeksPerPeriod
  )
}

export function getWeeklyCrewCostForCard(
  game: Pick<GameState, "operatingConfig">,
  vehicleCard: VehicleCard,
  vehicleCount = vehicleCard.vehicleCount,
) {
  return getCrewCostPerWeekPerVehicle(game, vehicleCard.type) * Math.max(vehicleCount, 0)
}

export function getWeeklyMaintenanceCostForCard(
  game: Pick<GameState, "operatingConfig">,
  vehicleCard: VehicleCard,
  vehicleCount = vehicleCard.vehicleCount,
) {
  return getMaintenanceCostPerWeekPerVehicle(game, vehicleCard.type) * Math.max(vehicleCount, 0)
}

export function getAffordableFleetSize({
  targetFleetSize,
  availableBudget,
  fixedCostPerVehicle,
  variableTripCost,
  maxTrips,
}: {
  targetFleetSize: number
  availableBudget: number
  fixedCostPerVehicle: number
  variableTripCost: number
  maxTrips: number
}) {
  if (targetFleetSize <= 0 || availableBudget <= 0) {
    return 0
  }

  for (let fleetSize = targetFleetSize; fleetSize >= 1; fleetSize -= 1) {
    const fixedCost = fixedCostPerVehicle * fleetSize

    if (fixedCost > availableBudget + 1e-9) {
      continue
    }

    if (maxTrips <= 0 || variableTripCost <= 0) {
      return fleetSize
    }

    const maxTripsByBudget = Math.floor(
      (availableBudget - fixedCost + 1e-9) / (variableTripCost * fleetSize),
    )

    if (maxTripsByBudget > 0) {
      return fleetSize
    }
  }

  return 0
}

export function getBalanceAdjustmentPerTrip(game: GameState, route: Route) {
  if (route.mode === "bus") {
    return game.operatingConfig.balanceAdjustmentPerTrip.bus
  }

  if (route.mode === "air") {
    return game.operatingConfig.balanceAdjustmentPerTrip.air
  }

  return getRailTraction(route) === "electric"
    ? game.operatingConfig.balanceAdjustmentPerTrip.railElectric
    : game.operatingConfig.balanceAdjustmentPerTrip.railDiesel
}

export function getConnectedCityIds(game: GameState, playerId: string) {
  const connectedCityIds = new Set<string>()

  for (const route of game.routes) {
    if (route.ownerId !== playerId) {
      continue
    }

    connectedCityIds.add(route.cityA)
    connectedCityIds.add(route.cityB)
  }

  return [...connectedCityIds]
}

export function getNewlyConnectedCityIds(
  game: GameState,
  playerId: string,
  cityIds: string[],
) {
  const connectedCityIds = new Set(getConnectedCityIds(game, playerId))

  return [...new Set(cityIds)].filter(cityId => !connectedCityIds.has(cityId))
}

export function calculateConnectionBonus(
  game: GameState,
  playerId: string,
  cityIds: string[],
) {
  const newlyConnectedCities = getNewlyConnectedCityIds(game, playerId, cityIds)
    .map(cityId => game.cities.find(candidate => candidate.id === cityId) ?? null)
    .filter((city): city is City => city !== null)
  const activeChanceCard = getActiveChanceCard(game)
  const baseBonus = newlyConnectedCities.reduce(
    (total, city) => total + city.size * game.operatingConfig.connectionBonusPerCitySize,
    0,
  )
  const chanceBonus = activeChanceCard?.connectionBonus
    ? newlyConnectedCities.reduce(
        (total, city) =>
          total +
          (city.size === activeChanceCard.connectionBonus?.citySize
            ? activeChanceCard.connectionBonus.bonusPerCity
            : 0),
        0,
      )
    : 0

  return {
    newlyConnectedCityIds: newlyConnectedCities.map(city => city.id),
    baseBonus,
    chanceBonus,
    totalBonus: baseBonus + chanceBonus,
  }
}

export function getRailUpgradeCost(game: GameState, route: Route) {
  if (route.mode !== "rail" || getRailTraction(route) === "electric") {
    return 0
  }

  const distanceMiles = calculateRouteDistanceMiles(game.cities, route)

  if (distanceMiles === null) {
    return 0
  }

  return Math.ceil(distanceMiles * game.operatingConfig.railElectrificationCostPerMile)
}

export type VictoryStanding = {
  player: Player
  connectedCities: number
}

export function buildVictoryStandings(game: GameState): VictoryStanding[] {
  return [...game.players]
    .map(player => ({
      player,
      connectedCities: getConnectedCityIds(game, player.id).length,
    }))
    .sort((standingA, standingB) => {
      if (standingB.player.totalPassengersServed !== standingA.player.totalPassengersServed) {
        return standingB.player.totalPassengersServed - standingA.player.totalPassengersServed
      }

      if (standingB.connectedCities !== standingA.connectedCities) {
        return standingB.connectedCities - standingA.connectedCities
      }

      return standingB.player.money - standingA.player.money
    })
}
