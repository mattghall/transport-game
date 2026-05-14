import type { GameMap } from "./maps/types"

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

export type OperatingConfig = {
  hoursPerDay: number
  daysPerWeek: number
  weeksPerPeriod: number
  totalWeeks: number
  loadingHours: Record<VehicleType, number>
  passengersPerDemandPoint: number
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

export type Player = {
  id: string
  name: string
  color: string
  money: number
  totalPassengersServed: number
  startingCityId?: string
  inventory: PlayerInventory
  ownedVehicleCardIds: string[]
  operatingCosts: number
  weeklyPayout: number
  lastPeriodPassengersServed: number
}

export type RouteMode = "rail" | "air" | "bus"
export type WeeklyPhase =
  | "purchase-fuel"
  | "claim-routes"
  | "purchase-equipment"
  | "bureaucracy"

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
  currentWeek: number
  currentPhase: WeeklyPhase
  isGameOver: boolean
  operatingConfig: OperatingConfig
  chanceCatalog: ChanceCard[]
  activeChanceCardId: string | null
  chanceDeckCardIds: string[]
  chanceDiscardCardIds: string[]
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
  hasPurchasedVehicleThisTurn: boolean
  hasPurchasedVehicleThisPhase: boolean
  hasClaimedRouteThisTurn: boolean

  players: Player[]
  leadPlayerIndex: number
  currentPlayerId: string
  actionLog: GameActionLogEntry[]
}
