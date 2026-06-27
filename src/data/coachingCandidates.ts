import type { ScoredBotCandidate } from "../bots/scriptedBot"

function shouldReplaceVehicleQuantityCandidate(
  currentBest: ScoredBotCandidate,
  candidate: ScoredBotCandidate,
) {
  if (candidate.score !== currentBest.score) {
    return candidate.score > currentBest.score
  }

  if (candidate.action.type !== "buy-vehicle" || currentBest.action.type !== "buy-vehicle") {
    return false
  }

  return candidate.action.quantity < currentBest.action.quantity
}

export function collapseVehicleQuantityCandidates(candidates: ScoredBotCandidate[]): ScoredBotCandidate[] {
  const nonBuyCandidates: ScoredBotCandidate[] = []
  const bestBuyCandidateByCardId = new Map<string, ScoredBotCandidate>()

  for (const candidate of candidates) {
    if (candidate.action.type !== "buy-vehicle") {
      nonBuyCandidates.push(candidate)
      continue
    }

    const currentBest = bestBuyCandidateByCardId.get(candidate.action.cardId)
    if (!currentBest || shouldReplaceVehicleQuantityCandidate(currentBest, candidate)) {
      bestBuyCandidateByCardId.set(candidate.action.cardId, candidate)
    }
  }

  return [...nonBuyCandidates, ...bestBuyCandidateByCardId.values()].sort((a, b) => b.score - a.score)
}

export function selectVehicleCoachingCandidates(candidates: ScoredBotCandidate[]): ScoredBotCandidate[] {
  return collapseVehicleQuantityCandidates(candidates).slice(0, 5)
}
