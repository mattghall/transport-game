import {
  addBureaucracyServiceSplit,
  advanceTurn,
  buyVehicleCard,
  canPlayerEditOperations,
  canPlayerPickCities,
  canPlayerStartPhaseByPipeline,
  calculateClaimRouteCost,
  claimRoute,
  exchangeVehicleCard,
  getConnectionOptions,
  getPlayerById,
  confirmAddCityPicks,
  drawCityOffer,
  deleteBureaucracyServicePod,
  getRequiredCityKeepCount,
  getVehiclePurchaseLimit,
  getVehicleTradeInValue,
  getVisibleVehicleMarketCardIds,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedAddCity,
  markBureaucracyReady,
  markOperationsReady,
  moveBureaucracyServiceCity,
  setBureaucracyServicePodCities,
  setBureaucracyRouteVehicleCard,
  setActiveCityOfferKeptCityIds,
} from "../engine/actions"
import {
  buildServiceSlotId,
  buildDisconnectedServiceSlotId,
  isValidServicePodSelection,
} from "../engine/bureaucracy"
import { getPlayerOwnedNetworkRoutes } from "../engine/playerNetwork"
import { CITY_DECK_REGIONS, type GameState } from "../engine/types"
import { getOwnedCityPairs } from "./strategy"
import { getCachedBureaucracySummary } from "./summaryCache"
import type { BotAction } from "./types"

const MAX_BOT_OPERATION_CLAIM_ACTIONS = 16
const MAX_BOT_OPERATION_POD_ACTIONS_PER_CORRIDOR = 6
const MAX_BOT_OPERATION_POD_SIZE = 4
const MAX_BOT_OPERATION_POD_SEEDS = 4
const MAX_BOT_OPERATION_POD_REMOVE_ACTIONS_PER_PLAN = 2
const MAX_BOT_OPERATION_POD_PRUNE_BEAM = 6
const servicePodCandidateCache = new WeakMap<GameState, Map<string, string[][]>>()

function getAvailableBotVehicleActions(game: GameState, playerId: string): BotAction[] {
  const player = getPlayerById(game, playerId)

  if (!player || game.purchasedVehiclePlayerIds.includes(player.id)) {
    return []
  }

  if (!canPlayerStartPhaseByPipeline(game, playerId, "purchase-equipment")) {
    return []
  }

  const buyableCardIds = [...new Set([
    ...getVisibleVehicleMarketCardIds(game),
    ...player.ownedVehicleCardIds,
  ])]

  const buyActions: BotAction[] = buyableCardIds
    .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
    .filter((card): card is GameState["vehicleCatalog"][number] => card !== null && card.purchasePrice <= player.money)
    .flatMap(card => {
      const maxAffordableQuantity = Math.floor(player.money / card.purchasePrice)
      const maxQuantity = Math.max(1, Math.min(getVehiclePurchaseLimit(card.type), maxAffordableQuantity))
      return Array.from({ length: maxQuantity }, (_, index) => ({
        type: "buy-vehicle" as const,
        cardId: card.id,
        quantity: index + 1,
      }))
    })

  // Exchange actions: trade an owned vehicle for a market vehicle
  const exchangeActions: BotAction[] = getVisibleVehicleMarketCardIds(game)
    .flatMap(newCardId => {
      const newCard = game.vehicleCatalog.find(c => c.id === newCardId)
      if (!newCard || player.ownedVehicleCardIds.includes(newCardId)) return []
      return player.ownedVehicleCardIds.flatMap(oldCardId => {
        const oldCard = game.vehicleCatalog.find(c => c.id === oldCardId)
        if (!oldCard || oldCard.type !== newCard.type) return []
        const weeksOwned = player.vehicleWeeksOwnedByCardId[oldCardId] ?? 0
        const tradeInValue = getVehicleTradeInValue(oldCard, weeksOwned)
        const cost = Math.max(0, newCard.purchasePrice - tradeInValue)
        if (player.money < cost) return []
        // Only consider upgrades (new card costs more at purchase, indicating better stats)
        if (newCard.purchasePrice <= oldCard.purchasePrice) return []
        return [{ type: "exchange-vehicle" as const, newCardId, oldCardId }]
      })
    })

  return [...buyActions, ...exchangeActions]
}

