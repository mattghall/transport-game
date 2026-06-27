import type { CityDeckRegion, GameState, WeeklyPhase } from "../engine/types"

export type BuyVehicleBotAction = {
  type: "buy-vehicle"
  cardId: string
  quantity: number
}

export type DrawCityOfferBotAction = {
  type: "draw-city-offer"
  region: CityDeckRegion
}

export type KeepCityOfferBotAction = {
  type: "keep-city-offer"
  cityIds: string[]
}

export type ConfirmAddCityPicksBotAction = {
  type: "confirm-add-city-picks"
}

export type ClaimRouteBotAction = {
  type: "claim-route"
  mode: "rail" | "air"
  cityIds: [string, string]
}

export type CreateServicePodBotAction = {
  type: "create-service-pod"
  corridorId: string
  routeId: string
  cityIds: string[]
}

export type RemovePodCityBotAction = {
  type: "remove-pod-city"
  corridorId: string
  cityId: string
  sourceRouteId: string
}

/** Assign an owned vehicle card to an existing pod slot that has no vehicle. */
export type AssignPodVehicleBotAction = {
  type: "assign-pod-vehicle"
  routeId: string
  vehicleCardId: string
}

/**
 * Add a second (or Nth) vehicle to a high-performing pod by creating a new slot
 * with the same city set and assigning the given vehicle card to it.
 */
export type AddSecondVehicleToPodBotAction = {
  type: "add-second-vehicle-to-pod"
  corridorId: string
  cityIds: string[]
  vehicleCardId: string
}

export type DeleteServicePodBotAction = {
  type: "delete-service-pod"
  corridorId: string
  routeId: string
}

/** Trade in an old vehicle card for a better one in the market during purchase-equipment. */
export type ExchangeVehicleBotAction = {
  type: "exchange-vehicle"
  newCardId: string
  oldCardId: string
}

export type ReadyOperationsBotAction = {
  type: "ready-operations"
}

export type ReadyBureaucracyBotAction = {
  type: "ready-bureaucracy"
}

export type EndTurnBotAction = {
  type: "end-turn"
}

export type BotAction =
  | BuyVehicleBotAction
  | DrawCityOfferBotAction
  | KeepCityOfferBotAction
  | ConfirmAddCityPicksBotAction
  | ClaimRouteBotAction
  | CreateServicePodBotAction
  | RemovePodCityBotAction
  | AssignPodVehicleBotAction
  | AddSecondVehicleToPodBotAction
  | DeleteServicePodBotAction
  | ExchangeVehicleBotAction
  | ReadyOperationsBotAction
  | ReadyBureaucracyBotAction
  | EndTurnBotAction

export type BotController = {
  id: string
  pickAction: (input: {
    game: GameState
    playerId: string
    legalActions: BotAction[]
    phase: WeeklyPhase
  }) => BotAction
}
