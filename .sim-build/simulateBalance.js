import { buyResource, buyVehicleCard, claimRoute, advanceTurn, setBureaucracyRouteFuelUnits, setBureaucracyRouteVehicleCard, upgradeRailRoute } from "./src/engine/actions.js";
import { buildPlayerBureaucracySummary } from "./src/engine/bureaucracy.js";
import { createGameState } from "./src/engine/createGameState.js";
import { getConnectedCityIds, getOperatingCostPerTrip, getPassengersPerTrip, getRailUpgradeCost } from "./src/engine/economy.js";
import { calculateDistanceMiles, calculateRouteTripsPerWeek } from "./src/engine/trips.js";
import { usMap } from "./src/data/maps/usMap.js";
const PLAYERS = [
    { id: "p1", name: "Avery", color: "#e63946" },
    { id: "p2", name: "Blake", color: "#457b9d" },
    { id: "p3", name: "Casey", color: "#2a9d8f" },
    { id: "p4", name: "Devon", color: "#f4a261" },
];
const TOP_CITIES = [...usMap.cities]
    .sort((cityA, cityB) => {
    if (cityB.size !== cityA.size) {
        return cityB.size - cityA.size;
    }
    return cityB.population - cityA.population;
})
    .slice(0, 22);
const CANDIDATE_PAIRS = TOP_CITIES.flatMap((cityA, index) => TOP_CITIES.slice(index + 1).map(cityB => ({
    cityAId: cityA.id,
    cityBId: cityB.id,
    distanceMiles: calculateDistanceMiles(cityA, cityB),
}))).filter(pair => pair.distanceMiles >= 80 && pair.distanceMiles <= 2800);
function getCurrentPlayer(game) {
    return game.players.find(player => player.id === game.currentPlayerId) ?? game.players[0];
}
function getVehicleCardsForPlayer(game, playerId) {
    const player = game.players.find(candidate => candidate.id === playerId);
    if (!player) {
        return [];
    }
    return player.ownedVehicleCardIds
        .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
        .filter((card) => card !== null);
}
function getBestOwnedCard(game, playerId, type) {
    return getVehicleCardsForPlayer(game, playerId)
        .filter(card => card.type === type)
        .sort((cardA, cardB) => {
        if (cardB.totalPassengerCapacity !== cardA.totalPassengerCapacity) {
            return cardB.totalPassengerCapacity - cardA.totalPassengerCapacity;
        }
        return cardB.speed - cardA.speed;
    })[0] ?? null;
}
function getTypeForMode(mode) {
    switch (mode) {
        case "rail":
            return "train";
        case "air":
            return "air";
        case "bus":
            return "bus";
    }
}
function getClaimValue(game, playerId, candidate, mode) {
    const bestCard = getBestOwnedCard(game, playerId, getTypeForMode(mode));
    if (!bestCard) {
        return null;
    }
    if (game.routes.some(route => {
        const ids = [route.cityA, route.cityB].sort().join(":");
        return ids === [candidate.cityAId, candidate.cityBId].sort().join(":");
    })) {
        return null;
    }
    const route = {
        id: `sim:${mode}:${candidate.cityAId}:${candidate.cityBId}`,
        cityA: candidate.cityAId,
        cityB: candidate.cityBId,
        mode,
        railTraction: mode === "rail" ? "diesel" : undefined,
    };
    const tripSummary = calculateRouteTripsPerWeek(game, route, bestCard);
    if (!tripSummary) {
        return null;
    }
    const passengersPerTrip = getPassengersPerTrip(game, route, bestCard);
    const weeklyRevenue = tripSummary.distanceMiles *
        passengersPerTrip *
        tripSummary.tripsPerWeek *
        game.operatingConfig.revenuePerPassengerMile[mode];
    const weeklyOperatingCost = tripSummary.tripsPerWeek * getOperatingCostPerTrip(game, route);
    const weeksRemaining = game.operatingConfig.totalWeeks - game.currentWeek + 1;
    const connected = new Set(getConnectedCityIds(game, playerId));
    const networkBonus = (connected.has(candidate.cityAId) ? 0 : 3_000_000) +
        (connected.has(candidate.cityBId) ? 0 : 3_000_000);
    const railBuildCost = mode === "rail"
        ? Math.ceil(candidate.distanceMiles * game.operatingConfig.railConstructionCostPerMile)
        : 0;
    const value = (weeklyRevenue - weeklyOperatingCost) * Math.max(1, weeksRemaining * 0.6) +
        networkBonus -
        railBuildCost;
    return {
        pair: candidate,
        mode,
        route,
        value,
    };
}
function tryBuyVehicle(game) {
    const currentPlayer = getCurrentPlayer(game);
    const visibleCards = game.vehicleMarketCardIds
        .slice(0, 4)
        .map(cardId => game.vehicleCatalog.find(card => card.id === cardId) ?? null)
        .filter((card) => card !== null);
    const ownedCards = getVehicleCardsForPlayer(game, currentPlayer.id);
    const bestCard = visibleCards
        .filter(card => card.purchasePrice <= currentPlayer.money)
        .sort((cardA, cardB) => {
        const ownedCountA = ownedCards.filter(card => card.type === cardA.type).length;
        const ownedCountB = ownedCards.filter(card => card.type === cardB.type).length;
        const scoreA = (cardA.totalPassengerCapacity * cardA.speed * (ownedCountA === 0 ? 1.25 : 1)) /
            cardA.purchasePrice;
        const scoreB = (cardB.totalPassengerCapacity * cardB.speed * (ownedCountB === 0 ? 1.25 : 1)) /
            cardB.purchasePrice;
        return scoreB - scoreA;
    })[0];
    if (!bestCard) {
        return game;
    }
    const result = buyVehicleCard(game, bestCard.id);
    return result.ok ? result.game : game;
}
function tryClaimOrUpgrade(game) {
    const currentPlayer = getCurrentPlayer(game);
    const bestClaim = CANDIDATE_PAIRS.flatMap(candidate => {
        const values = ["bus", "air", "rail"]
            .map(mode => getClaimValue(game, currentPlayer.id, candidate, mode))
            .filter((value) => value !== null);
        return values;
    })
        .filter(value => value.value > 0)
        .sort((valueA, valueB) => valueB.value - valueA.value)[0];
    const upgradeOptions = game.routes
        .filter(route => route.ownerId === currentPlayer.id &&
        route.mode === "rail" &&
        route.railTraction !== "electric")
        .map(route => {
        const cost = getRailUpgradeCost(game, route);
        const summary = buildPlayerBureaucracySummary(game, currentPlayer.id);
        const plan = summary?.routePlans.find(candidate => candidate.route.id === route.id);
        const weeksRemaining = game.operatingConfig.totalWeeks - game.currentWeek + 1;
        const annualizedSavings = (plan?.weeklyFuelBurnUnits ?? 0) * 4_000 +
            (plan?.maxTripsByTime ?? 0) *
                (game.operatingConfig.operatingCostPerTrip.railDiesel -
                    game.operatingConfig.operatingCostPerTrip.railElectric);
        return {
            route,
            value: annualizedSavings * Math.max(1, weeksRemaining * 0.7) - cost,
        };
    })
        .filter(option => option.value > 0)
        .sort((optionA, optionB) => optionB.value - optionA.value)[0];
    if (upgradeOptions && (!bestClaim || upgradeOptions.value > bestClaim.value)) {
        const result = upgradeRailRoute(game, upgradeOptions.route.id);
        return result.ok ? result.game : game;
    }
    if (!bestClaim) {
        return game;
    }
    const result = claimRoute(game, {
        cityIds: [bestClaim.pair.cityAId, bestClaim.pair.cityBId],
        mode: bestClaim.mode,
    });
    return result.ok ? result.game : game;
}
function tryBuyFuel(game) {
    const currentPlayer = getCurrentPlayer(game);
    const summary = buildPlayerBureaucracySummary(game, currentPlayer.id);
    if (!summary) {
        return game;
    }
    let nextGame = game;
    for (const resource of ["diesel", "jetFuel"]) {
        const targetFuelUnits = Math.min(Math.ceil(summary.routePlans
            .filter(plan => plan.statsFuelResource === resource)
            .reduce((total, plan) => total + plan.weeklyFuelBurnUnits, 0)), nextGame.players.find(player => player.id === currentPlayer.id)?.inventory.fuel[resource] ??
            0 + 6);
        while ((nextGame.players.find(player => player.id === currentPlayer.id)?.inventory.fuel[resource] ??
            0) < targetFuelUnits) {
            const result = buyResource(nextGame, resource);
            if (!result.ok) {
                break;
            }
            nextGame = result.game;
        }
    }
    return nextGame;
}
function assignVehiclesAndFuel(game) {
    const currentPlayer = getCurrentPlayer(game);
    let nextGame = game;
    const summary = buildPlayerBureaucracySummary(nextGame, currentPlayer.id);
    if (!summary) {
        return nextGame;
    }
    for (const mode of ["air", "rail", "bus"]) {
        const routes = summary.routePlans
            .filter(plan => plan.route.mode === mode)
            .sort((planA, planB) => {
            const scoreA = (planA.distanceMiles ?? 0) * planA.combinedDemand;
            const scoreB = (planB.distanceMiles ?? 0) * planB.combinedDemand;
            return scoreB - scoreA;
        });
        const cards = getVehicleCardsForPlayer(nextGame, currentPlayer.id)
            .filter(card => card.type === getTypeForMode(mode))
            .sort((cardA, cardB) => cardB.totalPassengerCapacity - cardA.totalPassengerCapacity);
        routes.forEach((plan, index) => {
            const card = cards[index] ?? null;
            const result = setBureaucracyRouteVehicleCard(nextGame, plan.route.id, card?.id ?? null);
            if (result.ok) {
                nextGame = result.game;
            }
        });
    }
    const assignedSummary = buildPlayerBureaucracySummary(nextGame, currentPlayer.id);
    if (!assignedSummary) {
        return nextGame;
    }
    assignedSummary.routePlans
        .slice()
        .sort((planA, planB) => {
        const scoreA = (planA.distanceMiles ?? 0) * planA.passengersPerTrip * planA.maxTripsByTime;
        const scoreB = (planB.distanceMiles ?? 0) * planB.passengersPerTrip * planB.maxTripsByTime;
        return scoreB - scoreA;
    })
        .forEach(plan => {
        if (!plan.vehicleCard || plan.fuelResource === null) {
            return;
        }
        const routeRate = nextGame.operatingConfig.revenuePerPassengerMile[plan.route.mode];
        const potentialRevenue = (plan.distanceMiles ?? 0) * plan.passengersPerTrip * plan.maxTripsByTime * routeRate;
        const potentialOperatingCost = plan.maxTripsByTime * getOperatingCostPerTrip(nextGame, plan.route);
        const requestedFuelUnits = potentialRevenue > potentialOperatingCost ? plan.weeklyFuelBurnUnits : 0;
        const result = setBureaucracyRouteFuelUnits(nextGame, plan.route.id, requestedFuelUnits);
        if (result.ok) {
            nextGame = result.game;
        }
    });
    return nextGame;
}
function runSingleSimulation() {
    let game = createGameState(usMap, { players: PLAYERS });
    let safety = 0;
    while (!game.isGameOver && safety < 2000) {
        switch (game.currentPhase) {
            case "purchase-equipment":
                game = tryBuyVehicle(game);
                break;
            case "claim-routes":
                game = tryClaimOrUpgrade(game);
                break;
            case "purchase-fuel":
                game = tryBuyFuel(game);
                break;
            case "bureaucracy":
                game = assignVehiclesAndFuel(game);
                break;
        }
        game = advanceTurn(game);
        safety += 1;
    }
    const standings = [...game.players]
        .sort((playerA, playerB) => {
        if (playerB.totalPassengersServed !== playerA.totalPassengersServed) {
            return playerB.totalPassengersServed - playerA.totalPassengersServed;
        }
        const connectedA = getConnectedCityIds(game, playerA.id).length;
        const connectedB = getConnectedCityIds(game, playerB.id).length;
        if (connectedB !== connectedA) {
            return connectedB - connectedA;
        }
        return playerB.money - playerA.money;
    });
    const modeCounts = game.routes.reduce((counts, route) => {
        counts[route.mode] += 1;
        if (route.mode === "rail" && route.railTraction === "electric") {
            counts.electricRail += 1;
        }
        return counts;
    }, { bus: 0, air: 0, rail: 0, electricRail: 0 });
    return {
        winner: standings[0].name,
        winnerPassengers: standings[0].totalPassengersServed,
        totalPassengers: game.players.reduce((total, player) => total + player.totalPassengersServed, 0),
        averageMoney: game.players.reduce((total, player) => total + player.money, 0) / game.players.length,
        modeCounts,
    };
}
const results = Array.from({ length: 12 }, () => runSingleSimulation());
const winnerCounts = results.reduce((counts, result) => {
    counts[result.winner] = (counts[result.winner] ?? 0) + 1;
    return counts;
}, {});
const average = results.reduce((totals, result) => {
    totals.totalPassengers += result.totalPassengers;
    totals.averageMoney += result.averageMoney;
    totals.bus += result.modeCounts.bus;
    totals.air += result.modeCounts.air;
    totals.rail += result.modeCounts.rail;
    totals.electricRail += result.modeCounts.electricRail;
    return totals;
}, {
    totalPassengers: 0,
    averageMoney: 0,
    bus: 0,
    air: 0,
    rail: 0,
    electricRail: 0,
});
console.log(JSON.stringify({
    runs: results.length,
    winnerCounts,
    averageTotalPassengers: Math.round(average.totalPassengers / results.length),
    averageEndingMoney: Math.round(average.averageMoney / results.length),
    averageRoutes: {
        bus: Number((average.bus / results.length).toFixed(2)),
        air: Number((average.air / results.length).toFixed(2)),
        rail: Number((average.rail / results.length).toFixed(2)),
        electricRail: Number((average.electricRail / results.length).toFixed(2)),
    },
    sampleWinners: results.slice(0, 3),
}, null, 2));
