import {
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
  setActiveCityOfferKeptCityIds,
} from "../engine/actions"
import { CITY_DECK_REGIONS, type CityDeckRegion, type GameState } from "../engine/types"
import { getOwnedCityPairs } from "./strategy"
import type { BotAction } from "./types"

const MAX_BOT_OPERATION_CLAIM_ACTIONS = 8

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

  return [...claimActions, { type: "ready-operations" }]
}

export function getBotLegalActions(game: GameState, playerId: string): BotAction[] {
  switch (game.currentPhase) {
    case "purchase-equipment":
      return [...getAvailableBotVehicleActions(game, playerId), { type: "end-turn" }]
    case "add-city":
      return getAvailableClaimActions(game, playerId)
    case "operations":
      return getAvailableOperationsActions(game, playerId)
    case "bureaucracy":
      return hasPlayerCompletedBureaucracy(game, playerId) ? [] : [{ type: "ready-bureaucracy" }]
    case "purchase-fuel":
      return [{ type: "end-turn" }]
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
        (botPlayerIds.has(game.currentPlayerId) && !hasPlayerCompletedAddCity(game, game.currentPlayerId)
          ? game.currentPlayerId
          : null) ??
        game.players.find(
          player => botPlayerIds.has(player.id) && !hasPlayerCompletedAddCity(game, player.id),
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
    case "purchase-fuel":
      return botPlayerIds.has(game.currentPlayerId) ? game.currentPlayerId : null
  }
}
