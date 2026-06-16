import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import {
  type RailUpgradeResult,
  type BureaucracyServiceCityMoveResult,
  calculateClaimRouteCost,
  type BureaucracyServiceSplitResult,
  type BureaucracyVehicleCardResult,
  canPlayerEditOperations,
  canPlayerPickCities,
  canPlayerStartPhaseByPipeline,
  hasPlayerCompletedBureaucracy,
  getVisibleVehicleMarketCardIds,
  getVehiclePurchaseLimit,
  getFuelUnitPrice,
  getClaimSegmentPairs,
  getEffectiveClaimCityIds,
  getConnectionOptions,
  getCurrentPlayer,
  resolveSegmentSelection,
  resolveRouteSelection,
  type DrawCityOfferResult,
} from "../engine/actions"
import {
  buildBureaucracySummaries,
  findPlayerBureaucracyPlan,
  getMaxFuelUnitsCapacityForPlayer,
  getPayoutMultiplierForDistance,
  isValidServicePodSelection,
} from "../engine/bureaucracy"
import {
  getAffordableFleetSize,
  buildVictoryStandings,
  calculateConnectionBonus,
  getActiveChanceCard,
  getBalanceAdjustmentPerTrip,
  getCityDemandAbsorptionSize,
  getCityDemandSize,
  getCombinedDemandForCityIds,
  getCrewCostForTrips,
  getDemandCapacityForCityIds,
  getCrewCostPerWeekPerVehicle,
  getFleetSizeForDemand,
  getConnectedCityIds,
  getFuelPriceMultiplier,
  getHoursPerWeek,
  getMaintenanceCostPerWeekPerVehicle,
  getPassengersPerTripForCityIds,
  getRailTraction,
  getRailUpgradeCost,
} from "../engine/economy"
import { getPlayerOwnedNetworkRoutes } from "../engine/playerNetwork"
import { getOwnedVehicleCountsByCardId } from "../engine/playerVehicles"
import { latLngToWorld } from "../engine/projection"
import {
  calculateDistanceMiles,
  calculateRealFuelFromUnits,
  calculateRouteTripsPerWeek,
} from "../engine/trips"
import { computeLabels } from "../engine/layout"
import { usOutline } from "../data/maps/usOutline"
import {
  enableDebugMode,
  disableDebugMode,
  getDebugEntries,
} from "../engine/debugLogger"
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch"
import type {
  CityDeckRegion,
  GameState,
  RouteModeBreakdown,
  PurchasableResource,
  RouteMode,
  VehicleCard,
  WeeklyPhase,
} from "../engine/types"
import { CITY_DECK_REGIONS as CITY_DECK_REGION_LIST } from "../engine/types"

type MaybePromise<T> = T | Promise<T>

type LanSessionStatus = {
  sessionId: string
  sessionName: string
  playerName: string | null
  statusMessage: string
  statusTone: "neutral" | "error"
}

type Props = {
  game: GameState
  viewingPlayerId?: string | null
  lanSessionStatus?: LanSessionStatus | null
  suppressPeriodSummary?: boolean
  onPeriodSummaryVisibilityChange?: (isOpen: boolean) => void
  onClaimRoute: (
    mode: RouteMode,
    cityIds: string[],
    segmentPairs?: Array<[string, string]>,
  ) => MaybePromise<
    | {
        ok: true
        routes: GameState["routes"]
        cost: number
        connectionBonus: number
        newCityIds: string[]
        nextPhase: WeeklyPhase
        nextPlayerName: string
        advancedPhase: boolean
      }
    | {
        ok: false
        error: string
      }
  >
  onDrawCityOffer: (region: CityDeckRegion) => MaybePromise<DrawCityOfferResult>
  onSetActiveCityOfferKeptCityIds: (cityIds: string[]) => MaybePromise<
    | {
        ok: true
        game: GameState
        cityIds: string[]
      }
    | {
        ok: false
        error: string
      }
  >
  onBuyVehicleCard: (
    cardId: string,
    quantity: number,
  ) => MaybePromise<
    | {
      ok: true
      card: VehicleCard
      quantity: number
        cost: number
        nextPhase: WeeklyPhase
        nextPlayerName: string
        advancedPhase: boolean
      }
    | {
        ok: false
        error: string
      }
  >
  onUpgradeRailRoute: (routeId: string) => MaybePromise<RailUpgradeResult>
  onSetBureaucracyRouteVehicleCard: (
    routeId: string,
    vehicleCardId: string | null,
  ) => MaybePromise<BureaucracyVehicleCardResult>
  onAddBureaucracyServiceSplit: (corridorId: string) => MaybePromise<BureaucracyServiceSplitResult>
  onMoveBureaucracyServiceCity: (
    corridorId: string,
    cityId: string,
    routeId: string,
    sourceRouteId?: string | null,
  ) => MaybePromise<BureaucracyServiceCityMoveResult>
  onDeleteBureaucracyServicePod: (
    corridorId: string,
    routeId: string,
  ) => MaybePromise<{
    ok: true
  } | {
    ok: false
    error: string
  }>
  onAdvanceTurn: () => MaybePromise<{ ok: true; game: GameState } | { ok: false; error: string }>
  onUndo: () => void
  canUndo: boolean
}

type ResizeTarget = "left-panel" | "right-rail" | "table-height" | "table-preview"

type ResizeState = {
  target: ResizeTarget
  startX: number
  startY: number
  startValue: number
}

type PreviewSegment = {
  cityA: GameState["cities"][number]
  cityB: GameState["cities"][number]
  curve: { x?: number; y?: number } | undefined
}

type DraggedPodCity = {
  corridorId: string
  routeId: string
  cityId: string
}

const MIN_TRAY_SIZE = 200
const MIN_STATUS_RAIL_WIDTH = 60
const DEFAULT_TABLE_ZONE_HEIGHT = 390
const DEFAULT_LEFT_PANEL_WIDTH = 280
const DEFAULT_STATUS_RAIL_WIDTH = 60
const DEFAULT_TABLE_PREVIEW_WIDTH = 240
const PANEL_GAP = 12
const ROW_TWO_TOP = 88
const TABLE_ZONE_GAP = 6
const RESIZE_HANDLE_SIZE = 12
const COLLAPSED_LEFT_PANEL_WIDTH = 40
const CITY_DOT_RADIUS = 2.4
const DEMAND_POINTS_PER_MAP_CUBE = 10
const MAP_CUBES_PER_CYLINDER = 10
const POD_COLOR_PALETTE = [
  "#2563eb",
  "#db2777",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#4f46e5",
] as const
const BUS_POD_COLOR_PALETTE = ["#2563eb", "#0f766e", "#7c3aed", "#db2777"] as const
const RAIL_POD_COLOR_PALETTE = ["#b45309", "#dc2626", "#7c2d12", "#ea580c"] as const

const BOARD_SHELL_STYLE = {
  position: "fixed",
  inset: 0,
  overflow: "hidden",
  background: "#e8efe6",
} as const

const HUD_STYLE = {
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 2,
  fontFamily: "system-ui, sans-serif",
} as const

const ROW_TWO_STYLE = {
  position: "absolute",
  left: PANEL_GAP,
  right: PANEL_GAP,
  top: ROW_TWO_TOP,
  display: "grid",
  gap: PANEL_GAP,
  zIndex: 2,
} as const

const PLAYER_PANEL_STYLE = {
  position: "absolute",
  top: ROW_TWO_TOP,
  width: 320,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 2,
  fontFamily: "system-ui, sans-serif",
} as const

const ACTION_LOG_PANEL_STYLE = {
  position: "absolute",
  maxHeight: 260,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.97)",
  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.16)",
  zIndex: 4,
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
  left: PANEL_GAP,
  right: PANEL_GAP,
  top: PANEL_GAP,
  display: "flex",
  alignItems: "stretch",
  gap: 6,
  padding: 6,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 6px 24px rgba(0, 0, 0, 0.12)",
  zIndex: 2,
  fontFamily: "system-ui, sans-serif",
} as const

const TOP_BAR_PLAYERS_STYLE = {
  minWidth: 0,
  flex: "1 1 auto",
  display: "flex",
  alignItems: "stretch",
  gap: 6,
  overflowX: "auto",
  overflowY: "hidden",
  scrollbarWidth: "thin",
} as const

const TOP_BAR_PLAYER_STYLE = {
  minWidth: 280,
  flex: "0 0 auto",
  border: "1px solid #d8dfd5",
  borderRadius: 10,
  padding: "5px 7px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  whiteSpace: "nowrap",
  background: "#ffffff",
  fontSize: 11,
} as const

