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

export type OperatingConfig = {
  hoursPerDay: number
  daysPerWeek: number
  loadingHours: Record<VehicleType, number>
  railConstructionCostPerMile: number
  fuelUnits: Record<PurchasableResource, number>
  fuelPricePerRealUnit: Record<PurchasableResource, number>
  revenuePerPassengerMile: Record<RouteMode, number>
}

export type Player = {
  id: string
  name: string
  color: string
  money: number
  inventory: PlayerInventory
  ownedVehicleCardIds: string[]
  operatingCosts: number
  weeklyPayout: number
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
  ownerId?: string
}

export type GameState = {
  map: GameMap
  cities: City[]
  routes: Route[]
  currentWeek: number
  currentPhase: WeeklyPhase
  operatingConfig: OperatingConfig
  bureaucracyFuelUnitsByRouteId: Record<string, number>
  bureaucracyVehicleCardIdsByRouteId: Record<string, string>
  resourceMarket: ResourceMarket
  resourceSupply: ResourceSupply
  vehicleCatalog: VehicleCard[]
  vehicleMarketCardIds: string[]
  hasPurchasedVehicleThisTurn: boolean

  players: Player[]
  currentPlayerId: string
}
