import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type RailUpgradeResult,
  type BureaucracyServiceCityMoveResult,
  type BureaucracyServiceSplitResult,
  type BureaucracyServicePodCitiesResult,
  type BureaucracyVehicleCardResult,
  addBureaucracyServiceSplit,
  advanceTurn,
  buyVehicleCard,
  canPlayerEditOperations,
  canPlayerPickCities,
  claimRoute,
  confirmAddCityPicks,
  deleteBureaucracyServicePod,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedOperations,
  markBureaucracyReady,
  markOperationsReady,
  moveBureaucracyServiceCity,
  setBureaucracyServicePodCities,
  setActiveCityOfferKeptCityIds,
  setBureaucracyRouteVehicleCard,
  upgradeRailRoute,
} from "../engine/actions"
import { buildPlayerBureaucracySummary, buildServiceSlotId, findPlayerBureaucracyPlan } from "../engine/bureaucracy"
import { getPendingBotPlayerId } from "../bots/actions"
import type { GameState, RouteMode } from "../engine/types"
import type { DrawCityOfferResult } from "../engine/actions"
import { drawCityOffer } from "../engine/actions"
import {
  appendActionLog,
  getAdvanceTurnLogMessage,
  getDefaultLocalViewingPlayerId,
  getNextLocalViewingPlayerId,
  getPhaseDiscardLogMessage,
  runBotTurns,
} from "../game/gameHelpers"

export type UseLocalGameOptions = {
  initialGame: GameState
  onGameSave?: (game: GameState) => void
}

export type LocalGameActions = {
  game: GameState
  history: GameState[]
  selectedPlayerId: string | null
  isPeriodSummaryVisible: boolean
  setIsPeriodSummaryVisible: (visible: boolean) => void
  activeViewingPlayerId: string | null
  canUndo: boolean
  handleClaimRoute: (
    mode: "bus" | "rail" | "air",
    cityIds: string[],
    segmentPairs?: Array<[string, string]>,
  ) => ReturnType<typeof _claimRouteResult>
  handleDrawCityOffer: (
    region: NonNullable<GameState["activeCityOffer"]>["region"],
  ) => DrawCityOfferResult
  handleSetActiveCityOfferKeptCityIds: (cityIds: string[]) => { ok: true; game: GameState; cityIds: string[] } | { ok: false; error: string }
  handleBuyVehicleCard: (
    cardId: string,
    quantity: number,
  ) => ReturnType<typeof _buyVehicleCardResult>
  handleUpgradeRailRoute: (routeId: string) => RailUpgradeResult
  handleSetBureaucracyRouteVehicleCard: (routeId: string, vehicleCardId: string | null) => BureaucracyVehicleCardResult
  handleAddBureaucracyServiceSplit: (corridorId: string, initialCityIds?: string[]) => BureaucracyServiceSplitResult
  handleSetBureaucracyServicePodCities: (corridorId: string, routeIds: string[], cityIds: string[]) => BureaucracyServicePodCitiesResult
  handleMoveBureaucracyServiceCity: (
    corridorId: string,
    cityId: string,
    routeId: string,
    sourceRouteId?: string | null,
  ) => BureaucracyServiceCityMoveResult
  handleDeleteBureaucracyServicePod: (corridorId: string, routeId: string) => { ok: true } | { ok: false; error: string }
  handleAdvanceTurn: () => { ok: true; game: GameState } | { ok: false; error: string }
  handleUndo: () => void
}

// Placeholder return types used for inference — not called at runtime
function _claimRouteResult() {
  return null as unknown as
    | { ok: true; routes: GameState["routes"]; cost: number; connectionBonus: number; newCityIds: string[]; nextPhase: GameState["currentPhase"]; nextPlayerName: string; advancedPhase: boolean }
    | { ok: false; error: string }
}
function _buyVehicleCardResult() {
  return null as unknown as
    | { ok: true; card: GameState["vehicleCatalog"][number]; quantity: number; cost: number; nextPhase: GameState["currentPhase"]; nextPlayerName: string; advancedPhase: boolean }
    | { ok: false; error: string }
}

