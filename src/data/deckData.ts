import rawAirVehicleCards from "./vehicles/air.json"
import rawBusVehicleCards from "./vehicles/bus.json"
import { chanceCards as defaultChanceCards } from "./chanceCards"
import { defaultRouteCards } from "./defaultRouteCards"
import rawTrainVehicleCards from "./vehicles/train.json"
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

type RawVehicleCard =
  | (typeof rawBusVehicleCards)[number]
  | (typeof rawTrainVehicleCards)[number]
  | (typeof rawAirVehicleCards)[number]

const rawVehicleCards = [
  ...rawBusVehicleCards,
  ...rawTrainVehicleCards,
  ...rawAirVehicleCards,
] as const satisfies readonly RawVehicleCard[]

const LEGACY_BUILT_IN_VEHICLE_CARD_IDS: Record<string, string> = {
  "bus-card-13": "bus-byd-k-m-electric",
  "bus-card-06": "bus-proterra-catalyst-be",
  "bus-card-08": "bus-new-flyer-xcelsior-xe",
  "bus-card-12": "bus-solaris-urbino-electric",
  "bus-card-09": "bus-gillig-low-floor-ev-plus",
  "bus-card-20": "bus-nova-bus-lfse-rapid",
  "bus-card-11": "bus-new-flyer-xcelsior-xe-b",
  "bus-card-14": "bus-solaris-urbino-electric-b",
  "bus-card-24": "bus-d-crt-le",
  "bus-card-25": "bus-prevost-h",
  "bus-card-22": "bus-van-hool-exqui-city",
  "bus-card-10": "bus-new-flyer-xcelsior-xde",
  "bus-card-17": "bus-new-flyer-xcelsior-xt",
  "bus-card-03": "bus-gillig-low-floor",
  "bus-card-15": "bus-new-flyer-xcelsior-xde-b",
  "bus-card-19": "bus-alexander-dennis-enviro",
  "bus-card-28": "bus-superbus-concept",
  "bus-card-01": "bus-twin-coach-gwft",
  "bus-card-07": "bus-orion-hybrid",
  "bus-card-21": "bus-new-flyer-xcelsior-xde-c",
  "bus-card-04": "bus-gm-new-look-fishbowl",
  "bus-card-26": "bus-greyhound-americruiser",
  "bus-card-18": "bus-new-flyer-xcelsior-xt-b",
  "bus-card-16": "bus-new-flyer-de-lfa",
  "bus-card-05": "bus-breda-duobus",
  "bus-card-02": "bus-man-sg-t",
  "bus-card-29": "bus-crrc-autonomous-rail-rapid-transit",
  "bus-card-27": "bus-neoplan-jumbocruiser",
  "bus-card-23": "bus-volvo-electric-articulated",
  "bus-card-30": "bus-autotram-extra-grand",
  "train-card-18": "train-hitachi-class",
  "train-card-11": "train-amtrak-airo-cascades",
  "train-card-05": "train-empire-builder-superliner-set",
  "train-card-14": "train-acela-express",
  "train-card-01": "train-union-pacific-big-boy",
  "train-card-29": "train-caf-oaris",
  "train-card-08": "train-siemens-charger-venture",
  "train-card-09": "train-siemens-venture",
  "train-card-26": "train-hyundai-rotem-ktx-eum",
  "train-card-02": "train-emd-f-locomotive-set",
  "train-card-06": "train-stadler-flirt-h",
  "train-card-07": "train-talgo-series",
  "train-card-28": "train-stadler-smile",
  "train-card-21": "train-tgv-pos",
  "train-card-16": "train-jr-central-l-series",
  "train-card-19": "train-siemens-velaro",
  "train-card-15": "train-amtrak-airo-northeast-regional",
  "train-card-22": "train-shanghai-transrapid",
  "train-card-13": "train-alstom-avelia-liberty",
  "train-card-04": "train-siemens-viaggio-comfort",
  "train-card-12": "train-british-rail-class",
  "train-card-30": "train-chuo-shinkansen-l-series",
  "train-card-24": "train-alstom-agv",
  "train-card-27": "train-talgo-avril",
  "train-card-20": "train-cr-af-fuxing-hao",
  "train-card-10": "train-alstom-euroduplex",
  "train-card-17": "train-series-shinkansen",
  "train-card-03": "train-sounder-bilevel-set",
  "train-card-23": "train-jr-east-e-series",
  "train-card-25": "train-shinkansen-e-series-max",
  "air-card-27": "air-boom-overture",
  "air-card-09": "air-boeing-max",
  "air-card-07": "air-airbus-a",
  "air-card-08": "air-airbus-a-neo",
  "air-card-05": "air-de-havilland-dash",
  "air-card-06": "air-embraer-e-e",
  "air-card-01": "air-ford-trimotor-tin-goose",
  "air-card-26": "air-tupolev-tu",
  "air-card-25": "air-concorde",
  "air-card-02": "air-douglas",
  "air-card-13": "air-boeing",
  "air-card-04": "air-de-havilland-comet",
  "air-card-15": "air-boeing-er",
  "air-card-24": "air-airbus-a-b",
  "air-card-30": "air-spaceline-skylon",
  "air-card-03": "air-lockheed-super-constellation",
  "air-card-14": "air-airbus-a-b-b",
  "air-card-16": "air-airbus-a-c",
  "air-card-17": "air-boeing-er-b",
  "air-card-19": "air-airbus-a-d",
  "air-card-12": "air-lockheed-tristar",
  "air-card-18": "air-boeing-dreamliner",
  "air-card-10": "air-boeing-advanced",
  "air-card-11": "air-mcdonnell-douglas",
  "air-card-28": "air-ilyushin-m",
  "air-card-20": "air-boeing-queen-of-the-skies",
  "air-card-21": "air-airbus-a-e",
  "air-card-29": "air-boeing-b",
  "air-card-22": "air-boeing-er-c",
  "air-card-23": "air-boeing-intercontinental",
}

