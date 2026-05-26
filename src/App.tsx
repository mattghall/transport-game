import { useCallback, useEffect, useState } from "react"
import { loadUserDecks, saveUserDecks } from "./data/deckData"
import { usMap } from "./data/maps/usMap"
import {
  addBureaucracyServiceSplit,
  advanceTurn,
  buyResource,
  buyVehicleCard,
  claimRoute,
  drawCityOffer,
  setActiveCityOfferKeptCityIds,
  setBureaucracyServiceCities,
  setBureaucracyRouteVehicleCard,
  upgradeRailRoute,
} from "./engine/actions"
import { findPlayerBureaucracyPlan } from "./engine/bureaucracy"
import {
  createGameState,
  DEFAULT_PLAYERS,
  DEFAULT_STARTING_MONEY,
  type GameSetupPlayer,
} from "./engine/createGameState"
import type { GameActionLogEntry, GameState, PurchasableResource, UserDeckData, WeeklyPhase } from "./engine/types"
import Board from "./ui/Board"
import StartMenu from "./ui/StartMenu"

const MAX_SETUP_PLAYERS = 4
const PLAYER_SETUP_PRESETS: GameSetupPlayer[] = [
  { id: "p1", name: "Matt", color: "#457b9d" },
  { id: "p2", name: "Sarah", color: "#e96620" },
  { id: "p3", name: "Avery", color: "#6f42c1" },
  { id: "p4", name: "Jordan", color: "#2a9d8f" },
]

function formatPhaseLabel(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "purchase equipment"
    case "claim-routes":
      return "claim routes"
    case "operations":
      return "operations"
    case "purchase-fuel":
      return "purchase fuel"
    case "bureaucracy":
      return "bureaucracy"
  }
}

function appendActionLog(
  previousGame: GameState,
  nextGame: GameState,
  message: string,
  playerId: string | null = previousGame.currentPlayerId,
) {
  const playerName =
    (playerId && previousGame.players.find(player => player.id === playerId)?.name) ?? "System"
  const entry: GameActionLogEntry = {
    id: `action-${previousGame.actionLog.length + 1}`,
    playerId,
    playerName,
    week: previousGame.currentWeek,
    phase: previousGame.currentPhase,
    message,
  }

  return {
    ...nextGame,
    actionLog: [...nextGame.actionLog, entry],
  }
}

function getAdvanceTurnLogMessage(previousGame: GameState, nextGame: GameState) {
  const nextPlayer = nextGame.players.find(player => player.id === nextGame.currentPlayerId)

  return nextGame.currentWeek !== previousGame.currentWeek
    ? `advanced to month ${nextGame.currentWeek} ${formatPhaseLabel(nextGame.currentPhase)}`
    : nextGame.currentPhase !== previousGame.currentPhase
      ? `advanced to ${formatPhaseLabel(nextGame.currentPhase)}`
      : `ended turn, next player ${nextPlayer?.name ?? nextGame.currentPlayerId}`
}

function getPhaseDiscardLogMessage(previousGame: GameState, nextGame: GameState) {
  const burnedVehicleCards =
    previousGame.currentPhase === "purchase-equipment" &&
    nextGame.currentPhase === "claim-routes" &&
    previousGame.vehicleMarketCardIds.length !== nextGame.vehicleMarketCardIds.length
      ? previousGame.vehicleMarketCardIds
          .filter(cardId => !nextGame.vehicleMarketCardIds.includes(cardId))
          .map(cardId => previousGame.vehicleCatalog.find(card => card.id === cardId) ?? null)
          .filter((card): card is NonNullable<typeof card> => card !== null)
          .sort((cardA, cardB) => cardA.type.localeCompare(cardB.type) || cardA.number - cardB.number)
      : []
  const messages = [
    ...burnedVehicleCards.map(
      card =>
        `removed vehicle #${card.number} ${card.name} from the ${card.type} deck because nobody bought a ${card.type === "air" ? "plane" : card.type} this month`,
    ),
  ]

  return messages.length > 0 ? messages.join("; ") : null
}

