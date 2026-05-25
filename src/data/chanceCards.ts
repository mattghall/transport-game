import type { ChanceCard } from "../engine/types"

export const chanceCards: ChanceCard[] = [
  {
    id: "chance-diesel-glut",
    title: "Diesel Glut",
    description: "Freight oversupply pushes diesel prices down nationwide this week.",
    fuelPriceMultiplier: {
      diesel: 0.8,
    },
  },
  {
    id: "chance-jet-fuel-surge",
    title: "Jet Fuel Squeeze",
    description: "Refinery outages tighten jet fuel supply and raise air operating costs.",
    fuelPriceMultiplier: {
      jetFuel: 1.25,
    },
  },
  {
    id: "chance-pacific-tourism",
    title: "Pacific Tourism Boom",
    description: "Travel demand surges across the Pacific and West corridors.",
    demandBoost: {
      regions: ["Pacific", "West"],
      bonusPerCity: 2,
    },
  },
  {
    id: "chance-southern-holiday",
    title: "Southern Holiday Rush",
    description: "Seasonal travel increases passenger demand across the South.",
    demandBoost: {
      regions: ["South"],
      bonusPerCity: 2,
    },
  },
  {
    id: "chance-atlantic-business",
    title: "Southeast Business Travel",
    description: "Corporate travel spikes across Southeast cities and nearby corridors.",
    demandBoost: {
      regions: ["Southeast"],
      bonusPerCity: 1,
    },
  },
  {
    id: "chance-fuel-stability",
    title: "Stable Markets",
    description: "Fuel markets hold steady and demand returns to baseline this week.",
  },
  {
    id: "chance-regional-access-grants",
    title: "Regional Access Grants",
    description: "Federal grants reward operators that connect size 3 cities this week.",
    connectionBonus: {
      citySize: 3,
      bonusPerCity: 1_500_000,
    },
  },
  {
    id: "chance-major-hub-push",
    title: "Major Hub Push",
    description: "Tourism boards pay extra for bringing large cities into your network.",
    connectionBonus: {
      citySize: 5,
      bonusPerCity: 2_500_000,
    },
  },
]