function toVehicleCard(card: RawVehicleCard): VehicleCard {
  if (!isVehicleType(card.type)) {
    throw new Error(`Invalid vehicle type: ${card.type}`)
  }

  const rawFuel = "fuelResource" in card ? card.fuelResource : undefined
  const fuelResource =
    rawFuel === "diesel" || rawFuel === "jetFuel" ? rawFuel : rawFuel === null ? null : undefined

  return {
    ...card,
    type: card.type,
    vehicleCount: 1,
    totalPassengerCapacity: card.capacityPerVehicle,
    fuelResource,
  }
}

export function normalizeVehicleCardsByPrice(vehicleCards: VehicleCard[]) {
  return (["bus", "train", "air"] as const).flatMap(type =>
    vehicleCards
      .filter(card => card.type === type)
      .sort(
        (cardA, cardB) =>
          cardA.purchasePrice - cardB.purchasePrice ||
          cardA.number - cardB.number ||
          cardA.name.localeCompare(cardB.name) ||
          cardA.id.localeCompare(cardB.id),
      )
      .map((card, index) => ({
        ...card,
        number: index + 1,
      })),
  )
}

export const defaultVehicleCards: VehicleCard[] = normalizeVehicleCardsByPrice(rawVehicleCards.map(toVehicleCard))
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
    (card.fuelResource === undefined ||
      card.fuelResource === null ||
      card.fuelResource === "diesel" ||
      card.fuelResource === "jetFuel") &&
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
      ? normalizeVehicleCardsByPrice(
          decks.vehicleCards.filter(isVehicleCard).map(card => ({
            ...card,
            id: LEGACY_BUILT_IN_VEHICLE_CARD_IDS[card.id] ?? card.id,
            vehicleCount: 1,
            totalPassengerCapacity: card.capacityPerVehicle,
          })),
        )
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

function mergeWithStarterDecks(userDecks: UserDeckData): UserDeckData {
  const starterDecks = createInitialUserDecks()

  return {
    vehicleCards: normalizeVehicleCardsByPrice([
      ...userDecks.vehicleCards,
      ...starterDecks.vehicleCards.filter(
        starterCard => !userDecks.vehicleCards.some(card => card.id === starterCard.id),
      ),
    ]),
    chanceCards: [
      ...userDecks.chanceCards,
      ...starterDecks.chanceCards.filter(
        starterCard => !userDecks.chanceCards.some(card => card.id === starterCard.id),
      ),
    ],
    routeCards: [
      ...userDecks.routeCards,
      ...starterDecks.routeCards.filter(
        starterCard => !userDecks.routeCards.some(card => card.id === starterCard.id),
      ),
    ],
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
    return mergeWithStarterDecks(coerceUserDecks(JSON.parse(rawValue)))
  } catch (error) {
    console.error("Failed to load saved user decks.", error)
    return createInitialUserDecks()
  }
}

export function saveUserDecks(userDecks: UserDeckData) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(
    USER_DECKS_STORAGE_KEY,
    JSON.stringify(
      {
        ...userDecks,
        vehicleCards: normalizeVehicleCardsByPrice(userDecks.vehicleCards),
      },
      null,
      2,
    ),
  )
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