export default function App() {
  const [setupPlayers, setSetupPlayers] = useState<GameSetupPlayer[]>(() => DEFAULT_PLAYERS)
  const [startingMoney, setStartingMoney] = useState(DEFAULT_STARTING_MONEY)
  const [userDecks, setUserDecks] = useState<UserDeckData>(() => loadUserDecks())
  const [hasStarted, setHasStarted] = useState(false)
  const [game, setGame] = useState(() => {
    const initialUserDecks = loadUserDecks()

    return createGameState(usMap, {
      players: DEFAULT_PLAYERS,
      vehicleCards: initialUserDecks.vehicleCards,
      chanceCards: initialUserDecks.chanceCards,
      startingMoney: DEFAULT_STARTING_MONEY,
    })
  })
  const [history, setHistory] = useState<typeof game[]>([])

  useEffect(() => {
    saveUserDecks(userDecks)
  }, [userDecks])

  useEffect(() => {
    if (!hasStarted) {
      return
    }

    const currentUrl = window.location.href
    window.history.pushState({ transportGameGuard: true }, "", currentUrl)

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ""
    }

    function handlePopState() {
      window.history.pushState({ transportGameGuard: true }, "", currentUrl)
      window.alert("Use the in-game controls instead of the browser Back button so you don't lose your game.")
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    window.addEventListener("popstate", handlePopState)

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
      window.removeEventListener("popstate", handlePopState)
    }
  }, [hasStarted])

  const handleSetupPlayerChange = useCallback(
    (playerId: string, updates: Partial<GameSetupPlayer>) => {
      setSetupPlayers(current =>
        current.map(player =>
          player.id === playerId
            ? {
                ...player,
                ...updates,
              }
            : player,
        ),
      )
    },
    [],
  )

  const handleMoveSetupPlayer = useCallback((playerId: string, direction: -1 | 1) => {
    setSetupPlayers(current => {
      const playerIndex = current.findIndex(player => player.id === playerId)
      const nextIndex = playerIndex + direction

      if (playerIndex === -1 || nextIndex < 0 || nextIndex >= current.length) {
        return current
      }

      const nextPlayers = [...current]
      const [player] = nextPlayers.splice(playerIndex, 1)
      nextPlayers.splice(nextIndex, 0, player)
      return nextPlayers
    })
  }, [])

  const handleAddSetupPlayer = useCallback(() => {
    setSetupPlayers(current => {
      if (current.length >= MAX_SETUP_PLAYERS) {
        return current
      }

      const nextPreset = PLAYER_SETUP_PRESETS.find(
        preset => !current.some(player => player.id === preset.id),
      )

      return nextPreset ? [...current, nextPreset] : current
    })
  }, [])

  const handleRemoveSetupPlayer = useCallback((playerId: string) => {
    setSetupPlayers(current => {
      if (current.length <= 2) {
        return current
      }

      return current.filter(player => player.id !== playerId)
    })
  }, [])

  const handleStartGame = useCallback(() => {
    const normalizedPlayers = setupPlayers.map((player, index) => ({
      ...player,
      name: player.name.trim() || `Player ${index + 1}`,
    }))
    setHistory([])
    setGame(
      createGameState(usMap, {
        players: normalizedPlayers,
        vehicleCards: userDecks.vehicleCards,
        chanceCards: userDecks.chanceCards,
        startingMoney,
      }),
    )
    setHasStarted(true)
  }, [setupPlayers, startingMoney, userDecks.chanceCards, userDecks.vehicleCards])

  const commitGame = useCallback(
    (nextGame: typeof game) => {
      setHistory(current => [...current, game])
      setGame(nextGame)
    },
    [game],
  )

  const handleClaimRouteAndAdvance = useCallback(
    (mode: "bus" | "rail" | "air", cityIds: string[], segmentPairs?: Array<[string, string]>) => {
      const claimResult = claimRoute(game, { mode, cityIds, segmentPairs })

      if (!claimResult.ok) {
        return claimResult
      }

      const routeLabel = claimResult.routes
        .map(route => {
          const cityA = game.cities.find(city => city.id === route.cityA)?.name ?? route.cityA
          const cityB = game.cities.find(city => city.id === route.cityB)?.name ?? route.cityB

          return `${cityA} - ${cityB}`
        })
        .join(", ")
      const claimedGame = appendActionLog(
        game,
        claimResult.game,
        `claimed a ${mode} route across ${routeLabel}${claimResult.connectionBonus > 0 ? ` and earned ${Math.round(claimResult.connectionBonus).toLocaleString()}` : ""}`,
      )

      if (game.currentPhase === "operations") {
        commitGame(claimedGame)

        return {
          ok: true as const,
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
      }

      const advancedGame = advanceTurn(claimedGame)
      const finalGame = appendActionLog(
        claimedGame,
        advancedGame,
        [getAdvanceTurnLogMessage(claimedGame, advancedGame), getPhaseDiscardLogMessage(claimedGame, advancedGame)]
          .filter((message): message is string => Boolean(message))
          .join("; "),
      )

      commitGame(finalGame)

      return {
        ok: true as const,
        routes: claimResult.routes,
        cost: claimResult.cost,
        connectionBonus: claimResult.connectionBonus,
        newCityIds: claimResult.newCityIds,
        nextPhase: advancedGame.currentPhase,
        nextPlayerName:
          advancedGame.players.find(player => player.id === advancedGame.currentPlayerId)?.name ??
          advancedGame.currentPlayerId,
        advancedPhase: advancedGame.currentPhase !== claimedGame.currentPhase,
      }
    },
    [commitGame, game],
  )

  const handleDrawCityOffer = useCallback(
    (region: NonNullable<GameState["activeCityOffer"]>["region"]) => {
      const result = drawCityOffer(game, region)

      if (!result.ok) {
        return result
      }

      commitGame(
        appendActionLog(
          game,
          result.game,
          `drew ${result.cityIds.length} city cards from the ${region} deck`,
        ),
      )

      return result
    },
    [commitGame, game],
  )

  const handleAdvanceTurn = useCallback(() => {
    const nextGame = advanceTurn(game)
    const message = getAdvanceTurnLogMessage(game, nextGame)
    const discardMessage = getPhaseDiscardLogMessage(game, nextGame)
    const fullMessage = discardMessage
      ? `${message}; ${discardMessage}`
      : message
    commitGame(appendActionLog(game, nextGame, fullMessage))
  }, [commitGame, game])

  const handleSetActiveCityOfferKeptCityIds = useCallback(
    (cityIds: string[]) => {
      const result = setActiveCityOfferKeptCityIds(game, cityIds)

      if (result.ok) {
        commitGame(result.game)
      }

      return result
    },
    [commitGame, game],
  )

  const handleBuyResource = useCallback(
    (resource: PurchasableResource, quantity: number) => {
      const result = buyResource(game, resource, quantity)

      if (result.ok) {
        commitGame(
          appendActionLog(
            game,
            result.game,
            `bought ${result.quantity} ${resource === "diesel" ? "diesel" : "jet fuel"} for ${Math.round(result.cost).toLocaleString()}`,
          ),
        )
      }

      return result
    },
    [commitGame, game],
  )

  const handleBuyVehicleCardAndAdvance = useCallback(
    (cardId: string, quantity: number) => {
      const purchaseResult = buyVehicleCard(game, cardId, quantity)

      if (!purchaseResult.ok) {
        return purchaseResult
      }

      const purchasedGame = appendActionLog(
        game,
        purchaseResult.game,
        `purchased ${purchaseResult.quantity} vehicle${purchaseResult.quantity === 1 ? "" : "s"} of #${purchaseResult.card.number} ${purchaseResult.card.name}`,
      )
      const advancedGame = advanceTurn(purchasedGame)
      const finalGame = appendActionLog(
        purchasedGame,
        advancedGame,
        getAdvanceTurnLogMessage(purchasedGame, advancedGame),
      )

      commitGame(finalGame)

      return {
        ok: true as const,
        card: purchaseResult.card,
        quantity: purchaseResult.quantity,
        cost: purchaseResult.cost,
        nextPhase: advancedGame.currentPhase,
        nextPlayerName:
          advancedGame.players.find(player => player.id === advancedGame.currentPlayerId)?.name ??
          advancedGame.currentPlayerId,
        advancedPhase: advancedGame.currentPhase !== purchasedGame.currentPhase,
      }
    },
    [commitGame, game],
  )

  const handleSetBureaucracyRouteVehicleCard = useCallback(
    (routeId: string, vehicleCardId: string | null) => {
      const result = setBureaucracyRouteVehicleCard(game, routeId, vehicleCardId)

      if (result.ok) {
        const plan = findPlayerBureaucracyPlan(game, game.currentPlayerId, routeId)
        const cardName =
          vehicleCardId === null
            ? "no vehicle"
            : game.vehicleCatalog.find(card => card.id === vehicleCardId)?.name ?? vehicleCardId
        commitGame(
          appendActionLog(
            game,
            result.game,
            `assigned ${cardName} to ${plan?.serviceLabel ?? routeId}`,
          ),
        )
      }

      return result
    },
    [commitGame, game],
  )

  const handleSetBureaucracyServiceCities = useCallback(
    (routeId: string, cityIds: string[]) => {
      const result = setBureaucracyServiceCities(game, routeId, cityIds)

      if (result.ok) {
        const plan = findPlayerBureaucracyPlan(game, game.currentPlayerId, routeId)
        const cityLabel = result.cityIds
          .map(cityId => game.cities.find(city => city.id === cityId)?.name ?? cityId)
          .join(" - ")
        commitGame(
          appendActionLog(
            game,
            result.game,
            `set service cities for ${plan?.serviceLabel ?? routeId} to ${cityLabel || "none"}`,
          ),
        )
      }

      return result
    },
    [commitGame, game],
  )

  const handleAddBureaucracyServiceSplit = useCallback(
    (corridorId: string) => {
      const result = addBureaucracyServiceSplit(game, corridorId)

      if (result.ok) {
        commitGame(
          appendActionLog(
            game,
            result.game,
            `added split service on corridor ${corridorId}`,
          ),
        )
      }

      return result
    },
    [commitGame, game],
  )

  const handleUpgradeRailRoute = useCallback(
    (routeId: string) => {
      const result = upgradeRailRoute(game, routeId)

      if (result.ok) {
        const route = game.routes.find(candidate => candidate.id === routeId)
        const cityA = game.cities.find(city => city.id === route?.cityA)?.name ?? route?.cityA ?? routeId
        const cityB = game.cities.find(city => city.id === route?.cityB)?.name ?? route?.cityB ?? routeId
        commitGame(
          appendActionLog(
            game,
            result.game,
            `electrified rail route ${cityA} - ${cityB}`,
          ),
        )
      }

      return result
    },
    [commitGame, game],
  )

  const handleUndo = useCallback(() => {
    setHistory(current => {
      const previousGame = current[current.length - 1]

      if (!previousGame) {
        return current
      }

      setGame(previousGame)
      return current.slice(0, -1)
    })
  }, [])

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      {!hasStarted ? (
      <StartMenu
        players={setupPlayers}
        startingMoney={startingMoney}
        onStartingMoneyChange={setStartingMoney}
        onSetupPlayerChange={handleSetupPlayerChange}
        onMoveSetupPlayer={handleMoveSetupPlayer}
        onAddSetupPlayer={handleAddSetupPlayer}
          onRemoveSetupPlayer={handleRemoveSetupPlayer}
          onStartGame={handleStartGame}
          userDecks={userDecks}
          onUserDecksChange={setUserDecks}
        />
      ) : (
      <Board
        game={game}
        onClaimRoute={handleClaimRouteAndAdvance}
        onDrawCityOffer={handleDrawCityOffer}
        onSetActiveCityOfferKeptCityIds={handleSetActiveCityOfferKeptCityIds}
        onBuyResource={handleBuyResource}
        onBuyVehicleCard={handleBuyVehicleCardAndAdvance}
        onUpgradeRailRoute={handleUpgradeRailRoute}
        onSetBureaucracyRouteVehicleCard={handleSetBureaucracyRouteVehicleCard}
        onSetBureaucracyServiceCities={handleSetBureaucracyServiceCities}
        onAddBureaucracyServiceSplit={handleAddBureaucracyServiceSplit}
        onAdvanceTurn={handleAdvanceTurn}
        onUndo={handleUndo}
        canUndo={history.length > 0}
      />
      )}
    </div>
  )
}
