import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  mergeScriptedBotWeights,
  type ScriptedBotWeights,
} from "./scriptedBot"

export type ScriptedBotLeverMetadata = {
  mutationStep: number
  minimum?: number
  enabled: boolean
}

export const SCRIPTED_BOT_WEIGHT_KEYS = Object.keys(
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
) as Array<keyof ScriptedBotWeights>

// These levers had zero passenger/score/win-rate ablation impact across the latest 2p/3p/4p
// importance snapshots, so they are the first conservative freeze batch.
// podRemoveCityBaseScore is frozen at 0 so bots only remove cities when there's a measurable
// net-revenue or passengers-per-distance gain, not unconditionally.
export const FROZEN_SCRIPTED_BOT_WEIGHT_KEYS = [
  "claimFirstModeBonus",
  "claimMountainPreference",
  "claimPacificPreference",
  "claimNewCityBonus",
  "claimNewRegionBonus",
  "earlyExpansionMultiplier",
  "earlyPopulationMultiplier",
  "lateReadyOperationsScore",
  "podRemoveCityBaseScore",
] as const satisfies Array<keyof ScriptedBotWeights>

const FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET = new Set<keyof ScriptedBotWeights>(
  FROZEN_SCRIPTED_BOT_WEIGHT_KEYS,
)