function getAvailableClaimActions(game: GameState, playerId: string): BotAction[] {
  if (hasPlayerCompletedAddCity(game, playerId)) {
    return []
  }

  if (!canPlayerPickCities(game, playerId)) {
    return []
  }

  if (!game.activeCityOffer) {
    // Generate one draw action per region so the scorer can pick the best
    return CITY_DECK_REGIONS
      .filter(region => (game.cityDeckCardIdsByRegion[region]?.length ?? 0) > 0)
      .map(region => ({ type: "draw-city-offer" as const, region }))
  }

  // Another player owns this offer — wait for them to finish
  if (game.activeCityOffer.playerId !== playerId) {
    return []
  }

  const keptCityIds = game.activeCityOffer.keptCityIds
  const offerCityIds = game.activeCityOffer.cityIds
  const requiredKeepCount = getRequiredCityKeepCount(game)

  if (keptCityIds.length === requiredKeepCount) {
    return [{ type: "confirm-add-city-picks" }]
  }

  if (requiredKeepCount <= 0) {
    return [{ type: "confirm-add-city-picks" }]
  }

  // Generate all C(n,k) combinations from the offer so the scorer picks the best keep set.
  const combos: BotAction[] = []

  function buildCombinations(startIndex: number, selectedCityIds: string[]) {
    if (selectedCityIds.length === requiredKeepCount) {
      combos.push({ type: "keep-city-offer", cityIds: [...selectedCityIds] })
      return
    }

    for (let index = startIndex; index < offerCityIds.length; index += 1) {
      selectedCityIds.push(offerCityIds[index])
      buildCombinations(index + 1, selectedCityIds)
      selectedCityIds.pop()
    }
  }

  buildCombinations(0, [])
  return combos
}

