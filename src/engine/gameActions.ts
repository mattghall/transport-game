import type { CityDeckRegion } from "./types"

/**
 * All actions that can be applied server-side via POST /sessions/:id/action.
 * Superset of BotAction — includes human-only actions not available to scripted bots.
 */
export type GameAction =
  | { type: "buy-vehicle"; cardId: string; quantity: number }
  | { type: "draw-city-offer"; region: CityDeckRegion }
  | { type: "keep-city-offer"; cityIds: string[] }
  | { type: "confirm-add-city-picks" }
  | { type: "claim-route"; mode: "bus" | "rail" | "air"; cityIds: string[]; segmentPairs?: Array<[string, string]> }
  | { type: "create-service-pod"; corridorId: string; routeId: string; cityIds: string[] }
  | { type: "remove-pod-city"; corridorId: string; cityId: string; sourceRouteId: string }
  | { type: "ready-operations" }
  | { type: "ready-bureaucracy" }
  | { type: "end-turn" }
  | { type: "advance-turn"; keptCityIds?: string[] }
  | { type: "set-route-vehicle"; routeId: string; vehicleCardId: string | null }
  | { type: "add-service-split"; corridorId: string }
  | { type: "move-service-city"; corridorId: string; cityId: string; routeId: string; sourceRouteId: string | null }
  | { type: "delete-service-pod"; corridorId: string; routeId: string }
  | { type: "upgrade-rail"; routeId: string }
  | { type: "exchange-vehicle"; newCardId: string; oldCardId: string }
  | { type: "stop-auto-play" }
