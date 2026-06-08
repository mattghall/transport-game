import { getPlayerById, calculateClaimRouteCost, resolveRouteSelection } from "../engine/actions"
import { getPayoutMultiplierForDistance } from "../engine/bureaucracy"
import { getConnectedCityIds } from "../engine/economy"
import { getPlayerOwnedNetworkRoutes } from "../engine/playerNetwork"
import { CITY_DECK_REGIONS, type City, type CityDeckRegion, type VehicleType } from "../engine/types"
import { calculateDistanceMiles } from "../engine/trips"
import { getBotLegalActions } from "./actions"
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
  keepCityRegionMatchScore: number
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
  keepCityRegionMatchScore: 4,
}

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
  weights: ScriptedBotWeights,
) {
  const stage = getBotGameStage(game)
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
    newRegionCount * weights.claimNewRegionBonus * getStageWeight(stage, weights, "ExpansionMultiplier") -
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
    // Score based on population and demand from the already-cached summary — no simulation needed.
    // Using applyBotAction + nextSummary would be ~10x more expensive per candidate.
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

    return (
      weights.podSplitBaseScore +
      action.cityIds.length * weights.podCityCountScore +
      (totalPopulation / 1_000_000) * weights.podPopulationPerMillionScore +
      populationPerDistance * weights.podPopulationPerDistanceScore +
      podCombinedDemand * weights.podDemandScore +
      demandPerMile * weights.podDemandPerMileScore -
      Math.max(0, activePodCount - 1) * weights.podAdditionalRoutePenalty
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
      networkProximityScore * weights.keepCityNetworkProximityScore +
      regionMatchCount * weights.keepCityRegionMatchScore
    )
  }

  if (action.type !== "buy-vehicle") {
    if (action.type === "ready-operations") {
      return getStageWeight(stage, weights, "ReadyOperationsScore")
    }

    if (action.type === "end-turn") {
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
      ? Math.min(ownedCityCount, 6) * weights.buyBusOwnedCityBonus
      : card.type === "train"
        ? potentialRailClaims > 0
          ? weights.buyTrainPotentialClaimBonus
          : ownedCityCount >= 4
            ? weights.buyTrainFallbackOwnedCityBonus
            : -weights.buyTrainNoClaimPenalty
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

  return (
    getVehiclePriority(card.type, weights) +
    cityBonus -
    ownedVehicleCount * weights.buyDuplicateVehiclePenalty +
    firstOfTypeBonus -
    card.purchasePrice / 1_000_000
  )
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
        !availableActions.some(action => action.type === "create-service-pod") &&
        availableActions.some(action => action.type === "ready-operations")
      ) {
        return { type: "ready-operations" }
      }

      // Only compute the bureaucracy summary when there are pod/removal actions to score —
      // those are the only action types that need it. This avoids expensive calls on every
      // claim-route, buy-vehicle, add-city, and bureaucracy step.
      const hasPodActions = availableActions.some(
        a => a.type === "create-service-pod" || a.type === "remove-pod-city",
      )
      const precomputedSummary = hasPodActions ? getCachedBureaucracySummary(game, playerId) : undefined
      const bestAction = availableActions.reduce<{ action: BotAction; score: number } | null>(
        (best, action) => {
          const score = scoreBotAction(action, game, playerId, resolvedWeights, precomputedSummary)
          return best === null || score > best.score ? { action, score } : best
        },
        null,
      )
      return bestAction?.action ?? { type: "end-turn" }
    },
  }
}
