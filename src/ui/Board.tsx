import { useEffect, useMemo, useState } from "react"
import {
  calculateClaimRouteCost,
  type BureaucracyVehicleCardResult,
  getFuelUnitPrice,
  getConnectionOptions,
  getCurrentPlayer,
  isLastPlayerTurn,
  type BureaucracyFuelUnitsResult,
  type ClaimRouteResult,
  type ResourcePurchaseResult,
  type VehiclePurchaseResult,
} from "../engine/actions"
import {
  buildBureaucracySummaries,
  getMaxFuelUnitsCapacityForPlayer,
  getMaxFuelUnitsForRoute,
} from "../engine/bureaucracy"
import { latLngToWorld } from "../engine/projection"
import {
  calculateDistanceMiles,
  calculateRealFuelFromUnits,
  calculateRouteTripsPerWeek,
} from "../engine/trips"
import { computeLabels } from "../engine/layout"
import { usOutline } from "../data/maps/usOutline"
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch"
import type {
  GameState,
  PurchasableResource,
  RouteMode,
  VehicleCard,
  WeeklyPhase,
} from "../engine/types"

type Props = {
  game: GameState
  onClaimRoute: (
    cityIds: string[],
    mode: RouteMode,
  ) => ClaimRouteResult
  onBuyResource: (resource: PurchasableResource) => ResourcePurchaseResult
  onBuyVehicleCard: (cardId: string) => VehiclePurchaseResult
  onSetBureaucracyRouteVehicleCard: (
    routeId: string,
    vehicleCardId: string | null,
  ) => BureaucracyVehicleCardResult
  onSetBureaucracyRouteFuelUnits: (
    routeId: string,
    fuelUnits: number,
  ) => BureaucracyFuelUnitsResult
  onAdvanceTurn: () => void
}

const BOARD_SHELL_STYLE = {
  position: "relative",
  width: "100vw",
  height: "100vh",
  background: "#e8efe6",
} as const

const HUD_STYLE = {
  position: "absolute",
  left: 16,
  top: 88,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 1,
  fontFamily: "system-ui, sans-serif",
} as const

const PLAYER_PANEL_STYLE = {
  position: "absolute",
  right: 16,
  top: 88,
  width: 320,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 1,
  fontFamily: "system-ui, sans-serif",
} as const

const PLAYER_CARD_STYLE = {
  border: "1px solid #d8dfd5",
  borderRadius: 10,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 6,
} as const

const TOP_BAR_STYLE = {
  position: "absolute",
  left: 16,
  right: 16,
  top: 16,
  display: "flex",
  alignItems: "stretch",
  gap: 10,
  padding: 10,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 1,
  fontFamily: "system-ui, sans-serif",
  overflowX: "auto",
} as const

const TOP_BAR_PLAYER_STYLE = {
  minWidth: 280,
  border: "1px solid #d8dfd5",
  borderRadius: 10,
  padding: "8px 10px",
  display: "flex",
  alignItems: "center",
  gap: 14,
  whiteSpace: "nowrap",
  background: "#ffffff",
} as const

const BOTTOM_BAR_STYLE = {
  position: "absolute",
  left: 16,
  right: 16,
  bottom: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 1,
  fontFamily: "system-ui, sans-serif",
} as const

const RESOURCE_MARKET_PANEL_STYLE = {
  position: "absolute",
  left: 16,
  right: 16,
  bottom: 88,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.96)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 1,
  fontFamily: "system-ui, sans-serif",
} as const

const MAP_OUTLINE_STYLE = {
  fill: "#f4f1e8",
  stroke: "#c9c2b3",
  opacity: 0.9,
} as const

const MODE_LABELS: Record<RouteMode, string> = {
  rail: "Rail",
  air: "Air",
  bus: "Bus",
}

const MODE_LINE_STYLES: Record<
  RouteMode,
  { strokeDasharray?: string; opacity?: number }
> = {
  rail: {},
  air: { strokeDasharray: "14 10" },
  bus: { strokeDasharray: "3 9", opacity: 0.9 },
}

function getMinimumVisibleCitySize(zoomScale: number) {
  if (zoomScale <= 1.15) {
    return 3
  }

  if (zoomScale <= 2) {
    return 2
  }

  return 1
}

function formatCurrency(amount: number) {
  const absoluteAmount = Math.abs(amount)
  const roundedAmount = Math.round(amount)

  if (absoluteAmount >= 1_000_000_000) {
    return `$${(roundedAmount / 1_000_000_000).toFixed(1)}B`
  }

  if (absoluteAmount >= 1_000_000) {
    return `$${(roundedAmount / 1_000_000).toFixed(1)}M`
  }

  if (absoluteAmount >= 1_000) {
    return `$${(roundedAmount / 1_000).toFixed(1)}K`
  }

  return `$${roundedAmount.toLocaleString()}`
}

function formatDecimal(value: number, maximumFractionDigits = 2) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })
}

function getResourceLabel(resource: PurchasableResource) {
  return resource === "diesel" ? "Diesel" : "Jet fuel"
}

function getResourceIcon(resource: PurchasableResource) {
  return resource === "diesel" ? "●" : "⬢"
}

function getVehicleTypeForMode(mode: RouteMode): VehicleCard["type"] {
  return mode === "rail" ? "train" : mode
}

function getRealFuelLabel(resource: PurchasableResource) {
  return resource === "diesel" ? "gallons" : "pounds"
}

function formatPhaseLabel(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "Purchase equipment"
    case "claim-routes":
      return "Claim routes"
    case "purchase-fuel":
      return "Purchase fuel"
    case "bureaucracy":
      return "Bureaucracy"
  }
}

function getNextPhase(phase: WeeklyPhase): WeeklyPhase {
  switch (phase) {
    case "purchase-equipment":
      return "claim-routes"
    case "claim-routes":
      return "purchase-fuel"
    case "purchase-fuel":
      return "bureaucracy"
    case "bureaucracy":
      return "purchase-equipment"
  }
}

