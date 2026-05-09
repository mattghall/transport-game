import type { GameMap } from "./maps/types"
import type {
  ChanceCard,
  GameState,
  OperatingConfig,
  Player,
  ResourceMarket,
  ResourceSupply,
  VehicleCard,
} from "./types"
import vehicleCards from "../data/vehicleCards.json"
import { chanceCards } from "../data/chanceCards"

const INITIAL_RESOURCE_MARKET: ResourceMarket = {
  diesel: [5, 5, 5, 5, 4, 4, 4, 4],
  jetFuel: [0, 0, 3, 3, 3, 3, 6, 6],
}

const INITIAL_RESOURCE_SUPPLY: ResourceSupply = {
  diesel: 32,
  jetFuel: 24,
}

const INITIAL_OPERATING_CONFIG: OperatingConfig = {
  hoursPerDay: 14,
  daysPerWeek: 7,
  totalWeeks: 10,
  loadingHours: {
    air: 1,
    train: 0.5,
    bus: 0.25,
  },
  passengersPerDemandPoint: 45,
  connectionBonusPerCitySize: 500_000,
  railConstructionCostPerMile: 60_000,
  railElectrificationCostPerMile: 8_000,
  operatingCostPerTrip: {
    bus: 3_500,
    air: 24_000,
    railDiesel: 3_500,
    railElectric: 1_500,
  },
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

export type GameSetupPlayer = {
  id: string
  name: string
  color: string
}

export type CreateGameStateOptions = {
  players?: GameSetupPlayer[]
}

const DEFAULT_PLAYERS: GameSetupPlayer[] = [
  { id: "p1", name: "Matt", color: "#e63946" },
  { id: "p2", name: "Bot", color: "#457b9d" },
]

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

function shuffleCards<T>(cards: T[]) {
  const shuffledCards = [...cards]

  for (let index = shuffledCards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const currentCard = shuffledCards[index]
    shuffledCards[index] = shuffledCards[swapIndex]
    shuffledCards[swapIndex] = currentCard
  }

  return shuffledCards
}

function shuffleVehicleCards() {
  return shuffleCards(getStarterVehicleCards())
}

function shuffleChanceCards() {
  return shuffleCards(chanceCards as ChanceCard[])
}

function createPlayer(player: GameSetupPlayer): Player {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    money: 140000000,
    totalPassengersServed: 0,
    startingCityId: undefined,
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

export function createGameState(
  map: GameMap,
  options: CreateGameStateOptions = {},
): GameState {
  const shuffledVehicleCards = shuffleVehicleCards()
  const shuffledChanceCards = shuffleChanceCards()
  const [activeChanceCard, ...chanceDeck] = shuffledChanceCards
  const players = (options.players ?? DEFAULT_PLAYERS).map(createPlayer)

  return {
    map,
    cities: map.cities,
    routes: [],
    currentWeek: 1,
    currentPhase: "purchase-equipment",
    isGameOver: false,
    operatingConfig: INITIAL_OPERATING_CONFIG,
    chanceCatalog: chanceCards as ChanceCard[],
    activeChanceCardId: activeChanceCard?.id ?? null,
    chanceDeckCardIds: chanceDeck.map(card => card.id),
    chanceDiscardCardIds: [],
    bureaucracyFuelUnitsByRouteId: {},
    bureaucracyVehicleCardIdsByRouteId: {},
    resourceMarket: INITIAL_RESOURCE_MARKET,
    resourceSupply: INITIAL_RESOURCE_SUPPLY,
    vehicleCatalog: shuffledVehicleCards,
    vehicleMarketCardIds: shuffledVehicleCards.map(card => card.id),
    hasPurchasedVehicleThisTurn: false,
    players,
    leadPlayerIndex: 0,
    currentPlayerId: players[0]?.id ?? "p1",
  }
}
