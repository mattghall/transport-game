import { calculateRouteDistanceMiles } from "./trips";
export function getActiveChanceCard(game) {
    if (!game.activeChanceCardId) {
        return null;
    }
    return (game.chanceCatalog.find(card => card.id === game.activeChanceCardId) ?? null);
}
export function getFuelPriceMultiplier(game, resource) {
    return getActiveChanceCard(game)?.fuelPriceMultiplier?.[resource] ?? 1;
}
function cityMatchesDemandBoost(card, city) {
    if (!card?.demandBoost || !city.region) {
        return false;
    }
    return city.region.some(region => card.demandBoost?.regions.includes(region));
}
export function getCityDemandSize(game, city) {
    const activeChanceCard = getActiveChanceCard(game);
    if (!cityMatchesDemandBoost(activeChanceCard, city)) {
        return city.size;
    }
    return city.size + (activeChanceCard?.demandBoost?.bonusPerCity ?? 0);
}
export function getCombinedDemandForCityIds(game, cityIds) {
    return cityIds.reduce((total, cityId) => {
        const city = game.cities.find(candidate => candidate.id === cityId);
        return total + (city ? getCityDemandSize(game, city) : 0);
    }, 0);
}
export function getCombinedDemandForRoute(game, route) {
    return getCombinedDemandForCityIds(game, [route.cityA, route.cityB]);
}
export function getPassengersPerTrip(game, route, vehicleCard) {
    const combinedDemand = getCombinedDemandForRoute(game, route);
    const demandCapacity = combinedDemand * game.operatingConfig.passengersPerDemandPoint;
    return Math.min(vehicleCard.totalPassengerCapacity, demandCapacity);
}
export function getRailTraction(route) {
    return route.mode === "rail" ? route.railTraction ?? "diesel" : "diesel";
}
export function getOperatingCostPerTrip(game, route) {
    if (route.mode === "bus") {
        return game.operatingConfig.operatingCostPerTrip.bus;
    }
    if (route.mode === "air") {
        return game.operatingConfig.operatingCostPerTrip.air;
    }
    return getRailTraction(route) === "electric"
        ? game.operatingConfig.operatingCostPerTrip.railElectric
        : game.operatingConfig.operatingCostPerTrip.railDiesel;
}
export function getConnectedCityIds(game, playerId) {
    const connectedCityIds = new Set();
    for (const route of game.routes) {
        if (route.ownerId !== playerId) {
            continue;
        }
        connectedCityIds.add(route.cityA);
        connectedCityIds.add(route.cityB);
    }
    return [...connectedCityIds];
}
export function getRailUpgradeCost(game, route) {
    if (route.mode !== "rail" || getRailTraction(route) === "electric") {
        return 0;
    }
    const distanceMiles = calculateRouteDistanceMiles(game.cities, route);
    if (distanceMiles === null) {
        return 0;
    }
    return Math.ceil(distanceMiles * game.operatingConfig.railElectrificationCostPerMile);
}
export function buildVictoryStandings(game) {
    return [...game.players]
        .map(player => ({
        player,
        connectedCities: getConnectedCityIds(game, player.id).length,
    }))
        .sort((standingA, standingB) => {
        if (standingB.player.totalPassengersServed !== standingA.player.totalPassengersServed) {
            return standingB.player.totalPassengersServed - standingA.player.totalPassengersServed;
        }
        if (standingB.connectedCities !== standingA.connectedCities) {
            return standingB.connectedCities - standingA.connectedCities;
        }
        return standingB.player.money - standingA.player.money;
    });
}