export const SCRIPTED_BOT_LEVER_METADATA: Record<keyof ScriptedBotWeights, ScriptedBotLeverMetadata> = {
  vehiclePriorityBus: {
    mutationStep: 18,
    enabled: true,
  },
  vehiclePriorityTrain: {
    mutationStep: 18,
    enabled: true,
  },
  vehiclePriorityAir: {
    mutationStep: 18,
    enabled: true,
  },
  claimRailBaseScore: {
    mutationStep: 24,
    enabled: true,
  },
  claimAirBaseScore: {
    mutationStep: 24,
    enabled: true,
  },
  claimPopulationPerMillionScore: {
    mutationStep: 2.5,
    minimum: 0,
    enabled: true,
  },
  claimNewCityBonus: {
    mutationStep: 10,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("claimNewCityBonus"),
  },
  claimFirstModeBonus: {
    mutationStep: 10,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("claimFirstModeBonus"),
  },
  claimRailCostPenaltyPerMillion: {
    mutationStep: 1,
    minimum: 0,
    enabled: true,
  },
  claimPacificPreference: {
    mutationStep: 8,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("claimPacificPreference"),
  },
  claimMountainPreference: {
    mutationStep: 8,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("claimMountainPreference"),
  },
  claimSouthPreference: {
    mutationStep: 8,
    enabled: true,
  },
  claimSoutheastPreference: {
    mutationStep: 8,
    enabled: true,
  },
  claimMidwestPreference: {
    mutationStep: 8,
    enabled: true,
  },
  claimNortheastPreference: {
    mutationStep: 8,
    enabled: true,
  },
  claimSameRegionLinkBonus: {
    mutationStep: 10,
    enabled: true,
  },
  claimNewRegionBonus: {
    mutationStep: 10,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("claimNewRegionBonus"),
  },
  claimLongDistancePreference: {
    mutationStep: 8,
    enabled: true,
  },
  buyBusOwnedCityBonus: {
    mutationStep: 2,
    minimum: 0,
    enabled: true,
  },
  buyTrainPotentialClaimBonus: {
    mutationStep: 14,
    enabled: true,
  },
  buyTrainFallbackOwnedCityBonus: {
    mutationStep: 6,
    minimum: 0,
    enabled: true,
  },
  buyTrainNoClaimPenalty: {
    mutationStep: 12,
    enabled: true,
  },
  buyAirPotentialClaimBonus: {
    mutationStep: 14,
    enabled: true,
  },
  buyAirFallbackOwnedCityBonus: {
    mutationStep: 6,
    minimum: 0,
    enabled: true,
  },
  buyAirNoClaimPenalty: {
    mutationStep: 12,
    enabled: true,
  },
  buyDuplicateVehiclePenalty: {
    mutationStep: 4,
    minimum: 0,
    enabled: true,
  },
  buyFirstTrainBonus: {
    mutationStep: 10,
    enabled: true,
  },
  buyFirstAirBonus: {
    mutationStep: 10,
    enabled: true,
  },
  earlyExpansionMultiplier: {
    mutationStep: 0.25,
    minimum: 0.1,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("earlyExpansionMultiplier"),
  },
  midExpansionMultiplier: {
    mutationStep: 0.2,
    minimum: 0.1,
    enabled: true,
  },
  lateExpansionMultiplier: {
    mutationStep: 0.2,
    minimum: 0.1,
    enabled: true,
  },
  earlyPopulationMultiplier: {
    mutationStep: 0.2,
    minimum: 0.1,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("earlyPopulationMultiplier"),
  },
  midPopulationMultiplier: {
    mutationStep: 0.2,
    minimum: 0.1,
    enabled: true,
  },
  latePopulationMultiplier: {
    mutationStep: 0.25,
    minimum: 0.1,
    enabled: true,
  },
  earlyReadyOperationsScore: {
    mutationStep: 20,
    minimum: 0,
    enabled: true,
  },
  midReadyOperationsScore: {
    mutationStep: 24,
    minimum: 0,
    enabled: true,
  },
  lateReadyOperationsScore: {
    mutationStep: 28,
    minimum: 0,
    enabled: !FROZEN_SCRIPTED_BOT_WEIGHT_KEY_SET.has("lateReadyOperationsScore"),
  },
  earlyClaimBudget: {
    mutationStep: 1,
    minimum: 0,
    enabled: true,
  },
  midClaimBudget: {
    mutationStep: 1,
    minimum: 0,
    enabled: true,
  },
  lateClaimBudget: {
    mutationStep: 1,
    minimum: 0,
    enabled: true,
  },
  podSplitBaseScore: {
    mutationStep: 12,
    enabled: true,
  },
  podCityCountScore: {
    mutationStep: 4,
    enabled: true,
  },
  podPopulationPerMillionScore: {
    mutationStep: 2,
    minimum: 0,
    enabled: true,
  },
  podPopulationPerDistanceScore: {
    mutationStep: 6,
    minimum: 0,
    enabled: true,
  },
  podDemandScore: {
    mutationStep: 1.5,
    minimum: 0,
    enabled: true,
  },
  podDemandPerMileScore: {
    mutationStep: 2,
    minimum: 0,
    enabled: true,
  },
  podNetRevenueScore: {
    mutationStep: 8,
    minimum: 0,
    enabled: true,
  },
  podAdditionalRoutePenalty: {
    mutationStep: 4,
    minimum: 0,
    enabled: true,
  },
  podRemoveCityBaseScore: {
    mutationStep: 4,
    enabled: true,
  },
  podRemovePassengersPerDistanceGainScore: {
    mutationStep: 6,
    minimum: 0,
    enabled: true,
  },
  podRemoveNetRevenueGainScore: {
    mutationStep: 5,
    minimum: 0,
    enabled: true,
  },
}

export const MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS = SCRIPTED_BOT_WEIGHT_KEYS.filter(
  key => SCRIPTED_BOT_LEVER_METADATA[key].enabled,
)

export function applyFrozenScriptedBotWeights(
  weights: Partial<ScriptedBotWeights>,
  frozenWeights?: Partial<ScriptedBotWeights>,
) {
  const resolvedWeights = mergeScriptedBotWeights(weights)

  if (!frozenWeights) {
    return resolvedWeights
  }

  const resolvedFrozenWeights = mergeScriptedBotWeights(frozenWeights)

  for (const key of FROZEN_SCRIPTED_BOT_WEIGHT_KEYS) {
    resolvedWeights[key] = resolvedFrozenWeights[key]
  }

  return resolvedWeights
}
