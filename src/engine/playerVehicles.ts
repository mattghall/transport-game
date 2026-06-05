import type { Player } from "./types"

export function getOwnedVehicleCountForCard(player: Player, cardId: string) {
  const explicitCount = player.ownedVehicleCountsByCardId[cardId]

  if (typeof explicitCount === "number" && explicitCount > 0) {
    return explicitCount
  }

  return player.ownedVehicleCardIds.includes(cardId) ? 1 : 0
}

export function getOwnedVehicleCountsByCardId(player: Player | null | undefined) {
  if (!player) {
    return {}
  }

  const countsByCardId = { ...player.ownedVehicleCountsByCardId }

  for (const cardId of player.ownedVehicleCardIds) {
    countsByCardId[cardId] = Math.max(countsByCardId[cardId] ?? 0, 1)
  }

  return countsByCardId
}
