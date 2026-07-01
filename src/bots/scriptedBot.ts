import { getPlayerById, calculateClaimRouteCost, getVehicleTradeInValue, resolveRouteSelection } from "../engine/actions"
import { getPayoutMultiplierForDistance, type BureaucracyRoutePlan } from "../engine/bureaucracy"
import { getPlayerOwnedNetworkRoutes } from "../engine/playerNetwork"
import { CITY_DECK_REGIONS, type City, type CityDeckRegion, type GameState, type VehicleType } from "../engine/types"
import { calculateDistanceMiles } from "../engine/trips"
import { getBotLegalActions, applyBotAction } from "./actions"
import { getBotGameStage, getOwnedCityPairs, type BotGameStage } from "./strategy"
import { getCachedBureaucracySummary } from "./summaryCache"
import type { BotAction, BotController } from "./types"

export type ScriptedBotWeights = {
  vehiclePriorityBus: number
  vehiclePriorityTrain: number
  vehiclePriorityAir: number
  claimRailBaseScore: number
  claimAirBaseScore: number
  claimPopulationPerMillionScore: number
  claimNewCityBonus: number
  claimFirstModeBonus: number
  claimRailCostPenaltyPerMillion: number
  claimPacificPreference: number
  claimMountainPreference: number
  claimSouthPreference: number
  claimSoutheastPreference: number
  claimMidwestPreference: number
  claimNortheastPreference: number
  claimSameRegionLinkBonus: number
  claimNewRegionBonus: number
  claimLongDistancePreference: number
  buyBusOwnedCityBonus: number
  buyTrainPotentialClaimBonus: number
  buyTrainFallbackOwnedCityBonus: number
  buyTrainNoClaimPenalty: number
  buyAirPotentialClaimBonus: number
  buyAirFallbackOwnedCityBonus: number
  buyAirNoClaimPenalty: number
  buyDuplicateVehiclePenalty: number
  buyFirstTrainBonus: number
  buyFirstAirBonus: number
  earlyExpansionMultiplier: number
  midExpansionMultiplier: number
  lateExpansionMultiplier: number
  earlyPopulationMultiplier: number
  midPopulationMultiplier: number
  latePopulationMultiplier: number
  earlyReadyOperationsScore: number
  midReadyOperationsScore: number
  lateReadyOperationsScore: number
  earlyClaimBudget: number
  midClaimBudget: number
  lateClaimBudget: number
  podSplitBaseScore: number
  podCityCountScore: number
  podPopulationPerMillionScore: number
  podPopulationPerDistanceScore: number
  podDemandScore: number
  podDemandPerMileScore: number
  podNetRevenueScore: number
  podAdditionalRoutePenalty: number
  podRemoveCityBaseScore: number
  podRemovePassengersPerDistanceGainScore: number
  podRemoveNetRevenueGainScore: number
  drawRegionDeckSizeScore: number
  drawRegionOwnedCityBonus: number
  drawRegionOpponentCityPenalty: number
  drawRegionBigCityScarcityBonus: number
  keepCityPopulationScore: number
  keepCityNetworkProximityScore: number
  keepCityPairCohesionScore: number
  keepCityRegionMatchScore: number
  keepCityAdjacencyPotentialScore: number
  // Reward claiming routes that extend or bridge existing owned corridors.
  // +N per owned route that shares a city endpoint with the claimed route.
  claimAdjacentNetworkBonus: number
  // Penalty per opponent route that already touches either endpoint of the claimed route.
  // Discourages claiming into heavily contested areas.
  claimOpponentBlockPenalty: number
  // Extra penalty multiplier for the wasted portion of a rail build when a cheaper connector
  // would have extended the same rail network more efficiently.
  claimConnectorWastePenaltyMultiplier: number
  // Penalty for starting a disconnected rail component when no spare train exists to service it.
  claimDisconnectedRailPenalty: number
  // Reward for buying more of a vehicle card you already have assigned to a pod.
  // Models fleet scaling: if pod with vehicle X earns $Y/month, buying another X adds ~$Y/month.
  // Score += (existingNetRevenue / 1_000_000) * buyFleetScaleBonus
  buyFleetScaleBonus: number
  // Reward per 100 passengers of vehicle capacity when buying.
  // Helps the bot prefer higher-capacity vehicles within the same type.
  buyVehicleCapacityScore: number
  // Reward per 10 units of vehicle speed when buying.
  buyVehicleSpeedScore: number
  // Bonus when buying a vehicle that matches the type needed by an unserviced (empty) pod.
  buyVehicleForEmptyPodBonus: number
  // Bonus for creating a service pod when the player already owns a compatible unassigned vehicle.
  podHasCompatibleVehicleBonus: number
  // Reward per 100 passengers gained from a create-service-pod action.
  podPassengerGainScore: number
  // Bonus per disconnected city removed from a corridor through a create-service-pod action.
  podDisconnectedCityReductionBonus: number
  // Penalty per newly created staffed-but-unassigned pod in a corridor.
  podUnstaffedPodPenalty: number
  // Bonus for expanding/reconfiguring a pod that already has a vehicle assigned.
  podExistingVehicleAssignedBonus: number
  // Bonus per zero-service city that a pod action converts into a city with some service.
  podZeroServiceCityReliefBonus: number
  // Bonus for improving service coverage in smaller cities, weighted by served ratio.
  podSmallCityCoverageScore: number
  // Bonus for getting smaller cities across dynamic-demand growth thresholds.
  podGrowthCityServiceBonus: number
  // Penalty per city left with zero service when the bot is considering ending operations.
  readyOperationsZeroServiceCityPenalty: number
  // Bonus for buying a vehicle type that can relieve zero-service cities on existing networks.
  buyVehicleForUnservedCityBonus: number
}

export const DEFAULT_SCRIPTED_BOT_WEIGHTS: ScriptedBotWeights = {
  vehiclePriorityBus: 88,
  vehiclePriorityTrain: 58,
  vehiclePriorityAir: 42,
  claimRailBaseScore: 120,
  claimAirBaseScore: 104,
  claimPopulationPerMillionScore: 5,
  claimNewCityBonus: 24,
  claimFirstModeBonus: 18,
  claimRailCostPenaltyPerMillion: 1,
  claimPacificPreference: 0,
  claimMountainPreference: 0,
  claimSouthPreference: 0,
  claimSoutheastPreference: 0,
  claimMidwestPreference: 0,
  claimNortheastPreference: 0,
  claimSameRegionLinkBonus: 0,
  claimNewRegionBonus: 0,
  claimLongDistancePreference: 0,
  buyBusOwnedCityBonus: 4,
  buyTrainPotentialClaimBonus: 38,
  buyTrainFallbackOwnedCityBonus: 6,
  buyTrainNoClaimPenalty: 20,
  buyAirPotentialClaimBonus: 34,
  buyAirFallbackOwnedCityBonus: 8,
  buyAirNoClaimPenalty: 24,
  buyDuplicateVehiclePenalty: 10,
  buyFirstTrainBonus: 26,
  buyFirstAirBonus: 30,
  earlyExpansionMultiplier: 1.45,
  midExpansionMultiplier: 1,
  lateExpansionMultiplier: 0.45,
  earlyPopulationMultiplier: 0.8,
  midPopulationMultiplier: 1,
  latePopulationMultiplier: 1.5,
  earlyReadyOperationsScore: 42,
  midReadyOperationsScore: 128,
  lateReadyOperationsScore: 228,
  earlyClaimBudget: 3,
  midClaimBudget: 2,
  lateClaimBudget: 1,
  podSplitBaseScore: 28,
  podCityCountScore: 11,
  podPopulationPerMillionScore: 8,
  podPopulationPerDistanceScore: 18,
  podDemandScore: 4,
  podDemandPerMileScore: 0,
  podNetRevenueScore: 30,
  podAdditionalRoutePenalty: 16,
  podRemoveCityBaseScore: 0,
  podRemovePassengersPerDistanceGainScore: 20,
  podRemoveNetRevenueGainScore: 15,
  drawRegionDeckSizeScore: 2,
  drawRegionOwnedCityBonus: 8,
  drawRegionOpponentCityPenalty: 3,
  drawRegionBigCityScarcityBonus: 5,
  keepCityPopulationScore: 10,
  keepCityNetworkProximityScore: 6,
  keepCityPairCohesionScore: 12,
  keepCityRegionMatchScore: 4,
  keepCityAdjacencyPotentialScore: 8,
  claimAdjacentNetworkBonus: 8,
  claimOpponentBlockPenalty: 4,
  claimConnectorWastePenaltyMultiplier: 3.5,
  claimDisconnectedRailPenalty: 220,
  buyFleetScaleBonus: 30,
  buyVehicleCapacityScore: 1.5,
  buyVehicleSpeedScore: 0.5,
  buyVehicleForEmptyPodBonus: 25,
  podHasCompatibleVehicleBonus: 15,
  podPassengerGainScore: 1,
  podDisconnectedCityReductionBonus: 18,
  podUnstaffedPodPenalty: 90,
  podExistingVehicleAssignedBonus: 40,
  podZeroServiceCityReliefBonus: 34,
  podSmallCityCoverageScore: 12,
  podGrowthCityServiceBonus: 10,
  readyOperationsZeroServiceCityPenalty: 24,
  buyVehicleForUnservedCityBonus: 18,
}

type BotCityServiceSnapshot = {
  zeroServiceCityCount: number
  weightedCoverageScore: number
  growthReadyScore: number
}

type CorridorPlanningAction = Extract<
  BotAction,
  {
    type:
      | "create-service-pod"
      | "remove-pod-city"
      | "assign-pod-vehicle"
      | "add-second-vehicle-to-pod"
      | "delete-service-pod"
  }
>

type CorridorPlanState = {
  bestScore: number
  stepCount: number
}

const MAX_BOT_CORRIDOR_PLAN_DEPTH = 4
const MAX_BOT_CORRIDOR_PLAN_ACTIONS = 6
const MAX_BOT_CORRIDOR_PLAN_CITY_COUNT = 8

export function mergeScriptedBotWeights(
  overrides: Partial<ScriptedBotWeights> = {},
): ScriptedBotWeights {
  return {
    ...DEFAULT_SCRIPTED_BOT_WEIGHTS,
    ...overrides,
  }
}

