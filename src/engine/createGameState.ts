import type { GameMap } from "./maps/types"
import type {
  ChanceCard,
  GameState,
  OperatingConfig,
  Player,
  RouteDeckCard,
  RouteMarketByMode,
  ResourceMarket,
  ResourceSupply,
  RouteMode,
  VehicleCard,
} from "./types"
import { defaultDecks } from "../data/deckData"

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
  weeksPerPeriod: 4,
  totalWeeks: 10,
  loadingHours: {
    air: 1,
    train: 0.5,
    bus: 0.25,
  },
  passengersPerDemandPoint: 45,
  connectionBonusPerCitySize: 500_000,
  railConstructionCostPerMile: 120_000,
  railElectrificationCostPerMile: 8_000,
  realWorldOperatingCosts: {
    crewHourlyCostPerVehicle: {
      bus: 30,
      train: 45,
      air: 120,
    },
    maintenanceCostPerWeekPerVehicle: {
      bus: 1_000,
      train: 3_000,
      air: 10_000,
    },
  },
  balanceAdjustmentPerTrip: {
    bus: 0,
    air: 0,
    railDiesel: 0,
    railElectric: 0,
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

export const DEFAULT_STARTING_MONEY = 140_000_000

export type GameSetupPlayer = {
  id: string
  name: string
  color: string
}

export type CreateGameStateOptions = {
  players?: GameSetupPlayer[]
  vehicleCards?: VehicleCard[]
  chanceCards?: ChanceCard[]
  routeCards?: RouteDeckCard[]
  startingMoney?: number
}

export const DEFAULT_PLAYERS: GameSetupPlayer[] = [
  { id: "p1", name: "Matt", color: "#457b9d" },
  { id: "p2", name: "Sarah", color: "#e96620" },
]

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

function shuffleVehicleCards(cards: VehicleCard[]) {
  const openingCards = shuffleCards(cards.slice(0, 6))
  const remainingCards = shuffleCards(cards.slice(6))

  return [...openingCards, ...remainingCards]
}

function shuffleChanceCards(cards: ChanceCard[]) {
  return shuffleCards(cards)
}

function shuffleRouteCards(cards: RouteDeckCard[]): RouteMarketByMode {
  return (["bus", "rail", "air"] as RouteMode[]).reduce<RouteMarketByMode>(
    (marketByMode, mode) => ({
      ...marketByMode,
      [mode]: shuffleCards(cards.filter(card => card.mode === mode)).map(card => card.id),
    }),
    { bus: [], rail: [], air: [] },
  )
}

function createPlayer(player: GameSetupPlayer, startingMoney: number): Player {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    money: startingMoney,
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
    lastPeriodPassengersServed: 0,
  }
}

export function createGameState(
  map: GameMap,
  options: CreateGameStateOptions = {},
): GameState {
  const vehicleCards = options.vehicleCards ?? defaultDecks.vehicleCards
  const chanceCards = options.chanceCards ?? defaultDecks.chanceCards
  const routeCards = options.routeCards ?? defaultDecks.routeCards
  const shuffledVehicleCards = shuffleVehicleCards(vehicleCards)
  const shuffledChanceCards = shuffleChanceCards(chanceCards)
  const shuffledRouteMarketCardIdsByMode = shuffleRouteCards(routeCards)
  const [activeChanceCard, ...chanceDeck] = shuffledChanceCards
  const startingMoney = options.startingMoney ?? DEFAULT_STARTING_MONEY
  const players = (options.players ?? DEFAULT_PLAYERS).map(player =>
    createPlayer(player, startingMoney),
  )

  return {
    map,
    cities: map.cities,
    routes: [],
    currentWeek: 1,
    currentPhase: "purchase-equipment",
    isGameOver: false,
    operatingConfig: INITIAL_OPERATING_CONFIG,
    chanceCatalog: chanceCards,
    activeChanceCardId: activeChanceCard?.id ?? null,
    chanceDeckCardIds: chanceDeck.map(card => card.id),
    chanceDiscardCardIds: [],
    bureaucracyFuelUnitsByRouteId: {},
    bureaucracyVehicleCardIdsByRouteId: {},
    bureaucracyServiceCityIdsByRouteId: {},
    bureaucracyServiceSlotCountsByCorridorId: {},
    resourceMarket: INITIAL_RESOURCE_MARKET,
    resourceSupply: INITIAL_RESOURCE_SUPPLY,
    vehicleCatalog: shuffledVehicleCards,
    vehicleMarketCardIds: shuffledVehicleCards.map(card => card.id),
    routeCatalog: routeCards,
    routeMarketCardIdsByMode: shuffledRouteMarketCardIdsByMode,
    hasPurchasedVehicleThisTurn: false,
    hasPurchasedVehicleThisPhase: false,
    hasClaimedRouteThisTurn: false,
    players,
    leadPlayerIndex: 0,
    currentPlayerId: players[0]?.id ?? "p1",
    actionLog: [],
  }
}
