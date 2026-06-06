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