function getRouteInteractionMessage(phase: WeeklyPhase) {
  return phase === "claim-routes"
    ? "Select cities to create a connection."
    : "Routes can only be claimed during the claim routes phase."
}

function getPhaseStatusMessage(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "Buy up to 1 vehicle card this turn."
    case "claim-routes":
      return "Select cities to create a connection."
    case "purchase-fuel":
      return "Buy fuel or advance to the next player."
    case "bureaucracy":
      return "Plan trips for each route, then advance."
  }
}

function getVehicleTypeLabel(type: VehicleCard["type"]) {
  switch (type) {
    case "bus":
      return "Bus"
    case "train":
      return "Train"
    case "air":
      return "Air"
  }
}

function getVehicleTypeIcon(type: VehicleCard["type"]) {
  switch (type) {
    case "bus":
      return "🚌"
    case "train":
      return "🚆"
    case "air":
      return "✈️"
  }
}

function InfoBubble({ label }: { label: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: "50%",
        border: "1px solid #c7d0c4",
        color: "#56635a",
        fontSize: 11,
        fontWeight: 700,
        cursor: "help",
        userSelect: "none",
        marginLeft: 6,
        flexShrink: 0,
      }}
    >
      ?
    </span>
  )
}

export default function Board({
  game,
  onClaimRoute,
  onBuyResource,
  onBuyVehicleCard,
  onSetBureaucracyRouteVehicleCard,
  onSetBureaucracyRouteFuelUnits,
  onAdvanceTurn,
}: Props) {
  const [selectedCityIds, setSelectedCityIds] = useState<string[]>([])
  const [hoverCityId, setHoverCityId] = useState<string | null>(null)
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const [isResourceMarketOpen, setIsResourceMarketOpen] = useState(false)
  const [isVehicleMarketOpen, setIsVehicleMarketOpen] = useState(false)
  const [isBureaucracyOpen, setIsBureaucracyOpen] = useState(false)
  const [zoomScale, setZoomScale] = useState(1)
  const [statusMessage, setStatusMessage] = useState<string>(
    getPhaseStatusMessage(game.currentPhase),
  )

  const map = game.map
  const currentPlayer = getCurrentPlayer(game)

  const cityMap = Object.fromEntries(
    game.cities.map(c => [c.id, c]),
  )
  const playerMap = Object.fromEntries(
    game.players.map(player => [player.id, player]),
  )
  const vehicleCardMap = Object.fromEntries(
    game.vehicleCatalog.map(card => [card.id, card]),
  )
  const bureaucracySummaries = useMemo(
    () => buildBureaucracySummaries(game),
    [game],
  )
  const minimumVisibleCitySize = getMinimumVisibleCitySize(zoomScale)
  const visibleCities = useMemo(
    () => game.cities.filter(city => city.size >= minimumVisibleCitySize),
    [game.cities, minimumVisibleCitySize],
  )
  const hiddenCities = useMemo(
    () => game.cities.filter(city => city.size < minimumVisibleCitySize),
    [game.cities, minimumVisibleCitySize],
  )
  const visibleCityIds = useMemo(
    () => new Set(visibleCities.map(city => city.id)),
    [visibleCities],
  )

  const labels = useMemo(
    () => computeLabels(visibleCities, zoomScale),
    [visibleCities, zoomScale],
  )
  const labelMap = Object.fromEntries(
    labels.map(l => [l.cityId, l]),
  )
  const outlinePath = usOutline
  .map(([lng, lat]) => {
     const p = latLngToWorld({ lng, lat })
     return `${p.x},${p.y}`
   })
   .join(" L ")

  const selectedCities = selectedCityIds
    .map(cityId => cityMap[cityId])
    .filter(city => city !== undefined)
  const currentPlayerOwnedVehicleCards = useMemo(
    () =>
      (currentPlayer?.ownedVehicleCardIds ?? [])
        .map(cardId => vehicleCardMap[cardId])
        .filter((card): card is VehicleCard => card !== undefined)
        .sort((cardA, cardB) => cardA.number - cardB.number),
    [currentPlayer, vehicleCardMap],
  )

  const connectionOptions = useMemo(() => {
    if (selectedCityIds.length < 2) {
      return []
    }

    return getConnectionOptions(game, selectedCityIds)
  }, [game, selectedCityIds])

  const previewCityIds =
    selectedCityIds.length >= 2
      ? selectedCityIds
      : selectedCityIds.length === 1 &&
          hoverCityId &&
          selectedCityIds[0] !== hoverCityId
        ? [selectedCityIds[0], hoverCityId]
        : []

  const previewPoints = previewCityIds
    .map(cityId => cityMap[cityId])
    .filter(city => city !== undefined)
    .map(city => latLngToWorld(city))

  const previewVisible = previewPoints.length >= 2

  const selectionSummary =
    selectedCities.length >= 2
      ? selectedCities.map(city => city.name).join(" -> ")
      : selectedCities.length === 1
        ? `Start city: ${selectedCities[0].name}`
        : "No cities selected"

  const optionMessage = connectionOptions
    .filter(option => !option.valid && option.reason)
    .map(option => option.reason)
    .filter((reason, index, reasons) => reasons.indexOf(reason) === index)
    .join(" ")
  const routePreviewSummaries = useMemo(() => {
    if (selectedCities.length < 2) {
      return []
    }

    const routePairs = selectedCities.slice(0, -1).map((city, index) => ({
      cityA: city,
      cityB: selectedCities[index + 1],
    }))
    const totalDistanceMiles = routePairs.reduce(
      (total, pair) => total + calculateDistanceMiles(pair.cityA, pair.cityB),
      0,
    )
    const combinedDemand = selectedCities.reduce((total, city) => total + city.size, 0)

    return connectionOptions.map(option => {
      const previewCard =
        currentPlayerOwnedVehicleCards.find(
          card => card.type === getVehicleTypeForMode(option.mode),
        ) ?? null
      const routeSummaries =
        previewCard === null
          ? []
          : routePairs
              .map(pair =>
                calculateRouteTripsPerWeek(
                  game,
                  {
                    id: `preview:${option.mode}:${pair.cityA.id}:${pair.cityB.id}`,
                    cityA: pair.cityA.id,
                    cityB: pair.cityB.id,
                    mode: option.mode,
                  },
                  previewCard,
                ),
              )
              .filter(summary => summary !== null)
      const weeklyFuelUnits = routeSummaries.reduce(
        (total, summary) => total + Math.ceil(summary.tripFuelUnits * summary.tripsPerWeek),
        0,
      )
      const fuelCostPerWeek =
        routeSummaries.length === 0
          ? null
          : routeSummaries.reduce(
              (total, summary) =>
                total +
                calculateRealFuelFromUnits(
                  Math.ceil(summary.tripFuelUnits * summary.tripsPerWeek),
                  summary.fuelResource,
                  game,
                ) * game.operatingConfig.fuelPricePerRealUnit[summary.fuelResource],
              0,
            )

      return {
        mode: option.mode,
        totalDistanceMiles,
        combinedDemand,
        claimCost: Math.ceil(
          calculateClaimRouteCost(game, {
            cityIds: selectedCities.map(city => city.id),
            mode: option.mode,
          }),
        ),
        weeklyFuelUnits,
        fuelCostPerWeek,
      }
    })
  }, [connectionOptions, currentPlayerOwnedVehicleCards, game, selectedCities])
  const canBuyFuelByResource = useMemo(
    () => ({
      diesel: currentPlayerOwnedVehicleCards.some(card => card.type !== "air"),
      jetFuel: currentPlayerOwnedVehicleCards.some(card => card.type === "air"),
    }),
    [currentPlayerOwnedVehicleCards],
  )
  const maxFuelHoldingsByResource = useMemo(
    () => ({
      diesel: currentPlayer
        ? getMaxFuelUnitsCapacityForPlayer(game, currentPlayer.id, "diesel") * 2
        : 0,
      jetFuel: currentPlayer
        ? getMaxFuelUnitsCapacityForPlayer(game, currentPlayer.id, "jetFuel") * 2
        : 0,
    }),
    [currentPlayer, game],
  )

  const playerSummaries = useMemo(() => {
    return game.players.map(player => {
      const ownedRoutes = game.routes.filter(route => route.ownerId === player.id)
      const connectedCityIds = new Set<string>()

      for (const route of ownedRoutes) {
        connectedCityIds.add(route.cityA)
        connectedCityIds.add(route.cityB)
      }

      const connectedCities = [...connectedCityIds]
        .map(cityId => cityMap[cityId]?.name ?? cityId)
        .sort((cityA, cityB) => cityA.localeCompare(cityB))

      const connectedRoutes = ownedRoutes.map(route => {
        const cityA = cityMap[route.cityA]?.name ?? route.cityA
        const cityB = cityMap[route.cityB]?.name ?? route.cityB

        return `${cityA} - ${cityB} (${MODE_LABELS[route.mode]})`
      })
      const weeklyNet = player.weeklyPayout - player.operatingCosts
      const ownedVehicleCards = player.ownedVehicleCardIds
        .map(cardId => vehicleCardMap[cardId])
        .filter((card): card is VehicleCard => card !== undefined)

      return {
        player,
        connectedCities,
        connectedRoutes,
        ownedVehicleCards,
        weeklyNet,
      }
    })
  }, [cityMap, game.players, game.routes, vehicleCardMap])

  const expandedPlayerSummary = playerSummaries.find(
    summary => summary.player.id === expandedPlayerId,
  )
  const resourceSummaries = useMemo(() => {
    return (["diesel", "jetFuel"] as PurchasableResource[]).map(resource => {
      const slots = game.resourceMarket[resource]
      const availableUnits = slots.reduce((total, units) => total + units, 0)
      const cheapestIndex = slots.findIndex(units => units > 0)

        return {
          resource,
          slots,
          availableUnits,
          cheapestPrice:
            cheapestIndex === -1 ? null : getFuelUnitPrice(resource, cheapestIndex),
        }
      })
    }, [game.resourceMarket])
  const visibleVehicleCards = useMemo(() => {
    return game.vehicleMarketCardIds
      .slice(0, 4)
      .map(cardId => vehicleCardMap[cardId])
      .filter((card): card is VehicleCard => card !== undefined)
  }, [game.vehicleMarketCardIds, vehicleCardMap])
  const remainingVehicleCardCount = Math.max(
    0,
    game.vehicleMarketCardIds.length - visibleVehicleCards.length,
  )
  const currentPlayerIndex = game.players.findIndex(
    player => player.id === game.currentPlayerId,
  )
  const currentPlayerBureaucracySummary = bureaucracySummaries.find(
    summary => summary.player.id === game.currentPlayerId,
  )
  const nextPlayer = currentPlayerIndex === -1
    ? game.players[0]
    : game.players[(currentPlayerIndex + 1) % game.players.length]
  const shouldAdvancePhase = isLastPlayerTurn(game)

  function getFuelInfoLabel(resource: PurchasableResource, units: number) {
    const realFuel = calculateRealFuelFromUnits(units, resource, game)

    return `${formatDecimal(units)} ${getResourceLabel(resource).toLowerCase()} unit${units === 1 ? "" : "s"} = ${formatDecimal(realFuel)} ${getRealFuelLabel(resource)}`
  }

  function resetSelection(message = getPhaseStatusMessage(game.currentPhase)) {
    setSelectedCityIds([])
    setHoverCityId(null)
    setStatusMessage(message)
  }

  useEffect(() => {
    if (selectedCityIds.some(cityId => !visibleCityIds.has(cityId))) {
      resetSelection("Zoom in to interact with smaller cities.")
    }
  }, [selectedCityIds, visibleCityIds])

  useEffect(() => {
    if (hoverCityId && !visibleCityIds.has(hoverCityId)) {
      setHoverCityId(null)
    }
  }, [hoverCityId, visibleCityIds])

  useEffect(() => {
    setSelectedCityIds([])
    setHoverCityId(null)
    setStatusMessage(getPhaseStatusMessage(game.currentPhase))
  }, [game.currentPhase])

  useEffect(() => {
    setIsResourceMarketOpen(game.currentPhase === "purchase-fuel")
    setIsVehicleMarketOpen(game.currentPhase === "purchase-equipment")
    setIsBureaucracyOpen(game.currentPhase === "bureaucracy")
  }, [game.currentPhase])

  function handleCityClick(cityId: string) {
    if (game.currentPhase !== "claim-routes") {
      resetSelection(getRouteInteractionMessage(game.currentPhase))
      return
    }

    if (!visibleCityIds.has(cityId)) {
      return
    }

    if (selectedCityIds.length === 0) {
      setSelectedCityIds([cityId])
      setStatusMessage("Choose a second city.")
      return
    }

    if (selectedCityIds[selectedCityIds.length - 1] === cityId) {
      if (selectedCityIds.length === 1) {
        resetSelection("Selection cleared.")
        return
      }

      setSelectedCityIds(current => current.slice(0, -1))
      setHoverCityId(null)
      setStatusMessage("Removed the last city from the route chain.")
      return
    }

    if (selectedCityIds.includes(cityId)) {
      setSelectedCityIds([cityId])
      setHoverCityId(null)
      setStatusMessage("Restarted the route chain from that city.")
      return
    }

    setSelectedCityIds(current => [...current, cityId])
    setHoverCityId(null)
    setStatusMessage(
      selectedCityIds.length >= 1
        ? "Add another city or choose a connection type."
        : "Choose a second city.",
    )
  }

  function handleClaim(mode: RouteMode) {
    if (game.currentPhase !== "claim-routes") {
      setStatusMessage(getRouteInteractionMessage(game.currentPhase))
      return
    }

    if (selectedCityIds.length < 2) {
      return
    }

    const result = onClaimRoute(selectedCityIds, mode)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    const routeLabel = selectedCities.map(city => city.name).join(" -> ")

    resetSelection(
      `${currentPlayer?.name ?? "Current player"} claimed ${result.routes.length} ${MODE_LABELS[mode].toLowerCase()} segment${result.routes.length === 1 ? "" : "s"} across ${routeLabel}${result.cost > 0 ? ` for ${formatCurrency(result.cost)}` : ""}.`,
    )
  }

  function handleAdvanceTurnClick() {
    const nextStatusMessage = shouldAdvancePhase
      ? `Starting ${formatPhaseLabel(getNextPhase(game.currentPhase)).toLowerCase()}.`
      : `${nextPlayer?.name ?? "Next player"} is up.`

    onAdvanceTurn()
    resetSelection(nextStatusMessage)
  }

  function handleBuyResourceClick(resource: PurchasableResource) {
    const result = onBuyResource(resource)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(
      `${currentPlayer?.name ?? "Current player"} bought 1 ${getResourceLabel(resource).toLowerCase()} for ${formatCurrency(result.cost)}.`,
    )
  }

  function handleBuyVehicleCardClick(cardId: string) {
    const result = onBuyVehicleCard(cardId)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(
      `${currentPlayer?.name ?? "Current player"} bought vehicle card ${result.card.number} (${getVehicleTypeLabel(result.card.type).toLowerCase()}) for ${formatCurrency(result.cost)}.`,
    )
  }

  function handleSetBureaucracyFuelUnits(routeId: string, requestedFuelUnits: number) {
    const result = onSetBureaucracyRouteFuelUnits(routeId, requestedFuelUnits)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    if (result.fuelUnits !== Math.max(0, Math.floor(requestedFuelUnits))) {
      setStatusMessage(
        `Fuel units adjusted to ${result.fuelUnits} based on route limits and available fuel.`,
      )
      return
    }

    setStatusMessage(
      `Allocated ${result.fuelUnits} fuel unit${result.fuelUnits === 1 ? "" : "s"} to that route.`,
    )
  }

  function handleSetBureaucracyVehicleCard(routeId: string, vehicleCardId: string | null) {
    const result = onSetBureaucracyRouteVehicleCard(routeId, vehicleCardId)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(
      vehicleCardId === null
        ? "Cleared the assigned vehicle for that route."
        : "Updated the vehicle assigned to that route.",
    )
  }

  return (
    <div style={BOARD_SHELL_STYLE}>
      <div style={TOP_BAR_STYLE}>
        {playerSummaries.map(({ player, connectedCities, connectedRoutes, weeklyNet }) => (
          <button
            key={`${player.id}-summary`}
            type="button"
            onClick={() => setExpandedPlayerId(current =>
              current === player.id ? null : player.id,
            )}
            style={{
              ...TOP_BAR_PLAYER_STYLE,
              borderColor: player.id === game.currentPlayerId ? player.color : "#d8dfd5",
              boxShadow:
                player.id === game.currentPlayerId
                  ? `0 0 0 2px ${player.color}33 inset`
                  : "none",
              background:
                player.id === game.currentPlayerId ? `${player.color}14` : "#ffffff",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <strong style={{ color: player.color }}>{player.name}</strong>
            </div>
            <div>
              <span>
                <strong>$</strong> {player.money.toLocaleString()}
              </span>
            </div>
            <div
              style={{
                color: weeklyNet > 0 ? "#2a7f3b" : weeklyNet < 0 ? "#b42318" : "#666666",
                fontWeight: 600,
              }}
            >
              {weeklyNet >= 0 ? "+" : "-"}${Math.abs(weeklyNet).toLocaleString()}
            </div>
            <div style={{ display: "flex", gap: 12, color: "#324236" }}>
              <span>🏙 {connectedCities.length}</span>
              <span>🛤 {connectedRoutes.length}</span>
            </div>
          </button>
        ))}
      </div>
      <div style={HUD_STYLE}>
        <div>
          <strong>Current turn:</strong>{" "}
          <span style={{ color: currentPlayer?.color }}>
            {currentPlayer?.name ?? "Unknown player"}
          </span>
        </div>
        <div>
          <strong>Selection:</strong> {selectionSummary}
        </div>
        <div>
          <strong>Visible cities:</strong> size {minimumVisibleCitySize}+
        </div>
        <div>{statusMessage}</div>
        {selectedCityIds.length >= 2 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {connectionOptions.map(option => (
              <button
                key={option.mode}
                type="button"
                disabled={!option.valid}
                onClick={() => handleClaim(option.mode)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  cursor: option.valid ? "pointer" : "not-allowed",
                  background: option.valid ? "#ffffff" : "#f2f2f2",
                  color: option.valid ? "#222222" : "#767676",
                }}
              >
                {MODE_LABELS[option.mode]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => resetSelection()}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: "1px solid #c7d0c4",
                cursor: "pointer",
                background: "#ffffff",
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {optionMessage && selectedCityIds.length >= 2 && <div>{optionMessage}</div>}
        {routePreviewSummaries.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            {routePreviewSummaries.map(summary => (
              <div key={`${summary.mode}-preview`} style={{ color: "#324236" }}>
                <strong>{MODE_LABELS[summary.mode]}:</strong> {formatDecimal(summary.totalDistanceMiles)} mi
                {" • "}Demand {summary.combinedDemand}
                {summary.claimCost > 0 && (
                  <>
                    {" • "}Build {formatCurrency(summary.claimCost)}
                  </>
                )}
                {summary.fuelCostPerWeek !== null && (
                  <>
                    {" • "}Fuel {formatDecimal(summary.weeklyFuelUnits)}u/week
                    {" • "}{formatCurrency(summary.fuelCostPerWeek)}/week
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {expandedPlayerSummary && (
        <div style={PLAYER_PANEL_STYLE}>
          <strong>Player ledger</strong>
          <div style={PLAYER_CARD_STYLE}>
            <div>
              <strong style={{ color: expandedPlayerSummary.player.color }}>
                {expandedPlayerSummary.player.name}
              </strong>
            </div>
            <div>
              <strong>Money:</strong> {formatCurrency(expandedPlayerSummary.player.money)}
            </div>
            <div>
              <strong>Operating costs:</strong>{" "}
              {formatCurrency(expandedPlayerSummary.player.operatingCosts)}
            </div>
            <div>
              <strong>Weekly payout:</strong>{" "}
              {formatCurrency(expandedPlayerSummary.player.weeklyPayout)}
            </div>
            <div>
              <strong>Vehicles:</strong>{" "}
              {expandedPlayerSummary.player.inventory.vehicles.trains} trains,{" "}
              {expandedPlayerSummary.player.inventory.vehicles.planes} planes,{" "}
              {expandedPlayerSummary.player.inventory.vehicles.buses} buses
            </div>
            <div>
              <strong>Vehicle cards:</strong>{" "}
              {expandedPlayerSummary.ownedVehicleCards.length > 0
                ? expandedPlayerSummary.ownedVehicleCards
                    .map(card => `#${card.number} ${card.name}`)
                    .join(", ")
                : "None yet"}
            </div>
            <div>
              <strong>Fuel:</strong>{" "}
              <span>
                {formatDecimal(expandedPlayerSummary.player.inventory.fuel.diesel)} diesel units
              </span>
              <InfoBubble
                label={getFuelInfoLabel(
                  "diesel",
                  expandedPlayerSummary.player.inventory.fuel.diesel,
                )}
              />
              {", "}
              <span>
                {formatDecimal(expandedPlayerSummary.player.inventory.fuel.jetFuel)} jet fuel units
              </span>
              <InfoBubble
                label={getFuelInfoLabel(
                  "jetFuel",
                  expandedPlayerSummary.player.inventory.fuel.jetFuel,
                )}
              />
            </div>
            <div>
              <strong>Connected cities:</strong>{" "}
              {expandedPlayerSummary.connectedCities.length > 0
                ? expandedPlayerSummary.connectedCities.join(", ")
                : "None yet"}
            </div>
            <div>
              <strong>Connected segments:</strong>{" "}
              {expandedPlayerSummary.connectedRoutes.length > 0
                ? expandedPlayerSummary.connectedRoutes.join("; ")
                : "None yet"}
            </div>
          </div>
        </div>
      )}
      {isBureaucracyOpen && (
        <div style={RESOURCE_MARKET_PANEL_STYLE}>
          <strong>Bureaucracy ledger</strong>
          <div style={{ color: "#56635a" }}>
            Assign vehicles to routes, then choose whole fuel units per route. One owned vehicle card operates one matching route, and revenue is paid per passenger-mile actually served.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 12,
            }}
          >
            {bureaucracySummaries.map(summary => (
              <div
                key={`${summary.player.id}-bureaucracy`}
                style={{
                  border: "1px solid #d8dfd5",
                  borderRadius: 10,
                  padding: 10,
                  background:
                    summary.player.id === game.currentPlayerId
                      ? `${summary.player.color}12`
                      : "#ffffff",
                  boxShadow:
                    summary.player.id === game.currentPlayerId
                      ? `0 0 0 2px ${summary.player.color}22 inset`
                      : "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div>
                  <strong style={{ color: summary.player.color }}>{summary.player.name}</strong>
                </div>
                <div>Revenue: {formatCurrency(summary.totalRevenue)}</div>
                <div>
                  <strong>Net:</strong> {formatCurrency(summary.netRevenue)}
                </div>
                <div>Passengers served: {summary.totalPassengersServed.toLocaleString()}</div>
                <div>
                  Fuel used: {formatDecimal(summary.fuelUsedUnits.diesel)} diesel units
                  <InfoBubble
                    label={`${formatDecimal(summary.fuelUsedReal.diesel)} ${getRealFuelLabel("diesel")}`}
                  />
                  {", "}
                  {formatDecimal(summary.fuelUsedUnits.jetFuel)} jet fuel units
                  <InfoBubble
                    label={`${formatDecimal(summary.fuelUsedReal.jetFuel)} ${getRealFuelLabel("jetFuel")}`}
                  />
                </div>
                <div>
                  Fuel remaining: {formatDecimal(summary.fuelRemainingUnits.diesel)} diesel units
                  <InfoBubble
                    label={`${formatDecimal(summary.fuelRemainingReal.diesel)} ${getRealFuelLabel("diesel")}`}
                  />
                  {", "}
                  {formatDecimal(summary.fuelRemainingUnits.jetFuel)} jet fuel units
                  <InfoBubble
                    label={`${formatDecimal(summary.fuelRemainingReal.jetFuel)} ${getRealFuelLabel("jetFuel")}`}
                  />
                </div>
                {summary.routePlans.length === 0 ? (
                  <div style={{ color: "#56635a" }}>No routes to operate.</div>
                ) : (
                  summary.routePlans.map(plan => (
                    <div
                      key={`${summary.player.id}-${plan.route.id}`}
                      style={{
                        border: "1px solid #e1e6df",
                        borderRadius: 8,
                        padding: 8,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      <div>
                        <strong>
                          {plan.cityAName} - {plan.cityBName}
                        </strong>
                      </div>
                      <div style={{ color: "#56635a", fontSize: 13 }}>
                        {MODE_LABELS[plan.route.mode]}{" "}
                        {plan.vehicleCard
                          ? `• #${plan.vehicleCard.number} ${plan.vehicleCard.name}`
                          : "• No vehicle assigned"}
                      </div>
                      {summary.player.id === game.currentPlayerId ? (
                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            fontSize: 13,
                          }}
                        >
                          Vehicle
                          <select
                            value={plan.vehicleCard?.id ?? ""}
                            onChange={event =>
                              handleSetBureaucracyVehicleCard(
                                plan.route.id,
                                event.target.value === "" ? null : event.target.value,
                              )
                            }
                            style={{
                              minWidth: 220,
                              padding: "6px 8px",
                              borderRadius: 8,
                              border: "1px solid #c7d0c4",
                              background: "#ffffff",
                            }}
                          >
                            <option value="">No vehicle assigned</option>
                            {currentPlayerOwnedVehicleCards
                              .filter(
                                card => card.type === getVehicleTypeForMode(plan.route.mode),
                              )
                              .map(card => (
                                <option key={card.id} value={card.id}>
                                  #{card.number} {card.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      ) : null}
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "4px 10px",
                          color: "#324236",
                          fontSize: 13,
                        }}
                      >
                        {plan.distanceMiles !== null && (
                          <span>{formatDecimal(plan.distanceMiles)} mi</span>
                        )}
                        <span>Demand {plan.combinedDemand}</span>
                        <span>max {plan.maxTripsByTime} trips</span>
                        <span>👥 {plan.passengersPerTrip.toLocaleString()}</span>
                        {plan.statsFuelResource && (
                          <span>
                            {getResourceIcon(plan.statsFuelResource)}{" "}
                            {formatDecimal(plan.weeklyFuelBurnUnits)} u/week
                          </span>
                        )}
                        {plan.statsFuelResource && plan.statsFuelBurnUnit && (
                          <InfoBubble
                            label={`${formatDecimal(plan.weeklyFuelBurnReal)} ${plan.statsFuelBurnUnit} ${getResourceLabel(plan.statsFuelResource).toLowerCase()} per week`}
                          />
                        )}
                      </div>
                      {plan.vehicleCard ? (
                        <>
                          {summary.player.id === game.currentPlayerId ? (
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                fontSize: 13,
                              }}
                            >
                              Fuel units
                              <input
                                type="number"
                                min={0}
                                max={getMaxFuelUnitsForRoute(game, plan.route.id)}
                                step={1}
                                value={plan.selectedFuelUnits}
                                onChange={event => {
                                  const nextFuelUnits =
                                    event.target.value === ""
                                      ? 0
                                      : Number(event.target.value)
                                  handleSetBureaucracyFuelUnits(
                                    plan.route.id,
                                    nextFuelUnits,
                                  )
                                }}
                                style={{
                                  width: 72,
                                  padding: "6px 8px",
                                  borderRadius: 8,
                                  border: "1px solid #c7d0c4",
                                }}
                              />
                            </label>
                          ) : (
                            <div>Fuel units planned: {plan.selectedFuelUnits}</div>
                          )}
                          <div style={{ color: "#56635a", fontSize: 12 }}>
                            Total fuel: {formatDecimal(plan.totalFuelBurnUnits)} units
                            {plan.fuelResource && plan.fuelBurnUnit && (
                              <InfoBubble
                                label={`${formatDecimal(plan.totalFuelBurnReal)} ${plan.fuelBurnUnit} total`}
                              />
                            )}{" "}
                            • Trips: {plan.selectedTrips}
                            {" • "}Passengers: {plan.passengersServed.toLocaleString()}
                            {" • "}Revenue: {formatCurrency(plan.revenue)}
                          </div>
                        </>
                      ) : (
                        <div style={{ color: "#9b1c1c", fontSize: 13 }}>
                          Assign a matching vehicle card to operate this route.
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {isVehicleMarketOpen && (
        <div style={RESOURCE_MARKET_PANEL_STYLE}>
          <strong>Vehicle market</strong>
          <div style={{ color: "#56635a" }}>
            The deck is shuffled when the game starts. Only the first 4 cards can be bought during purchase equipment.
          </div>
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 10,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div>
              <strong>Purchase used this turn:</strong>{" "}
              {game.hasPurchasedVehicleThisTurn ? "Yes" : "No"}
            </div>
            <div>
              <strong>Remaining deck:</strong> {remainingVehicleCardCount} card
              {remainingVehicleCardCount === 1 ? "" : "s"} behind the market
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 10,
              }}
            >
              {visibleVehicleCards.map(card => {
                const canBuy =
                  game.currentPhase === "purchase-equipment" &&
                  !game.hasPurchasedVehicleThisTurn &&
                  (currentPlayer?.money ?? 0) >= card.purchasePrice

                return (
                  <div
                    key={card.id}
                    style={{
                      border: "1px solid #d8dfd5",
                      borderRadius: 10,
                      padding: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                      background: "#ffffff",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong>
                        #{card.number} {getVehicleTypeIcon(card.type)} {getVehicleTypeLabel(card.type)}
                      </strong>
                      <span>{formatCurrency(card.purchasePrice)}</span>
                    </div>
                    <div style={{ fontWeight: 600, color: "#223024" }}>{card.name}</div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "4px 10px",
                        color: "#324236",
                        fontSize: 13,
                      }}
                    >
                      <span>
                        {getVehicleTypeIcon(card.type)} x{card.vehicleCount}
                      </span>
                      <span>👤 {card.capacityPerVehicle.toLocaleString()}</span>
                      <span>👥 {card.totalPassengerCapacity.toLocaleString()}</span>
                      <span>{card.speed}mph</span>
                      <span>⚙️{card.operatingCostMultiplier}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <span
                        title={card.funFact}
                        aria-label={card.funFact}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          border: "1px solid #c7d0c4",
                          color: "#56635a",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "help",
                          userSelect: "none",
                        }}
                      >
                        ?
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={!canBuy}
                      onClick={() => handleBuyVehicleCardClick(card.id)}
                      style={{
                        marginTop: 4,
                        padding: "8px 12px",
                        borderRadius: 999,
                        border: "1px solid #c7d0c4",
                        cursor: canBuy ? "pointer" : "not-allowed",
                        background: canBuy ? "#ffffff" : "#f2f2f2",
                      }}
                    >
                      Buy card
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
      {isResourceMarketOpen && (
        <div style={RESOURCE_MARKET_PANEL_STYLE}>
          <strong>Resource market</strong>
          <div style={{ color: "#56635a" }}>
            Buy only fuel your fleet can use. Diesel starts at $3/gal and jet fuel at $0.60/pound behind the scenes.
          </div>
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 10,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div>
              <strong>Owned fuel:</strong>{" "}
              {currentPlayer
                ? (
                    <>
                      {getResourceIcon("diesel")}{" "}
                      {formatDecimal(currentPlayer.inventory.fuel.diesel)}/
                      {formatDecimal(maxFuelHoldingsByResource.diesel)}
                      <InfoBubble
                        label={getFuelInfoLabel(
                          "diesel",
                          currentPlayer.inventory.fuel.diesel,
                        )}
                      />
                      {", "}
                      {getResourceIcon("jetFuel")}{" "}
                      {formatDecimal(currentPlayer.inventory.fuel.jetFuel)}/
                      {formatDecimal(maxFuelHoldingsByResource.jetFuel)}
                      <InfoBubble
                        label={getFuelInfoLabel(
                          "jetFuel",
                          currentPlayer.inventory.fuel.jetFuel,
                        )}
                      />
                    </>
                  )
                : "No player selected"}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  minWidth: 620,
                }}
              >
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel</th>
                    {Array.from({ length: 8 }, (_, index) => (
                      <th
                        key={`price-${index + 1}`}
                        style={{ textAlign: "center", padding: "6px 8px" }}
                      >
                        Slot {index + 1}
                      </th>
                    ))}
                    <th style={{ textAlign: "center", padding: "6px 8px" }}>Buy</th>
                  </tr>
                </thead>
                <tbody>
                  {resourceSummaries.map(summary => (
                    <tr key={summary.resource}>
                      <td style={{ padding: "8px" }}>
                        <strong>
                          {getResourceIcon(summary.resource)} {getResourceLabel(summary.resource)}
                        </strong>
                      </td>
                      {summary.slots.map((units, index) => (
                        <td
                          key={`${summary.resource}-${index + 1}`}
                          style={{
                            textAlign: "center",
                            padding: "8px",
                            background: units > 0 ? "#eef3ec" : "#f5f5f5",
                            color: units > 0 ? "#223024" : "#848484",
                            borderRadius: 6,
                          }}
                        >
                          <div>{units}</div>
                          <div style={{ fontSize: 11 }}>
                            {formatCurrency(
                              getFuelUnitPrice(summary.resource, index) ?? 0,
                            )}
                          </div>
                        </td>
                      ))}
                      <td style={{ textAlign: "center", padding: "8px" }}>
                        <button
                          type="button"
                          disabled={
                            game.currentPhase !== "purchase-fuel" ||
                            !canBuyFuelByResource[summary.resource] ||
                            (
                              currentPlayer !== undefined &&
                              currentPlayer.inventory.fuel[summary.resource] + 1 >
                                maxFuelHoldingsByResource[summary.resource]
                            ) ||
                            summary.cheapestPrice === null
                          }
                          onClick={() => handleBuyResourceClick(summary.resource)}
                          style={{
                            padding: "8px 12px",
                            borderRadius: 999,
                            border: "1px solid #c7d0c4",
                            cursor:
                              game.currentPhase === "purchase-fuel" &&
                              canBuyFuelByResource[summary.resource] &&
                              (
                                currentPlayer === undefined ||
                                currentPlayer.inventory.fuel[summary.resource] + 1 <=
                                  maxFuelHoldingsByResource[summary.resource]
                              ) &&
                              summary.cheapestPrice !== null
                                ? "pointer"
                                : "not-allowed",
                            background:
                              game.currentPhase === "purchase-fuel" &&
                              canBuyFuelByResource[summary.resource] &&
                              (
                                currentPlayer === undefined ||
                                currentPlayer.inventory.fuel[summary.resource] + 1 <=
                                  maxFuelHoldingsByResource[summary.resource]
                              ) &&
                              summary.cheapestPrice !== null
                                ? "#ffffff"
                                : "#f2f2f2",
                          }}
                        >
                          Buy
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      <div style={BOTTOM_BAR_STYLE}>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <div>
            <strong>Week:</strong> {game.currentWeek}
          </div>
          <div>
            <strong>Phase:</strong> {formatPhaseLabel(game.currentPhase)}
          </div>
          <div>
            <strong>Selection length:</strong> {selectedCityIds.length}
          </div>
          {game.currentPhase === "bureaucracy" && currentPlayerBureaucracySummary && (
            <div>
              <strong>Planned fuel units:</strong>{" "}
              {currentPlayerBureaucracySummary.routePlans.reduce(
                (total, plan) => total + plan.selectedFuelUnits,
                0,
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              setIsResourceMarketOpen(open => !open)
              setIsVehicleMarketOpen(false)
              setIsBureaucracyOpen(false)
            }}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: "pointer",
              background: "#ffffff",
              fontWeight: 600,
            }}
          >
            {isResourceMarketOpen ? "Hide resources" : "Resources"}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsVehicleMarketOpen(open => !open)
              setIsResourceMarketOpen(false)
              setIsBureaucracyOpen(false)
            }}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: "pointer",
              background: "#ffffff",
              fontWeight: 600,
            }}
          >
            {isVehicleMarketOpen ? "Hide vehicles" : "Vehicles"}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsBureaucracyOpen(open => !open)
              setIsResourceMarketOpen(false)
              setIsVehicleMarketOpen(false)
            }}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: "pointer",
              background: "#ffffff",
              fontWeight: 600,
            }}
          >
            {isBureaucracyOpen ? "Hide bureaucracy" : "Bureaucracy"}
          </button>
          <button
            type="button"
            onClick={handleAdvanceTurnClick}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: "pointer",
              background: "#ffffff",
              fontWeight: 600,
            }}
          >
            {shouldAdvancePhase ? "Next phase" : "Next player"}
          </button>
        </div>
      </div>
      <TransformWrapper
        minScale={0.5}
        maxScale={6}
        centerOnInit
        limitToBounds={false}
        onTransform={(_, state) => {
          setZoomScale(current => (
            Math.abs(current - state.scale) < 0.001 ? current : state.scale
          ))
        }}
      >
        <TransformComponent>
          <svg
            viewBox={`0 0 ${map.width} ${map.height}`}
            style={{
              width: "100vw",
              height: "100vh",
              display: "block",
            }}
          >
            <path
              d={`M ${outlinePath} Z`}
              fill={MAP_OUTLINE_STYLE.fill}
              stroke={MAP_OUTLINE_STYLE.stroke}
              strokeWidth={2}
              opacity={MAP_OUTLINE_STYLE.opacity}
            />

            {game.routes.map(route => {
              const aCity = cityMap[route.cityA]
              const bCity = cityMap[route.cityB]
              if (!aCity || !bCity) return null
              if (!visibleCityIds.has(aCity.id) || !visibleCityIds.has(bCity.id)) {
                return null
              }

              const a = latLngToWorld(aCity)
              const b = latLngToWorld(bCity)
              const owner = route.ownerId ? playerMap[route.ownerId] : undefined
              const lineStyle = MODE_LINE_STYLES[route.mode]

              return (
                <line
                  key={route.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={owner?.color ?? "#222222"}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray={lineStyle.strokeDasharray}
                  opacity={lineStyle.opacity}
                />
              )
            })}

            {previewVisible && (
              <polyline
                points={previewPoints.map(point => `${point.x},${point.y}`).join(" ")}
                fill="none"
                stroke={currentPlayer?.color ?? "#444444"}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="10 8"
                opacity={0.75}
              />
            )}

            {visibleCities.map(city => {
              const { x, y } = latLngToWorld(city)
              const label = labelMap[city.id]

              if (!label) {
                return null
              }

              const dx = label.connectorX - x
              const dy = label.connectorY - y
              const connectorLength = Math.sqrt(dx * dx + dy * dy)
              const radius = city.size * 2.5

              if (connectorLength <= radius + 8) {
                return null
              }

              const unitX = dx / connectorLength
              const unitY = dy / connectorLength

              return (
                <line
                  key={`${city.id}-label-connector`}
                  x1={x + unitX * (radius + 1)}
                  y1={y + unitY * (radius + 1)}
                  x2={label.connectorX}
                  y2={label.connectorY}
                  stroke="rgba(34, 48, 36, 0.28)"
                  strokeWidth={1.25}
                  strokeLinecap="round"
                  pointerEvents="none"
                />
              )
            })}

            {hiddenCities.map(city => {
              const { x, y } = latLngToWorld(city)

              return (
                <circle
                  key={`${city.id}-hint`}
                  cx={x}
                  cy={y}
                  r={Math.max(1.6, city.size * 1.2)}
                  fill="rgba(34, 48, 36, 0.38)"
                  stroke="rgba(244, 241, 232, 0.55)"
                  strokeWidth={0.8}
                  pointerEvents="none"
                />
              )
            })}

            {visibleCities.map(city => {
              const { x, y } = latLngToWorld(city)
              const label = labelMap[city.id]
              const isSelected = selectedCityIds.includes(city.id)
              const isPreviewTarget =
                selectedCityIds.length === 1 && hoverCityId === city.id
              const fill = isSelected
                ? currentPlayer?.color ?? "#ffffff"
                : isPreviewTarget
                  ? "#d7e8ff"
                  : "#ffffff"

              return (
                <g
                  key={city.id}
                  onClick={() => handleCityClick(city.id)}
                  onMouseEnter={() => setHoverCityId(city.id)}
                  onMouseLeave={() => setHoverCityId(current =>
                    current === city.id ? null : current,
                  )}
                  style={{ cursor: "pointer" }}
                >
                  <circle
                    cx={x}
                    cy={y}
                    r={city.size * 2.5}
                    fill={fill}
                    stroke="black"
                    strokeWidth={isSelected ? 2.5 : 1.5}
                  />

                  {label && (
                    <text
                      x={label.textX}
                      y={label.textY}
                      fontSize={12}
                      textAnchor={label.textAnchor}
                      dominantBaseline="middle"
                      fill="#223024"
                      stroke="rgba(244, 241, 232, 0.95)"
                      strokeWidth={4}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {city.name}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </TransformComponent>
      </TransformWrapper>
    </div>
  )
}