const BOTTOM_BAR_STYLE = {
  position: "relative",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 8,
  padding: 8,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.97)",
  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.16)",
  zIndex: 2,
  fontFamily: "system-ui, sans-serif",
} as const

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function colorWithOpacity(color: string, opacity: number) {
  const normalized = color.trim()
  const shortHexMatch = /^#([\da-f]{3})$/i.exec(normalized)
  const fullHexMatch = /^#([\da-f]{6})$/i.exec(normalized)

  if (shortHexMatch) {
    const [r, g, b] = shortHexMatch[1].split("").map(channel => parseInt(channel + channel, 16))
    return `rgba(${r}, ${g}, ${b}, ${opacity})`
  }

  if (fullHexMatch) {
    const value = fullHexMatch[1]
    const r = parseInt(value.slice(0, 2), 16)
    const g = parseInt(value.slice(2, 4), 16)
    const b = parseInt(value.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${opacity})`
  }

  return color
}

function getRouteSelectColors(mode: RouteMode) {
  switch (mode) {
    case "bus":
      return {
        border: "#2563eb",
        background: colorWithOpacity("#2563eb", 0.12),
        color: "#1d4ed8",
      }
    case "rail":
      return {
        border: "#b45309",
        background: colorWithOpacity("#f59e0b", 0.14),
        color: "#92400e",
      }
    case "air":
      return {
        border: "#7c3aed",
        background: colorWithOpacity("#8b5cf6", 0.14),
        color: "#5b21b6",
      }
  }
}

function buildSegmentPath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  curve?: { x?: number; y?: number },
) {
  if (!curve?.x && !curve?.y) {
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  }

  const midpointX = (a.x + b.x) / 2
  const midpointY = (a.y + b.y) / 2
  const segmentLength = Math.hypot(b.x - a.x, b.y - a.y)

  return `M ${a.x} ${a.y} Q ${midpointX + segmentLength * (curve.x ?? 0)} ${midpointY - segmentLength * (curve.y ?? 0)} ${b.x} ${b.y}`
}

function getSegmentKey(cityAId: string, cityBId: string) {
  return [cityAId, cityBId].sort().join("|")
}

function getPrimaryCityDeckRegion(region: GameState["cities"][number]["region"]) {
  const primaryRegion = region?.[0]

  return primaryRegion && CITY_DECK_REGION_LIST.includes(primaryRegion as CityDeckRegion)
    ? (primaryRegion as CityDeckRegion)
    : null
}

function renderFillBoxes(
  totalBoxes: number,
  filledBoxes: number,
  options: {
    filledColor?: string
    unfilledColor?: string
    unfilledBorderColor?: string
  } = {},
) {
  const filledColor = options.filledColor ?? "#5fbf72"
  const unfilledColor = options.unfilledColor ?? "transparent"
  const unfilledBorderColor = options.unfilledBorderColor ?? "#92a097"

  return Array.from({ length: Math.max(totalBoxes, 0) }, (_, index) => (
    <span
      key={`fill-box-${totalBoxes}-${filledBoxes}-${index}`}
      style={{
        width: 12,
        height: 12,
        borderRadius: 3,
        border: `1px solid ${index < filledBoxes ? filledColor : unfilledBorderColor}`,
        background: index < filledBoxes ? filledColor : unfilledColor,
        display: "inline-block",
        boxSizing: "border-box",
      }}
    />
  ))
}

function renderDemandPointBoxes(
  totalDemandPoints: number,
  filledDemandPoints: number,
  options: {
    demandPointsPerBox?: number
    filledColor?: string
    unfilledColor?: string
    unfilledBorderColor?: string
  } = {},
) {
  const demandPointsPerBox = options.demandPointsPerBox ?? 10
  const totalBoxes = Math.max(0, Math.ceil(totalDemandPoints / demandPointsPerBox))
  const filledBoxes = Math.min(totalBoxes, Math.max(0, Math.ceil(filledDemandPoints / demandPointsPerBox)))

  return renderFillBoxes(totalBoxes, filledBoxes, options)
}

type CityAdjacencyLabel = {
  id: string
  label: string
  isInNetwork: boolean
}

function getCityAdjacencyLabels(
  city: GameState["cities"][number] | undefined,
  cityMap: Record<string, GameState["cities"][number]>,
  networkCityIds: Set<string>,
) {
  return (city?.adjacentCities ?? [])
    .map(adjacentCity => ({
      id: adjacentCity.id,
      label: `${cityMap[adjacentCity.id]?.name ?? adjacentCity.id} - ${adjacentCity.distance}mi (${getPayoutMultiplierForDistance(adjacentCity.distance)})`,
      distance: adjacentCity.distance,
      name: cityMap[adjacentCity.id]?.name ?? adjacentCity.id,
      isInNetwork: networkCityIds.has(adjacentCity.id),
    }))
    .sort((entryA, entryB) => {
      if (entryA.distance !== entryB.distance) {
        return entryA.distance - entryB.distance
      }

      return entryA.name.localeCompare(entryB.name)
    })
}

function formatPopulation(population: number | undefined) {
  if (!population || population <= 0) {
    return "—"
  }

  if (population >= 1_000_000) {
    return `${formatDecimal(population / 1_000_000, 1)}M`
  }

  if (population >= 1_000) {
    return `${formatDecimal(population / 1_000, 0)}K`
  }

  return population.toLocaleString()
}

function renderCitySelectionCard({
  cityId,
  city,
  cityRegion,
  regionStyle,
  adjacencyLabels,
  isSelected,
  disabled,
  onClick,
}: {
  cityId: string
  city: GameState["cities"][number] | undefined
  cityRegion: CityDeckRegion | null
  regionStyle: { fill: string; stroke: string; surface: string; text: string }
  adjacencyLabels: CityAdjacencyLabel[]
  isSelected: boolean
  disabled: boolean
  onClick: () => void
}) {
  const borderColor = isSelected ? regionStyle.stroke : colorWithOpacity(regionStyle.stroke, 0.4)
  const headerBackground = isSelected
    ? `linear-gradient(180deg, ${colorWithOpacity(regionStyle.fill, 0.28)} 0%, ${colorWithOpacity(regionStyle.fill, 0.12)} 100%)`
    : `linear-gradient(180deg, ${colorWithOpacity(regionStyle.fill, 0.18)} 0%, ${regionStyle.surface} 100%)`

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 186,
        minHeight: 228,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 16,
        padding: 0,
        background: "#fffef9",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.65 : 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxShadow: isSelected
          ? `0 10px 22px ${colorWithOpacity(regionStyle.stroke, 0.22)}`
          : "0 6px 16px rgba(34, 48, 36, 0.08)",
      }}
    >
      <div
        style={{
          padding: "12px 12px 10px",
          background: headerBackground,
          borderBottom: `1px solid ${colorWithOpacity(regionStyle.stroke, 0.2)}`,
          display: "grid",
          gap: 4,
        }}
      >
        <strong
          style={{
            fontSize: 15,
            lineHeight: 1.15,
            color: "#223024",
          }}
        >
          {city?.name ?? cityId}
        </strong>
        <div
          style={{
            color: regionStyle.text,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {cityRegion ?? "Regionless"}
        </div>
        <div
          style={{
            color: "#4d5a50",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          Pop {formatPopulation(city?.population)} • Size {city?.size ?? 0}
        </div>
      </div>
      <div
        style={{
          padding: "10px 12px 12px",
          display: "grid",
          gap: 6,
          flex: 1,
          alignContent: "start",
        }}
      >
        <div
          style={{
            color: "#6c776f",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Connections
        </div>
        {adjacencyLabels.length > 0 ? (
          <div style={{ display: "grid", gap: 4 }}>
            {adjacencyLabels.map(({ id, isInNetwork, label }) => (
              <div
                key={`${cityId}-${id}`}
                style={{
                  color: isInNetwork ? regionStyle.text : "#324236",
                  fontSize: 10,
                  lineHeight: 1.3,
                  fontWeight: isInNetwork ? 700 : 400,
                  padding: isInNetwork ? "3px 6px" : 0,
                  borderRadius: isInNetwork ? 999 : 0,
                  background: isInNetwork
                    ? colorWithOpacity(regionStyle.fill, 0.2)
                    : "transparent",
                  border: isInNetwork
                    ? `1px solid ${colorWithOpacity(regionStyle.stroke, 0.28)}`
                    : "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  justifySelf: "start",
                }}
              >
                {isInNetwork && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: regionStyle.stroke,
                      flexShrink: 0,
                    }}
                  />
                )}
                {label}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: "#7b857d", fontSize: 10.5, lineHeight: 1.3 }}>No listed connections</div>
        )}
      </div>
    </button>
  )
}

function getDiePipPositions(value: number) {
  switch (value) {
    case 1:
      return [{ top: "50%", left: "50%" }]
    case 2:
      return [
        { top: "28%", left: "28%" },
        { top: "72%", left: "72%" },
      ]
    case 3:
      return [
        { top: "28%", left: "28%" },
        { top: "50%", left: "50%" },
        { top: "72%", left: "72%" },
      ]
    case 4:
      return [
        { top: "28%", left: "28%" },
        { top: "28%", left: "72%" },
        { top: "72%", left: "28%" },
        { top: "72%", left: "72%" },
      ]
    case 5:
      return [
        { top: "28%", left: "28%" },
        { top: "28%", left: "72%" },
        { top: "50%", left: "50%" },
        { top: "72%", left: "28%" },
        { top: "72%", left: "72%" },
      ]
    default:
      return [
        { top: "28%", left: "28%" },
        { top: "28%", left: "72%" },
        { top: "50%", left: "28%" },
        { top: "50%", left: "72%" },
        { top: "72%", left: "28%" },
        { top: "72%", left: "72%" },
      ]
  }
}

function getDefaultTablePreviewWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_TABLE_PREVIEW_WIDTH
  }

  const availableTableZoneWidth = window.innerWidth - PANEL_GAP * 2 - TABLE_ZONE_GAP
  const maxTablePreviewWidth = Math.max(MIN_TRAY_SIZE, availableTableZoneWidth - MIN_TRAY_SIZE)

  return clamp(Math.round(availableTableZoneWidth * 0.25), MIN_TRAY_SIZE, maxTablePreviewWidth)
}

function getResizeCursor(target: ResizeTarget) {
  return target === "table-height" ? "ns-resize" : "ew-resize"
}

const RESOURCE_MARKET_PANEL_STYLE = {
  position: "absolute",
  top: ROW_TWO_TOP,
  bottom: PANEL_GAP,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.96)",
  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.14)",
  zIndex: 3,
  fontFamily: "system-ui, sans-serif",
} as const

const BOARD_STAGE_STYLE = {
  position: "relative",
  minWidth: 0,
  minHeight: 0,
  borderRadius: 12,
  background: "#f4f7f3",
  border: "1px solid rgba(124, 146, 127, 0.2)",
  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.12)",
  zIndex: 0,
  overflow: "hidden",
} as const

const BOARD_INNER_STYLE = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  borderRadius: 12,
  background: "#f4f7f3",
  boxShadow: "inset 0 0 0 1px rgba(124, 146, 127, 0.18)",
} as const

const TABLE_ZONE_STYLE = {
  position: "absolute",
  left: PANEL_GAP,
  right: PANEL_GAP,
  bottom: PANEL_GAP,
  display: "grid",
  gap: TABLE_ZONE_GAP,
  zIndex: 2,
  fontFamily: "system-ui, sans-serif",
} as const

const TABLE_LANE_STYLE = {
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  borderRadius: 12,
  background: "rgba(255, 255, 255, 0.94)",
  border: "1px solid #d8dfd5",
  overflow: "hidden",
} as const

const MAP_OUTLINE_STYLE = {
  fill: "#f4f1e8",
  stroke: "#c9c2b3",
  opacity: 0.9,
} as const

const REGION_STYLES: Record<
  CityDeckRegion,
  { fill: string; stroke: string; surface: string; text: string }
> = {
  Pacific: { fill: "#4d9de0", stroke: "#2f6fa7", surface: "#eef6fd", text: "#214b6f" },
  Mountain: { fill: "#8a6dd3", stroke: "#5f49a0", surface: "#f3effd", text: "#4a3a80" },
  South: { fill: "#e27d60", stroke: "#b65d45", surface: "#fdf0ec", text: "#7a4030" },
  Southeast: { fill: "#4fb286", stroke: "#2f805f", surface: "#eef9f4", text: "#235846" },
  Midwest: { fill: "#d8a031", stroke: "#9b6f12", surface: "#fcf5e8", text: "#74520e" },
  Northeast: { fill: "#d35d9e", stroke: "#9e3f73", surface: "#fceef5", text: "#7b3158" },
}

const REGION_SHADE_BASE_RADIUS: Record<CityDeckRegion, number> = {
  Pacific: 36,
  Mountain: 38,
  South: 28,
  Southeast: 28,
  Midwest: 30,
  Northeast: 26,
}

const REGION_SHADE_ANCHORS: Array<{
  id: string
  region: CityDeckRegion
  lat: number
  lng: number
  radius: number
}> = [
  { id: "pacific-north", region: "Pacific", lat: 45.8, lng: -121.3, radius: 72 },
  { id: "pacific-central", region: "Pacific", lat: 40.8, lng: -121.2, radius: 76 },
  { id: "pacific-south", region: "Pacific", lat: 35.8, lng: -119.8, radius: 72 },
  { id: "pacific-sacramento-salt-lake", region: "Pacific", lat: 39.3, lng: -117.2, radius: 64 },
  { id: "mountain-north", region: "Mountain", lat: 45.2, lng: -111.5, radius: 78 },
  { id: "mountain-central", region: "Mountain", lat: 40.7, lng: -111.2, radius: 82 },
  { id: "mountain-south", region: "Mountain", lat: 35.8, lng: -108.8, radius: 78 },
  { id: "mountain-spokane-fargo", region: "Mountain", lat: 47.1, lng: -108.2, radius: 64 },
  { id: "mountain-billings-fargo", region: "Mountain", lat: 46.7, lng: -101.6, radius: 62 },
  { id: "mountain-billings-sioux-falls", region: "Mountain", lat: 44.8, lng: -101.8, radius: 66 },
  { id: "mountain-cheyenne-omaha", region: "Mountain", lat: 41.1, lng: -100.3, radius: 60 },
]

const MODE_LABELS: Record<RouteMode, string> = {
  rail: "Rail",
  air: "Air",
  bus: "Bus",
}

function createEmptyRouteModeBreakdown(): RouteModeBreakdown {
  return {
    bus: 0,
    rail: 0,
    air: 0,
  }
}

const BUREAUCRACY_MODE_ORDER: RouteMode[] = ["bus", "rail", "air"]

const MODE_LINE_STYLES: Record<
  RouteMode,
  { strokeDasharray?: string; opacity?: number; strokeWidth: number }
> = {
  rail: { strokeWidth: 6 },
  air: { strokeDasharray: "14 10", strokeWidth: 4 },
  bus: { strokeWidth: 4, opacity: 0.95 },
}

const MODE_ACCENT_COLORS: Record<RouteMode, { border: string; face: string; badge: string }> = {
  bus: { border: "#8aa07f", face: "#f7fbf4", badge: "#68865b" },
  rail: { border: "#7d8fa8", face: "#f4f7fb", badge: "#5b7395" },
  air: { border: "#9a88bb", face: "#f7f4fc", badge: "#7c66a7" },
}

const TOP_BAR_PHASE_ORDER: WeeklyPhase[] = [
  "purchase-equipment",
  "add-city",
  "operations",
  "bureaucracy",
]

type CardStackPreviewProps = {
  icon: string
  label: string
  count: number
  accent: { border: string; face: string; badge: string }
  compact?: boolean
  dimmed?: boolean
}

function CardStackPreview({
  icon,
  label,
  count,
  accent,
  compact = false,
  dimmed = false,
}: CardStackPreviewProps) {
  const width = compact ? 19 : 34
  const height = compact ? 26 : 48
  const badgeSize = compact ? 12 : 15
  const depth = count > 0 ? Math.min(3, count) : 1

  return (
    <div
      title={`${label}: ${count}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        minWidth: 0,
        opacity: dimmed ? 0.6 : 1,
      }}
    >
      <div
        style={{
          position: "relative",
          width: width + (depth - 1) * (compact ? 3 : 6),
          height: height + (depth - 1) * (compact ? 2 : 4),
          flexShrink: 0,
        }}
      >
        {Array.from({ length: depth }).map((_, index) => {
          const isTop = index === depth - 1

          return (
            <div
              key={`${label}-${index}`}
              style={{
                position: "absolute",
                left: index * (compact ? 3 : 6),
                top: index * (compact ? 2 : 4),
                width,
                height,
                borderRadius: compact ? 5 : 12,
                border: `1px solid ${accent.border}`,
                background: accent.face,
                boxShadow: isTop ? "0 4px 10px rgba(0, 0, 0, 0.08)" : "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#223024",
                fontSize: compact ? 10 : 18,
                fontWeight: 700,
                overflow: "hidden",
                opacity: count > 0 ? 1 : 0.45,
              }}
            >
              {icon}
              {isTop && (
                <div
                  style={{
                    position: "absolute",
                    right: compact ? 0 : 3,
                    top: compact ? 0 : 3,
                    minWidth: badgeSize,
                    height: badgeSize,
                    padding: compact ? "0 3px" : "0 4px",
                    borderRadius: 999,
                    background: accent.badge,
                    color: "#ffffff",
                    fontSize: compact ? 8 : 9,
                    fontWeight: 800,
                    lineHeight: `${badgeSize}px`,
                    textAlign: "center",
                    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.18)",
                  }}
                >
                  {count}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function getCityDemandTokenCounts(
  passengers: number,
  passengersPerDemandPoint: number,
) {
  const demandCubePassengers =
    passengersPerDemandPoint * DEMAND_POINTS_PER_MAP_CUBE
  const demandCylinderPassengers =
    demandCubePassengers * MAP_CUBES_PER_CYLINDER
  const roundedPassengers = Math.max(
    0,
    Math.round(passengers / demandCubePassengers) * demandCubePassengers,
  )

  return {
    roundedPassengers,
    cylinders: Math.floor(roundedPassengers / demandCylinderPassengers),
    cubes:
      (roundedPassengers % demandCylinderPassengers) / demandCubePassengers,
  }
}

function renderCityDemandTokens(
  cityName: string,
  x: number,
  y: number,
  radius: number,
  passengers: number,
  passengersPerDemandPoint: number,
) {
  const { roundedPassengers, cylinders, cubes } =
    getCityDemandTokenCounts(passengers, passengersPerDemandPoint)

  if (roundedPassengers <= 0) {
    return null
  }

  const layers: ReactNode[] = []
  let nextBottomY = y - radius - 3
  const getColumnOffset = (columnIndex: number, horizontalSpacing: number) =>
    columnIndex === 0 ? -horizontalSpacing / 2 : horizontalSpacing / 2

  for (let index = 0; index < cylinders; index += 2) {
    const tokenHeight = 8
    const topY = nextBottomY - tokenHeight
    const rowCount = Math.min(2, cylinders - index)

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const centerX = x + getColumnOffset(rowIndex, 10)

      layers.push(
        <g key={`${cityName}-cylinder-${index + rowIndex}`}>
          <ellipse
            cx={centerX}
            cy={topY + 1.1}
            rx={4.2}
            ry={1.8}
            fill="#f6d174"
            stroke="#7f5c1f"
            strokeWidth={0.9}
          />
          <rect
            x={centerX - 4.2}
            y={topY + 1.1}
            width={8.4}
            height={5.8}
            rx={1.5}
            fill="#f0bc4f"
            stroke="#7f5c1f"
            strokeWidth={0.9}
          />
          <ellipse
            cx={centerX}
            cy={topY + 6.9}
            rx={4.2}
            ry={1.8}
            fill="#d89a2c"
            stroke="#7f5c1f"
            strokeWidth={0.9}
          />
        </g>,
      )
    }

    nextBottomY = topY - 1.2
  }

  for (let index = 0; index < cubes; index += 2) {
    const tokenSize = 6
    const topY = nextBottomY - tokenSize
    const rowCount = Math.min(2, cubes - index)

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const centerX = x + getColumnOffset(rowIndex, 8)

      layers.push(
        <rect
          key={`${cityName}-cube-${index + rowIndex}`}
          x={centerX - tokenSize / 2}
          y={topY}
          width={tokenSize}
          height={tokenSize}
          rx={1.2}
          fill="#5fbf72"
          stroke="#224b2c"
          strokeWidth={0.9}
        />,
      )
    }

    nextBottomY = topY - 1.2
  }

  return (
    <g pointerEvents="none">
      <title>{`${cityName}: ${roundedPassengers} passengers of monthly demand (${DEMAND_POINTS_PER_MAP_CUBE} demand points per cube)`}</title>
      {layers}
    </g>
  )
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

function getModeForVehicleType(type: VehicleCard["type"]): RouteMode {
  return type === "train" ? "rail" : type
}

function getRealFuelLabel(resource: PurchasableResource) {
  return resource === "diesel" ? "gallons" : "pounds"
}

function formatPhaseLabel(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "Purchase equipment"
    case "add-city":
      return "Add city"
    case "operations":
      return "Operations"
    case "bureaucracy":
      return "Bureaucracy"
  }
}

function getNextPhase(phase: WeeklyPhase): WeeklyPhase {
  switch (phase) {
    case "purchase-equipment":
      return "add-city"
    case "add-city":
      return "operations"
    case "operations":
      return "bureaucracy"
    case "bureaucracy":
      return "purchase-equipment"
  }
}

function getRouteInteractionMessage(phase: WeeklyPhase) {
  return phase === "operations"
    ? "Build tracks from the Operations list or highlighted map segments, then assign vehicles and split routes."
    : "Routes can only be claimed during the operations phase."
}

function getPhaseStatusMessage(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "Make 1 vehicle purchase this turn. Buses can buy up to 6, trains up to 3, planes 1."
    case "add-city":
      return "Draw 4 city cards and keep exactly 2, then go straight into Operations for this turn."
    case "operations":
      return "Build tracks, assign vehicles, and split service routes before running the month."
    case "bureaucracy":
      return "Review passenger flow and operating ledgers, then advance."
  }
}

function getTopBarPhaseIndex(phase: WeeklyPhase) {
  return Math.max(0, TOP_BAR_PHASE_ORDER.indexOf(phase))
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

function getVehiclePurchaseLabel(type: VehicleCard["type"], quantity: number) {
  switch (type) {
    case "bus":
      return quantity === 1 ? "bus" : "buses"
    case "train":
      return quantity === 1 ? "train" : "trains"
    case "air":
      return quantity === 1 ? "plane" : "planes"
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
  viewingPlayerId,
  lanSessionStatus,
  suppressPeriodSummary = false,
  onPeriodSummaryVisibilityChange,
  onClaimRoute,
  onDrawCityOffer,
  onSetActiveCityOfferKeptCityIds,
  onBuyVehicleCard,
  onUpgradeRailRoute,
  onSetBureaucracyRouteVehicleCard,
  onAddBureaucracyServiceSplit,
  onMoveBureaucracyServiceCity,
  onDeleteBureaucracyServicePod,
  onAdvanceTurn,
  onUndo,
  canUndo,
}: Props) {
  type RestorablePanel = "resource" | "vehicle" | "bureaucracy" | "economics" | null

  const [selectedRouteMode, setSelectedRouteMode] = useState<RouteMode | null>(null)
  const [selectedDrawCityIds, setSelectedDrawCityIds] = useState<string[]>([])
  const [selectedOwnedCityIds, setSelectedOwnedCityIds] = useState<string[]>([])
  const [selectedRailSegmentKeys, setSelectedRailSegmentKeys] = useState<string[]>([])
  const [draggedPodCity, setDraggedPodCity] = useState<DraggedPodCity | null>(null)
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const [isResourceMarketOpen, setIsResourceMarketOpen] = useState(false)
  const [isVehicleMarketOpen, setIsVehicleMarketOpen] = useState(false)
  const [isBureaucracyOpen, setIsBureaucracyOpen] = useState(false)
  const [isEconomicsOpen, setIsEconomicsOpen] = useState(false)
  const [isWikiOpen, setIsWikiOpen] = useState(false)
  const [isActionLogOpen, setIsActionLogOpen] = useState(false)
  const [isControlsMenuOpen, setIsControlsMenuOpen] = useState(false)
  const [wikiPreviousPanel, setWikiPreviousPanel] = useState<RestorablePanel>(null)
  const [zoomScale, setZoomScale] = useState(1)
  const [isLiveStagePulseOn, setIsLiveStagePulseOn] = useState(false)
  const [isPeriodSummaryOpen, setIsPeriodSummaryOpen] = useState(false)
  const [isGameSummaryMinimized, setIsGameSummaryMinimized] = useState(false)
  const [lastShownPeriodSummaryKey, setLastShownPeriodSummaryKey] = useState<string | null>(null)
  const [showCityNames, setShowCityNames] = useState(true)
  const [showCitySizeBubbles, setShowCitySizeBubbles] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string>(
    getPhaseStatusMessage(game.currentPhase),
  )
  const [leftPanelWidth, setLeftPanelWidth] = useState(DEFAULT_LEFT_PANEL_WIDTH)
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false)
  const [rightRailWidth, setRightRailWidth] = useState(DEFAULT_STATUS_RAIL_WIDTH)
  const [tableZoneHeight, setTableZoneHeight] = useState(DEFAULT_TABLE_ZONE_HEIGHT)
  const [tablePreviewWidth, setTablePreviewWidth] = useState(getDefaultTablePreviewWidth)
  const [resizeState, setResizeState] = useState<ResizeState | null>(null)
  const [pendingVehiclePurchaseCardId, setPendingVehiclePurchaseCardId] = useState<string | null>(null)
  const [pendingVehiclePurchaseQuantity, setPendingVehiclePurchaseQuantity] = useState(1)
  const [revealedVehicleFunFactCardId, setRevealedVehicleFunFactCardId] = useState<string | null>(null)

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setIsLiveStagePulseOn(current => !current)
    }, 3200)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (!game.isGameOver) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsGameSummaryMinimized(false)
    }
  }, [game.isGameOver])

  useEffect(() => {
    if (!resizeState) {
      return
    }

    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = "none"
    document.body.style.cursor = getResizeCursor(resizeState.target)

    const handleMouseMove = (event: MouseEvent) => {
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const maxSidePanelWidth = Math.max(
        MIN_TRAY_SIZE,
        viewportWidth - PANEL_GAP * 4 - MIN_TRAY_SIZE - rightRailWidth,
      )
      const maxRightRailWidth = Math.max(
        MIN_STATUS_RAIL_WIDTH,
        viewportWidth - PANEL_GAP * 4 - MIN_TRAY_SIZE - leftPanelWidth,
      )
      const maxTableZoneHeight = Math.max(
        MIN_TRAY_SIZE,
        viewportHeight - ROW_TWO_TOP - PANEL_GAP * 2 - MIN_TRAY_SIZE,
      )
      const maxTablePreviewWidth = Math.max(
        MIN_TRAY_SIZE,
        viewportWidth - PANEL_GAP * 2 - TABLE_ZONE_GAP - MIN_TRAY_SIZE,
      )

      switch (resizeState.target) {
        case "left-panel":
          setLeftPanelWidth(
            clamp(resizeState.startValue + (event.clientX - resizeState.startX), MIN_TRAY_SIZE, maxSidePanelWidth),
          )
          break
        case "right-rail":
          setRightRailWidth(
            clamp(resizeState.startValue - (event.clientX - resizeState.startX), MIN_TRAY_SIZE, maxRightRailWidth),
          )
          break
        case "table-height":
          setTableZoneHeight(
            clamp(resizeState.startValue - (event.clientY - resizeState.startY), MIN_TRAY_SIZE, maxTableZoneHeight),
          )
          break
        case "table-preview":
          setTablePreviewWidth(
            clamp(resizeState.startValue - (event.clientX - resizeState.startX), MIN_TRAY_SIZE, maxTablePreviewWidth),
          )
          break
      }
    }

    const handleMouseUp = () => {
      setResizeState(null)
    }

    const handleTouchMove = (event: TouchEvent) => {
      event.preventDefault()
      const touch = event.touches[0]
      if (touch) handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY } as MouseEvent)
    }

    const handleTouchEnd = () => {
      setResizeState(null)
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    window.addEventListener("touchmove", handleTouchMove, { passive: false })
    window.addEventListener("touchend", handleTouchEnd)

    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
      window.removeEventListener("touchmove", handleTouchMove)
      window.removeEventListener("touchend", handleTouchEnd)
    }
  }, [leftPanelWidth, resizeState, rightRailWidth])

  const map = game.map
  const activeViewingPlayerId = viewingPlayerId ?? game.currentPlayerId
  const viewerPhase: WeeklyPhase = useMemo(() => {
    const player = game.players.find(entry => entry.id === activeViewingPlayerId)
    return player?.phase ?? game.currentPhase
  }, [game, activeViewingPlayerId])
  const currentPlayer =
    game.players.find(player => player.id === activeViewingPlayerId) ?? getCurrentPlayer(game)
  const hasUsedVehiclePurchase =
    activeViewingPlayerId !== null && activeViewingPlayerId !== undefined
      ? game.purchasedVehiclePlayerIds.includes(activeViewingPlayerId)
      : false
  const canBuyVehiclesInPipeline =
    activeViewingPlayerId !== null && activeViewingPlayerId !== undefined &&
    viewerPhase === "purchase-equipment" &&
    canPlayerStartPhaseByPipeline(game, activeViewingPlayerId, "purchase-equipment")
  const boardClearanceBottom = tableZoneHeight + PANEL_GAP * 2
  const effectiveLeftPanelWidth = isLeftPanelCollapsed ? COLLAPSED_LEFT_PANEL_WIDTH : leftPanelWidth
  const boardLeftInset = effectiveLeftPanelWidth + PANEL_GAP * 2
  const boardRightInset = rightRailWidth + PANEL_GAP * 2
  const rowTwoStyle = {
    ...ROW_TWO_STYLE,
    bottom: boardClearanceBottom,
    gridTemplateColumns: `${effectiveLeftPanelWidth}px minmax(0, 1fr) ${rightRailWidth}px`,
  } as const
  const playerPanelStyle = {
    ...PLAYER_PANEL_STYLE,
    right: boardRightInset,
    bottom: boardClearanceBottom,
  } as const
  const actionLogPanelStyle = {
    ...ACTION_LOG_PANEL_STYLE,
    left: boardLeftInset,
    right: boardRightInset,
    bottom: boardClearanceBottom,
  } as const
  const resourceMarketPanelStyle = {
    ...RESOURCE_MARKET_PANEL_STYLE,
    left: boardLeftInset,
    right: boardRightInset,
  } as const
  const tableZoneStyle = {
    ...TABLE_ZONE_STYLE,
    height: tableZoneHeight,
    gridTemplateColumns: `minmax(0, 1fr) ${tablePreviewWidth}px`,
  } as const

  const cityMap: Record<string, GameState["cities"][number]> = Object.fromEntries(
    game.cities.map(c => [c.id, c]),
  )
  const regionShadingBlobs = useMemo(
    () => [
      ...game.cities
        .map(city => {
          const region = getPrimaryCityDeckRegion(city.region)

          if (!region) {
            return null
          }

          const point = latLngToWorld(city)

          return {
            id: `${region}:${city.id}`,
            region,
            x: point.x,
            y: point.y,
            radius: REGION_SHADE_BASE_RADIUS[region] + city.size * 8,
          }
        })
        .filter(
          (
            blob,
          ): blob is {
            id: string
            region: CityDeckRegion
            x: number
            y: number
            radius: number
          } => blob !== null,
        ),
      ...REGION_SHADE_ANCHORS.map(anchor => {
        const point = latLngToWorld(anchor)

        return {
          id: `anchor:${anchor.id}`,
          region: anchor.region,
          x: point.x,
          y: point.y,
          radius: anchor.radius,
        }
      }),
    ],
    [game.cities],
  )
  const adjacentRouteSegments = useMemo(() => {
    const seenPairs = new Set<string>()

    return game.cities.flatMap(city =>
      (city.adjacentCities ?? []).flatMap(adjacentCity => {
        const targetCity = cityMap[adjacentCity.id]

        if (!targetCity) {
          return []
        }

        const pairKey = getSegmentKey(city.id, targetCity.id)

        if (seenPairs.has(pairKey)) {
          return []
        }

        seenPairs.add(pairKey)
        const reverseConnection = targetCity.adjacentCities?.find(candidate => candidate.id === city.id)

        return [
          {
            id: pairKey,
            cityA: city,
            cityB: targetCity,
            distance: adjacentCity.distance,
            curve: adjacentCity.curve ?? reverseConnection?.curve,
            allowRail:
              adjacentCity.allowRail ??
              reverseConnection?.allowRail ??
              true,
          },
        ]
      }),
    )
  }, [cityMap, game.cities])
  const vehicleCardMap: Record<string, VehicleCard> = Object.fromEntries(
    game.vehicleCatalog.map(card => [card.id, card]),
  )
  const bureaucracySummaries = useMemo(
    () => buildBureaucracySummaries(game),
    [game],
  )
  const finalRouteLeaderboard = useMemo(
    () =>
      bureaucracySummaries
        .flatMap(summary =>
          summary.routePlans
            .flatMap(plan => {
              if (
                plan.isDisconnected ||
                plan.vehicleCard === null ||
                plan.selectedCityIds.length < 2 ||
                plan.routes.length === 0
              ) {
                return []
              }

              return [
                {
                  player: summary.player,
                  plan,
                  vehicleCard: plan.vehicleCard,
                },
              ]
            }),
        )
        .sort((entryA, entryB) => {
          if (entryB.plan.passengersServed !== entryA.plan.passengersServed) {
            return entryB.plan.passengersServed - entryA.plan.passengersServed
          }

          if (entryB.plan.movedCubes !== entryA.plan.movedCubes) {
            return entryB.plan.movedCubes - entryA.plan.movedCubes
          }

          return entryA.plan.serviceLabel.localeCompare(entryB.plan.serviceLabel)
        }),
    [bureaucracySummaries],
  )
  const activeCityOffer = game.activeCityOffer
  const selectedRailSegmentPairs = useMemo(
    () =>
      selectedRailSegmentKeys
        .map(segmentKey => {
          const [cityAId, cityBId] = segmentKey.split("|")
          return cityAId && cityBId ? ([cityAId, cityBId] as [string, string]) : null
        })
        .filter((segmentPair): segmentPair is [string, string] => segmentPair !== null),
    [selectedRailSegmentKeys],
  )
  const selectedCityIds = useMemo(
    () => {
      if (selectedRouteMode === "rail" && selectedRailSegmentPairs.length > 0) {
        return [...new Set(selectedRailSegmentPairs.flat())]
      }

      return selectedRouteMode === "bus"
        ? [...new Set([...selectedOwnedCityIds, ...selectedDrawCityIds])]
        : [...new Set([...selectedOwnedCityIds, ...selectedDrawCityIds])]
    },
    [selectedDrawCityIds, selectedOwnedCityIds, selectedRailSegmentPairs, selectedRouteMode],
  )
  const selectedCityIdSet = useMemo(() => new Set(selectedCityIds), [selectedCityIds])
  const activeOfferCityIdSet = useMemo(
    () => new Set(activeCityOffer?.cityIds ?? []),
    [activeCityOffer],
  )
  const ownedCityCardIdSet = useMemo(
    () => new Set(currentPlayer?.ownedCityCardIds ?? []),
    [currentPlayer],
  )
  const ownedCityPlayersByCityId = useMemo(() => {
    const ownersByCityId = new Map<string, GameState["players"]>()

    for (const player of game.players) {
      for (const cityId of player.ownedCityCardIds ?? []) {
        ownersByCityId.set(cityId, [...(ownersByCityId.get(cityId) ?? []), player])
      }
    }

    return ownersByCityId
  }, [game.players])
  const allOwnedCityCardIdSet = useMemo(
    () => new Set([...ownedCityPlayersByCityId.keys()]),
    [ownedCityPlayersByCityId],
  )
  const currentPlayerConnectedCityIds = useMemo(
    () =>
      currentPlayer
        ? new Set(currentPlayer.ownedCityCardIds)
        : new Set<string>(),
    [currentPlayer],
  )
  const isSelectingCityCards = canPlayerPickCities(game, activeViewingPlayerId)
  const expandedCityIds = useMemo(() => {
    const cardVisibleCityIds = new Set<string>([
      ...selectedCityIds,
      ...(activeCityOffer?.cityIds ?? []),
      ...allOwnedCityCardIdSet,
    ])

    currentPlayerConnectedCityIds.forEach(cityId => {
      cardVisibleCityIds.add(cityId)
    })

    return cardVisibleCityIds
  }, [activeCityOffer, allOwnedCityCardIdSet, currentPlayerConnectedCityIds, selectedCityIds])
  function getCityMarkerPriority(cityId: string) {
    if (isSelectingCityCards) {
      if (selectedCityIdSet.has(cityId)) {
        return 3
      }

      if (activeOfferCityIdSet.has(cityId)) {
        return 2
      }

      if (ownedCityCardIdSet.has(cityId)) {
        return 1
      }

      if (allOwnedCityCardIdSet.has(cityId)) {
        return 1
      }

      return 0
    }

    if (selectedCityIdSet.has(cityId)) {
      return 1
    }

    return 0
  }

  function getCityMarkerStyle(city: GameState["cities"][number]) {
    if (isSelectingCityCards) {
      if (selectedCityIdSet.has(city.id)) {
        return {
          radius: city.size * 2.5,
          fill: "#2563eb",
          stroke: "#1e3a8a",
          strokeWidth: 2.5,
          isEmphasized: true,
        }
      }

      if (activeOfferCityIdSet.has(city.id)) {
        return {
          radius: city.size * 2.5,
          fill: "#fde047",
          stroke: "#b45309",
          strokeWidth: 2.5,
          isEmphasized: true,
        }
      }

      if (ownedCityCardIdSet.has(city.id)) {
        const currentPlayerColor = currentPlayer?.color ?? "#000000"
        return {
          radius: city.size * 2.5,
          fill: "#ffffff",
          stroke: currentPlayerColor,
          strokeWidth: 2.5,
          isEmphasized: true,
        }
      }

      const cityOwners = ownedCityPlayersByCityId.get(city.id) ?? []

      if (cityOwners.length > 0) {
        const primaryOwner = cityOwners[0]
        return {
          radius: city.size * 2.4,
          fill: colorWithOpacity(primaryOwner.color, 0.16),
          stroke: primaryOwner.color,
          strokeWidth: 2,
          isEmphasized: true,
        }
      }
    }

    if (selectedCityIdSet.has(city.id)) {
      return {
        radius: 8,
        fill: "#fde047",
        stroke: "#b45309",
        strokeWidth: 3,
        isEmphasized: true,
      }
    }

    if (showCitySizeBubbles) {
      return {
        radius: city.size * 2.5,
        fill: "#ffffff",
        stroke: "#000000",
        strokeWidth: 1.5,
        isEmphasized: true,
      }
    }

    return {
      radius: CITY_DOT_RADIUS,
      fill: "rgba(34, 48, 36, 0.7)",
      stroke: "rgba(244, 241, 232, 0.75)",
      strokeWidth: 1,
      isEmphasized: false,
    }
  }
  const visibleCities = useMemo(() => {
    const kept: Array<GameState["cities"][number] & { markerRadius: number; x: number; y: number }> = []

    const orderedCities = [...game.cities].sort((a, b) => {
      const priorityDifference = getCityMarkerPriority(b.id) - getCityMarkerPriority(a.id)
      if (priorityDifference !== 0) {
        return priorityDifference
      }

      if (b.size !== a.size) {
        return b.size - a.size
      }

      return a.name.localeCompare(b.name)
    })

    for (const city of orderedCities) {
      const { x, y } = latLngToWorld(city)
      const markerRadius = getCityMarkerStyle(city).radius
      const overlapsExisting = kept.some(other => {
        const dx = other.x - x
        const dy = other.y - y
        return Math.hypot(dx, dy) < other.markerRadius + markerRadius + 1
      })

      if (!overlapsExisting) {
        kept.push({ ...city, markerRadius, x, y })
      }
    }

    return kept.sort((a, b) => {
      const priorityDifference = getCityMarkerPriority(a.id) - getCityMarkerPriority(b.id)
      if (priorityDifference !== 0) {
        return priorityDifference
      }

      if (a.size !== b.size) {
        return a.size - b.size
      }

      return a.name.localeCompare(b.name)
    })
  }, [
    expandedCityIds,
    game.cities,
    showCitySizeBubbles,
    activeOfferCityIdSet,
    allOwnedCityCardIdSet,
    currentPlayer,
    ownedCityCardIdSet,
    ownedCityPlayersByCityId,
    selectedCityIdSet,
    isSelectingCityCards,
  ])
  const labels = useMemo(
    () =>
    showCityNames
      ? computeLabels(
          visibleCities.map(city => {
            const labelRadius = getCityMarkerStyle(city).radius

            return {
              ...city,
              labelRadius,
              }
            }),
            zoomScale,
          )
        : [],
    [
      expandedCityIds,
      showCityNames,
      showCitySizeBubbles,
      visibleCities,
      zoomScale,
      activeOfferCityIdSet,
      allOwnedCityCardIdSet,
      ownedCityCardIdSet,
      selectedCityIdSet,
      isSelectingCityCards,
    ],
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
  const resolvedSelection = useMemo(
    () =>
      selectedRouteMode === null
        ? null
        : selectedRouteMode === "rail" && selectedRailSegmentPairs.length > 0
          ? resolveSegmentSelection(game, selectedRailSegmentPairs, selectedRouteMode)
          : resolveRouteSelection(
              game,
              getEffectiveClaimCityIds(game, selectedRouteMode, selectedCityIds, currentPlayer.id),
              selectedRouteMode,
            ),
    [currentPlayer.id, game, selectedCityIds, selectedRailSegmentPairs, selectedRouteMode],
  )
  const selectedSegmentPairs = useMemo(
    () =>
      selectedRouteMode === null
        ? []
        : selectedRouteMode === "rail" && selectedRailSegmentPairs.length > 0
          ? selectedRailSegmentPairs
          : getClaimSegmentPairs(game, selectedRouteMode, selectedCityIds, currentPlayer.id),
    [currentPlayer.id, game, selectedCityIds, selectedRailSegmentPairs, selectedRouteMode],
  )
  const selectedCities = useMemo(
    () =>
      (resolvedSelection?.ok ? resolvedSelection.cityIds : selectedCityIds)
        .map(cityId => cityMap[cityId])
        .filter((city): city is GameState["cities"][number] => city !== undefined),
    [cityMap, resolvedSelection, selectedCityIds],
  )
  const currentPlayerOwnedVehicleCards = useMemo(
    () =>
      (currentPlayer?.ownedVehicleCardIds ?? [])
        .map(cardId => vehicleCardMap[cardId])
        .filter((card): card is VehicleCard => card !== undefined)
        .sort((cardA, cardB) => cardA.number - cardB.number),
    [currentPlayer, vehicleCardMap],
  )
  const currentPlayerOwnedVehicleCountsByCardId = useMemo(
    () => getOwnedVehicleCountsByCardId(currentPlayer),
    [currentPlayer],
  )
  const currentPlayerOwnedModes = useMemo(
    () => new Set(currentPlayerOwnedVehicleCards.map(card => getModeForVehicleType(card.type))),
    [currentPlayerOwnedVehicleCards],
  )
  const cityDecksByRegion = useMemo(
    () =>
      CITY_DECK_REGION_LIST.map(region => ({
        region,
        remainingCount: game.cityDeckCardIdsByRegion[region].length,
      })),
    [game.cityDeckCardIdsByRegion],
  )
  const currentPlayerOwnedCityCards = useMemo(
    () =>
      (currentPlayer?.ownedCityCardIds ?? [])
        .filter(cityId => !(activeCityOffer?.cityIds ?? []).includes(cityId))
        .map(cityId => cityMap[cityId])
        .filter((city): city is GameState["cities"][number] => city !== undefined)
        .sort((cityA, cityB) => cityA.name.localeCompare(cityB.name)),
    [activeCityOffer, cityMap, currentPlayer],
  )

  const connectionOptions = useMemo(() => {
    if (selectedRouteMode === null) {
      return []
    }

    if (selectedRouteMode === "rail" && selectedRailSegmentPairs.length > 0) {
      const resolvedRailSelection = resolveSegmentSelection(game, selectedRailSegmentPairs, "rail")

      return [
        {
          mode: "rail" as const,
          valid: resolvedRailSelection.ok && currentPlayerOwnedModes.has("rail"),
          reason: resolvedRailSelection.ok
            ? currentPlayerOwnedModes.has("rail")
              ? undefined
              : "Buy a train vehicle card first."
            : resolvedRailSelection.error,
        },
      ]
    }

    if (selectedCityIds.length < 1) {
      return []
    }

    return getConnectionOptions(game, selectedCityIds, currentPlayer.id)
  }, [currentPlayer.id, currentPlayerOwnedModes, game, selectedCityIds, selectedRailSegmentPairs, selectedRouteMode])
  const segmentMetadataByKey = useMemo(
    () => Object.fromEntries(adjacentRouteSegments.map(segment => [segment.id, segment])),
    [adjacentRouteSegments],
  )
  const claimableRailSegmentKeys = useMemo(() => {
    const ownedCityIds = new Set(currentPlayer?.ownedCityCardIds ?? [])

    return new Set(
      adjacentRouteSegments
        .filter(
          segment =>
            segment.allowRail &&
            ownedCityIds.has(segment.cityA.id) &&
            ownedCityIds.has(segment.cityB.id) &&
            !game.routes.some(
              route =>
                getSegmentKey(route.cityA, route.cityB) === segment.id,
            ),
        )
        .map(segment => segment.id),
    )
  }, [adjacentRouteSegments, currentPlayer, game.routes])
  const claimableRailSegments = useMemo(
    () =>
      adjacentRouteSegments
        .filter(segment => claimableRailSegmentKeys.has(segment.id))
        .sort((segmentA, segmentB) => {
          const labelA = `${segmentA.cityA.name} ${segmentA.cityB.name}`
          const labelB = `${segmentB.cityA.name} ${segmentB.cityB.name}`
          return labelA.localeCompare(labelB)
        }),
    [adjacentRouteSegments, claimableRailSegmentKeys],
  )
  const previewSegments = useMemo(
    () =>
      selectedSegmentPairs
        .map(([cityAId, cityBId]) => {
          const cityA = cityMap[cityAId]
          const cityB = cityMap[cityBId]

          if (!cityA || !cityB) {
            return null
          }

          return {
            cityA,
            cityB,
            curve: segmentMetadataByKey[getSegmentKey(cityAId, cityBId)]?.curve,
          }
        })
        .filter(
          (segment): segment is PreviewSegment => segment !== null,
        ),
    [cityMap, segmentMetadataByKey, selectedSegmentPairs],
  )
  const previewVisible = previewSegments.length >= 1

  const selectionSummary =
      selectedRouteMode === "rail" && selectedRailSegmentPairs.length > 0
      ? `Rail: ${selectedRailSegmentPairs
          .map(([cityAId, cityBId]) => `${cityMap[cityAId]?.name ?? cityAId} - ${cityMap[cityBId]?.name ?? cityBId}`)
          .join(", ")}`
      : selectedRouteMode
        ? `${MODE_LABELS[selectedRouteMode]}: ${selectedCities.map(city => city.name).join(", ") || "no cities selected"}`
        : activeCityOffer
          ? `Picked from ${activeCityOffer.region}`
          : "No route selected"

  const connectionBonusPreview = useMemo(
    () =>
      selectedCities.length >= 2
        ? calculateConnectionBonus(
            game,
            currentPlayer.id,
            selectedCities.map(city => city.id),
          )
        : null,
    [currentPlayer.id, game, selectedCities],
  )
  const routePreviewSummaries = useMemo(() => {
    if (selectedCities.length < 2) {
      return []
    }

    const routePairs = selectedSegmentPairs
      .map(([cityAId, cityBId]) => {
        const cityA = cityMap[cityAId]
        const cityB = cityMap[cityBId]

        if (!cityA || !cityB) {
          return null
        }

        return {
          cityA,
          cityB,
        }
      })
      .filter(
        (
          pair,
        ): pair is {
          cityA: GameState["cities"][number]
          cityB: GameState["cities"][number]
        } => pair !== null,
      )
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
      const claimCost = Math.ceil(
        calculateClaimRouteCost(game, {
          cityIds: selectedCities.map(city => city.id),
          segmentPairs: option.mode === "rail" && selectedSegmentPairs.length > 0 ? selectedSegmentPairs : undefined,
          mode: option.mode,
        }, currentPlayer.id),
      )
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
      const ownedFleetSize =
        previewCard === null ? 0 : Math.max(0, currentPlayerOwnedVehicleCountsByCardId[previewCard.id] ?? 0)
      const demandFleetSize =
        previewCard === null
          ? 0
          : getFleetSizeForDemand(
              game,
              selectedCities.map(city => city.id),
              previewCard,
              maxTripsPerPeriod,
            )
      const tripFuelBurnReal =
        routeSummaries.length === 0
          ? 0
          : routeSummaries.reduce((total, summary) => total + summary.tripFuelBurn, 0)
      const fuelResource = routeSummaries[0]?.fuelResource ?? null
      const fuelCostPerTrip =
        fuelResource === null
          ? 0
          : tripFuelBurnReal *
            game.operatingConfig.fuelPricePerRealUnit[fuelResource] *
            getFuelPriceMultiplier(game, fuelResource)
      const fixedMaintenanceCostPerVehicle =
        previewCard === null ? 0 : getMaintenanceCostPerWeekPerVehicle(game, previewCard.type)
      const crewCostPerTrip =
        previewCard === null || totalTripDurationHours <= 0
          ? 0
          : getCrewCostForTrips(game, previewCard.type, totalTripDurationHours, 1)
      const balanceAdjustmentPerTrip =
        previewCard === null
          ? 0
          : routePairs.reduce(
              (total, pair) =>
                total +
                getBalanceAdjustmentPerTrip(game, {
                  id: `preview:${option.mode}:${pair.cityA.id}:${pair.cityB.id}`,
                  cityA: pair.cityA.id,
                  cityB: pair.cityB.id,
                  mode: option.mode,
                }),
              0,
            )
      const plannedFleetSize =
        previewCard === null || getDemandCapacityForCityIds(game, selectedCities.map(city => city.id)) <= 0
          ? 0
          : getAffordableFleetSize({
              targetFleetSize: Math.min(demandFleetSize, ownedFleetSize),
              availableBudget: Math.max(0, (currentPlayer?.money ?? 0) - claimCost),
              fixedCostPerVehicle: fixedMaintenanceCostPerVehicle,
              variableTripCost: balanceAdjustmentPerTrip + fuelCostPerTrip + crewCostPerTrip,
              maxTrips: maxTripsPerPeriod,
            })
      const demandCapacity =
        previewCard === null ? 0 : getDemandCapacityForCityIds(game, selectedCities.map(city => city.id))
      const maxTripsByTime = maxTripsPerPeriod * plannedFleetSize
      const maxUsefulTripsByDemand =
        previewCard === null || previewCard.totalPassengerCapacity <= 0
          ? 0
          : Math.ceil(demandCapacity / Math.max(previewCard.totalPassengerCapacity, 1))
      const fixedMaintenanceCost =
        fixedMaintenanceCostPerVehicle * plannedFleetSize
      const maxTripsByBudget =
        plannedFleetSize <= 0
          ? 0
          : balanceAdjustmentPerTrip + fuelCostPerTrip + crewCostPerTrip <= 0
            ? maxTripsByTime
            : Math.floor(
                (Math.max(0, (currentPlayer?.money ?? 0) - claimCost - fixedMaintenanceCost) + 1e-9) /
                  Math.max(balanceAdjustmentPerTrip + fuelCostPerTrip + crewCostPerTrip, 0.000001),
              )
      const selectedTrips = Math.max(
        0,
        Math.min(maxTripsByTime, maxTripsByBudget, maxUsefulTripsByDemand),
      )
      const passengersPerTrip =
        previewCard === null
          ? 0
          : getPassengersPerTripForCityIds(
              game,
              selectedCities.map(city => city.id),
              previewCard,
              plannedFleetSize,
            )
      const passengersPerPeriod =
        previewCard === null
          ? 0
          : Math.min(selectedTrips * previewCard.totalPassengerCapacity, demandCapacity)
      const revenuePerPeriod =
        totalDistanceMiles *
        passengersPerPeriod *
        game.operatingConfig.revenuePerPassengerMile[option.mode]
      const fuelCostPerPeriod =
        fuelResource === null
          ? 0
          : fuelCostPerTrip * selectedTrips
      const crewCostPerPeriod = crewCostPerTrip * selectedTrips
      const balanceAdjustmentPerPeriod = selectedTrips * balanceAdjustmentPerTrip
      const operatingCostPerPeriod =
        crewCostPerPeriod + fixedMaintenanceCost + balanceAdjustmentPerPeriod + fuelCostPerPeriod
      return {
        mode: option.mode,
        valid: option.valid,
        reason: option.reason,
        previewCard,
        totalDistanceMiles,
        combinedDemand,
        claimCost,
        connectionBonus: connectionBonusPreview?.totalBonus ?? 0,
        newCityCount: connectionBonusPreview?.newlyConnectedCityIds.length ?? 0,
        demandFleetSize,
        plannedFleetSize,
        passengersPerTrip,
        maxTripsPerPeriod: selectedTrips,
        passengersPerPeriod,
        revenuePerPeriod,
        crewCostPerPeriod,
        maintenanceCostPerPeriod: fixedMaintenanceCost,
        fuelCostPerPeriod,
        balanceCostPerPeriod: balanceAdjustmentPerPeriod,
        operatingCostPerPeriod,
        netPerPeriod: revenuePerPeriod - operatingCostPerPeriod,
      }
    })
  }, [
    cityMap,
    connectionBonusPreview,
    connectionOptions,
    currentPlayer,
    currentPlayerOwnedVehicleCards,
    currentPlayerOwnedVehicleCountsByCardId,
    game,
    selectedCities,
    selectedSegmentPairs,
  ])
  const selectedClaimPreview =
    selectedRouteMode === null
      ? null
      : routePreviewSummaries.find(summary => summary.mode === selectedRouteMode) ?? null
  const canAffordSelectedClaim =
    selectedClaimPreview === null
      ? false
      : selectedClaimPreview.claimCost <= (currentPlayer?.money ?? 0)
  const canManageCurrentCityOffer = isSelectingCityCards &&
    (!game.activeCityOffer || game.activeCityOffer.playerId === activeViewingPlayerId)
  const canConfirmSelectedClaim =
    Boolean(selectedClaimPreview?.valid) &&
    canAffordSelectedClaim
  const optionMessage =
    selectedRouteMode !== null && selectedClaimPreview && !canConfirmSelectedClaim
      ? !selectedClaimPreview.valid
        ? selectedClaimPreview.reason ?? "That route is not available."
        : `That selection costs ${formatCurrency(selectedClaimPreview.claimCost)}, but you only have ${formatCurrency(currentPlayer?.money ?? 0)}.`
      : ""
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
  const playerConfirmedBureaucracy = hasPlayerCompletedBureaucracy(game, activeViewingPlayerId)
  const completedPeriod = game.isGameOver
    ? game.currentWeek
    : playerConfirmedBureaucracy
      ? game.currentWeek
      : game.currentWeek - 1
  const isPeriodSummaryVisible = !suppressPeriodSummary && isPeriodSummaryOpen && completedPeriod >= 1
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
      const ownedRoutes = getPlayerOwnedNetworkRoutes(game, player.id)
      const connectedCities = getConnectedCityIds(game, player.id)
        .map(cityId => cityMap[cityId]?.name ?? cityId)
        .sort((cityA, cityB) => cityA.localeCompare(cityB))

      const connectedRoutes = ownedRoutes.map(route => {
        const cityA = cityMap[route.cityA]?.name ?? route.cityA
        const cityB = cityMap[route.cityB]?.name ?? route.cityB

        return `${cityA} - ${cityB} (${route.mode === "rail" ? `${getRailTraction(route) === "electric" ? "Electric rail" : "Rail"}` : MODE_LABELS[route.mode]})`
      })
      const weeklyNet = player.weeklyPayout - player.operatingCosts
      const bureaucracySummary = bureaucracySummaries.find(s => s.player.id === player.id)
      const projectedMoney = game.currentPhase === "bureaucracy" && bureaucracySummary
        ? player.money + bureaucracySummary.netRevenue
        : player.money
      const ownedVehicleCards = player.ownedVehicleCardIds
        .map(cardId => vehicleCardMap[cardId])
        .filter((card): card is VehicleCard => card !== undefined)
      const ownedVehicleCardCounts = {
        bus: ownedVehicleCards.filter(card => card.type === "bus").length,
        train: ownedVehicleCards.filter(card => card.type === "train").length,
        air: ownedVehicleCards.filter(card => card.type === "air").length,
      }
      const ownedVehicleCounts = {
        bus: player.inventory.vehicles.buses,
        train: player.inventory.vehicles.trains,
        air: player.inventory.vehicles.planes,
      }
      const ownedRouteCount = ownedRoutes.length
      return {
        player,
        connectedCities,
        connectedRoutes,
        ownedVehicleCards,
        ownedVehicleCardCounts,
        ownedVehicleCounts,
        ownedRouteCount,
        weeklyNet,
        projectedMoney,
      }
    })
  }, [cityMap, game, vehicleCardMap, bureaucracySummaries])
  const gameOverSummaryPlayers = useMemo(
    () =>
      victoryStandings.map(standing => {
        const summary = playerSummaries.find(candidate => candidate.player.id === standing.player.id)
        const bureaucracySummary = bureaucracySummaries.find(
          candidate => candidate.player.id === standing.player.id,
        )
        const periodHistory = standing.player.periodHistory ?? []
        const latestPeriodHistoryEntry = periodHistory[periodHistory.length - 1]
        const passengersByMode = periodHistory.reduce((totals, entry) => {
          totals.bus += entry.passengersServedByMode?.bus ?? 0
          totals.rail += entry.passengersServedByMode?.rail ?? 0
          totals.air += entry.passengersServedByMode?.air ?? 0
          return totals
        }, createEmptyRouteModeBreakdown())
        const podCountByMode =
          latestPeriodHistoryEntry?.podCountByMode ??
          createEmptyRouteModeBreakdown()

        return {
          standing,
          summary,
          finalPodLabels:
            bureaucracySummary?.routePlans
              .filter(
                plan =>
                  !plan.isDisconnected &&
                  plan.vehicleCard !== null &&
                  plan.selectedCityIds.length >= 2 &&
                  plan.routes.length > 0,
              )
              .map(plan => `${plan.serviceLabel} (${MODE_LABELS[plan.route.mode]})`) ?? [],
          periodHistory,
          passengersByMode,
          podCountByMode,
        }
      }),
    [bureaucracySummaries, playerSummaries, victoryStandings],
  )
  const currentPlayerId = currentPlayer?.id
  const otherPlayerNetworkSummaries = useMemo(
    () =>
      playerSummaries
        .filter(({ player }) => player.id !== currentPlayerId)
        .map(summary => ({
          ...summary,
          ownedCityCards: (summary.player.ownedCityCardIds ?? [])
            .map(cityId => cityMap[cityId]?.name ?? cityId)
            .sort((cityA, cityB) => cityA.localeCompare(cityB)),
        })),
    [cityMap, currentPlayerId, playerSummaries],
  )
  const displayedMapRoutes = useMemo(
    () => {
      const routesByKey = new Map<
        string,
        {
          id: string
          route: GameState["routes"][number]
          color: string
          opacity: number
        }
      >()
      const addRoute = (
        key: string,
        route: GameState["routes"][number],
        color: string,
        opacity: number,
      ) => {
        if (!routesByKey.has(key)) {
          routesByKey.set(key, {
            id: key,
            route,
            color,
            opacity,
          })
        }
      }

      // Helper: for a player, get the set of air route IDs that have a plane assigned.
      // Uses game.bureaucracyVehicleCardIdsByRouteId (explicit) first, then fills
      // remaining slots with auto-assignment up to the number of owned planes.
      function getAirRouteIdsWithPlane(player: GameState["players"][number]) {
        const ownedPlaneCount = player.ownedVehicleCardIds.filter(
          cardId => game.vehicleCatalog.find(c => c.id === cardId)?.type === "air",
        ).length
        if (ownedPlaneCount === 0) return new Set<string>()

        const playerAirRoutes = game.routes
          .filter(r => r.ownerId === player.id && r.mode === "air")
          .sort((a, b) => a.id.localeCompare(b.id))

        const result = new Set<string>()
        // First pass: explicit assignments
        for (const route of playerAirRoutes) {
          const slotId = `service:${route.id}:slot:0`
          if (game.bureaucracyVehicleCardIdsByRouteId[slotId] != null) {
            result.add(route.id)
          }
        }
        // Second pass: fill remaining slots up to plane count (auto-assignment order)
        if (result.size < ownedPlaneCount) {
          for (const route of playerAirRoutes) {
            if (result.size >= ownedPlaneCount) break
            result.add(route.id)
          }
        }
        return result
      }

      if (viewerPhase === "add-city") {
        for (const player of game.players) {
          const airRouteIdsWithPlane = getAirRouteIdsWithPlane(player)
          const summary = bureaucracySummaries.find(s => s.player.id === player.id)
          if (!summary) continue
          for (const plan of summary.routePlans) {
            if (plan.isDisconnected || plan.selectedCityIds.length < 2 || plan.routes.length === 0) {
              continue
            }
            for (const route of plan.routes) {
              if (route.mode === "air" && !airRouteIdsWithPlane.has(route.id)) continue
              addRoute(`${player.id}:${route.id}`, route, player.color, 0.95)
            }
          }
        }

        return [...routesByKey.values()]
      }

      if (viewerPhase === "operations") {
        for (const summary of bureaucracySummaries) {
          const isCurrentPlayer = summary.player.id === currentPlayer.id
          const airRouteIdsWithPlane = getAirRouteIdsWithPlane(summary.player)

          for (const plan of summary.routePlans) {
            if (plan.isDisconnected || plan.selectedCityIds.length < 2 || plan.routes.length === 0) {
              continue
            }
            for (const route of plan.routes) {
              if (route.mode === "air" && !airRouteIdsWithPlane.has(route.id)) continue
              // Show current player's routes at full opacity; others dimmed
              addRoute(`${summary.player.id}:${route.id}`, route, summary.player.color, isCurrentPlayer ? 1 : 0.35)
            }
          }
        }

        return [...routesByKey.values()]
      }

      if (!game.isGameOver) {
        for (const player of game.players) {
          const airRouteIdsWithPlane = getAirRouteIdsWithPlane(player)
          for (const route of getPlayerOwnedNetworkRoutes(game, player.id)) {
            if (route.mode === "air" && !airRouteIdsWithPlane.has(route.id)) {
              continue
            }
            addRoute(
              `${player.id}:${route.id}`,
              route,
              player.color,
              MODE_LINE_STYLES[route.mode].opacity ?? 1,
            )
          }
        }

        return [...routesByKey.values()]
      }

      for (const summary of bureaucracySummaries) {
        for (const plan of summary.routePlans) {
          if (
            plan.isDisconnected ||
            plan.vehicleCard === null ||
            plan.selectedCityIds.length < 2 ||
            plan.routes.length === 0
          ) {
            continue
          }

          for (const route of plan.routes) {
            addRoute(`${summary.player.id}:${route.id}`, route, summary.player.color, 1)
          }
        }
      }

      return [...routesByKey.values()]
    },
    [bureaucracySummaries, currentPlayer.id, game, viewerPhase],
  )
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
        }
      })
    }, [game, game.resourceMarket])
  const visibleVehicleCards = useMemo(() => {
    return getVisibleVehicleMarketCardIds(game)
      .map(cardId => vehicleCardMap[cardId])
      .filter((card): card is VehicleCard => card !== undefined)
  }, [game, vehicleCardMap])
  const vehicleMarketCountsByType = useMemo(
    () => ({
      bus: game.vehicleMarketCardIds.reduce(
        (total, cardId) => total + (vehicleCardMap[cardId]?.type === "bus" ? 1 : 0),
        0,
      ),
      train: game.vehicleMarketCardIds.reduce(
        (total, cardId) => total + (vehicleCardMap[cardId]?.type === "train" ? 1 : 0),
        0,
      ),
      air: game.vehicleMarketCardIds.reduce(
        (total, cardId) => total + (vehicleCardMap[cardId]?.type === "air" ? 1 : 0),
        0,
      ),
    }),
    [game.vehicleMarketCardIds, vehicleCardMap],
  )
  const remainingVehicleCardCount = Math.max(
    0,
    game.vehicleMarketCardIds.length - visibleVehicleCards.length,
  )
  const totalCityDeckCount = useMemo(
    () => cityDecksByRegion.reduce((total, { remainingCount }) => total + remainingCount, 0),
    [cityDecksByRegion],
  )
  const remainingChanceDeckCount = game.chanceDeckCardIds.length
  const currentPhaseProgressIndex = getTopBarPhaseIndex(game.currentPhase)
  const currentPlayerIndex = game.players.findIndex(
    player => player.id === game.currentPlayerId,
  )
  const currentPlayerBureaucracySummary = bureaucracySummaries.find(
    summary => summary.player.id === currentPlayer.id,
  )
  const currentPlayerActiveBureaucracyPlans = useMemo(
    () =>
      currentPlayerBureaucracySummary?.routePlans.filter(plan => !plan.isDisconnected) ?? [],
    [currentPlayerBureaucracySummary],
  )
  const currentPlayerBureaucracyPlansByMode = useMemo(() => {
    if (!currentPlayerBureaucracySummary) {
      return []
    }

    return BUREAUCRACY_MODE_ORDER.map(mode => ({
      mode,
      plans: currentPlayerActiveBureaucracyPlans
        .filter(plan => plan.route.mode === mode)
        .sort((planA, planB) => {
          if (planB.passengersServed !== planA.passengersServed) {
            return planB.passengersServed - planA.passengersServed
          }

          if (planB.movedCubes !== planA.movedCubes) {
            return planB.movedCubes - planA.movedCubes
          }

          return planA.serviceLabel.localeCompare(planB.serviceLabel)
        }),
    }))
  }, [currentPlayerActiveBureaucracyPlans, currentPlayerBureaucracySummary])
  const currentPlayerAggregatedCityPairings = useMemo(() => {
    type PlanModeStats = { planId: string; mode: RouteMode; passengers: number; farePerPassenger: number; payout: number }
    type AggPairing = {
      key: string
      originCityId: string
      originCityName: string
      destinationCityId: string
      destinationCityName: string
      cubes: number
      finalDestinationCubes: number
      passengers: number
      pathLabels: string[]
      planModeStats: PlanModeStats[]
      totalDemand: number
      planIds: string[]
    }

    // Build total demand per origin→dest from intent snapshot
    const intentDemand = new Map<string, number>()
    if (currentPlayerBureaucracySummary) {
      for (const entry of currentPlayerBureaucracySummary.outboundIntentByCity) {
        for (const dest of entry.destinations) {
          const key = `${entry.cityId}:${dest.destCityId}`
          intentDemand.set(key, (intentDemand.get(key) ?? 0) + dest.cubeCount)
        }
      }
    }

    const pairingsMap = new Map<string, AggPairing>()
    for (const plan of currentPlayerActiveBureaucracyPlans) {
      for (const entry of plan.simplifiedLedgerEntries) {
        const key = `${entry.originCityId}:${entry.destinationCityId}`
        const existing = pairingsMap.get(key)
        if (existing) {
          existing.cubes += entry.cubeCount
          existing.finalDestinationCubes += entry.finalDestinationCubeCount
          existing.passengers += entry.passengers
          const epms = existing.planModeStats.find(s => s.planId === plan.id && s.mode === entry.mode)
          if (epms) {
            epms.passengers += entry.passengers
            epms.payout += entry.payout
          } else {
            existing.planModeStats.push({ planId: plan.id, mode: entry.mode, passengers: entry.passengers, farePerPassenger: entry.farePerPassenger, payout: entry.payout })
          }
          for (const label of entry.pathLabels) {
            if (!existing.pathLabels.includes(label)) existing.pathLabels.push(label)
          }
          if (!existing.planIds.includes(plan.id)) existing.planIds.push(plan.id)
        } else {
          pairingsMap.set(key, {
            key,
            originCityId: entry.originCityId,
            originCityName: entry.originCityName,
            destinationCityId: entry.destinationCityId,
            destinationCityName: entry.destinationCityName,
            cubes: entry.cubeCount,
            finalDestinationCubes: entry.finalDestinationCubeCount,
            passengers: entry.passengers,
            pathLabels: [...entry.pathLabels],
            planModeStats: [{ planId: plan.id, mode: entry.mode, passengers: entry.passengers, farePerPassenger: entry.farePerPassenger, payout: entry.payout }],
            totalDemand: intentDemand.get(key) ?? 0,
            planIds: [plan.id],
          })
        }
      }
    }
    return [...pairingsMap.values()].sort((a, b) => b.passengers - a.passengers)
  }, [currentPlayerActiveBureaucracyPlans, currentPlayerBureaucracySummary])
  const currentPlayerCombinedDemandFill = useMemo(() => {
    if (!currentPlayerBureaucracySummary) {
      return []
    }

    const filledByCityId = new Map<string, number>()
    // Segment departures per origin city (includes transit cubes — used for cap logic only)
    const segmentDeparturesByCityId = new Map<string, number>()

    currentPlayerBureaucracySummary.routePlans.forEach(plan => {
      plan.simplifiedCityStatuses.forEach(cityStatus => {
        filledByCityId.set(
          cityStatus.cityId,
          (filledByCityId.get(cityStatus.cityId) ?? 0) + cityStatus.filledCubes,
        )
      })
      plan.simplifiedLedgerEntries.forEach(entry => {
        segmentDeparturesByCityId.set(
          entry.originCityId,
          (segmentDeparturesByCityId.get(entry.originCityId) ?? 0) + entry.cubeCount,
        )
      })
    })

    // Originating cubes per city from intent snapshot (pre-simulation, excludes transit)
    const originatingCubesByCityId = new Map<string, number>()
    for (const entry of currentPlayerBureaucracySummary.outboundIntentByCity) {
      originatingCubesByCityId.set(
        entry.cityId,
        entry.destinations.reduce((s, d) => s + d.cubeCount, 0),
      )
    }

    return currentPlayerOwnedCityCards
      .map(city => {
        const originating = originatingCubesByCityId.get(city.id) ?? 0
        // Cap segment departures at originating — transit cubes can't inflate above local demand
        const movedOutboundCubes = Math.min(
          segmentDeparturesByCityId.get(city.id) ?? 0,
          originating,
        )
        return {
          city,
          outboundCubes: Math.max(0, getCityDemandSize(game, city)),
          inboundCubes: getCityDemandAbsorptionSize(game, city),
          filledCubes: filledByCityId.get(city.id) ?? 0,
          movedOutboundCubes,
        }
      })
      .sort((entryA, entryB) => {
        const sizeDifference = (entryB.city.size ?? 0) - (entryA.city.size ?? 0)
        if (sizeDifference !== 0) {
          return sizeDifference
        }

        return entryA.city.name.localeCompare(entryB.city.name)
      })
  }, [currentPlayerBureaucracySummary, currentPlayerOwnedCityCards, game])
  const currentPlayerPodGroups = useMemo(() => {
    if (!currentPlayerBureaucracySummary) {
      return []
    }

    const groups = new Map<
      string,
      {
        corridorId: string
        mode: RouteMode
        availableCityIds: string[]
        canAddSplitService: boolean
        plans: typeof currentPlayerBureaucracySummary.routePlans
      }
    >()

    currentPlayerBureaucracySummary.routePlans.forEach(plan => {
      const existingGroup = groups.get(plan.corridorId)

      if (existingGroup) {
        existingGroup.canAddSplitService =
          existingGroup.canAddSplitService || plan.canAddSplitService
        existingGroup.plans.push(plan)
        return
      }

      groups.set(plan.corridorId, {
        corridorId: plan.corridorId,
        mode: plan.route.mode,
        availableCityIds: plan.availableCityIds,
        canAddSplitService: plan.canAddSplitService,
        plans: [plan],
      })
    })

    return [...groups.values()]
      .map(group => ({
        ...group,
        plans: [...group.plans].sort((planA, planB) => planA.slotIndex - planB.slotIndex),
      }))
      .sort((groupA, groupB) =>
        `${groupA.mode}:${groupA.availableCityIds.join("|")}`.localeCompare(
          `${groupB.mode}:${groupB.availableCityIds.join("|")}`,
        ),
      )
  }, [currentPlayerBureaucracySummary])
  const currentPlayerPodPreviewLines = useMemo(() => {
    if (game.currentPhase !== "operations") {
      return []
    }

    return currentPlayerPodGroups.flatMap(group =>
      group.plans.flatMap((plan, planIndex) => {
        if (plan.isDisconnected || plan.selectedCityIds.length < 2) {
          return []
        }

        const selectedCityIdSet = new Set(plan.selectedCityIds)
        const segmentPairs =
          plan.route.mode === "air"
            ? [plan.selectedCityIds.slice(0, 2) as [string, string]]
            : plan.corridorSegmentPairs.filter(
                ([cityAId, cityBId]) =>
                  selectedCityIdSet.has(cityAId) && selectedCityIdSet.has(cityBId),
              )

        return segmentPairs.flatMap(([cityAId, cityBId]) => {
          const cityA = cityMap[cityAId]
          const cityB = cityMap[cityBId]

          if (!cityA || !cityB) {
            return []
          }

          return [
            {
              id: `${plan.id}:${cityAId}:${cityBId}`,
              cityA,
              cityB,
              color:
                plan.route.mode === "rail"
                  ? RAIL_POD_COLOR_PALETTE[planIndex % RAIL_POD_COLOR_PALETTE.length]
                  : plan.route.mode === "bus"
                    ? BUS_POD_COLOR_PALETTE[planIndex % BUS_POD_COLOR_PALETTE.length]
                    : POD_COLOR_PALETTE[planIndex % POD_COLOR_PALETTE.length],
              dasharray: plan.route.mode === "air" ? "10 8" : undefined,
              haloWidth: plan.route.mode === "rail" ? 16 : 12,
              lineWidth: plan.route.mode === "rail" ? 7 : 5,
              curve: segmentMetadataByKey[getSegmentKey(cityAId, cityBId)]?.curve,
            },
          ]
        })
      }),
    )
  }, [cityMap, currentPlayerPodGroups, game.currentPhase, segmentMetadataByKey])
  const currentPlayerAssignedRouteLabelsByVehicleCardId = useMemo(() => {
    const labelsByCardId: Record<string, string[]> = {}

    currentPlayerBureaucracySummary?.routePlans.forEach(plan => {
      if (!plan.vehicleCard) {
        return
      }

      labelsByCardId[plan.vehicleCard.id] ??= []
      labelsByCardId[plan.vehicleCard.id].push(plan.serviceLabel)
    })

    return labelsByCardId
  }, [currentPlayerBureaucracySummary])
  const currentPlayerVehicleDemandByCardId = useMemo(() => {
    const demandByCardId: Record<
      string,
      { selectedFleetSize: number; demandFleetSize: number }
    > = {}

    currentPlayerBureaucracySummary?.routePlans.forEach(plan => {
      if (!plan.vehicleCard) {
        return
      }

      const current = demandByCardId[plan.vehicleCard.id] ?? {
        selectedFleetSize: 0,
        demandFleetSize: 0,
      }

      current.selectedFleetSize += plan.selectedFleetSize
      current.demandFleetSize += plan.demandFleetSize

      demandByCardId[plan.vehicleCard.id] = current
    })

    return demandByCardId
  }, [currentPlayerBureaucracySummary])
  const invalidCurrentPlayerPodRouteIds = useMemo(
    () =>
      new Set(
        currentPlayerBureaucracySummary?.routePlans
          .filter(
            plan =>
              !plan.isDisconnected &&
              !isValidServicePodSelection(
                plan.selectedCityIds,
                plan.corridorSegmentPairs,
                { allowSingleCity: false },
              ),
          )
          .map(plan => plan.id) ?? [],
      ),
    [currentPlayerBureaucracySummary],
  )
  const activeCityOfferRegions = useMemo(() => {
    if (!activeCityOffer) {
      return []
    }

    return [...new Set(
      activeCityOffer.cityIds
        .map(cityId => getPrimaryCityDeckRegion(cityMap[cityId]?.region) ?? activeCityOffer.region),
    )]
  }, [activeCityOffer, cityMap])
  const nextPlayer = currentPlayerIndex === -1
    ? game.players[0]
    : game.players[(currentPlayerIndex + 1) % game.players.length]
  const pendingVehiclePurchaseCard =
    (pendingVehiclePurchaseCardId && vehicleCardMap[pendingVehiclePurchaseCardId]) ?? null
  const pendingVehiclePurchaseMaxQuantity = pendingVehiclePurchaseCard
    ? Math.max(
        1,
        Math.min(
          getVehiclePurchaseLimit(pendingVehiclePurchaseCard.type),
          Math.floor((currentPlayer?.money ?? 0) / pendingVehiclePurchaseCard.purchasePrice),
        ),
      )
    : 1
  const pendingVehiclePurchaseTotalCost = pendingVehiclePurchaseCard
    ? pendingVehiclePurchaseCard.purchasePrice * pendingVehiclePurchaseQuantity
    : 0
  const canConfirmPicks =
    canManageCurrentCityOffer &&
    (game.activeCityOffer?.keptCityIds.length ?? 0) === 2
  const currentPlayerVehicleTotals = currentPlayer
    ? [
        currentPlayer.inventory.vehicles.buses > 0
          ? `${currentPlayer.inventory.vehicles.buses} buses`
          : null,
        currentPlayer.inventory.vehicles.trains > 0
          ? `${currentPlayer.inventory.vehicles.trains} trains`
          : null,
        currentPlayer.inventory.vehicles.planes > 0
          ? `${currentPlayer.inventory.vehicles.planes} planes`
          : null,
      ]
        .filter((value): value is string => value !== null)
        .join(", ")
    : ""
  const areResizeHandlesVisible =
    !isResourceMarketOpen && !isBureaucracyOpen && !isEconomicsOpen && !isWikiOpen
  const canEditOperations = canPlayerEditOperations(game, activeViewingPlayerId)
  const [demandFillHoveredDest, setDemandFillHoveredDest] = useState<string | null>(null)
  const [demandFillSelectedDest, setDemandFillSelectedDest] = useState<string | null>(null)
  const [networkMapGridSizes, setNetworkMapGridSizes] = useState<Record<string, { cols: number; rows: number }>>({})
  const [debugMode, setDebugMode] = useState(false)
  const [debugLogEntries, setDebugLogEntries] = useState<ReturnType<typeof getDebugEntries>>([])
  const [debugLogOpen, setDebugLogOpen] = useState(false)
  const purchaseEquipmentPlayersRemaining = game.players.filter(player => player.phase === "purchase-equipment").length
  const addCityPlayersRemaining = game.players.filter(player => player.phase === "add-city").length
  const operationsPlayersRemaining = game.players.filter(player => player.phase === "operations").length
  const shouldAdvancePhase =
    (viewerPhase === "purchase-equipment" && canBuyVehiclesInPipeline && purchaseEquipmentPlayersRemaining <= 1) ||
    (canManageCurrentCityOffer && addCityPlayersRemaining <= 1) ||
    (canEditOperations && operationsPlayersRemaining <= 1) ||
    (game.currentPhase === "bureaucracy" && (game.bureaucracyReadyPlayerIds.length + 1 >= game.players.length))
  const hasInvalidOperationsPods =
    canEditOperations && invalidCurrentPlayerPodRouteIds.size > 0
  const hasPendingOperationsRouteSelection =
    canEditOperations &&
    ((selectedRouteMode !== null && selectedCityIds.length >= 2) || selectedRailSegmentKeys.length > 0)
  const unassignedVehicleCardCount = canEditOperations
    ? Math.max(0, currentPlayerOwnedVehicleCards.length - currentPlayerActiveBureaucracyPlans.length)
    : 0
  const isAdvanceBlocked =
    (canManageCurrentCityOffer && (game.activeCityOffer?.keptCityIds.length ?? 0) !== 2) ||
    hasPendingOperationsRouteSelection ||
    hasInvalidOperationsPods
  const advanceTurnLabel = game.isGameOver
    ? "Game over"
    : shouldAdvancePhase
      ? "Next phase"
      : "Next player"

  function renderOperationsPodEditor(
    groups = currentPlayerPodGroups,
    options?: { emptyMessage?: string },
  ) {
    if (!canEditOperations) {
      return null
    }

    if (groups.length === 0) {
      return (
        <div
          style={{
            border: "1px solid #e1e6df",
            borderRadius: 10,
            padding: 10,
            background: "#fafcf9",
            display: "grid",
            gap: 4,
          }}
        >
          <strong>Route editor</strong>
          <div style={{ color: "#56635a", fontSize: 12 }}>
            {options?.emptyMessage ?? "No editable routes are available in this section yet."}
          </div>
        </div>
      )
    }

    return (
      <div
        style={{
          border: "1px solid #e1e6df",
          borderRadius: 10,
          padding: 10,
          background: "#ffffff",
          display: "grid",
          gap: 10,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <strong>Route editor</strong>
          <div style={{ color: "#56635a", fontSize: 12 }}>
            Split a corridor into smaller routes, drag cities to copy them into another pod, or use disconnected/× to remove a city from just one pod.
          </div>
        </div>
        {hasInvalidOperationsPods && (
          <div
            style={{
              border: "1px solid #e7b4b4",
              borderRadius: 10,
              padding: "8px 10px",
              background: "#fff5f5",
              color: "#9b1c1c",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Fix the red routes before leaving Operations.
          </div>
        )}
        {unassignedVehicleCardCount > 0 && (
          <div
            style={{
              border: "1px solid #d7c97a",
              borderRadius: 10,
              padding: "8px 10px",
              background: "#fffbea",
              color: "#7a6200",
              fontSize: 12,
              fontWeight: 600,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span>⚠️</span>
            <span>
              {unassignedVehicleCardCount === 1
                ? "1 vehicle card unassigned — add a new pod to put it to work."
                : `${unassignedVehicleCardCount} vehicle cards unassigned — add new pods to put them to work.`}
            </span>
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
          {groups.map(group => {
            const disconnectedPlan =
              group.plans.find(plan => plan.isDisconnected) ?? null

            return (
            <div
              key={`pod-group-${group.corridorId}`}
              style={{
                border: "1px solid #e7ece5",
                borderRadius: 10,
                padding: 10,
                boxSizing: "border-box",
                display: "grid",
                gap: 8,
                background: "#fafcf9",
                flex: "1 1 calc((100% - 10px) / 2)",
                maxWidth: "calc((100% - 10px) / 2)",
                minWidth: 280,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 12, color: "#324236" }}>
                  <strong>{MODE_LABELS[group.mode]} network</strong>
                  {" • "}
                  {group.availableCityIds
                    .map(cityId => cityMap[cityId]?.name ?? cityId)
                    .join(", ")}
                </div>
                {group.canAddSplitService && (
                  <button
                    type="button"
                    onClick={() => handleAddSplitService(group.corridorId)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      border: "1px solid #c7d0c4",
                      background: "#ffffff",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    New route
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
                {group.plans.map(plan => {
                  const isInvalidPod = invalidCurrentPlayerPodRouteIds.has(plan.id)
                  const routeSelectColors = getRouteSelectColors(plan.route.mode)
                  const dropError =
                    draggedPodCity && draggedPodCity.corridorId === group.corridorId
                      ? getPodMoveError(group.plans, draggedPodCity.cityId, plan.id)
                      : null
                  const canDrop =
                    draggedPodCity !== null &&
                    draggedPodCity.corridorId === group.corridorId &&
                    dropError === null
                  const availableVehicleCards = currentPlayerOwnedVehicleCards.filter(
                    card => card.type === getVehicleTypeForMode(plan.route.mode),
                  )

                  return (
                    <div
                      key={`pod-editor-slot-${plan.id}`}
                      onDragOver={event => {
                        if (canDrop) {
                          event.preventDefault()
                        }
                      }}
                      onDrop={event => {
                        event.preventDefault()

                        if (!draggedPodCity || draggedPodCity.corridorId !== group.corridorId) {
                          return
                        }

                        if (dropError) {
                          setStatusMessage(dropError)
                          setDraggedPodCity(null)
                          return
                        }

                        handleMoveServiceCity(
                          draggedPodCity.corridorId,
                          draggedPodCity.cityId,
                          plan.id,
                          draggedPodCity.routeId,
                        )
                        setDraggedPodCity(null)
                      }}
                      title={
                        dropError ??
                        (isInvalidPod
                          ? "Illegal route: service routes need 2+ connected cities."
                          : undefined)
                      }
                      style={{
                        minWidth: 180,
                        minHeight: 72,
                        border: `1px dashed ${
                          draggedPodCity?.corridorId === group.corridorId
                            ? canDrop
                              ? "#86a889"
                              : "#d2a4a4"
                            : isInvalidPod
                              ? "#c53030"
                              : "#b9c5ba"
                        }`,
                        borderRadius: 10,
                        padding: 8,
                        background:
                          draggedPodCity?.corridorId === group.corridorId
                            ? canDrop
                              ? "#f7faf6"
                              : "#fff7f7"
                            : isInvalidPod
                              ? "#fff5f5"
                              : "#ffffff",
                        display: "grid",
                        alignContent: "start",
                        gap: 6,
                        flex: "0 0 180px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        {plan.isDisconnected ? (
                          <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700 }}>
                            DISCONNECTED
                          </div>
                        ) : (
                          <>
                            <select
                              value={plan.vehicleCard?.id ?? ""}
                              onChange={event =>
                                handleSetBureaucracyVehicleCard(
                                  plan.id,
                                  event.target.value === "" ? null : event.target.value,
                                )
                              }
                              disabled={!canEditOperations}
                              style={{
                                minWidth: 0,
                                width: 0,
                                maxWidth: "100%",
                                flex: "1 1 0",
                                padding: "6px 8px",
                                borderRadius: 8,
                                border: `1px solid ${routeSelectColors.border}`,
                                background: routeSelectColors.background,
                                color: routeSelectColors.color,
                                fontSize: 12,
                              }}
                            >
                              <option value="">No vehicle assigned</option>
                              {availableVehicleCards.map(card => (
                                <option key={card.id} value={card.id}>
                                  #{card.number} {card.name} ({currentPlayerOwnedVehicleCountsByCardId[card.id] ?? 0})
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() =>
                                handleDeleteServicePod(
                                  group.corridorId,
                                  plan.id,
                                  plan.selectedCityIds,
                                )
                              }
                              title="Delete this route; any city not used by another pod will fall into disconnected"
                              style={{
                                border: "none",
                                background: "transparent",
                                color: "#9b1c1c",
                                cursor: "pointer",
                                fontSize: 12,
                                fontWeight: 700,
                                lineHeight: 1,
                                padding: 0,
                                flexShrink: 0,
                              }}
                            >
                              ×
                            </button>
                          </>
                        )}
                      </div>
                      {isInvalidPod && (
                        <div style={{ color: "#9b1c1c", fontSize: 11, fontWeight: 700 }}>
                          Illegal route
                        </div>
                      )}
                      {plan.selectedCityIds.length === 0 ? (
                        <div style={{ color: "#8b948d", fontSize: 12 }}>
                          {plan.isDisconnected
                            ? "Click × or drop city here"
                            : "Drop city here"}
                        </div>
                      ) : (
                        <>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {plan.selectedCityIds.map(cityId => (
                              <div
                                key={`pod-editor-city-${plan.id}-${cityId}`}
                                draggable
                                onDragStart={() =>
                                  setDraggedPodCity({
                                    corridorId: group.corridorId,
                                    routeId: plan.id,
                                    cityId,
                                  })
                                }
                                onDragEnd={() => setDraggedPodCity(null)}
                                style={{
                                  border: "1px solid #d8dfd5",
                                  borderRadius: 999,
                                  padding: "4px 6px 4px 8px",
                                  background: "#ffffff",
                                  color: "#324236",
                                  fontSize: 12,
                                  cursor: "grab",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 6,
                                }}
                              >
                                <span>
                                  {(cityMap[cityId]?.name ?? cityId) +
                                    ` (${cityMap[cityId]?.size ?? "?"})`}
                                </span>
                                {!plan.isDisconnected && disconnectedPlan && (
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      handleMoveServiceCity(
                                        group.corridorId,
                                        cityId,
                                        disconnectedPlan.id,
                                        plan.id,
                                      )
                                    }}
                                    title="Remove this city from this route only"
                                    style={{
                                      border: "none",
                                      background: "transparent",
                                      color: "#9b1c1c",
                                      cursor: "pointer",
                                      fontSize: 12,
                                      fontWeight: 700,
                                      lineHeight: 1,
                                      padding: 0,
                                    }}
                                  >
                                    ×
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                          {plan.selectedCityIds.length >= 2 && plan.populationPerMile !== null && (
                            <div style={{ color: "#56635a", fontSize: 11, marginTop: 2 }}>
                              {Math.round(plan.populationPerMile).toLocaleString()} pax/mi
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
            )
          })}
        </div>
      </div>
    )
  }

  function getFuelInfoLabel(resource: PurchasableResource, units: number) {
    const realFuel = calculateRealFuelFromUnits(units, resource, game)

    return `${formatDecimal(units)} ${getResourceLabel(resource).toLowerCase()} unit${units === 1 ? "" : "s"} = ${formatDecimal(realFuel)} ${getRealFuelLabel(resource)}`
  }

  function resetSelection(message = getPhaseStatusMessage(game.currentPhase)) {
    setSelectedRouteMode(null)
    setSelectedDrawCityIds([])
    setSelectedOwnedCityIds([])
    setSelectedRailSegmentKeys([])
    setStatusMessage(message)
  }

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setSelectedRouteMode(null)
    setSelectedDrawCityIds([])
    setSelectedOwnedCityIds([])
    setSelectedRailSegmentKeys([])
    setPendingVehiclePurchaseCardId(null)
    setRevealedVehicleFunFactCardId(null)
    setStatusMessage(getPhaseStatusMessage(viewerPhase))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [viewerPhase])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedDrawCityIds(game.activeCityOffer?.keptCityIds ?? [])
  }, [game.activeCityOffer?.keptCityIds])

  useEffect(() => {
    if (suppressPeriodSummary) return

    const doneBureaucracy = hasPlayerCompletedBureaucracy(game, activeViewingPlayerId)

    if (doneBureaucracy) {
      // Show immediately after player confirms bureaucracy — week hasn't ended yet
      const summaryKey = `bureaucracy-wait:${game.currentWeek}:${activeViewingPlayerId}`
      if (summaryKey !== lastShownPeriodSummaryKey) {
        /* eslint-disable react-hooks/set-state-in-effect */
        setIsPeriodSummaryOpen(true)
        setIsBureaucracyOpen(false)
        setLastShownPeriodSummaryKey(summaryKey)
        /* eslint-enable react-hooks/set-state-in-effect */
      }
      return
    }

    // Also show once the week fully ends so final data is visible
    const completedPeriodLocal = game.isGameOver ? game.currentWeek : game.currentWeek - 1
    if (game.currentPhase !== "purchase-equipment" || completedPeriodLocal < 1) return
    const summaryKey = `${completedPeriodLocal}:${game.isGameOver ? "game-over" : "continue"}`
    if (summaryKey === lastShownPeriodSummaryKey) return

    setIsPeriodSummaryOpen(true)
    setLastShownPeriodSummaryKey(summaryKey)
  }, [game, activeViewingPlayerId, lastShownPeriodSummaryKey, suppressPeriodSummary])

  useEffect(() => {
    onPeriodSummaryVisibilityChange?.(isPeriodSummaryVisible)
  }, [isPeriodSummaryVisible, onPeriodSummaryVisibilityChange])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setIsResourceMarketOpen(false)
    setIsVehicleMarketOpen(viewerPhase === "purchase-equipment")
    setIsBureaucracyOpen(viewerPhase === "bureaucracy" && !game.isGameOver)
    setIsEconomicsOpen(false)
    setIsWikiOpen(false)
    setWikiPreviousPanel(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [viewerPhase, game.isGameOver])

  function restorePhasePanel() {
    setIsResourceMarketOpen(false)
    setIsVehicleMarketOpen(viewerPhase === "purchase-equipment")
    setIsBureaucracyOpen(viewerPhase === "bureaucracy" && !game.isGameOver)
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

  function handleCityClick() {
    if (isSelectingCityCards) {
      setStatusMessage("Use the table lane to draw 4 city cards and keep exactly 2.")
      return
    }

    if (canEditOperations) {
      setStatusMessage("Use your city cards or click highlighted rail segments on the map to build a route.")
      return
    }

    resetSelection(getRouteInteractionMessage(game.currentPhase))
  }

  async function toggleSelectedCityId(
    cityId: string,
    source: "draw" | "owned",
    mode: RouteMode,
  ) {
    if (isSelectingCityCards) {
      if (source !== "draw") {
        return
      }

      if (!canManageCurrentCityOffer) {
        setStatusMessage("Only the active player can pick city cards.")
        return
      }

      const nextCityIds = selectedDrawCityIds.includes(cityId)
        ? selectedDrawCityIds.filter(candidate => candidate !== cityId)
        : selectedDrawCityIds.length >= 2
          ? null
          : [...selectedDrawCityIds, cityId]

      if (nextCityIds === null) {
        setStatusMessage("Keep exactly 2 city cards from the draw.")
        return
      }

      const result = await onSetActiveCityOfferKeptCityIds(nextCityIds)

      if (!result.ok) {
        setStatusMessage(result.error)
        return
      }

      setStatusMessage(
        result.cityIds.length === 2
          ? "Kept 2 city cards. Confirm picks to add them to your hand and end the turn."
          : "Keep exactly 2 city cards from the draw.",
      )
      return
    }

    if (mode === "rail") {
      return
    }

    setSelectedRouteMode(mode)
    setSelectedRailSegmentKeys([])

    const applyToggle = (current: string[]) =>
      current.includes(cityId)
        ? current.filter(candidate => candidate !== cityId)
        : mode === "air" && current.length >= 2
          ? [current[1], cityId]
          : [...current, cityId]

    if (source === "draw") {
      return
    }

    if (mode !== "bus") {
      setSelectedDrawCityIds([])
    }
    setSelectedOwnedCityIds(current => applyToggle(current))
    setStatusMessage(`Selecting owned city cards for a ${MODE_LABELS[mode].toLowerCase()} route.`)
  }

  async function handleDrawDeck(region: CityDeckRegion) {
    const result = await onDrawCityOffer(region)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setSelectedRouteMode(null)
    setSelectedDrawCityIds([])
    setSelectedOwnedCityIds([])
    setSelectedRailSegmentKeys([])
    setStatusMessage(
      `Drew ${result.cityIds.length} city cards from the ${region} deck. Keep exactly 2 to use this turn.`,
    )
  }

  function handleToggleRailSegment(segmentKey: string) {
    if (!claimableRailSegmentKeys.has(segmentKey)) {
      return
    }

    setSelectedRouteMode("rail")
    setSelectedDrawCityIds([])
    setSelectedOwnedCityIds([])
    setSelectedRailSegmentKeys(current =>
      current.includes(segmentKey)
        ? current.filter(candidate => candidate !== segmentKey)
        : [...current, segmentKey],
    )
    setStatusMessage("Selecting rail track segments on the map.")
  }

  function handleSelectAirCity(slot: 0 | 1, cityId: string) {
    setSelectedRouteMode("air")
    setSelectedDrawCityIds([])
    setSelectedRailSegmentKeys([])
    setSelectedOwnedCityIds(current => {
      const next: (string | undefined)[] = [current[0], current[1]]
      next[slot] = cityId

      const otherSlot = slot === 0 ? 1 : 0
      if (next[otherSlot] === cityId) {
        next[otherSlot] = undefined
      }

      return next.filter((candidate): candidate is string => typeof candidate === "string")
    })
    setStatusMessage("Selected air route endpoints from owned city cards.")
  }

  async function handleClaim() {
    if (!canEditOperations) {
      setStatusMessage(getRouteInteractionMessage(game.currentPhase))
      return
    }

    if (
      selectedRouteMode === null ||
      (selectedRouteMode === "rail"
        ? selectedSegmentPairs.length < 1
        : selectedCities.length < 2)
    ) {
      return
    }

    const result = await onClaimRoute(
      selectedRouteMode,
      selectedCityIds,
      selectedRouteMode === "rail" ? selectedSegmentPairs : undefined,
    )

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    const routeLabel = selectedCities.map(city => city.name).join(", ")
    const rewardText =
      result.connectionBonus > 0
        ? ` and earned ${formatCurrency(result.connectionBonus)} for ${result.newCityIds.length} new cit${result.newCityIds.length === 1 ? "y" : "ies"}`
        : ""

    resetSelection(
      `${currentPlayer?.name ?? "Current player"} claimed a ${MODE_LABELS[selectedRouteMode].toLowerCase()} route across ${routeLabel}${result.cost > 0 ? ` for ${formatCurrency(result.cost)}` : ""}${rewardText}. Continue operations.`,
    )
  }

  async function handleConfirmPicks() {
    if (!canConfirmPicks) {
      setStatusMessage("Keep exactly 2 city cards from the draw first.")
      return
    }

    const nextStatusMessage = shouldAdvancePhase
      ? `Confirmed picks. Starting ${formatPhaseLabel(getNextPhase(game.currentPhase)).toLowerCase()}.`
      : `Confirmed picks. ${nextPlayer?.name ?? "Next player"} is up.`

    const result = await onAdvanceTurn()
    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }
    resetSelection(nextStatusMessage)
  }

  async function handleAdvanceTurnClick() {
    if (
      canManageCurrentCityOffer &&
      (game.activeCityOffer?.keptCityIds.length ?? 0) !== 2
    ) {
      setStatusMessage("Draw 4 city cards and keep exactly 2 before ending the turn.")
      return
    }

    if (canEditOperations && hasPendingOperationsRouteSelection) {
      setStatusMessage("Build or clear the selected route before ending the turn.")
      return
    }

    if (canEditOperations && hasInvalidOperationsPods) {
      setStatusMessage("Fix the red routes before ending Operations.")
      return
    }

    const nextStatusMessage = shouldAdvancePhase
      ? `Starting ${formatPhaseLabel(getNextPhase(game.currentPhase)).toLowerCase()}.`
      : `${nextPlayer?.name ?? "Next player"} is up.`

    if (debugMode) enableDebugMode()
    const result = await onAdvanceTurn()
    if (debugMode) {
      setDebugLogEntries(getDebugEntries())
      disableDebugMode()
    }
    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }
    resetSelection(nextStatusMessage)
  }

  function beginResize(
    target: ResizeTarget,
    event: ReactMouseEvent<HTMLDivElement>,
    startValue: number,
  ) {
    event.preventDefault()
    setResizeState({
      target,
      startX: event.clientX,
      startY: event.clientY,
      startValue,
    })
  }

  function beginTouchResize(
    target: ResizeTarget,
    event: React.TouchEvent<HTMLDivElement>,
    startValue: number,
  ) {
    event.preventDefault()
    const touch = event.touches[0]
    if (!touch) return
    setResizeState({
      target,
      startX: touch.clientX,
      startY: touch.clientY,
      startValue,
    })
  }

  function getResizeHandleStyle(target: ResizeTarget) {
    const sharedStyle = {
      position: "absolute",
      zIndex: 3,
      borderRadius: 999,
      background:
        resizeState?.target === target ? "rgba(34, 48, 36, 0.28)" : "rgba(34, 48, 36, 0.12)",
      transition: "background 120ms ease",
      touchAction: "none",
    } as const

    switch (target) {
      case "left-panel":
        return {
          ...sharedStyle,
          top: 16,
          bottom: 16,
          left: effectiveLeftPanelWidth + PANEL_GAP / 2 - RESIZE_HANDLE_SIZE / 2,
          width: RESIZE_HANDLE_SIZE,
          cursor: "ew-resize",
        } as const
      case "right-rail":
        return {
          ...sharedStyle,
          top: 16,
          bottom: 16,
          right: rightRailWidth + PANEL_GAP / 2 - RESIZE_HANDLE_SIZE / 2,
          width: RESIZE_HANDLE_SIZE,
          cursor: "ew-resize",
        } as const
      case "table-height":
        return {
          ...sharedStyle,
          left: boardLeftInset,
          right: boardRightInset,
          bottom: tableZoneHeight + PANEL_GAP + PANEL_GAP / 2 - RESIZE_HANDLE_SIZE / 2,
          height: RESIZE_HANDLE_SIZE,
          cursor: "ns-resize",
        } as const
      case "table-preview":
        return {
          ...sharedStyle,
          top: 12,
          bottom: 12,
          right: tablePreviewWidth + TABLE_ZONE_GAP / 2 - RESIZE_HANDLE_SIZE / 2,
          width: RESIZE_HANDLE_SIZE,
          cursor: "ew-resize",
        } as const
    }
  }

  function renderVehiclePurchaseCard(card: VehicleCard, section: "owned" | "market") {
    const isOwnedModel = currentPlayerOwnedVehicleCards.some(ownedCard => ownedCard.id === card.id)
    const ownedCount = currentPlayerOwnedVehicleCountsByCardId[card.id] ?? 0
    const assignedRouteLabels = currentPlayerAssignedRouteLabelsByVehicleCardId[card.id] ?? []
    const demandCoverage = currentPlayerVehicleDemandByCardId[card.id]
    const isDemandShortfall =
      (demandCoverage?.selectedFleetSize ?? 0) < (demandCoverage?.demandFleetSize ?? 0)
    const accentColor = currentPlayer?.color ?? "#457b9d"
    const isOwnedSection = section === "owned"
    const canBuy =
      canBuyVehiclesInPipeline &&
      !hasUsedVehiclePurchase &&
      (currentPlayer?.money ?? 0) >= card.purchasePrice &&
      (isOwnedSection ? isOwnedModel : visibleVehicleCards.some(visibleCard => visibleCard.id === card.id))
    const buyLabel = isOwnedSection || isOwnedModel ? "Buy more" : "Buy model"
    const cardBorderColor = isOwnedSection ? colorWithOpacity(accentColor, 0.55) : "#d8dfd5"
    const cardBackground = isOwnedSection
      ? `linear-gradient(180deg, ${colorWithOpacity(accentColor, 0.12)} 0%, #ffffff 42%)`
      : "#ffffff"
    const cardShadow = isOwnedSection
      ? `0 0 0 1px ${colorWithOpacity(accentColor, 0.18)}, 0 0 18px ${colorWithOpacity(accentColor, 0.2)}, 0 10px 22px ${colorWithOpacity(accentColor, 0.18)}`
      : "0 4px 12px rgba(0, 0, 0, 0.06)"
    const stackedDiceValues = [ownedCount, ownedCount - 6, ownedCount - 12]
      .filter(value => value > 0)
      .map(value => Math.min(value, 6))

    return (
      <div
        key={`${section}-${card.id}`}
        style={{
          border: `1px solid ${cardBorderColor}`,
          borderRadius: 14,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          background: cardBackground,
          boxShadow: cardShadow,
          fontSize: 12,
          minWidth: 156,
          maxWidth: 176,
          minHeight: 218,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
          <strong style={{ lineHeight: 1.2 }}>
            #{card.number} {getVehicleTypeIcon(card.type)} {getVehicleTypeLabel(card.type)}
          </strong>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12 }}>{formatCurrency(card.purchasePrice)}</span>
            <button
              type="button"
              onClick={() =>
                setRevealedVehicleFunFactCardId(current =>
                  current === card.id ? null : card.id,
                )
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: "1px solid #c7d0c4",
                background: "#ffffff",
                color: "#56635a",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
              }}
              aria-label={`Toggle fun fact for ${card.name}`}
              title="Show fun fact"
            >
              ?
            </button>
          </div>
        </div>
        <div
          style={{
            fontWeight: 700,
            color: "#223024",
            fontSize: 12,
            lineHeight: 1.25,
            whiteSpace: "normal",
            overflowWrap: "anywhere",
            textWrap: "pretty",
          }}
        >
          {card.name}
        </div>
        {isOwnedModel && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              color: isOwnedSection ? accentColor : "#5b7395",
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            <span>{isOwnedSection ? "Fleet Size/Demand" : "Owned model"}</span>
            {isOwnedSection && (
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 999,
                  background: colorWithOpacity(
                    isDemandShortfall
                      ? "#b42318"
                      : demandCoverage && demandCoverage.demandFleetSize > 0
                        ? accentColor
                        : "#7d8d80",
                    isDemandShortfall ? 0.14 : demandCoverage && demandCoverage.demandFleetSize > 0 ? 0.16 : 0.1,
                  ),
                  color: isDemandShortfall
                    ? "#b42318"
                    : demandCoverage && demandCoverage.demandFleetSize > 0
                      ? accentColor
                      : "#5d6c61",
                }}
              >
                {`${ownedCount}/${demandCoverage?.demandFleetSize ?? 0}`}
              </span>
            )}
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 8px",
            color: "#324236",
            fontSize: 11,
            lineHeight: 1.25,
          }}
        >
          <span>👥 {card.totalPassengerCapacity.toLocaleString()} seats</span>
          <span>{card.speed}mph</span>
          <span>⚙️{card.operatingCostMultiplier}</span>
        </div>
        {isOwnedSection && ownedCount > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 6,
              marginTop: 2,
            }}
          >
            <div style={{ position: "relative", width: 36, height: 34 }}>
              {stackedDiceValues.map((dieValue, index) => (
                <div
                  key={`${card.id}-die-${index}`}
                  style={{
                    position: "absolute",
                    right: index * 7,
                    top: Math.max(0, 10 - index * 5),
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    border: `1px solid ${colorWithOpacity(accentColor, 0.45)}`,
                    background: "#ffffff",
                    boxShadow: `0 4px 10px ${colorWithOpacity(accentColor, 0.18)}`,
                  }}
                >
                  {getDiePipPositions(dieValue).map((pip, pipIndex) => (
                    <span
                      key={`${card.id}-die-${index}-pip-${pipIndex}`}
                      style={{
                        position: "absolute",
                        top: pip.top,
                        left: pip.left,
                        width: 4,
                        height: 4,
                        borderRadius: "50%",
                        background: accentColor,
                        transform: "translate(-50%, -50%)",
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div
              style={{
                minWidth: 26,
                padding: "2px 6px",
                borderRadius: 999,
                background: accentColor,
                color: "#ffffff",
                fontSize: 11,
                fontWeight: 800,
                textAlign: "center",
                boxShadow: `0 4px 10px ${colorWithOpacity(accentColor, 0.24)}`,
              }}
            >
              {ownedCount}
            </div>
          </div>
        )}
        {revealedVehicleFunFactCardId === card.id && (
          <div style={{ color: "#56635a", fontSize: 11 }}>
            {card.funFact}
          </div>
        )}
        {isOwnedSection && assignedRouteLabels.length > 0 && (
          <div style={{ color: "#56635a", fontSize: 11, lineHeight: 1.35 }}>
            <strong>Assigned routes:</strong> {assignedRouteLabels.join("; ")}
          </div>
        )}
        {isOwnedSection && ownedCount > 0 && (
          <div
            style={{
              color: isDemandShortfall ? "#b42318" : "#56635a",
              fontSize: 11,
              lineHeight: 1.35,
              fontWeight: isDemandShortfall ? 700 : 400,
            }}
          >
            <strong>Demand:</strong>{" "}
            {`${demandCoverage?.selectedFleetSize ?? 0}/${demandCoverage?.demandFleetSize ?? 0} demand`}
          </div>
        )}
        <button
          type="button"
          disabled={!canBuy}
          onClick={() => handleBuyVehicleCardClick(card.id)}
          style={{
            marginTop: "auto",
            padding: "6px 10px",
            borderRadius: 999,
            border: "1px solid #c7d0c4",
            cursor: canBuy ? "pointer" : "not-allowed",
            background: canBuy ? "#ffffff" : "#f2f2f2",
            fontWeight: 700,
            fontSize: 12,
          }}
        >
          {buyLabel}
        </button>
      </div>
    )
  }

  function handleBuyVehicleCardClick(cardId: string) {
    setPendingVehiclePurchaseQuantity(1)
    setPendingVehiclePurchaseCardId(cardId)
  }

  async function handleConfirmBuyVehicleCard() {
    if (!pendingVehiclePurchaseCard) {
      return
    }

    const result = await onBuyVehicleCard(
      pendingVehiclePurchaseCard.id,
      pendingVehiclePurchaseQuantity,
    )

    if (!result.ok) {
      setStatusMessage(result.error)
      setPendingVehiclePurchaseCardId(null)
      setPendingVehiclePurchaseQuantity(1)
      return
    }

    setStatusMessage(
      result.advancedPhase
        ? `${currentPlayer?.name ?? "Current player"} bought ${result.quantity} ${getVehiclePurchaseLabel(result.card.type, result.quantity)} from card ${result.card.number} for ${formatCurrency(result.cost)}. Starting ${formatPhaseLabel(result.nextPhase).toLowerCase()}.`
        : `${currentPlayer?.name ?? "Current player"} bought ${result.quantity} ${getVehiclePurchaseLabel(result.card.type, result.quantity)} from card ${result.card.number} for ${formatCurrency(result.cost)}. ${result.nextPlayerName} is up.`,
    )
    setPendingVehiclePurchaseCardId(null)
    setPendingVehiclePurchaseQuantity(1)
  }

  async function handleSetBureaucracyVehicleCard(routeId: string, vehicleCardId: string | null) {
    const result = await onSetBureaucracyRouteVehicleCard(routeId, vehicleCardId)

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

  async function handleAddSplitService(corridorId: string) {
    const result = await onAddBureaucracyServiceSplit(corridorId)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage("Added another service slot on that corridor.")
  }

  async function handleMoveServiceCity(
    corridorId: string,
    cityId: string,
    routeId: string,
    sourceRouteId: string | null = null,
  ) {
    const result = await onMoveBureaucracyServiceCity(
      corridorId,
      cityId,
      routeId,
      sourceRouteId,
    )

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    const targetPlan = findPlayerBureaucracyPlan(game, currentPlayer.id, routeId)
    const sourcePlan =
      sourceRouteId === null
        ? null
        : findPlayerBureaucracyPlan(game, currentPlayer.id, sourceRouteId)

    setStatusMessage(
      targetPlan?.isDisconnected
        ? `Removed ${cityMap[cityId]?.name ?? cityId} from ${sourcePlan?.serviceLabel ?? "that route"}.`
        : `Copied ${cityMap[cityId]?.name ?? cityId} into ${targetPlan?.serviceLabel ?? "that route"}.`,
    )
  }

  async function handleDeleteServicePod(corridorId: string, routeId: string, cityIds: string[]) {
    const result = await onDeleteBureaucracyServicePod(corridorId, routeId)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(
      cityIds.length === 0
        ? "Deleted that route."
        : "Deleted that route.",
    )
  }

  function getPodMoveError(
    plans: NonNullable<typeof currentPlayerBureaucracySummary>["routePlans"],
    cityId: string,
    routeId: string,
  ) {
    const targetPlan = plans.find(plan => plan.id === routeId)

    if (!targetPlan || !targetPlan.availableCityIds.includes(cityId)) {
      return "That city does not belong to this route group."
    }

    if (targetPlan.isDisconnected) {
      return null
    }

    const nextTargetCityIds = [
      ...new Set([
        ...targetPlan.selectedCityIds.filter(selectedCityId => selectedCityId !== cityId),
        cityId,
      ]),
    ]

    if (!isValidServicePodSelection(nextTargetCityIds, targetPlan.corridorSegmentPairs)) {
      return "That destination route would be disconnected."
    }

    return null
  }

  async function handleUpgradeRailRoute(routeId: string) {
    const result = await onUpgradeRailRoute(routeId)

    if (!result.ok) {
      setStatusMessage(result.error)
      return
    }

    setStatusMessage(`Electrified that rail route for ${formatCurrency(result.cost)}.`)
  }

  return (
    <div style={BOARD_SHELL_STYLE}>
      <div style={TOP_BAR_STYLE}>
        <div style={TOP_BAR_PLAYERS_STYLE}>
        {playerSummaries.map(
          ({ player, connectedCities, weeklyNet, ownedVehicleCardCounts, ownedRouteCount, projectedMoney }) => (
            <button
              key={`${player.id}-summary`}
              type="button"
              onClick={() => setExpandedPlayerId(current => (current === player.id ? null : player.id))}
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
                  <strong>$</strong> {formatCurrency(projectedMoney).replace("$", "")}
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
              <div style={{ display: "flex", gap: 8, color: "#324236", alignItems: "center" }}>
                <span>👥 {formatDecimal(player.totalPassengersServed, 0)}</span>
                <span>🏙 {connectedCities.length}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  {ownedVehicleCardCounts.bus > 0 && (
                    <CardStackPreview
                      compact
                      icon=""
                      label="Bus cards"
                      count={ownedVehicleCardCounts.bus}
                      accent={{ border: "#8aa07f", face: "#f7fbf4", badge: "#68865b" }}
                    />
                  )}
                  {ownedVehicleCardCounts.train > 0 && (
                    <CardStackPreview
                      compact
                      icon=""
                      label="Train cards"
                      count={ownedVehicleCardCounts.train}
                      accent={{ border: "#7d8fa8", face: "#f4f7fb", badge: "#5b7395" }}
                    />
                  )}
                  {ownedVehicleCardCounts.air > 0 && (
                    <CardStackPreview
                      compact
                      icon=""
                      label="Air cards"
                      count={ownedVehicleCardCounts.air}
                      accent={{ border: "#9a88bb", face: "#f7f4fc", badge: "#7c66a7" }}
                    />
                  )}
                </div>
                <CardStackPreview
                  compact
                  icon="🗺"
                  label="Route cards"
                  count={ownedRouteCount}
                  accent={{ border: "#b3966a", face: "#fbf6ed", badge: "#9a7440" }}
                />
              </div>
            </button>
          ),
        )}
        </div>
      </div>
      <div style={rowTwoStyle}>
        <div
          style={{
            ...HUD_STYLE,
            ...(isLeftPanelCollapsed ? {
              padding: 6,
              alignItems: "center",
              justifyContent: "flex-start",
              overflow: "hidden",
            } : {}),
          }}
        >
          {isLeftPanelCollapsed ? (
            <button
              type="button"
              onClick={() => setIsLeftPanelCollapsed(false)}
              title="Show menu"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                border: "1px solid #c7d0c4",
                background: "#ffffff",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                flexShrink: 0,
              }}
            >
              ▶
            </button>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -4 }}>
                <button
                  type="button"
                  onClick={() => setIsLeftPanelCollapsed(true)}
                  title="Hide menu"
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    border: "1px solid #c7d0c4",
                    background: "#f7faf6",
                    cursor: "pointer",
                    fontSize: 11,
                    color: "#56635a",
                    fontWeight: 600,
                  }}
                >
                  ◀ Hide
                </button>
              </div>
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
            <strong>Expanded cities:</strong>{" "}
            {expandedCityIds.size > 0
              ? `${expandedCityIds.size} in the current draw, hand, or network`
              : "none"}
          </div>
          <div>{statusMessage}</div>
          {(game.currentPhase === "purchase-equipment" ||
            game.currentPhase === "add-city" ||
            game.currentPhase === "operations" ||
            game.currentPhase === "bureaucracy") && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                border: "1px solid #d8dfd5",
                borderRadius: 12,
                padding: 10,
                background: "#fffaf0",
              }}
            >
                <strong>
                  {game.currentPhase === "purchase-equipment"
                    ? "Vehicle deck on the table"
                    : game.currentPhase === "add-city"
                      ? "City decks on the table"
                      : game.currentPhase === "operations"
                        ? "Operations planning"
                        : "Bureaucracy review"}
                </strong>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                {game.currentPhase === "purchase-equipment"
                  ? "Choose from the cards laid out across the table below instead of opening a market menu."
                  : game.currentPhase === "add-city"
                    ? "Draw 4 city cards and keep exactly 2. This step only adds cities to your hand."
                    : game.currentPhase === "operations"
                      ? "Build tracks, split routes, assign service, and set up routes."
                      : "Review passenger flow and route ledgers before ending the month."}
              </div>
              {game.currentPhase === "purchase-equipment" && hasUsedVehiclePurchase && (
                <div style={{ color: "#9b1c1c", fontSize: 13 }}>
                  You have already used your vehicle purchase this turn. Advance to finish purchasing.
                </div>
              )}
              {canEditOperations &&
                currentPlayerOwnedModes.has("bus") &&
                !currentPlayerOwnedModes.has("rail") && (
                  <div style={{ color: "#56635a", fontSize: 13 }}>
                    Build Track unlocks after you buy a train vehicle card in Purchase Equipment.
                  </div>
                )}
              {canEditOperations && currentPlayerOwnedModes.size === 0 && (
                <div style={{ color: "#848484", fontSize: 13 }}>
                  You do not own any vehicles that can build city links yet.
                </div>
              )}
            </div>
          )}
          <div
            style={{
              marginTop: "auto",
              display: "grid",
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
              justifyItems: "center",
              alignItems: "end",
              columnGap: 4,
              rowGap: 4,
            }}
          >
            <CardStackPreview
              icon="🚌"
              label="Bus cards"
              count={vehicleMarketCountsByType.bus}
              accent={MODE_ACCENT_COLORS.bus}
            />
            <CardStackPreview
              icon="🚆"
              label="Train cards"
              count={vehicleMarketCountsByType.train}
              accent={MODE_ACCENT_COLORS.rail}
            />
            <CardStackPreview
              icon="✈️"
              label="Air cards"
              count={vehicleMarketCountsByType.air}
              accent={MODE_ACCENT_COLORS.air}
            />
            <CardStackPreview
              icon="🗺"
              label="City cards"
              count={totalCityDeckCount}
              accent={{ border: "#b3966a", face: "#fbf6ed", badge: "#9a7440" }}
              dimmed={game.currentPhase !== "add-city"}
            />
            <CardStackPreview
              icon="?"
              label="Chance cards"
              count={remainingChanceDeckCount}
              accent={{ border: "#b58cba", face: "#fbf4fb", badge: "#95669a" }}
              dimmed={!activeChanceCard && remainingChanceDeckCount === 0}
            />
          </div>
            </>
          )}
        </div>
        <div style={BOARD_STAGE_STYLE}>
          <div style={BOARD_INNER_STYLE}>
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
              <TransformComponent
                wrapperStyle={{ width: "100%", height: "100%" }}
                contentStyle={{ width: "100%", height: "100%" }}
              >
                <svg
                  viewBox={`0 0 ${map.width} ${map.height}`}
                  style={{
                    width: "100%",
                    height: "100%",
                    display: "block",
                  }}
                >
            <defs>
              <clipPath id="board-outline-clip">
                <path d={`M ${outlinePath} Z`} />
              </clipPath>
              <filter id="region-shade-blur">
                <feGaussianBlur stdDeviation="20" />
              </filter>
            </defs>
            <path
              d={`M ${outlinePath} Z`}
              fill={MAP_OUTLINE_STYLE.fill}
              stroke={MAP_OUTLINE_STYLE.stroke}
              strokeWidth={2}
              opacity={MAP_OUTLINE_STYLE.opacity}
            />
            <g clipPath="url(#board-outline-clip)" filter="url(#region-shade-blur)">
              {regionShadingBlobs.map(blob => (
                <circle
                  key={blob.id}
                  cx={blob.x}
                  cy={blob.y}
                  r={blob.radius}
                  fill={colorWithOpacity(REGION_STYLES[blob.region].fill, 0.18)}
                />
              ))}
            </g>

            {adjacentRouteSegments.map(segment => {
              const a = latLngToWorld(segment.cityA)
              const b = latLngToWorld(segment.cityB)
              const d = buildSegmentPath(a, b, segment.curve)

              return (
                <g key={segment.id}>
                  <path
                    d={d}
                    stroke="rgba(221, 155, 87, 0.42)"
                    strokeWidth={2}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={segment.allowRail ? undefined : "10 7"}
                    opacity={0.9}
                  />
                  <path
                    d={d}
                    stroke="rgba(255, 221, 177, 0.72)"
                    strokeWidth={0.9}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={segment.allowRail ? "8 8" : "3 9"}
                    opacity={0.85}
                  />
                </g>
              )
            })}

            {canEditOperations &&
              selectedRouteMode === "rail" &&
              currentPlayerOwnedModes.has("rail") &&
              adjacentRouteSegments.map(segment => {
                if (!claimableRailSegmentKeys.has(segment.id)) {
                  return null
                }

                const a = latLngToWorld(segment.cityA)
                const b = latLngToWorld(segment.cityB)
                const d = buildSegmentPath(a, b, segment.curve)
                const isSelected = selectedRailSegmentKeys.includes(segment.id)

                return (
                  <g key={`rail-build:${segment.id}`}>
                    <path
                      d={d}
                      stroke={isSelected ? colorWithOpacity(currentPlayer?.color ?? "#223024", 0.35) : "rgba(34, 48, 36, 0.14)"}
                      strokeWidth={14}
                      fill="none"
                      strokeLinecap="round"
                    />
                    <path
                      d={d}
                      stroke={isSelected ? currentPlayer?.color ?? "#223024" : "rgba(34, 48, 36, 0.6)"}
                      strokeWidth={isSelected ? 5 : 3}
                      fill="none"
                      strokeLinecap="round"
                      strokeDasharray="10 8"
                    />
                    <path
                      d={d}
                      stroke="transparent"
                      strokeWidth={20}
                      fill="none"
                      strokeLinecap="round"
                      style={{ cursor: "pointer" }}
                      onClick={() => handleToggleRailSegment(segment.id)}
                    />
                  </g>
                )
              })}

            {!game.isGameOver && currentPlayerPodPreviewLines.map(segment => {
              const a = latLngToWorld(segment.cityA)
              const b = latLngToWorld(segment.cityB)
              const d = buildSegmentPath(a, b, segment.curve)

              return (
                <g key={`pod-preview:${segment.id}`}>
                  <path
                    d={d}
                    stroke={colorWithOpacity(segment.color, 0.18)}
                    strokeWidth={segment.haloWidth}
                    fill="none"
                    strokeLinecap="round"
                  />
                  <path
                    d={d}
                    stroke={segment.color}
                    strokeWidth={segment.lineWidth}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={segment.dasharray}
                    opacity={0.95}
                  />
                </g>
              )
            })}

            {displayedMapRoutes.map(({ id, route, color, opacity }) => {
              const aCity = cityMap[route.cityA]
              const bCity = cityMap[route.cityB]
              if (!aCity || !bCity) return null

              const a = latLngToWorld(aCity)
              const b = latLngToWorld(bCity)
              const d = buildSegmentPath(
                a,
                b,
                segmentMetadataByKey[getSegmentKey(route.cityA, route.cityB)]?.curve,
              )
              const lineStyle = MODE_LINE_STYLES[route.mode]
              const isElectricRail =
                route.mode === "rail" && getRailTraction(route) === "electric"
              const finalRouteDasharray = game.isGameOver
                ? route.mode === "air"
                  ? lineStyle.strokeDasharray
                  : undefined
                : isElectricRail
                  ? "18 6"
                  : lineStyle.strokeDasharray
              const finalRouteOpacity = game.isGameOver ? 1 : opacity

              return (
                <g key={id}>
                  {isElectricRail && (
                    <path
                      d={d}
                      stroke="#8ed8ff"
                      strokeWidth={8}
                      fill="none"
                      strokeLinecap="round"
                      opacity={0.7}
                    />
                  )}
                  <path
                    d={d}
                    stroke={color}
                    strokeWidth={lineStyle.strokeWidth}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={finalRouteDasharray}
                    opacity={finalRouteOpacity}
                  />
                </g>
              )
            })}

            {previewVisible && (
              previewSegments.map(segment => {
                const a = latLngToWorld(segment.cityA)
                const b = latLngToWorld(segment.cityB)

                return (
                  <path
                    key={`preview:${segment.cityA.id}:${segment.cityB.id}`}
                    d={buildSegmentPath(a, b, segment.curve)}
                    fill="none"
                    stroke={currentPlayer?.color ?? "#444444"}
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={
                      selectedRouteMode === "air"
                        ? "14 10"
                        : selectedRouteMode === "bus"
                          ? "4 8"
                          : "10 8"
                    }
                    opacity={0.75}
                  />
                )
              })
            )}

            {[...visibleCities]
              .sort((cityA, cityB) => {
                const priorityDifference =
                  getCityMarkerPriority(cityA.id) - getCityMarkerPriority(cityB.id)
                if (priorityDifference !== 0) {
                  return priorityDifference
                }

                if (cityA.size !== cityB.size) {
                  return cityA.size - cityB.size
                }

                return cityA.name.localeCompare(cityB.name)
              })
              .map(city => {
              const { x, y } = latLngToWorld(city)
              const markerStyle = getCityMarkerStyle(city)
              const usesBubbleRadius = markerStyle.isEmphasized
              const labelScale = Math.max(1, zoomScale)
              const label = labelMap[city.id]
              const radiusToRender = markerStyle.radius
              const shouldShowDemandTokens = !game.isGameOver && currentPlayerConnectedCityIds.has(city.id)
              const demandPassengers =
                shouldShowDemandTokens
                  ? getCityDemandSize(game, city) *
                    game.operatingConfig.passengersPerDemandPoint
                  : 0

              return (
                <g
                  key={city.id}
                  onClick={handleCityClick}
                  style={{ cursor: game.currentPhase === "add-city" ? "default" : "pointer" }}
                >
                  {renderCityDemandTokens(
                    city.name,
                    x,
                    y,
                    radiusToRender,
                    demandPassengers,
                    game.operatingConfig.passengersPerDemandPoint,
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={radiusToRender}
                    fill={markerStyle.fill}
                    stroke={markerStyle.stroke}
                    strokeWidth={markerStyle.strokeWidth}
                  />

                  {label && (
                    <text
                      x={label.textX}
                      y={label.textY}
                      fontSize={(usesBubbleRadius ? 24 : 20) / labelScale}
                      textAnchor={label.textAnchor}
                      dominantBaseline="middle"
                      fill="#223024"
                      stroke="rgba(244, 241, 232, 0.95)"
                      strokeWidth={(usesBubbleRadius ? 8 : 6.4) / labelScale}
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
        </div>
        <div style={BOTTOM_BAR_STYLE}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, height: "100%" }}>
            <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
              <button
                type="button"
                onClick={() => setIsControlsMenuOpen(open => !open)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #c7d0c4",
                  cursor: "pointer",
                  background: isControlsMenuOpen ? "#eef3ed" : "#ffffff",
                  fontWeight: 700,
                  fontSize: 18,
                  lineHeight: 1,
                  width: 44,
                  height: 44,
                }}
                aria-label={isControlsMenuOpen ? "Close controls menu" : "Open controls menu"}
                title={isControlsMenuOpen ? "Close controls menu" : "Open controls menu"}
              >
                ☰
              </button>
            </div>
            {isControlsMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  right: "calc(100% + 8px)",
                  minWidth: 220,
                  display: "grid",
                  gap: 6,
                  padding: 8,
                  borderRadius: 12,
                  border: "1px solid #d8dfd5",
                  background: "#f8faf7",
                  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.16)",
                  zIndex: 3,
                }}
              >
                {lanSessionStatus && (
                  <div
                    style={{
                      display: "grid",
                      gap: 4,
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: `1px solid ${lanSessionStatus.statusTone === "error" ? "#d2a4a4" : "#c7d0c4"}`,
                      background: "#ffffff",
                      color: "#223024",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        letterSpacing: 0.4,
                        textTransform: "uppercase",
                      }}
                    >
                      LAN session {lanSessionStatus.sessionId}
                    </div>
                    <div style={{ fontSize: 13 }}>{lanSessionStatus.sessionName} • undo disabled while connected</div>
                    {lanSessionStatus.playerName && (
                      <div style={{ fontSize: 12, color: "#56635a" }}>
                        You joined as {lanSessionStatus.playerName}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 12,
                        color: lanSessionStatus.statusTone === "error" ? "#9b1c1c" : "#56635a",
                      }}
                    >
                      {lanSessionStatus.statusMessage}
                    </div>
                  </div>
                )}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #c7d0c4",
                    background: "#ffffff",
                    color: "#324236",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showCityNames}
                    onChange={event => setShowCityNames(event.target.checked)}
                  />
                  <span>Show city names</span>
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #c7d0c4",
                    background: "#ffffff",
                    color: "#324236",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showCitySizeBubbles}
                    onChange={event => setShowCitySizeBubbles(event.target.checked)}
                  />
                  <span>Show city size bubbles</span>
                </label>
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
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #c7d0c4",
                    cursor: "pointer",
                    background: "#ffffff",
                    fontWeight: 600,
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {isEconomicsOpen ? "Hide economics" : "Economics"}
                </button>
                {(viewerPhase === "operations" || viewerPhase === "bureaucracy") && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsBureaucracyOpen(open => !open)
                      setIsResourceMarketOpen(false)
                      setIsVehicleMarketOpen(false)
                      setIsEconomicsOpen(false)
                      setIsWikiOpen(false)
                    }}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid #c7d0c4",
                      cursor: "pointer",
                      background: "#ffffff",
                      fontWeight: 600,
                      textAlign: "left",
                      fontSize: 13,
                    }}
                  >
                    {isBureaucracyOpen
                      ? viewerPhase === "operations"
                        ? "Hide operations table"
                        : "Hide bureaucracy ledger"
                      : viewerPhase === "operations"
                        ? "Operations table"
                        : "Bureaucracy ledger"}
                  </button>
                )}
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
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #c7d0c4",
                    cursor: "pointer",
                    background: "#ffffff",
                    fontWeight: 600,
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {isWikiOpen ? "Hide wiki" : "Wiki"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsActionLogOpen(open => !open)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #c7d0c4",
                    cursor: "pointer",
                    background: "#ffffff",
                    fontWeight: 600,
                    textAlign: "left",
                    fontSize: 13,
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
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #c7d0c4",
                    cursor: canUndo ? "pointer" : "not-allowed",
                    background: canUndo ? "#ffffff" : "#f2f2f2",
                    fontWeight: 600,
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  Undo
                </button>
                {/* Panel resize controls for touch/mobile */}
                <div style={{ borderTop: "1px solid #d8dfd5", paddingTop: 6, display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#56635a", letterSpacing: "0.06em", textTransform: "uppercase", paddingLeft: 2 }}>Resize panels</div>
                  {[
                    { label: "Left tray", value: leftPanelWidth, min: MIN_TRAY_SIZE, max: Math.max(MIN_TRAY_SIZE, window.innerWidth - PANEL_GAP * 4 - MIN_TRAY_SIZE - rightRailWidth), set: setLeftPanelWidth },
                    { label: "Right rail", value: rightRailWidth, min: MIN_STATUS_RAIL_WIDTH, max: Math.max(MIN_STATUS_RAIL_WIDTH, window.innerWidth - PANEL_GAP * 4 - MIN_TRAY_SIZE - leftPanelWidth), set: setRightRailWidth },
                    { label: "Table height", value: tableZoneHeight, min: MIN_TRAY_SIZE, max: Math.max(MIN_TRAY_SIZE, window.innerHeight - ROW_TWO_TOP - PANEL_GAP * 2 - MIN_TRAY_SIZE), set: setTableZoneHeight },
                  ].map(({ label, value, min, max, set }) => (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 8, border: "1px solid #e1e6df", background: "#ffffff" }}>
                      <span style={{ fontSize: 12, flex: 1, color: "#324236" }}>{label}</span>
                      <button type="button" onClick={() => set(v => Math.max(min, v - 40))} style={{ width: 26, height: 26, borderRadius: 6, border: "1px solid #c7d0c4", background: "#f8faf7", cursor: "pointer", fontWeight: 700, fontSize: 14, lineHeight: 1 }}>−</button>
                      <span style={{ fontSize: 11, color: "#56635a", minWidth: 36, textAlign: "center" }}>{value}px</span>
                      <button type="button" onClick={() => set(v => Math.min(max, v + 40))} style={{ width: 26, height: 26, borderRadius: 6, border: "1px solid #c7d0c4", background: "#f8faf7", cursor: "pointer", fontWeight: 700, fontSize: 14, lineHeight: 1 }}>+</button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setDebugMode(prev => !prev)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: `1px solid ${debugMode ? "#c55" : "#c7d0c4"}`,
                    cursor: "pointer",
                    background: debugMode ? "#ffeaea" : "#ffffff",
                    fontWeight: 600,
                    textAlign: "left",
                    fontSize: 13,
                    color: debugMode ? "#a00" : "#324236",
                  }}
                >
                  {debugMode ? "🐛 Debug mode ON" : "🐛 Debug mode"}
                </button>
              </div>
            )}
            <div
              style={{
                flex: "1 1 0%",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                gap: 1,
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              {Array.from({ length: game.operatingConfig.totalWeeks }, (_, index) => {
                const weekNum = index + 1
                const isPast = weekNum < game.currentWeek
                const isCurrent = weekNum === game.currentWeek

                return (
                  <div
                   key={`week-tracker-${weekNum}`}
                   title={`Month ${weekNum}${isCurrent ? `: ${formatPhaseLabel(game.currentPhase)}` : ""}`}
                   style={{
                     flex: "1 1 0%",
                     minHeight: 0,
                     position: "relative",
                     display: "flex",
                     gap: 1,
                     overflow: "hidden",
                   }}
                  >
                   {TOP_BAR_PHASE_ORDER.map((_, phaseIndex) => {
                     const isFilled = isPast || (isCurrent && currentPhaseProgressIndex >= phaseIndex)
                     return (
                       <div
                         key={phaseIndex}
                         style={{
                           flex: 1,
                           background: isPast
                             ? "repeating-linear-gradient(135deg, #a9c3dc 0 4px, #9bb7d4 4px 6px)"
                             : isCurrent && isFilled
                               ? "repeating-linear-gradient(135deg, #7e9b73 0 4px, #6f8f64 4px 6px)"
                               : "#d9ddd7",
                         }}
                       />
                     )
                   })}
                   {isCurrent && (
                     <div
                       style={{
                         position: "absolute",
                         inset: 0,
                         background:
                           "repeating-linear-gradient(135deg, rgba(126, 155, 115, 0.85) 0 4px, rgba(111, 143, 100, 0.85) 4px 6px)",
                         opacity: isLiveStagePulseOn ? 0.4 : 0,
                         transition: "opacity 2800ms ease-in-out",
                       }}
                     />
                   )}
                   <div
                     style={{
                       position: "absolute",
                       inset: 0,
                       display: "flex",
                       alignItems: "center",
                       justifyContent: "center",
                       fontSize: 9,
                       fontWeight: 800,
                       color: isPast ? "rgba(255,255,255,0.85)" : isCurrent ? "#ffffff" : "#9ba59d",
                       textShadow: isPast || isCurrent ? "0 1px 1px rgba(0,0,0,0.3)" : "none",
                       pointerEvents: "none",
                     }}
                   >
                     {weekNum}
                   </div>
                  </div>
                )
              })}
            </div>
            <button
                type="button"
                onClick={handleAdvanceTurnClick}
                disabled={game.isGameOver || isAdvanceBlocked}
                style={{
                  marginTop: "auto",
                  alignSelf: "center",
                  width: 44,
                  minHeight: 88,
                  padding: "8px 0",
                  borderRadius: 10,
                  border: "1px solid #c7d0c4",
                  cursor: game.isGameOver || isAdvanceBlocked ? "not-allowed" : "pointer",
                  background: game.isGameOver || isAdvanceBlocked ? "#f2f2f2" : "#ffffff",
                  fontWeight: 700,
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "visible",
                }}
                title={advanceTurnLabel}
              >
                <span style={{ display: "inline-block", whiteSpace: "nowrap", transform: "rotate(90deg)" }}>
                  Next
                </span>
              </button>
          </div>
        </div>
        {areResizeHandlesVisible && !isLeftPanelCollapsed && (
          <>
            <div
              onMouseDown={event => beginResize("left-panel", event, leftPanelWidth)}
              onTouchStart={event => beginTouchResize("left-panel", event, leftPanelWidth)}
              style={getResizeHandleStyle("left-panel")}
              title="Resize left tray"
            />
            <div
              onMouseDown={event => beginResize("right-rail", event, rightRailWidth)}
              onTouchStart={event => beginTouchResize("right-rail", event, rightRailWidth)}
              style={getResizeHandleStyle("right-rail")}
              title="Resize right tray"
            />
          </>
        )}
      </div>
      {isPeriodSummaryVisible && (
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
                  {game.bureaucracyReadyPlayerIds.length > 0 && game.currentPhase !== "purchase-equipment"
                    ? "Waiting for other players to finish…"
                    : "Revenue, costs, and passenger totals from the month that just finished."}
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
                {playerSummaries.map(({ player, connectedCities }) => {
                  const isMidBureaucracy = game.currentPhase !== "purchase-equipment"
                  // When mid-bureaucracy, use live projected stats from the bureaucracy summary
                  // (applyBureaucracyFuelConsumption hasn't run yet so player fields still hold last period's values)
                  const liveSummary = isMidBureaucracy
                    ? bureaucracySummaries.find(s => s.player.id === player.id) ?? null
                    : null
                  const passengers = liveSummary
                    ? liveSummary.totalPassengersServed
                    : player.lastPeriodPassengersServed
                  const revenue = liveSummary ? liveSummary.totalRevenue : player.weeklyPayout
                  const costs = liveSummary ? liveSummary.totalOperatingCost : player.operatingCosts
                  const net = revenue - costs
                  const stillPlaying = isMidBureaucracy && !game.bureaucracyReadyPlayerIds.includes(player.id)
                  // Previous period for delta display
                  const history = player.periodHistory ?? []
                  // During bureaucracy the current period isn't committed yet → last entry is the previous period.
                  // After bureaucracy (purchase-equipment) the current period was just appended → use second-to-last.
                  const prevPeriodIndex = isMidBureaucracy ? history.length - 1 : history.length - 2
                  const prevPeriod = prevPeriodIndex >= 0 ? history[prevPeriodIndex] : null
                  const prevPassengers = prevPeriod?.passengersServed ?? null
                  const prevNet = prevPeriod?.netRevenue ?? null
                  const prevRevenue = prevPeriod?.grossRevenue ?? null
                  const prevCosts = prevPeriod?.operatingCosts ?? null
                  const prevCash = prevPeriod?.endingCash ?? null
                  return (
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
                      {stillPlaying && <span style={{ color: "#a07c30", fontStyle: "italic" }}> · still playing</span>}
                    </div>
                  </div>
                  {[
                    {
                      label: "Passengers",
                      value: formatDecimal(passengers, 0),
                      emphasized: true,
                      delta: prevPassengers !== null ? passengers - prevPassengers : null,
                      deltaFormat: (d: number) => (d >= 0 ? "+" : "") + Math.round(d).toLocaleString(),
                    },
                    {
                      label: "Profit",
                      value: formatCurrency(net),
                      emphasized: true,
                      delta: prevNet !== null ? net - prevNet : null,
                      deltaFormat: (d: number) => (d >= 0 ? "+" : "") + formatCurrency(d),
                    },
                    {
                      label: "Revenue",
                      value: formatCurrency(revenue),
                      emphasized: false,
                      delta: prevRevenue !== null ? revenue - prevRevenue : null,
                      deltaFormat: (d: number) => (d >= 0 ? "+" : "") + formatCurrency(d),
                    },
                    {
                      label: "Costs",
                      value: formatCurrency(costs),
                      emphasized: false,
                      delta: prevCosts !== null ? costs - prevCosts : null,
                      deltaFormat: (d: number) => (d >= 0 ? "+" : "") + formatCurrency(d),
                    },
                    {
                      label: "Cash",
                      value: formatCurrency(player.money),
                      emphasized: false,
                      delta: prevCash !== null ? player.money - prevCash : null,
                      deltaFormat: (d: number) => (d >= 0 ? "+" : "") + formatCurrency(d),
                    },
                  ].map(stat => (
                    <div
                      key={`${player.id}-${stat.label}`}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                        minWidth: 96,
                        opacity: stillPlaying ? 0.6 : 1,
                      }}
                    >
                      <div style={{ color: "#7b857d", fontSize: 11, fontWeight: 600 }}>
                        {stat.label}
                      </div>
                      <div
                        style={{
                          color: "#223024",
                          fontSize: stat.emphasized ? 22 : 16,
                          fontWeight: stat.emphasized ? 800 : 700,
                          lineHeight: 1.1,
                        }}
                      >
                        {stat.value}
                      </div>
                      {stat.delta !== null && (
                        <div style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: stat.delta >= 0 ? "#1a7c3c" : "#b42318",
                          lineHeight: 1.2,
                        }}>
                          {stat.deltaFormat(stat.delta)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                  )
                })}
            </div>
          </div>
        </div>
      )}
      {game.isGameOver && leadingStanding && isGameSummaryMinimized && (
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            zIndex: 5,
            display: "grid",
            gap: 8,
            width: "min(320px, calc(100vw - 32px))",
            background: "rgba(255, 255, 255, 0.96)",
            border: "1px solid #d8dfd5",
            borderRadius: 14,
            boxShadow: "0 12px 30px rgba(0, 0, 0, 0.18)",
            padding: 12,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div style={{ display: "grid", gap: 2 }}>
              <strong>Game summary minimized</strong>
              <div style={{ color: "#56635a", fontSize: 12 }}>
                Winner:{" "}
                <span style={{ color: leadingStanding.player.color, fontWeight: 800 }}>
                  {leadingStanding.player.name}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsGameSummaryMinimized(false)}
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
              Show summary
            </button>
          </div>
          <div style={{ color: "#56635a", fontSize: 12 }}>
            The final map stays interactive so you can inspect the bots&apos; cities and routes.
          </div>
        </div>
      )}
      {game.isGameOver && leadingStanding && !isGameSummaryMinimized && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(10, 18, 12, 0.35)",
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div
            style={{
              width: "min(1080px, calc(100vw - 32px))",
              maxHeight: "calc(100vh - 48px)",
              overflowY: "auto",
              background: "#ffffff",
              borderRadius: 16,
              boxShadow: "0 16px 40px rgba(0, 0, 0, 0.2)",
              padding: 18,
              display: "grid",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start", flexWrap: "wrap" }}>
              <div style={{ display: "grid", gap: 4 }}>
                <strong>End of game summary</strong>
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Winner:{" "}
                  <span style={{ color: leadingStanding.player.color, fontWeight: 800 }}>
                    {leadingStanding.player.name}
                  </span>{" "}
                  with {formatDecimal(leadingStanding.player.totalPassengersServed, 0)} passengers served.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => { window.location.href = "/" }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    background: "#223024",
                    color: "#ffffff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  ← Home
                </button>
                <button
                  type="button"
                  onClick={() => setIsGameSummaryMinimized(true)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid #c7d0c4",
                    background: "#ffffff",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  Minimize
                </button>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(140px, 1.1fr) repeat(4, auto)",
                gap: 10,
                alignItems: "center",
              }}
            >
              {[
                { label: "Player", align: "left" as const },
                { label: "Passengers", align: "right" as const },
                { label: "Connected cities", align: "right" as const },
                { label: "Cash", align: "right" as const },
                { label: "Rank", align: "right" as const },
              ].map(column => (
                <div
                  key={column.label}
                  style={{
                    color: "#7b857d",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    textAlign: column.align,
                  }}
                >
                  {column.label}
                </div>
              ))}
              {gameOverSummaryPlayers.flatMap(({ standing, summary }, index) => [
                <div key={`${standing.player.id}-name`}>
                  <strong style={{ color: standing.player.color }}>{standing.player.name}</strong>
                </div>,
                <div
                  key={`${standing.player.id}-passengers`}
                  style={{ textAlign: "right", fontWeight: 700, color: "#223024" }}
                >
                  {formatDecimal(standing.player.totalPassengersServed, 0)}
                </div>,
                <div
                  key={`${standing.player.id}-cities`}
                  style={{ textAlign: "right", fontWeight: 700, color: "#223024" }}
                >
                  {summary?.connectedCities.length ?? standing.connectedCities}
                </div>,
                <div
                  key={`${standing.player.id}-cash`}
                  style={{ textAlign: "right", fontWeight: 700, color: "#223024" }}
                >
                  {formatCurrency(standing.player.money)}
                </div>,
                <div
                  key={`${standing.player.id}-rank`}
                  style={{ textAlign: "right", fontWeight: 800, color: "#223024" }}
                >
                  #{index + 1}
                </div>,
              ])}
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              {gameOverSummaryPlayers.map(({ standing, finalPodLabels, periodHistory, passengersByMode, podCountByMode }) => (
                <div
                  key={`${standing.player.id}-history`}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    padding: 12,
                    display: "grid",
                    gap: 10,
                    background: "#ffffff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <strong style={{ color: standing.player.color }}>{standing.player.name}</strong>
                    </div>
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      Final cash: {formatCurrency(standing.player.money)}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gap: 6,
                      border: "1px solid #e3e8e0",
                      borderRadius: 10,
                      padding: 10,
                      background: "#fafcf9",
                    }}
                  >
                    <div style={{ fontSize: 12, color: "#324236" }}>
                      <strong>Pods by type:</strong>{" "}
                      {(["bus", "rail", "air"] as const)
                        .map(mode => `${MODE_LABELS[mode]} ${formatDecimal(podCountByMode[mode], 0)}`)
                        .join(" • ")}
                    </div>
                    <div style={{ fontSize: 12, color: "#324236" }}>
                      <strong>Passengers by type:</strong>{" "}
                      {(["bus", "rail", "air"] as const)
                        .map(mode => `${MODE_LABELS[mode]} ${formatDecimal(passengersByMode[mode], 0)}`)
                        .join(" • ")}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gap: 6,
                      border: `1px solid ${colorWithOpacity(standing.player.color, 0.28)}`,
                      borderRadius: 10,
                      padding: 10,
                      background: colorWithOpacity(standing.player.color, 0.08),
                    }}
                  >
                    <div style={{ fontSize: 12, color: "#324236" }}>
                      <strong>Final pods:</strong>
                    </div>
                    {finalPodLabels.length ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {finalPodLabels.map(podLabel => (
                          <span
                            key={`${standing.player.id}-${podLabel}`}
                            style={{
                              border: `1px solid ${colorWithOpacity(standing.player.color, 0.38)}`,
                              borderRadius: 999,
                              padding: "4px 8px",
                              fontSize: 12,
                              fontWeight: 700,
                              color: standing.player.color,
                              background: "#ffffff",
                            }}
                          >
                            {podLabel}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "#56635a" }}>No active pods.</div>
                    )}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "96px repeat(5, minmax(110px, auto))",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    {[
                      "Month",
                      "Money made",
                      "Pods by type",
                      "Passengers moved",
                      "Passengers by type",
                      "Ending cash",
                    ].map(label => (
                      <div
                        key={`${standing.player.id}-${label}`}
                        style={{
                          color: "#7b857d",
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: "uppercase",
                        }}
                      >
                        {label}
                      </div>
                    ))}
                    {periodHistory.length > 0 ? (
                      periodHistory.flatMap(entry => [
                        <div key={`${standing.player.id}-${entry.period}-period`} style={{ color: "#223024", fontWeight: 700 }}>
                          Month {entry.period}
                        </div>,
                        <div
                          key={`${standing.player.id}-${entry.period}-net`}
                          style={{
                            color: entry.netRevenue > 0 ? "#2a7f3b" : entry.netRevenue < 0 ? "#b42318" : "#223024",
                            fontWeight: 700,
                          }}
                        >
                          {formatCurrency(entry.netRevenue)}
                        </div>,
                        <div key={`${standing.player.id}-${entry.period}-pods`} style={{ color: "#223024", fontWeight: 700, fontSize: 12 }}>
                          {(["bus", "rail", "air"] as const)
                            .map(mode => `${MODE_LABELS[mode]} ${formatDecimal(entry.podCountByMode?.[mode] ?? 0, 0)}`)
                            .join(" • ")}
                        </div>,
                        <div key={`${standing.player.id}-${entry.period}-passengers`} style={{ color: "#223024", fontWeight: 700 }}>
                          {formatDecimal(entry.passengersServed, 0)}
                        </div>,
                        <div key={`${standing.player.id}-${entry.period}-passengers-by-type`} style={{ color: "#223024", fontWeight: 700, fontSize: 12 }}>
                          {(["bus", "rail", "air"] as const)
                            .map(mode => `${MODE_LABELS[mode]} ${formatDecimal(entry.passengersServedByMode?.[mode] ?? 0, 0)}`)
                            .join(" • ")}
                        </div>,
                        <div key={`${standing.player.id}-${entry.period}-cash`} style={{ color: "#223024", fontWeight: 700 }}>
                          {formatCurrency(entry.endingCash)}
                        </div>,
                      ])
                    ) : (
                      <div
                        style={{
                          gridColumn: "1 / -1",
                          color: "#56635a",
                          fontSize: 13,
                        }}
                      >
                        No month history recorded for this player.
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {expandedPlayerSummary && (
        <div style={playerPanelStyle}>
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
            {expandedPlayerSummary.player.id === currentPlayer.id &&
            game.currentPhase === "operations" ? (
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
                          disabled={!canEditOperations}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 999,
                            border: "1px solid #c7d0c4",
                            background: canEditOperations ? "#ffffff" : "#f2f2f2",
                            cursor: canEditOperations ? "pointer" : "not-allowed",
                            fontWeight: 600,
                            opacity: canEditOperations ? 1 : 0.6,
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
        <div style={resourceMarketPanelStyle}>
          <strong>{game.currentPhase === "operations" ? "Operations" : "Bureaucracy ledger"}</strong>
          <div style={{ color: "#56635a" }}>
            {game.currentPhase === "operations"
            ? "Build rail track, assign vehicles, and split routes here. Bureaucracy is now just the read-only results."
              : "Passenger cubes now flow toward the biggest city demand first. The detailed operating planner stays below as a reference view."}
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
                {canEditOperations ? (
                 <>
                   <div>
                     Pods ready: <strong>{currentPlayerActiveBureaucracyPlans.length}</strong>
                   </div>
                   <div style={{ color: "#56635a", fontSize: 12 }}>
                     Bus {currentPlayerActiveBureaucracyPlans.filter(plan => plan.route.mode === "bus").length}
                     {" • "}Rail {currentPlayerActiveBureaucracyPlans.filter(plan => plan.route.mode === "rail").length}
                     {" • "}Air {currentPlayerActiveBureaucracyPlans.filter(plan => plan.route.mode === "air").length}
                   </div>
                </>
                ) : null}
                 {canEditOperations && currentPlayerOwnedModes.has("rail") && (
                  <div
                    style={{
                      border: "1px solid #e1e6df",
                      borderRadius: 10,
                      padding: 10,
                      background: "#ffffff",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div>
                      <strong>Available track segments</strong>
                    </div>
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      Click a segment here or on the map to lay rail between owned adjacent cities.
                    </div>
                     {claimableRailSegments.length === 0 ? (
                      <div style={{ color: "#56635a", fontSize: 12 }}>
                        No owned adjacent city pairs are ready for new rail track.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxHeight: 200, overflowY: "auto", paddingRight: 2 }}>
                        {claimableRailSegments.map(segment => {
                          const isSelected = selectedRailSegmentKeys.includes(segment.id)

                          return (
                            <button
                              key={`track-option-${segment.id}`}
                              type="button"
                              onClick={() => handleToggleRailSegment(segment.id)}
                              style={{
                                padding: "6px 10px",
                                borderRadius: 999,
                                border: `1px solid ${isSelected ? currentPlayerBureaucracySummary.player.color : "#c7d0c4"}`,
                                background: isSelected
                                  ? `${currentPlayerBureaucracySummary.player.color}18`
                                  : "#ffffff",
                                color: "#223024",
                                cursor: "pointer",
                                fontSize: 12,
                                fontWeight: isSelected ? 700 : 500,
                              }}
                            >
                              {segment.cityA.name} - {segment.cityB.name}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {selectedRailSegmentKeys.length > 0 && (
                      <div style={{ color: "#324236", fontSize: 12 }}>
                        Selected track:{" "}
                        {selectedRailSegmentKeys
                          .map(segmentKey => {
                            const segment = claimableRailSegments.find(candidate => candidate.id === segmentKey)
                            return segment ? `${segment.cityA.name} - ${segment.cityB.name}` : segmentKey
                          })
                          .join(", ")}
                      </div>
                    )}
                  </div>
                 )}
                 {currentPlayerActiveBureaucracyPlans.length === 0 ? (
                    <div
                      style={{
                        border: "1px solid #e1e6df",
                        borderRadius: 10,
                        padding: 10,
                        background: "#ffffff",
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div style={{ color: "#56635a" }}>
                        {canEditOperations
                        ? "No service routes are ready yet."
                          : "No routes to operate yet."}
                      </div>
                      {currentPlayerOwnedCityCards.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {currentPlayerOwnedCityCards.map(city => {
                            const demandSize = getCityDemandSize(game, city)
                            const absorptionSize = Math.max(0, demandSize) + 1

                            return (
                              <div
                                key={`${city.id}-pending-demand`}
                                style={{
                                  border: "1px solid #d8dfd5",
                                  borderRadius: 10,
                                  padding: "6px 8px",
                                  background: "#fafcf9",
                                  display: "grid",
                                  gap: 4,
                                  minWidth: 150,
                                }}
                              >
                                <div style={{ fontSize: 12 }}>
                                  <strong>{city.name}</strong>
                                  {" • "}size {city.size}
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                  {renderDemandPointBoxes(absorptionSize, 0)}
                                </div>
                                <div style={{ color: "#56635a", fontSize: 11 }}>
                                  Waiting cubes {Math.max(0, demandSize)}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                  <>
                   {!canEditOperations && currentPlayerCombinedDemandFill.length > 0 && (
                    <div
                      style={{
                        border: "1px solid #e1e6df",
                        borderRadius: 10,
                        padding: 10,
                        background: "#ffffff",
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div>
                        <strong>City demand fill</strong>
                        <span style={{ color: "#56635a", fontSize: 11, marginLeft: 8 }}>
                          1 box = 10 cubes • hover to see destinations
                        </span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {currentPlayerCombinedDemandFill.map(
                          ({
                            city,
                            outboundCubes,
                            movedOutboundCubes,
                          }) => {
                            const intentEntry = currentPlayerBureaucracySummary?.outboundIntentByCity.find(
                              e => e.cityId === city.id,
                            )
                            const cityHasService = currentPlayerActiveBureaucracyPlans.some(
                              plan => plan.selectedCityIds.includes(city.id),
                            )
                            const stuckEntry = currentPlayerBureaucracySummary?.stuckCubesByCity.find(
                              s => s.cityId === city.id,
                            )
                            type Tone = "green" | "white" | "red"

                            const CUBES_PER_BOX = 10

                            // Build flat per-cube destination arrays from initial intent
                            const allCubeDestinations: string[] = []
                            if (intentEntry) {
                              for (const dest of intentEntry.destinations) {
                                for (let i = 0; i < dest.cubeCount; i++) {
                                  allCubeDestinations.push(dest.destCityName)
                                }
                              }
                            }

                            const movedCubeDestinations = allCubeDestinations.slice(0, movedOutboundCubes)
                            const unmovedCubeDestinations = allCubeDestinations.slice(movedOutboundCubes)

                            const unmovedCount = Math.max(0, outboundCubes - movedOutboundCubes)
                            const unmovedTone: Tone = cityHasService ? "white" : "red"

                            // Fill any gap from stuck cubes at intermediate cities (transit)
                            if (unmovedCubeDestinations.length < unmovedCount && stuckEntry) {
                              for (const wanted of stuckEntry.wantedDestinations) {
                                for (let i = 0; i < wanted.cubeCount && unmovedCubeDestinations.length < unmovedCount; i++) {
                                  unmovedCubeDestinations.push(wanted.destCityName)
                                }
                              }
                            }
                            while (unmovedCubeDestinations.length < unmovedCount) {
                              unmovedCubeDestinations.push("unknown")
                            }

                            function buildBoxes(cubeList: string[], tone: Tone): Array<{ tone: Tone; tooltip: string; primaryDest: string }> {
                              if (cubeList.length === 0) return []
                              const counts = new Map<string, number>()
                              for (const d of cubeList) counts.set(d, (counts.get(d) ?? 0) + 1)
                              const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])

                              const fullBoxes: Array<{ tone: Tone; tooltip: string; primaryDest: string }> = []
                              const remainders: Array<{ dest: string; count: number }> = []

                              for (const [dest, count] of sorted) {
                                const full = Math.floor(count / CUBES_PER_BOX)
                                const rem = count % CUBES_PER_BOX
                                for (let i = 0; i < full; i++) {
                                  fullBoxes.push({ tone, tooltip: `→ ${dest}`, primaryDest: dest })
                                }
                                if (rem > 0) remainders.push({ dest, count: rem })
                              }

                              // Sort remainders by count desc, pack sequentially into boxes of 10
                              remainders.sort((a, b) => b.count - a.count)
                              const remBoxes: Array<{ tone: Tone; tooltip: string; primaryDest: string }> = []
                              let buf: string[] = []
                              for (const { dest, count } of remainders) {
                                for (let i = 0; i < count; i++) {
                                  buf.push(dest)
                                  if (buf.length === CUBES_PER_BOX) {
                                    const c = new Map<string, number>()
                                    for (const d of buf) c.set(d, (c.get(d) ?? 0) + 1)
                                    const topDest = [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]
                                    const parts = [...c.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => c.size === 1 ? `→ ${d}` : `→ ${d} (${n})`).join(", ")
                                    remBoxes.push({ tone, tooltip: parts, primaryDest: topDest })
                                    buf = []
                                  }
                                }
                              }
                              if (buf.length > 0) {
                                const c = new Map<string, number>()
                                for (const d of buf) c.set(d, (c.get(d) ?? 0) + 1)
                                const topDest = [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]
                                const parts = [...c.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => c.size === 1 ? `→ ${d}` : `→ ${d} (${n})`).join(", ")
                                remBoxes.push({ tone, tooltip: parts, primaryDest: topDest })
                              }

                              return [...fullBoxes, ...remBoxes]
                            }

                            const boxes: Array<{ tone: Tone; tooltip: string; primaryDest: string }> = [
                              ...buildBoxes(movedCubeDestinations, "green"),
                              ...buildBoxes(unmovedCubeDestinations, unmovedTone),
                            ]

                            // Group boxes by primaryDest preserving order of first appearance
                            const destOrder: string[] = []
                            const boxesByDest = new Map<string, typeof boxes>()
                            for (const box of boxes) {
                              if (!boxesByDest.has(box.primaryDest)) {
                                destOrder.push(box.primaryDest)
                                boxesByDest.set(box.primaryDest, [])
                              }
                              boxesByDest.get(box.primaryDest)!.push(box)
                            }

                            return (
                              <div
                                key={`${city.id}-combined-fill`}
                                style={{
                                  border: "1px solid #d8dfd5",
                                  borderRadius: 10,
                                  padding: "6px 8px",
                                  background: "#ffffff",
                                  display: "grid",
                                  gap: 4,
                                  minWidth: 120,
                                }}
                              >
                                <div style={{ fontSize: 12 }}>
                                  <strong
                                    onClick={() => setDemandFillSelectedDest(demandFillSelectedDest === city.name ? null : city.name)}
                                    style={{
                                      cursor: "pointer",
                                      color: demandFillSelectedDest === city.name || demandFillHoveredDest === city.name ? "#2563eb" : undefined,
                                      textDecoration: demandFillSelectedDest === city.name ? "underline" : undefined,
                                      userSelect: "none",
                                    }}
                                  >{city.name}</strong>
                                  {" • "}size {city.size}
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-start" }}>
                                  {destOrder.map(dest => {
                                    const destBoxes = boxesByDest.get(dest)!
                                    const isHighlighted = demandFillHoveredDest === dest || demandFillSelectedDest === dest
                                    return (
                                      <div
                                        key={dest}
                                        style={{
                                          display: "inline-flex",
                                          flexWrap: "wrap",
                                          gap: 3,
                                          padding: 2,
                                          borderRadius: 4,
                                          outline: isHighlighted ? "2px solid #2563eb" : "2px solid transparent",
                                          transition: "outline-color 0.1s",
                                        }}
                                        onMouseEnter={() => setDemandFillHoveredDest(dest)}
                                        onMouseLeave={() => setDemandFillHoveredDest(null)}
                                      >
                                        {destBoxes.map((box, i) => (
                                          <span
                                            key={i}
                                            title={box.tooltip}
                                            style={{
                                              width: 12,
                                              height: 12,
                                              borderRadius: 3,
                                              border: `1px solid ${box.tone === "green" ? "#5fbf72" : box.tone === "red" ? "#ef4444" : "#c8d0c8"}`,
                                              background: box.tone === "green" ? "#5fbf72" : box.tone === "red" ? "#fca5a5" : "#ffffff",
                                              display: "inline-block",
                                              boxSizing: "border-box",
                                            }}
                                          />
                                        ))}
                                      </div>
                                    )
                                  })}
                                </div>
                                <div style={{ color: "#56635a", fontSize: 11 }}>
                                  Moved{" "}
                                  <span style={{ color: unmovedCount > 0 ? (unmovedTone === "red" ? "#b42318" : "#56635a") : "#1a7c3c", fontWeight: 600 }}>
                                    {movedOutboundCubes}/{outboundCubes}
                                  </span>
                                </div>
                              </div>
                            )
                          },
                        )}
                      </div>
                    </div>
                  )}
                  {canEditOperations
                    ? currentPlayerBureaucracyPlansByMode.map(({ mode, plans }) => (
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
                          plans.map(plan => {
                            const podCityIds =
                              plan.availableCityIds.length > 0
                                ? plan.availableCityIds
                                : plan.selectedCityIds
                            return (
                              <div
                                key={plan.id}
                                style={{
                                  border: "1px solid #e1e6df",
                                  borderRadius: 8,
                                  padding: 10,
                                  display: "grid",
                                  gap: 10,
                                }}
                              >
                                <div style={{ display: "grid", gap: 4 }}>
                                  <div>
                                    <strong>{plan.serviceLabel}</strong>
                                  </div>
                                  <div style={{ color: "#56635a", fontSize: 12 }}>
                                    {plan.route.mode === "rail" && getRailTraction(plan.route) === "electric"
                                      ? "Electric rail"
                                      : MODE_LABELS[plan.route.mode]}
                                    {plan.segmentCount > 1 ? ` • ${plan.segmentCount} segments` : ""}
                                    {" • "}Route cities {podCityIds.length}
                                  </div>
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                  {podCityIds.map(cityId => (
                                    <div
                                      key={`${plan.id}-pod-city-${cityId}`}
                                      style={{
                                        border: "1px solid #d8dfd5",
                                        borderRadius: 999,
                                        padding: "4px 8px",
                                        background: "#fafcf9",
                                        fontSize: 12,
                                        color: "#324236",
                                      }}
                                    >
                                      {cityMap[cityId]?.name ?? cityId}
                                    </div>
                                  ))}
                                </div>
                                <label
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    fontSize: 13,
                                    flexWrap: "wrap",
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
                                    disabled={!canEditOperations}
                                    style={{
                                      minWidth: 220,
                                      padding: "6px 8px",
                                      borderRadius: 8,
                                      border: `1px solid ${getRouteSelectColors(plan.route.mode).border}`,
                                      background: getRouteSelectColors(plan.route.mode).background,
                                      color: getRouteSelectColors(plan.route.mode).color,
                                    }}
                                  >
                                    <option value="">No vehicle assigned</option>
                                    {currentPlayerOwnedVehicleCards
                                      .filter(card => card.type === getVehicleTypeForMode(plan.route.mode))
                                      .map(card => (
                                        <option key={card.id} value={card.id}>
                                          #{card.number} {card.name} ({currentPlayerOwnedVehicleCountsByCardId[card.id] ?? 0})
                                        </option>
                                      ))}
                                  </select>
                                  {!plan.vehicleCard && (
                                    <span style={{ color: "#9b1c1c", fontSize: 12 }}>
                                      Assign a matching vehicle to run this route.
                                    </span>
                                  )}
                                </label>
                                {plan.availableCityIds.length > 2 && (
                                  <div style={{ color: "#56635a", fontSize: 12 }}>
                                    Route membership is managed in the route editor above.
                                  </div>
                                )}
                              </div>
                            )
                          })
                        )}
                      </div>
                    ))
                    : (
                      <>
                        {/* Two-column row: financial summary (left) + vehicles (right) */}
                        <div style={{ display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
                          {/* Financial summary */}
                          <div
                            style={{
                              border: "1px solid #e1e6df",
                              borderRadius: 10,
                              padding: 10,
                              background: "#ffffff",
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              flex: "0 0 auto",
                              minWidth: 220,
                            }}
                          >
                            {(() => {
                              const prevHistory = currentPlayerBureaucracySummary.player.periodHistory ?? []
                              const prev = prevHistory.length > 0 ? prevHistory[prevHistory.length - 1] : null
                              const netDelta = prev !== null ? currentPlayerBureaucracySummary.netRevenue - prev.netRevenue : null
                              const paxDelta = prev !== null ? currentPlayerBureaucracySummary.totalPassengersServed - prev.passengersServed : null
                              const delta = (val: number, isCurrency: boolean) => {
                                const sign = val >= 0 ? "+" : ""
                                const text = isCurrency ? `${sign}${formatCurrency(val)}` : `${sign}${val.toLocaleString()}`
                                const color = val >= 0 ? "#1a7c3c" : "#b42318"
                                return <span style={{ color, fontSize: 11, fontWeight: 600, marginLeft: 6 }}>{text}</span>
                              }
                              return (
                                <>
                                  <div style={{ fontSize: 13 }}><strong>Summary</strong></div>
                                  <div style={{ fontSize: 13 }}>Revenue: {formatCurrency(currentPlayerBureaucracySummary.totalRevenue)}</div>
                                  <div style={{ fontSize: 13 }}>Operating cost: {formatCurrency(currentPlayerBureaucracySummary.totalOperatingCost)}</div>
                                  <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>Crew: {formatCurrency(currentPlayerBureaucracySummary.totalCrewCost)}</div>
                                  <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>Maintenance: {formatCurrency(currentPlayerBureaucracySummary.totalMaintenanceCost)}</div>
                                  <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>Balance: {formatCurrency(currentPlayerBureaucracySummary.totalBalanceAdjustmentCost)}</div>
                                  <div style={{ paddingLeft: 12, color: "#56635a", fontSize: 12 }}>Fuel: {formatCurrency(currentPlayerBureaucracySummary.totalFuelCost)}</div>
                                  <div style={{ fontSize: 13 }}><strong>Net:</strong> {formatCurrency(currentPlayerBureaucracySummary.netRevenue)}{netDelta !== null && delta(netDelta, true)}</div>
                                  <div style={{ fontSize: 13 }}>Passengers served: {currentPlayerBureaucracySummary.totalPassengersServed.toLocaleString()}{paxDelta !== null && delta(paxDelta, false)}</div>
                                </>
                              )
                            })()}
                          </div>
                          {/* Vehicles */}
                          {(() => {
                            // Compute plan → color map using same union-find grouping as network maps
                            const POD_COLORS_MAP = ["#2563eb", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#be185d", "#65a30d", "#c2410c"]
                            const eligibleForColor = currentPlayerActiveBureaucracyPlans.filter(p => p.selectedCityIds.length >= 2)
                            const _parent = new Map<string, string>()
                            const _find = (x: string): string => {
                              if (!_parent.has(x)) _parent.set(x, x)
                              const p = _parent.get(x)!
                              if (p !== x) { const r = _find(p); _parent.set(x, r); return r }
                              return x
                            }
                            for (const plan of eligibleForColor) {
                              for (let i = 1; i < plan.selectedCityIds.length; i++) {
                                const a = _find(plan.selectedCityIds[0]), b = _find(plan.selectedCityIds[i])
                                _parent.set(a, b)
                              }
                            }
                            const _netsByRoot = new Map<string, typeof eligibleForColor>()
                            for (const plan of eligibleForColor) {
                              const root = _find(plan.selectedCityIds[0])
                              if (!_netsByRoot.has(root)) _netsByRoot.set(root, [])
                              _netsByRoot.get(root)!.push(plan)
                            }
                            const planColorById = new Map<string, string>()
                            for (const netPlans of _netsByRoot.values()) {
                              netPlans.forEach((plan, pi) => {
                                planColorById.set(plan.id, POD_COLORS_MAP[pi % POD_COLORS_MAP.length])
                              })
                            }

                            return (
                          <div
                            style={{
                              border: "1px solid #e1e6df",
                              borderRadius: 10,
                              padding: 10,
                              background: "#ffffff",
                              display: "flex",
                              flexDirection: "column",
                              gap: 8,
                              flex: "1 1 0",
                              minWidth: 240,
                            }}
                          >
                          <div><strong>Vehicles</strong></div>
                          {currentPlayerActiveBureaucracyPlans.filter(p => p.vehicleCard !== null).length === 0 ? (
                            <div style={{ color: "#56635a", fontSize: 13 }}>No vehicles assigned to any route.</div>
                          ) : (
                            [...currentPlayerActiveBureaucracyPlans]
                              .filter(p => p.vehicleCard !== null)
                              .sort((a, b) => b.passengersServed - a.passengersServed)
                              .map(plan => (
                                <div
                                  key={plan.id}
                                  style={{
                                    border: "1px solid #e1e6df",
                                    borderRadius: 8,
                                    padding: "8px 10px",
                                    background: "#fafcf9",
                                    display: "grid",
                                    gap: 4,
                                  }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                                    <div style={{ fontSize: 13 }}>
                                      <strong>
                                        {plan.route.mode === "bus" ? "🚌" : plan.route.mode === "rail" ? "🚂" : "✈️"}
                                        {" "}#{plan.vehicleCard?.number} {plan.vehicleCard?.name}
                                      </strong>
                                    </div>
                                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                                      <div style={{ fontSize: 15, fontWeight: 800, color: plan.netRevenue >= 0 ? "#1a7c3c" : "#b42318" }}>
                                        {formatCurrency(plan.netRevenue)}
                                      </div>
                                    </div>
                                  </div>
                                  <div style={{ color: planColorById.get(plan.id) ?? "#56635a", fontSize: 12, fontWeight: 600 }}>
                                    {plan.serviceLabel}
                                  </div>
                                  <div style={{ color: "#324236", fontSize: 12 }}>
                                    <span
                                      style={{
                                        color: plan.selectedFleetSize < plan.demandFleetSize ? "#b42318" : "#324236",
                                        fontWeight: plan.selectedFleetSize < plan.demandFleetSize ? 700 : 400,
                                      }}
                                    >
                                      Qty {plan.selectedFleetSize} / {plan.demandFleetSize} Demand
                                    </span>
                                    {" • "}{plan.selectedTrips} trips
                                    {" • "}👥 {plan.passengersServed.toLocaleString()}
                                    {" • "}Revenue {formatCurrency(plan.revenue)}
                                    {" • "}Cost {formatCurrency(plan.operatingCost)}
                                  </div>
                                </div>
                              ))
                          )}
                        </div>
                            )
                          })()}
                        </div>
                        {/* Per-network modules: map on top, pairing cards below */}
                        {(() => {
                          const POD_COLORS_NET = ["#2563eb", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#be185d", "#65a30d", "#c2410c"]
                          const eligiblePlans = currentPlayerActiveBureaucracyPlans.filter(p => p.selectedCityIds.length >= 2)
                          if (eligiblePlans.length === 0 && currentPlayerAggregatedCityPairings.length === 0) return null

                          // Union-find to group plans into networks
                          const parent = new Map<string, string>()
                          const find = (x: string): string => {
                            if (!parent.has(x)) parent.set(x, x)
                            const p = parent.get(x)!
                            if (p !== x) { const r = find(p); parent.set(x, r); return r }
                            return x
                          }
                          for (const plan of eligiblePlans) {
                            for (let i = 1; i < plan.selectedCityIds.length; i++) {
                              const a = find(plan.selectedCityIds[0]), b = find(plan.selectedCityIds[i])
                              parent.set(a, b)
                            }
                          }
                          const networksByRoot = new Map<string, typeof eligiblePlans>()
                          for (const plan of eligiblePlans) {
                            const root = find(plan.selectedCityIds[0])
                            if (!networksByRoot.has(root)) networksByRoot.set(root, [])
                            networksByRoot.get(root)!.push(plan)
                          }

                          // Build plan → color map
                          const planColorById = new Map<string, string>()
                          for (const netPlans of networksByRoot.values()) {
                            netPlans.forEach((plan, pi) => {
                              planColorById.set(plan.id, POD_COLORS_NET[pi % POD_COLORS_NET.length])
                            })
                          }

                          const networks = [...networksByRoot.values()]

                          return (
                            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                              {networks.map((plans, ni) => {
                                const networkPlanIdSet = new Set(plans.map(p => p.id))
                                const networkPairings = currentPlayerAggregatedCityPairings
                                  .filter(pair => pair.planIds.some(id => networkPlanIdSet.has(id)))

                                const cityIdSet = new Set<string>()
                                for (const plan of plans) {
                                  for (const id of plan.selectedCityIds) cityIdSet.add(id)
                                }
                                const netCities = [...cityIdSet].map(id => cityMap[id]).filter(Boolean)
                                if (netCities.length < 2) return null

                                // Stable key for grid size persistence across rounds
                                const netKey = [...cityIdSet].sort().join(",")

                                const worldPts = netCities.map(c => ({ id: c.id, name: c.name, ...latLngToWorld(c) }))
                                const CITY_R = 6, SVG_PAD = 30
                                const rawMinX = Math.min(...worldPts.map(p => p.x))
                                const rawMaxX = Math.max(...worldPts.map(p => p.x))
                                const rawMinY = Math.min(...worldPts.map(p => p.y))
                                const rawMaxY = Math.max(...worldPts.map(p => p.y))
                                const rangeX = Math.max(rawMaxX - rawMinX, 1)
                                const rangeY = Math.max(rawMaxY - rawMinY, 1)

                                // Grid sizing: card cell dimensions + default map span from aspect ratio
                                const CELL_W = 230, CELL_H = 76, CELL_GAP = 6
                                const aspectRatio = rangeX / rangeY
                                const defaultCols = aspectRatio < 0.75 ? 2 : 3
                                const defaultRows = aspectRatio < 0.75 ? 3 : 2
                                const gridSize = networkMapGridSizes[netKey] ?? { cols: defaultCols, rows: defaultRows }
                                const mapCols = gridSize.cols
                                const mapRows = gridSize.rows
                                const mapHeight = mapRows * (CELL_H + CELL_GAP) - CELL_GAP
                                const setGridSize = (cols: number, rows: number) =>
                                  setNetworkMapGridSizes(prev => ({ ...prev, [netKey]: { cols: Math.max(1, Math.min(5, cols)), rows: Math.max(1, Math.min(6, rows)) } }))

                                // SVG viewBox matches container dimensions exactly so map fills the space
                                const SVG_W = mapCols * (CELL_W + CELL_GAP) - CELL_GAP
                                const SVG_H = mapHeight

                                const drawW = SVG_W - SVG_PAD * 2
                                const drawH = SVG_H - SVG_PAD * 2
                                const scale = Math.min(drawW / rangeX, drawH / rangeY)
                                const toSvgX = (wx: number) => SVG_PAD + (drawW - rangeX * scale) / 2 + (wx - rawMinX) * scale
                                const toSvgY = (wy: number) => SVG_PAD + (drawH - rangeY * scale) / 2 + (wy - rawMinY) * scale
                                const pts = worldPts.map(p => ({ ...p, x: toSvgX(p.x), y: toSvgY(p.y) }))
                                const ptById = new Map(pts.map(p => [p.id, p]))

                                const planSegs = plans.map((plan, pi) => {
                                  const color = POD_COLORS_NET[pi % POD_COLORS_NET.length]
                                  const citySet = new Set(plan.selectedCityIds)
                                  const allPlayerRoutes = getPlayerOwnedNetworkRoutes(game, plan.route.ownerId ?? currentPlayer?.id ?? "")
                                  const routeLines = allPlayerRoutes
                                    .filter(r => r.mode === plan.route.mode && citySet.has(r.cityA) && citySet.has(r.cityB))
                                    .map(r => {
                                      const a = ptById.get(r.cityA), b = ptById.get(r.cityB)
                                      return a && b ? { ax: a.x, ay: a.y, bx: b.x, by: b.y } : null
                                    })
                                    .filter(Boolean) as { ax: number; ay: number; bx: number; by: number }[]
                                  const segMap = new Map<string, { ax: number; ay: number; bx: number; by: number; cubes: number }>()
                                  for (const e of plan.simplifiedLedgerEntries) {
                                    const a = ptById.get(e.originCityId), b = ptById.get(e.destinationCityId)
                                    if (!a || !b) continue
                                    const k = `${e.originCityId}:${e.destinationCityId}`
                                    const ex = segMap.get(k)
                                    if (ex) ex.cubes += e.cubeCount
                                    else segMap.set(k, { ax: a.x, ay: a.y, bx: b.x, by: b.y, cubes: e.cubeCount })
                                  }
                                  return { color, routeLines, segs: [...segMap.values()] }
                                })
                                const allSegs = planSegs.flatMap(p => p.segs)
                                const maxCubes = Math.max(1, ...allSegs.map(s => s.cubes))

                                const LANE = 5, SHRINK = CITY_R + 6

                                // Pre-compute US outline in this SVG's coordinate space
                                const outlinePathD = "M " + usOutline.map(([lng, lat]) => {
                                  const p = latLngToWorld({ lng, lat })
                                  return `${toSvgX(p.x).toFixed(1)},${toSvgY(p.y).toFixed(1)}`
                                }).join(" L ") + " Z"

                                // Region shading blobs for cities in this network + nearby anchors
                                const netRegionBlobs = [
                                  ...netCities.flatMap(city => {
                                    const region = getPrimaryCityDeckRegion(city.region)
                                    if (!region) return []
                                    const pt = ptById.get(city.id)
                                    if (!pt) return []
                                    return [{ key: city.id, region, cx: pt.x, cy: pt.y, r: (REGION_SHADE_BASE_RADIUS[region] + (city.size ?? 0) * 8) * scale }]
                                  }),
                                  ...REGION_SHADE_ANCHORS.map(anchor => {
                                    const wp = latLngToWorld(anchor)
                                    return { key: `anc-${anchor.id}`, region: anchor.region, cx: toSvgX(wp.x), cy: toSvgY(wp.y), r: anchor.radius * scale }
                                  }),
                                ]

                                const clipId = `nmap-clip-${ni}`
                                const blurId = `nmap-blur-${ni}`

                                const planColors = planSegs.map(s => s.color)
                                const modeSet = new Set(plans.map(p => p.route.mode))
                                const modeLabel = [
                                  modeSet.has("bus") ? "🚌 Bus" : null,
                                  modeSet.has("rail") ? "🚂 Rail" : null,
                                  modeSet.has("air") ? "✈️ Air" : null,
                                ].filter(Boolean).join(" · ")

                                return (
                                  <div
                                    key={ni}
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
                                    {/* Route legend */}
                                    <div style={{ fontSize: 11, color: "#56635a", display: "flex", gap: 8, flexWrap: "wrap" }}>
                                      <span>{modeLabel} · {netCities.length} cities</span>
                                      {plans.map((plan, pi) => (
                                        <span key={plan.id} style={{ color: planColors[pi], fontWeight: 600 }}>
                                          ● {plan.serviceLabel}
                                        </span>
                                      ))}
                                    </div>
                                    {/* CSS Grid: map spans mapCols×mapRows cells, cards auto-fill remaining cells */}
                                    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, ${CELL_W}px)`, gridAutoRows: `minmax(${CELL_H}px, auto)`, gap: CELL_GAP, alignItems: "start" }}>
                                      {/* Map spanning mapCols × mapRows */}
                                      <div
                                        style={{
                                          gridColumn: `span ${mapCols}`,
                                          gridRow: `span ${mapRows}`,
                                          position: "relative",
                                          height: mapHeight,
                                        }}
                                      >
                                        <svg
                                          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                                          style={{ display: "block", width: "100%", height: "100%", borderRadius: 8, border: "1px solid #d8dfd5", overflow: "hidden" }}
                                        >
                                          <defs>
                                            <clipPath id={clipId}>
                                              <rect x="0" y="0" width={SVG_W} height={SVG_H} rx="7" />
                                            </clipPath>
                                            <filter id={blurId} x="-80%" y="-80%" width="260%" height="260%">
                                              <feGaussianBlur stdDeviation="20" />
                                            </filter>
                                            {planSegs.map(({ color }, pi) => (
                                              <marker key={pi} id={`na${ni}p${pi}`} markerWidth="2.5" markerHeight="2.5" refX="2" refY="1.25" orient="auto">
                                                <path d="M0,0 L0,2.5 L2.5,1.25 z" fill={color} />
                                              </marker>
                                            ))}
                                          </defs>

                                          {/* Land background */}
                                          <rect x="0" y="0" width={SVG_W} height={SVG_H} fill={MAP_OUTLINE_STYLE.fill} />

                                          {/* US outline + region blobs, clipped to viewBox */}
                                          <g clipPath={`url(#${clipId})`}>
                                            <path
                                              d={outlinePathD}
                                              fill={MAP_OUTLINE_STYLE.fill}
                                              stroke={MAP_OUTLINE_STYLE.stroke}
                                              strokeWidth={1.5}
                                              opacity={MAP_OUTLINE_STYLE.opacity}
                                            />
                                            <g filter={`url(#${blurId})`}>
                                              {netRegionBlobs.map(blob => (
                                                <circle
                                                  key={blob.key}
                                                  cx={blob.cx}
                                                  cy={blob.cy}
                                                  r={blob.r}
                                                  fill={colorWithOpacity(REGION_STYLES[blob.region].fill, 0.32)}
                                                />
                                              ))}
                                            </g>

                                            {/* Route infrastructure lines (faint) */}
                                            {planSegs.flatMap(({ color, routeLines }, pi) =>
                                              routeLines.map((r, ri) => (
                                                <line key={`rl-${pi}-${ri}`} x1={r.ax} y1={r.ay} x2={r.bx} y2={r.by} stroke={color} strokeWidth="2" strokeLinecap="round" opacity="0.2" />
                                              ))
                                            )}

                                            {/* Traffic flow arrows */}
                                            {planSegs.flatMap(({ color, segs }, pi) =>
                                              segs.map((s, si) => {
                                                const ddx = s.bx - s.ax, ddy = s.by - s.ay
                                                const len = Math.sqrt(ddx*ddx + ddy*ddy) || 1
                                                const px = -ddy/len*LANE, py = ddx/len*LANE
                                                const x1 = s.ax + px + ddx/len*SHRINK
                                                const y1 = s.ay + py + ddy/len*SHRINK
                                                const x2 = s.bx + px - ddx/len*SHRINK
                                                const y2 = s.by + py - ddy/len*SHRINK
                                                const sw = 1 + (s.cubes/maxCubes)*4
                                                return (
                                                  <line key={`seg-${pi}-${si}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0.85" markerEnd={`url(#na${ni}p${pi})`} />
                                                )
                                              })
                                            )}

                                            {/* City dots and labels */}
                                            {pts.map(p => (
                                              <g key={p.id}>
                                                <circle cx={p.x} cy={p.y} r={CITY_R} fill="#223024" stroke="#ffffff" strokeWidth="1.5" />
                                                <text x={p.x} y={p.y + CITY_R + 11} textAnchor="middle" fontSize="10" fill="#1a3021" fontFamily="system-ui,sans-serif" fontWeight="600" stroke="#ffffff" strokeWidth="2.5" paintOrder="stroke">
                                                  {p.name}
                                                </text>
                                              </g>
                                            ))}
                                          </g>
                                        </svg>
                                        {/* Bottom row control */}
                                        <div style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.85)", borderRadius: 6, padding: "2px 6px", fontSize: 11, userSelect: "none" }}>
                                          <button onClick={() => setGridSize(mapCols, mapRows - 1)} style={{ border: "none", background: "none", cursor: "pointer", padding: "0 2px", fontSize: 12, lineHeight: 1 }} title="Fewer rows">↑</button>
                                          <span style={{ color: "#56635a", minWidth: 40, textAlign: "center" }}>{mapRows} row{mapRows !== 1 ? "s" : ""}</span>
                                          <button onClick={() => setGridSize(mapCols, mapRows + 1)} style={{ border: "none", background: "none", cursor: "pointer", padding: "0 2px", fontSize: 12, lineHeight: 1 }} title="More rows">↓</button>
                                        </div>
                                        {/* Right col control */}
                                        <div style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.85)", borderRadius: 6, padding: "6px 2px", fontSize: 11, userSelect: "none" }}>
                                          <button onClick={() => setGridSize(mapCols + 1, mapRows)} style={{ border: "none", background: "none", cursor: "pointer", padding: "2px 0", fontSize: 12, lineHeight: 1 }} title="More cols">→</button>
                                          <span style={{ color: "#56635a", writingMode: "vertical-lr", textOrientation: "mixed", transform: "rotate(180deg)", minHeight: 40, textAlign: "center" }}>{mapCols} col{mapCols !== 1 ? "s" : ""}</span>
                                          <button onClick={() => setGridSize(mapCols - 1, mapRows)} style={{ border: "none", background: "none", cursor: "pointer", padding: "2px 0", fontSize: 12, lineHeight: 1 }} title="Fewer cols">←</button>
                                        </div>
                                      </div>
                                      {/* Cards — auto-placed into remaining grid cells */}
                                      {networkPairings.map(pair => {
                                        const pairColors = [...new Set(pair.planIds.map(id => planColorById.get(id)).filter(Boolean) as string[])]
                                        const unmetFinal = pair.totalDemand > 0 && pair.finalDestinationCubes < pair.totalDemand
                                        const connecting = pair.cubes - pair.finalDestinationCubes
                                        return (
                                          <div
                                            key={pair.key}
                                            style={{ border: "1px solid #e1e6df", borderRadius: 8, padding: "7px 14px", background: "#fafcf9", display: "grid", gap: 3, alignSelf: "start", overflow: "hidden" }}
                                          >
                                            <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                                              {pairColors.map((c, i) => <span key={i} style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: c, flexShrink: 0 }} />)}
                                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pair.originCityName} to {pair.destinationCityName}</span>
                                            </div>
                                            <div style={{ fontSize: 12, color: "#324236", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                              {"Moved: "}
                                              <span style={{ color: unmetFinal ? "#b42318" : "inherit", fontWeight: unmetFinal ? 700 : 400 }}>
                                                {pair.finalDestinationCubes}{unmetFinal ? `/${pair.totalDemand}` : ""}{" cubes"}
                                              </span>
                                              {connecting > 0 && <> + {connecting} connecting</>}
                                            </div>
                                            {pair.planModeStats.map((pms, idx) => {
                                              const emoji = pms.mode === "bus" ? "🚌" : pms.mode === "rail" ? "🚂" : "✈️"
                                              const routeColor = planColorById.get(pms.planId) ?? "#1a3021"
                                              return (
                                                <div key={idx} style={{ fontSize: 12, color: "#1a3021", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                                  {emoji} <span style={{ color: routeColor, fontWeight: 600 }}>{pms.passengers.toLocaleString()}</span>
                                                  {" × Fare "}{formatCurrency(pms.farePerPassenger)}{" = "}<strong>{formatCurrency(pms.payout)}</strong>
                                                </div>
                                              )
                                            })}
                                          </div>
                                        )
                                      })}
                                    </div>
                                    {/* Route optimization suggestions */}
                                    {(() => {
                                      const suggestions: Array<{ type: "add" | "remove"; cityName: string; planLabel: string; detail: string }> = []

                                      for (const plan of plans) {
                                        // Suggest adding available cities with significant unserved demand
                                        for (const cityId of plan.availableCityIds) {
                                          if (plan.selectedCityIds.includes(cityId)) continue
                                          const demandEntry = plan.cityCubeDemands.find(d => d.cityId === cityId)
                                          if (!demandEntry || demandEntry.outboundCubes <= 0) continue
                                          const stuckEntry = currentPlayerBureaucracySummary?.stuckCubesByCity.find(s => s.cityId === cityId)
                                          const stuckCount = stuckEntry?.stuckCubeCount ?? demandEntry.outboundCubes
                                          if (stuckCount <= 0) continue
                                          suggestions.push({
                                            type: "add",
                                            cityName: demandEntry.cityName,
                                            planLabel: plan.serviceLabel,
                                            detail: `+${stuckCount} demand cube${stuckCount !== 1 ? "s" : ""} served`,
                                          })
                                        }

                                        // Suggest removing cities with zero demand and no stuck cubes wanting to go there
                                        for (const status of plan.simplifiedCityStatuses) {
                                          if (status.outboundCubes > 0 || status.filledCubes > 0) continue
                                          const hasInbound = plan.simplifiedLedgerEntries.some(e => e.destinationCityId === status.cityId && e.cubeCount > 0)
                                          if (hasInbound) continue
                                          suggestions.push({
                                            type: "remove",
                                            cityName: status.cityName,
                                            planLabel: plan.serviceLabel,
                                            detail: "no demand, reduces operating cost",
                                          })
                                        }
                                      }

                                      if (suggestions.length === 0) return null
                                      return (
                                        <div style={{ marginTop: 8, padding: "8px 12px", background: "#fffbea", border: "1px solid #e6c94a", borderRadius: 8, fontSize: 12, color: "#6b4f00" }}>
                                          <div style={{ fontWeight: 700, marginBottom: 5, color: "#5a3e00" }}>💡 Route Suggestions</div>
                                          {suggestions.map((s, i) => (
                                            <div key={i} style={{ marginBottom: 3, display: "flex", gap: 6, alignItems: "flex-start" }}>
                                              <span style={{ flexShrink: 0, color: s.type === "add" ? "#1a7a38" : "#a04000" }}>
                                                {s.type === "add" ? "＋" : "－"}
                                              </span>
                                              <span>
                                                <strong>{s.type === "add" ? "Add" : "Remove"} {s.cityName}</strong>
                                                {" to "}{s.planLabel}: {s.detail}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )
                                    })()}
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })()}
                     </>
                    )
                  }
                 </>
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
                {getVehicleTypeLabel(pendingVehiclePurchaseCard.type)} • 👥{" "}
                {pendingVehiclePurchaseCard.totalPassengerCapacity.toLocaleString()} seats •{" "}
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
            <label
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                color: "#324236",
                fontSize: 13,
              }}
            >
              <span>
                Quantity (max {pendingVehiclePurchaseMaxQuantity} for this{" "}
                {getVehiclePurchaseLabel(pendingVehiclePurchaseCard.type, 1)})
              </span>
              <select
                value={pendingVehiclePurchaseQuantity}
                onChange={event => setPendingVehiclePurchaseQuantity(Number(event.target.value))}
                style={{
                  minWidth: 96,
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                }}
              >
                {Array.from({ length: pendingVehiclePurchaseMaxQuantity }, (_, index) => index + 1).map(
                  quantity => (
                    <option key={quantity} value={quantity}>
                      {quantity}
                    </option>
                  ),
                )}
              </select>
            </label>
            <div style={{ color: "#56635a", fontSize: 13 }}>
              Total cost: <strong>{formatCurrency(pendingVehiclePurchaseTotalCost)}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  setPendingVehiclePurchaseCardId(null)
                  setPendingVehiclePurchaseQuantity(1)
                }}
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
      {isEconomicsOpen && (
        <div style={resourceMarketPanelStyle}>
          <strong>Economics</strong>
          <div style={{ color: "#56635a" }}>
            Route pricing, operating costs, fuel pricing, and infrastructure costs for the current month.
          </div>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            Crew assumptions use {formatDecimal(game.operatingConfig.hoursPerDay)}h/day for{" "}
            {formatDecimal(game.operatingConfig.daysPerWeek, 0)} days/week across{" "}
            {formatDecimal(game.operatingConfig.weeksPerPeriod, 0)} weeks/month ={" "}
            {formatDecimal(getHoursPerWeek(game), 0)}h/month per fully utilized vehicle.
          </div>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            Actual crew cost scales with trips run; the table below shows the full-utilization ceiling for each vehicle.
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
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Crew / max month / vehicle</th>
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
                  {game.operatingConfig.demandPointsPerCitySize} demand points per city size
                </div>
                <div style={{ color: "#324236", fontSize: 13 }}>
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
            ...resourceMarketPanelStyle,
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
                Each city size point creates{" "}
                <strong>{game.operatingConfig.demandPointsPerCitySize}</strong> demand points.
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
                1. <strong>Purchase Equipment</strong>: make 1 vehicle purchase on your turn, either from the face-up market lineup or from a vehicle model you already own, buying up to 6 buses, 3 trains, or 1 plane.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                At month end, each vehicle deck with no purchases discards its lowest-number remaining card before the next phase.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                2. <strong>Claim Routes</strong>: each turn draw 4 city cards and keep exactly 2 to grow your hand.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                3. <strong>Operations</strong>: build rail/air links, assign vehicles, and split services. Bus routes follow connected owned cities automatically.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Use <strong>Build Track</strong> in Operations to click highlighted adjacent segments on the map and lay rail.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                4. <strong>Bureaucracy</strong>: review passenger flow and monthly operating results after services auto-run.
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Real-world crew math uses <strong>{formatDecimal(game.operatingConfig.hoursPerDay)}</strong> hours/day for{" "}
                <strong>{formatDecimal(game.operatingConfig.daysPerWeek, 0)}</strong> days/week across{" "}
                <strong>{formatDecimal(game.operatingConfig.weeksPerPeriod, 0)}</strong> weeks/month at full utilization; actual crew cost scales with trips run.
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
                <strong>Bus</strong>: routes are built from connected owned city cards and use diesel.
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
                One vehicle card can operate one matching route at a time during operations, and fuel is charged as part of each trip&apos;s operating cost.
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
                • up to {formatCurrency(getCrewCostPerWeekPerVehicle(game, "bus"))}/month/vehicle
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Train crew:{" "}
                <strong>{formatUnitRate(game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.train, 0)}/h</strong>{" "}
                • up to {formatCurrency(getCrewCostPerWeekPerVehicle(game, "train"))}/month/vehicle
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                Air crew:{" "}
                <strong>{formatUnitRate(game.operatingConfig.realWorldOperatingCosts.crewHourlyCostPerVehicle.air, 0)}/h</strong>{" "}
                • up to {formatCurrency(getCrewCostPerWeekPerVehicle(game, "air"))}/month/vehicle
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
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>Crew / max month / vehicle</th>
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
                      {getVehicleTypeIcon(card.type)} 👥{" "}
                      {card.totalPassengerCapacity.toLocaleString()} seats • {card.speed}mph • ⚙️
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
        <div style={resourceMarketPanelStyle}>
          <strong>Resource market</strong>
          <div style={{ color: "#56635a" }}>
            Fuel prices and current holdings are shown here for planning and bureaucracy context.
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {isActionLogOpen && (
        <div style={actionLogPanelStyle}>
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
      <div style={tableZoneStyle}>
        <div style={TABLE_LANE_STYLE}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "baseline",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", minWidth: 0 }}>
              <div>
              <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em" }}>
                TABLE
              </div>
                <strong>
                  {game.currentPhase === "purchase-equipment"
                    ? "Vehicle market"
                    : game.currentPhase === "add-city"
                      ? "City Decks"
                      : game.currentPhase === "operations"
                        ? "Operations"
                      : game.currentPhase === "bureaucracy"
                        ? "Bureaucracy"
                        : "Player aid"}
                </strong>
              </div>
              {game.currentPhase === "purchase-equipment" && (
                <div style={{ color: "#56635a", fontSize: 12 }}>
                  {currentPlayerVehicleTotals
                    ? `Owned vehicles: ${currentPlayerVehicleTotals}.`
                    : "No owned vehicle models yet."}
                  {" "}
                  Remaining deck: {remainingVehicleCardCount} card{remainingVehicleCardCount === 1 ? "" : "s"}.
                  If nobody buys this month, the most expensive visible card is burned.
                </div>
              )}
            </div>
              <div style={{ color: "#56635a", fontSize: 13 }}>
              {game.isGameOver
                ? "Final month pod results ranked by passengers moved."
                : game.currentPhase === "purchase-equipment"
                ? "Your current vehicle models appear first in one row, followed by market purchase options."
                : game.currentPhase === "add-city"
                  ? "Draw regional city cards and keep exactly 2 to add them to your hand."
                  : game.currentPhase === "operations"
                  ? "Build tracks/routes and configure service routes by mode before running operations."
                  : game.currentPhase === "bureaucracy"
                  ? "Review how passenger cubes moved and how each route performed."
                  : "The board stays clear while reference panels open over it."}
            </div>
            </div>
            {game.isGameOver ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "grid",
                  gap: 10,
                  overflowY: "auto",
                  paddingRight: 2,
                }}
              >
                {finalRouteLeaderboard.length > 0 ? (
                  finalRouteLeaderboard.map(({ player, plan, vehicleCard }, index) => (
                    <div
                      key={`${player.id}-${plan.id}-final-route`}
                      style={{
                        border: `1px solid ${colorWithOpacity(player.color, 0.35)}`,
                        borderRadius: 14,
                        padding: 12,
                        background: colorWithOpacity(player.color, 0.08),
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <strong style={{ color: player.color }}>#{index + 1} {plan.serviceLabel}</strong>
                          <span style={{ color: "#56635a", fontSize: 12 }}>{MODE_LABELS[plan.route.mode]}</span>
                        </div>
                        <div style={{ color: "#223024", fontWeight: 800 }}>
                          {formatDecimal(plan.passengersServed, 0)} passengers
                        </div>
                      </div>
                      <div style={{ color: player.color, fontSize: 12, fontWeight: 700 }}>
                        {player.name}
                      </div>
                      <div style={{ color: "#56635a", fontSize: 12 }}>
                        Vehicle #{vehicleCard.number} • Fleet size {plan.selectedFleetSize}
                      </div>
                      <div style={{ color: "#324236", fontSize: 12 }}>
                        Cubes moved {plan.movedCubes} • Trips {plan.selectedTrips} • Revenue {formatCurrency(plan.revenue)} • Net {formatCurrency(plan.netRevenue)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div
                    style={{
                      border: "1px dashed #d8dfd5",
                      borderRadius: 14,
                      padding: 12,
                      background: "#fafcf9",
                      color: "#848484",
                      fontSize: 12,
                    }}
                  >
                    No vehicle-assigned pods recorded for the final month.
                  </div>
                )}
              </div>
            ) : game.currentPhase === "purchase-equipment" && !isSelectingCityCards && !canEditOperations ? (
              <>
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    display: "flex",
                    alignItems: "stretch",
                    gap: 8,
                    overflowX: "auto",
                    paddingRight: 2,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "stretch",
                      gap: 8,
                      flexShrink: 0,
                    }}
                  >
                    {currentPlayerOwnedVehicleCards.length === 0 ? (
                      <div
                        style={{
                          border: "1px dashed #d8dfd5",
                          borderRadius: 14,
                          padding: 12,
                          background: "#fafcf9",
                          color: "#848484",
                          fontSize: 12,
                        }}
                      >
                        You do not own any vehicle models yet.
                      </div>
                    ) : (
                      currentPlayerOwnedVehicleCards.map(card => renderVehiclePurchaseCard(card, "owned"))
                    )}
                  </div>
                  <div
                    style={{
                      borderLeft: "1px solid #d8dfd5",
                      paddingLeft: 10,
                      display: "flex",
                      alignItems: "stretch",
                      gap: 8,
                      flexShrink: 0,
                    }}
                  >
                    {visibleVehicleCards.length === 0 ? (
                      <div
                        style={{
                          border: "1px dashed #d8dfd5",
                          borderRadius: 14,
                          padding: 12,
                          background: "#fafcf9",
                          color: "#848484",
                          fontSize: 12,
                        }}
                      >
                        No face-up market cards are available right now.
                      </div>
                    ) : (
                      visibleVehicleCards.map(card => renderVehiclePurchaseCard(card, "market"))
                    )}
                  </div>
                </div>
              </>
          ) : isSelectingCityCards || canEditOperations ? (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "grid",
                gap: 12,
                overflowY: "auto",
                paddingRight: 2,
              }}
            >
              {isSelectingCityCards && (
                <>
                  <div style={{ display: "grid", gap: 8 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: "#324236",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                      }}
                    >
                      Regional city decks
                    </div>
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      Draw 4 city cards each turn starting from one region, filling from nearby decks if that region runs low, then keep exactly 2. The 2 kept cards do not need to connect.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                      {cityDecksByRegion.map(({ region, remainingCount }) => {
                        const regionStyle = REGION_STYLES[region]
                        const canDraw =
                          canManageCurrentCityOffer &&
                          !activeCityOffer &&
                          remainingCount > 0 &&
                          totalCityDeckCount >= 4

                        return (
                          <button
                            key={region}
                            type="button"
                            onClick={() => handleDrawDeck(region)}
                            disabled={!canDraw}
                            style={{
                              border: `1px solid ${activeCityOffer?.region === region ? regionStyle.stroke : colorWithOpacity(regionStyle.stroke, 0.45)}`,
                              borderRadius: 14,
                              padding: 12,
                              background:
                                activeCityOffer?.region === region
                                  ? colorWithOpacity(regionStyle.fill, 0.18)
                                  : regionStyle.surface,
                              textAlign: "left",
                              cursor: canDraw ? "pointer" : "not-allowed",
                              opacity: canDraw ? 1 : 0.65,
                              display: "grid",
                              gap: 4,
                            }}
                            >
                              <strong style={{ fontSize: 13, color: regionStyle.text }}>{region}</strong>
                              <span style={{ color: "#56635a", fontSize: 12 }}>
                                {remainingCount} cards left
                                {remainingCount > 0 && remainingCount < 4 && totalCityDeckCount >= 4
                                  ? " • fills from nearby decks"
                                  : ""}
                              </span>
                            </button>
                        )
                      })}
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 8 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: "#324236",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                      }}
                    >
                      Current draw
                    </div>
                    {activeCityOffer ? (
                      <div style={{ display: "grid", gap: 8 }}>
                        <div style={{ color: "#56635a", fontSize: 12 }}>
                          {activeCityOfferRegions.length <= 1
                            ? `${activeCityOffer.region} deck`
                            : `${activeCityOffer.region} deck + ${activeCityOfferRegions
                                .filter(region => region !== activeCityOffer.region)
                                .join(", ")}`}{" "}
                          • draw 4, then keep exactly 2. The 2 kept cards become part of your hand.
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {activeCityOffer.cityIds.map(cityId => {
                            const city = cityMap[cityId]
                            const isSelected = selectedDrawCityIds.includes(cityId)
                            const adjacencyLabels = getCityAdjacencyLabels(
                              city,
                              cityMap,
                              currentPlayerConnectedCityIds,
                            )
                            const cityRegion = getPrimaryCityDeckRegion(city?.region) ?? activeCityOffer.region
                            const regionStyle = REGION_STYLES[cityRegion]

                            return (
                              <div key={cityId}>
                                {renderCitySelectionCard({
                                  cityId,
                                  city,
                                  cityRegion,
                                  regionStyle,
                                  adjacencyLabels,
                                  isSelected,
                                  disabled: !canManageCurrentCityOffer,
                                  onClick: () => toggleSelectedCityId(cityId, "draw", "bus"),
                                })}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          border: "1px dashed #d8dfd5",
                          borderRadius: 14,
                          padding: 12,
                          background: "#fafcf9",
                          color: "#848484",
                          fontSize: 12,
                        }}
                      >
                        No city cards are currently drawn.
                      </div>
                    )}
                  </div>
                </>
              )}

              <div style={{ display: "grid", gap: 8 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    color: "#324236",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                  }}
                >
                  Owned city cards
                </div>
                {canEditOperations && (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        onClick={() => {
                          setStatusMessage("Bus routes are automatic from connected owned cities. No build step is needed.")
                        }}
                        disabled
                        style={{
                          padding: "8px 12px",
                          borderRadius: 999,
                          border: "1px solid #d8dfd5",
                          background: "#f6f8f5",
                          color: "#7b857d",
                          cursor: "not-allowed",
                          opacity: 0.9,
                        }}
                      >
                        Bus (auto)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedRouteMode("rail")
                          setSelectedOwnedCityIds([])
                          setSelectedDrawCityIds([])
                          setSelectedRailSegmentKeys([])
                          setStatusMessage("Build Track is active. Pick a segment from the Operations list or click a highlighted map segment.")
                        }}
                        disabled={!currentPlayerOwnedModes.has("rail")}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 999,
                          border: `1px solid ${selectedRouteMode === "rail" ? "#223024" : "#c7d0c4"}`,
                          background: selectedRouteMode === "rail" ? "#223024" : "#ffffff",
                          color: selectedRouteMode === "rail" ? "#ffffff" : "#223024",
                          cursor: currentPlayerOwnedModes.has("rail") ? "pointer" : "not-allowed",
                          opacity: currentPlayerOwnedModes.has("rail") ? 1 : 0.6,
                        }}
                      >
                        Build Track
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedRouteMode("air")
                          setSelectedOwnedCityIds([])
                          setSelectedDrawCityIds([])
                          setSelectedRailSegmentKeys([])
                        }}
                        disabled={!currentPlayerOwnedModes.has("air")}
                        style={{
                          padding: "8px 12px",
                          borderRadius: 999,
                          border: `1px solid ${selectedRouteMode === "air" ? "#223024" : "#c7d0c4"}`,
                          background: selectedRouteMode === "air" ? "#223024" : "#ffffff",
                          color: selectedRouteMode === "air" ? "#ffffff" : "#223024",
                          cursor: currentPlayerOwnedModes.has("air") ? "pointer" : "not-allowed",
                          opacity: currentPlayerOwnedModes.has("air") ? 1 : 0.6,
                        }}
                      >
                        Air
                      </button>
                    </div>
                    <div
                      style={{
                        border: "1px solid #d8dfd5",
                        borderRadius: 14,
                        padding: 12,
                        background: "#fafcf9",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "grid", gap: 4 }}>
                        <strong>Service routes</strong>
                        <div style={{ color: "#56635a", fontSize: 12 }}>
                          Split routes here by mode, drag cities between route boxes, and assign vehicles before running Bureaucracy.
                        </div>
                      </div>
                      {BUREAUCRACY_MODE_ORDER.map(mode => {
                        const podGroupsForMode = currentPlayerPodGroups.filter(group => group.mode === mode)

                        return (
                          <div key={`owned-card-pods-${mode}`} style={{ display: "grid", gap: 6 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#324236" }}>
                              {MODE_LABELS[mode]}
                            </div>
                            {renderOperationsPodEditor(podGroupsForMode, {
                            emptyMessage: `No ${MODE_LABELS[mode].toLowerCase()} routes are ready to split yet.`,
                            })}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {currentPlayerOwnedVehicleCards.length > 0 && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: "#324236",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                      }}
                    >
                      Your Fleet
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {currentPlayerOwnedVehicleCards.map(card => renderVehiclePurchaseCard(card, "owned"))}
                    </div>
                  </div>
                )}
                {currentPlayerOwnedCityCards.length === 0 ? (
                  <div
                    style={{
                      border: "1px dashed #d8dfd5",
                      borderRadius: 14,
                      padding: 12,
                      background: "#fafcf9",
                      color: "#848484",
                      fontSize: 12,
                    }}
                  >
                    You do not own any city cards yet.
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {currentPlayerOwnedCityCards.map(city => {
                      const isSelected = selectedOwnedCityIds.includes(city.id)
                      const adjacencyLabels = getCityAdjacencyLabels(
                        city,
                        cityMap,
                        currentPlayerConnectedCityIds,
                      )
                      const cityRegion = getPrimaryCityDeckRegion(city.region)
                      const regionStyle = cityRegion ? REGION_STYLES[cityRegion] : null
                      const mode =
                        selectedRouteMode === "air"
                          ? "air"
                          : selectedRouteMode === "bus" || activeCityOffer
                            ? "bus"
                            : "rail"
                      const disabled =
                        !canEditOperations ||
                        mode === "rail" ||
                        !currentPlayerOwnedModes.has(mode)

                      return (
                        <div key={city.id}>
                          {renderCitySelectionCard({
                            cityId: city.id,
                            city,
                            cityRegion,
                            regionStyle: regionStyle ?? {
                              fill: "#d8dfd5",
                              stroke: "#9aa89e",
                              surface: "#ffffff",
                              text: "#56635a",
                            },
                            adjacencyLabels,
                            isSelected,
                            disabled,
                            onClick: () => toggleSelectedCityId(city.id, "owned", mode),
                          })}
                        </div>
                      )
                    })}
                  </div>
                )}
                {otherPlayerNetworkSummaries.length > 0 && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: "#324236",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                      }}
                    >
                      Other player networks
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                      {otherPlayerNetworkSummaries.map(({ player, ownedCityCards, connectedRoutes }) => (
                        <div
                          key={`${player.id}-other-network`}
                          style={{
                            border: `1px solid ${colorWithOpacity(player.color, 0.35)}`,
                            borderRadius: 12,
                            padding: 10,
                            background: colorWithOpacity(player.color, 0.08),
                            display: "grid",
                            gap: 6,
                          }}
                        >
                          <div style={{ color: player.color, fontSize: 13, fontWeight: 800 }}>
                            {player.name}
                          </div>
                          <div style={{ fontSize: 12, color: "#324236" }}>
                            <strong>Owned cities:</strong>{" "}
                            {ownedCityCards.length > 0 ? ownedCityCards.join(", ") : "None yet"}
                          </div>
                          <div style={{ fontSize: 12, color: "#324236" }}>
                            <strong>Connected segments:</strong>{" "}
                            {connectedRoutes.length > 0 ? connectedRoutes.join("; ") : "None yet"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gap: 8,
                color: "#56635a",
                fontSize: 13,
              }}
            >
              <div>
                Use the action buttons above the table for references, logs, and turn flow.
              </div>
              <div>
                The board stays centered while ledgers and markets open over it like table aids instead of full-screen menus.
              </div>
            </div>
          )}
        </div>
        <div style={TABLE_LANE_STYLE}>
          {isSelectingCityCards ? (
            <>
              <div>
                <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em" }}>
                  PICK SUMMARY
                </div>
                <strong>{selectionSummary}</strong>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  type="button"
                  onClick={handleConfirmPicks}
                  disabled={!canConfirmPicks}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    cursor: canConfirmPicks ? "pointer" : "not-allowed",
                    background: canConfirmPicks ? "#223024" : "#dfe5de",
                    color: "#ffffff",
                    fontWeight: 700,
                  }}
                >
                  Confirm picks
                </button>
                <button
                  type="button"
                  onClick={() => resetSelection()}
                    disabled={
                      selectedRouteMode === null &&
                      selectedCityIds.length === 0 &&
                      selectedRailSegmentKeys.length === 0
                    }
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: "1px solid #c7d0c4",
                      cursor:
                        selectedRouteMode === null &&
                        selectedCityIds.length === 0 &&
                        selectedRailSegmentKeys.length === 0
                          ? "not-allowed"
                          : "pointer",
                      background:
                        selectedRouteMode === null &&
                        selectedCityIds.length === 0 &&
                        selectedRailSegmentKeys.length === 0
                          ? "#f2f2f2"
                          : "#ffffff",
                    }}
                >
                  Clear
                </button>
              </div>
              <div
                style={{
                  border: "1px solid #d8dfd5",
                  borderRadius: 12,
                  padding: 14,
                  background: "#ffffff",
                  color: "#56635a",
                  fontSize: 13,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div>Draw 4 city cards and keep exactly 2. Those cards are added to your hand when you confirm picks.</div>
                <div>Route building happens during Operations.</div>
              </div>
            </>
          ) : canEditOperations ? (
            <>
              <div>
                <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em" }}>
                  OPERATIONS PREVIEW
                </div>
                <strong>{selectionSummary}</strong>
              </div>
              {selectedRouteMode === "air" && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(160px, 1fr))",
                    gap: 8,
                  }}
                >
                  <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#324236" }}>
                    Plane city A
                    <select
                      value={selectedOwnedCityIds[0] ?? ""}
                      onChange={event => handleSelectAirCity(0, event.target.value)}
                      style={{
                        border: "1px solid #c7d0c4",
                        borderRadius: 8,
                        background: "#ffffff",
                        padding: "6px 8px",
                      }}
                    >
                      <option value="" disabled>
                        Select city
                      </option>
                      {currentPlayerOwnedCityCards.map(city => (
                        <option key={`air-a-${city.id}`} value={city.id}>
                          {city.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#324236" }}>
                    Plane city B
                    <select
                      value={selectedOwnedCityIds[1] ?? ""}
                      onChange={event => handleSelectAirCity(1, event.target.value)}
                      style={{
                        border: "1px solid #c7d0c4",
                        borderRadius: 8,
                        background: "#ffffff",
                        padding: "6px 8px",
                      }}
                    >
                      <option value="" disabled>
                        Select city
                      </option>
                      {currentPlayerOwnedCityCards
                        .filter(city => city.id !== selectedOwnedCityIds[0])
                        .map(city => (
                          <option key={`air-b-${city.id}`} value={city.id}>
                            {city.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {selectedRouteMode !== "rail" && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRouteMode("rail")
                      setSelectedOwnedCityIds([])
                      setSelectedDrawCityIds([])
                      setSelectedRailSegmentKeys([])
                      setStatusMessage("Build Track is active. Pick a segment from the Operations list or click a highlighted map segment.")
                    }}
                    disabled={!currentPlayerOwnedModes.has("rail")}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: "1px solid #c7d0c4",
                      cursor: currentPlayerOwnedModes.has("rail") ? "pointer" : "not-allowed",
                      background: "#ffffff",
                      color: "#223024",
                      fontWeight: 700,
                      opacity: currentPlayerOwnedModes.has("rail") ? 1 : 0.6,
                    }}
                  >
                    Build Track
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleClaim}
                  disabled={!canConfirmSelectedClaim}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    cursor:
                      canConfirmSelectedClaim
                        ? "pointer"
                        : "not-allowed",
                    background:
                      canConfirmSelectedClaim
                        ? "#223024"
                        : "#dfe5de",
                    color: "#ffffff",
                    fontWeight: 700,
                  }}
                >
                  {selectedRouteMode === "rail" ? "Confirm" : "Build route"}
                </button>
                <button
                  type="button"
                  onClick={() => resetSelection()}
                  disabled={
                    selectedRouteMode === null &&
                    selectedCityIds.length === 0 &&
                    selectedRailSegmentKeys.length === 0
                  }
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid #c7d0c4",
                    cursor:
                      selectedRouteMode === null &&
                      selectedCityIds.length === 0 &&
                      selectedRailSegmentKeys.length === 0
                        ? "not-allowed"
                        : "pointer",
                    background:
                      selectedRouteMode === null &&
                      selectedCityIds.length === 0 &&
                      selectedRailSegmentKeys.length === 0
                        ? "#f2f2f2"
                        : "#ffffff",
                  }}
                >
                  Clear
                </button>
              </div>
              {selectedRouteMode === "rail" && (
                <div style={{ color: "#56635a", fontSize: 12, lineHeight: 1.4 }}>
                  Track cost:{" "}
                  <strong style={{ color: canAffordSelectedClaim ? "#324236" : "#9b1c1c" }}>
                    {formatCurrency(selectedClaimPreview?.claimCost ?? 0)}
                  </strong>
                </div>
              )}
              {currentPlayerOwnedModes.has("rail") && (
                <div
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    padding: 12,
                    background: "#ffffff",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                    <strong>Available track segments</strong>
                    <span style={{ color: "#56635a", fontSize: 12 }}>
                      {claimableRailSegments.length} ready
                    </span>
                  </div>
                  <div style={{ color: "#56635a", fontSize: 12 }}>
                    Pick a segment here, then click <strong>{selectedRouteMode === "rail" ? "Confirm" : "Build Track"}</strong>.
                  </div>
                  {claimableRailSegments.length === 0 ? (
                    <div style={{ color: "#56635a", fontSize: 12 }}>
                      No owned adjacent city pairs are ready for new rail track.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {claimableRailSegments.map(segment => {
                        const isSelected = selectedRailSegmentKeys.includes(segment.id)

                        return (
                          <button
                            key={`operations-track-option-${segment.id}`}
                            type="button"
                            onClick={() => handleToggleRailSegment(segment.id)}
                            style={{
                              padding: "6px 10px",
                              borderRadius: 999,
                              border: `1px solid ${isSelected ? currentPlayer?.color ?? "#223024" : "#c7d0c4"}`,
                              background: isSelected
                                ? colorWithOpacity(currentPlayer?.color ?? "#223024", 0.12)
                                : "#ffffff",
                              color: "#223024",
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: isSelected ? 700 : 500,
                            }}
                          >
                            {segment.cityA.name} - {segment.cityB.name}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {selectedClaimPreview ? (
                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    display: "grid",
                    gap: 8,
                    fontSize: 13,
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    padding: 12,
                    background: "#ffffff",
                    color: "#324236",
                    overflowY: "auto",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{selectionSummary}</strong>
                    <span style={{ color: selectedClaimPreview.valid ? "#2a7f3b" : "#9b1c1c" }}>
                      {selectedClaimPreview.valid ? "Available" : "Unavailable"}
                    </span>
                  </div>
                  <div>
                    {selectedRouteMode === "rail"
                      ? `Track segments selected: ${selectedRailSegmentKeys.length}`
                      : `Selected cities: ${selectedCities.map(city => city.name).join(", ")}`}
                  </div>
                  {optionMessage && <div style={{ color: "#9b1c1c" }}>{optionMessage}</div>}
                  {selectedClaimPreview.valid && (
                    <div style={{ color: "#324236", fontSize: 13 }}>
                      {selectedRouteMode === "rail"
                        ? "Ready to build the selected track."
                        : "Ready to build the selected route."}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  style={{
                    border: "1px dashed #d8dfd5",
                    borderRadius: 12,
                    padding: 14,
                    background: "#ffffff",
                    color: "#56635a",
                    fontSize: 13,
                  }}
                >
                  Select air or build track mode, then pick owned cities or click an available rail segment chip/map highlight.
                </div>
              )}
            </>
          ) : game.currentPhase === "purchase-equipment" ? (
            <>
              <div>
                <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em" }}>
                  MARKET NOTES
                </div>
                <strong>{currentPlayer?.name ?? "Current player"}</strong>
              </div>
              <div style={{ display: "grid", gap: 8, fontSize: 13, color: "#324236" }}>
                <div>
                  Cash on hand: <strong>{formatCurrency(currentPlayer?.money ?? 0)}</strong>
                </div>
                <div>
                  Purchase used this turn: <strong>{hasUsedVehiclePurchase ? "Yes" : "No"}</strong>
                </div>
                <div>
                  Next after purchase:{" "}
                  <strong>
                    {shouldAdvancePhase
                      ? formatPhaseLabel(getNextPhase(game.currentPhase))
                      : nextPlayer?.name ?? "Next player"}
                  </strong>
                </div>
                {pendingVehiclePurchaseCard ? (
                  <div
                    style={{
                      border: "1px solid #d8dfd5",
                      borderRadius: 12,
                      padding: 12,
                      background: "#ffffff",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <strong>
                        #{pendingVehiclePurchaseCard.number} {pendingVehiclePurchaseCard.name}
                      </strong>
                      <span>{formatCurrency(pendingVehiclePurchaseCard.purchasePrice)}</span>
                    </div>
                    <div style={{ color: "#56635a", fontSize: 12, marginTop: 6 }}>
                      Confirmation is open for this purchase.
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      border: "1px dashed #d8dfd5",
                      borderRadius: 12,
                      padding: 14,
                      background: "#ffffff",
                      color: "#56635a",
                    }}
                  >
                    Pick any vehicle model shown on the table to open its confirmation.
                  </div>
                )}
              </div>
            </>
          ) : game.isGameOver ? (
            <>
              <div>
                <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em" }}>
                  FINAL ROUTE RESULTS
                </div>
                <strong>
                  {finalRouteLeaderboard[0]
                    ? `${finalRouteLeaderboard[0].plan.serviceLabel} led the final month`
                    : "No final pod results"}
                </strong>
              </div>
              <div style={{ display: "grid", gap: 8, color: "#324236", fontSize: 13 }}>
                {finalRouteLeaderboard[0] ? (
                  <>
                    <div>
                      Top pod owner:{" "}
                      <span style={{ color: finalRouteLeaderboard[0].player.color, fontWeight: 700 }}>
                        {finalRouteLeaderboard[0].player.name}
                      </span>
                    </div>
                    <div>
                      Top pod passengers: {formatDecimal(finalRouteLeaderboard[0].plan.passengersServed, 0)}
                    </div>
                    <div>
                      Vehicle #{finalRouteLeaderboard[0].vehicleCard.number} • Fleet size {finalRouteLeaderboard[0].plan.selectedFleetSize}
                    </div>
                    <div>
                      Active final pods: {finalRouteLeaderboard.length}
                    </div>
                  </>
                ) : (
                  <div>No vehicle-assigned pods were active in the final month.</div>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <div style={{ color: "#56635a", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em" }}>
                  PHASE SUMMARY
                </div>
                <strong>{formatPhaseLabel(game.currentPhase)}</strong>
              </div>
              <div style={{ display: "grid", gap: 8, color: "#324236", fontSize: 13 }}>
                <div>Current player: {currentPlayer?.name ?? "Unknown player"}</div>
                <div>Selection: {selectionSummary}</div>
                <div>{statusMessage}</div>
              </div>
            </>
          )}
        </div>
        {areResizeHandlesVisible && (
          <div
            onMouseDown={event => beginResize("table-preview", event, tablePreviewWidth)}
            onTouchStart={event => beginTouchResize("table-preview", event, tablePreviewWidth)}
            style={getResizeHandleStyle("table-preview")}
            title="Resize table preview"
          />
        )}
      </div>
      {/* Debug log viewer */}
      {debugLogEntries.length > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: 36,
            left: 8,
            zIndex: 1001,
            width: "min(700px, 90vw)",
            maxHeight: "60vh",
            background: "#1a1a1a",
            color: "#e0e0e0",
            fontFamily: "monospace",
            fontSize: 11,
            borderRadius: 8,
            border: "1px solid #444",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "4px 8px",
              background: "#2a2a2a",
              borderBottom: "1px solid #444",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 700, color: "#f80" }}>
              Debug Log ({debugLogEntries.length} entries)
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={() => setDebugLogOpen(p => !p)}
                style={{ fontSize: 10, padding: "1px 6px", cursor: "pointer", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#ccc" }}
              >
                {debugLogOpen ? "▼ collapse" : "▲ expand"}
              </button>
              <button
                type="button"
                onClick={() => setDebugLogEntries([])}
                style={{ fontSize: 10, padding: "1px 6px", cursor: "pointer", borderRadius: 4, border: "1px solid #555", background: "#333", color: "#ccc" }}
              >
                ✕ clear
              </button>
            </div>
          </div>
          {debugLogOpen && (
            <div style={{ overflowY: "auto", maxHeight: "calc(60vh - 32px)", padding: "4px 0" }}>
              {debugLogEntries.map((entry, i) => (
                <div
                  key={i}
                  style={{
                    padding: "1px 8px",
                    borderBottom: "1px solid #2a2a2a",
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: "#888", marginRight: 6 }}>{String(i + 1).padStart(3, "0")}</span>
                  <span style={{ color: "#6af", marginRight: 6 }}>[{entry.category}]</span>
                  <span>{entry.message}</span>
                  {entry.data !== undefined && (
                    <span style={{ color: "#8f8", marginLeft: 6 }}>{JSON.stringify(entry.data)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {areResizeHandlesVisible && (
        <div
          onMouseDown={event => beginResize("table-height", event, tableZoneHeight)}
          onTouchStart={event => beginTouchResize("table-height", event, tableZoneHeight)}
          style={getResizeHandleStyle("table-height")}
          title="Resize table tray height"
        />
      )}
    </div>
  )
}