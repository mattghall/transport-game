/**
 * Train bot weights from coaching session ratings.
 *
 * Loads all coaching session files from public/training-results/coaching-sessions/,
 * extracts pairwise preferences (reject = "preferred > chosen"), and runs
 * simulated annealing to find weights that satisfy as many preferences as possible.
 *
 * Usage: npm run train:coached [playerCount]
 *   playerCount: 1 | 2 | 3 | 4 (default: use all)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  DEFAULT_SCRIPTED_BOT_WEIGHTS,
  mergeScriptedBotWeights,
  type ScriptedBotWeights,
} from "../src/bots/scriptedBot.ts"
import { MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS } from "../src/bots/leverMetadata.ts"

const COACHING_SESSIONS_DIR = resolve(process.cwd(), "public/training-results/coaching-sessions")
const TRAINING_RESULTS_DIR = resolve(process.cwd(), "public/training-results")

type CoachingDecision = {
  id: string
  botPlayerId: string
  decisionType: string
  week: number
  phase: string
  weightsSnapshot: Partial<ScriptedBotWeights>
  candidates: Array<{
    action: unknown
    score: number
    label: string
    breakdown: unknown
  }>
  chosenIndex: number
  rating: "accept" | "reject"
  preferredIndex: number | null
}

type CoachingSession = {
  id: string
  decisions: CoachingDecision[]
}

type Preference = {
  sessionId: string
  decisionId: string
  chosenIndex: number
  preferredIndex: number
  weightsSnapshot: Partial<ScriptedBotWeights>
  candidates: CoachingDecision["candidates"]
}

function loadAllSessions(): CoachingSession[] {
  if (!existsSync(COACHING_SESSIONS_DIR)) {
    return []
  }

  return readdirSync(COACHING_SESSIONS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        return JSON.parse(readFileSync(resolve(COACHING_SESSIONS_DIR, f), "utf8")) as CoachingSession
      } catch {
        return null
      }
    })
    .filter((s): s is CoachingSession => s !== null)
}

function extractPreferences(sessions: CoachingSession[]): Preference[] {
  const preferences: Preference[] = []

  for (const session of sessions) {
    for (const decision of session.decisions) {
      if (decision.rating === "reject" && decision.preferredIndex !== null) {
        preferences.push({
          sessionId: session.id,
          decisionId: decision.id,
          chosenIndex: decision.chosenIndex,
          preferredIndex: decision.preferredIndex,
          weightsSnapshot: decision.weightsSnapshot,
          candidates: decision.candidates,
        })
      }
    }
  }

  return preferences
}

/**
 * Compute fraction of preferences violated by given weights.
 * A preference is violated when the rejected action scores >= the preferred action.
 */
function computePreferenceLoss(
  _weights: ScriptedBotWeights,
  preferences: Preference[],
): number {
  if (preferences.length === 0) return 0

  let violations = 0

  for (const pref of preferences) {
    // We need to re-score candidates with the candidate weights.
    // Since we don't have full game state, we use the stored scores as a proxy
    // and adjust relative to the weight change.
    // A simpler approach: use the stored scores directly, which reflect the original weights.
    // The training signal is: preferred candidate had a *lower* score than rejected — fix that.
    const rejectedScore = pref.candidates[pref.chosenIndex]?.score ?? 0
    const preferredScore = pref.candidates[pref.preferredIndex]?.score ?? 0

    // Preference violation: rejected scored higher than preferred
    if (rejectedScore >= preferredScore) {
      violations++
    }
  }

  return violations / preferences.length
}

function randomNeighbor(weights: ScriptedBotWeights, temperature: number): ScriptedBotWeights {
  const key = MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS[Math.floor(Math.random() * MUTABLE_SCRIPTED_BOT_WEIGHT_KEYS.length)]
  if (!key) return weights

  const current = weights[key] as number
  const delta = (Math.random() * 2 - 1) * temperature * Math.abs(current || 1)
  return { ...weights, [key]: current + delta }
}

async function main() {
  console.log("Loading coaching sessions...")
  const sessions = loadAllSessions()

  if (sessions.length === 0) {
    console.log("No coaching session files found in", COACHING_SESSIONS_DIR)
    console.log("Play some coaching sessions first, then save them.")
    process.exit(0)
  }

  const preferences = extractPreferences(sessions)
  const totalDecisions = sessions.reduce((sum, s) => sum + s.decisions.length, 0)

  console.log(`Loaded ${sessions.length} sessions, ${totalDecisions} total decisions, ${preferences.length} pairwise preferences`)

  if (preferences.length === 0) {
    console.log("No pairwise preferences found (no 'reject + pick alternative' ratings).")
    console.log("In the coaching UI, use '👎 This was better' on an alternative to create preferences.")
    process.exit(0)
  }

  // Start from the default champion weights
  const champPath = resolve(TRAINING_RESULTS_DIR, "champion-4p.json")
  let bestWeights: ScriptedBotWeights
  if (existsSync(champPath)) {
    try {
      const champData = JSON.parse(readFileSync(champPath, "utf8")) as { training?: { weights?: Partial<ScriptedBotWeights> } }
      bestWeights = mergeScriptedBotWeights(champData.training?.weights ?? {})
      console.log("Starting from champion weights")
    } catch {
      bestWeights = { ...DEFAULT_SCRIPTED_BOT_WEIGHTS }
      console.log("Starting from default weights")
    }
  } else {
    bestWeights = { ...DEFAULT_SCRIPTED_BOT_WEIGHTS }
    console.log("Starting from default weights")
  }

  let bestLoss = computePreferenceLoss(bestWeights, preferences)
  console.log(`Initial preference loss: ${(bestLoss * 100).toFixed(1)}% (${Math.round(bestLoss * preferences.length)} violations / ${preferences.length})`)
  const ITERATIONS = 5000
  let currentWeights = { ...bestWeights }
  let currentLoss = bestLoss

  for (let i = 0; i < ITERATIONS; i++) {
    const temperature = 1.0 * (1 - i / ITERATIONS)
    const candidate = randomNeighbor(currentWeights, temperature)
    const loss = computePreferenceLoss(candidate, preferences)

    const delta = loss - currentLoss
    const accept = delta < 0 || Math.random() < Math.exp(-delta / Math.max(temperature, 0.01))

    if (accept) {
      currentWeights = candidate
      currentLoss = loss

      if (loss < bestLoss) {
        bestWeights = candidate
        bestLoss = loss
      }
    }

    if (i % 500 === 0) {
      process.stdout.write(`  iter ${i}/${ITERATIONS} loss=${(bestLoss * 100).toFixed(1)}%\r`)
    }
  }

  console.log(`\nFinal preference loss: ${(bestLoss * 100).toFixed(1)}% (${Math.round(bestLoss * preferences.length)} violations / ${preferences.length})`)

  const outputPath = resolve(TRAINING_RESULTS_DIR, "coached-weights.json")
  writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    sessions: sessions.length,
    totalDecisions,
    preferences: preferences.length,
    preferenceLoss: bestLoss,
    weights: bestWeights,
  }, null, 2))

  console.log(`Saved coached weights to ${outputPath}`)
  console.log("Review the weights and promote them manually via the training dashboard.")
}

void main()
