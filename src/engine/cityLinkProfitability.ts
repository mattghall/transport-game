import { usMap } from "../data/maps/usMap"
import { createGameState } from "./createGameState"
import { calculateClaimRouteCost } from "./actions"
import { getPayoutFarePerPassengerForDistance } from "./bureaucracy"
import {
  getBalanceAdjustmentPerTrip,
  getCrewCostForTrips,
  getDemandCapacityForCityIds,
  getFuelPriceMultiplier,
  getFleetSizeForDemand,
  getWeeklyMaintenanceCostForCard,
} from "./economy"
import { calculateRouteTripsPerWeek } from "./trips"
import type { GameState, Route, RouteMode, VehicleType } from "./types"

export type EstimatedCityLinkProfitability = {
  mode: Exclude<RouteMode, "bus">
  cityAId: string
  cityAName: string
  cityBId: string
  cityBName: string
  distanceMiles: number
  bestVehicleName: string
  estimatedPassengers: number
  estimatedRevenue: number
  estimatedOperatingCost: number
  estimatedNetRevenue: number
  buildCost: number
}

const ANALYSIS_PLAYER = {
  id: "analysis-player",
  name: "Analysis Player",
  color: "#223024",
}

function getVehicleTypeForMode(mode: EstimatedCityLinkProfitability["mode"]): VehicleType {
  return mode === "rail" ? "train" : "air"
}

function createAnalysisGame() {
  const initialGame = createGameState(usMap, {
    players: [ANALYSIS_PLAYER],
    seed: 1,
  })

  return {
    ...initialGame,
    activeChanceCardId: null,
  }
}

function getRailCandidatePairs(game: GameState) {
  const seenPairs = new Set<string>()
  const pairs: Array<[string, string]> = []

  for (const city of game.cities) {
    for (const adjacentCity of city.adjacentCities ?? []) {
      if (adjacentCity.allowRail === false) {
        continue
      }

      const pair = [city.id, adjacentCity.id].sort()
      const pairKey = pair.join(":")

      if (seenPairs.has(pairKey)) {
        continue
      }

      seenPairs.add(pairKey)
      pairs.push([pair[0], pair[1]])
    }
  }

  return pairs
}

function getAirCandidatePairs(game: GameState) {
  const pairs: Array<[string, string]> = []

  for (let firstIndex = 0; firstIndex < game.cities.length - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < game.cities.length; secondIndex += 1) {
      const cityA = game.cities[firstIndex]
      const cityB = game.cities[secondIndex]

      if (!cityA || !cityB) {
        continue
      }

      const pair = [cityA.id, cityB.id].sort()
      pairs.push([pair[0], pair[1]])
    }
  }

  return pairs
}

function estimateLinkProfitability(
  game: GameState,
  mode: EstimatedCityLinkProfitability["mode"],
  cityAId: string,
  cityBId: string,
) {
  const cityA = game.cities.find(city => city.id === cityAId)
  const cityB = game.cities.find(city => city.id === cityBId)

  if (!cityA || !cityB) {
    return null
  }

  const route: Route = {
    id: `analysis:${mode}:${cityAId}:${cityBId}`,
    cityA: cityAId,
    cityB: cityBId,
    mode,
  }
  const vehicleType = getVehicleTypeForMode(mode)
  const buildCost =
    mode === "rail"
      ? Math.ceil(
          calculateClaimRouteCost(
            game,
            {
              cityIds: [cityAId, cityBId],
              mode,
            },
            ANALYSIS_PLAYER.id,
          ),
        )
      : 0
  const demandCapacity = getDemandCapacityForCityIds(game, [cityAId, cityBId])

  const bestEstimate = game.vehicleCatalog
    .filter(vehicleCard => vehicleCard.type === vehicleType)
    .map(vehicleCard => {
      const tripSummary = calculateRouteTripsPerWeek(game, route, vehicleCard)

      if (!tripSummary || tripSummary.tripsPerWeek <= 0) {
        return null
      }

      const fleetSize = Math.max(
        1,
        getFleetSizeForDemand(game, [cityAId, cityBId], vehicleCard, tripSummary.tripsPerWeek),
      )
      const maxPassengersByCapacity =
        vehicleCard.totalPassengerCapacity * fleetSize * tripSummary.tripsPerWeek
      const passengersServed = Math.min(demandCapacity, maxPassengersByCapacity)

      if (passengersServed <= 0) {
        return null
      }

      const tripsNeeded = Math.max(
        1,
        Math.ceil(passengersServed / Math.max(vehicleCard.totalPassengerCapacity * fleetSize, 1)),
      )
      const revenue =
        passengersServed * getPayoutFarePerPassengerForDistance(tripSummary.distanceMiles)
      const crewCost = getCrewCostForTrips(
        game,
        vehicleCard.type,
        tripSummary.tripDurationHours,
        tripsNeeded,
      )
      const maintenanceCost = getWeeklyMaintenanceCostForCard(game, vehicleCard, fleetSize)
      const balanceAdjustmentCost = tripsNeeded * getBalanceAdjustmentPerTrip(game, route)
      const fuelCost = tripSummary.fuelResource
        ? tripSummary.tripFuelBurn *
          tripsNeeded *
          game.operatingConfig.fuelPricePerRealUnit[tripSummary.fuelResource] *
          getFuelPriceMultiplier(game, tripSummary.fuelResource)
        : 0
      const operatingCost = crewCost + maintenanceCost + balanceAdjustmentCost + fuelCost

      return {
        vehicleCard,
        distanceMiles: tripSummary.distanceMiles,
        passengersServed,
        revenue,
        operatingCost,
        netRevenue: revenue - operatingCost,
      }
    })
    .filter((estimate): estimate is NonNullable<typeof estimate> => estimate !== null)
    .sort((estimateA, estimateB) => estimateB.netRevenue - estimateA.netRevenue)[0]

  if (!bestEstimate) {
    return null
  }

  return {
    mode,
    cityAId,
    cityAName: cityA.name,
    cityBId,
    cityBName: cityB.name,
    distanceMiles: bestEstimate.distanceMiles,
    bestVehicleName: bestEstimate.vehicleCard.name,
    estimatedPassengers: bestEstimate.passengersServed,
    estimatedRevenue: bestEstimate.revenue,
    estimatedOperatingCost: bestEstimate.operatingCost,
    estimatedNetRevenue: bestEstimate.netRevenue,
    buildCost,
  } satisfies EstimatedCityLinkProfitability
}

export function buildEstimatedCityLinkProfitabilityRows(limit = 20) {
  const game = createAnalysisGame()
  const railRows = getRailCandidatePairs(game)
    .map(([cityAId, cityBId]) => estimateLinkProfitability(game, "rail", cityAId, cityBId))
    .filter((row): row is EstimatedCityLinkProfitability => row !== null)
  const airRows = getAirCandidatePairs(game)
    .map(([cityAId, cityBId]) => estimateLinkProfitability(game, "air", cityAId, cityBId))
    .filter((row): row is EstimatedCityLinkProfitability => row !== null)

  return [...railRows, ...airRows]
    .sort((rowA, rowB) => rowB.estimatedNetRevenue - rowA.estimatedNetRevenue)
    .slice(0, limit)
}
