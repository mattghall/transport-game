import { useEffect, useMemo, useState } from "react"
import {
  type RailUpgradeResult,
  calculateClaimRouteCost,
  type BureaucracyVehicleCardResult,
  getFuelPurchaseCost,
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
import {
  buildVictoryStandings,
  calculateConnectionBonus,
  getActiveChanceCard,
  getCombinedDemandForCityIds,
  getConnectedCityIds,
  getFuelPriceMultiplier,
  getRailTraction,
  getRailUpgradeCost,
} from "../engine/economy"
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
  onBuyResource: (resource: PurchasableResource, quantity: number) => ResourcePurchaseResult
  onBuyVehicleCard: (cardId: string) => VehiclePurchaseResult
  onUpgradeRailRoute: (routeId: string) => RailUpgradeResult
  onSetBureaucracyRouteVehicleCard: (
    routeId: string,
    vehicleCardId: string | null,
  ) => BureaucracyVehicleCardResult
  onSetBureaucracyRouteFuelUnits: (
    routeId: string,
    fuelUnits: number,
  ) => BureaucracyFuelUnitsResult
  onAdvanceTurn: () => void
  onUndo: () => void
  canUndo: boolean
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

function formatUnitRate(amount: number, digits = 2) {
  return `$${amount.toFixed(digits)}`
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
  onUpgradeRailRoute,
  onSetBureaucracyRouteVehicleCard,
  onSetBureaucracyRouteFuelUnits,
  onAdvanceTurn,
  onUndo,
  canUndo,
}: Props) {
  type RestorablePanel = "resource" | "vehicle" | "bureaucracy" | "economics" | null

  const [selectedCityIds, setSelectedCityIds] = useState<string[]>([])
  const [hoverCityId, setHoverCityId] = useState<string | null>(null)
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const [isResourceMarketOpen, setIsResourceMarketOpen] = useState(false)
  const [isVehicleMarketOpen, setIsVehicleMarketOpen] = useState(false)
  const [isBureaucracyOpen, setIsBureaucracyOpen] = useState(false)
  const [isEconomicsOpen, setIsEconomicsOpen] = useState(false)
  const [isWikiOpen, setIsWikiOpen] = useState(false)
  const [wikiPreviousPanel, setWikiPreviousPanel] = useState<RestorablePanel>(null)
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
  const connectionBonusPreview = useMemo(
    () =>
      selectedCities.length >= 2
        ? calculateConnectionBonus(
            game,
            game.currentPlayerId,
            selectedCities.map(city => city.id),
          )
        : null,
    [game, selectedCities],
  )
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
    const combinedDemand = getCombinedDemandForCityIds(
      game,
      selectedCities.map(city => city.id),
    )

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
              (total, summary) => {
                if (summary.fuelResource === null) {
                  return total
                }

                return (
                  total +
                  calculateRealFuelFromUnits(
                    Math.ceil(summary.tripFuelUnits * summary.tripsPerWeek),
                    summary.fuelResource,
                    game,
                  ) * game.operatingConfig.fuelPricePerRealUnit[summary.fuelResource]
                )
              },
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
        connectionBonus: connectionBonusPreview?.totalBonus ?? 0,
        newCityCount: connectionBonusPreview?.newlyConnectedCityIds.length ?? 0,
        weeklyFuelUnits,
        fuelCostPerWeek,
      }
    })
  }, [connectionBonusPreview, connectionOptions, currentPlayerOwnedVehicleCards, game, selectedCities])
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
  const activeChanceCard = useMemo(() => getActiveChanceCard(game), [game])
  const victoryStandings = useMemo(() => buildVictoryStandings(game), [game])
  const leadingStanding = victoryStandings[0]
  const weeksRemaining = Math.max(0, game.operatingConfig.totalWeeks - game.currentWeek)
  const effectiveFuelPriceByResource = useMemo(
    () => ({
      diesel:
        game.operatingConfig.fuelPricePerRealUnit.diesel *
        getFuelPriceMultiplier(game, "diesel"),
      jetFuel:
        game.operatingConfig.fuelPricePerRealUnit.jetFuel *
        getFuelPriceMultiplier(game, "jetFuel"),
    }),
    [game],
  )
  const economicsRows = useMemo(
    () => [
      {
        label: "Bus",
        ticketPricePerMile: game.operatingConfig.revenuePerPassengerMile.bus,
        operatingCostPerTrip: game.operatingConfig.operatingCostPerTrip.bus,
        loadingHours: game.operatingConfig.loadingHours.bus,
        fuel: "Diesel",
        fuelPrice: formatUnitRate(effectiveFuelPriceByResource.diesel),
        fuelUnit: `${formatDecimal(game.operatingConfig.fuelUnits.diesel, 0)} gal/unit`,
      },
      {
        label: "Air",
        ticketPricePerMile: game.operatingConfig.revenuePerPassengerMile.air,
        operatingCostPerTrip: game.operatingConfig.operatingCostPerTrip.air,
        loadingHours: game.operatingConfig.loadingHours.air,
        fuel: "Jet fuel",
        fuelPrice: formatUnitRate(effectiveFuelPriceByResource.jetFuel),
        fuelUnit: `${formatDecimal(game.operatingConfig.fuelUnits.jetFuel, 0)} lb/unit`,
      },
      {
        label: "Rail (diesel)",
        ticketPricePerMile: game.operatingConfig.revenuePerPassengerMile.rail,
        operatingCostPerTrip: game.operatingConfig.operatingCostPerTrip.railDiesel,
        loadingHours: game.operatingConfig.loadingHours.train,
        fuel: "Diesel",
        fuelPrice: formatUnitRate(effectiveFuelPriceByResource.diesel),
        fuelUnit: `${formatDecimal(game.operatingConfig.fuelUnits.diesel, 0)} gal/unit`,
      },
      {
        label: "Rail (electric)",
        ticketPricePerMile: game.operatingConfig.revenuePerPassengerMile.rail,
        operatingCostPerTrip: game.operatingConfig.operatingCostPerTrip.railElectric,
        loadingHours: game.operatingConfig.loadingHours.train,
        fuel: "No fuel",
        fuelPrice: "—",
        fuelUnit: "No fuel units",
      },
    ],
    [effectiveFuelPriceByResource, game.operatingConfig],
  )

  const playerSummaries = useMemo(() => {
    return game.players.map(player => {
      const ownedRoutes = game.routes.filter(route => route.ownerId === player.id)
      const connectedCities = getConnectedCityIds(game, player.id)
        .map(cityId => cityMap[cityId]?.name ?? cityId)
        .sort((cityA, cityB) => cityA.localeCompare(cityB))

      const connectedRoutes = ownedRoutes.map(route => {
        const cityA = cityMap[route.cityA]?.name ?? route.cityA
        const cityB = cityMap[route.cityB]?.name ?? route.cityB

        return `${cityA} - ${cityB} (${route.mode === "rail" ? `${getRailTraction(route) === "electric" ? "Electric rail" : "Rail"}` : MODE_LABELS[route.mode]})`
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
  }, [cityMap, game, vehicleCardMap])

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
            cheapestIndex === -1 ? null : getFuelUnitPrice(game, resource, cheapestIndex),
          purchaseCosts: {
            1: getFuelPurchaseCost(game, resource, 1),
            10: resource === "diesel" ? getFuelPurchaseCost(game, resource, 10) : null,
          },
        }
      })
    }, [game, game.resourceMarket])
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
    setIsEconomicsOpen(false)
    setIsWikiOpen(false)
    setWikiPreviousPanel(null)
  }, [game.currentPhase])

  function restorePhasePanel() {
    setIsResourceMarketOpen(game.currentPhase === "purchase-fuel")
    setIsVehicleMarketOpen(game.currentPhase === "purchase-equipment")
    setIsBureaucracyOpen(game.currentPhase === "bureaucracy")
    setIsEconomicsOpen(false)
  }

  function getCurrentRestorablePanel(): RestorablePanel {
    if (isEconomicsOpen) {
      return "economics"
    }

    if (isResourceMarketOpen) {
      return "resource"
    }

    if (isVehicleMarketOpen) {
      return "vehicle"
    }

    if (isBureaucracyOpen) {
      return "bureaucracy"
    }

    return null
  }

  function restoreWikiPreviousPanel() {
    switch (wikiPreviousPanel) {
      case "economics":
        setIsEconomicsOpen(true)
        setIsResourceMarketOpen(false)
        setIsVehicleMarketOpen(false)
        setIsBureaucracyOpen(false)
        break
      case "resource":
        setIsResourceMarketOpen(true)
        setIsVehicleMarketOpen(false)
        setIsBureaucracyOpen(false)
        setIsEconomicsOpen(false)
        break
      case "vehicle":
        setIsVehicleMarketOpen(true)
        setIsResourceMarketOpen(false)
        setIsBureaucracyOpen(false)
        setIsEconomicsOpen(false)
        break
      case "bureaucracy":
        setIsBureaucracyOpen(true)
        setIsResourceMarketOpen(false)
        setIsVehicleMarketOpen(false)
        setIsEconomicsOpen(false)
        break
      default:
        restorePhasePanel()
        break
    }

    setWikiPreviousPanel(null)
  }

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
    const rewardText =
      result.connectionBonus > 0
        ? ` and earned ${formatCurrency(result.connectionBonus)} for ${result.newCityIds.length} new cit${result.newCityIds.length === 1 ? "y" : "ies"}`
        : ""

    resetSelection(
      `${currentPlayer?.name ?? "Current player"} claimed ${result.routes.length} ${MODE_LABELS[mode].toLowerCase()} segment${result.routes.length === 1 ? "" : "s"} across ${routeLabel}${result.cost > 0 ? ` for ${formatCurrency(result.cost)}` : ""}${rewardText}.`,
    )
  }

  function handleAdvanceTurnClick() {
    const nextStatusMessage = shouldAdvancePhase
      ? `Starting ${formatPhaseLabel(getNextPhase(game.currentPhase)).toLowerCase()}.`
      : `${nextPlayer?.name ?? "Next player"} is up.`

    onAdvanceTurn()
    resetSelection(nextStatusMessage)
  }

  function handleBuyResourceClick(resource: PurchasableResource, quantity: number) {
    const result = onBuyResource(resource, quantity)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(
      `${currentPlayer?.name ?? "Current player"} bought ${result.quantity} ${getResourceLabel(resource).toLowerCase()} unit${result.quantity === 1 ? "" : "s"} for ${formatCurrency(result.cost)}.`,
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
      `Set fuel used to ${result.fuelUnits} unit${result.fuelUnits === 1 ? "" : "s"} for that route.`,
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

  function handleUpgradeRailRoute(routeId: string) {
    const result = onUpgradeRailRoute(routeId)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(`Electrified that rail route for ${formatCurrency(result.cost)}.`)
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
                <strong>$</strong> {formatCurrency(player.money).replace("$", "")}
              </span>
            </div>
            <div
              style={{
                color: weeklyNet > 0 ? "#2a7f3b" : weeklyNet < 0 ? "#b42318" : "#666666",
                fontWeight: 600,
              }}
            >
              {weeklyNet >= 0 ? "+" : "-"}
              {formatCurrency(Math.abs(weeklyNet))}
            </div>
            <div style={{ display: "flex", gap: 12, color: "#324236" }}>
              <span>👥 {formatDecimal(player.totalPassengersServed, 0)}</span>
              <span>🏙 {connectedCities.length}</span>
              <span>🛤 {connectedRoutes.length}</span>
            </div>
          </button>
        ))}
      </div>
      <div style={HUD_STYLE}>
        <div
          style={{
            border: "1px solid #d8dfd5",
            borderRadius: 10,
            padding: 10,
            background: "#f7faf6",
          }}
        >
          <div>
            <strong>Goal:</strong> Move the most passengers in {game.operatingConfig.totalWeeks} weeks.
          </div>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            Ties break on connected cities, then cash.
          </div>
          {leadingStanding && (
            <div style={{ marginTop: 4 }}>
              <strong>Leader:</strong>{" "}
              <span style={{ color: leadingStanding.player.color }}>
                {leadingStanding.player.name}
              </span>{" "}
              • {formatDecimal(leadingStanding.player.totalPassengersServed, 0)} passengers
            </div>
          )}
        </div>
        {activeChanceCard && (
          <div
            style={{
              border: "1px solid #d7d1eb",
              borderRadius: 10,
              padding: 10,
              background: "#f6f2ff",
            }}
          >
            <div>
              <strong>Weekly chance:</strong> {activeChanceCard.title}
            </div>
            <div style={{ color: "#5f5482", fontSize: 13 }}>
              {activeChanceCard.description}
            </div>
          </div>
        )}
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
                {summary.connectionBonus > 0 && (
                  <>
                    {" • "}Bonus {formatCurrency(summary.connectionBonus)}
                    {" • "}New cities {summary.newCityCount}
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
      {game.isGameOver && leadingStanding && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 104,
            transform: "translateX(-50%)",
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid #d8dfd5",
            background: "rgba(255, 255, 255, 0.96)",
            boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
            zIndex: 1,
            fontFamily: "system-ui, sans-serif",
            minWidth: 320,
          }}
        >
          <div>
            <strong>Game over</strong>
          </div>
          <div>
            Winner:{" "}
            <span style={{ color: leadingStanding.player.color, fontWeight: 700 }}>
              {leadingStanding.player.name}
            </span>
          </div>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            {formatDecimal(leadingStanding.player.totalPassengersServed, 0)} passengers •{" "}
            {leadingStanding.connectedCities} connected cities
          </div>
        </div>
      )}
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
              <strong>Total passengers:</strong>{" "}
              {formatDecimal(expandedPlayerSummary.player.totalPassengersServed, 0)}
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
            {expandedPlayerSummary.player.id === game.currentPlayerId &&
            game.currentPhase === "claim-routes" ? (
              <div
                style={{
                  borderTop: "1px solid #e1e6df",
                  paddingTop: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <strong>Rail upgrades</strong>
                {game.routes
                  .filter(
                    route =>
                      route.ownerId === expandedPlayerSummary.player.id &&
                      route.mode === "rail" &&
                      getRailTraction(route) !== "electric",
                  )
                  .map(route => {
                    const cityA = cityMap[route.cityA]?.name ?? route.cityA
                    const cityB = cityMap[route.cityB]?.name ?? route.cityB

                    return (
                      <div
                        key={`${route.id}-upgrade`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          border: "1px solid #e1e6df",
                          borderRadius: 8,
                          padding: "8px 10px",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div>
                            {cityA} - {cityB}
                          </div>
                          <div style={{ color: "#56635a", fontSize: 12 }}>
                            Upgrade {formatCurrency(getRailUpgradeCost(game, route))}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleUpgradeRailRoute(route.id)}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 999,
                            border: "1px solid #c7d0c4",
                            background: "#ffffff",
                            cursor: "pointer",
                            fontWeight: 600,
                          }}
                        >
                          Electrify
                        </button>
                      </div>
                    )
                  })}
                {game.routes.every(
                  route =>
                    route.ownerId !== expandedPlayerSummary.player.id ||
                    route.mode !== "rail" ||
                    getRailTraction(route) === "electric",
                ) && (
                  <div style={{ color: "#56635a", fontSize: 13 }}>
                    No diesel rail routes are ready for upgrade.
                  </div>
                )}
              </div>
            ) : null}
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
                <div>Operating cost: {formatCurrency(summary.totalOperatingCost)}</div>
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
                        {plan.route.mode === "rail" && getRailTraction(plan.route) === "electric"
                          ? "Electric rail "
                          : `${MODE_LABELS[plan.route.mode]} `}
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
                              Fuel used
                              <select
                                value={plan.selectedFuelUnits}
                                onChange={event => {
                                  const nextFuelUnits = Number(event.target.value)
                                  handleSetBureaucracyFuelUnits(
                                    plan.route.id,
                                    nextFuelUnits,
                                  )
                                }}
                                style={{
                                  minWidth: 88,
                                  padding: "6px 8px",
                                  borderRadius: 8,
                                  border: "1px solid #c7d0c4",
                                  background: "#ffffff",
                                }}
                              >
                                {Array.from(
                                  { length: getMaxFuelUnitsForRoute(game, plan.route.id) + 1 },
                                  (_, fuelUnits) => (
                                    <option key={`${plan.route.id}-fuel-${fuelUnits}`} value={fuelUnits}>
                                      {fuelUnits}
                                    </option>
                                  ),
                                )}
                              </select>
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
                            {" • "}Base cost: {formatCurrency(plan.operatingCost)}
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
      {isEconomicsOpen && (
        <div style={RESOURCE_MARKET_PANEL_STYLE}>
          <strong>Economics</strong>
          <div style={{ color: "#56635a" }}>
            Route pricing, operating costs, fuel pricing, and infrastructure costs for the current week.
          </div>
          {activeChanceCard && (
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 10,
                background: "#f7faf6",
              }}
            >
              <div>
                <strong>Active modifier:</strong> {activeChanceCard.title}
              </div>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                {activeChanceCard.description}
              </div>
              {activeChanceCard.connectionBonus && (
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Connection grant: {formatCurrency(activeChanceCard.connectionBonus.bonusPerCity)} for
                  each new size {activeChanceCard.connectionBonus.citySize} city
                </div>
              )}
            </div>
          )}
          <div style={{ color: "#56635a", fontSize: 13 }}>
            New city bonus: {formatCurrency(game.operatingConfig.connectionBonusPerCitySize)} per city
            size level added to your network.
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
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  minWidth: 760,
                }}
              >
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Mode</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Ticket / mile</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Base cost / trip</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Loading</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel price</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel unit</th>
                  </tr>
                </thead>
                <tbody>
                  {economicsRows.map(row => (
                    <tr key={row.label}>
                      <td style={{ padding: "8px" }}>
                        <strong>{row.label}</strong>
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatUnitRate(row.ticketPricePerMile, 3)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatCurrency(row.operatingCostPerTrip)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatDecimal(row.loadingHours)}h
                      </td>
                      <td style={{ padding: "8px" }}>{row.fuel}</td>
                      <td style={{ padding: "8px" }}>{row.fuelPrice}</td>
                      <td style={{ padding: "8px" }}>{row.fuelUnit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 10,
              }}
            >
              <div
                style={{
                  border: "1px solid #e1e6df",
                  borderRadius: 8,
                  padding: 10,
                  background: "#ffffff",
                }}
              >
                <strong>Infrastructure</strong>
                <div style={{ marginTop: 6, color: "#324236", fontSize: 13 }}>
                  Rail build: {formatCurrency(game.operatingConfig.railConstructionCostPerMile)}/mi
                </div>
                <div style={{ color: "#324236", fontSize: 13 }}>
                  Electrify: {formatCurrency(game.operatingConfig.railElectrificationCostPerMile)}/mi
                </div>
              </div>
              <div
                style={{
                  border: "1px solid #e1e6df",
                  borderRadius: 8,
                  padding: 10,
                  background: "#ffffff",
                }}
              >
                <strong>Demand + score</strong>
                <div style={{ marginTop: 6, color: "#324236", fontSize: 13 }}>
                  {game.operatingConfig.passengersPerDemandPoint} passengers per demand point
                </div>
                <div style={{ color: "#324236", fontSize: 13 }}>
                  Win by total passengers served
                </div>
              </div>
              <div
                style={{
                  border: "1px solid #e1e6df",
                  borderRadius: 8,
                  padding: 10,
                  background: "#ffffff",
                }}
              >
                <strong>Fuel market</strong>
                <div style={{ marginTop: 6, color: "#324236", fontSize: 13 }}>
                  Diesel: {formatUnitRate(effectiveFuelPriceByResource.diesel)} / gal
                </div>
                <div style={{ color: "#324236", fontSize: 13 }}>
                  Jet fuel: {formatUnitRate(effectiveFuelPriceByResource.jetFuel)} / lb
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {isWikiOpen && (
        <div
          style={{
            ...RESOURCE_MARKET_PANEL_STYLE,
            top: 88,
            bottom: 88,
            overflowY: "auto",
          }}
        >
          <strong>Game wiki</strong>
          <div style={{ color: "#56635a" }}>
            Rules, strategy reference, costs, vehicles, chance cards, and other key game information.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 10,
                background: "#ffffff",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <strong>How to win</strong>
              <div style={{ color: "#324236", fontSize: 13 }}>
                The game lasts <strong>{game.operatingConfig.totalWeeks} weeks</strong>. Winner is the
                player with the most passengers served.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Ties break by <strong>connected cities</strong>, then <strong>cash</strong>.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Each demand point supports <strong>{game.operatingConfig.passengersPerDemandPoint}</strong>{" "}
                passengers per trip.
              </div>
            </div>
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 10,
                background: "#ffffff",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <strong>How to play</strong>
              <div style={{ color: "#324236", fontSize: 13 }}>
                1. <strong>Purchase Equipment</strong>: buy 1 vehicle card on your turn from the first 4 cards.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                2. <strong>Claim Routes</strong>: select cities and claim a bus, air, or rail connection.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Your first successful route establishes your network. Every later claim must touch that
                network somewhere.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                3. <strong>Purchase Fuel</strong>: buy fuel units for the fleet you own, up to your current cap.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                4. <strong>Bureaucracy</strong>: assign vehicle cards to routes, allocate fuel, and collect revenue.
              </div>
            </div>
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 10,
                background: "#ffffff",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <strong>Route rules</strong>
              <div style={{ color: "#324236", fontSize: 13 }}>
                <strong>Bus</strong>: can connect any city pair and uses diesel.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                <strong>Air</strong>: can connect any city pair, but only between 2 cities at a time.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                <strong>Rail</strong>: can chain across multiple cities, starts as diesel, and can be electrified later.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Connecting a brand-new city pays a bonus based on that city&apos;s size.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                One vehicle card can operate one matching route at a time during bureaucracy.
              </div>
            </div>
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 10,
                background: "#ffffff",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <strong>Current costs</strong>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Rail build: <strong>{formatCurrency(game.operatingConfig.railConstructionCostPerMile)}/mi</strong>
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                New city bonus:{" "}
                <strong>{formatCurrency(game.operatingConfig.connectionBonusPerCitySize)} x city size</strong>
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Electrify rail: <strong>{formatCurrency(game.operatingConfig.railElectrificationCostPerMile)}/mi</strong>
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Diesel: <strong>{formatUnitRate(effectiveFuelPriceByResource.diesel)}</strong> / gal
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Jet fuel: <strong>{formatUnitRate(effectiveFuelPriceByResource.jetFuel)}</strong> / lb
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Diesel unit: <strong>{formatDecimal(game.operatingConfig.fuelUnits.diesel, 0)} gal</strong>
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Jet fuel unit: <strong>{formatDecimal(game.operatingConfig.fuelUnits.jetFuel, 0)} lb</strong>
              </div>
            </div>
          </div>
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 10,
              padding: 10,
              background: "#ffffff",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <strong>Mode economics</strong>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  minWidth: 760,
                }}
              >
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Mode</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Ticket / mile</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Base cost / trip</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Loading</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel price</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel unit</th>
                  </tr>
                </thead>
                <tbody>
                  {economicsRows.map(row => (
                    <tr key={`wiki-${row.label}`}>
                      <td style={{ padding: "8px" }}>
                        <strong>{row.label}</strong>
                      </td>
                      <td style={{ padding: "8px" }}>{formatUnitRate(row.ticketPricePerMile, 3)}</td>
                      <td style={{ padding: "8px" }}>{formatCurrency(row.operatingCostPerTrip)}</td>
                      <td style={{ padding: "8px" }}>{formatDecimal(row.loadingHours)}h</td>
                      <td style={{ padding: "8px" }}>{row.fuel}</td>
                      <td style={{ padding: "8px" }}>{row.fuelPrice}</td>
                      <td style={{ padding: "8px" }}>{row.fuelUnit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 10,
              padding: 10,
              background: "#ffffff",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <strong>Vehicle cards</strong>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 10,
              }}
            >
              {[...game.vehicleCatalog]
                .sort((cardA, cardB) => cardA.number - cardB.number)
                .map(card => (
                  <div
                    key={`wiki-card-${card.id}`}
                    style={{
                      border: "1px solid #e1e6df",
                      borderRadius: 8,
                      padding: 10,
                      background: "#fafcfa",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong>
                        #{card.number} {getVehicleTypeIcon(card.type)} {getVehicleTypeLabel(card.type)}
                      </strong>
                      <span>{formatCurrency(card.purchasePrice)}</span>
                    </div>
                    <div style={{ color: "#223024", fontWeight: 600 }}>{card.name}</div>
                    <div style={{ color: "#324236", fontSize: 13 }}>
                      {getVehicleTypeIcon(card.type)} x{card.vehicleCount} • 👤{" "}
                      {card.capacityPerVehicle.toLocaleString()} • 👥{" "}
                      {card.totalPassengerCapacity.toLocaleString()} • {card.speed}mph • ⚙️
                      {card.operatingCostMultiplier}
                    </div>
                    <div style={{ color: "#56635a", fontSize: 12 }}>{card.funFact}</div>
                  </div>
                ))}
            </div>
          </div>
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 10,
              padding: 10,
              background: "#ffffff",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <strong>Chance cards</strong>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 10,
              }}
            >
              {game.chanceCatalog.map(card => (
                <div
                  key={`wiki-chance-${card.id}`}
                  style={{
                    border: "1px solid #e1e6df",
                    borderRadius: 8,
                    padding: 10,
                    background: activeChanceCard?.id === card.id ? "#f7f2ff" : "#fafcfa",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <strong>{card.title}</strong>
                  <div style={{ color: "#324236", fontSize: 13 }}>{card.description}</div>
                  {card.fuelPriceMultiplier && (
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      Fuel multiplier:{" "}
                      {Object.entries(card.fuelPriceMultiplier)
                        .map(([resource, multiplier]) => `${resource} x${multiplier}`)
                        .join(", ")}
                    </div>
                  )}
                  {card.demandBoost && (
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      Demand boost: +{card.demandBoost.bonusPerCity} per city in{" "}
                      {card.demandBoost.regions.join(", ")}
                    </div>
                  )}
                  {card.connectionBonus && (
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      Connection grant: {formatCurrency(card.connectionBonus.bonusPerCity)} for each new
                      size {card.connectionBonus.citySize} city
                    </div>
                  )}
                  {activeChanceCard?.id === card.id && (
                    <div style={{ color: "#5f5482", fontSize: 12, fontWeight: 600 }}>
                      Active this week
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {isResourceMarketOpen && (
        <div style={RESOURCE_MARKET_PANEL_STYLE}>
          <strong>Resource market</strong>
          <div style={{ color: "#56635a" }}>
            Buy only fuel your fleet can use. Diesel can be bought 1 or 10 units at a time; jet fuel stays at 1.
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
                              getFuelUnitPrice(game, summary.resource, index) ?? 0,
                            )}
                          </div>
                        </td>
                      ))}
                      <td style={{ textAlign: "center", padding: "8px" }}>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          {(summary.resource === "diesel" ? [1, 10] : [1]).map(quantity => {
                            const canBuy =
                              game.currentPhase === "purchase-fuel" &&
                              canBuyFuelByResource[summary.resource] &&
                              (
                                currentPlayer === undefined ||
                                currentPlayer.inventory.fuel[summary.resource] + quantity <=
                                  maxFuelHoldingsByResource[summary.resource]
                              ) &&
                              (summary.purchaseCosts[quantity as 1 | 10] ?? null) !== null
                            const purchaseCost = summary.purchaseCosts[quantity as 1 | 10]

                            return (
                              <button
                                key={`${summary.resource}-buy-${quantity}`}
                                type="button"
                                disabled={!canBuy}
                                onClick={() => handleBuyResourceClick(summary.resource, quantity)}
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: 999,
                                  border: "1px solid #c7d0c4",
                                  cursor: canBuy ? "pointer" : "not-allowed",
                                  background: canBuy ? "#ffffff" : "#f2f2f2",
                                  minWidth: 96,
                                }}
                              >
                                Buy {quantity}
                                {purchaseCost !== null ? ` • ${formatCurrency(purchaseCost)}` : ""}
                              </button>
                            )
                          })}
                        </div>
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
            <strong>Week:</strong> {game.currentWeek}/{game.operatingConfig.totalWeeks}
          </div>
          <div>
            <strong>Phase:</strong> {formatPhaseLabel(game.currentPhase)}
          </div>
          {activeChanceCard && (
            <div>
              <strong>Chance:</strong> {activeChanceCard.title}
            </div>
          )}
          {leadingStanding && (
            <div>
              <strong>Leader:</strong> {leadingStanding.player.name}
            </div>
          )}
          <div>
            <strong>Weeks left:</strong> {weeksRemaining}
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
              setIsEconomicsOpen(open => !open)
              setIsResourceMarketOpen(false)
              setIsVehicleMarketOpen(false)
              setIsBureaucracyOpen(false)
              setIsWikiOpen(false)
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
            {isEconomicsOpen ? "Hide economics" : "Economics"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (isWikiOpen) {
                setIsWikiOpen(false)
                restoreWikiPreviousPanel()
                return
              }

              setWikiPreviousPanel(getCurrentRestorablePanel())
              setIsWikiOpen(true)
              setIsResourceMarketOpen(false)
              setIsVehicleMarketOpen(false)
              setIsBureaucracyOpen(false)
              setIsEconomicsOpen(false)
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
            {isWikiOpen ? "Hide wiki" : "Wiki"}
          </button>
          <button
            type="button"
            onClick={() => {
              onUndo()
              setStatusMessage("Undid the last action.")
            }}
            disabled={!canUndo}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: canUndo ? "pointer" : "not-allowed",
              background: canUndo ? "#ffffff" : "#f2f2f2",
              fontWeight: 600,
            }}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={handleAdvanceTurnClick}
            disabled={game.isGameOver}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: game.isGameOver ? "not-allowed" : "pointer",
              background: game.isGameOver ? "#f2f2f2" : "#ffffff",
              fontWeight: 600,
            }}
          >
            {game.isGameOver ? "Game over" : shouldAdvancePhase ? "Next phase" : "Next player"}
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
              const isElectricRail =
                route.mode === "rail" && getRailTraction(route) === "electric"

              return (
                <g key={route.id}>
                  {isElectricRail && (
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="#8ed8ff"
                      strokeWidth={8}
                      strokeLinecap="round"
                      opacity={0.7}
                    />
                  )}
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={owner?.color ?? "#222222"}
                    strokeWidth={4}
                    strokeLinecap="round"
                    strokeDasharray={
                      isElectricRail ? "18 6" : lineStyle.strokeDasharray
                    }
                    opacity={lineStyle.opacity}
                  />
                </g>
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
