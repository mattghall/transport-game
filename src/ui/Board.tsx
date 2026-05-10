import { useEffect, useMemo, useState } from "react"
import {
  type RailUpgradeResult,
  calculateClaimRouteCost,
  type BureaucracyServiceCitiesResult,
  type BureaucracyServiceSplitResult,
  type BureaucracyVehicleCardResult,
  getFuelPurchaseCost,
  getFuelUnitPrice,
  getConnectionOptions,
  getCurrentPlayer,
  isLastPlayerTurn,
  type ClaimRouteResult,
  type ResourcePurchaseResult,
} from "../engine/actions"
import {
  buildBureaucracySummaries,
  getMaxFuelUnitsCapacityForPlayer,
} from "../engine/bureaucracy"
import {
  buildVictoryStandings,
  calculateConnectionBonus,
  getActiveChanceCard,
  getBalanceAdjustmentPerTrip,
  getCombinedDemandForCityIds,
  getCrewCostPerWeekPerVehicle,
  getConnectedCityIds,
  getFuelPriceMultiplier,
  getHoursPerWeek,
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
  onBuyVehicleCard: (
    cardId: string,
  ) =>
    | {
        ok: true
        card: VehicleCard
        cost: number
        nextPhase: WeeklyPhase
        nextPlayerName: string
        advancedPhase: boolean
      }
    | {
        ok: false
        error: string
      }
  onUpgradeRailRoute: (routeId: string) => RailUpgradeResult
  onSetBureaucracyRouteVehicleCard: (
    routeId: string,
    vehicleCardId: string | null,
  ) => BureaucracyVehicleCardResult
  onSetBureaucracyServiceCities: (
    routeId: string,
    cityIds: string[],
  ) => BureaucracyServiceCitiesResult
  onAddBureaucracyServiceSplit: (corridorId: string) => BureaucracyServiceSplitResult
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

const ACTION_LOG_PANEL_STYLE = {
  position: "absolute",
  right: 16,
  bottom: 88,
  width: 320,
  maxHeight: 260,
  overflowY: "auto",
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
  top: 88,
  bottom: 88,
  overflowY: "auto",
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

const BUREAUCRACY_MODE_ORDER: RouteMode[] = ["bus", "rail", "air"]

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
      return "bureaucracy"
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
      return "Fuel purchasing is disabled."
    case "bureaucracy":
      return "Plan routes and operate the maximum affordable trips, then advance."
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
  onSetBureaucracyServiceCities,
  onAddBureaucracyServiceSplit,
  onAdvanceTurn,
  onUndo,
  canUndo,
}: Props) {
  type RestorablePanel = "resource" | "vehicle" | "bureaucracy" | "economics" | null

  const [selectedCityIds, setSelectedCityIds] = useState<string[]>([])
  const [selectedClaimMode, setSelectedClaimMode] = useState<RouteMode | null>(null)
  const [hoverCityId, setHoverCityId] = useState<string | null>(null)
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const [isResourceMarketOpen, setIsResourceMarketOpen] = useState(false)
  const [isVehicleMarketOpen, setIsVehicleMarketOpen] = useState(false)
  const [isBureaucracyOpen, setIsBureaucracyOpen] = useState(false)
  const [isEconomicsOpen, setIsEconomicsOpen] = useState(false)
  const [isWikiOpen, setIsWikiOpen] = useState(false)
  const [isActionLogOpen, setIsActionLogOpen] = useState(false)
  const [wikiPreviousPanel, setWikiPreviousPanel] = useState<RestorablePanel>(null)
  const [zoomScale, setZoomScale] = useState(1)
  const [isPeriodSummaryOpen, setIsPeriodSummaryOpen] = useState(false)
  const [lastShownPeriodSummaryKey, setLastShownPeriodSummaryKey] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string>(
    getPhaseStatusMessage(game.currentPhase),
  )
  const [pendingVehiclePurchaseCardId, setPendingVehiclePurchaseCardId] = useState<string | null>(null)

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
      const totalTripDurationHours = routeSummaries.reduce(
        (total, summary) => total + summary.tripDurationHours,
        0,
      )
      const maxTripsPerPeriod =
        previewCard === null || routeSummaries.length !== routePairs.length || totalTripDurationHours <= 0
          ? 0
          : Math.floor(getHoursPerWeek(game) / totalTripDurationHours)
      const passengersPerTrip =
        previewCard === null
          ? 0
          : Math.min(
              previewCard.totalPassengerCapacity,
              combinedDemand * game.operatingConfig.passengersPerDemandPoint,
            )
      const passengersPerPeriod = passengersPerTrip * maxTripsPerPeriod
      const revenuePerPeriod =
        totalDistanceMiles *
        passengersPerPeriod *
        game.operatingConfig.revenuePerPassengerMile[option.mode]
      const tripFuelBurnReal =
        routeSummaries.length === 0
          ? 0
          : routeSummaries.reduce((total, summary) => total + summary.tripFuelBurn, 0)
      const fuelResource = routeSummaries[0]?.fuelResource ?? null
      const fuelCostPerPeriod =
        fuelResource === null
          ? 0
          : tripFuelBurnReal *
            maxTripsPerPeriod *
            game.operatingConfig.fuelPricePerRealUnit[fuelResource] *
            getFuelPriceMultiplier(game, fuelResource)
      const fixedCrewCost =
        previewCard === null ? 0 : getCrewCostPerWeekPerVehicle(game, previewCard.type) * previewCard.vehicleCount
      const fixedMaintenanceCost =
        previewCard === null
          ? 0
          : game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle[previewCard.type] *
            game.operatingConfig.weeksPerPeriod *
            previewCard.vehicleCount
      const balanceAdjustmentPerPeriod =
        previewCard === null
          ? 0
          : maxTripsPerPeriod *
            getBalanceAdjustmentPerTrip(game, {
              id: `preview:${option.mode}`,
              cityA: selectedCities[0].id,
              cityB: selectedCities[selectedCities.length - 1].id,
              mode: option.mode,
            })
      const operatingCostPerPeriod =
        fixedCrewCost + fixedMaintenanceCost + balanceAdjustmentPerPeriod + fuelCostPerPeriod

      return {
        mode: option.mode,
        valid: option.valid,
        reason: option.reason,
        previewCard,
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
        passengersPerTrip,
        maxTripsPerPeriod,
        passengersPerPeriod,
        revenuePerPeriod,
        crewCostPerPeriod: fixedCrewCost,
        maintenanceCostPerPeriod: fixedMaintenanceCost,
        fuelCostPerPeriod,
        balanceCostPerPeriod: balanceAdjustmentPerPeriod,
        operatingCostPerPeriod,
        netPerPeriod: revenuePerPeriod - operatingCostPerPeriod,
      }
    })
  }, [connectionBonusPreview, connectionOptions, currentPlayerOwnedVehicleCards, game, selectedCities])
  const selectedClaimPreview = routePreviewSummaries.find(
    summary => summary.mode === selectedClaimMode,
  ) ?? null
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
  const periodsRemaining = Math.max(0, game.operatingConfig.totalWeeks - game.currentWeek)
  const completedPeriod = game.isGameOver ? game.currentWeek : game.currentWeek - 1
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
        crewHourlyCostPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.bus,
        crewCostPerWeekPerVehicle: getCrewCostPerWeekPerVehicle(game, "bus"),
        maintenanceCostPerWeekPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle.bus *
          game.operatingConfig.weeksPerPeriod,
        balanceAdjustmentPerTrip: getBalanceAdjustmentPerTrip(game, {
          id: "economics-bus",
          cityA: "",
          cityB: "",
          mode: "bus",
        }),
        loadingHours: game.operatingConfig.loadingHours.bus,
        fuel: "Diesel",
        fuelPrice: formatUnitRate(effectiveFuelPriceByResource.diesel),
      },
      {
        label: "Air",
        ticketPricePerMile: game.operatingConfig.revenuePerPassengerMile.air,
        crewHourlyCostPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.air,
        crewCostPerWeekPerVehicle: getCrewCostPerWeekPerVehicle(game, "air"),
        maintenanceCostPerWeekPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle.air *
          game.operatingConfig.weeksPerPeriod,
        balanceAdjustmentPerTrip: getBalanceAdjustmentPerTrip(game, {
          id: "economics-air",
          cityA: "",
          cityB: "",
          mode: "air",
        }),
        loadingHours: game.operatingConfig.loadingHours.air,
        fuel: "Jet fuel",
        fuelPrice: formatUnitRate(effectiveFuelPriceByResource.jetFuel),
      },
      {
        label: "Rail (diesel)",
        ticketPricePerMile: game.operatingConfig.revenuePerPassengerMile.rail,
        crewHourlyCostPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.train,
        crewCostPerWeekPerVehicle: getCrewCostPerWeekPerVehicle(game, "train"),
        maintenanceCostPerWeekPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle.train *
          game.operatingConfig.weeksPerPeriod,
        balanceAdjustmentPerTrip: getBalanceAdjustmentPerTrip(game, {
          id: "economics-rail-diesel",
          cityA: "",
          cityB: "",
          mode: "rail",
          railTraction: "diesel",
        }),
        loadingHours: game.operatingConfig.loadingHours.train,
        fuel: "Diesel",
        fuelPrice: formatUnitRate(effectiveFuelPriceByResource.diesel),
      },
      {
        label: "Rail (electric)",
        ticketPricePerMile: game.operatingConfig.revenuePerPassengerMile.rail,
        crewHourlyCostPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.train,
        crewCostPerWeekPerVehicle: getCrewCostPerWeekPerVehicle(game, "train"),
        maintenanceCostPerWeekPerVehicle:
          game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle.train *
          game.operatingConfig.weeksPerPeriod,
        balanceAdjustmentPerTrip: getBalanceAdjustmentPerTrip(game, {
          id: "economics-rail-electric",
          cityA: "",
          cityB: "",
          mode: "rail",
          railTraction: "electric",
        }),
        loadingHours: game.operatingConfig.loadingHours.train,
        fuel: "No fuel",
        fuelPrice: "—",
      },
    ],
    [effectiveFuelPriceByResource, game],
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
  const currentPlayerBureaucracyPlansByMode = useMemo(() => {
    if (!currentPlayerBureaucracySummary) {
      return []
    }

    return BUREAUCRACY_MODE_ORDER.map(mode => ({
      mode,
      plans: currentPlayerBureaucracySummary.routePlans.filter(plan => plan.route.mode === mode),
    }))
  }, [currentPlayerBureaucracySummary])
  const nextPlayer = currentPlayerIndex === -1
    ? game.players[0]
    : game.players[(currentPlayerIndex + 1) % game.players.length]
  const pendingVehiclePurchaseCard =
    (pendingVehiclePurchaseCardId && vehicleCardMap[pendingVehiclePurchaseCardId]) ?? null
  const shouldAdvancePhase = isLastPlayerTurn(game)
  const isAdvanceBlocked =
    game.currentPhase === "claim-routes" && selectedCityIds.length >= 2

  function getFuelInfoLabel(resource: PurchasableResource, units: number) {
    const realFuel = calculateRealFuelFromUnits(units, resource, game)

    return `${formatDecimal(units)} ${getResourceLabel(resource).toLowerCase()} unit${units === 1 ? "" : "s"} = ${formatDecimal(realFuel)} ${getRealFuelLabel(resource)}`
  }

  function resetSelection(message = getPhaseStatusMessage(game.currentPhase)) {
    setSelectedCityIds([])
    setSelectedClaimMode(null)
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
    setSelectedClaimMode(null)
    setHoverCityId(null)
    setPendingVehiclePurchaseCardId(null)
    setStatusMessage(getPhaseStatusMessage(game.currentPhase))
  }, [game.currentPhase])

  useEffect(() => {
    if (selectedClaimMode && !connectionOptions.some(option => option.mode === selectedClaimMode && option.valid)) {
      setSelectedClaimMode(null)
    }
  }, [connectionOptions, selectedClaimMode])

  useEffect(() => {
    const completedPeriod = game.isGameOver ? game.currentWeek : game.currentWeek - 1

    if (game.currentPhase !== "purchase-equipment" || completedPeriod < 1) {
      return
    }

    const summaryKey = `${completedPeriod}:${game.isGameOver ? "game-over" : "continue"}`

    if (summaryKey === lastShownPeriodSummaryKey) {
      return
    }

    setIsPeriodSummaryOpen(true)
    setLastShownPeriodSummaryKey(summaryKey)
  }, [game.currentPhase, game.currentWeek, game.isGameOver, lastShownPeriodSummaryKey])

  useEffect(() => {
    setIsResourceMarketOpen(false)
    setIsVehicleMarketOpen(game.currentPhase === "purchase-equipment")
    setIsBureaucracyOpen(game.currentPhase === "bureaucracy")
    setIsEconomicsOpen(false)
    setIsWikiOpen(false)
    setWikiPreviousPanel(null)
  }, [game.currentPhase])

  function restorePhasePanel() {
    setIsResourceMarketOpen(false)
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

  function handleSelectClaimMode(mode: RouteMode) {
    const option = connectionOptions.find(candidate => candidate.mode === mode)

    if (!option?.valid) {
      setStatusMessage(option?.reason ?? "That connection type is not available.")
      return
    }

    setSelectedClaimMode(mode)
    setStatusMessage(`Ready to confirm this ${MODE_LABELS[mode].toLowerCase()} route.`)
  }

  function handleClaim() {
    if (game.currentPhase !== "claim-routes") {
      setStatusMessage(getRouteInteractionMessage(game.currentPhase))
      return
    }

    if (selectedCityIds.length < 2 || selectedClaimMode === null) {
      return
    }

    const result = onClaimRoute(selectedCityIds, selectedClaimMode)

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
      `${currentPlayer?.name ?? "Current player"} claimed ${result.routes.length} ${MODE_LABELS[selectedClaimMode].toLowerCase()} segment${result.routes.length === 1 ? "" : "s"} across ${routeLabel}${result.cost > 0 ? ` for ${formatCurrency(result.cost)}` : ""}${rewardText}.`,
    )
  }

  function handleAdvanceTurnClick() {
    if (game.currentPhase === "claim-routes" && selectedCityIds.length >= 2) {
      setStatusMessage("Confirm or cancel the selected route before ending the turn.")
      return
    }

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
    setPendingVehiclePurchaseCardId(cardId)
  }

  function handleConfirmBuyVehicleCard() {
    if (!pendingVehiclePurchaseCard) {
      return
    }

    const result = onBuyVehicleCard(pendingVehiclePurchaseCard.id)

    if (!result.ok) {
      setStatusMessage(result.error)
      setPendingVehiclePurchaseCardId(null)
      return
    }

    setStatusMessage(
      result.advancedPhase
        ? `${currentPlayer?.name ?? "Current player"} bought vehicle card ${result.card.number} for ${formatCurrency(result.cost)}. Starting ${formatPhaseLabel(result.nextPhase).toLowerCase()}.`
        : `${currentPlayer?.name ?? "Current player"} bought vehicle card ${result.card.number} for ${formatCurrency(result.cost)}. ${result.nextPlayerName} is up.`,
    )
    setPendingVehiclePurchaseCardId(null)
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

  function handleToggleServiceCity(routeId: string, cityId: string, selectedCityIds: string[]) {
    const nextCityIds = selectedCityIds.includes(cityId)
      ? selectedCityIds.filter(candidate => candidate !== cityId)
      : [...selectedCityIds, cityId]
    const result = onSetBureaucracyServiceCities(routeId, nextCityIds)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(
      result.cityIds.length >= 2
        ? `Updated service span to ${result.cityIds
            .map(nextCityId => cityMap[nextCityId]?.name ?? nextCityId)
            .join(" - ")}.`
        : "Select at least two cities to run that service.",
    )
  }

  function handleAddSplitService(corridorId: string) {
    const result = onAddBureaucracyServiceSplit(corridorId)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage("Added another service slot on that corridor.")
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
            <strong>Goal:</strong> Move the most passengers in {game.operatingConfig.totalWeeks} months.
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
              <strong>Monthly chance:</strong> {activeChanceCard.title}
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {connectionOptions.map(option => {
              const isSelected = selectedClaimMode === option.mode

              return (
                <button
                  key={option.mode}
                  type="button"
                  disabled={!option.valid}
                  onClick={() => handleSelectClaimMode(option.mode)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: `1px solid ${isSelected ? "#223024" : "#c7d0c4"}`,
                    cursor: option.valid ? "pointer" : "not-allowed",
                    background: isSelected ? "#223024" : option.valid ? "#ffffff" : "#f2f2f2",
                    color: isSelected ? "#ffffff" : option.valid ? "#222222" : "#767676",
                    fontWeight: isSelected ? 700 : 500,
                  }}
                >
                  {MODE_LABELS[option.mode]}
                </button>
              )
            })}
            <button
              type="button"
              onClick={handleClaim}
              disabled={selectedClaimMode === null}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: "1px solid #223024",
                cursor: selectedClaimMode === null ? "not-allowed" : "pointer",
                background: selectedClaimMode === null ? "#dfe5de" : "#223024",
                color: "#ffffff",
                fontWeight: 700,
              }}
            >
              Confirm route
            </button>
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
          <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
            {routePreviewSummaries.map(summary => (
              <div
                key={`${summary.mode}-preview`}
                style={{
                  border: selectedClaimMode === summary.mode ? "1px solid #223024" : "1px solid #d8dfd5",
                  borderRadius: 10,
                  padding: 10,
                  background: selectedClaimMode === summary.mode ? "#f4f7f3" : "#ffffff",
                  color: "#324236",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong>{MODE_LABELS[summary.mode]}</strong>
                  <span style={{ color: summary.valid ? "#2a7f3b" : "#9b1c1c" }}>
                    {summary.valid ? "Available" : "Unavailable"}
                  </span>
                </div>
                <div style={{ marginTop: 4 }}>
                  {formatDecimal(summary.totalDistanceMiles)} mi
                  {" • "}Demand {summary.combinedDemand}
                  {" • "}Capacity {summary.passengersPerTrip.toLocaleString()} / trip
                </div>
                {summary.previewCard && (
                  <div style={{ color: "#56635a", marginTop: 4 }}>
                    Vehicle preview: #{summary.previewCard.number} {summary.previewCard.name}
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  Trips/month {summary.maxTripsPerPeriod.toLocaleString()}
                  {" • "}Passengers/month {summary.passengersPerPeriod.toLocaleString()}
                </div>
                <div style={{ marginTop: 4 }}>
                  Revenue {formatCurrency(summary.revenuePerPeriod)}
                  {" • "}Operating cost {formatCurrency(summary.operatingCostPerPeriod)}
                  {" • "}Net {formatCurrency(summary.netPerPeriod)}
                </div>
                <div style={{ marginTop: 4, color: "#56635a", fontSize: 12 }}>
                  Crew {formatCurrency(summary.crewCostPerPeriod)}
                  {" • "}Maint {formatCurrency(summary.maintenanceCostPerPeriod)}
                  {" • "}Balance {formatCurrency(summary.balanceCostPerPeriod)}
                  {" • "}Fuel {formatCurrency(summary.fuelCostPerPeriod)}
                </div>
                <div style={{ marginTop: 4 }}>
                  Build {formatCurrency(summary.claimCost)}
                  {summary.connectionBonus > 0 && (
                    <>
                      {" • "}Bonus {formatCurrency(summary.connectionBonus)}
                      {" • "}New cities {summary.newCityCount}
                    </>
                  )}
                </div>
                {!summary.valid && summary.reason && (
                  <div style={{ marginTop: 4, color: "#9b1c1c" }}>{summary.reason}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {selectedClaimPreview && selectedClaimPreview.valid && (
          <div style={{ color: "#324236", fontSize: 13 }}>
            Ready to confirm: <strong>{MODE_LABELS[selectedClaimPreview.mode]}</strong> for{" "}
            {formatCurrency(selectedClaimPreview.claimCost)}
            {selectedClaimPreview.connectionBonus > 0 &&
              ` with ${formatCurrency(selectedClaimPreview.connectionBonus)} in connection bonuses`}
            .
          </div>
        )}
      </div>
      {isPeriodSummaryOpen && completedPeriod >= 1 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(10, 18, 12, 0.35)",
            zIndex: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div
            style={{
              width: "min(760px, calc(100vw - 32px))",
              maxHeight: "calc(100vh - 48px)",
              overflowY: "auto",
              background: "#ffffff",
              borderRadius: 16,
              boxShadow: "0 16px 40px rgba(0, 0, 0, 0.2)",
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div>
                <strong>End of month {completedPeriod} summary</strong>
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Revenue, costs, and passenger totals from the month that just finished.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsPeriodSummaryOpen(false)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Close
              </button>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {playerSummaries.map(({ player, connectedCities, weeklyNet }) => (
                <div
                  key={`${player.id}-period-summary`}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    padding: 12,
                    display: "grid",
                    gridTemplateColumns: "minmax(140px, 1fr) repeat(5, auto)",
                    gap: 10,
                    alignItems: "center",
                    background: "#ffffff",
                  }}
                >
                  <div>
                    <strong style={{ color: player.color }}>{player.name}</strong>
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      Connected cities: {connectedCities.length}
                    </div>
                  </div>
                  <div>Revenue {formatCurrency(player.weeklyPayout)}</div>
                  <div>Costs {formatCurrency(player.operatingCosts)}</div>
                  <div>Net {formatCurrency(weeklyNet)}</div>
                  <div>Passengers {formatDecimal(player.lastPeriodPassengersServed, 0)}</div>
                  <div>Cash {formatCurrency(player.money)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
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
              <strong>Monthly revenue:</strong>{" "}
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
            Assign vehicles to routes. Fuel is charged here as trips operate, and each route defaults to the maximum trips you can afford.
          </div>
          {currentPlayerBureaucracySummary ? (
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 12,
                background: `${currentPlayerBureaucracySummary.player.color}12`,
                boxShadow: `0 0 0 2px ${currentPlayerBureaucracySummary.player.color}22 inset`,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div>
                  <strong style={{ color: currentPlayerBureaucracySummary.player.color }}>
                    {currentPlayerBureaucracySummary.player.name}
                  </strong>
                </div>
                <div>Revenue: {formatCurrency(currentPlayerBureaucracySummary.totalRevenue)}</div>
                <div>
                  Operating cost: {formatCurrency(currentPlayerBureaucracySummary.totalOperatingCost)}
                </div>
                <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>
                  Crew: {formatCurrency(currentPlayerBureaucracySummary.totalCrewCost)}
                </div>
                <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>
                  Maintenance: {formatCurrency(currentPlayerBureaucracySummary.totalMaintenanceCost)}
                </div>
                <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>
                  Balance: {formatCurrency(currentPlayerBureaucracySummary.totalBalanceAdjustmentCost)}
                </div>
                <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>
                  Fuel: {formatCurrency(currentPlayerBureaucracySummary.totalFuelCost)}
                </div>
                <div>
                  <strong>Net:</strong> {formatCurrency(currentPlayerBureaucracySummary.netRevenue)}
                </div>
                <div>
                  Passengers served:{" "}
                  {currentPlayerBureaucracySummary.totalPassengersServed.toLocaleString()}
                </div>
                {currentPlayerBureaucracySummary.routePlans.length === 0 ? (
                  <div style={{ color: "#56635a" }}>No routes to operate.</div>
                ) : (
                  currentPlayerBureaucracyPlansByMode.map(({ mode, plans }) => (
                    <div
                      key={mode}
                      style={{
                        border: "1px solid #e1e6df",
                        borderRadius: 10,
                        padding: 10,
                        background: "#ffffff",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div>
                        <strong>{MODE_LABELS[mode]}</strong>
                      </div>
                      {plans.length === 0 ? (
                        <div style={{ color: "#56635a", fontSize: 13 }}>
                          No {MODE_LABELS[mode].toLowerCase()} services to operate.
                        </div>
                      ) : (
                        plans.map(plan => (
                          <div
                            key={plan.id}
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
                              <strong>{plan.serviceLabel}</strong>
                            </div>
                            <div style={{ color: "#56635a", fontSize: 13 }}>
                              {plan.route.mode === "rail" && getRailTraction(plan.route) === "electric"
                                ? "Electric rail "
                                : `${MODE_LABELS[plan.route.mode]} `}
                              {plan.segmentCount > 1 ? `• ${plan.segmentCount} segments ` : ""}
                              {plan.vehicleCard
                                ? `• #${plan.vehicleCard.number} ${plan.vehicleCard.name}`
                                : "• No vehicle assigned"}
                            </div>
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
                                    plan.id,
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
                                  .filter(card => card.type === getVehicleTypeForMode(plan.route.mode))
                                  .map(card => (
                                    <option key={card.id} value={card.id}>
                                      #{card.number} {card.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            {plan.availableCityIds.length > 2 && (
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 6,
                                  fontSize: 12,
                                  color: "#324236",
                                }}
                              >
                                <div>
                                  <strong>Cities in service</strong>
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px" }}>
                                  {plan.availableCityIds.map(cityId => (
                                    <label
                                      key={`${plan.id}-${cityId}`}
                                      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={plan.selectedCityIds.includes(cityId)}
                                        onChange={() =>
                                          handleToggleServiceCity(plan.id, cityId, plan.selectedCityIds)
                                        }
                                      />
                                      {cityMap[cityId]?.name ?? cityId}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
                            {plan.canAddSplitService && (
                              <div>
                                <button
                                  type="button"
                                  onClick={() => handleAddSplitService(plan.corridorId)}
                                  style={{
                                    padding: "6px 10px",
                                    borderRadius: 999,
                                    border: "1px solid #c7d0c4",
                                    background: "#ffffff",
                                    cursor: "pointer",
                                    fontSize: 12,
                                  }}
                                >
                                  Add split service
                                </button>
                              </div>
                            )}
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
                            </div>
                            {plan.vehicleCard ? (
                              <div style={{ color: "#56635a", fontSize: 12 }}>
                                Trips: {plan.selectedTrips}
                                {" • "}Passengers: {plan.passengersServed.toLocaleString()}
                                {" • "}Revenue: {formatCurrency(plan.revenue)}
                                {" • "}Crew: {formatCurrency(plan.crewCost)}
                                {" • "}Maint: {formatCurrency(plan.maintenanceCost)}
                                {" • "}Balance: {formatCurrency(plan.balanceAdjustmentCost)}
                                {" • "}Fuel cost: {formatCurrency(plan.fuelCost)}
                                {" • "}Base cost: {formatCurrency(plan.baseOperatingCost)}
                                {" • "}Total cost: {formatCurrency(plan.operatingCost)}
                              </div>
                            ) : (
                              <div style={{ color: "#9b1c1c", fontSize: 13 }}>
                                Assign a matching vehicle card to operate this route.
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: 12,
                background: "#ffffff",
                color: "#56635a",
              }}
            >
              No bureaucracy summary is available for the current player.
            </div>
          )}
        </div>
      )}
      {pendingVehiclePurchaseCard && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(10, 18, 12, 0.35)",
            zIndex: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div
            style={{
              width: "min(520px, calc(100vw - 32px))",
              background: "#ffffff",
              borderRadius: 16,
              boxShadow: "0 16px 40px rgba(0, 0, 0, 0.2)",
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div>
              <strong>Confirm vehicle purchase</strong>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                {currentPlayer?.name ?? "Current player"} is about to buy vehicle card #
                {pendingVehiclePurchaseCard.number}.
              </div>
            </div>
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                padding: 12,
                display: "grid",
                gap: 6,
                background: "#f7faf6",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>
                  #{pendingVehiclePurchaseCard.number} {pendingVehiclePurchaseCard.name}
                </strong>
                <span>{formatCurrency(pendingVehiclePurchaseCard.purchasePrice)}</span>
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                {getVehicleTypeIcon(pendingVehiclePurchaseCard.type)}{" "}
                {getVehicleTypeLabel(pendingVehiclePurchaseCard.type)} • x
                {pendingVehiclePurchaseCard.vehicleCount} • 👥{" "}
                {pendingVehiclePurchaseCard.totalPassengerCapacity.toLocaleString()} •{" "}
                {pendingVehiclePurchaseCard.speed}mph
              </div>
            </div>
            <div style={{ color: "#56635a", fontSize: 13 }}>
              After confirmation, the turn will automatically move to{" "}
              {shouldAdvancePhase
                ? formatPhaseLabel(getNextPhase(game.currentPhase)).toLowerCase()
                : nextPlayer?.name ?? "the next player"}
              .
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setPendingVehiclePurchaseCardId(null)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmBuyVehicleCard}
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "1px solid #223024",
                  background: "#223024",
                  color: "#ffffff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Confirm purchase
              </button>
            </div>
          </div>
        </div>
      )}
      {isVehicleMarketOpen && (
        <div style={RESOURCE_MARKET_PANEL_STYLE}>
          <strong>Vehicle market</strong>
          <div style={{ color: "#56635a" }}>
            The deck is shuffled when the game starts. Only the first 4 cards can be bought during purchase equipment. If nobody buys a card this month, the most expensive visible card is discarded before claim routes begins.
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
            Route pricing, operating costs, fuel pricing, and infrastructure costs for the current month.
          </div>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            Crew assumptions use {formatDecimal(game.operatingConfig.hoursPerDay)}h/day for{" "}
            {formatDecimal(game.operatingConfig.daysPerWeek, 0)} days/week across{" "}
            {formatDecimal(game.operatingConfig.weeksPerPeriod, 0)} weeks/month ={" "}
            {formatDecimal(getHoursPerWeek(game), 0)}h/month per active vehicle.
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
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Crew / hr</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Crew / month / vehicle</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Maint / month / vehicle</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Balance / trip</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Loading</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel price</th>
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
                        {formatUnitRate(row.crewHourlyCostPerVehicle, 0)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatCurrency(row.crewCostPerWeekPerVehicle)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatCurrency(row.maintenanceCostPerWeekPerVehicle)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatCurrency(row.balanceAdjustmentPerTrip)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatDecimal(row.loadingHours)}h
                      </td>
                      <td style={{ padding: "8px" }}>{row.fuel}</td>
                      <td style={{ padding: "8px" }}>{row.fuelPrice}</td>
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
                The game lasts <strong>{game.operatingConfig.totalWeeks} months</strong>. Winner is the
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
                If nobody buys a card during the month, the most expensive visible card is discarded before the next phase.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                2. <strong>Claim Routes</strong>: select cities and claim a bus, air, or rail connection.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Your first successful route establishes your network. Every later claim must touch that
                network somewhere.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                3. <strong>Bureaucracy</strong>: assign vehicles, set fuel caps if needed, and routes auto-run the maximum trips you can afford.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Real-world crew math uses <strong>{formatDecimal(game.operatingConfig.hoursPerDay)}</strong> hours/day for{" "}
                <strong>{formatDecimal(game.operatingConfig.daysPerWeek, 0)}</strong> days/week across{" "}
                <strong>{formatDecimal(game.operatingConfig.weeksPerPeriod, 0)}</strong> weeks/month.
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
                One vehicle card can operate one matching route at a time during bureaucracy, and fuel is charged as part of each trip&apos;s operating cost.
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
                Bus crew:{" "}
                <strong>{formatUnitRate(game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.bus, 0)}/h</strong>{" "}
                • {formatCurrency(getCrewCostPerWeekPerVehicle(game, "bus"))}/month/vehicle
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Train crew:{" "}
                <strong>{formatUnitRate(game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.train, 0)}/h</strong>{" "}
                • {formatCurrency(getCrewCostPerWeekPerVehicle(game, "train"))}/month/vehicle
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Air crew:{" "}
                <strong>{formatUnitRate(game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.air, 0)}/h</strong>{" "}
                • {formatCurrency(getCrewCostPerWeekPerVehicle(game, "air"))}/month/vehicle
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Bus maintenance:{" "}
                <strong>{formatCurrency(game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle.bus * game.operatingConfig.weeksPerPeriod)}</strong>/month/vehicle
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Train maintenance:{" "}
                <strong>{formatCurrency(game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle.train * game.operatingConfig.weeksPerPeriod)}</strong>/month/vehicle
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Air maintenance:{" "}
                <strong>{formatCurrency(game.operatingConfig.realWorldOperatingCosts.maintenanceCostPerWeekPerVehicle.air * game.operatingConfig.weeksPerPeriod)}</strong>/month/vehicle
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
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Crew / hr</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Crew / month / vehicle</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Maint / month / vehicle</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Balance / trip</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Loading</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Fuel price</th>
                  </tr>
                </thead>
                <tbody>
                  {economicsRows.map(row => (
                    <tr key={`wiki-${row.label}`}>
                      <td style={{ padding: "8px" }}>
                        <strong>{row.label}</strong>
                      </td>
                      <td style={{ padding: "8px" }}>{formatUnitRate(row.ticketPricePerMile, 3)}</td>
                      <td style={{ padding: "8px" }}>
                        {formatUnitRate(row.crewHourlyCostPerVehicle, 0)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatCurrency(row.crewCostPerWeekPerVehicle)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatCurrency(row.maintenanceCostPerWeekPerVehicle)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {formatCurrency(row.balanceAdjustmentPerTrip)}
                      </td>
                      <td style={{ padding: "8px" }}>{formatDecimal(row.loadingHours)}h</td>
                      <td style={{ padding: "8px" }}>{row.fuel}</td>
                      <td style={{ padding: "8px" }}>{row.fuelPrice}</td>
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
                      Active this month
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
      {isActionLogOpen && (
        <div style={ACTION_LOG_PANEL_STYLE}>
          <strong>Action log</strong>
          {game.actionLog.length === 0 ? (
            <div style={{ color: "#56635a", fontSize: 13 }}>No actions yet.</div>
          ) : (
            game.actionLog
              .slice(-18)
              .toReversed()
              .map(entry => {
                const playerColor =
                  game.players.find(player => player.id === entry.playerId)?.color ?? "#223024"

                return (
                  <div
                    key={entry.id}
                    style={{
                      border: "1px solid #d8dfd5",
                      borderRadius: 8,
                      padding: "8px 10px",
                      background: "#ffffff",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <div style={{ fontSize: 12, color: "#56635a" }}>
                      <span style={{ color: playerColor, fontWeight: 700 }}>{entry.playerName}</span>
                      {" • "}Month {entry.week}
                      {" • "}{formatPhaseLabel(entry.phase)}
                    </div>
                    <div style={{ color: "#223024", fontSize: 13 }}>{entry.message}</div>
                  </div>
                )
              })
          )}
        </div>
      )}
      <div style={BOTTOM_BAR_STYLE}>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <div>
            <strong>Month:</strong> {game.currentWeek}/{game.operatingConfig.totalWeeks}
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
            <strong>Months left:</strong> {periodsRemaining}
          </div>
          {game.currentPhase === "bureaucracy" && currentPlayerBureaucracySummary && (
            <div>
              <strong>Planned fuel cost:</strong>{" "}
              {formatCurrency(
                currentPlayerBureaucracySummary.routePlans.reduce(
                  (total, plan) => total + plan.fuelCost,
                  0,
                ),
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
            onClick={() => setIsActionLogOpen(open => !open)}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: "pointer",
              background: "#ffffff",
              fontWeight: 600,
            }}
          >
            {isActionLogOpen ? "Hide log" : "Action log"}
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
            disabled={game.isGameOver || isAdvanceBlocked}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              cursor: game.isGameOver || isAdvanceBlocked ? "not-allowed" : "pointer",
              background: game.isGameOver || isAdvanceBlocked ? "#f2f2f2" : "#ffffff",
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
