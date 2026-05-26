import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import {
  type RailUpgradeResult,
  calculateClaimRouteCost,
  type BureaucracyServiceCitiesResult,
  type BureaucracyServiceSplitResult,
  type BureaucracyVehicleCardResult,
  getVisibleVehicleMarketCardIds,
  getVehiclePurchaseLimit,
  getFuelPurchaseCost,
  getFuelUnitPrice,
  getClaimSegmentPairs,
  getEffectiveClaimCityIds,
  getConnectionOptions,
  getCurrentPlayer,
  isLastPlayerTurn,
  resolveSegmentSelection,
  resolveRouteSelection,
  type DrawCityOfferResult,
  type ResourcePurchaseResult,
} from "../engine/actions"
import {
  buildBureaucracySummaries,
  getMaxFuelUnitsCapacityForPlayer,
  getPayoutMultiplierForDistance,
} from "../engine/bureaucracy"
import {
  getAffordableFleetSize,
  buildVictoryStandings,
  calculateConnectionBonus,
  getActiveChanceCard,
  getBalanceAdjustmentPerTrip,
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
  CityDeckRegion,
  GameState,
  PurchasableResource,
  RouteMode,
  VehicleCard,
  WeeklyPhase,
} from "../engine/types"
import { CITY_DECK_REGIONS as CITY_DECK_REGION_LIST } from "../engine/types"

type Props = {
  game: GameState
  onClaimRoute: (
    mode: RouteMode,
    cityIds: string[],
    segmentPairs?: Array<[string, string]>,
  ) =>
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
  onDrawCityOffer: (region: CityDeckRegion) => DrawCityOfferResult
  onSetActiveCityOfferKeptCityIds: (cityIds: string[]) =>
    | {
        ok: true
        game: GameState
        cityIds: string[]
      }
    | {
        ok: false
        error: string
      }
  onBuyResource: (resource: PurchasableResource, quantity: number) => ResourcePurchaseResult
  onBuyVehicleCard: (
    cardId: string,
    quantity: number,
  ) =>
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

const MIN_TRAY_SIZE = 200
const DEFAULT_TABLE_ZONE_HEIGHT = 390
const DEFAULT_LEFT_PANEL_WIDTH = 280
const DEFAULT_STATUS_RAIL_WIDTH = 200
const DEFAULT_TABLE_PREVIEW_WIDTH = 240
const PANEL_GAP = 12
const ROW_TWO_TOP = 88
const TABLE_ZONE_GAP = 6
const RESIZE_HANDLE_SIZE = 12
const CITY_DOT_RADIUS = 2.4
const DEMAND_CUBE_PASSENGERS = 50
const DEMAND_CYLINDER_PASSENGERS = 500

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
  flex: "1 1 65%",
  display: "flex",
  alignItems: "stretch",
  gap: 6,
  overflowX: "auto",
} as const

