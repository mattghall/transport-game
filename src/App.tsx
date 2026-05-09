import { useCallback, useState } from "react"
import { usMap } from "./data/maps/usMap"
import {
  advanceTurn,
  buyResource,
  buyVehicleCard,
  claimRoute,
  setBureaucracyRouteVehicleCard,
  setBureaucracyRouteFuelUnits,
} from "./engine/actions"
import { createGameState } from "./engine/createGameState"
import type { PurchasableResource, RouteMode } from "./engine/types"
import Board from "./ui/Board"

export default function App() {
  const [game, setGame] = useState(() => createGameState(usMap))

  const handleClaimRoute = useCallback(
    (cityIds: string[], mode: RouteMode) => {
      const result = claimRoute(game, { cityIds, mode })

      if (result.ok) {
        setGame(result.game)
      }

      return result
    },
    [game],
  )

  const handleAdvanceTurn = useCallback(() => {
    setGame(current => advanceTurn(current))
  }, [])

  const handleBuyResource = useCallback(
    (resource: PurchasableResource) => {
      const result = buyResource(game, resource)

      if (result.ok) {
        setGame(result.game)
      }

      return result
    },
    [game],
  )

  const handleBuyVehicleCard = useCallback(
    (cardId: string) => {
      const result = buyVehicleCard(game, cardId)

      if (result.ok) {
        setGame(result.game)
      }

      return result
    },
    [game],
  )

  const handleSetBureaucracyRouteFuelUnits = useCallback(
    (routeId: string, fuelUnits: number) => {
      const result = setBureaucracyRouteFuelUnits(game, routeId, fuelUnits)

      if (result.ok) {
        setGame(result.game)
      }

      return result
    },
    [game],
  )

  const handleSetBureaucracyRouteVehicleCard = useCallback(
    (routeId: string, vehicleCardId: string | null) => {
      const result = setBureaucracyRouteVehicleCard(game, routeId, vehicleCardId)

      if (result.ok) {
        setGame(result.game)
      }

      return result
    },
    [game],
  )

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <Board
        game={game}
        onClaimRoute={handleClaimRoute}
        onBuyResource={handleBuyResource}
        onBuyVehicleCard={handleBuyVehicleCard}
        onSetBureaucracyRouteVehicleCard={handleSetBureaucracyRouteVehicleCard}
        onSetBureaucracyRouteFuelUnits={handleSetBureaucracyRouteFuelUnits}
        onAdvanceTurn={handleAdvanceTurn}
      />
    </div>
  )
}