const REGION_WEIGHT_KEY_BY_REGION: Record<CityDeckRegion, keyof ScriptedBotWeights> = {
  Pacific: "claimPacificPreference",
  Mountain: "claimMountainPreference",
  South: "claimSouthPreference",
  Southeast: "claimSoutheastPreference",
  Midwest: "claimMidwestPreference",
  Northeast: "claimNortheastPreference",
}

function getVehiclePriority(type: VehicleType, weights: ScriptedBotWeights) {
  switch (type) {
    case "bus":
      return weights.vehiclePriorityBus
    case "train":
      return weights.vehiclePriorityTrain
    case "air":
      return weights.vehiclePriorityAir
  }
}

function getStageWeight(
  stage: BotGameStage,
  weights: ScriptedBotWeights,
  keyPrefix: "ExpansionMultiplier" | "PopulationMultiplier" | "ReadyOperationsScore" | "ClaimBudget",
) {
  switch (stage) {
    case "early":
      return weights[`early${keyPrefix}`]
    case "mid":
      return weights[`mid${keyPrefix}`]
    case "late":
      return weights[`late${keyPrefix}`]
  }
}

function getPrimaryRegion(city: City | undefined): CityDeckRegion | null {
  const primaryRegion = city?.region?.[0]
  return primaryRegion && CITY_DECK_REGIONS.includes(primaryRegion as CityDeckRegion)
    ? (primaryRegion as CityDeckRegion)
    : null
}

function getRegionPreference(region: CityDeckRegion, weights: ScriptedBotWeights) {
  return weights[REGION_WEIGHT_KEY_BY_REGION[region]]
}

function hasExistingModePath(
  routes: Array<Pick<GameState["routes"][number], "cityA" | "cityB">>,
  startCityId: string,
  endCityId: string,
) {
  if (startCityId === endCityId) {
    return true
  }

  const adjacency = new Map<string, string[]>()

  for (const route of routes) {
    adjacency.set(route.cityA, [...(adjacency.get(route.cityA) ?? []), route.cityB])
    adjacency.set(route.cityB, [...(adjacency.get(route.cityB) ?? []), route.cityA])
  }

  const visited = new Set<string>()
  const queue = [startCityId]

  while (queue.length > 0) {
    const cityId = queue.shift()
    if (!cityId || visited.has(cityId)) {
      continue
    }
    if (cityId === endCityId) {
      return true
    }

    visited.add(cityId)
    for (const neighborCityId of adjacency.get(cityId) ?? []) {
      if (!visited.has(neighborCityId)) {
        queue.push(neighborCityId)
      }
    }
  }

  return false
}

function getVehicleTypeForPlanMode(mode: BureaucracyRoutePlan["route"]["mode"]): VehicleType {
  switch (mode) {
    case "bus":
      return "bus"
    case "rail":
      return "train"
    case "air":
      return "air"
  }
}

function buildCityServiceSnapshot(
  plans: BureaucracyRoutePlan[],
  game: Pick<GameState, "operatingConfig">,
): BotCityServiceSnapshot {
  const statsByCityId = new Map<
    string,
    {
      size: number
      generatedDemandCubes: number
      servedDemandCubes: number
    }
  >()

  for (const plan of plans) {
    if (plan.isDisconnected || plan.selectedCityIds.length < 2) {
      continue
    }

    for (const cityStatus of plan.simplifiedCityStatuses) {
      const existing = statsByCityId.get(cityStatus.cityId) ?? {
        size: cityStatus.size,
        generatedDemandCubes: 0,
        servedDemandCubes: 0,
      }

      statsByCityId.set(cityStatus.cityId, {
        size: Math.max(existing.size, cityStatus.size),
        generatedDemandCubes: Math.max(existing.generatedDemandCubes, cityStatus.outboundCubes),
        servedDemandCubes: existing.servedDemandCubes + cityStatus.filledCubes,
      })
    }
  }

  let zeroServiceCityCount = 0
  let weightedCoverageScore = 0
  let growthReadyScore = 0

  for (const stats of statsByCityId.values()) {
    if (stats.generatedDemandCubes <= 0) {
      continue
    }

    const servedRatio = Math.min(
      1,
      Math.max(0, stats.servedDemandCubes / Math.max(stats.generatedDemandCubes, 1)),
    )
    const cityWeight = Math.max(1, 9 - stats.size)

    if (stats.servedDemandCubes <= 0) {
      zeroServiceCityCount += 1
    }

    weightedCoverageScore += servedRatio * cityWeight

    if (game.operatingConfig.dynamicDemand.enabled) {
      if (servedRatio >= game.operatingConfig.dynamicDemand.fullServiceThreshold) {
        growthReadyScore += cityWeight * 2
      } else if (servedRatio >= game.operatingConfig.dynamicDemand.highServiceThreshold) {
        growthReadyScore += cityWeight
      }
    }
  }

  return {
    zeroServiceCityCount,
    weightedCoverageScore,
    growthReadyScore,
  }
}

