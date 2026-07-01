import type { GameState } from "../engine/types"
import { getCachedBureaucracySummary } from "./summaryCache"

export type BotStructureMetrics = {
  unassignedVehicleCount: number
  unstaffedPodCount: number
  unstaffedRailPodCount: number
  avoidableDisconnectedCityCount: number
}

export function measureBotStructure(game: GameState, playerId: string): BotStructureMetrics {
  const player = game.players.find(candidate => candidate.id === playerId) ?? null

  if (!player) {
    return {
      unassignedVehicleCount: 0,
      unstaffedPodCount: 0,
      unstaffedRailPodCount: 0,
      avoidableDisconnectedCityCount: 0,
    }
  }

  const summary = getCachedBureaucracySummary(game, playerId)
  const unassignedVehicleCountsByMode = player.ownedVehicleCardIds.reduce<Record<"bus" | "rail" | "air", number>>(
    (counts, cardId) => {
      const isAssigned = (summary?.routePlans ?? []).some(
        plan => plan.selectedCityIds.length >= 2 && plan.vehicleCard?.id === cardId,
      )
      if (isAssigned) {
        return counts
      }

      const card = game.vehicleCatalog.find(candidate => candidate.id === cardId)
      if (card?.type === "bus") counts.bus += 1
      if (card?.type === "train") counts.rail += 1
      if (card?.type === "air") counts.air += 1
      return counts
    },
    { bus: 0, rail: 0, air: 0 },
  )
  const assignedVehicleCardIds = new Set(
    (summary?.routePlans ?? [])
      .filter(plan => plan.selectedCityIds.length >= 2)
      .map(plan => plan.vehicleCard?.id ?? null)
      .filter((cardId): cardId is string => cardId !== null),
  )
  const unassignedVehicleCount = player.ownedVehicleCardIds.filter(cardId => !assignedVehicleCardIds.has(cardId)).length
  const activeUnstaffedPlans = (summary?.routePlans ?? []).filter(
    plan => !plan.isDisconnected && plan.selectedCityIds.length >= 2 && !plan.vehicleCard,
  )
  const unstaffedPodCountsByMode = activeUnstaffedPlans.reduce<Record<"bus" | "rail" | "air", number>>(
    (counts, plan) => {
      counts[plan.route.mode] += 1
      return counts
    },
    { bus: 0, rail: 0, air: 0 },
  )
  const avoidableDisconnectedCityCount = (summary?.routePlans ?? []).reduce((total, plan) => {
    if (!plan.isDisconnected) {
      return total
    }

    const mode = plan.route.mode
    const hasSpareCompatibleVehicle =
      Math.max(0, unassignedVehicleCountsByMode[mode] - unstaffedPodCountsByMode[mode]) > 0
    const alreadyHasEmptyPodInMode = unstaffedPodCountsByMode[mode] > 0

    return hasSpareCompatibleVehicle || alreadyHasEmptyPodInMode
      ? total + plan.selectedCityIds.length
      : total
  }, 0)

  return {
    unassignedVehicleCount,
    unstaffedPodCount: activeUnstaffedPlans.length,
    unstaffedRailPodCount: activeUnstaffedPlans.filter(plan => plan.route.mode === "rail").length,
    avoidableDisconnectedCityCount,
  }
}
