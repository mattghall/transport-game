import type { GameMap } from "./maps/types"
import type {
  ChanceCard,
  CityDeckRegion,
  CityDecksByRegion,
  GameState,
  OperatingConfig,
  Player,
  RouteClaimsByMode,
  ResourceMarket,
  ResourceSupply,
  VehicleCard,
  VehiclePurchasesByType,
} from "./types"
import { CITY_DECK_REGIONS as CITY_DECK_REGION_LIST } from "./types"
import { defaultDecks } from "../data/deckData"

const OPENING_VEHICLE_POOL_SIZE = 5
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
      bus: 8,
      train: 18,
      air: 45,
    },
    maintenanceCostPerWeekPerVehicle: {
      bus: 150,
      train: 600,
      air: 2_500,
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
    diesel: 0.6,
    jetFuel: 0.15,
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
  startingMoney?: number
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

function getPrimaryRegion(region: GameMap["cities"][number]["region"]): CityDeckRegion | null {
  const primaryRegion = region?.[0]
  return primaryRegion && CITY_DECK_REGION_LIST.includes(primaryRegion as CityDeckRegion)
    ? (primaryRegion as CityDeckRegion)
    : null
}

function shuffleCityDecks(map: GameMap): CityDecksByRegion {
  const decks = CITY_DECK_REGION_LIST.reduce<CityDecksByRegion>(
    (result, region) => ({
      ...result,
      [region]: [],
    }),
    {
      Pacific: [],
      Mountain: [],
      South: [],
      Southeast: [],
      Midwest: [],
      Northeast: [],
    },
  )

  for (const city of map.cities) {
    const primaryRegion = getPrimaryRegion(city.region)

    if (!primaryRegion) {
      continue
    }

    decks[primaryRegion].push(city.id)
  }

  for (const region of CITY_DECK_REGION_LIST) {
    decks[region] = shuffleCards(decks[region])
  }

  return decks
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
    ownedCityCardIds: [],
  }
}

function getSetupPlayers(players?: GameSetupPlayer[]) {
  if (players && players.length > 0) {
    return players
  }

  throw new Error("createGameState requires at least one setup player.")
}

function applyOpeningBusPurchases(
  players: Player[],
  vehicleCards: VehicleCard[],
) {
  const seededBusCards = [1, 2]
    .map(number => vehicleCards.find(card => card.type === "bus" && card.number === number) ?? null)
    .filter((card): card is VehicleCard => card !== null)

  const nextPlayers = players.map(player => ({
    ...player,
    inventory: {
      ...player.inventory,
      vehicles: {
        ...player.inventory.vehicles,
      },
      fuel: {
        ...player.inventory.fuel,
      },
    },
    ownedVehicleCardIds: [...player.ownedVehicleCardIds],
    ownedVehicleCountsByCardId: { ...player.ownedVehicleCountsByCardId },
  }))

  seededBusCards.forEach((card, index) => {
    const player = nextPlayers[index]

    if (!player) {
      return
    }

    player.money -= card.purchasePrice
    player.ownedVehicleCardIds = [...new Set([...player.ownedVehicleCardIds, card.id])]
    player.ownedVehicleCountsByCardId[card.id] = (player.ownedVehicleCountsByCardId[card.id] ?? 0) + 1
    player.inventory.vehicles.buses += 1
  })

  return {
    players: nextPlayers,
    seededVehicleCardIds: seededBusCards.map(card => card.id),
  }
}

export function createGameState(
  map: GameMap,
  options: CreateGameStateOptions = {},
): GameState {
  const vehicleCards = options.vehicleCards ?? defaultDecks.vehicleCards
  const chanceCards = options.chanceCards ?? defaultDecks.chanceCards
  const shuffledVehicleCards = shuffleVehicleCards(vehicleCards)
  const shuffledChanceCards = shuffleChanceCards(chanceCards)
  const startingMoney = options.startingMoney ?? DEFAULT_STARTING_MONEY
  const [activeChanceCard, ...chanceDeck] = shuffledChanceCards
  const initialPlayers = getSetupPlayers(options.players).map(player =>
    createPlayer(player, startingMoney),
  )
  const openingSetup = applyOpeningBusPurchases(initialPlayers, shuffledVehicleCards)
  const players = openingSetup.players
 
  return {
    map,
    cities: map.cities,
    routes: [],
    currentWeek: 1,
    currentPhase: "claim-routes",
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
    vehicleMarketCardIds: shuffledVehicleCards
      .filter(card => !openingSetup.seededVehicleCardIds.includes(card.id))
      .map(card => card.id),
    routeCatalog: [],
    routeMarketCardIdsByMode: { bus: [], rail: [], air: [] },
    cityDeckCardIdsByRegion: shuffleCityDecks(map),
    activeCityOffer: null,
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
