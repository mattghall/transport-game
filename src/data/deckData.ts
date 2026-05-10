import rawVehicleCards from "./vehicleCards.json"
import { chanceCards as defaultChanceCards } from "./chanceCards"
import { defaultRouteCards } from "./defaultRouteCards"
import type {
  ChanceCard,
  RouteDeckCard,
  RouteMode,
  UserDeckData,
  VehicleCard,
} from "../engine/types"

const USER_DECKS_STORAGE_KEY = "transport-game-user-decks-v1"

function isVehicleType(type: string): type is VehicleCard["type"] {
  return type === "bus" || type === "train" || type === "air"
}

function toVehicleCard(card: (typeof rawVehicleCards)[number]): VehicleCard {
  if (!isVehicleType(card.type)) {
    throw new Error(`Invalid vehicle type: ${card.type}`)
  }

  return {
    ...card,
    type: card.type,
  }
}

export const defaultVehicleCards: VehicleCard[] = rawVehicleCards.map(toVehicleCard)
export const defaultDecks = {
  vehicleCards: defaultVehicleCards,
  chanceCards: defaultChanceCards,
  routeCards: defaultRouteCards,
} as const

export function createInitialUserDecks(): UserDeckData {
  return {
    vehicleCards: defaultDecks.vehicleCards.map(card => ({ ...card })),
    chanceCards: defaultDecks.chanceCards.map(card => ({
      ...card,
      fuelPriceMultiplier: card.fuelPriceMultiplier
        ? { ...card.fuelPriceMultiplier }
        : undefined,
      demandBoost: card.demandBoost
        ? {
            ...card.demandBoost,
            regions: [...card.demandBoost.regions],
          }
        : undefined,
      connectionBonus: card.connectionBonus
        ? { ...card.connectionBonus }
        : undefined,
    })),
    routeCards: defaultDecks.routeCards.map(card => ({
      ...card,
      cityIds: [...card.cityIds],
    })),
  }
}

export const EMPTY_USER_DECKS: UserDeckData = {
  vehicleCards: [],
  chanceCards: [],
  routeCards: [],
}

function isChanceCard(value: unknown): value is ChanceCard {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const card = value as Partial<ChanceCard>
  return typeof card.id === "string" && typeof card.title === "string" && typeof card.description === "string"
}

function isVehicleCard(value: unknown): value is VehicleCard {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const card = value as Partial<VehicleCard>
  return (
    typeof card.id === "string" &&
    typeof card.number === "number" &&
    isVehicleType(card.type ?? "") &&
    typeof card.name === "string" &&
    typeof card.purchasePrice === "number" &&
    typeof card.vehicleCount === "number" &&
    typeof card.capacityPerVehicle === "number" &&
    typeof card.totalPassengerCapacity === "number" &&
    typeof card.operatingCostMultiplier === "number" &&
    typeof card.speed === "number" &&
    typeof card.funFact === "string"
  )
}

function isRouteMode(value: unknown): value is RouteMode {
  return value === "bus" || value === "rail" || value === "air"
}

function isRouteDeckCard(value: unknown): value is RouteDeckCard {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const card = value as Partial<RouteDeckCard>
  return (
    typeof card.id === "string" &&
    isRouteMode(card.mode) &&
    typeof card.title === "string" &&
    Array.isArray(card.cityIds) &&
    card.cityIds.every(cityId => typeof cityId === "string") &&
    (card.isLoop === undefined || typeof card.isLoop === "boolean") &&
    (card.notes === undefined || typeof card.notes === "string")
  )
}

export function coerceUserDecks(value: unknown): UserDeckData {
  if (typeof value !== "object" || value === null) {
    return EMPTY_USER_DECKS
  }

  const decks = value as Partial<UserDeckData>

  return {
    vehicleCards: Array.isArray(decks.vehicleCards)
      ? decks.vehicleCards.filter(isVehicleCard)
      : [],
    chanceCards: Array.isArray(decks.chanceCards)
      ? decks.chanceCards.filter(isChanceCard)
      : [],
    routeCards: Array.isArray(decks.routeCards)
      ? decks.routeCards.filter(isRouteDeckCard).map(card => ({
          ...card,
          cityIds: card.mode === "air" ? card.cityIds.slice(0, 2) : card.cityIds,
          isLoop: card.mode === "air" ? false : card.isLoop ?? false,
        }))
      : [],
  }
}

export function loadUserDecks(): UserDeckData {
  if (typeof window === "undefined") {
    return createInitialUserDecks()
  }

  const rawValue = window.localStorage.getItem(USER_DECKS_STORAGE_KEY)

  if (!rawValue) {
    return createInitialUserDecks()
  }

  try {
    return coerceUserDecks(JSON.parse(rawValue))
  } catch (error) {
    console.error("Failed to load saved user decks.", error)
    return createInitialUserDecks()
  }
}

export function saveUserDecks(userDecks: UserDeckData) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(USER_DECKS_STORAGE_KEY, JSON.stringify(userDecks, null, 2))
}

export function createEmptyVehicleCard(number: number): VehicleCard {
  return {
    id: `user-vehicle-${crypto.randomUUID()}`,
    number,
    type: "bus",
    name: "New vehicle card",
    purchasePrice: 1_000_000,
    vehicleCount: 1,
    capacityPerVehicle: 40,
    totalPassengerCapacity: 40,
    operatingCostMultiplier: 1,
    speed: 50,
    funFact: "",
  }
}

export function createEmptyChanceCard(index: number): ChanceCard {
  return {
    id: `user-chance-${crypto.randomUUID()}`,
    title: `New chance card ${index}`,
    description: "",
  }
}

export function createEmptyRouteCard(mode: RouteMode): RouteDeckCard {
  return {
    id: `user-route-${crypto.randomUUID()}`,
    mode,
    title: `New ${mode} route`,
    cityIds: [],
    isLoop: false,
    notes: "",
  }
}