function getAvailableOperationsActions(game: GameState, playerId: string): BotAction[] {
  if (!canPlayerEditOperations(game, playerId)) {
    return []
  }

  const cityMap = new Map(game.cities.map(city => [city.id, city]))
  const player = getPlayerById(game, playerId)
  const railConstructionCostPerMile = game.operatingConfig.railConstructionCostPerMile
  const claimActions = getOwnedCityPairs(game, playerId).flatMap(([cityAId, cityBId]) => {
    const cityA = cityMap.get(cityAId)
    const railPairIsAdjacent = cityA?.adjacentCities?.some(adjacentCity => adjacentCity.id === cityBId) ?? false

    return getConnectionOptions(game, [cityAId, cityBId], playerId)
      .filter(option => option.valid && (option.mode === "rail" || option.mode === "air"))
      .filter((option): option is { mode: "rail" | "air"; valid: true } => option.mode === "rail" || option.mode === "air")
      .filter(option => option.mode !== "rail" || railPairIsAdjacent)
      .filter(option => {
        if (!player) {
          return false
        }

        const cost = calculateClaimRouteCost(
          game,
          {
            mode: option.mode,
            cityIds: [cityAId, cityBId],
          },
          playerId,
        )

        return cost <= player.money
      })
      .map(option => ({
        type: "claim-route" as const,
        mode: option.mode,
        cityIds: [cityAId, cityBId] as [string, string],
      }))
  }).sort((actionA, actionB) => {
    const getConnectorWastePenalty = (action: typeof actionA, connectedCityIdSet: Set<string>) => {
      if (action.mode !== "rail" || !player) {
        return 0
      }

      const newCityIds = action.cityIds.filter(cityId => !connectedCityIdSet.has(cityId))

      if (newCityIds.length !== 1) {
        return 0
      }

      const newCityId = newCityIds[0]
      const newCity = cityMap.get(newCityId)

      if (!newCity) {
        return 0
      }

      const currentCost = calculateClaimRouteCost(game, action, playerId)
      const connectedOwnedCityIds = player.ownedCityCardIds.filter(cityId => connectedCityIdSet.has(cityId))
      let cheapestConnectorCost = Number.POSITIVE_INFINITY

      for (const adjacentCity of newCity.adjacentCities ?? []) {
        if (!connectedOwnedCityIds.includes(adjacentCity.id)) {
          continue
        }

        cheapestConnectorCost = Math.min(
          cheapestConnectorCost,
          adjacentCity.distance * railConstructionCostPerMile,
        )
      }

      return Number.isFinite(cheapestConnectorCost)
        ? Math.max(0, currentCost - cheapestConnectorCost)
        : 0
    }

    const getClaimPriority = (action: typeof actionA) => {
      const ownedRoutesOfMode = getPlayerOwnedNetworkRoutes(game, playerId).filter(
        route => route.mode === action.mode,
      )
      const connectedCityIdSet = new Set(
        ownedRoutesOfMode.flatMap(route => [route.cityA, route.cityB]),
      )
      const totalPopulation = action.cityIds.reduce(
        (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
        0,
      )
      const newCityCount = action.cityIds.filter(cityId => !connectedCityIdSet.has(cityId)).length
      const adjacentOwnedRouteCount = ownedRoutesOfMode.filter(
        route => action.cityIds.includes(route.cityA) || action.cityIds.includes(route.cityB),
      ).length
      const railCost = action.mode === "rail" ? calculateClaimRouteCost(game, action, playerId) : 0
      const connectorWastePenalty = getConnectorWastePenalty(action, connectedCityIdSet)

      return (
        newCityCount * 1000 +
        (totalPopulation / 1_000_000) * 24 +
        adjacentOwnedRouteCount * 80 -
        (railCost / 1_000_000) * 10 -
        (connectorWastePenalty / 1_000_000) * 36
      )
    }

    return getClaimPriority(actionB) - getClaimPriority(actionA)
  }).slice(0, MAX_BOT_OPERATION_CLAIM_ACTIONS)

  const playerSummary = getCachedBureaucracySummary(game, playerId)
  const assignedVehicleCardIds = new Set(
    (playerSummary?.routePlans ?? [])
      .filter(plan => plan.selectedCityIds.length >= 2)
      .map(plan => plan.vehicleCard?.id ?? null)
      .filter((cardId): cardId is string => cardId !== null),
  )
  const unassignedOwnedVehicleCards = (player?.ownedVehicleCardIds ?? [])
    .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
    .filter((card): card is GameState["vehicleCatalog"][number] => card !== null && !assignedVehicleCardIds.has(card.id))
  const unassignedVehicleCountsByMode = unassignedOwnedVehicleCards.reduce<Record<"bus" | "rail" | "air", number>>(
    (counts, card) => {
      if (card.type === "bus") counts.bus += 1
      if (card.type === "train") counts.rail += 1
      if (card.type === "air") counts.air += 1
      return counts
    },
    { bus: 0, rail: 0, air: 0 },
  )
  const unstaffedPodCountsByMode = (playerSummary?.routePlans ?? []).reduce<Record<"bus" | "rail" | "air", number>>(
    (counts, plan) => {
      if (!plan.isDisconnected && plan.selectedCityIds.length >= 2 && !plan.vehicleCard) {
        counts[plan.route.mode] += 1
      }
      return counts
    },
    { bus: 0, rail: 0, air: 0 },
  )
  const remainingVehicleBudgetByMode = {
    bus: Math.max(0, unassignedVehicleCountsByMode.bus - unstaffedPodCountsByMode.bus),
    rail: Math.max(0, unassignedVehicleCountsByMode.rail - unstaffedPodCountsByMode.rail),
    air: Math.max(0, unassignedVehicleCountsByMode.air - unstaffedPodCountsByMode.air),
  }
  const podActions = playerSummary
    ? Array.from(
        playerSummary.routePlans.reduce((corridors, plan) => {
          const currentPlans = corridors.get(plan.corridorId) ?? []
          currentPlans.push(plan)
          corridors.set(plan.corridorId, currentPlans)
          return corridors
        }, new Map<string, typeof playerSummary.routePlans>()),
      ).flatMap(([, corridorPlans]) => {
        const representativePlan = corridorPlans[0]

        if (!representativePlan) {
          return []
        }

        const activePlans = corridorPlans.filter(plan => !plan.isDisconnected)
        const reusableEmptyPlan = activePlans.find(plan => plan.selectedCityIds.length === 0) ?? null
        const canAddSplitService = activePlans.some(plan => plan.canAddSplitService)

        const existingPodKeys = new Set(
          activePlans
            .filter(plan => plan.selectedCityIds.length >= 2)
            .map(plan => [...plan.selectedCityIds].sort().join("|")),
        )
        const demandByCityId = new Map<string, number>()
        for (const plan of corridorPlans) {
          for (const demand of plan.cityCubeDemands) {
            demandByCityId.set(
              demand.cityId,
              Math.max(demandByCityId.get(demand.cityId) ?? 0, demand.outboundCubes + demand.inboundCubes),
            )
          }
        }
        const cityMap = new Map(game.cities.map(city => [city.id, city]))
        const candidateCityIds = buildServicePodCandidates(
          game,
          representativePlan.availableCityIds,
          representativePlan.corridorSegmentPairs,
          cityMap,
          demandByCityId,
        )
          .filter(cityIds => !existingPodKeys.has([...cityIds].sort().join("|")))
        const createNewPodActions =
          remainingVehicleBudgetByMode[representativePlan.route.mode] <= 0 || (!reusableEmptyPlan && !canAddSplitService)
            ? []
            : candidateCityIds
                .slice(0, MAX_BOT_OPERATION_POD_ACTIONS_PER_CORRIDOR)
                .filter(cityIds => cityIds.some(cityId => (demandByCityId.get(cityId) ?? 0) > 0))
                .map(cityIds => ({
                  type: "create-service-pod" as const,
                  corridorId: representativePlan.corridorId,
                  routeId:
                    reusableEmptyPlan?.id ?? buildServiceSlotId(representativePlan.corridorId, activePlans.length),
                  cityIds,
                }))

        const expandExistingPodActions = activePlans
          .filter(plan => plan.selectedCityIds.length >= 2)
          .flatMap(plan =>
            candidateCityIds
              .filter(cityIds =>
                cityIds.length > plan.selectedCityIds.length &&
                plan.selectedCityIds.every(cityId => cityIds.includes(cityId)) &&
                cityIds.some(
                  cityId =>
                    !plan.selectedCityIds.includes(cityId) &&
                    (demandByCityId.get(cityId) ?? 0) > 0,
                ),
              )
              .slice(0, Math.max(1, Math.floor(MAX_BOT_OPERATION_POD_ACTIONS_PER_CORRIDOR / 2)))
              .map(cityIds => ({
                type: "create-service-pod" as const,
                corridorId: representativePlan.corridorId,
                routeId: plan.id,
                cityIds,
              })),
          )

        return [...createNewPodActions, ...expandExistingPodActions]
      })
    : []

  const removePodCityActions: BotAction[] = playerSummary
    ? playerSummary.routePlans
        .filter(
          plan =>
            !plan.isDisconnected &&
            plan.selectedCityIds.length >= 3 &&
            (plan.netRevenue ?? 0) < 0,
        )
        .flatMap(plan =>
          plan.selectedCityIds
            .filter(cityId => {
              const remaining = plan.selectedCityIds.filter(id => id !== cityId)
              return isValidServicePodSelection(remaining, plan.corridorSegmentPairs)
            })
            .sort((cityIdA, cityIdB) => {
              const popA = cityMap.get(cityIdA)?.population ?? cityMap.get(cityIdA)?.size ?? 0
              const popB = cityMap.get(cityIdB)?.population ?? cityMap.get(cityIdB)?.size ?? 0
              return popA - popB
            })
            .slice(0, MAX_BOT_OPERATION_POD_REMOVE_ACTIONS_PER_PLAN)
            .map(cityId => ({
              type: "remove-pod-city" as const,
              corridorId: plan.corridorId,
              cityId,
              sourceRouteId: plan.id,
            })),
        )
    : []

  // Assign unassigned vehicles to pods that have no vehicle yet — prefer highest-capacity match
  const unassignedOwnedVehicleCardIds = unassignedOwnedVehicleCards
    .map(card => card.id)
    .sort((a, b) => {
      const capA = game.vehicleCatalog.find(c => c.id === a)?.totalPassengerCapacity ?? 0
      const capB = game.vehicleCatalog.find(c => c.id === b)?.totalPassengerCapacity ?? 0
      return capB - capA
    })

  const assignVehicleActions: BotAction[] = playerSummary
    ? playerSummary.routePlans
        .filter(plan => !plan.isDisconnected && plan.selectedCityIds.length >= 2 && !plan.vehicleCard)
        .flatMap(plan => {
          const vehicleTypeForMode =
            plan.route.mode === "bus" ? "bus" : plan.route.mode === "rail" ? "train" : "air"
          const compatibleCard = unassignedOwnedVehicleCardIds.find(cardId => {
            const card = game.vehicleCatalog.find(c => c.id === cardId)
            return card?.type === vehicleTypeForMode
          })
          if (!compatibleCard) return []
          return [{ type: "assign-pod-vehicle" as const, routeId: plan.id, vehicleCardId: compatibleCard }]
        })
    : []

  // Add a second vehicle to high-demand pods (those with net revenue > 0 and unassigned matching vehicles)
  const addSecondVehicleActions: BotAction[] = playerSummary
    ? playerSummary.routePlans
        .filter(plan =>
          !plan.isDisconnected &&
          plan.selectedCityIds.length >= 2 &&
          plan.vehicleCard != null &&
          (plan.netRevenue ?? 0) > 0 &&
          plan.canAddSplitService,
        )
        .flatMap(plan => {
          const vehicleTypeForMode =
            plan.route.mode === "bus" ? "bus" : plan.route.mode === "rail" ? "train" : "air"
          // Prefer same card as the existing assignment (fleet uniformity), then highest capacity
          const compatibleCards = unassignedOwnedVehicleCardIds.filter(cardId => {
            const card = game.vehicleCatalog.find(c => c.id === cardId)
            return card?.type === vehicleTypeForMode
          })
          const compatibleCard = compatibleCards.find(id => id === plan.vehicleCard?.id) ?? compatibleCards[0]
          if (!compatibleCard) return []
          return [{
            type: "add-second-vehicle-to-pod" as const,
            corridorId: plan.corridorId,
            cityIds: plan.selectedCityIds,
            vehicleCardId: compatibleCard,
          }]
        })
    : []

  return [
    ...claimActions,
    ...podActions,
    ...removePodCityActions,
    ...assignVehicleActions,
    ...addSecondVehicleActions,
    { type: "ready-operations" },
  ]
}

function buildServicePodCandidates(
  game: GameState,
  availableCityIds: string[],
  corridorSegmentPairs: Array<[string, string]>,
  cityMap: Map<string, GameState["cities"][number]>,
  demandByCityId: Map<string, number>,
) {
  if (availableCityIds.length < 3) {
    return []
  }

  const maxPodSize = Math.min(MAX_BOT_OPERATION_POD_SIZE, availableCityIds.length - 1)

  if (maxPodSize < 2) {
    return []
  }

  const adjacency = new Map<string, string[]>(availableCityIds.map(cityId => [cityId, []]))

  for (const [cityAId, cityBId] of corridorSegmentPairs) {
    adjacency.get(cityAId)?.push(cityBId)
    adjacency.get(cityBId)?.push(cityAId)
  }

  const cityValue = (cityId: string) =>
    (demandByCityId.get(cityId) ?? 0) * 1_000_000 +
    (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0) * 100 +
    (adjacency.get(cityId)?.length ?? 0) * 10
  const byValueDesc = (cityIdA: string, cityIdB: string) =>
    cityValue(cityIdB) - cityValue(cityIdA) || cityIdA.localeCompare(cityIdB)
  const scoreCandidate = (cityIds: string[]) =>
    cityIds.reduce((total, cityId) => total + cityValue(cityId), 0) - Math.max(0, cityIds.length - 2) * 25
  const cacheKey = [
    availableCityIds.slice().sort().join("|"),
    corridorSegmentPairs.map(([cityAId, cityBId]) => `${cityAId}:${cityBId}`).sort().join("|"),
    [...demandByCityId.entries()].sort(([cityAId], [cityBId]) => cityAId.localeCompare(cityBId)).map(([cityId, demand]) => `${cityId}:${demand}`).join("|"),
  ].join("::")
  const cachedByGame = servicePodCandidateCache.get(game)

  if (cachedByGame?.has(cacheKey)) {
    return cachedByGame.get(cacheKey) ?? []
  }

  const seeds = [...availableCityIds].sort(byValueDesc).slice(0, MAX_BOT_OPERATION_POD_SEEDS)
  const candidates = new Map<string, string[]>()

  const visit = (path: string[]) => {
    if (path.length >= 2 && path.length <= maxPodSize && isValidServicePodSelection(path, corridorSegmentPairs)) {
      candidates.set([...path].sort().join("|"), [...path])
    }

    if (path.length >= maxPodSize) {
      return
    }

    const nextCityIds = [...new Set(path.flatMap(cityId => adjacency.get(cityId) ?? []))]
      .filter(cityId => !path.includes(cityId))
      .sort(byValueDesc)
      .slice(0, MAX_BOT_OPERATION_POD_SEEDS)

    for (const nextCityId of nextCityIds) {
      const nextPath = [...path, nextCityId]

      if (!isValidServicePodSelection(nextPath, corridorSegmentPairs)) {
        continue
      }

      visit(nextPath)
    }
  }

  for (const seedCityId of seeds) {
    visit([seedCityId])
  }

  let beam: string[][] = [[...availableCityIds].sort(byValueDesc)]
  const seenPruneStates = new Set(beam.map(cityIds => cityIds.slice().sort().join("|")))

  while (beam.length > 0) {
    const nextBeam = new Map<string, string[]>()

    for (const cityIds of beam) {
      if (cityIds.length >= 2 && cityIds.length <= maxPodSize && isValidServicePodSelection(cityIds, corridorSegmentPairs)) {
        candidates.set(cityIds.slice().sort().join("|"), cityIds)
      }

      if (cityIds.length <= 2) {
        continue
      }

      for (const cityId of [...cityIds].sort((cityIdA, cityIdB) => cityValue(cityIdA) - cityValue(cityIdB))) {
        const remainingCityIds = cityIds.filter(candidateCityId => candidateCityId !== cityId)
        const remainingKey = remainingCityIds.slice().sort().join("|")

        if (
          seenPruneStates.has(remainingKey) ||
          remainingCityIds.length < 2 ||
          !isValidServicePodSelection(remainingCityIds, corridorSegmentPairs)
        ) {
          continue
        }

        seenPruneStates.add(remainingKey)
        nextBeam.set(remainingKey, remainingCityIds)
      }
    }

    beam = [...nextBeam.values()]
      .sort((cityIdsA, cityIdsB) => scoreCandidate(cityIdsB) - scoreCandidate(cityIdsA))
      .slice(0, MAX_BOT_OPERATION_POD_PRUNE_BEAM)
  }

  const resolvedCandidates = [...candidates.values()].sort((cityIdsA, cityIdsB) =>
    scoreCandidate(cityIdsB) - scoreCandidate(cityIdsA) || cityIdsB.length - cityIdsA.length,
  )
  const nextCachedByGame = cachedByGame ?? new Map<string, string[][]>()
  nextCachedByGame.set(cacheKey, resolvedCandidates)
  servicePodCandidateCache.set(game, nextCachedByGame)
  return resolvedCandidates
}

function applyCreateServicePodAction(game: GameState, playerId: string, action: Extract<BotAction, { type: "create-service-pod" }>) {
  let nextGame = game
  let currentSummary = getCachedBureaucracySummary(nextGame, playerId)
  let targetPlan = currentSummary?.routePlans.find(plan => plan.id === action.routeId) ?? null

  if (!targetPlan) {
    const splitResult = addBureaucracyServiceSplit(nextGame, action.corridorId, playerId)

    if (!splitResult.ok) {
      throw new Error(splitResult.error)
    }

    nextGame = splitResult.game
    currentSummary = getCachedBureaucracySummary(nextGame, playerId)
    targetPlan = currentSummary?.routePlans.find(plan => plan.id === action.routeId) ?? null
  }

  if (!targetPlan) {
    throw new Error("The target service pod could not be created.")
  }

  const setCitiesResult = setBureaucracyServicePodCities(
    nextGame,
    action.corridorId,
    [action.routeId],
    action.cityIds,
    playerId,
  )

  if (!setCitiesResult.ok) {
    throw new Error(setCitiesResult.error)
  }

  return setCitiesResult.game
}

export function getBotLegalActions(game: GameState, playerId: string): BotAction[] {
  const player = getPlayerById(game, playerId)

  if (!player) {
    return []
  }

  switch (player.phase) {
    case "purchase-equipment":
      return canPlayerStartPhaseByPipeline(game, playerId, "purchase-equipment")
        ? [...getAvailableBotVehicleActions(game, playerId), { type: "end-turn" }]
        : []
    case "add-city": {
      const claimActions = getAvailableClaimActions(game, playerId)
      if (claimActions.length > 0) return claimActions
      return getAvailableOperationsActions(game, playerId)
    }
    case "operations":
      return getAvailableOperationsActions(game, playerId)
    case "bureaucracy":
      return hasPlayerCompletedBureaucracy(game, playerId) ? [] : [{ type: "ready-bureaucracy" }]
  }
}

export function applyBotAction(game: GameState, playerId: string, action: BotAction) {
  switch (action.type) {
    case "buy-vehicle": {
      const result = buyVehicleCard(game, action.cardId, action.quantity, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }

      return result.game
    }
    case "draw-city-offer": {
      const result = drawCityOffer(game, action.region, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }

      return result.game
    }
    case "keep-city-offer": {
      const result = setActiveCityOfferKeptCityIds(game, action.cityIds, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }

      return result.game
    }
    case "confirm-add-city-picks": {
      const result = confirmAddCityPicks(game, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }

      return result.game
    }
    case "claim-route": {
      const result = claimRoute(game, { mode: action.mode, cityIds: action.cityIds }, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }

      return result.game
    }
    case "create-service-pod":
      return applyCreateServicePodAction(game, playerId, action)
    case "remove-pod-city": {
      const disconnectedRouteId = buildDisconnectedServiceSlotId(action.corridorId)
      const result = moveBureaucracyServiceCity(
        game,
        action.corridorId,
        action.cityId,
        disconnectedRouteId,
        action.sourceRouteId,
        playerId,
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      return result.game
    }
    case "delete-service-pod": {
      const result = deleteBureaucracyServicePod(game, action.corridorId, action.routeId, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }
      return result.game
    }
    case "assign-pod-vehicle": {
      const result = setBureaucracyRouteVehicleCard(game, action.routeId, action.vehicleCardId, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }
      return result.game
    }
    case "add-second-vehicle-to-pod": {
      // Create a new slot for the same city set, then assign the vehicle to it
      const splitResult = addBureaucracyServiceSplit(game, action.corridorId, playerId, action.cityIds)
      if (!splitResult.ok) {
        throw new Error(splitResult.error)
      }
      // Find the newly created slot (no vehicle assigned, matching corridor and city set)
      const newSummary = getCachedBureaucracySummary(splitResult.game, playerId)
      const cityKey = [...action.cityIds].sort().join("|")
      const newSlot = newSummary?.routePlans.find(
        p =>
          !p.isDisconnected &&
          !p.vehicleCard &&
          p.corridorId === action.corridorId &&
          [...p.selectedCityIds].sort().join("|") === cityKey,
      )
      if (!newSlot) return splitResult.game
      const assignResult = setBureaucracyRouteVehicleCard(splitResult.game, newSlot.id, action.vehicleCardId, playerId)
      if (!assignResult.ok) {
        throw new Error(assignResult.error)
      }
      return assignResult.game
    }
    case "exchange-vehicle": {
      const result = exchangeVehicleCard(game, action.newCardId, action.oldCardId, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }
      return result.game
    }
    case "ready-operations": {
      const result = markOperationsReady(game, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }

      return result.game
    }
    case "ready-bureaucracy": {
      const result = markBureaucracyReady(game, playerId)
      if (!result.ok) {
        throw new Error(result.error)
      }

      return result.game
    }
    case "end-turn":
      return advanceTurn(game, playerId)
  }
}

export function getNextBotPlayerId(game: GameState) {
  return getPendingBotPlayerId(
    game,
    new Set(game.players.filter(player => player.isBot ?? true).map(player => player.id)),
  )
}

export function getPendingBotPlayerId(game: GameState, botPlayerIds: ReadonlySet<string>) {
  if (game.isGameOver) {
    return null
  }

  return game.players.find(player => botPlayerIds.has(player.id) && getBotLegalActions(game, player.id).length > 0)?.id ?? null
}
