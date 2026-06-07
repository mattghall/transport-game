import {
  addBureaucracyServiceSplit,
  advanceTurn,
  buyVehicleCard,
  canPlayerEditOperations,
  claimRoute,
  getConnectionOptions,
  getPlayerById,
  confirmAddCityPicks,
  drawCityOffer,
  getVisibleVehicleMarketCardIds,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedOperations,
  hasPlayerCompletedAddCity,
  markBureaucracyReady,
  markOperationsReady,
  moveBureaucracyServiceCity,
  setActiveCityOfferKeptCityIds,
} from "../engine/actions"
import {
  buildServiceSlotId,
  buildDisconnectedServiceSlotId,
  isValidServicePodSelection,
} from "../engine/bureaucracy"
import { CITY_DECK_REGIONS, type CityDeckRegion, type GameState } from "../engine/types"
import { getOwnedCityPairs } from "./strategy"
import { getCachedBureaucracySummary } from "./summaryCache"
import type { BotAction } from "./types"

const MAX_BOT_OPERATION_CLAIM_ACTIONS = 8
const MAX_BOT_OPERATION_POD_ACTIONS_PER_CORRIDOR = 6
const MAX_BOT_OPERATION_POD_SIZE = 4
const MAX_BOT_OPERATION_POD_SEEDS = 4
const MAX_BOT_OPERATION_POD_REMOVE_ACTIONS_PER_PLAN = 2

function getAvailableBotVehicleActions(game: GameState, playerId: string): BotAction[] {
  const player = getPlayerById(game, playerId)

  if (!player || game.hasPurchasedVehicleThisTurn) {
    return []
  }

  return getVisibleVehicleMarketCardIds(game)
    .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
    .filter((card): card is GameState["vehicleCatalog"][number] => card !== null && card.purchasePrice <= player.money)
    .map(card => ({
      type: "buy-vehicle" as const,
      cardId: card.id,
      quantity: 1,
    }))
}

function getPreferredDrawRegion(game: GameState, playerId: string): CityDeckRegion {
  const player = getPlayerById(game, playerId)
  const regionPreferenceCounts = new Map<CityDeckRegion, number>(
    CITY_DECK_REGIONS.map(region => [region, 0]),
  )

  for (const cityId of player?.ownedCityCardIds ?? []) {
    const city = game.cities.find(candidate => candidate.id === cityId)
    const primaryRegion = city?.region?.[0]

    if (primaryRegion && regionPreferenceCounts.has(primaryRegion as CityDeckRegion)) {
      regionPreferenceCounts.set(
        primaryRegion as CityDeckRegion,
        (regionPreferenceCounts.get(primaryRegion as CityDeckRegion) ?? 0) + 1,
      )
    }
  }

  return [...CITY_DECK_REGIONS].sort((regionA, regionB) => {
    const deckDelta =
      game.cityDeckCardIdsByRegion[regionB].length - game.cityDeckCardIdsByRegion[regionA].length

    if (deckDelta !== 0) {
      return deckDelta
    }

    return (
      (regionPreferenceCounts.get(regionB) ?? 0) -
      (regionPreferenceCounts.get(regionA) ?? 0)
    )
  })[0]
}

function getAvailableClaimActions(game: GameState, playerId: string): BotAction[] {
  if (playerId !== game.currentPlayerId || hasPlayerCompletedAddCity(game, playerId)) {
    return []
  }

  if (!game.activeCityOffer) {
    return [{ type: "draw-city-offer", region: getPreferredDrawRegion(game, playerId) } as BotAction]
  }

  const keptCityIds = game.activeCityOffer.keptCityIds

  if (keptCityIds.length === 2) {
    return [{ type: "confirm-add-city-picks" }]
  }

  if (game.activeCityOffer.cityIds.length < 2) {
    return [{ type: "end-turn" }]
  }

  return [
    {
      type: "keep-city-offer",
      cityIds: [...game.activeCityOffer.cityIds]
        .sort((cityIdA, cityIdB) => {
          const cityA = game.cities.find(city => city.id === cityIdA)
          const cityB = game.cities.find(city => city.id === cityIdB)
          return (
            (cityB?.population ?? cityB?.size ?? 0) -
            (cityA?.population ?? cityA?.size ?? 0)
          )
        })
        .slice(0, 2),
    },
  ]
}

