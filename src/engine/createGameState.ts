import { DEFAULT_BOT_PRESET_ID, normalizeBotPresetId, type BotPresetId } from "../bots/presets"
import type { ScriptedBotWeights } from "../bots/scriptedBot"
import type { GameMap } from "./maps/types"
import type {
  ChanceCard,
  CityDeckRegion,
  CityDecksByRegion,
  GameState,
  OperatingConfig,
  PlayerState,
  RouteClaimsByMode,
  ResourceMarket,
  ResourceSupply,
  VehicleCard,
  VehiclePurchasesByType,
} from "./types"
import { CITY_DECK_REGIONS as CITY_DECK_REGION_LIST } from "./types"
import { defaultDecks } from "../data/deckData"
import { createInitialRandomState, shuffleWithRandomState } from "./random"

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
  demandPointsPerCitySize: 30,
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
  isBot?: boolean
  botPreset?: BotPresetId
}

export type CreateGameStateOptions = {
  players?: GameSetupPlayer[]
  vehicleCards?: VehicleCard[]
  chanceCards?: ChanceCard[]
  startingMoney?: number
  seed?: number
  botPresetWeightsById?: Partial<Record<BotPresetId, ScriptedBotWeights>>
}

function shuffleVehicleCards(cards: VehicleCard[], initialRandomState: number) {
  let randomState = initialRandomState
  const shuffledCards = (["bus", "train", "air"] as const).flatMap(type => {
    const typeCards = cards
      .filter(card => card.type === type)
      .sort((cardA, cardB) => cardA.number - cardB.number)
    const openingShuffle = shuffleWithRandomState(typeCards.slice(0, OPENING_VEHICLE_POOL_SIZE), randomState)
    randomState = openingShuffle.randomState
    const remainingShuffle = shuffleWithRandomState(typeCards.slice(OPENING_VEHICLE_POOL_SIZE), randomState)
    randomState = remainingShuffle.randomState

    return [...openingShuffle.items, ...remainingShuffle.items]
  })

  return {
    cards: shuffledCards,
    randomState,
  }
}

function shuffleChanceCards(cards: ChanceCard[], randomState: number) {
  return shuffleWithRandomState(cards, randomState)
}

function getPrimaryRegion(region: GameMap["cities"][number]["region"]): CityDeckRegion | null {
  const primaryRegion = region?.[0]
  return primaryRegion && CITY_DECK_REGION_LIST.includes(primaryRegion as CityDeckRegion)
    ? (primaryRegion as CityDeckRegion)
    : null
}

function shuffleCityDecks(map: GameMap, initialRandomState: number) {
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
  let randomState = initialRandomState

  for (const city of map.cities) {
    const primaryRegion = getPrimaryRegion(city.region)

    if (!primaryRegion) {
      continue
    }

    decks[primaryRegion].push(city.id)
  }

  for (const region of CITY_DECK_REGION_LIST) {
    const shuffledRegion = shuffleWithRandomState(decks[region], randomState)
    decks[region] = shuffledRegion.items
    randomState = shuffledRegion.randomState
  }

  return {
    decks,
    randomState,
  }
}

function createPlayer(
  player: GameSetupPlayer,
  startingMoney: number,
  phase: "purchase-equipment" | "add-city",
): PlayerState {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    isBot: player.isBot ?? false,
    botPreset: player.isBot ? normalizeBotPresetId(player.botPreset ?? DEFAULT_BOT_PRESET_ID) : undefined,
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
    phase,
    periodHistory: [],
  }
}

function getSetupPlayers(players?: GameSetupPlayer[]) {
  if (players && players.length > 0) {
    return players
  }

  throw new Error("createGameState requires at least one setup player.")
}

function applyOpeningBusPurchases(
  players: PlayerState[],
  vehicleCards: VehicleCard[],
) {
  const siennaCard = vehicleCards.find(card => card.id === "bus-toyota-sienna") ?? null

  const nextPlayers = players.map(player => ({
    ...player,
    inventory: {
      ...player.inventory,
      vehicles: { ...player.inventory.vehicles },
      fuel: { ...player.inventory.fuel },
    },
    ownedVehicleCardIds: [...player.ownedVehicleCardIds],
    ownedVehicleCountsByCardId: { ...player.ownedVehicleCountsByCardId },
  }))

  // Give every player a free Toyota Sienna starter vehicle
  if (siennaCard) {
    nextPlayers.forEach(player => {
      player.ownedVehicleCardIds = [...new Set([...player.ownedVehicleCardIds, siennaCard.id])]
      player.ownedVehicleCountsByCardId[siennaCard.id] = (player.ownedVehicleCountsByCardId[siennaCard.id] ?? 0) + 1
      player.inventory.vehicles.buses += 1
    })
  }

  return {
    players: nextPlayers,
    seededVehicleCardIds: [] as string[],
  }
}

export function createGameState(
  map: GameMap,
  options: CreateGameStateOptions = {},
): GameState {
  const vehicleCards = options.vehicleCards ?? defaultDecks.vehicleCards
  const chanceCards = options.chanceCards ?? defaultDecks.chanceCards
  const initialRandomState = createInitialRandomState(options.seed)
  const vehicleShuffle = shuffleVehicleCards(vehicleCards, initialRandomState)
  const chanceShuffle = shuffleChanceCards(chanceCards, vehicleShuffle.randomState)
  const startingMoney = options.startingMoney ?? DEFAULT_STARTING_MONEY
  const [activeChanceCard, ...chanceDeck] = chanceShuffle.items
  const initialPhase = "add-city" as const
  const initialPlayers = getSetupPlayers(options.players).map(player =>
    createPlayer(player, startingMoney, initialPhase),
  )
  const openingSetup = applyOpeningBusPurchases(initialPlayers, vehicleShuffle.cards)
  const players = openingSetup.players
  const cityDeckShuffle = shuffleCityDecks(map, chanceShuffle.randomState)

  return {
    map,
    cities: map.cities,
    routes: [],
    randomState: cityDeckShuffle.randomState,
    currentWeek: 1,
    currentPhase: "add-city",
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
    vehicleCatalog: vehicleShuffle.cards,
    vehicleMarketCardIds: vehicleShuffle.cards
      .filter(card => !openingSetup.seededVehicleCardIds.includes(card.id))
      .map(card => card.id),
    routeCatalog: [],
    routeMarketCardIdsByMode: { bus: [], rail: [], air: [] },
    cityDeckCardIdsByRegion: cityDeckShuffle.decks,
    activeCityOffer: null,
    bureaucracyReadyPlayerIds: [],
    purchasedVehiclePlayerIds: [],
    hasPurchasedVehicleThisPhase: false,
    purchasedVehicleTypesThisPhase: EMPTY_VEHICLE_PURCHASES_BY_TYPE,
    claimedRoutePlayerIdsThisTurn: [],
    claimedRouteCountsByPlayerIdThisTurn: {},
    claimedRouteModesThisPhase: EMPTY_ROUTE_CLAIMS_BY_MODE,
    botPresetWeightsById: options.botPresetWeightsById ? { ...options.botPresetWeightsById } : undefined,
    players,
    leadPlayerIndex: 0,
    currentPlayerId: players[0]?.id ?? "p1",
    actionLog: [],
  }
}