const TOP_BAR_PLAYER_STYLE = {
  minWidth: 240,
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

const TOP_BAR_PROGRESS_STYLE = {
  minWidth: 0,
  flex: "1 1 35%",
  alignSelf: "stretch",
  margin: "-6px -6px -6px 0",
  border: "none",
  borderRadius: "0 12px 12px 0",
  padding: 0,
  display: "flex",
  alignItems: "stretch",
  justifyContent: "stretch",
  background: "transparent",
  fontSize: 12,
  overflow: "hidden",
} as const

const BOTTOM_BAR_STYLE = {
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  justifyContent: "flex-start",
  gap: 8,
  padding: 12,
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

const BUREAUCRACY_MODE_ORDER: RouteMode[] = ["bus", "rail", "air"]

const MODE_LINE_STYLES: Record<
  RouteMode,
  { strokeDasharray?: string; opacity?: number }
> = {
  rail: {},
  air: { strokeDasharray: "14 10" },
  bus: { strokeDasharray: "3 9", opacity: 0.9 },
}

const MODE_ACCENT_COLORS: Record<RouteMode, { border: string; face: string; badge: string }> = {
  bus: { border: "#8aa07f", face: "#f7fbf4", badge: "#68865b" },
  rail: { border: "#7d8fa8", face: "#f4f7fb", badge: "#5b7395" },
  air: { border: "#9a88bb", face: "#f7f4fc", badge: "#7c66a7" },
}

const TOP_BAR_PHASE_ORDER: WeeklyPhase[] = [
  "purchase-equipment",
  "claim-routes",
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

function getCityDemandTokenCounts(passengers: number) {
  const roundedPassengers = Math.max(
    0,
    Math.round(passengers / DEMAND_CUBE_PASSENGERS) * DEMAND_CUBE_PASSENGERS,
  )

  return {
    roundedPassengers,
    cylinders: Math.floor(roundedPassengers / DEMAND_CYLINDER_PASSENGERS),
    cubes:
      (roundedPassengers % DEMAND_CYLINDER_PASSENGERS) / DEMAND_CUBE_PASSENGERS,
  }
}

function renderCityDemandTokens(
  cityName: string,
  x: number,
  y: number,
  radius: number,
  passengers: number,
) {
  const { roundedPassengers, cylinders, cubes } =
    getCityDemandTokenCounts(passengers)

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
      <title>{`${cityName}: ${roundedPassengers} passengers of monthly demand`}</title>
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
    case "claim-routes":
      return "Claim routes"
    case "operations":
      return "Operations"
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
      return "operations"
    case "operations":
      return "bureaucracy"
    case "purchase-fuel":
      return "bureaucracy"
    case "bureaucracy":
      return "purchase-equipment"
  }
}

function getRouteInteractionMessage(phase: WeeklyPhase) {
  return phase === "operations"
    ? "Build routes from your hand or click highlighted rail segments on the map."
    : "Routes can only be claimed during the operations phase."
}

function getPhaseStatusMessage(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "Make 1 vehicle purchase this turn. Buses can buy up to 6, trains up to 3, planes 1."
    case "claim-routes":
      return "Draw 4 city cards and keep exactly 2. This step only adds cities to your hand."
    case "operations":
      return "Build tracks and routes, assign vehicles, and split services before running the month."
    case "purchase-fuel":
      return "Fuel purchasing is disabled."
    case "bureaucracy":
      return "Review passenger flow and operating ledgers, then advance."
  }
}

function getTopBarPhaseIndex(phase: WeeklyPhase) {
  if (phase === "purchase-fuel") {
    return 1
  }

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
  onClaimRoute,
  onDrawCityOffer,
  onSetActiveCityOfferKeptCityIds,
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

  const [selectedRouteMode, setSelectedRouteMode] = useState<RouteMode | null>(null)
  const [selectedDrawCityIds, setSelectedDrawCityIds] = useState<string[]>([])
  const [selectedOwnedCityIds, setSelectedOwnedCityIds] = useState<string[]>([])
  const [selectedRailSegmentKeys, setSelectedRailSegmentKeys] = useState<string[]>([])
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const [isResourceMarketOpen, setIsResourceMarketOpen] = useState(false)
  const [isVehicleMarketOpen, setIsVehicleMarketOpen] = useState(false)
  const [isBureaucracyOpen, setIsBureaucracyOpen] = useState(false)
  const [isEconomicsOpen, setIsEconomicsOpen] = useState(false)
  const [isWikiOpen, setIsWikiOpen] = useState(false)
  const [isActionLogOpen, setIsActionLogOpen] = useState(false)
  const [wikiPreviousPanel, setWikiPreviousPanel] = useState<RestorablePanel>(null)
  const [zoomScale, setZoomScale] = useState(1)
  const [isLiveStagePulseOn, setIsLiveStagePulseOn] = useState(false)
  const [isPeriodSummaryOpen, setIsPeriodSummaryOpen] = useState(false)
  const [lastShownPeriodSummaryKey, setLastShownPeriodSummaryKey] = useState<string | null>(null)
  const [showCityNames, setShowCityNames] = useState(true)
  const [showCitySizeBubbles, setShowCitySizeBubbles] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string>(
    getPhaseStatusMessage(game.currentPhase),
  )
  const [leftPanelWidth, setLeftPanelWidth] = useState(DEFAULT_LEFT_PANEL_WIDTH)
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
        MIN_TRAY_SIZE,
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

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)

    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [leftPanelWidth, resizeState, rightRailWidth])

  const map = game.map
  const currentPlayer = getCurrentPlayer(game)
  const boardClearanceBottom = tableZoneHeight + PANEL_GAP * 2
  const boardLeftInset = leftPanelWidth + PANEL_GAP * 2
  const boardRightInset = rightRailWidth + PANEL_GAP * 2
  const rowTwoStyle = {
    ...ROW_TWO_STYLE,
    bottom: boardClearanceBottom,
    gridTemplateColumns: `${leftPanelWidth}px minmax(0, 1fr) ${rightRailWidth}px`,
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
  const playerMap: Record<string, GameState["players"][number]> = Object.fromEntries(
    game.players.map(player => [player.id, player]),
  )
  const vehicleCardMap: Record<string, VehicleCard> = Object.fromEntries(
    game.vehicleCatalog.map(card => [card.id, card]),
  )
  const bureaucracySummaries = useMemo(
    () => buildBureaucracySummaries(game),
    [game],
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
  const currentPlayerConnectedCityIds = useMemo(
    () =>
      currentPlayer
        ? new Set(currentPlayer.ownedCityCardIds)
        : new Set<string>(),
    [currentPlayer],
  )
  const expandedCityIds = useMemo(() => {
    const cardVisibleCityIds = new Set<string>([
      ...selectedCityIds,
      ...(activeCityOffer?.cityIds ?? []),
      ...(currentPlayer?.ownedCityCardIds ?? []),
    ])

    currentPlayerConnectedCityIds.forEach(cityId => {
      cardVisibleCityIds.add(cityId)
    })

    return cardVisibleCityIds
  }, [activeCityOffer, currentPlayer, currentPlayerConnectedCityIds, selectedCityIds])
  const visibleCities = useMemo(() => {
    const kept: Array<GameState["cities"][number] & { markerRadius: number; x: number; y: number }> = []

    const orderedCities = [...game.cities].sort((a, b) => {
      if (b.size !== a.size) {
        return b.size - a.size
      }

      return a.name.localeCompare(b.name)
    })

    for (const city of orderedCities) {
      const { x, y } = latLngToWorld(city)
      const isExpanded = expandedCityIds.has(city.id)
      const markerRadius = showCitySizeBubbles || isExpanded ? city.size * 2.5 : CITY_DOT_RADIUS
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
      if (a.size !== b.size) {
        return a.size - b.size
      }

      return a.name.localeCompare(b.name)
    })
  }, [expandedCityIds, game.cities, showCitySizeBubbles])
  const labels = useMemo(
    () =>
      showCityNames
        ? computeLabels(
            visibleCities.map(city => {
              const isExpanded = expandedCityIds.has(city.id)
              const labelRadius = showCitySizeBubbles || isExpanded ? city.size * 2.5 : CITY_DOT_RADIUS

              return {
                ...city,
                labelRadius,
              }
            }),
            zoomScale,
          )
        : [],
    [expandedCityIds, showCityNames, showCitySizeBubbles, visibleCities, zoomScale],
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
              getEffectiveClaimCityIds(game, selectedRouteMode, selectedCityIds),
              selectedRouteMode,
            ),
    [game, selectedCityIds, selectedRailSegmentPairs, selectedRouteMode],
  )
  const selectedSegmentPairs = useMemo(
    () =>
      selectedRouteMode === null
        ? []
        : selectedRouteMode === "rail" && selectedRailSegmentPairs.length > 0
          ? selectedRailSegmentPairs
          : getClaimSegmentPairs(game, selectedRouteMode, selectedCityIds),
    [game, selectedCityIds, selectedRailSegmentPairs, selectedRouteMode],
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
  const currentPlayerOwnedVehicleCountsByCardId = currentPlayer?.ownedVehicleCountsByCardId ?? {}
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

    return getConnectionOptions(game, selectedCityIds)
  }, [currentPlayerOwnedModes, game, selectedCityIds, selectedRailSegmentPairs, selectedRouteMode])
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
          mode: option.mode,
        }),
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
  }, [cityMap, connectionBonusPreview, connectionOptions, currentPlayer, currentPlayerOwnedVehicleCards, game, selectedCities, selectedSegmentPairs])
  const selectedClaimPreview =
    selectedRouteMode === null
      ? null
      : routePreviewSummaries.find(summary => summary.mode === selectedRouteMode) ?? null
  const optionMessage =
    selectedRouteMode !== null && selectedClaimPreview && !selectedClaimPreview.valid
      ? selectedClaimPreview.reason ?? "That route is not available."
      : ""
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
  const currentPlayerVehicleUtilizationByCardId = useMemo(() => {
    const utilizationByCardId: Record<
      string,
      { percent: number; selectedTrips: number; maxTrips: number }
    > = {}

    currentPlayerBureaucracySummary?.routePlans.forEach(plan => {
      if (!plan.vehicleCard) {
        return
      }

      const current = utilizationByCardId[plan.vehicleCard.id] ?? {
        percent: 0,
        selectedTrips: 0,
        maxTrips: 0,
      }

      current.selectedTrips += plan.selectedTrips
      current.maxTrips += plan.maxTripsByTime
      current.percent =
        current.maxTrips <= 0
          ? 0
          : Math.max(0, Math.min(1, current.selectedTrips / current.maxTrips))

      utilizationByCardId[plan.vehicleCard.id] = current
    })

    return utilizationByCardId
  }, [currentPlayerBureaucracySummary])
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
    game.currentPhase === "claim-routes" &&
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
  const shouldAdvancePhase = isLastPlayerTurn(game)
  const canEditOperations = game.currentPhase === "operations"
  const hasPendingOperationsRouteSelection =
    canEditOperations &&
    ((selectedRouteMode !== null && selectedCityIds.length >= 2) || selectedRailSegmentKeys.length > 0)
  const isAdvanceBlocked =
    (game.currentPhase === "claim-routes" && (game.activeCityOffer?.keptCityIds.length ?? 0) !== 2) ||
    hasPendingOperationsRouteSelection
  const advanceTurnLabel = game.isGameOver
    ? "Game over"
    : shouldAdvancePhase
      ? "Next phase"
      : "Next player"

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
    setSelectedRouteMode(null)
    setSelectedDrawCityIds([])
    setSelectedOwnedCityIds([])
    setSelectedRailSegmentKeys([])
    setPendingVehiclePurchaseCardId(null)
    setRevealedVehicleFunFactCardId(null)
    setStatusMessage(getPhaseStatusMessage(game.currentPhase))
  }, [game.currentPhase])

  useEffect(() => {
    setSelectedDrawCityIds(game.activeCityOffer?.keptCityIds ?? [])
  }, [game.activeCityOffer?.keptCityIds])

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
    setIsBureaucracyOpen(game.currentPhase === "operations" || game.currentPhase === "bureaucracy")
    setIsEconomicsOpen(false)
    setIsWikiOpen(false)
    setWikiPreviousPanel(null)
  }, [game.currentPhase])

  function restorePhasePanel() {
    setIsResourceMarketOpen(false)
    setIsVehicleMarketOpen(game.currentPhase === "purchase-equipment")
    setIsBureaucracyOpen(game.currentPhase === "operations" || game.currentPhase === "bureaucracy")
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
    if (game.currentPhase === "claim-routes") {
      setStatusMessage("Use the table lane to draw 4 city cards and keep exactly 2.")
      return
    }

    if (game.currentPhase === "operations") {
      setStatusMessage("Use your city cards or click highlighted rail segments on the map to build a route.")
      return
    }

    resetSelection(getRouteInteractionMessage(game.currentPhase))
  }

  function toggleSelectedCityId(
    cityId: string,
    source: "draw" | "owned",
    mode: RouteMode,
  ) {
    if (game.currentPhase === "claim-routes") {
      if (source !== "draw") {
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

      const result = onSetActiveCityOfferKeptCityIds(nextCityIds)

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

  function handleDrawDeck(region: CityDeckRegion) {
    const result = onDrawCityOffer(region)

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

  function handleClaim() {
    if (game.currentPhase !== "operations") {
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

    const result = onClaimRoute(
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
      `${currentPlayer?.name ?? "Current player"} claimed a ${MODE_LABELS[selectedRouteMode].toLowerCase()} route across ${routeLabel}${result.cost > 0 ? ` for ${formatCurrency(result.cost)}` : ""}${rewardText}. Continue bureaucracy.`,
    )
  }

  function handleConfirmPicks() {
    if (!canConfirmPicks) {
      setStatusMessage("Keep exactly 2 city cards from the draw first.")
      return
    }

    const nextStatusMessage = shouldAdvancePhase
      ? `Confirmed picks. Starting ${formatPhaseLabel(getNextPhase(game.currentPhase)).toLowerCase()}.`
      : `Confirmed picks. ${nextPlayer?.name ?? "Next player"} is up.`

    onAdvanceTurn()
    resetSelection(nextStatusMessage)
  }

  function handleAdvanceTurnClick() {
    if (
      game.currentPhase === "claim-routes" &&
      (game.activeCityOffer?.keptCityIds.length ?? 0) !== 2
    ) {
      setStatusMessage("Draw 4 city cards and keep exactly 2 before ending the turn.")
      return
    }

    if (game.currentPhase === "operations" && hasPendingOperationsRouteSelection) {
      setStatusMessage("Build or clear the selected route before ending the turn.")
      return
    }

    const nextStatusMessage = shouldAdvancePhase
      ? `Starting ${formatPhaseLabel(getNextPhase(game.currentPhase)).toLowerCase()}.`
      : `${nextPlayer?.name ?? "Next player"} is up.`

    onAdvanceTurn()
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

  function getResizeHandleStyle(target: ResizeTarget) {
    const sharedStyle = {
      position: "absolute",
      zIndex: 3,
      borderRadius: 999,
      background:
        resizeState?.target === target ? "rgba(34, 48, 36, 0.28)" : "rgba(34, 48, 36, 0.12)",
      transition: "background 120ms ease",
    } as const

    switch (target) {
      case "left-panel":
        return {
          ...sharedStyle,
          top: 16,
          bottom: 16,
          left: leftPanelWidth + PANEL_GAP / 2 - RESIZE_HANDLE_SIZE / 2,
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
    const utilization = currentPlayerVehicleUtilizationByCardId[card.id]
    const accentColor = currentPlayer?.color ?? "#457b9d"
    const isOwnedSection = section === "owned"
    const canBuy =
      game.currentPhase === "purchase-equipment" &&
      !game.hasPurchasedVehicleThisTurn &&
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
            <span>{isOwnedSection ? "Owned fleet" : "Owned model"}</span>
            {isOwnedSection && (
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 999,
                  background: colorWithOpacity(
                    utilization && utilization.percent > 0 ? accentColor : "#7d8d80",
                    utilization && utilization.percent > 0 ? 0.16 : 0.1,
                  ),
                  color: utilization && utilization.percent > 0 ? accentColor : "#5d6c61",
                }}
              >
                {Math.round((utilization?.percent ?? 0) * 100)}%
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
          <div style={{ color: "#56635a", fontSize: 11, lineHeight: 1.35 }}>
            <strong>Utilization:</strong>{" "}
            {utilization
              ? `${Math.round(utilization.percent * 100)}% of max trips`
              : "0% of max trips"}
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
    setPendingVehiclePurchaseQuantity(1)
    setPendingVehiclePurchaseCardId(cardId)
  }

  function handleConfirmBuyVehicleCard() {
    if (!pendingVehiclePurchaseCard) {
      return
    }

    const result = onBuyVehicleCard(pendingVehiclePurchaseCard.id, pendingVehiclePurchaseQuantity)

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
        <div style={TOP_BAR_PLAYERS_STYLE}>
        {playerSummaries.map(
          ({ player, connectedCities, weeklyNet, ownedVehicleCardCounts, ownedRouteCount }) => (
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
        <div style={TOP_BAR_PROGRESS_STYLE}>
          <div
            style={{
              display: "flex",
              alignItems: "stretch",
              gap: 0,
              width: "100%",
              height: "100%",
              minWidth: 0,
            }}
          >
            {Array.from({ length: game.operatingConfig.totalWeeks }, (_, index) => {
              const monthNumber = index + 1
              const isLastMonth = monthNumber === game.operatingConfig.totalWeeks
              const isPast = monthNumber < game.currentWeek
              const isCurrent = monthNumber === game.currentWeek
              const isFuture = monthNumber > game.currentWeek

              if (isCurrent) {
                return (
                  <div
                    key={`month-progress-${monthNumber}`}
                    title={`Month ${monthNumber}: ${formatPhaseLabel(game.currentPhase)}`}
                    style={{
                      position: "relative",
                      flex: "0.72 1 0%",
                      minWidth: 0,
                      borderRadius: isLastMonth ? "0 12px 12px 0" : 0,
                      background: "#d9ddd7",
                      overflow: "hidden",
                      zIndex: 1,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background:
                          "repeating-linear-gradient(135deg, rgba(126, 155, 115, 0.85) 0 8px, rgba(111, 143, 100, 0.85) 8px 12px)",
                        opacity: isLiveStagePulseOn ? 0.95 : 0.2,
                        transition: "opacity 2800ms ease-in-out",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "grid",
                        gridTemplateRows: `repeat(${TOP_BAR_PHASE_ORDER.length}, minmax(0, 1fr))`,
                        gap: 1,
                        background: "rgba(255, 255, 255, 0.28)",
                      }}
                    >
                      {Array.from(
                        { length: TOP_BAR_PHASE_ORDER.length },
                        (_, index) => TOP_BAR_PHASE_ORDER.length - 1 - index,
                      ).map(requiredPhaseIndex => (
                        <div
                          key={`${monthNumber}-band-${requiredPhaseIndex}`}
                          style={{
                            background:
                              currentPhaseProgressIndex >= requiredPhaseIndex
                                ? "repeating-linear-gradient(135deg, #7e9b73 0 8px, #6f8f64 8px 12px)"
                                : "transparent",
                          }}
                        />
                      ))}
                    </div>
                    <div
                      style={{
                        position: "relative",
                        zIndex: 1,
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#ffffff",
                        fontSize: 11,
                        fontWeight: 800,
                        textShadow: "0 1px 2px rgba(0, 0, 0, 0.35)",
                      }}
                    >
                      {monthNumber}
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={`month-progress-${monthNumber}`}
                  title={`Month ${monthNumber}`}
                      style={{
                        position: "relative",
                        flex: "0.72 1 0%",
                        minWidth: 0,
                        borderRadius: isLastMonth ? "0 12px 12px 0" : 0,
                        background: isPast
                          ? "repeating-linear-gradient(135deg, #a9c3dc 0 8px, #9bb7d4 8px 12px)"
                          : isFuture
                        ? "#d9ddd7"
                        : "#edf3e8",
                    boxShadow: isPast
                      ? "none"
                      : "inset 0 0 0 1px rgba(124, 146, 127, 0.18)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: isPast ? "#ffffff" : "#56635a",
                    fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      {monthNumber}
                    </div>
              )
            })}
          </div>
        </div>
      </div>
      <div style={rowTwoStyle}>
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
            game.currentPhase === "claim-routes" ||
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
                    : game.currentPhase === "claim-routes"
                      ? "City decks on the table"
                      : game.currentPhase === "operations"
                        ? "Operations planning"
                        : "Bureaucracy review"}
                </strong>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                {game.currentPhase === "purchase-equipment"
                  ? "Choose from the cards laid out across the table below instead of opening a market menu."
                  : game.currentPhase === "claim-routes"
                    ? "Draw 4 city cards and keep exactly 2. This step only adds cities to your hand."
                    : game.currentPhase === "operations"
                      ? "Build tracks, split pods, assign service, and set up routes."
                      : "Review passenger flow and route ledgers before ending the month."}
              </div>
              {game.currentPhase === "purchase-equipment" && game.hasPurchasedVehicleThisTurn && (
                <div style={{ color: "#9b1c1c", fontSize: 13 }}>
                  You have already used your vehicle purchase this turn. Advance to the next player.
                </div>
              )}
              {game.currentPhase === "operations" && game.hasClaimedRouteThisTurn && (
                <div style={{ color: "#9b1c1c", fontSize: 13 }}>
                  You have already claimed 1 route this turn. Advance to the next player.
                </div>
              )}
              {game.currentPhase === "operations" && currentPlayerOwnedModes.size === 0 && (
                <div style={{ color: "#848484", fontSize: 13 }}>
                  You do not own any vehicles that can claim routes yet.
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
              dimmed={game.currentPhase !== "claim-routes"}
            />
            <CardStackPreview
              icon="?"
              label="Chance cards"
              count={remainingChanceDeckCount}
              accent={{ border: "#b58cba", face: "#fbf4fb", badge: "#95669a" }}
              dimmed={!activeChanceCard && remainingChanceDeckCount === 0}
            />
          </div>
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

            {game.currentPhase === "operations" &&
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

            {game.routes.map(route => {
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
              const owner = route.ownerId ? playerMap[route.ownerId] : undefined
              const lineStyle = MODE_LINE_STYLES[route.mode]
              const isElectricRail =
                route.mode === "rail" && getRailTraction(route) === "electric"

              return (
                <g key={route.id}>
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
                    stroke={owner?.color ?? "#222222"}
                    strokeWidth={4}
                    fill="none"
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

            {visibleCities.map(city => {
              const { x, y } = latLngToWorld(city)
              const isExpanded = expandedCityIds.has(city.id)
              const usesBubbleRadius = showCitySizeBubbles || isExpanded
              const radius = usesBubbleRadius ? city.size * 2.5 : CITY_DOT_RADIUS
              const label = labelMap[city.id]
              const isSelected = selectedCityIds.includes(city.id)
              const fill = isSelected
                ? currentPlayer?.color ?? "#ffffff"
                : usesBubbleRadius
                  ? "#ffffff"
                  : "rgba(34, 48, 36, 0.7)"
              const stroke = usesBubbleRadius
                ? "#000000"
                : "rgba(244, 241, 232, 0.75)"
              const shouldShowDemandTokens = currentPlayerConnectedCityIds.has(city.id)
              const demandPassengers =
                shouldShowDemandTokens
                  ? getCityDemandSize(game, city) *
                    game.operatingConfig.passengersPerDemandPoint
                  : 0

              return (
                <g
                  key={city.id}
                  onClick={handleCityClick}
                  style={{ cursor: game.currentPhase === "claim-routes" ? "default" : "pointer" }}
                >
                  {renderCityDemandTokens(city.name, x, y, radius, demandPassengers)}
                  <circle
                    cx={x}
                    cy={y}
                    r={radius}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={
                      isSelected ? 2.5 : usesBubbleRadius ? 1.5 : 1
                    }
                  />

                  {label && (
                    <text
                      x={label.textX}
                      y={label.textY}
                      fontSize={usesBubbleRadius ? 12 : 10}
                      textAnchor={label.textAnchor}
                      dominantBaseline="middle"
                      fill="#223024"
                      stroke="rgba(244, 241, 232, 0.95)"
                      strokeWidth={usesBubbleRadius ? 4 : 3.2}
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
          <div style={{ display: "grid", gap: 6 }}>
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
            {game.currentPhase !== "bureaucracy" && (
              <button
                type="button"
                onClick={handleAdvanceTurnClick}
                disabled={game.isGameOver || isAdvanceBlocked}
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid #c7d0c4",
                  cursor: game.isGameOver || isAdvanceBlocked ? "not-allowed" : "pointer",
                  background: game.isGameOver || isAdvanceBlocked ? "#f2f2f2" : "#ffffff",
                  fontWeight: 700,
                  textAlign: "left",
                  fontSize: 13,
                }}
              >
                {advanceTurnLabel}
              </button>
            )}
          </div>
        </div>
        {areResizeHandlesVisible && (
          <>
            <div
              onMouseDown={event => beginResize("left-panel", event, leftPanelWidth)}
              style={getResizeHandleStyle("left-panel")}
              title="Resize left tray"
            />
            <div
              onMouseDown={event => beginResize("right-rail", event, rightRailWidth)}
              style={getResizeHandleStyle("right-rail")}
              title="Resize right tray"
            />
          </>
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
                  {[
                    {
                      label: "Passengers",
                      value: formatDecimal(player.lastPeriodPassengersServed, 0),
                      emphasized: true,
                    },
                    {
                      label: "Profit",
                      value: formatCurrency(weeklyNet),
                      emphasized: true,
                    },
                    {
                      label: "Revenue",
                      value: formatCurrency(player.weeklyPayout),
                      emphasized: false,
                    },
                    {
                      label: "Costs",
                      value: formatCurrency(player.operatingCosts),
                      emphasized: false,
                    },
                    {
                      label: "Cash",
                      value: formatCurrency(player.money),
                      emphasized: false,
                    },
                  ].map(stat => (
                    <div
                      key={`${player.id}-${stat.label}`}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                        minWidth: 96,
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
                    </div>
                  ))}
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
            {expandedPlayerSummary.player.id === game.currentPlayerId &&
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
              ? "Configure pods by mode, assign vehicles, and split services before running the month."
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
                      <div style={{ color: "#56635a" }}>No routes to operate yet.</div>
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
                                  {renderFillBoxes(absorptionSize, 0)}
                                </div>
                                <div style={{ color: "#56635a", fontSize: 11 }}>
                                  Waiting cubes {Math.max(0, demandSize)}
                                  {" • "}Capacity {absorptionSize}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
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
                        plans.map(plan => {
                          const hasCapacityShortfall =
                            plan.selectedFleetSize < plan.demandFleetSize ||
                            plan.movedCubes < plan.movableDemandCubes
                          const unmetCapacityCubes = Math.max(
                            0,
                            plan.movableDemandCubes - plan.movedCubes,
                          )
                          const movedOutboundByCityId = Object.fromEntries(
                            plan.simplifiedLedgerEntries.reduce(
                              (totals, entry) => {
                                totals.set(
                                  entry.originCityId,
                                  (totals.get(entry.originCityId) ?? 0) +
                                    entry.cubeCount,
                                )
                                return totals
                              },
                              new Map<string, number>(),
                            ),
                          ) as Record<string, number>
                          const podCities = plan.selectedCityIds
                            .map(cityId => cityMap[cityId])
                            .filter(
                              (
                                city,
                              ): city is GameState["cities"][number] =>
                                city !== undefined,
                            )
                          const podPoints = podCities.map(city => ({
                            cityId: city.id,
                            cityName: city.name,
                            ...latLngToWorld(city),
                          }))

                          const flowColors = [
                            "#2563eb",
                            "#7c3aed",
                            "#d97706",
                            "#0f766e",
                            "#db2777",
                            "#1d4ed8",
                          ]
                          const markerPrefix = plan.id.replace(
                            /[^a-zA-Z0-9_-]/g,
                            "-",
                          )
                          const pointByCityId = Object.fromEntries(
                            podPoints.map(point => [point.cityId, point]),
                          )
                          const minX = Math.min(
                            ...(podPoints.length > 0
                              ? podPoints.map(point => point.x)
                              : [0]),
                          )
                          const maxX = Math.max(
                            ...(podPoints.length > 0
                              ? podPoints.map(point => point.x)
                              : [120]),
                          )
                          const minY = Math.min(
                            ...(podPoints.length > 0
                              ? podPoints.map(point => point.y)
                              : [0]),
                          )
                          const maxY = Math.max(
                            ...(podPoints.length > 0
                              ? podPoints.map(point => point.y)
                              : [120]),
                          )
                          const previewPadding = 28
                          const previewWidth = Math.max(
                            120,
                            maxX - minX + previewPadding * 2,
                          )
                          const previewHeight = Math.max(
                            120,
                            maxY - minY + previewPadding * 2,
                          )
                          const previewViewBox = `${minX - previewPadding} ${minY - previewPadding} ${previewWidth} ${previewHeight}`
                          const shouldStretchFlowMap =
                            plan.simplifiedLedgerEntries.length >= 5

                          return (
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
                                ? (
                                  <>
                                    {`• #${plan.vehicleCard.number} ${plan.vehicleCard.name} • `}
                                    <span
                                      style={{
                                        color:
                                          plan.selectedFleetSize < plan.demandFleetSize
                                            ? "#b42318"
                                            : "#56635a",
                                        fontWeight:
                                          plan.selectedFleetSize < plan.demandFleetSize
                                            ? 700
                                            : 400,
                                      }}
                                    >
                                      {`Fleet ${plan.selectedFleetSize}${
                                        plan.selectedFleetSize < plan.demandFleetSize
                                          ? ` / ${plan.demandFleetSize} needed`
                                          : ""
                                      }`}
                                    </span>
                                  </>
                                )
                                : "• No vehicle assigned"}
                            </div>
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
                              <span>Demand {plan.movableDemandCubes} cubes</span>
                              <span>Filled {plan.simplifiedCityStatuses.reduce((total, city) => total + city.filledCubes, 0)} boxes</span>
                              {hasCapacityShortfall && (
                                <span style={{ color: "#b42318", fontWeight: 700 }}>
                                  {unmetCapacityCubes}{" "}
                                  cubes blocked by capacity
                                </span>
                              )}
                              <span>{plan.cubeCapacityPerTrip} cubes/trip</span>
                              <span>max {plan.maxTripsByTime} trips</span>
                              <span>Fleet {plan.selectedFleetSize}</span>
                              <span>👥 {plan.passengersPerTrip.toLocaleString()}</span>
                              <span>x{formatDecimal(plan.simplifiedPayoutMultiplier, 0)} payout weight</span>
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gap: 8,
                                border: "1px solid #e1e6df",
                                borderRadius: 8,
                                padding: 8,
                                background: "#fafcf9",
                              }}
                            >
                              <div>
                                <strong>City demand fill</strong>
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                {plan.simplifiedCityStatuses.map(cityStatus => (
                                  <div
                                    key={`${plan.id}-${cityStatus.cityId}-fill`}
                                    style={{
                                      border: "1px solid #d8dfd5",
                                      borderRadius: 10,
                                      padding: "6px 8px",
                                      background: "#ffffff",
                                      display: "grid",
                                      gap: 4,
                                      minWidth: 150,
                                    }}
                                  >
                                    <div style={{ fontSize: 12 }}>
                                      <strong>{cityStatus.cityName}</strong>
                                      {" • "}size {cityStatus.size}
                                    </div>
                                    <div
                                      style={{
                                        display: "flex",
                                        flexWrap: "wrap",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: 8,
                                      }}
                                    >
                                      <div
                                        style={{
                                          display: "inline-flex",
                                          flexWrap: "wrap",
                                          gap: 4,
                                        }}
                                      >
                                        {renderFillBoxes(
                                          cityStatus.size + 1,
                                          Math.min(
                                            cityStatus.size + 1,
                                            cityStatus.filledCubes,
                                          ),
                                        )}
                                      </div>
                                      <div
                                        style={{
                                          display: "inline-flex",
                                          flexWrap: "wrap",
                                          gap: 4,
                                          justifyContent: "flex-end",
                                        }}
                                      >
                                        {renderFillBoxes(
                                          Math.max(
                                            0,
                                            cityStatus.outboundCubes -
                                              (movedOutboundByCityId[
                                                cityStatus.cityId
                                              ] ?? 0),
                                          ),
                                          Math.max(
                                            0,
                                            cityStatus.outboundCubes -
                                              (movedOutboundByCityId[
                                                cityStatus.cityId
                                              ] ?? 0),
                                          ),
                                          { filledColor: "#ef4444" },
                                        )}
                                      </div>
                                    </div>
                                    <div style={{ color: "#56635a", fontSize: 11 }}>
                                      Filled {cityStatus.filledCubes} / {cityStatus.size + 1}
                                      {" • "}Out {cityStatus.outboundCubes}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gap: 8,
                                gridTemplateColumns:
                                  podPoints.length >= 2
                                    ? "minmax(0, 1.25fr) minmax(0, 1fr)"
                                    : "minmax(0, 1fr)",
                                alignItems: shouldStretchFlowMap
                                  ? "stretch"
                                  : "start",
                              }}
                            >
                              <div
                                style={{
                                  display: "grid",
                                  gap: 8,
                                  border: "1px solid #e1e6df",
                                  borderRadius: 8,
                                  padding: 8,
                                  background: "#ffffff",
                                }}
                              >
                                <div>
                                  <strong>Simplified passenger ledger</strong>
                                </div>
                                {plan.simplifiedLedgerEntries.length === 0 ? (
                                  <div style={{ color: "#56635a", fontSize: 12 }}>
                                    No passenger cubes can be moved on this service with the current setup.
                                  </div>
                                ) : (
                                  plan.simplifiedLedgerEntries.map(entry => (
                                    <div
                                      key={entry.id}
                                      style={{
                                        border: "1px solid #e1e6df",
                                        borderRadius: 8,
                                        padding: "8px 10px",
                                        background: "#fafcf9",
                                        display: "grid",
                                        gap: 4,
                                      }}
                                    >
                                      <div style={{ fontSize: 13 }}>
                                        <strong>{entry.originCityName}</strong> to{" "}
                                        <strong>{entry.destinationCityName}</strong>
                                      </div>
                                      <div style={{ color: "#324236", fontSize: 12 }}>
                                        {entry.cubeCount} cube{entry.cubeCount === 1 ? "" : "s"}
                                        {" • "}👥 {formatDecimal(entry.passengers, 0)}
                                        {" • "}x{formatDecimal(entry.payoutMultiplier, 0)}
                                        {" • "}Fare {formatCurrency(entry.farePerPassenger)}
                                        {" • "}Payout {formatCurrency(entry.payout)}
                                      </div>
                                      <div style={{ color: "#56635a", fontSize: 11 }}>
                                        {entry.pathLabels.join(" • ")}
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                              {podPoints.length >= 2 && (
                                <div
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 8,
                                    border: "1px solid #e1e6df",
                                    borderRadius: 8,
                                    padding: 8,
                                    background: "#ffffff",
                                    minHeight: shouldStretchFlowMap ? 0 : 260,
                                  }}
                                >
                                  <div>
                                    <strong>Pod flow map</strong>
                                  </div>
                                  <svg
                                    viewBox={previewViewBox}
                                    style={{
                                      width: "100%",
                                      height: shouldStretchFlowMap
                                        ? "100%"
                                        : 240,
                                      minHeight: shouldStretchFlowMap
                                        ? 220
                                        : 240,
                                      flex: shouldStretchFlowMap ? 1 : "none",
                                      borderRadius: 8,
                                      background: "#f7faf6",
                                    }}
                                  >
                                    <defs>
                                      {plan.simplifiedLedgerEntries.map((_, entryIndex) => {
                                        const color =
                                          flowColors[
                                            entryIndex % flowColors.length
                                          ]

                                        return (
                                          <marker
                                            key={`${markerPrefix}-arrow-${entryIndex}`}
                                            id={`${markerPrefix}-arrow-${entryIndex}`}
                                            viewBox="0 0 10 10"
                                            refX="8"
                                            refY="5"
                                            markerWidth="5"
                                            markerHeight="5"
                                            orient="auto"
                                          >
                                            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                                          </marker>
                                        )
                                      })}
                                    </defs>
                                    {plan.routes.map(route => {
                                      const a = pointByCityId[route.cityA]
                                      const b = pointByCityId[route.cityB]

                                      if (!a || !b) {
                                        return null
                                      }

                                      return (
                                        <path
                                          key={`${plan.id}-pod-${route.id}`}
                                          d={buildSegmentPath(
                                            a,
                                            b,
                                            segmentMetadataByKey[
                                              getSegmentKey(route.cityA, route.cityB)
                                            ]?.curve,
                                          )}
                                          fill="none"
                                          stroke="#d0d9d0"
                                          strokeWidth={2}
                                        />
                                      )
                                    })}
                                    {plan.simplifiedLedgerEntries.flatMap(
                                      (entry, entryIndex) =>
                                        entry.pathCityIds
                                          .slice(0, -1)
                                          .map((startCityId, segmentIndex) => {
                                            const endCityId =
                                              entry.pathCityIds[segmentIndex + 1]
                                            const a = pointByCityId[startCityId]
                                            const b = pointByCityId[endCityId]

                                            if (!a || !b) {
                                              return null
                                            }

                                            const color =
                                              flowColors[
                                                entryIndex % flowColors.length
                                              ]

                                            return (
                                              <path
                                                key={`${plan.id}-flow-${entry.id}-${segmentIndex}`}
                                                d={buildSegmentPath(
                                                  a,
                                                  b,
                                                  segmentMetadataByKey[
                                                    getSegmentKey(startCityId, endCityId)
                                                  ]?.curve,
                                                )}
                                                fill="none"
                                                stroke={color}
                                                strokeWidth={Math.max(
                                                  2.5,
                                                  entry.cubeCount * 0.7,
                                                )}
                                                markerEnd={`url(#${markerPrefix}-arrow-${entryIndex})`}
                                                strokeLinecap="round"
                                                opacity={0.88}
                                              />
                                            )
                                          }),
                                    )}
                                    {podPoints.map(point => (
                                      <g key={`${plan.id}-city-${point.cityId}`}>
                                        <circle
                                          cx={point.x}
                                          cy={point.y}
                                          r={4.5}
                                          fill="#ffffff"
                                          stroke="#324236"
                                          strokeWidth={1.5}
                                        />
                                        <text
                                          x={point.x + 6}
                                          y={point.y - 6}
                                          fill="#324236"
                                          fontSize={8}
                                          fontWeight={600}
                                        >
                                          {point.cityName}
                                        </text>
                                      </g>
                                    ))}
                                  </svg>
                                  <div style={{ color: "#56635a", fontSize: 11 }}>
                                    Colored arrows show cube movement by ledger entry (arrow direction indicates destination).
                                  </div>
                                </div>
                              )}
                            </div>
                            {plan.vehicleCard ? (
                              <div style={{ color: "#56635a", fontSize: 12 }}>
                                Trips: {plan.selectedTrips}
                                {" • "}Cubes moved: {plan.movedCubes}
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
                            <details>
                              <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                                Detailed view
                              </summary>
                              <div
                                style={{
                                  display: "grid",
                                  gap: 8,
                                  marginTop: 8,
                                }}
                              >
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
                                    disabled={!canEditOperations}
                                    style={{
                                      minWidth: 220,
                                      padding: "6px 8px",
                                      borderRadius: 8,
                                      border: "1px solid #c7d0c4",
                                      background: canEditOperations ? "#ffffff" : "#f2f2f2",
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
                                            disabled={!canEditOperations}
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
                                {plan.cityCubeDemands.length > 0 && (
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
                                      <strong>City cubes</strong>
                                    </div>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px" }}>
                                      {plan.cityCubeDemands.map(cityDemand => (
                                        <div
                                          key={`${plan.id}-${cityDemand.cityId}-cubes`}
                                          style={{
                                            border: "1px solid #e1e6df",
                                            borderRadius: 999,
                                            padding: "4px 8px",
                                            background: "#fafcf9",
                                          }}
                                        >
                                          <strong>{cityDemand.cityName}</strong>
                                          {" • "}Out {cityDemand.outboundCubes}
                                          {" • "}In {cityDemand.inboundCubes}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {plan.canAddSplitService && (
                                  <div>
                                    <button
                                      type="button"
                                      onClick={() => handleAddSplitService(plan.corridorId)}
                                      disabled={!canEditOperations}
                                      style={{
                                        padding: "6px 10px",
                                        borderRadius: 999,
                                        border: "1px solid #c7d0c4",
                                        background: canEditOperations ? "#ffffff" : "#f2f2f2",
                                        cursor: canEditOperations ? "pointer" : "not-allowed",
                                        fontSize: 12,
                                        opacity: canEditOperations ? 1 : 0.6,
                                      }}
                                    >
                                      Add split service
                                    </button>
                                  </div>
                                )}
                              </div>
                            </details>
                          </div>
                          )
                        })
                      )}
                    </div>
                  ))
                 )}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={handleAdvanceTurnClick}
                    disabled={game.isGameOver || isAdvanceBlocked}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: "1px solid #223024",
                      cursor: game.isGameOver || isAdvanceBlocked ? "not-allowed" : "pointer",
                      background: game.isGameOver || isAdvanceBlocked ? "#dfe5de" : "#223024",
                      color: "#ffffff",
                      fontWeight: 700,
                    }}
                  >
                    {advanceTurnLabel}
                  </button>
                </div>
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
                3. <strong>Operations</strong>: build rail/air links, assign vehicles, and split services. Bus pods follow connected owned cities automatically.
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
                <strong>Bus</strong>: pods are built from connected owned city cards and use diesel.
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
                    : game.currentPhase === "claim-routes"
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
              {game.currentPhase === "purchase-equipment"
                ? "Your current vehicle models appear first in one row, followed by market purchase options."
                : game.currentPhase === "claim-routes"
                  ? "Draw regional city cards and keep exactly 2 to add them to your hand."
                  : game.currentPhase === "operations"
                    ? "Build tracks/routes and configure service pods by mode before running operations."
                  : game.currentPhase === "bureaucracy"
                    ? "Review how passenger cubes moved and how each pod performed."
                  : "The board stays clear while reference panels open over it."}
            </div>
            </div>
            {game.currentPhase === "purchase-equipment" ? (
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
          ) : game.currentPhase === "claim-routes" || game.currentPhase === "operations" ? (
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
              {game.currentPhase === "claim-routes" && (
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
                        const canDraw = !activeCityOffer && remainingCount > 0 && totalCityDeckCount >= 4

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
                                  disabled: false,
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
                {game.currentPhase === "operations" && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setStatusMessage("Bus pods are automatic from connected owned cities. No build step is needed.")
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
                        game.currentPhase !== "operations" ||
                        game.hasClaimedRouteThisTurn ||
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
          {game.currentPhase === "claim-routes" ? (
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
          ) : game.currentPhase === "operations" ? (
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
                <button
                  type="button"
                  onClick={() => {
                    setSelectedRouteMode("rail")
                    setSelectedOwnedCityIds([])
                    setSelectedDrawCityIds([])
                    setSelectedRailSegmentKeys([])
                    setStatusMessage("Build Track is active. Click highlighted adjacent segments to lay rail.")
                  }}
                  disabled={!currentPlayerOwnedModes.has("rail")}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid #c7d0c4",
                    cursor: currentPlayerOwnedModes.has("rail") ? "pointer" : "not-allowed",
                    background: selectedRouteMode === "rail" ? "#eff5ee" : "#ffffff",
                    color: "#223024",
                    fontWeight: 700,
                    opacity: currentPlayerOwnedModes.has("rail") ? 1 : 0.6,
                  }}
                >
                  Build Track
                </button>
                <button
                  type="button"
                  onClick={handleClaim}
                  disabled={!selectedClaimPreview?.valid || game.hasClaimedRouteThisTurn}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    cursor:
                      selectedClaimPreview?.valid && !game.hasClaimedRouteThisTurn
                        ? "pointer"
                        : "not-allowed",
                    background:
                      selectedClaimPreview?.valid && !game.hasClaimedRouteThisTurn
                        ? "#223024"
                        : "#dfe5de",
                    color: "#ffffff",
                    fontWeight: 700,
                  }}
                >
                  {selectedRouteMode === "rail" ? "Build track" : "Build route"}
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
                    {MODE_LABELS[selectedClaimPreview.mode]} • {formatDecimal(selectedClaimPreview.totalDistanceMiles)} mi
                    {" • "}Demand {selectedClaimPreview.combinedDemand}
                    {" • "}Fleet {selectedClaimPreview.plannedFleetSize}
                    {selectedClaimPreview.plannedFleetSize < selectedClaimPreview.demandFleetSize &&
                      ` / ${selectedClaimPreview.demandFleetSize} needed`}
                    {" • "}Capacity {selectedClaimPreview.passengersPerTrip.toLocaleString()} / trip
                  </div>
                  {selectedClaimPreview.previewCard && (
                    <div style={{ color: "#56635a" }}>
                      Vehicle preview: #{selectedClaimPreview.previewCard.number}{" "}
                      {selectedClaimPreview.previewCard.name}
                    </div>
                  )}
                  <div>
                    Trips/month {selectedClaimPreview.maxTripsPerPeriod.toLocaleString()}
                    {" • "}Passengers/month {selectedClaimPreview.passengersPerPeriod.toLocaleString()}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                      gap: 10,
                      border: "1px solid #e2e8df",
                      borderRadius: 10,
                      padding: 10,
                      background: "#f7faf7",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ color: "#7b857d", fontSize: 11, fontWeight: 600 }}>
                        Avg net / month
                      </div>
                      <div
                        style={{
                          color:
                            selectedClaimPreview.netPerPeriod > 0
                              ? "#2a7f3b"
                              : selectedClaimPreview.netPerPeriod < 0
                                ? "#b42318"
                                : "#223024",
                          fontSize: 24,
                          fontWeight: 800,
                          lineHeight: 1.1,
                        }}
                      >
                        {formatCurrency(selectedClaimPreview.netPerPeriod)}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        alignItems: "flex-start",
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ color: "#7b857d", fontSize: 11, fontWeight: 600 }}>
                          Avg revenue / month
                        </div>
                        <div style={{ color: "#324236", fontSize: 14, fontWeight: 700 }}>
                          {formatCurrency(selectedClaimPreview.revenuePerPeriod)}
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div style={{ color: "#7b857d", fontSize: 11, fontWeight: 600 }}>
                          Avg operating cost / month
                        </div>
                        <div style={{ color: "#324236", fontSize: 14, fontWeight: 700 }}>
                          {formatCurrency(selectedClaimPreview.operatingCostPerPeriod)}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{ color: "#56635a", fontSize: 12 }}>
                    Crew {formatCurrency(selectedClaimPreview.crewCostPerPeriod)}
                    {" • "}Maint {formatCurrency(selectedClaimPreview.maintenanceCostPerPeriod)}
                    {" • "}Balance {formatCurrency(selectedClaimPreview.balanceCostPerPeriod)}
                    {" • "}Fuel {formatCurrency(selectedClaimPreview.fuelCostPerPeriod)}
                  </div>
                  <div>
                    Build {formatCurrency(selectedClaimPreview.claimCost)}
                    {selectedClaimPreview.connectionBonus > 0 && (
                      <>
                        {" • "}Bonus {formatCurrency(selectedClaimPreview.connectionBonus)}
                        {" • "}New cities {selectedClaimPreview.newCityCount}
                      </>
                    )}
                  </div>
                  {optionMessage && <div style={{ color: "#9b1c1c" }}>{optionMessage}</div>}
                  {selectedClaimPreview.valid && (
                    <div style={{ color: "#324236", fontSize: 13 }}>
                      Ready to confirm for {formatCurrency(selectedClaimPreview.claimCost)}
                      {selectedClaimPreview.connectionBonus > 0 &&
                        ` with ${formatCurrency(selectedClaimPreview.connectionBonus)} in connection bonuses`}
                      .
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
                  Select air or build track mode, then pick city cards from your hand or click highlighted rail segments to preview.
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
                  Purchase used this turn: <strong>{game.hasPurchasedVehicleThisTurn ? "Yes" : "No"}</strong>
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
            style={getResizeHandleStyle("table-preview")}
            title="Resize table preview"
          />
        )}
      </div>
      {areResizeHandlesVisible && (
        <div
          onMouseDown={event => beginResize("table-height", event, tableZoneHeight)}
          style={getResizeHandleStyle("table-height")}
          title="Resize table tray height"
        />
      )}
    </div>
  )
}
