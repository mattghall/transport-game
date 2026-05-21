import type { GameMap } from "./maps/types"
import { calculateDistanceMiles } from "./trips"
import type {
  ChanceCard,
  GameState,
  OperatingConfig,
  Player,
  RouteClaimsByMode,
  RouteDeckCard,
  RouteMarketByMode,
  ResourceMarket,
  ResourceSupply,
  RouteMode,
  VehicleCard,
  VehiclePurchasesByType,
} from "./types"
import { defaultDecks } from "../data/deckData"

const OPENING_VEHICLE_POOL_SIZE = 5
const OPENING_VISIBLE_TRAIN_COUNT = 2
const OPENING_VISIBLE_ROUTE_COUNT = 3
const EMPTY_VEHICLE_PURCHASES_BY_TYPE: VehiclePurchasesByType = {
  bus: false,
  train: false,
  air: false,
}
const EMPTY_ROUTE_CLAIMS_BY_MODE: RouteClaimsByMode = {
  bus: false,
  rail: false,
  air: false,
}

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
  passengersPerDemandPoint: 50,
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
  return (["bus", "train", "air"] as const).flatMap(type => {
    const typeCards = cards
      .filter(card => card.type === type)
      .sort((cardA, cardB) => cardA.number - cardB.number)
    const openingCards = shuffleCards(typeCards.slice(0, OPENING_VEHICLE_POOL_SIZE))
    const remainingCards = shuffleCards(typeCards.slice(OPENING_VEHICLE_POOL_SIZE))

    return [...openingCards, ...remainingCards]
  })
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

function calculateOpeningRailRouteCost(
  routeCard: RouteDeckCard,
  map: GameMap,
  railConstructionCostPerMile: number,
) {
  if (routeCard.mode !== "rail") {
    return 0
  }

  return routeCard.cityIds.slice(0, -1).reduce((total, cityId, index) => {
    const cityA = map.cities.find(city => city.id === cityId)
    const cityB = map.cities.find(city => city.id === routeCard.cityIds[index + 1])

    if (!cityA || !cityB) {
      return total
    }

    return total + calculateDistanceMiles(cityA, cityB) * railConstructionCostPerMile
  }, 0)
}

function seedOpeningRouteMarket(
  routeMarketByMode: RouteMarketByMode,
  routeCards: RouteDeckCard[],
  map: GameMap,
  railConstructionCostPerMile: number,
  startingMoney: number,
  shuffledVehicleCards: VehicleCard[],
) {
  const openingTrainCards: VehicleCard[] = []

  for (const card of shuffledVehicleCards) {
    if (card.type !== "train") {
      continue
    }

    openingTrainCards.push(card)

    if (openingTrainCards.length >= OPENING_VISIBLE_TRAIN_COUNT) {
      break
    }
  }

  if (openingTrainCards.length === 0) {
    return routeMarketByMode
  }

  const openingRailBudget = startingMoney - Math.min(...openingTrainCards.map(card => card.purchasePrice))
  const railRouteCardsById = new Map(routeCards.filter(card => card.mode === "rail").map(card => [card.id, card]))
  const visibleRailIds = routeMarketByMode.rail.slice(0, OPENING_VISIBLE_ROUTE_COUNT)
  const hasAffordableVisibleRail = visibleRailIds.some(cardId => {
    const routeCard = railRouteCardsById.get(cardId)

    return routeCard !== undefined &&
      calculateOpeningRailRouteCost(routeCard, map, railConstructionCostPerMile) <= openingRailBudget
  })

  if (hasAffordableVisibleRail) {
    return routeMarketByMode
  }

  const affordableRailCardId = routeMarketByMode.rail.find(cardId => {
    const routeCard = railRouteCardsById.get(cardId)

    return routeCard !== undefined &&
      calculateOpeningRailRouteCost(routeCard, map, railConstructionCostPerMile) <= openingRailBudget
  })

  if (!affordableRailCardId) {
    return routeMarketByMode
  }

  return {
    ...routeMarketByMode,
    rail: [
      affordableRailCardId,
      ...routeMarketByMode.rail.filter(cardId => cardId !== affordableRailCardId),
    ],
  }
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
    ownedVehicleCountsByCardId: {},
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
  const startingMoney = options.startingMoney ?? DEFAULT_STARTING_MONEY
  const shuffledRouteMarketCardIdsByMode = seedOpeningRouteMarket(
    shuffleRouteCards(routeCards),
    routeCards,
    map,
    INITIAL_OPERATING_CONFIG.railConstructionCostPerMile,
    startingMoney,
    shuffledVehicleCards,
  )
  const [activeChanceCard, ...chanceDeck] = shuffledChanceCards
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
    purchasedVehicleTypesThisPhase: EMPTY_VEHICLE_PURCHASES_BY_TYPE,
    hasClaimedRouteThisTurn: false,
    claimedRouteModesThisPhase: EMPTY_ROUTE_CLAIMS_BY_MODE,
    players,
    leadPlayerIndex: 0,
    currentPlayerId: players[0]?.id ?? "p1",
    actionLog: [],
  }
}
