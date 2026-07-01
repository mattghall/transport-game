import type { BotAction } from "../bots/types"
import type {
  ScriptedBotWeights,
  ClaimRouteScoreBreakdown,
  KeepCityScoreBreakdown,
  BuyVehicleScoreBreakdown,
  DrawCityScoreBreakdown,
} from "../bots/scriptedBot"
import type { OperationsReviewComparison } from "./coachingReview"

export type TopChoiceCoachingRating = "fine" | "good" | "great"
export type AlternativeCoachingRating = "slightly-better" | "better" | "way-better"
export type CoachingDecisionRating = TopChoiceCoachingRating | AlternativeCoachingRating

export type CoachingDecision = {
  id: string
  sessionId: string
  timestamp: string
  botPlayerId: string
  botPlayerName: string
  decisionType: string
  week: number
  phase: string
  weightsSnapshot: Partial<ScriptedBotWeights>
  candidates: Array<{
    action: BotAction
    score: number
    label: string
    breakdown: ClaimRouteScoreBreakdown | KeepCityScoreBreakdown | BuyVehicleScoreBreakdown | DrawCityScoreBreakdown | null
  }>
  botChoiceIndex: number
  chosenIndex: number
  rating: CoachingDecisionRating
  preferredIndex: number | null
  reviewEdits?: string[]
  operationsReviewComparison?: OperationsReviewComparison
}

export type CoachingSession = {
  id: string
  startedAt: string
  endedAt: string | null
  playerCount: number
  decisions: CoachingDecision[]
}

export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function generateDecisionId(): string {
  return `decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const SESSION_STORAGE_KEY = "coaching-current-session"

export function loadCurrentCoachingSession(): CoachingSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as CoachingSession) : null
  } catch {
    return null
  }
}

export function saveCurrentCoachingSession(session: CoachingSession): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // non-fatal
  }
}

export function clearCurrentCoachingSession(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY)
}

/** Persists a coaching session to the server (training-results endpoint). */
export async function persistCoachingSession(
  session: CoachingSession,
  options?: { fallbackDownload?: boolean },
): Promise<void> {
  const filename = `coaching-sessions/${session.id}.json`
  const body = JSON.stringify(session, null, 2)
  const shouldFallbackDownload = options?.fallbackDownload ?? true

  try {
    const response = await fetch(`/api/training-results/${filename}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    })
    if (!response.ok) {
      throw new Error(`Could not persist coaching session (${response.status})`)
    }
  } catch {
    if (!shouldFallbackDownload) {
      return
    }
    // Fallback: trigger download so the user can save manually
    const blob = new Blob([body], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${session.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
}

export function summarizeCoachingSession(session: CoachingSession): string {
  const total = session.decisions.length
  const topChoiceRatings = session.decisions.filter(d => d.preferredIndex === null).length
  const alternativeRatings = session.decisions.filter(d => d.preferredIndex !== null).length
  return `${total} decisions rated: ${topChoiceRatings} top-choice ratings, ${alternativeRatings} alternative picks`
}
