const EARTH_RADIUS_MILES = 3958.8;
const BASE_FUEL_BURN_PER_HOUR = {
    air: 6000,
    train: 100,
    bus: 10,
};
const FUEL_RESOURCE_BY_TYPE = {
    air: "jetFuel",
    train: "diesel",
    bus: "diesel",
};
const FUEL_BURN_UNIT_BY_TYPE = {
    air: "pounds",
    train: "gallons",
    bus: "gallons",
};
function getRouteRailTraction(route) {
    return route.mode === "rail" ? route.railTraction ?? "diesel" : "diesel";
}
function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
}
function getCityById(cities, cityId) {
    return cities.find(city => city.id === cityId);
}
export function calculateDistanceMiles(cityA, cityB) {
    const lat1 = toRadians(cityA.lat);
    const lat2 = toRadians(cityB.lat);
    const deltaLat = toRadians(cityB.lat - cityA.lat);
    const deltaLng = toRadians(cityB.lng - cityA.lng);
    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
        Math.cos(lat1) *
            Math.cos(lat2) *
            Math.sin(deltaLng / 2) *
            Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_MILES * c;
}
export function calculateRouteDistanceMiles(cities, route) {
    const cityA = getCityById(cities, route.cityA);
    const cityB = getCityById(cities, route.cityB);
    if (!cityA || !cityB) {
        return null;
    }
    return calculateDistanceMiles(cityA, cityB);
}
export function calculateTripDurationHours(distanceMiles, speedMph, loadingHours) {
    if (speedMph <= 0) {
        return Infinity;
    }
    return distanceMiles / speedMph + loadingHours;
}
export function calculateTripsPerWeek(distanceMiles, vehicleCard, game) {
    const tripDurationHours = calculateTripDurationHours(distanceMiles, vehicleCard.speed, game.operatingConfig.loadingHours[vehicleCard.type]);
    if (!Number.isFinite(tripDurationHours) || tripDurationHours <= 0) {
        return {
            tripDurationHours,
            tripsPerWeek: 0,
        };
    }
    const operatingHoursPerWeek = game.operatingConfig.hoursPerDay * game.operatingConfig.daysPerWeek;
    return {
        tripDurationHours,
        tripsPerWeek: Math.floor(operatingHoursPerWeek / tripDurationHours),
    };
}
export function calculateTripFuelBurn(tripDurationHours, vehicleCard) {
    return (tripDurationHours *
        BASE_FUEL_BURN_PER_HOUR[vehicleCard.type] *
        vehicleCard.operatingCostMultiplier);
}
export function calculateRealFuelPerUnit(resource, game) {
    return game.operatingConfig.fuelUnits[resource];
}
export function calculateFuelUnitsFromReal(realFuelAmount, resource, game) {
    return realFuelAmount / calculateRealFuelPerUnit(resource, game);
}
export function calculateRealFuelFromUnits(fuelUnits, resource, game) {
    return fuelUnits * calculateRealFuelPerUnit(resource, game);
}
export function calculateRouteTripsPerWeek(game, route, vehicleCard) {
    const distanceMiles = calculateRouteDistanceMiles(game.cities, route);
    if (distanceMiles === null) {
        return null;
    }
    const tripSummary = calculateTripsPerWeek(distanceMiles, vehicleCard, game);
    const usesElectricRail = route.mode === "rail" &&
        vehicleCard.type === "train" &&
        getRouteRailTraction(route) === "electric";
    const fuelResource = usesElectricRail
        ? null
        : FUEL_RESOURCE_BY_TYPE[vehicleCard.type];
    const fuelBurnUnit = usesElectricRail
        ? null
        : FUEL_BURN_UNIT_BY_TYPE[vehicleCard.type];
    const tripFuelBurn = usesElectricRail
        ? 0
        : calculateTripFuelBurn(tripSummary.tripDurationHours, vehicleCard);
    const weeklyFuelBurn = tripFuelBurn * tripSummary.tripsPerWeek;
    const tripFuelUnits = fuelResource === null
        ? 0
        : calculateFuelUnitsFromReal(tripFuelBurn, fuelResource, game);
    return {
        distanceMiles,
        ...tripSummary,
        fuelResource,
        fuelBurnUnit,
        tripFuelBurn,
        weeklyFuelBurn,
        tripFuelUnits,
    };
}