function getAvailableOperationsActions(game: GameState, playerId: string): BotAction[] {
  if (!canPlayerEditOperations(game, playerId)) {
    return []
  }

  const cityMap = new Map(game.cities.map(city => [city.id, city]))
  const claimActions = getOwnedCityPairs(game, playerId).flatMap(([cityAId, cityBId]) => {
    const cityA = cityMap.get(cityAId)
    const railPairIsAdjacent = cityA?.adjacentCities?.some(adjacentCity => adjacentCity.id === cityBId) ?? false

    return getConnectionOptions(game, [cityAId, cityBId], playerId)
      .filter(option => option.valid && (option.mode === "rail" || option.mode === "air"))
      .filter((option): option is { mode: "rail" | "air"; valid: true } => option.mode === "rail" || option.mode === "air")
      .filter(option => option.mode !== "rail" || railPairIsAdjacent)
      .map(option => ({
        type: "claim-route" as const,
        mode: option.mode,
        cityIds: [cityAId, cityBId] as [string, string],
      }))
  }).sort((actionA, actionB) => {
    const actionACityScore = actionA.cityIds.reduce(
      (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
      0,
    )
    const actionBCityScore = actionB.cityIds.reduce(
      (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
      0,
    )
    return actionBCityScore - actionACityScore
  }).slice(0, MAX_BOT_OPERATION_CLAIM_ACTIONS)

  const playerSummary = getCachedBureaucracySummary(game, playerId)
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

        if (!reusableEmptyPlan && !canAddSplitService) {
          return []
        }

        const existingPodKeys = new Set(
          activePlans
            .filter(plan => plan.selectedCityIds.length >= 2)
            .map(plan => [...plan.selectedCityIds].sort().join("|")),
        )
        const cityMap = new Map(game.cities.map(city => [city.id, city]))
        const candidateCityIds = buildServicePodCandidates(
          representativePlan.availableCityIds,
          representativePlan.corridorSegmentPairs,
          cityMap,
        )
          .filter(cityIds => !existingPodKeys.has([...cityIds].sort().join("|")))
          .slice(0, MAX_BOT_OPERATION_POD_ACTIONS_PER_CORRIDOR)
        const routeId =
          reusableEmptyPlan?.id ?? buildServiceSlotId(representativePlan.corridorId, activePlans.length)

        return candidateCityIds.map(cityIds => ({
          type: "create-service-pod" as const,
          corridorId: representativePlan.corridorId,
          routeId,
          cityIds,
        }))
      })
    : []

  const removePodCityActions: BotAction[] = playerSummary
    ? playerSummary.routePlans
        .filter(plan => !plan.isDisconnected && plan.selectedCityIds.length >= 3)
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

  return [...claimActions, ...podActions, ...removePodCityActions, { type: "ready-operations" }]
}

function buildServicePodCandidates(
  availableCityIds: string[],
  corridorSegmentPairs: Array<[string, string]>,
  cityMap: Map<string, GameState["cities"][number]>,
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

  const byPopulationDesc = (cityIdA: string, cityIdB: string) =>
    (cityMap.get(cityIdB)?.population ?? cityMap.get(cityIdB)?.size ?? 0) -
      (cityMap.get(cityIdA)?.population ?? cityMap.get(cityIdA)?.size ?? 0) || cityIdA.localeCompare(cityIdB)

  const seeds = [...availableCityIds].sort(byPopulationDesc).slice(0, MAX_BOT_OPERATION_POD_SEEDS)
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
      .sort(byPopulationDesc)
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

  return [...candidates.values()].sort((cityIdsA, cityIdsB) => {
    const populationA = cityIdsA.reduce(
      (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
      0,
    )
    const populationB = cityIdsB.reduce(
      (total, cityId) => total + (cityMap.get(cityId)?.population ?? cityMap.get(cityId)?.size ?? 0),
      0,
    )
    return populationB - populationA || cityIdsB.length - cityIdsA.length
  })
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

  for (const cityId of action.cityIds) {
    const refreshedSummary = getCachedBureaucracySummary(nextGame, playerId)
    const refreshedTargetPlan = refreshedSummary?.routePlans.find(plan => plan.id === action.routeId) ?? null

    if (!refreshedTargetPlan) {
      throw new Error("The target service pod could not be found.")
    }

    if (refreshedTargetPlan.selectedCityIds.includes(cityId)) {
      continue
    }

    const sourcePlan =
      refreshedSummary?.routePlans.find(
        plan =>
          plan.corridorId === action.corridorId &&
          plan.id !== action.routeId &&
          plan.selectedCityIds.includes(cityId),
      ) ?? null
    const moveResult = moveBureaucracyServiceCity(
      nextGame,
      action.corridorId,
      cityId,
      action.routeId,
      sourcePlan?.id ?? null,
      playerId,
    )

    if (!moveResult.ok) {
      throw new Error(moveResult.error)
    }

    nextGame = moveResult.game
  }

  return nextGame
}

export function getBotLegalActions(game: GameState, playerId: string): BotAction[] {
  switch (game.currentPhase) {
    case "purchase-equipment":
      return [...getAvailableBotVehicleActions(game, playerId), { type: "end-turn" }]
    case "add-city": {
      const claimActions = getAvailableClaimActions(game, playerId)
      if (claimActions.length > 0) return claimActions
      // After confirming city picks, bots can also edit operations during the add-city phase.
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
      const result = buyVehicleCard(game, action.cardId, action.quantity)
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
      const result = confirmAddCityPicks(game)
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
      return advanceTurn(game)
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

  switch (game.currentPhase) {
    case "purchase-equipment":
      return botPlayerIds.has(game.currentPlayerId) ? game.currentPlayerId : null
    case "add-city":
      return (
        // Bot is the active city-picker and hasn't confirmed yet.
        (botPlayerIds.has(game.currentPlayerId) && !hasPlayerCompletedAddCity(game, game.currentPlayerId)
          ? game.currentPlayerId
          : null) ??
        // Bot has confirmed city picks and can still edit operations during add-city phase.
        game.players.find(
          player => botPlayerIds.has(player.id) && canPlayerEditOperations(game, player.id),
        )?.id ??
        null
      )
    case "operations":
      return (
        game.players.find(
          player => botPlayerIds.has(player.id) && !hasPlayerCompletedOperations(game, player.id),
        )?.id ?? null
      )
    case "bureaucracy":
      return (
        game.players.find(
          player => botPlayerIds.has(player.id) && !hasPlayerCompletedBureaucracy(game, player.id),
        )?.id ?? null
      )
  }
}
