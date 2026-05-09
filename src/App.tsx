import { useCallback, useState } from "react"
import { usMap } from "./data/maps/usMap"
import {
  advanceTurn,
  buyResource,
  buyVehicleCard,
  claimRoute,
  setBureaucracyRouteVehicleCard,
  setBureaucracyRouteFuelUnits,
  upgradeRailRoute,
} from "./engine/actions"
import { createGameState } from "./engine/createGameState"
import type { PurchasableResource, RouteMode } from "./engine/types"
import Board from "./ui/Board"

export default function App() {
  const [game, setGame] = useState(() => createGameState(usMap))
  const [history, setHistory] = useState<typeof game[]>([])

  const commitGame = useCallback(
    (nextGame: typeof game) => {
      setHistory(current => [...current, game])
      setGame(nextGame)
    },
    [game],
  )

  const handleClaimRoute = useCallback(
    (cityIds: string[], mode: RouteMode) => {
      const result = claimRoute(game, { cityIds, mode })

      if (result.ok) {
        commitGame(result.game)
      }

      return result
    },
    [commitGame, game],
  )

  const handleAdvanceTurn = useCallback(() => {
    commitGame(advanceTurn(game))
  }, [commitGame, game])

  const handleBuyResource = useCallback(
    (resource: PurchasableResource, quantity: number) => {
      const result = buyResource(game, resource, quantity)

      if (result.ok) {
        commitGame(result.game)
      }

      return result
    },
    [commitGame, game],
  )

  const handleBuyVehicleCard = useCallback(
    (cardId: string) => {
      const result = buyVehicleCard(game, cardId)

      if (result.ok) {
        commitGame(result.game)
      }

      return result
    },
    [commitGame, game],
  )

  const handleSetBureaucracyRouteFuelUnits = useCallback(
    (routeId: string, fuelUnits: number) => {
      const result = setBureaucracyRouteFuelUnits(game, routeId, fuelUnits)

      if (result.ok) {
        commitGame(result.game)
      }

      return result
    },
    [commitGame, game],
  )

  const handleSetBureaucracyRouteVehicleCard = useCallback(
    (routeId: string, vehicleCardId: string | null) => {
      const result = setBureaucracyRouteVehicleCard(game, routeId, vehicleCardId)

      if (result.ok) {
        commitGame(result.game)
      }

      return result
    },
    [commitGame, game],
  )

  const handleUpgradeRailRoute = useCallback(
    (routeId: string) => {
      const result = upgradeRailRoute(game, routeId)

      if (result.ok) {
        commitGame(result.game)
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
    <div style={{ width: "100vw", height: "100vh" }}>
      <Board
        game={game}
        onClaimRoute={handleClaimRoute}
        onBuyResource={handleBuyResource}
        onBuyVehicleCard={handleBuyVehicleCard}
        onUpgradeRailRoute={handleUpgradeRailRoute}
        onSetBureaucracyRouteVehicleCard={handleSetBureaucracyRouteVehicleCard}
        onSetBureaucracyRouteFuelUnits={handleSetBureaucracyRouteFuelUnits}
        onAdvanceTurn={handleAdvanceTurn}
        onUndo={handleUndo}
        canUndo={history.length > 0}
      />
    </div>
  )
}
