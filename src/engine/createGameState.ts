import type { GameMap } from "./maps/types"
import type {
  GameState,
  OperatingConfig,
  Player,
  ResourceMarket,
  ResourceSupply,
  VehicleCard,
} from "./types"
import vehicleCards from "../data/vehicleCards.json"

const INITIAL_RESOURCE_MARKET: ResourceMarket = {
  diesel: [3, 3, 3, 3, 3, 3, 3, 3],
  jetFuel: [0, 0, 3, 3, 3, 3, 6, 6],
}

const INITIAL_RESOURCE_SUPPLY: ResourceSupply = {
  diesel: 0,
  jetFuel: 24,
}

const INITIAL_OPERATING_CONFIG: OperatingConfig = {
  hoursPerDay: 14,
  daysPerWeek: 7,
  loadingHours: {
    air: 1,
    train: 0.5,
    bus: 0.25,
  },
  railConstructionCostPerMile: 1_000_000,
  fuelUnits: {
    diesel: 1000,
    jetFuel: 120000,
  },
  fuelPricePerRealUnit: {
    diesel: 3,
    jetFuel: 0.6,
  },
  revenuePerPassengerMile: {
    air: 0.153,
    rail: 0.38,
    bus: 0.15,
  },
}

function isVehicleType(type: string): type is VehicleCard["type"] {
  return type === "bus" || type === "train" || type === "air"
}

function getStarterVehicleCards(): VehicleCard[] {
  return vehicleCards.map(card => {
    if (!isVehicleType(card.type)) {
      throw new Error(`Invalid vehicle type: ${card.type}`)
    }

    return {
      ...card,
      type: card.type,
    }
  })
}

function shuffleVehicleCards() {
  const shuffledCards = getStarterVehicleCards()

  for (let index = shuffledCards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const currentCard = shuffledCards[index]
    shuffledCards[index] = shuffledCards[swapIndex]
    shuffledCards[swapIndex] = currentCard
  }

  return shuffledCards
}

function createPlayer(
  id: string,
  name: string,
  color: string,
): Player {
  return {
    id,
    name,
    color,
    money: 100000000,
    inventory: {
      vehicles: {
        trains: 0,
        planes: 0,
        buses: 0,
      },
      fuel: {
        diesel: 0,
        jetFuel: 0,
      },
    },
    ownedVehicleCardIds: [],
    operatingCosts: 0,
    weeklyPayout: 0,
  }
}

export function createGameState(map: GameMap): GameState {
  const shuffledVehicleCards = shuffleVehicleCards()

  return {
    map,

    cities: map.cities,
    routes: [],
    currentWeek: 1,
    currentPhase: "purchase-equipment",
    operatingConfig: INITIAL_OPERATING_CONFIG,
    bureaucracyFuelUnitsByRouteId: {},
    bureaucracyVehicleCardIdsByRouteId: {},
    resourceMarket: INITIAL_RESOURCE_MARKET,
    resourceSupply: INITIAL_RESOURCE_SUPPLY,
    vehicleCatalog: shuffledVehicleCards,
    vehicleMarketCardIds: shuffledVehicleCards.map(card => card.id),
    hasPurchasedVehicleThisTurn: false,

    players: [
      createPlayer("p1", "Matt", "#e63946"),
      createPlayer("p2", "Bot", "#457b9d"),
    ],

    currentPlayerId: "p1",
  }
}
