import type { PlayerBureaucracySummary } from "../engine/bureaucracy"

export type OperationsReviewOutcome = {
  totalPassengersServed: number
  totalRevenue: number
  totalOperatingCost: number
  netRevenue: number
  stuckCubeCount: number
  podCount: number
}

export type OperationsReviewComparison = {
  botPlan: OperationsReviewOutcome
  reviewedPlan: OperationsReviewOutcome
  delta: {
    totalPassengersServed: number
    totalRevenue: number
    totalOperatingCost: number
    netRevenue: number
    stuckCubeCount: number
    podCount: number
  }
}

export function summarizeOperationsReviewOutcome(summary: PlayerBureaucracySummary): OperationsReviewOutcome {
  return {
    totalPassengersServed: summary.totalPassengersServed,
    totalRevenue: summary.totalRevenue,
    totalOperatingCost: summary.totalOperatingCost,
    netRevenue: summary.netRevenue,
    stuckCubeCount: summary.stuckCubesByCity.reduce((sum, city) => sum + city.stuckCubeCount, 0),
    podCount: summary.routePlans.filter(
      plan => !plan.isDisconnected && plan.selectedCityIds.length >= 2 && plan.vehicleCard !== null,
    ).length,
  }
}

export function compareOperationsReviewOutcomes(
  botPlan: OperationsReviewOutcome,
  reviewedPlan: OperationsReviewOutcome,
): OperationsReviewComparison {
  return {
    botPlan,
    reviewedPlan,
    delta: {
      totalPassengersServed: reviewedPlan.totalPassengersServed - botPlan.totalPassengersServed,
      totalRevenue: reviewedPlan.totalRevenue - botPlan.totalRevenue,
      totalOperatingCost: reviewedPlan.totalOperatingCost - botPlan.totalOperatingCost,
      netRevenue: reviewedPlan.netRevenue - botPlan.netRevenue,
      stuckCubeCount: reviewedPlan.stuckCubeCount - botPlan.stuckCubeCount,
      podCount: reviewedPlan.podCount - botPlan.podCount,
    },
  }
}
