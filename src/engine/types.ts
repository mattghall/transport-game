import type { BotPresetId } from "../bots/presets"
import type { ScriptedBotWeights } from "../bots/scriptedBot"
import type { AdjacentCity, GameMap } from "./maps/types"

export type PlayerInventory = {
  vehicles: {
    trains: number
    planes: number
    buses: number
  }
  fuel: {
    diesel: number
    jetFuel: number
  }
}

export type PurchasableResource = "diesel" | "jetFuel"
export type VehicleType = "air" | "train" | "bus"
export type FuelBurnUnit = "gallons" | "pounds"
export type RailTraction = "diesel" | "electric"
export type VehiclePurchasesByType = Record<VehicleType, boolean>
export type RouteClaimsByMode = Record<RouteMode, boolean>
export const CITY_DECK_REGIONS = [
  "Pacific",
  "Mountain",
  "South",
  "Southeast",
  "Midwest",
  "Northeast",
] as const
export type CityDeckRegion = (typeof CITY_DECK_REGIONS)[number]

export type ChanceDemandBoost = {
  regions: string[]
  bonusPerCity: number
}

export type ChanceCard = {
  id: string
  title: string
  description: string
  fuelPriceMultiplier?: Partial<Record<PurchasableResource, number>>
  demandBoost?: ChanceDemandBoost
  connectionBonus?: {
    citySize: number
    bonusPerCity: number
  }
}

export type VehicleCard = {
  id: string
  number: number
  type: VehicleType
  name: string
  purchasePrice: number
  vehicleCount: number
  capacityPerVehicle: number
  totalPassengerCapacity: number
  operatingCostMultiplier: number
  speed: number
  fuelResource?: PurchasableResource | null
  funFact: string
}

export type RouteDeckCard = {
  id: string
  mode: RouteMode
  title: string
  cityIds: string[]
  isLoop: boolean
  notes?: string
}

export type UserDeckData = {
  vehicleCards: VehicleCard[]
  chanceCards: ChanceCard[]
  routeCards: RouteDeckCard[]
}

export type RouteMarketByMode = Record<RouteMode, string[]>
export type CityDecksByRegion = Record<CityDeckRegion, string[]>
export type ActiveCityOffer = {
  region: CityDeckRegion
  cityIds: string[]
  keptCityIds: string[]
  playerId: string
}

export type OperatingConfig = {
  hoursPerDay: number
  daysPerWeek: number
  weeksPerPeriod: number
  totalWeeks: number
  simulationTicksPerPeriod: number
  cityDrawCount: number
  cityTargetKeepCount: number
  cityMinimumKeepCount: number
  loadingHours: Record<VehicleType, number>
  demandPointsPerCitySize: number
  passengersPerDemandPoint: number
  dynamicDemand: {
    enabled: boolean
    lowServiceThreshold: number
    lowServiceMultiplier: number
    noServiceThreshold: number
    noServiceMultiplier: number
    highServiceThreshold: number
    highServiceMultiplier: number
    fullServiceThreshold: number
    fullServiceMultiplier: number
  }
  connectionBonusPerCitySize: number
  railConstructionCostPerMile: number
  railElectrificationCostPerMile: number
  realWorldOperatingCosts: {
    crewHourlyCostPerVehicle: Record<VehicleType, number>
    maintenanceCostPerWeekPerVehicle: Record<VehicleType, number>
  }
  balanceAdjustmentPerTrip: {
    bus: number
    air: number
    railDiesel: number
    railElectric: number
  }
  fuelUnits: Record<PurchasableResource, number>
  fuelPricePerRealUnit: Record<PurchasableResource, number>
  revenuePerPassengerMile: Record<RouteMode, number>
}

export type RouteModeBreakdown = Record<RouteMode, number>

export type PlayerPeriodHistoryEntry = {
  period: number
  passengersServed: number
  passengersServedByMode: RouteModeBreakdown
  podCountByMode: RouteModeBreakdown
  grossRevenue: number
  operatingCosts: number
  netRevenue: number
  endingCash: number
}

export type RouteMode = "rail" | "air" | "bus"
export type WeeklyPhase =
  | "add-city"
  | "operations"
  | "purchase-equipment"
  | "bureaucracy"

export type PlayerState = {
  id: string
  name: string
  color: string
  isBot?: boolean
  botPreset?: BotPresetId
  money: number
  totalPassengersServed: number
  startingCityId?: string
  inventory: PlayerInventory
  ownedVehicleCardIds: string[]
  ownedVehicleCountsByCardId: Record<string, number>
  vehicleWeeksOwnedByCardId: Record<string, number>
  operatingCosts: number
  weeklyPayout: number
  lastPeriodPassengersServed: number
  ownedCityCardIds: string[]
  phase: WeeklyPhase
  periodHistory?: PlayerPeriodHistoryEntry[]
}

export type Player = PlayerState

export type ResourceMarket = Record<PurchasableResource, number[]>
export type ResourceSupply = Record<PurchasableResource, number>

export type City = {
  id: string
  name: string
  lat: number
  lng: number
  size: number
  population: number
  region?: string[]
  labelSide?: "right" | "left" | "top" | "bottom"
  adjacentCities?: AdjacentCity[]
}

export type Route = {
  id: string
  cityA: string
  cityB: string
  mode: RouteMode
  railTraction?: RailTraction
  ownerId?: string
}

export type GameActionLogEntry = {
  id: string
  playerId: string | null
  playerName: string
  week: number
  phase: WeeklyPhase
  message: string
}

export type GameState = {
  map: GameMap
  cities: City[]
  routes: Route[]
  randomState: number
  currentWeek: number
  currentPhase: WeeklyPhase
  isGameOver: boolean
  operatingConfig: OperatingConfig
  chanceCardsEnabled: boolean
  chanceCatalog: ChanceCard[]
  activeChanceCardId: string | null
  chanceDeckCardIds: string[]
  chanceDiscardCardIds: string[]
  cityDemandMultipliersByCityId: Record<string, number>
  bureaucracyFuelUnitsByRouteId: Record<string, number>
  bureaucracyVehicleCardIdsByRouteId: Record<string, string>
  bureaucracyServiceCityIdsByRouteId: Record<string, string[]>
  bureaucracyServiceSlotCountsByCorridorId: Record<string, number>
  resourceMarket: ResourceMarket
  resourceSupply: ResourceSupply
  vehicleCatalog: VehicleCard[]
  vehicleMarketCardIds: string[]
  routeCatalog: RouteDeckCard[]
  routeMarketCardIdsByMode: RouteMarketByMode
  cityDeckCardIdsByRegion: CityDecksByRegion
  activeCityOffer: ActiveCityOffer | null
  bureaucracyReadyPlayerIds: string[]
  purchasedVehiclePlayerIds: string[]
  hasPurchasedVehicleThisPhase: boolean
  purchasedVehicleTypesThisPhase: VehiclePurchasesByType
  claimedRoutePlayerIdsThisTurn: string[]
  claimedRouteCountsByPlayerIdThisTurn: Record<string, number>
  claimedRouteModesThisPhase: RouteClaimsByMode
  botPresetWeightsById?: Partial<Record<BotPresetId, ScriptedBotWeights>>
  turnTimerSeconds: number
  turnTimerExpiresAt: number | null
  autoPlayUntilWeek: number

  players: Player[]
  leadPlayerIndex: number
  currentPlayerId: string
  actionLog: GameActionLogEntry[]
}