function getVehicleTypeForMode(mode: RouteMode) {
  switch (mode) {
    case "rail":
      return "train"
    case "air":
      return "air"
    case "bus":
      return "bus"
  }
}

function getAutoAssignableVehicleCardId(game: GameState, playerId: string, corridorId: string) {
  const player = game.players.find(candidate => candidate.id === playerId)
  const summary = buildPlayerBureaucracySummary(game, playerId)
  const routeMode =
    summary?.routePlans.find(plan => !plan.isDisconnected && plan.corridorId === corridorId)?.route.mode ?? null

  if (!player || !summary || routeMode === null) {
    return null
  }

  const assignedVehicleCardIds = new Set(
    summary.routePlans
      .map(plan => plan.vehicleCard?.id)
      .filter((cardId): cardId is string => cardId !== undefined),
  )

  return (
    player.ownedVehicleCardIds.find(cardId => {
      if (assignedVehicleCardIds.has(cardId)) {
        return false
      }

      return game.vehicleCatalog.find(card => card.id === cardId)?.type === getVehicleTypeForMode(routeMode)
    }) ?? null
  )
}

export function useLocalGame({ initialGame, onGameSave }: UseLocalGameOptions): LocalGameActions {
  const [game, setGame] = useState(initialGame)
  const [history, setHistory] = useState<GameState[]>([])
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(
    () => getDefaultLocalViewingPlayerId(initialGame),
  )
  const [isPeriodSummaryVisible, setIsPeriodSummaryVisible] = useState(false)
  const gameRef = useRef(game)
  const localBotTurnSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    gameRef.current = game
  }, [game])

  const localBotPlayerIds = useMemo(
    () => new Set(game.players.filter(player => player.isBot).map(player => player.id)),
    [game.players],
  )

  const pendingBotPlayerId = useMemo(
    () => getPendingBotPlayerId(game, localBotPlayerIds),
    [game, localBotPlayerIds],
  )

  // Run bot turns synchronously when it's a bot's turn
  useEffect(() => {
    if (!pendingBotPlayerId || isPeriodSummaryVisible) {
      localBotTurnSignatureRef.current = null
      return
    }

    const turnSignature = JSON.stringify({
      week: game.currentWeek,
      phase: game.currentPhase,
      currentPlayerId: game.currentPlayerId,
      playerPhases: game.players.map(player => [player.id, player.phase]),
      bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds,
      pendingBotPlayerId,
    })

    if (localBotTurnSignatureRef.current === turnSignature) {
      return
    }

    localBotTurnSignatureRef.current = turnSignature
    const previousGame = game
    const { game: nextGame, hasChanged } = runBotTurns(game, localBotPlayerIds)

    if (!hasChanged || nextGame === previousGame) {
      return
    }

    const commitId = window.setTimeout(() => {
      setHistory(current => [...current, previousGame])
      setGame(nextGame)
      setSelectedPlayerId(currentSelectedPlayerId =>
        getNextLocalViewingPlayerId(nextGame, currentSelectedPlayerId),
      )
      onGameSave?.(nextGame)
    }, 0)

    return () => {
      window.clearTimeout(commitId)
    }
  }, [game, pendingBotPlayerId, isPeriodSummaryVisible, localBotPlayerIds, onGameSave])

  const commit = useCallback(
    <T extends { ok: true; game: GameState }>(
      mutate: (baseGame: GameState, actingPlayerId: string) => T | { ok: false; error: string },
    ): T | { ok: false; error: string } => {
      const actingPlayerId = getDefaultLocalViewingPlayerId(game) ?? game.currentPlayerId
      const result = mutate(game, actingPlayerId)

      if (result.ok) {
        setHistory(current => [...current, game])
        setGame(result.game)
        setSelectedPlayerId(currentSelectedPlayerId =>
          getNextLocalViewingPlayerId(result.game, currentSelectedPlayerId),
        )
        onGameSave?.(result.game)
      }

      return result
    },
    [game, onGameSave],
  )

  const handleClaimRoute = useCallback(
    (mode: "bus" | "rail" | "air", cityIds: string[], segmentPairs?: Array<[string, string]>) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const claimResult = claimRoute(baseGame, { mode, cityIds, segmentPairs }, actingPlayerId)

        if (!claimResult.ok) {
          return claimResult
        }

        const routeLabel = claimResult.routes
          .map(route => {
            const cityA = baseGame.cities.find(city => city.id === route.cityA)?.name ?? route.cityA
            const cityB = baseGame.cities.find(city => city.id === route.cityB)?.name ?? route.cityB
            return `${cityA} - ${cityB}`
          })
          .join(", ")
        const claimedGame = appendActionLog(
          baseGame,
          claimResult.game,
          `claimed a ${mode} route across ${routeLabel}${claimResult.connectionBonus > 0 ? ` and earned ${Math.round(claimResult.connectionBonus).toLocaleString()}` : ""}`,
          actingPlayerId,
        )

        return {
          ok: true as const,
          game: claimedGame,
          routes: claimResult.routes,
          cost: claimResult.cost,
          connectionBonus: claimResult.connectionBonus,
          newCityIds: claimResult.newCityIds,
          nextPhase: claimedGame.currentPhase,
          nextPlayerName:
            claimedGame.players.find(player => player.id === claimedGame.currentPlayerId)?.name ??
            claimedGame.currentPlayerId,
          advancedPhase: false,
        }
      }),
    [commit],
  )

  const handleDrawCityOffer = useCallback(
    (region: NonNullable<GameState["activeCityOffer"]>["region"]) =>
      commit((baseGame, actingPlayerId) => {
        const result = drawCityOffer(baseGame, region, actingPlayerId)

        if (!result.ok) {
          return result
        }

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `drew ${result.cityIds.length} city cards from the ${region} deck`,
            actingPlayerId,
          ),
        }
      }),
    [commit],
  )

  const handleSetActiveCityOfferKeptCityIds = useCallback(
    (cityIds: string[]) =>
      commit((baseGame, actingPlayerId) => {
        const result = setActiveCityOfferKeptCityIds(baseGame, cityIds, actingPlayerId)
        return result.ok ? { ...result, game: result.game } : result
      }),
    [commit],
  )

  const handleBuyVehicleCard = useCallback(
    (cardId: string, quantity: number) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const purchaseResult = buyVehicleCard(baseGame, cardId, quantity, actingPlayerId)

        if (!purchaseResult.ok) {
          return purchaseResult
        }

        const purchasedGame = appendActionLog(
          baseGame,
          purchaseResult.game,
          `purchased ${purchaseResult.quantity} vehicle${purchaseResult.quantity === 1 ? "" : "s"} of #${purchaseResult.card.number} ${purchaseResult.card.name}`,
          actingPlayerId,
        )
        const advancedGame = advanceTurn(purchasedGame, actingPlayerId)
        const finalGame = appendActionLog(
          purchasedGame,
          advancedGame,
          getAdvanceTurnLogMessage(purchasedGame, advancedGame),
          actingPlayerId,
        )

        return {
          ok: true as const,
          game: finalGame,
          card: purchaseResult.card,
          quantity: purchaseResult.quantity,
          cost: purchaseResult.cost,
          nextPhase: advancedGame.currentPhase,
          nextPlayerName:
            advancedGame.players.find(player => player.id === advancedGame.currentPlayerId)?.name ??
            advancedGame.currentPlayerId,
          advancedPhase: advancedGame.currentPhase !== purchasedGame.currentPhase,
        }
      }),
    [commit],
  )

  const handleUpgradeRailRoute = useCallback(
    (routeId: string) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const result = upgradeRailRoute(baseGame, routeId, actingPlayerId)

        if (!result.ok) {
          return result
        }

        const route = baseGame.routes.find(candidate => candidate.id === routeId)
        const cityA = baseGame.cities.find(city => city.id === route?.cityA)?.name ?? route?.cityA ?? routeId
        const cityB = baseGame.cities.find(city => city.id === route?.cityB)?.name ?? route?.cityB ?? routeId

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `electrified rail route ${cityA} - ${cityB}`,
            actingPlayerId,
          ),
        }
      }),
    [commit],
  )

  const handleSetBureaucracyRouteVehicleCard = useCallback(
    (routeId: string, vehicleCardId: string | null) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const result = setBureaucracyRouteVehicleCard(baseGame, routeId, vehicleCardId, actingPlayerId)

        if (!result.ok) {
          return result
        }

        const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
        const cardName =
          vehicleCardId === null
            ? "no vehicle"
            : baseGame.vehicleCatalog.find(card => card.id === vehicleCardId)?.name ?? vehicleCardId

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `assigned ${cardName} to ${plan?.serviceLabel ?? routeId}`,
            actingPlayerId,
          ),
        }
      }),
    [commit],
  )

  const handleAddBureaucracyServiceSplit = useCallback(
    (corridorId: string, initialCityIds?: string[]) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const nextSlotIndex = Math.max(
          1,
          baseGame.bureaucracyServiceSlotCountsByCorridorId[corridorId] ?? 1,
        )
        const newRouteId = buildServiceSlotId(corridorId, nextSlotIndex)
        const autoAssignableVehicleCardId = getAutoAssignableVehicleCardId(
          baseGame,
          actingPlayerId,
          corridorId,
        )
        const result = addBureaucracyServiceSplit(baseGame, corridorId, actingPlayerId, initialCityIds)

        if (!result.ok) {
          return result
        }

        let nextGame = result.game
        let logMessage = `added split service on corridor ${corridorId}`

        if (autoAssignableVehicleCardId) {
          const vehicleAssignmentResult = setBureaucracyRouteVehicleCard(
            nextGame,
            newRouteId,
            autoAssignableVehicleCardId,
            actingPlayerId,
          )

          if (!vehicleAssignmentResult.ok) {
            return vehicleAssignmentResult
          }

          nextGame = vehicleAssignmentResult.game
          const vehicleCardName =
            baseGame.vehicleCatalog.find(card => card.id === autoAssignableVehicleCardId)?.name ??
            autoAssignableVehicleCardId
          logMessage = `${logMessage} and assigned ${vehicleCardName}`
        }

        return {
          ...result,
          game: appendActionLog(baseGame, nextGame, logMessage, actingPlayerId),
        }
      }),
    [commit],
  )

  const handleMoveBureaucracyServiceCity = useCallback(
    (corridorId: string, cityId: string, routeId: string, sourceRouteId: string | null = null) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const result = moveBureaucracyServiceCity(
          baseGame,
          corridorId,
          cityId,
          routeId,
          sourceRouteId,
          actingPlayerId,
        )

        if (!result.ok) {
          return result
        }

        const cityName = baseGame.cities.find(city => city.id === cityId)?.name ?? cityId
        const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
        const sourcePlan =
          sourceRouteId === null
            ? null
            : findPlayerBureaucracyPlan(baseGame, actingPlayerId, sourceRouteId)
        const actionLabel =
          plan?.isDisconnected
            ? `removed ${cityName} from ${sourcePlan?.serviceLabel ?? "that route"}`
            : `copied ${cityName} into ${plan?.serviceLabel ?? routeId}`

        return {
          ...result,
          game: appendActionLog(baseGame, result.game, actionLabel, actingPlayerId),
        }
      }),
    [commit],
  )

  const handleSetBureaucracyServicePodCities = useCallback(
    (corridorId: string, routeIds: string[], cityIds: string[]) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const result = setBureaucracyServicePodCities(
          baseGame,
          corridorId,
          routeIds,
          cityIds,
          actingPlayerId,
        )

        if (!result.ok) {
          return result
        }

        const cityLabel = cityIds
          .map(cityId => baseGame.cities.find(city => city.id === cityId)?.name ?? cityId)
          .join(", ")

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `set pod cities on corridor ${corridorId} to ${cityLabel || "none"}`,
            actingPlayerId,
          ),
        }
      }),
    [commit],
  )

  const handleDeleteBureaucracyServicePod = useCallback(
    (corridorId: string, routeId: string) =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId
        const result = deleteBureaucracyServicePod(baseGame, corridorId, routeId, actingPlayerId)

        if (!result.ok) {
          return result
        }

        const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
        const movedCitiesLabel =
          result.cityIds.length === 0
            ? "deleted an empty route"
            : result.disconnectedCityIds.length === 0
              ? `deleted ${plan?.serviceLabel ?? "a route"}`
              : `deleted ${plan?.serviceLabel ?? "a route"} and moved ${result.disconnectedCityIds.length} cit${result.disconnectedCityIds.length === 1 ? "y" : "ies"} to disconnected`

        return {
          ...result,
          game: appendActionLog(baseGame, result.game, movedCitiesLabel, actingPlayerId),
        }
      }),
    [commit],
  )

  const handleAdvanceTurn = useCallback(
    () =>
      commit(baseGame => {
        const actingPlayerId = getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId

        if (actingPlayerId && canPlayerPickCities(baseGame, actingPlayerId)) {
          const result = confirmAddCityPicks(baseGame, actingPlayerId)

          if (!result.ok) {
            return result
          }

          return {
            ok: true as const,
            game: appendActionLog(
              baseGame,
              result.game,
              result.advancedPhase
                ? "confirmed city picks and opened Operations for every player"
                : `confirmed city picks; ${result.game.players.find(player => player.id === result.game.currentPlayerId)?.name ?? result.game.currentPlayerId} is selecting cities`,
              actingPlayerId,
            ),
          }
        }

        if (actingPlayerId && canPlayerEditOperations(baseGame, actingPlayerId)) {
          const result = markOperationsReady(baseGame, actingPlayerId)

          if (!result.ok) {
            return result
          }

          return {
            ok: true as const,
            game: appendActionLog(
              baseGame,
              result.game,
              result.advancedPhase
                ? "finished operations planning and advanced to bureaucracy"
                : "finished operations planning",
              actingPlayerId,
            ),
          }
        }

        if (
          baseGame.currentPhase === "bureaucracy" ||
          (actingPlayerId &&
            hasPlayerCompletedOperations(baseGame, actingPlayerId) &&
            !hasPlayerCompletedBureaucracy(baseGame, actingPlayerId))
        ) {
          const result = markBureaucracyReady(baseGame, actingPlayerId)

          if (!result.ok) {
            return result
          }

          return {
            ok: true as const,
            game: appendActionLog(
              baseGame,
              result.game,
              result.advancedPhase
                ? "finished bureaucracy review and advanced to purchase equipment"
                : "finished bureaucracy review",
              actingPlayerId,
            ),
          }
        }

        const nextGame = advanceTurn(baseGame, actingPlayerId)
        const message = getAdvanceTurnLogMessage(baseGame, nextGame)
        const discardMessage = getPhaseDiscardLogMessage(baseGame, nextGame)
        const fullMessage = discardMessage ? `${message}; ${discardMessage}` : message

        return {
          ok: true as const,
          game: appendActionLog(baseGame, nextGame, fullMessage, actingPlayerId),
        }
      }),
    [commit],
  )

  const handleUndo = useCallback(() => {
    setHistory(current => {
      const previousGame = current[current.length - 1]

      if (!previousGame) {
        return current
      }

      setGame(previousGame)
      setSelectedPlayerId(currentSelectedPlayerId =>
        getNextLocalViewingPlayerId(previousGame, currentSelectedPlayerId),
      )
      onGameSave?.(previousGame)
      return current.slice(0, -1)
    })
  }, [onGameSave])

  const activeViewingPlayerId =
    selectedPlayerId ?? getDefaultLocalViewingPlayerId(game)

  return {
    game,
    history,
    selectedPlayerId,
    isPeriodSummaryVisible,
    setIsPeriodSummaryVisible,
    activeViewingPlayerId,
    canUndo: history.length > 0,
    handleClaimRoute,
    handleDrawCityOffer,
    handleSetActiveCityOfferKeptCityIds,
    handleBuyVehicleCard,
    handleUpgradeRailRoute,
    handleSetBureaucracyRouteVehicleCard,
    handleAddBureaucracyServiceSplit,
    handleSetBureaucracyServicePodCities,
    handleMoveBureaucracyServiceCity,
    handleDeleteBureaucracyServicePod,
    handleAdvanceTurn,
    handleUndo,
  }
}