function getServiceCoverageBonus(
  currentPlans: BureaucracyRoutePlan[],
  nextPlans: BureaucracyRoutePlan[],
  game: Pick<GameState, "operatingConfig">,
  weights: ScriptedBotWeights,
) {
  const currentSnapshot = buildCityServiceSnapshot(currentPlans, game)
  const nextSnapshot = buildCityServiceSnapshot(nextPlans, game)

  return (
    (currentSnapshot.zeroServiceCityCount - nextSnapshot.zeroServiceCityCount) *
      weights.podZeroServiceCityReliefBonus +
    (nextSnapshot.weightedCoverageScore - currentSnapshot.weightedCoverageScore) *
      weights.podSmallCityCoverageScore +
    (nextSnapshot.growthReadyScore - currentSnapshot.growthReadyScore) *
      weights.podGrowthCityServiceBonus
  )
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

function getRailConnectorWastePenalty(
  action: Extract<BotAction, { type: "claim-route" }>,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  connectedCityIdSet: Set<string>,
  cityMap: Map<string, City>,
) {
  if (action.mode !== "rail") {
    return 0
  }

  const player = getPlayerById(game, playerId)

  if (!player) {
    return 0
  }

  const existingRailRoutes = getPlayerOwnedNetworkRoutes(game, playerId).filter(
    route => route.mode === action.mode,
  )

  const newCityIds = action.cityIds.filter(cityId => !connectedCityIdSet.has(cityId))

  if (
    newCityIds.length === 0 &&
    action.cityIds.length === 2 &&
    hasExistingModePath(existingRailRoutes, action.cityIds[0], action.cityIds[1])
  ) {
    return calculateClaimRouteCost(game, {
      mode: action.mode,
      cityIds: action.cityIds,
    }) * 20
  }

  if (newCityIds.length !== 1) {
    return 0
  }

  const newCityId = newCityIds[0]
  const newCity = cityMap.get(newCityId)

  if (!newCity) {
    return 0
  }

  const currentCost = calculateClaimRouteCost(game, {
    mode: action.mode,
    cityIds: action.cityIds,
  })
  const connectedOwnedCityIds = player.ownedCityCardIds.filter(cityId => connectedCityIdSet.has(cityId))
  let cheapestConnectorCost = Number.POSITIVE_INFINITY

  for (const adjacentCity of newCity.adjacentCities ?? []) {
    if (!connectedOwnedCityIds.includes(adjacentCity.id)) {
      continue
    }

    cheapestConnectorCost = Math.min(
      cheapestConnectorCost,
      adjacentCity.distance * game.operatingConfig.railConstructionCostPerMile,
    )
  }

  return Number.isFinite(cheapestConnectorCost)
    ? Math.max(0, currentCost - cheapestConnectorCost)
    : 0
}

function scoreClaimRouteAction(
  action: Extract<BotAction, { type: "claim-route" }>,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: ScriptedBotWeights,
) {
  const stage = getBotGameStage(game)
  const cityMap = new Map(game.cities.map(city => [city.id, city]))
  const existingRoutesOfMode = getPlayerOwnedNetworkRoutes(game, playerId).filter(
    route => route.mode === action.mode,
  )
  const connectedCityIdSet = new Set(
    existingRoutesOfMode.flatMap(route => [route.cityA, route.cityB]),
  )
  const totalPopulation = action.cityIds.reduce(
    (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
    0,
  )
  const newCityCount = action.cityIds.filter(cityId => !connectedCityIdSet.has(cityId)).length
  const candidateRegions = action.cityIds
    .map(cityId => getPrimaryRegion(cityMap.get(cityId)))
    .filter((region): region is CityDeckRegion => region !== null)
  const connectedRegions = new Set(
    [...connectedCityIdSet]
      .map(cityId => getPrimaryRegion(cityMap.get(cityId)))
      .filter((region): region is CityDeckRegion => region !== null),
  )
  const newRegionCount = [...new Set(candidateRegions)].filter(region => !connectedRegions.has(region)).length
  const cost = calculateClaimRouteCost(game, {
    mode: action.mode,
    cityIds: action.cityIds,
  })
  const regionPreferenceScore = candidateRegions.reduce(
    (total, region) => total + getRegionPreference(region, weights),
    0,
  )
  const sameRegionLinkBonus =
    action.cityIds.length >= 2 &&
    candidateRegions.length === action.cityIds.length &&
    new Set(candidateRegions).size === 1
      ? weights.claimSameRegionLinkBonus
      : 0
  const resolvedSelection = resolveRouteSelection(game, action.cityIds, action.mode)
  const totalDistanceMiles =
    resolvedSelection.ok
      ? resolvedSelection.segmentPairs.reduce((total, [cityAId, cityBId]) => {
          const cityA = cityMap.get(cityAId)
          const cityB = cityMap.get(cityBId)

          if (!cityA || !cityB) {
            return total
          }

          return total + calculateDistanceMiles(cityA, cityB)
        }, 0)
      : 0
  const distancePreferenceScore =
    getPayoutMultiplierForDistance(totalDistanceMiles) * weights.claimLongDistancePreference

  // Count player's existing routes that share a city endpoint with this candidate route.
  // An extension (+1 shared endpoint) gets one bonus; a bridging route (+2 shared endpoints) gets two.
  const candidateCityIdSet = new Set(action.cityIds)
  const allPlayerRoutes = getPlayerOwnedNetworkRoutes(game, playerId)
  const adjacentNetworkCount = allPlayerRoutes.filter(
    r => candidateCityIdSet.has(r.cityA) || candidateCityIdSet.has(r.cityB),
  ).length

  // Count opponent routes touching the same endpoints — indicates a contested / blocked area.
  const opponentBlockCount = game.routes.filter(
    r => r.ownerId && r.ownerId !== playerId && (candidateCityIdSet.has(r.cityA) || candidateCityIdSet.has(r.cityB)),
  ).length
  const connectorWastePenalty =
    (getRailConnectorWastePenalty(action, game, playerId, connectedCityIdSet, cityMap) / 1_000_000) *
    weights.claimConnectorWastePenaltyMultiplier
  const summary = getCachedBureaucracySummary(game, playerId)
  const assignedTrainCardIds = new Set(
    summary?.routePlans
      .filter(plan => !plan.isDisconnected && plan.route.mode === "rail" && plan.vehicleCard?.type === "train")
      .map(plan => plan.vehicleCard!.id) ?? [],
  )
  const unassignedTrainCount = getPlayerById(game, playerId)?.ownedVehicleCardIds.filter(cardId => {
    const card = game.vehicleCatalog.find(vehicleCard => vehicleCard.id === cardId)
    return card?.type === "train" && !assignedTrainCardIds.has(cardId)
  }).length ?? 0
  const isDisconnectedRailExpansion =
    action.mode === "rail" &&
    existingRoutesOfMode.length > 0 &&
    action.cityIds.every(cityId => !connectedCityIdSet.has(cityId))
  const disconnectedRailPenalty =
    isDisconnectedRailExpansion && unassignedTrainCount <= 0
      ? weights.claimDisconnectedRailPenalty
      : 0

  return (
    (action.mode === "rail" ? weights.claimRailBaseScore : weights.claimAirBaseScore) +
    (totalPopulation / 1_000_000) *
      weights.claimPopulationPerMillionScore *
      getStageWeight(stage, weights, "PopulationMultiplier") +
    newCityCount *
      weights.claimNewCityBonus *
      getStageWeight(stage, weights, "ExpansionMultiplier") +
    (existingRoutesOfMode.length === 0
      ? weights.claimFirstModeBonus * getStageWeight(stage, weights, "ExpansionMultiplier")
      : 0) +
    regionPreferenceScore +
    sameRegionLinkBonus +
    distancePreferenceScore +
    newRegionCount * weights.claimNewRegionBonus * getStageWeight(stage, weights, "ExpansionMultiplier") +
    adjacentNetworkCount * weights.claimAdjacentNetworkBonus -
    opponentBlockCount * weights.claimOpponentBlockPenalty -
    connectorWastePenalty -
    disconnectedRailPenalty -
    (cost / 1_000_000) * weights.claimRailCostPenaltyPerMillion
  )
}

function scoreBotAction(
  action: BotAction,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: ScriptedBotWeights,
  currentSummary?: ReturnType<typeof getCachedBureaucracySummary>,
) {
  const stage = getBotGameStage(game)
  if (action.type === "claim-route") {
    return scoreClaimRouteAction(action, game, playerId, weights)
  }

  if (action.type === "create-service-pod") {
    const summary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
    const cityMap = new Map(game.cities.map(city => [city.id, city]))

    const totalPopulation = action.cityIds.reduce(
      (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
      0,
    )
    const distanceMiles = action.cityIds.reduce((total, cityId, i) => {
      const nextCityId = action.cityIds[i + 1]
      if (!nextCityId) return total
      const cityA = cityMap.get(cityId)
      const cityB = cityMap.get(nextCityId)
      return cityA && cityB ? total + calculateDistanceMiles(cityA, cityB) : total
    }, 0)
    const populationPerDistance =
      distanceMiles > 0 ? (totalPopulation / 1_000_000) / Math.max(distanceMiles / 100, 1) : 0

    // Estimate combined demand from current cube state via the cached summary.
    let podCombinedDemand = 0
    let activePodCount = 0
    if (summary) {
      const corridorPlans = summary.routePlans.filter(p => p.corridorId === action.corridorId)
      const demandByCityId = new Map<string, number>()
      for (const plan of corridorPlans) {
        for (const d of plan.cityCubeDemands) {
          demandByCityId.set(d.cityId, d.outboundCubes + d.inboundCubes)
        }
      }
      podCombinedDemand = action.cityIds.reduce(
        (total, cityId) => total + (demandByCityId.get(cityId) ?? 0),
        0,
      )
      activePodCount = corridorPlans.filter(p => !p.isDisconnected && p.selectedCityIds.length >= 2).length
    }

    const demandPerMile = distanceMiles > 0 ? podCombinedDemand / Math.max(distanceMiles / 100, 1) : 0

    // Bonus when the player already owns a compatible unassigned vehicle for this corridor's mode.
    const player = getPlayerById(game, playerId)
    let compatibleVehicleBonus = 0
    if (player && summary) {
      const corridorMode = summary.routePlans.find(p => p.corridorId === action.corridorId)?.route.mode
      const neededType = corridorMode === "bus" ? "bus" : corridorMode === "rail" ? "train" : "air"
      const assignedCardIds = new Set(Object.values(game.bureaucracyVehicleCardIdsByRouteId))
      const hasCompatible = player.ownedVehicleCardIds.some(cardId => {
        if (assignedCardIds.has(cardId)) return false
        const card = game.vehicleCatalog.find(c => c.id === cardId)
        return card?.type === neededType
      })
      if (hasCompatible) compatibleVehicleBonus = weights.podHasCompatibleVehicleBonus
    }

    const currentCorridorPlans = summary?.routePlans.filter(plan => plan.corridorId === action.corridorId) ?? []
    const currentTargetPlan = currentCorridorPlans.find(plan => plan.id === action.routeId) ?? null
    let passengerGainScore = 0
    let netRevenueGainScore = 0
    let disconnectedReductionBonus = 0
    let unstaffedPodPenalty = 0

    const nextGame = applyBotAction(game, playerId, action)
    const nextSummary = getCachedBureaucracySummary(nextGame, playerId)
    const nextCorridorPlans = nextSummary?.routePlans.filter(plan => plan.corridorId === action.corridorId) ?? []
    const currentPassengers = currentCorridorPlans.reduce((sum, plan) => sum + plan.passengersServed, 0)
    const nextPassengers = nextCorridorPlans.reduce((sum, plan) => sum + plan.passengersServed, 0)
    const currentNetRevenue = currentCorridorPlans.reduce((sum, plan) => sum + plan.netRevenue, 0)
    const nextNetRevenue = nextCorridorPlans.reduce((sum, plan) => sum + plan.netRevenue, 0)
    const currentDisconnectedCount =
      currentCorridorPlans.find(plan => plan.isDisconnected)?.selectedCityIds.length ?? 0
    const nextDisconnectedCount =
      nextCorridorPlans.find(plan => plan.isDisconnected)?.selectedCityIds.length ?? 0
    const currentUnstaffedPodCount = currentCorridorPlans.filter(
      plan => !plan.isDisconnected && plan.selectedCityIds.length >= 2 && !plan.vehicleCard,
    ).length
    const nextUnstaffedPodCount = nextCorridorPlans.filter(
      plan => !plan.isDisconnected && plan.selectedCityIds.length >= 2 && !plan.vehicleCard,
    ).length

    passengerGainScore =
      (Math.max(0, nextPassengers - currentPassengers) / 100) * weights.podPassengerGainScore
    netRevenueGainScore = ((nextNetRevenue - currentNetRevenue) / 1_000_000) * weights.podNetRevenueScore
    disconnectedReductionBonus =
      Math.max(0, currentDisconnectedCount - nextDisconnectedCount) *
      weights.podDisconnectedCityReductionBonus
    unstaffedPodPenalty =
      Math.max(0, nextUnstaffedPodCount - currentUnstaffedPodCount) * weights.podUnstaffedPodPenalty
    const serviceCoverageBonus = getServiceCoverageBonus(
      currentCorridorPlans,
      nextCorridorPlans,
      game,
      weights,
    )

    return (
      weights.podSplitBaseScore +
      action.cityIds.length * weights.podCityCountScore +
      (totalPopulation / 1_000_000) * weights.podPopulationPerMillionScore +
      populationPerDistance * weights.podPopulationPerDistanceScore +
      podCombinedDemand * weights.podDemandScore +
      demandPerMile * weights.podDemandPerMileScore -
      Math.max(0, activePodCount - 1) * weights.podAdditionalRoutePenalty +
      compatibleVehicleBonus +
      passengerGainScore +
      netRevenueGainScore +
      serviceCoverageBonus +
      disconnectedReductionBonus -
      unstaffedPodPenalty +
      (currentTargetPlan?.vehicleCard ? weights.podExistingVehicleAssignedBonus : 0)
    )
  }

  if (action.type === "remove-pod-city") {
    // Score based on city's current demand contribution — no simulation needed.
    // Only remove cities with zero demand cubes (safe: they can't form a profitable pod candidate
    // via create-service-pod, so removal won't cause cycling).
    const summary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
    if (!summary) return Number.NEGATIVE_INFINITY

    const sourcePlan = summary.routePlans.find(plan => plan.id === action.sourceRouteId) ?? null
    if (!sourcePlan || sourcePlan.isDisconnected || sourcePlan.selectedCityIds.length < 3) {
      return Number.NEGATIVE_INFINITY
    }

    const cityDemand = sourcePlan.cityCubeDemands.find(d => d.cityId === action.cityId)
    const activeCubes = (cityDemand?.outboundCubes ?? 0) + (cityDemand?.inboundCubes ?? 0)
    if (activeCubes > 0) return Number.NEGATIVE_INFINITY

    // Zero-demand city: removing it reduces route distance/cost with no passenger loss.
    const netRevenuePenalty = sourcePlan.netRevenue < 0 ? -sourcePlan.netRevenue / 1_000_000 : 0
    return weights.podRemoveCityBaseScore + netRevenuePenalty * weights.podRemoveNetRevenueGainScore
  }

  if (action.type === "assign-pod-vehicle") {
    // Assigning a vehicle to an empty pod is almost always good — score based on pod potential.
    // Use demand from the pod plan to estimate value.
    const summary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
    if (!summary) return 80
    const plan = summary.routePlans.find(p => p.id === action.routeId)
    if (!plan) return 80
    const podDemand = plan.cityCubeDemands.reduce(
      (total, d) => total + d.outboundCubes + d.inboundCubes,
      0,
    )
    const currentCorridorPlans = summary.routePlans.filter(
      routePlan => routePlan.corridorId === plan.corridorId,
    )
    const nextGame = applyBotAction(game, playerId, action)
    const nextSummary = getCachedBureaucracySummary(nextGame, playerId)
    const nextCorridorPlans = nextSummary?.routePlans.filter(
      routePlan => routePlan.corridorId === plan.corridorId,
    ) ?? []
    const serviceCoverageBonus = getServiceCoverageBonus(
      currentCorridorPlans,
      nextCorridorPlans,
      game,
      weights,
    )
    // Strong positive: assigning any vehicle unlocks revenue
    return 100 + podDemand * weights.podDemandScore + serviceCoverageBonus
  }

  if (action.type === "add-second-vehicle-to-pod") {
    const summary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
    if (!summary) return Number.NEGATIVE_INFINITY
    const cityKey = [...action.cityIds].sort().join("|")
    const currentMatchingPods = summary.routePlans.filter(
      plan => !plan.isDisconnected && plan.vehicleCard && [...plan.selectedCityIds].sort().join("|") === cityKey,
    )
    const existingPod = currentMatchingPods[0] ?? null
    if (!existingPod || (existingPod.netRevenue ?? 0) <= 0) return Number.NEGATIVE_INFINITY

    const nextGame = applyBotAction(game, playerId, action)
    const nextSummary = getCachedBureaucracySummary(nextGame, playerId)
    const nextMatchingPods = nextSummary?.routePlans.filter(
      plan => !plan.isDisconnected && plan.vehicleCard && [...plan.selectedCityIds].sort().join("|") === cityKey,
    ) ?? []
    const currentPassengers = currentMatchingPods.reduce((sum, plan) => sum + plan.passengersServed, 0)
    const nextPassengers = nextMatchingPods.reduce((sum, plan) => sum + plan.passengersServed, 0)
    const currentNetRevenue = currentMatchingPods.reduce((sum, plan) => sum + plan.netRevenue, 0)
    const nextNetRevenue = nextMatchingPods.reduce((sum, plan) => sum + plan.netRevenue, 0)
    const passengerGainScore =
      (Math.max(0, nextPassengers - currentPassengers) / 100) * weights.podPassengerGainScore
    const netRevenueGainScore = ((nextNetRevenue - currentNetRevenue) / 1_000_000) * weights.podNetRevenueScore
    const fleetScaleBonus = (existingPod.netRevenue / 1_000_000) * weights.buyFleetScaleBonus
    const currentCorridorPlans = summary.routePlans.filter(
      plan => plan.corridorId === existingPod.corridorId,
    )
    const nextCorridorPlans = nextSummary?.routePlans.filter(
      plan => plan.corridorId === existingPod.corridorId,
    ) ?? []
    const serviceCoverageBonus = getServiceCoverageBonus(
      currentCorridorPlans,
      nextCorridorPlans,
      game,
      weights,
    )

    return fleetScaleBonus + passengerGainScore + netRevenueGainScore + serviceCoverageBonus
  }

  if (action.type === "exchange-vehicle") {
    // Score upgrade based on improvement in capacity/speed vs old card; penalize cost
    const player = getPlayerById(game, playerId)
    if (!player) return Number.NEGATIVE_INFINITY
    const newCard = game.vehicleCatalog.find(c => c.id === action.newCardId)
    const oldCard = game.vehicleCatalog.find(c => c.id === action.oldCardId)
    if (!newCard || !oldCard) return Number.NEGATIVE_INFINITY
    const weeksOwned = player.vehicleWeeksOwnedByCardId[action.oldCardId] ?? 0
    const tradeInValue = getVehicleTradeInValue(oldCard, weeksOwned)
    const cost = Math.max(0, newCard.purchasePrice - tradeInValue)
    // Capacity improvement as a fraction
    const capacityGain = newCard.totalPassengerCapacity - oldCard.totalPassengerCapacity
    const speedGain = newCard.speed - oldCard.speed
    // Bonus if this card is already assigned to a profitable pod
    const summary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
    const netRevenueFromOld = summary?.routePlans
      .filter(p => !p.isDisconnected && p.vehicleCard?.id === action.oldCardId && (p.netRevenue ?? 0) > 0)
      .reduce((sum, p) => sum + (p.netRevenue ?? 0), 0) ?? 0
    const upgradeBonus = (netRevenueFromOld / 1_000_000) * weights.buyFleetScaleBonus * 0.5
    return (
      (capacityGain / 100) * 4 +
      (speedGain / 10) * 2 +
      upgradeBonus -
      (cost / 1_000_000) * 8
    )
  }

  if (action.type === "draw-city-offer") {
    const player = getPlayerById(game, playerId)
    if (!player) return 0
    const region = action.region as import("../engine/types").CityDeckRegion
    const deckSize = game.cityDeckCardIdsByRegion[region]?.length ?? 0
    const ownedInRegion = player.ownedCityCardIds.filter(id => {
      const city = game.cities.find(c => c.id === id)
      return city?.region?.includes(region)
    }).length
    const opponentCitiesInRegion = game.players
      .filter(p => p.id !== playerId)
      .reduce((total, p) => total + p.ownedCityCardIds.filter(id => {
        const city = game.cities.find(c => c.id === id)
        return city?.region?.includes(region)
      }).length, 0)
    // Big-city scarcity: large cities still in a small deck are valuable targets
    const remainingCitiesInDeck = (game.cityDeckCardIdsByRegion[region] ?? []).map(
      id => game.cities.find(c => c.id === id)
    ).filter(Boolean)
    const avgPopRemaining = remainingCitiesInDeck.length > 0
      ? remainingCitiesInDeck.reduce((s, c) => s + (c!.population ?? 0), 0) / remainingCitiesInDeck.length
      : 0
    const bigCityScarcitySignal = deckSize > 0 && deckSize <= 6 ? avgPopRemaining / 1_000_000 : 0

    return (
      deckSize * weights.drawRegionDeckSizeScore +
      ownedInRegion * weights.drawRegionOwnedCityBonus -
      opponentCitiesInRegion * weights.drawRegionOpponentCityPenalty +
      bigCityScarcitySignal * weights.drawRegionBigCityScarcityBonus
    )
  }

  if (action.type === "keep-city-offer") {
    const player = getPlayerById(game, playerId)
    if (!player) return 0
    const cityMap = new Map(game.cities.map(c => [c.id, c]))
    const chosenCities = action.cityIds.map(id => cityMap.get(id)).filter(Boolean) as import("../engine/types").City[]
    const ownedCities = player.ownedCityCardIds.map(id => cityMap.get(id)).filter(Boolean) as import("../engine/types").City[]

    // Population sum of chosen pair
    const totalPop = chosenCities.reduce((s, c) => s + (c.population ?? 0), 0)

    const chosenPairIsAdjacent =
      chosenCities.length === 2 &&
      (chosenCities[0]?.adjacentCities?.some(adjacentCity => adjacentCity.id === chosenCities[1]?.id) ?? false)
    const chosenCitiesAdjacentToOwnedCount = chosenCities.reduce((total, city) => {
      const isAdjacentToOwned = ownedCities.some(
        ownedCity => city.adjacentCities?.some(adjacentCity => adjacentCity.id === ownedCity.id) ?? false,
      )
      return total + (isAdjacentToOwned ? 1 : 0)
    }, 0)
    const pairCohesionScore =
      (chosenPairIsAdjacent ? 2 : 0) + chosenCitiesAdjacentToOwnedCount * 1.5

    // Adjacency potential: unclaimed adjacent routes = future connection opportunity;
    // opponent-claimed adjacent routes = blocked potential (penalize)
    const adjacencyPotential = chosenCities.reduce((sum, city) => {
      const adjacentRoutes = game.routes.filter(r => r.cityA === city.id || r.cityB === city.id)
      const unclaimed = adjacentRoutes.filter(r => !r.ownerId).length
      const opponentOwned = adjacentRoutes.filter(r => r.ownerId && r.ownerId !== playerId).length
      return sum + unclaimed - opponentOwned * 2
    }, 0)

    // Network proximity: avg min-distance from each chosen city to any owned city
    let networkProximityScore = 0
    if (ownedCities.length > 0) {
      const avgMinDist = chosenCities.reduce((sum, city) => {
        const minDist = Math.min(...ownedCities.map(owned => calculateDistanceMiles(city, owned)))
        return sum + minDist
      }, 0) / chosenCities.length
      // Closer = higher score: invert distance (cap at 2000 miles)
      networkProximityScore = Math.max(0, 2000 - avgMinDist) / 100
    }

    // Region match: how many chosen cities are in the player's most-owned region
    const regionCounts = new Map<string, number>()
    for (const id of player.ownedCityCardIds) {
      for (const r of (cityMap.get(id)?.region ?? [])) {
        regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1)
      }
    }
    const topRegion = [...regionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const regionMatchCount = topRegion
      ? chosenCities.filter(c => c.region?.includes(topRegion)).length
      : 0

    return (
      (totalPop / 1_000_000) * weights.keepCityPopulationScore +
      pairCohesionScore * weights.keepCityPairCohesionScore +
      networkProximityScore * weights.keepCityNetworkProximityScore +
      regionMatchCount * weights.keepCityRegionMatchScore +
      adjacencyPotential * weights.keepCityAdjacencyPotentialScore
    )
  }

  if (action.type !== "buy-vehicle") {
    if (action.type === "ready-operations") {
      const baseScore = getStageWeight(stage, weights, "ReadyOperationsScore")
      const summary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
      const player = getPlayerById(game, playerId)

      if (!summary || !player) {
        return baseScore
      }

      const unstaffedPodCount = summary.routePlans.filter(
        plan => !plan.isDisconnected && plan.selectedCityIds.length >= 2 && !plan.vehicleCard,
      ).length
      const connectedCityIds = new Set(
        summary.routePlans
          .filter(plan => !plan.isDisconnected)
          .flatMap(plan => plan.availableCityIds),
      )
      const isolatedOwnedCityCount = player.ownedCityCardIds.filter(cityId => !connectedCityIds.has(cityId)).length
      const disconnectedCityCount = new Set(
        summary.routePlans
          .filter(plan => plan.isDisconnected && plan.selectedCityIds.length > 0)
          .flatMap(plan => plan.selectedCityIds),
      ).size
      const playerCityService = buildCityServiceSnapshot(summary.routePlans, game)

      return (
        baseScore -
        unstaffedPodCount * weights.podUnstaffedPodPenalty -
        disconnectedCityCount * weights.podDisconnectedCityReductionBonus * 0.6 -
        isolatedOwnedCityCount * weights.podDisconnectedCityReductionBonus * 0.4 -
        playerCityService.zeroServiceCityCount * weights.readyOperationsZeroServiceCityPenalty
      )
    }

    if (action.type === "end-turn") {
      return 0
    }

    return 10
  }

  const player = getPlayerById(game, playerId)
  const card = game.vehicleCatalog.find(vehicleCard => vehicleCard.id === action.cardId)
  const quantity = Math.max(1, action.quantity)

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
  const ownedRailRouteCount = getPlayerOwnedNetworkRoutes(game, playerId).filter(route => route.mode === "rail").length

  // Fleet scaling bonus: if this exact card is already owned and assigned to a productive pod,
  // buying another directly scales revenue (fleet size × capacity). Score the expected delta.
  const summary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
  const hasRailServiceOpportunity =
    ownedRailRouteCount > 0 ||
    (summary?.routePlans.some(
      plan => !plan.isDisconnected && plan.route.mode === "rail" && plan.selectedCityIds.length >= 2,
    ) ?? false)
  let fleetScaleBonus = 0
  if (player.ownedVehicleCardIds.includes(card.id)) {
    const netRevenueFromCard = summary?.routePlans
      .filter(p => !p.isDisconnected && p.vehicleCard?.id === card.id && (p.netRevenue ?? 0) > 0)
      .reduce((sum, p) => sum + (p.netRevenue ?? 0), 0) ?? 0
    fleetScaleBonus = (netRevenueFromCard / 1_000_000) * weights.buyFleetScaleBonus
  }

  // Bonus when an unserviced pod of this vehicle type already exists — buying fills it immediately.
  const vehicleTypeForMode = card.type === "bus" ? "bus" : card.type === "train" ? "train" : "air"
  const unservicedPodCount = summary?.routePlans.filter(
    p => !p.isDisconnected && p.selectedCityIds.length >= 2 && !p.vehicleCard &&
      (p.route.mode === "bus" ? "bus" : p.route.mode === "rail" ? "train" : "air") === vehicleTypeForMode,
  ).length ?? 0
  const emptyPodBonus = unservicedPodCount > 0 ? weights.buyVehicleForEmptyPodBonus : 0
  const matchingModeService = buildCityServiceSnapshot(
    summary?.routePlans.filter(plan => getVehicleTypeForPlanMode(plan.route.mode) === card.type) ?? [],
    game,
  )
  const unservedCityVehicleBonus =
    matchingModeService.zeroServiceCityCount * weights.buyVehicleForUnservedCityBonus

  if (card.type === "train" && potentialRailClaims === 0 && !hasRailServiceOpportunity) {
    return Number.NEGATIVE_INFINITY
  }

  const cityBonus =
    card.type === "bus"
      ? Math.min(ownedCityCount, 6) * weights.buyBusOwnedCityBonus
      : card.type === "train"
        ? potentialRailClaims > 0
          ? weights.buyTrainPotentialClaimBonus
          : hasRailServiceOpportunity && ownedCityCount >= 4
            ? weights.buyTrainFallbackOwnedCityBonus
            : -weights.buyTrainNoClaimPenalty * 4
        : potentialAirClaims > 0
          ? weights.buyAirPotentialClaimBonus
          : ownedCityCount >= 5
            ? weights.buyAirFallbackOwnedCityBonus
            : -weights.buyAirNoClaimPenalty
  const firstOfTypeBonus =
    card.type === "train"
      ? ownedVehicleCount === 0 && potentialRailClaims > 0 ? weights.buyFirstTrainBonus : 0
      : card.type === "air"
        ? ownedVehicleCount === 0 && potentialAirClaims > 0 ? weights.buyFirstAirBonus : 0
        : 0
  const duplicatePenalty =
    Array.from({ length: quantity }, (_, index) => ownedVehicleCount + index)
      .reduce((sum, count) => sum + count * weights.buyDuplicateVehiclePenalty, 0)
  const scalableScore =
    (getVehiclePriority(card.type, weights) +
      cityBonus +
      fleetScaleBonus +
      emptyPodBonus +
      unservedCityVehicleBonus +
      (card.totalPassengerCapacity / 100) * weights.buyVehicleCapacityScore +
      (card.speed / 10) * weights.buyVehicleSpeedScore -
      card.purchasePrice / 1_000_000) * quantity

  return (
    scalableScore +
    firstOfTypeBonus -
    duplicatePenalty
  )
}

function isCorridorPlanningAction(action: BotAction): action is CorridorPlanningAction {
  return (
    action.type === "create-service-pod" ||
    action.type === "remove-pod-city" ||
    action.type === "assign-pod-vehicle" ||
    action.type === "add-second-vehicle-to-pod" ||
    action.type === "delete-service-pod"
  )
}

function getActionKey(action: BotAction) {
  switch (action.type) {
    case "claim-route":
      return `${action.type}:${action.mode}:${action.cityIds.join(",")}`
    case "create-service-pod":
      return `${action.type}:${action.corridorId}:${action.routeId}:${action.cityIds.join(",")}`
    case "remove-pod-city":
      return `${action.type}:${action.corridorId}:${action.sourceRouteId}:${action.cityId}`
    case "assign-pod-vehicle":
      return `${action.type}:${action.routeId}:${action.vehicleCardId}`
    case "add-second-vehicle-to-pod":
      return `${action.type}:${action.corridorId}:${action.vehicleCardId}:${action.cityIds.join(",")}`
    case "delete-service-pod":
      return `${action.type}:${action.corridorId}:${action.routeId}`
    case "buy-vehicle":
      return `${action.type}:${action.cardId}:${action.quantity}`
    case "draw-city-offer":
      return `${action.type}:${action.region}`
    case "keep-city-offer":
      return `${action.type}:${action.cityIds.join(",")}`
    case "exchange-vehicle":
      return `${action.type}:${action.oldCardId}:${action.newCardId}`
    default:
      return action.type
  }
}

function getVehicleTypeForRouteMode(mode: BureaucracyRoutePlan["route"]["mode"]): VehicleType {
  return mode === "bus" ? "bus" : mode === "rail" ? "train" : "air"
}

function getCorridorIdForAction(
  action: CorridorPlanningAction,
  summary?: ReturnType<typeof getCachedBureaucracySummary>,
) {
  switch (action.type) {
    case "create-service-pod":
    case "remove-pod-city":
    case "add-second-vehicle-to-pod":
    case "delete-service-pod":
      return action.corridorId
    case "assign-pod-vehicle":
      return summary?.routePlans.find(plan => plan.id === action.routeId)?.corridorId ?? null
  }
}

function getCorridorPlans(
  summary: ReturnType<typeof getCachedBureaucracySummary> | undefined,
  corridorId: string,
) {
  return summary?.routePlans.filter(plan => plan.corridorId === corridorId) ?? []
}

function scoreCorridorPlans(corridorPlans: BureaucracyRoutePlan[], weights: ScriptedBotWeights) {
  const activePlans = corridorPlans.filter(plan => !plan.isDisconnected)
  const staffedPodCount = activePlans.filter(
    plan => plan.selectedCityIds.length >= 2 && plan.vehicleCard,
  ).length
  const unstaffedPodCount = activePlans.filter(
    plan => plan.selectedCityIds.length >= 2 && !plan.vehicleCard,
  ).length
  const disconnectedCityCount = corridorPlans.find(plan => plan.isDisconnected)?.selectedCityIds.length ?? 0
  const totalPassengers = activePlans.reduce((sum, plan) => sum + plan.passengersServed, 0)
  const totalNetRevenue = activePlans.reduce((sum, plan) => sum + plan.netRevenue, 0)
  const movedDemandCubes = activePlans.reduce((sum, plan) => sum + plan.movedCubes, 0)
  const selectedCityCount = activePlans.reduce((sum, plan) => sum + plan.selectedCityIds.length, 0)

  return (
    (totalPassengers / 100) * weights.podPassengerGainScore +
    (totalNetRevenue / 1_000_000) * weights.podNetRevenueScore +
    staffedPodCount * (weights.podSplitBaseScore * 0.5) +
    movedDemandCubes * weights.podDemandScore +
    selectedCityCount * (weights.podCityCountScore * 0.4) -
    unstaffedPodCount * weights.podUnstaffedPodPenalty -
    disconnectedCityCount * weights.podDisconnectedCityReductionBonus
  )
}

function buildCorridorPlanStateKey(
  game: GameState,
  playerId: string,
  corridorId: string,
  summary?: ReturnType<typeof getCachedBureaucracySummary>,
) {
  const resolvedSummary = summary ?? getCachedBureaucracySummary(game, playerId)
  const corridorPlans = getCorridorPlans(resolvedSummary, corridorId)
  const corridorMode = corridorPlans[0]?.route.mode ?? null
  const player = getPlayerById(game, playerId)
  const assignedVehicleIds = new Set(
    resolvedSummary?.routePlans
      .filter(plan => !plan.isDisconnected && plan.selectedCityIds.length >= 2)
      .map(plan => plan.vehicleCard?.id ?? null)
      .filter((cardId): cardId is string => cardId !== null) ?? [],
  )
  const compatibleVehicleIds =
    corridorMode === null || !player
      ? []
      : player.ownedVehicleCardIds
          .filter(cardId => {
            const card = game.vehicleCatalog.find((vehicleCard) => vehicleCard.id === cardId)
            return card?.type === getVehicleTypeForRouteMode(corridorMode) && !assignedVehicleIds.has(cardId)
          })
          .sort()

  const planSignature = corridorPlans
    .map(plan => [
      plan.id,
      plan.slotIndex,
      plan.isDisconnected ? "disconnected" : "active",
      plan.selectedCityIds.join(","),
      plan.vehicleCard?.id ?? "-",
      plan.canAddSplitService ? "split" : "fixed",
    ].join(":"))
    .sort()
    .join("|")

  return `${corridorId}::${planSignature}::${compatibleVehicleIds.join(",")}`
}

function isBetterCorridorPlanState(candidate: CorridorPlanState, current: CorridorPlanState) {
  return (
    candidate.bestScore > current.bestScore ||
    (candidate.bestScore === current.bestScore && candidate.stepCount < current.stepCount)
  )
}

function findBestCorridorPlanState(
  game: GameState,
  playerId: string,
  corridorId: string,
  weights: ScriptedBotWeights,
  remainingDepth: number,
  memo: Map<string, CorridorPlanState>,
): CorridorPlanState {
  const summary = getCachedBureaucracySummary(game, playerId)
  const corridorPlans = getCorridorPlans(summary, corridorId)
  const currentScore = scoreCorridorPlans(corridorPlans, weights)
  const memoKey = `${remainingDepth}::${buildCorridorPlanStateKey(game, playerId, corridorId, summary)}`
  const cached = memo.get(memoKey)

  if (cached) {
    return cached
  }

  let bestState: CorridorPlanState = {
    bestScore: currentScore,
    stepCount: 0,
  }

  if (remainingDepth <= 0) {
    memo.set(memoKey, bestState)
    return bestState
  }

  const corridorActions = getBotLegalActions(game, playerId).filter(
    (action): action is CorridorPlanningAction =>
      isCorridorPlanningAction(action) && getCorridorIdForAction(action, summary) === corridorId,
  )

  for (const action of corridorActions) {
    let nextGame: GameState

    try {
      nextGame = applyBotAction(game, playerId, action)
    } catch {
      continue
    }

    const nextState = findBestCorridorPlanState(
      nextGame,
      playerId,
      corridorId,
      weights,
      remainingDepth - 1,
      memo,
    )
    const candidateState: CorridorPlanState = {
      bestScore: nextState.bestScore,
      stepCount: nextState.stepCount + 1,
    }

    if (isBetterCorridorPlanState(candidateState, bestState)) {
      bestState = candidateState
    }
  }

  memo.set(memoKey, bestState)
  return bestState
}

function getPlannedOperationsActionScores(
  game: GameState,
  playerId: string,
  weights: ScriptedBotWeights,
  legalActions: BotAction[],
  currentSummary?: ReturnType<typeof getCachedBureaucracySummary>,
) {
  if (game.currentPhase !== "operations") {
    return new Map<string, number>()
  }

  const resolvedSummary = currentSummary ?? getCachedBureaucracySummary(game, playerId)
  const memo = new Map<string, CorridorPlanState>()
  const plannedScores = new Map<string, number>()
  const corridorActionsByCorridor = new Map<string, CorridorPlanningAction[]>()

  for (const action of legalActions) {
    if (!isCorridorPlanningAction(action)) {
      continue
    }

    const corridorId = getCorridorIdForAction(action, resolvedSummary)

    if (!corridorId) {
      continue
    }

    const corridorActions = corridorActionsByCorridor.get(corridorId) ?? []
    corridorActions.push(action)
    corridorActionsByCorridor.set(corridorId, corridorActions)
  }

  for (const [corridorId, corridorActions] of corridorActionsByCorridor) {
    const corridorPlans = getCorridorPlans(resolvedSummary, corridorId)
    const corridorCityCount = new Set(corridorPlans.flatMap(plan => plan.availableCityIds)).size

    if (
      corridorActions.length > MAX_BOT_CORRIDOR_PLAN_ACTIONS ||
      corridorCityCount > MAX_BOT_CORRIDOR_PLAN_CITY_COUNT
    ) {
      continue
    }

    for (const action of corridorActions) {
      const immediateScore = scoreBotAction(action, game, playerId, weights, resolvedSummary)
      let nextGame: GameState

      try {
        nextGame = applyBotAction(game, playerId, action)
      } catch {
        continue
      }

      const nextSummary = getCachedBureaucracySummary(nextGame, playerId)
      const immediateCorridorScore = scoreCorridorPlans(
        getCorridorPlans(nextSummary, corridorId),
        weights,
      )
      const bestContinuationState = findBestCorridorPlanState(
        nextGame,
        playerId,
        corridorId,
        weights,
        MAX_BOT_CORRIDOR_PLAN_DEPTH - 1,
        memo,
      )
      const continuationBonus = Math.max(0, bestContinuationState.bestScore - immediateCorridorScore)

      plannedScores.set(getActionKey(action), immediateScore + continuationBonus)
    }
  }

  return plannedScores
}

function getBotActionSelectionScore(
  action: BotAction,
  game: GameState,
  playerId: string,
  weights: ScriptedBotWeights,
  currentSummary: ReturnType<typeof getCachedBureaucracySummary> | undefined,
  plannedActionScores: ReadonlyMap<string, number>,
) {
  return plannedActionScores.get(getActionKey(action)) ??
    scoreBotAction(action, game, playerId, weights, currentSummary)
}

export function createScriptedBot(id: string, weights: Partial<ScriptedBotWeights> = {}): BotController {
  const resolvedWeights = mergeScriptedBotWeights(weights)

  return {
    id,
    pickAction({ game, playerId, legalActions }) {
      const availableActions = legalActions.length > 0 ? legalActions : getBotLegalActions(game, playerId)
      const stage = getBotGameStage(game)
      const stageClaimBudget = Math.max(0, Math.round(getStageWeight(stage, resolvedWeights, "ClaimBudget")))
      const claimedRouteCountThisTurn = game.claimedRouteCountsByPlayerIdThisTurn[playerId] ?? 0

      if (availableActions.length === 0) {
        return { type: "end-turn" }
      }

      if (
        claimedRouteCountThisTurn >= stageClaimBudget &&
        !availableActions.some(action =>
          action.type === "create-service-pod" ||
          action.type === "assign-pod-vehicle" ||
          action.type === "add-second-vehicle-to-pod",
        ) &&
        availableActions.some(action => action.type === "ready-operations")
      ) {
        return { type: "ready-operations" }
      }

      const prioritizedActions =
        game.currentPhase === "operations" &&
        claimedRouteCountThisTurn < stageClaimBudget &&
        availableActions.some(action => action.type === "claim-route")
          ? availableActions.filter(action => action.type === "claim-route")
          : availableActions

      // Compute the bureaucracy summary when there are pod/vehicle/removal actions to score.
      const hasPodActions = prioritizedActions.some(
        a =>
          a.type === "create-service-pod" ||
          a.type === "remove-pod-city" ||
          a.type === "assign-pod-vehicle" ||
          a.type === "add-second-vehicle-to-pod" ||
          a.type === "exchange-vehicle",
      )
      const hasBuyVehicleActions = prioritizedActions.some(a => a.type === "buy-vehicle")
      const needsSummary = hasPodActions || hasBuyVehicleActions
      const precomputedSummary = needsSummary ? getCachedBureaucracySummary(game, playerId) : undefined
      const plannedActionScores = getPlannedOperationsActionScores(
        game,
        playerId,
        resolvedWeights,
        prioritizedActions,
        precomputedSummary,
      )
      const bestAction = prioritizedActions.reduce<{ action: BotAction; score: number } | null>(
        (best, action) => {
          const score = getBotActionSelectionScore(
            action,
            game,
            playerId,
            resolvedWeights,
            precomputedSummary,
            plannedActionScores,
          )
          return best === null || score > best.score ? { action, score } : best
        },
        null,
      )
      return bestAction?.action ?? { type: "end-turn" }
    },
  }
}

// ── Coaching support: score breakdown and ranked candidates ──────────────────

export type ClaimRouteScoreBreakdown = {
  total: number
  modeBase: number
  populationScore: number
  newCityBonus: number
  firstModeBonus: number
  regionPreference: number
  sameRegionLinkBonus: number
  longDistancePreference: number
  newRegionBonus: number
  adjacentNetworkCount: number
  adjacentNetworkBonus: number
  opponentBlockCount: number
  opponentBlockPenalty: number
  connectorWastePenalty: number
  disconnectedRailPenalty: number
  costPenalty: number
}

export type KeepCityScoreBreakdown = {
  kind: "keep-city"
  totalPopulation: number
  populationScore: number
  populationWeight: number
  avgDistanceMiles: number | null   // null when no owned cities yet
  networkProximityScore: number
  networkProximityWeight: number
  regionMatchCount: number
  regionMatchScore: number
  regionMatchWeight: number
  topRegion: string | null
  adjacencyPotential: number        // net unclaimed - 2×opponent-claimed adjacent routes
  adjacencyPotentialScore: number
  adjacencyPotentialWeight: number
}

export type DrawCityScoreBreakdown = {
  kind: "draw-city"
  region: string
  deckSize: number
  deckSizeScore: number
  ownedInRegion: number
  ownedInRegionScore: number
  opponentCitiesInRegion: number
  opponentPenalty: number
  bigCityScarcitySignal: number
  bigCityScarcityScore: number
}

export type BuyVehicleScoreBreakdown = {
  kind: "buy-vehicle"
  cardNumber: number
  cardName: string
  vehicleType: string
  typePriority: number
  totalPassengerCapacity: number
  speed: number
  operatingCostMultiplier: number
  purchasePriceM: number      // price in millions
  pricePenalty: number
  cityBonus: number
  cityBonusReason: string
  duplicatePenalty: number
  duplicateCount: number
  firstOfTypeBonus: number
}

export type ScoredBotCandidate = {
  action: BotAction
  score: number
  label: string
  breakdown: ClaimRouteScoreBreakdown | KeepCityScoreBreakdown | BuyVehicleScoreBreakdown | DrawCityScoreBreakdown | null
}

function getClaimRouteBreakdown(
  action: Extract<BotAction, { type: "claim-route" }>,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: ScriptedBotWeights,
): ClaimRouteScoreBreakdown {
  const stage = getBotGameStage(game)
  const cityMap = new Map(game.cities.map(city => [city.id, city]))
  const existingRoutesOfMode = getPlayerOwnedNetworkRoutes(game, playerId).filter(
    route => route.mode === action.mode,
  )
  const connectedCityIdSet = new Set(
    existingRoutesOfMode.flatMap(route => [route.cityA, route.cityB]),
  )
  const totalPopulation = action.cityIds.reduce(
    (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
    0,
  )
  const newCityCount = action.cityIds.filter(cityId => !connectedCityIdSet.has(cityId)).length
  const candidateRegions = action.cityIds
    .map(cityId => getPrimaryRegion(cityMap.get(cityId)))
    .filter((region): region is CityDeckRegion => region !== null)
  const connectedRegions = new Set(
    [...connectedCityIdSet]
      .map(cityId => getPrimaryRegion(cityMap.get(cityId)))
      .filter((region): region is CityDeckRegion => region !== null),
  )
  const newRegionCount = [...new Set(candidateRegions)].filter(region => !connectedRegions.has(region)).length
  const cost = calculateClaimRouteCost(game, { mode: action.mode, cityIds: action.cityIds })
  const regionPreferenceScore = candidateRegions.reduce(
    (total, region) => total + getRegionPreference(region, weights),
    0,
  )
  const sameRegionLinkBonus =
    action.cityIds.length >= 2 &&
    candidateRegions.length === action.cityIds.length &&
    new Set(candidateRegions).size === 1
      ? weights.claimSameRegionLinkBonus
      : 0
  const resolvedSelection = resolveRouteSelection(game, action.cityIds, action.mode)
  const totalDistanceMiles =
    resolvedSelection.ok
      ? resolvedSelection.segmentPairs.reduce((total, [cityAId, cityBId]) => {
          const cityA = cityMap.get(cityAId)
          const cityB = cityMap.get(cityBId)
          return cityA && cityB ? total + calculateDistanceMiles(cityA, cityB) : total
        }, 0)
      : 0

  const modeBase = action.mode === "rail" ? weights.claimRailBaseScore : weights.claimAirBaseScore
  const populationScore =
    (totalPopulation / 1_000_000) * weights.claimPopulationPerMillionScore *
    getStageWeight(stage, weights, "PopulationMultiplier")
  const newCityBonus =
    newCityCount * weights.claimNewCityBonus * getStageWeight(stage, weights, "ExpansionMultiplier")
  const firstModeBonus =
    existingRoutesOfMode.length === 0
      ? weights.claimFirstModeBonus * getStageWeight(stage, weights, "ExpansionMultiplier")
      : 0
  const longDistancePreference =
    getPayoutMultiplierForDistance(totalDistanceMiles) * weights.claimLongDistancePreference
  const newRegionBonus =
    newRegionCount * weights.claimNewRegionBonus * getStageWeight(stage, weights, "ExpansionMultiplier")
  const costPenalty = (cost / 1_000_000) * weights.claimRailCostPenaltyPerMillion
  const connectorWastePenalty =
    (getRailConnectorWastePenalty(action, game, playerId, connectedCityIdSet, cityMap) / 1_000_000) *
    weights.claimConnectorWastePenaltyMultiplier
  const summary = getCachedBureaucracySummary(game, playerId)
  const assignedTrainCardIds = new Set(
    summary?.routePlans
      .filter(plan => !plan.isDisconnected && plan.route.mode === "rail" && plan.vehicleCard?.type === "train")
      .map(plan => plan.vehicleCard!.id) ?? [],
  )
  const unassignedTrainCount = getPlayerById(game, playerId)?.ownedVehicleCardIds.filter(cardId => {
    const card = game.vehicleCatalog.find(vehicleCard => vehicleCard.id === cardId)
    return card?.type === "train" && !assignedTrainCardIds.has(cardId)
  }).length ?? 0
  const isDisconnectedRailExpansion =
    action.mode === "rail" &&
    existingRoutesOfMode.length > 0 &&
    action.cityIds.every(cityId => !connectedCityIdSet.has(cityId))
  const disconnectedRailPenalty =
    isDisconnectedRailExpansion && unassignedTrainCount <= 0
      ? weights.claimDisconnectedRailPenalty
      : 0

  const candidateCityIdSetBreakdown = new Set(action.cityIds)
  const allPlayerRoutesBreakdown = getPlayerOwnedNetworkRoutes(game, playerId)
  const adjacentNetworkCount = allPlayerRoutesBreakdown.filter(
    r => candidateCityIdSetBreakdown.has(r.cityA) || candidateCityIdSetBreakdown.has(r.cityB),
  ).length
  const adjacentNetworkBonus = adjacentNetworkCount * weights.claimAdjacentNetworkBonus
  const opponentBlockCount = game.routes.filter(
    r => r.ownerId && r.ownerId !== playerId &&
      (candidateCityIdSetBreakdown.has(r.cityA) || candidateCityIdSetBreakdown.has(r.cityB)),
  ).length
  const opponentBlockPenalty = opponentBlockCount * weights.claimOpponentBlockPenalty

  return {
    total: modeBase + populationScore + newCityBonus + firstModeBonus + regionPreferenceScore +
      sameRegionLinkBonus + longDistancePreference + newRegionBonus +
    adjacentNetworkBonus - opponentBlockPenalty - connectorWastePenalty - disconnectedRailPenalty - costPenalty,
    modeBase,
    populationScore,
    newCityBonus,
    firstModeBonus,
    regionPreference: regionPreferenceScore,
    sameRegionLinkBonus,
    longDistancePreference,
    newRegionBonus,
    adjacentNetworkCount,
    adjacentNetworkBonus,
    opponentBlockCount,
    opponentBlockPenalty,
    connectorWastePenalty,
    disconnectedRailPenalty,
    costPenalty,
  }
}

function getDrawCityBreakdown(
  action: Extract<BotAction, { type: "draw-city-offer" }>,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: ScriptedBotWeights,
): DrawCityScoreBreakdown {
  const player = getPlayerById(game, playerId)
  const region = action.region as import("../engine/types").CityDeckRegion
  const deckSize = game.cityDeckCardIdsByRegion[region]?.length ?? 0
  const ownedInRegion = player
    ? player.ownedCityCardIds.filter(id => game.cities.find(c => c.id === id)?.region?.includes(region)).length
    : 0
  const opponentCitiesInRegion = game.players
    .filter(p => p.id !== playerId)
    .reduce((total, p) => total + p.ownedCityCardIds.filter(id =>
      game.cities.find(c => c.id === id)?.region?.includes(region)
    ).length, 0)
  const remainingCitiesInDeck = (game.cityDeckCardIdsByRegion[region] ?? [])
    .map(id => game.cities.find(c => c.id === id)).filter(Boolean)
  const avgPopRemaining = remainingCitiesInDeck.length > 0
    ? remainingCitiesInDeck.reduce((s, c) => s + (c!.population ?? 0), 0) / remainingCitiesInDeck.length
    : 0
  const bigCityScarcitySignal = deckSize > 0 && deckSize <= 6 ? avgPopRemaining / 1_000_000 : 0

  return {
    kind: "draw-city",
    region,
    deckSize,
    deckSizeScore: deckSize * weights.drawRegionDeckSizeScore,
    ownedInRegion,
    ownedInRegionScore: ownedInRegion * weights.drawRegionOwnedCityBonus,
    opponentCitiesInRegion,
    opponentPenalty: opponentCitiesInRegion * weights.drawRegionOpponentCityPenalty,
    bigCityScarcitySignal,
    bigCityScarcityScore: bigCityScarcitySignal * weights.drawRegionBigCityScarcityBonus,
  }
}

function getKeepCityBreakdown(
  action: Extract<BotAction, { type: "keep-city-offer" }>,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: ScriptedBotWeights,
): KeepCityScoreBreakdown {
  const player = getPlayerById(game, playerId)
  const cityMap = new Map(game.cities.map(c => [c.id, c]))
  const chosenCities = action.cityIds.map(id => cityMap.get(id)).filter(Boolean) as import("../engine/types").City[]
  const ownedCities = player
    ? (player.ownedCityCardIds.map(id => cityMap.get(id)).filter(Boolean) as import("../engine/types").City[])
    : []

  const totalPopulation = chosenCities.reduce((s, c) => s + (c.population ?? 0), 0)

  let networkProximityScore = 0
  let avgDistanceMiles: number | null = null
  if (ownedCities.length > 0) {
    const avgMinDist = chosenCities.reduce((sum, city) => {
      const minDist = Math.min(...ownedCities.map(owned => calculateDistanceMiles(city, owned)))
      return sum + minDist
    }, 0) / chosenCities.length
    avgDistanceMiles = Math.round(avgMinDist)
    networkProximityScore = Math.max(0, 2000 - avgMinDist) / 100
  }

  const regionCounts = new Map<string, number>()
  for (const id of (player?.ownedCityCardIds ?? [])) {
    for (const r of (cityMap.get(id)?.region ?? [])) {
      regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1)
    }
  }
  const topRegion = [...regionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const regionMatchCount = topRegion
    ? chosenCities.filter(c => c.region?.includes(topRegion)).length
    : 0

  const adjacencyPotential = chosenCities.reduce((sum, city) => {
    const adjacentRoutes = game.routes.filter(r => r.cityA === city.id || r.cityB === city.id)
    const unclaimed = adjacentRoutes.filter(r => !r.ownerId).length
    const opponentOwned = adjacentRoutes.filter(r => r.ownerId && r.ownerId !== playerId).length
    return sum + unclaimed - opponentOwned * 2
  }, 0)

  return {
    kind: "keep-city",
    totalPopulation,
    populationScore: (totalPopulation / 1_000_000) * weights.keepCityPopulationScore,
    populationWeight: weights.keepCityPopulationScore,
    avgDistanceMiles,
    networkProximityScore: networkProximityScore * weights.keepCityNetworkProximityScore,
    networkProximityWeight: weights.keepCityNetworkProximityScore,
    regionMatchCount,
    regionMatchScore: regionMatchCount * weights.keepCityRegionMatchScore,
    regionMatchWeight: weights.keepCityRegionMatchScore,
    topRegion,
    adjacencyPotential,
    adjacencyPotentialScore: adjacencyPotential * weights.keepCityAdjacencyPotentialScore,
    adjacencyPotentialWeight: weights.keepCityAdjacencyPotentialScore,
  }
}

function getBuyVehicleBreakdown(
  action: Extract<BotAction, { type: "buy-vehicle" }>,
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: ScriptedBotWeights,
): BuyVehicleScoreBreakdown {
  const player = getPlayerById(game, playerId)
  const card = game.vehicleCatalog.find(c => c.id === action.cardId)
  const quantity = Math.max(1, action.quantity)

  if (!player || !card) {
    return {
      kind: "buy-vehicle",
      cardNumber: 0, cardName: "unknown", vehicleType: "bus",
      typePriority: 0, totalPassengerCapacity: 0, speed: 0,
      operatingCostMultiplier: 1, purchasePriceM: 0, pricePenalty: 0,
      cityBonus: 0, cityBonusReason: "", duplicatePenalty: 0,
      duplicateCount: 0, firstOfTypeBonus: 0,
    }
  }

  const ownedCityCount = player.ownedCityCardIds.length
  const ownedVehicleCount = player.ownedVehicleCardIds
    .map(id => game.vehicleCatalog.find(c => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c != null && c.type === card.type).length

  const potentialRailClaims = countPotentialClaims(game, playerId, "rail")
  const potentialAirClaims = countPotentialClaims(game, playerId, "air")
  const ownedRailRouteCount = getPlayerOwnedNetworkRoutes(game, playerId).filter(route => route.mode === "rail").length
  const routePlans = getCachedBureaucracySummary(game, playerId)?.routePlans ?? []
  const hasRailServiceOpportunity =
    ownedRailRouteCount > 0 ||
    routePlans.some(
      plan => !plan.isDisconnected && plan.route.mode === "rail" && plan.selectedCityIds.length >= 2,
    )

  const { cityBonus, cityBonusReason } = (() => {
    if (card.type === "bus") {
      return {
        cityBonus: Math.min(ownedCityCount, 6) * weights.buyBusOwnedCityBonus,
        cityBonusReason: `${Math.min(ownedCityCount, 6)} owned cities × ${weights.buyBusOwnedCityBonus}`,
      }
    }

    if (card.type === "train") {
      if (potentialRailClaims > 0) {
        return {
          cityBonus: weights.buyTrainPotentialClaimBonus,
          cityBonusReason: `${potentialRailClaims} rail claim opportunities`,
        }
      }

      if (hasRailServiceOpportunity && ownedCityCount >= 4) {
        return {
          cityBonus: weights.buyTrainFallbackOwnedCityBonus,
          cityBonusReason: "fallback: existing rail network/service pod can use another train",
        }
      }

      return {
        cityBonus: -weights.buyTrainNoClaimPenalty * 4,
        cityBonusReason: "penalty: no rail claims or existing rail network to justify a train",
      }
    }

    if (potentialAirClaims > 0) {
      return {
        cityBonus: weights.buyAirPotentialClaimBonus,
        cityBonusReason: `${potentialAirClaims} air claim opportunities`,
      }
    }

    if (ownedCityCount >= 5) {
      return {
        cityBonus: weights.buyAirFallbackOwnedCityBonus,
        cityBonusReason: "fallback: ≥5 owned cities, no air claims yet",
      }
    }

    return {
      cityBonus: -weights.buyAirNoClaimPenalty,
      cityBonusReason: "penalty: no air claims available",
    }
  })()

  const firstOfTypeBonus =
    card.type === "train"
      ? ownedVehicleCount === 0 && potentialRailClaims > 0 ? weights.buyFirstTrainBonus : 0
      : card.type === "air"
        ? ownedVehicleCount === 0 && potentialAirClaims > 0 ? weights.buyFirstAirBonus : 0
        : 0
  const duplicatePenalty =
    Array.from({ length: quantity }, (_, index) => ownedVehicleCount + index)
      .reduce((sum, count) => sum + count * weights.buyDuplicateVehiclePenalty, 0)

  return {
    kind: "buy-vehicle",
    cardNumber: card.number,
    cardName: card.name,
    vehicleType: card.type,
    typePriority: getVehiclePriority(card.type, weights),
    totalPassengerCapacity: card.totalPassengerCapacity * quantity,
    speed: card.speed,
    operatingCostMultiplier: card.operatingCostMultiplier,
    purchasePriceM: (card.purchasePrice * quantity) / 1_000_000,
    pricePenalty: (card.purchasePrice * quantity) / 1_000_000,
    cityBonus: cityBonus * quantity,
    cityBonusReason,
    duplicatePenalty,
    duplicateCount: ownedVehicleCount,
    firstOfTypeBonus,
  }
}

function getBotActionLabel(
  action: BotAction,
  game: Parameters<BotController["pickAction"]>[0]["game"],
): string {
  const cityMap = new Map(game.cities.map(c => [c.id, c]))
  switch (action.type) {
    case "claim-route": {
      const cityNames = action.cityIds.map(id => cityMap.get(id)?.name ?? id).join(" → ")
      return `Build ${action.mode}: ${cityNames}`
    }
    case "create-service-pod": {
      const cityNames = action.cityIds.map(id => cityMap.get(id)?.name ?? id).join(" – ")
      return `Proposed pod: ${cityNames}`
    }
    case "exchange-vehicle": {
      const newCard = game.vehicleCatalog.find(c => c.id === action.newCardId)
      const oldCard = game.vehicleCatalog.find(c => c.id === action.oldCardId)
      if (newCard && oldCard) {
        return `Replace #${oldCard.number} ${oldCard.name} with #${newCard.number} ${newCard.name}`
      }
      return `Replace vehicle ${action.oldCardId} with ${action.newCardId}`
    }
    case "buy-vehicle": {
      const card = game.vehicleCatalog.find(c => c.id === action.cardId)
      return card
        ? `Buy ${action.quantity}× #${card.number} ${card.name} (${card.type})`
        : `Buy vehicle ${action.cardId}`
    }
    case "draw-city-offer":
      return `Draw city cards from ${action.region} deck`
    case "keep-city-offer": {
      const cityNames = action.cityIds.map(id => cityMap.get(id)?.name ?? id).join(" + ")
      return `Keep cities: ${cityNames}`
    }
    case "ready-operations":
      return "Finish operations planning"
    case "ready-bureaucracy":
      return "Finish bureaucracy review"
    case "end-turn":
      return "End turn"
    case "confirm-add-city-picks":
      return "Confirm city picks"
    case "remove-pod-city": {
      const cityName = cityMap.get(action.cityId)?.name ?? action.cityId
      return `Remove ${cityName} from pod`
    }
    default:
      return (action as { type: string }).type
  }
}

/** Returns the top N scored candidates for a bot's current turn, with score breakdowns. */
export function getTopScoredBotCandidates(
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: Partial<ScriptedBotWeights>,
  topN = 5,
): ScoredBotCandidate[] {
  const resolvedWeights = mergeScriptedBotWeights(weights)
  const legalActions = getBotLegalActions(game, playerId)
  const hasPodActions = legalActions.some(
    a =>
      a.type === "create-service-pod" ||
      a.type === "remove-pod-city" ||
      a.type === "assign-pod-vehicle" ||
      a.type === "add-second-vehicle-to-pod" ||
      a.type === "exchange-vehicle",
  )
  const precomputedSummary = hasPodActions ? getCachedBureaucracySummary(game, playerId) : undefined
  const plannedActionScores = getPlannedOperationsActionScores(
    game,
    playerId,
    resolvedWeights,
    legalActions,
    precomputedSummary,
  )

  return legalActions
    .map(action => {
      const score = getBotActionSelectionScore(
        action,
        game,
        playerId,
        resolvedWeights,
        precomputedSummary,
        plannedActionScores,
      )
      const breakdown =
        action.type === "claim-route"
          ? getClaimRouteBreakdown(action, game, playerId, resolvedWeights)
          : action.type === "draw-city-offer"
          ? getDrawCityBreakdown(action, game, playerId, resolvedWeights)
          : action.type === "keep-city-offer"
          ? getKeepCityBreakdown(action, game, playerId, resolvedWeights)
          : action.type === "buy-vehicle"
          ? getBuyVehicleBreakdown(action, game, playerId, resolvedWeights)
          : null
      return {
        action,
        score,
        label: getBotActionLabel(action, game),
        breakdown,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}

export type OperationsPlan = {
  routes: Array<{ mode: string; cityNames: string[] }>
  pods: Array<{ cityNames: string[] }>
  otherLabels: string[]
}

/**
 * Simulate the bot's entire upcoming operations sequence and return a summary
 * of what routes it plans to build and what pods it will create/modify.
 */
export function simulateOperationsPlan(
  game: Parameters<BotController["pickAction"]>[0]["game"],
  playerId: string,
  weights: Partial<ScriptedBotWeights>,
  maxSteps = 20,
): OperationsPlan {
  const resolvedWeights = mergeScriptedBotWeights(weights)
  const cityMap = new Map(game.cities.map(c => [c.id, c]))
  const routes: OperationsPlan["routes"] = []
  const pods: OperationsPlan["pods"] = []
  const otherLabels: string[] = []

  let currentGame = game
  for (let step = 0; step < maxSteps; step++) {
    const legalActions = getBotLegalActions(currentGame, playerId)
    if (legalActions.length === 0) break

    const hasPodActions = legalActions.some(
      a =>
        a.type === "create-service-pod" ||
        a.type === "remove-pod-city" ||
        a.type === "assign-pod-vehicle" ||
        a.type === "add-second-vehicle-to-pod" ||
        a.type === "exchange-vehicle",
    )
    const precomputedSummary = hasPodActions ? getCachedBureaucracySummary(currentGame, playerId) : undefined
    const plannedActionScores = getPlannedOperationsActionScores(
      currentGame,
      playerId,
      resolvedWeights,
      legalActions,
      precomputedSummary,
    )

    const scored = legalActions
      .map(action => ({
        action,
        score: getBotActionSelectionScore(
          action,
          currentGame,
          playerId,
          resolvedWeights,
          precomputedSummary,
          plannedActionScores,
        ),
      }))
      .sort((a, b) => b.score - a.score)
    const topAction = scored[0]?.action
    if (!topAction) break

    if (topAction.type === "ready-operations" || topAction.type === "end-turn") break

    if (topAction.type === "claim-route") {
      routes.push({ mode: topAction.mode, cityNames: topAction.cityIds.map(id => cityMap.get(id)?.name ?? id) })
    } else if (topAction.type === "create-service-pod") {
      pods.push({ cityNames: topAction.cityIds.map(id => cityMap.get(id)?.name ?? id) })
    } else if (topAction.type !== "confirm-add-city-picks" && topAction.type !== "remove-pod-city") {
      otherLabels.push(getBotActionLabel(topAction, currentGame))
    }

    try {
      currentGame = applyBotAction(currentGame, playerId, topAction)
    } catch {
      break
    }
  }

  return { routes, pods, otherLabels }
}
