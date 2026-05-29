import vehicleCards from "../data/vehicleCards.json";
import { chanceCards } from "../data/chanceCards";
const INITIAL_RESOURCE_MARKET = {
    diesel: [3, 3, 3, 3, 3, 3, 3, 3],
    jetFuel: [0, 0, 3, 3, 3, 3, 6, 6],
};
const INITIAL_RESOURCE_SUPPLY = {
    diesel: 0,
    jetFuel: 24,
};
const INITIAL_OPERATING_CONFIG = {
    hoursPerDay: 14,
    daysPerWeek: 7,
    totalWeeks: 8,
    loadingHours: {
        air: 1,
        train: 0.5,
        bus: 0.25,
    },
    passengersPerDemandPoint: 45,
    railConstructionCostPerMile: 1_000_000,
    railElectrificationCostPerMile: 250_000,
    operatingCostPerTrip: {
        bus: 2_500,
        air: 18_000,
        railDiesel: 7_000,
        railElectric: 5_500,
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
};
function isVehicleType(type) {
    return type === "bus" || type === "train" || type === "air";
}
function getStarterVehicleCards() {
    return vehicleCards.map(card => {
        if (!isVehicleType(card.type)) {
            throw new Error(`Invalid vehicle type: ${card.type}`);
        }
        return {
            ...card,
            type: card.type,
        };
    });
}
function shuffleCards(cards) {
    const shuffledCards = [...cards];
    for (let index = shuffledCards.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        const currentCard = shuffledCards[index];
        shuffledCards[index] = shuffledCards[swapIndex];
        shuffledCards[swapIndex] = currentCard;
    }
    return shuffledCards;
}
function shuffleVehicleCards() {
    return shuffleCards(getStarterVehicleCards());
}
function shuffleChanceCards() {
    return shuffleCards(chanceCards);
}
function createPlayer(player) {
    return {
        id: player.id,
        name: player.name,
        color: player.color,
        money: 100000000,
        totalPassengersServed: 0,
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
    };
}
function getSetupPlayers(players) {
    if (players && players.length > 0) {
        return players;
    }
    throw new Error("createGameState requires at least one setup player.");
}
export function createGameState(map, options = {}) {
    const shuffledVehicleCards = shuffleVehicleCards();
    const shuffledChanceCards = shuffleChanceCards();
    const [activeChanceCard, ...chanceDeck] = shuffledChanceCards;
    const players = getSetupPlayers(options.players).map(createPlayer);
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
        resourceMarket: INITIAL_RESOURCE_MARKET,
        resourceSupply: INITIAL_RESOURCE_SUPPLY,
        vehicleCatalog: shuffledVehicleCards,
        vehicleMarketCardIds: shuffledVehicleCards.map(card => card.id),
        hasPurchasedVehicleThisTurn: false,
        players,
        currentPlayerId: players[0]?.id ?? "p1",
    };
}
