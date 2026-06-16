import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usMap } from "./data/maps/usMap"
import { loadUserDecks } from "./data/deckData"
import {
  generateDecisionId,
  generateSessionId,
  saveCurrentCoachingSession,
  summarizeCoachingSession,
  persistCoachingSession,
  type CoachingSession,
  type CoachingDecision,
} from "./data/coachingStorage"
import {
  createGameState,
  DEFAULT_STARTING_MONEY,
} from "./engine/createGameState"
import { getPendingBotPlayerId } from "./bots/actions"
import { applyBotAction, getBotLegalActions } from "./bots/actions"
import {
  fetchManagedBotPresetStore,
  getPlayerBotPreset,
  createPresetBotController,
  type BotPresetId,
  BOT_PRESET_IDS,
  getBotPresetLabel,
} from "./bots/presets"
import {
  getTopScoredBotCandidates,
  simulateOperationsPlan,
  type ScoredBotCandidate,
  type KeepCityScoreBreakdown,
  type BuyVehicleScoreBreakdown,
  type DrawCityScoreBreakdown,
} from "./bots/scriptedBot"
import {
  appendActionLog,
  getBotActionLogMessage,
  getPhaseDiscardLogMessage,
  getNextLocalViewingPlayerId,
} from "./game/gameHelpers"
import type { GameState } from "./engine/types"
import Board from "./ui/Board"
import { PLAYER_SETUP_PRESETS, MAX_SETUP_PLAYERS } from "./gameSetup/defaultPlayers"

// ── Types ────────────────────────────────────────────────────────────────────

type DecisionTypeKey = "operations" | "vehicles" | "cities" | "end-turn"

const DECISION_TYPE_LABELS: Record<DecisionTypeKey, string> = {
  operations: "Operations (route claims, service pods)",
  vehicles: "Vehicles (buy vehicle)",
  cities: "City cards (draw & keep)",
  "end-turn": "End turn / pass",
}

function getDecisionType(actionType: string): DecisionTypeKey {
  switch (actionType) {
    case "claim-route":
    case "create-service-pod":
    case "remove-pod-city":
    case "ready-operations":
      return "operations"
    case "buy-vehicle":
      return "vehicles"
    case "draw-city-offer":
    case "keep-city-offer":
    case "confirm-add-city-picks":
      return "cities"
    default:
      return "end-turn"
  }
}

type BotSlotConfig = {
  name: string
  presetId: BotPresetId
  paused: boolean
}

type CoachSettings = {
  bots: BotSlotConfig[]
  pausedDecisionTypes: Set<DecisionTypeKey>
}

type PendingDecision = {
  botPlayerId: string
  botPlayerName: string
  decisionType: DecisionTypeKey
  candidates: ScoredBotCandidate[]
  chosenIndex: number
  nextPlannedLabel: string | null
  operationsPlan: import("./bots/scriptedBot").OperationsPlan | null
}

type AppPhase = "setup" | "playing" | "done"

// ── Helpers ──────────────────────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  borderRadius: 18,
  border: "1px solid #d8dfd5",
  background: "#ffffff",
  padding: 24,
  boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
}

const BUTTON_PRIMARY: React.CSSProperties = {
  padding: "10px 20px",
  borderRadius: 999,
  border: "1px solid #223024",
  background: "#223024",
  color: "#ffffff",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 14,
}

const BUTTON_SECONDARY: React.CSSProperties = {
  padding: "10px 20px",
  borderRadius: 999,
  border: "1px solid #c7d0c4",
  background: "#ffffff",
  color: "#223024",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 14,
}

function scorePts(n: number) {
  return `${n.toFixed(1)} pts`
}

function KeepCityBreakdownRow({ breakdown }: { breakdown: KeepCityScoreBreakdown }) {
  const popM = (breakdown.totalPopulation / 1_000_000).toFixed(2)
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 12, color: "#56635a", marginTop: 2 }}>
      <span title="Sum of both cities' populations × weight. Larger cities score higher.">
        Population: <strong>{popM}M</strong>
        <span style={{ color: "#8a9c8c" }}> × {breakdown.populationWeight} = {scorePts(breakdown.populationScore)}</span>
      </span>
      {breakdown.avgDistanceMiles !== null ? (
        <span title="Avg nearest distance from chosen cities to your existing network. Closer = more points (max bonus at 0 mi, zero at 2000+ mi).">
          Network: <strong>{breakdown.avgDistanceMiles.toLocaleString()} mi away</strong>
          <span style={{ color: "#8a9c8c" }}> × {breakdown.networkProximityWeight} = {scorePts(breakdown.networkProximityScore)}</span>
        </span>
      ) : (
        <span style={{ color: "#b0b8b2" }}>Network proximity: no owned cities yet</span>
      )}
      {breakdown.topRegion ? (
        <span title={`Cities in your top region (${breakdown.topRegion}) each add ${breakdown.regionMatchWeight} pts`}>
          Region ({breakdown.topRegion}): <strong>{breakdown.regionMatchCount} of 2 match</strong>
          <span style={{ color: "#8a9c8c" }}> × {breakdown.regionMatchWeight} = {scorePts(breakdown.regionMatchScore)}</span>
        </span>
      ) : (
        <span style={{ color: "#b0b8b2" }}>Region match: no concentration yet</span>
      )}
      <span title="Unclaimed adjacent routes = future connection potential. Opponent-claimed routes = blocked access (penalized ×2).">
        Adjacency: <strong style={{ color: breakdown.adjacencyPotential < 0 ? "#9b1c1c" : undefined }}>
          {breakdown.adjacencyPotential > 0 ? `+${breakdown.adjacencyPotential}` : breakdown.adjacencyPotential} open
        </strong>
        <span style={{ color: breakdown.adjacencyPotentialScore < 0 ? "#9b1c1c" : "#8a9c8c" }}> = {scorePts(breakdown.adjacencyPotentialScore)}</span>
      </span>
    </div>
  )
}

function DrawCityBreakdownRow({ breakdown }: { breakdown: DrawCityScoreBreakdown }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 12, color: "#56635a", marginTop: 2 }}>
      <span title="More cards remaining = more choices, scored higher">
        Deck size: <strong>{breakdown.deckSize} cards</strong>
        <span style={{ color: "#8a9c8c" }}> = {scorePts(breakdown.deckSizeScore)}</span>
      </span>
      <span title="Cities you already own in this region — drawing here extends your existing network">
        Your cities here: <strong>{breakdown.ownedInRegion}</strong>
        <span style={{ color: "#8a9c8c" }}> = {scorePts(breakdown.ownedInRegionScore)}</span>
      </span>
      {breakdown.opponentCitiesInRegion > 0 && (
        <span title="Opponents already own cities in this region — their network has a head start">
          Opponent cities: <strong style={{ color: "#9b1c1c" }}>{breakdown.opponentCitiesInRegion}</strong>
          <span style={{ color: "#9b1c1c" }}> = −{scorePts(breakdown.opponentPenalty)}</span>
        </span>
      )}
      {breakdown.bigCityScarcityScore > 0 && (
        <span title={`Deck is small (≤6 cards) but avg city pop is ${breakdown.bigCityScarcitySignal.toFixed(2)}M — high-value targets remain`}>
          Big city scarcity: <strong>{breakdown.bigCityScarcitySignal.toFixed(2)}M avg pop</strong>
          <span style={{ color: "#8a9c8c" }}> = {scorePts(breakdown.bigCityScarcityScore)}</span>
        </span>
      )}
    </div>
  )
}

function BuyVehicleBreakdownRow({ breakdown }: { breakdown: BuyVehicleScoreBreakdown }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px", fontSize: 12, color: "#56635a", marginTop: 2 }}>
      <span style={{ color: "#8a9c8c" }}>
        Cap: <strong style={{ color: "#223024" }}>{breakdown.totalPassengerCapacity} pax</strong>
      </span>
      <span style={{ color: "#8a9c8c" }}>
        Speed: <strong style={{ color: "#223024" }}>{breakdown.speed}</strong>
      </span>
      <span style={{ color: "#8a9c8c" }}>
        Op cost: <strong style={{ color: "#223024" }}>{breakdown.operatingCostMultiplier}×</strong>
      </span>
      <span title={`All ${breakdown.vehicleType} vehicles share the same type priority`}>
        Type priority: <strong>{scorePts(breakdown.typePriority)}</strong>
      </span>
      {breakdown.cityBonus !== 0 && (
        <span title={breakdown.cityBonusReason}>
          Context bonus: <strong style={{ color: breakdown.cityBonus >= 0 ? "#1a6b28" : "#9b1c1c" }}>{scorePts(breakdown.cityBonus)}</strong>
          <span style={{ color: "#8a9c8c" }}> ({breakdown.cityBonusReason})</span>
        </span>
      )}
      {breakdown.firstOfTypeBonus > 0 && (
        <span>First {breakdown.vehicleType} bonus: <strong style={{ color: "#1a6b28" }}>{scorePts(breakdown.firstOfTypeBonus)}</strong></span>
      )}
      {breakdown.duplicatePenalty > 0 && (
        <span title={`Already own ${breakdown.duplicateCount} ${breakdown.vehicleType}(s)`}>
          Duplicate penalty: <strong style={{ color: "#9b1c1c" }}>−{scorePts(breakdown.duplicatePenalty)}</strong>
        </span>
      )}
      <span title="Price subtracted directly from score">
        Price: <strong style={{ color: "#9b1c1c" }}>−{breakdown.purchasePriceM.toFixed(2)}M</strong>
      </span>
    </div>
  )
}



export default function CoachApp() {
  const [appPhase, setAppPhase] = useState<AppPhase>("setup")
  const [settings, setSettings] = useState<CoachSettings>(() => ({
    bots: [
      { name: "Stickbug 1", presetId: "bot-best-3p", paused: true },
      { name: "Stickbug 2", presetId: "bot-best-3p", paused: true },
      { name: "Stickbug 3", presetId: "bot-best-3p", paused: true },
    ],
    pausedDecisionTypes: new Set<DecisionTypeKey>(["operations", "vehicles", "cities"]),
  }))
  const [game, setGame] = useState<GameState | null>(null)
  const [viewingPlayerId, setViewingPlayerId] = useState<string | null>(null)
  const [isPeriodSummaryVisible, setIsPeriodSummaryVisible] = useState(false)
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null)
  const [session, setSession] = useState<CoachingSession | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  const gameRef = useRef<GameState | null>(null)
  const pendingDecisionRef = useRef<PendingDecision | null>(null)
  const botTurnSignatureRef = useRef<string | null>(null)

  useEffect(() => { gameRef.current = game }, [game])
  useEffect(() => { pendingDecisionRef.current = pendingDecision }, [pendingDecision])

  // ── Setup helpers ──────────────────────────────────────────────────────────

  const updateBotSlot = useCallback((index: number, updates: Partial<BotSlotConfig>) => {
    setSettings(prev => ({
      ...prev,
      bots: prev.bots.map((bot, i) => i === index ? { ...bot, ...updates } : bot),
    }))
  }, [])

  const toggleDecisionType = useCallback((key: DecisionTypeKey) => {
    setSettings(prev => {
      const next = new Set(prev.pausedDecisionTypes)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return { ...prev, pausedDecisionTypes: next }
    })
  }, [])

  const startGame = useCallback(async () => {
    const decks = loadUserDecks()
    const presetStore = await fetchManagedBotPresetStore()
    const botPresetWeightsById: Record<string, Record<string, number>> = {}

    const players = settings.bots.slice(0, Math.min(settings.bots.length, MAX_SETUP_PLAYERS)).map((bot, index) => {
      const preset = PLAYER_SETUP_PRESETS[index]!
      const presetId = bot.presetId

      if (presetStore) {
        const overrides = presetStore[presetId as keyof typeof presetStore]
        if (overrides && typeof overrides === "object") {
          botPresetWeightsById[presetId] = overrides as Record<string, number>
        }
      }

      return {
        ...preset,
        name: bot.name,
        isBot: true,
        botPreset: presetId,
      }
    })

    const initialGame = createGameState(usMap, {
      players,
      vehicleCards: decks.vehicleCards,
      chanceCards: decks.chanceCards,
      startingMoney: DEFAULT_STARTING_MONEY,
      botPresetWeightsById,
    })

    const newSession: CoachingSession = {
      id: generateSessionId(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      playerCount: players.length,
      decisions: [],
    }

    setGame(initialGame)
    setViewingPlayerId(initialGame.players[0]?.id ?? null)
    setSession(newSession)
    saveCurrentCoachingSession(newSession)
    botTurnSignatureRef.current = null
    setAppPhase("playing")
  }, [settings])

  // ── Bot turn loop ──────────────────────────────────────────────────────────

  const botPlayerIds = useMemo(
    () => new Set(game?.players.map(p => p.id) ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [game?.players],
  )

  useEffect(() => {
    if (appPhase !== "playing" || !game || game.isGameOver || pendingDecision) {
      botTurnSignatureRef.current = null
      return
    }

    const pendingBotId = getPendingBotPlayerId(game, botPlayerIds)

    if (!pendingBotId) {
      if (game.isGameOver) {
        setAppPhase("done")
      }
      return
    }

    const turnSignature = JSON.stringify({
      week: game.currentWeek,
      phase: game.currentPhase,
      currentPlayerId: game.currentPlayerId,
      playerPhases: game.players.map(p => [p.id, p.phase]),
      bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds,
      pendingBotId,
    })

    if (botTurnSignatureRef.current === turnSignature) {
      return
    }

    botTurnSignatureRef.current = turnSignature

    const botSlotIndex = game.players.findIndex(p => p.id === pendingBotId)
    const botSlot = settings.bots[botSlotIndex] ?? null
    const shouldPause = botSlot?.paused ?? false

    const legalActions = getBotLegalActions(game, pendingBotId)
    if (legalActions.length === 0) return

    // Determine what type the top action is
    const weights = game.botPresetWeightsById?.[botSlot?.presetId ?? ""] ?? {}
    const allCandidates = getTopScoredBotCandidates(game, pendingBotId, weights, 8)
    // Filter out non-viable alternatives (score -Infinity or extremely negative relative to top)
    const topScore = allCandidates[0]?.score ?? 0
    const candidates = allCandidates.filter((c, i) =>
      i === 0 ||
      (isFinite(c.score) && c.score > Number.NEGATIVE_INFINITY && c.score > topScore - 200)
    )
    const topAction = candidates[0]?.action ?? legalActions[0]!
    const decisionType = getDecisionType(topAction.type)

    const isPausedType = settings.pausedDecisionTypes.has(decisionType)

    // While the period summary is open, only allow ready-bureaucracy through.
    // All other actions wait until the user closes the summary.
    if (isPeriodSummaryVisible && topAction.type !== "ready-bureaucracy") {
      botTurnSignatureRef.current = null
      return
    }

    // Only pause if there are real alternatives to compare
    const hasViableAlternatives = candidates.length > 1
    if (shouldPause && isPausedType && hasViableAlternatives && !isPeriodSummaryVisible) {
      const botPlayer = game.players.find(p => p.id === pendingBotId)

      // For operations: compute plan asynchronously after pause is set (avoid blocking main thread)
      let operationsPlan: import("./bots/scriptedBot").OperationsPlan | null = null
      let nextPlannedLabel: string | null = null
      if (decisionType !== "operations") {
        // Peek one step ahead for non-operations decisions
        try {
          if (topAction) {
            const simGame = applyBotAction(game, pendingBotId, topAction)
            const nextPending = getPendingBotPlayerId(simGame, botPlayerIds)
            if (nextPending === pendingBotId) {
              const simWeights = simGame.botPresetWeightsById?.[botSlot?.presetId ?? ""] ?? {}
              const nextCandidates = getTopScoredBotCandidates(simGame, pendingBotId, simWeights, 1)
              nextPlannedLabel = nextCandidates[0]?.label ?? null
            }
          }
        } catch { /* ignore */ }
      }

      setPendingDecision({
        botPlayerId: pendingBotId,
        botPlayerName: botPlayer?.name ?? pendingBotId,
        decisionType,
        candidates,
        chosenIndex: 0,
        nextPlannedLabel,
        operationsPlan,
      })
      return
    }

    // Auto-execute top action
    const commitId = window.setTimeout(() => {
      const currentGame = gameRef.current
      if (!currentGame || pendingDecisionRef.current) return

      const controller = createPresetBotController(
        pendingBotId,
        getPlayerBotPreset(currentGame.players.find(p => p.id === pendingBotId) ?? null),
        currentGame.botPresetWeightsById,
      )
      const action = controller.pickAction({
        game: currentGame,
        playerId: pendingBotId,
        legalActions: getBotLegalActions(currentGame, pendingBotId),
        phase: currentGame.currentPhase,
      })

      const advancedGame = applyBotAction(currentGame, pendingBotId, action)
      const discardMessage = action.type === "end-turn" ? getPhaseDiscardLogMessage(currentGame, advancedGame) : null
      const actionMessage = getBotActionLogMessage(currentGame, advancedGame, action)
      const nextGame = appendActionLog(currentGame, advancedGame, discardMessage ? `${actionMessage}; ${discardMessage}` : actionMessage, pendingBotId)

      botTurnSignatureRef.current = null
      setGame(nextGame)
      setViewingPlayerId(prev => getNextLocalViewingPlayerId(nextGame, prev) ?? nextGame.players[0]?.id ?? prev)
    }, 80)

    return () => window.clearTimeout(commitId)
  }, [appPhase, game, botPlayerIds, pendingDecision, isPeriodSummaryVisible, settings])

  // Compute operations plan asynchronously after pause is set (avoids blocking the main thread)
  useEffect(() => {
    if (!pendingDecision || pendingDecision.decisionType !== "operations" || pendingDecision.operationsPlan !== null) return
    const { botPlayerId } = pendingDecision
    const currentGame = gameRef.current
    if (!currentGame) return
    const botSlotIndex = currentGame.players.findIndex(p => p.id === botPlayerId)
    const botSlot = settings.bots[botSlotIndex] ?? null
    const weights = currentGame.botPresetWeightsById?.[botSlot?.presetId ?? ""] ?? {}
    let cancelled = false
    const id = window.setTimeout(() => {
      if (cancelled) return
      try {
        const plan = simulateOperationsPlan(currentGame, botPlayerId, weights)
        setPendingDecision(prev => prev ? { ...prev, operationsPlan: plan } : null)
      } catch { /* ignore */ }
    }, 0)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [pendingDecision, settings])

  // Check for game over after each game update
  useEffect(() => {
    if (game?.isGameOver && appPhase === "playing" && !pendingDecision) {
      setAppPhase("done")
    }
  }, [game?.isGameOver, appPhase, pendingDecision])

  // ── Decision rating ────────────────────────────────────────────────────────

  const executeDecision = useCallback((
    decision: PendingDecision,
    chosenCandidateIndex: number,
    rating: "accept" | "reject",
    preferredIndex: number | null,
  ) => {
    const currentGame = gameRef.current
    if (!currentGame) return

    const candidate = decision.candidates[chosenCandidateIndex]
    if (!candidate) return

    const action = candidate.action
    const advancedGame = applyBotAction(currentGame, decision.botPlayerId, action)
    const discardMessage = action.type === "end-turn" ? getPhaseDiscardLogMessage(currentGame, advancedGame) : null
    const actionMessage = getBotActionLogMessage(currentGame, advancedGame, action)
    const nextGame = appendActionLog(currentGame, advancedGame, discardMessage ? `${actionMessage}; ${discardMessage}` : actionMessage, decision.botPlayerId)

    // Save rating to session
    const botPreset = currentGame.players.find(p => p.id === decision.botPlayerId)?.botPreset
    const weights = botPreset ? (currentGame.botPresetWeightsById?.[botPreset] ?? {}) : {}

    const coachDecision: CoachingDecision = {
      id: generateDecisionId(),
      sessionId: session?.id ?? "",
      timestamp: new Date().toISOString(),
      botPlayerId: decision.botPlayerId,
      botPlayerName: decision.botPlayerName,
      decisionType: decision.decisionType,
      week: currentGame.currentWeek,
      phase: currentGame.currentPhase,
      weightsSnapshot: weights,
      candidates: decision.candidates.map(c => ({
        action: c.action,
        score: c.score,
        label: c.label,
        breakdown: c.breakdown,
      })),
      chosenIndex: chosenCandidateIndex,
      rating,
      preferredIndex,
    }

    setSession(prev => {
      if (!prev) return prev
      const updated = { ...prev, decisions: [...prev.decisions, coachDecision] }
      saveCurrentCoachingSession(updated)
      return updated
    })

    botTurnSignatureRef.current = null
    setPendingDecision(null)
    setGame(nextGame)
    setViewingPlayerId(prev => getNextLocalViewingPlayerId(nextGame, prev) ?? nextGame.players[0]?.id ?? prev)
  }, [session])

  const handleAccept = useCallback(() => {
    if (!pendingDecision) return
    executeDecision(pendingDecision, 0, "accept", null)
  }, [pendingDecision, executeDecision])

  const handleReject = useCallback((preferredIndex: number) => {
    if (!pendingDecision) return
    executeDecision(pendingDecision, preferredIndex, "reject", preferredIndex)
  }, [pendingDecision, executeDecision])

  const handleSkip = useCallback(() => {
    if (!pendingDecision) return
    executeDecision(pendingDecision, 0, "accept", null)
  }, [pendingDecision, executeDecision])

  // ── Save session ───────────────────────────────────────────────────────────

  const handleSaveSession = useCallback(async () => {
    if (!session) return
    setIsSaving(true)
    try {
      const finalSession = { ...session, endedAt: new Date().toISOString() }
      await persistCoachingSession(finalSession)
      setSaveMessage(`Saved: ${summarizeCoachingSession(finalSession)}`)
    } catch {
      setSaveMessage("Failed to save session.")
    } finally {
      setIsSaving(false)
    }
  }, [session])

  // ── Board action handlers (view-only; no human players) ───────────────────
  // These are no-ops since all players are bots, but Board requires them.

  const noop = useCallback(() => ({ ok: false as const, error: "All players are bots." }), [])
  const noopVoid = useCallback(() => {}, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (appPhase === "setup") {
    return (
      <div style={{ minHeight: "100vh", background: "#f3f6f2", padding: 24, overflowY: "auto" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "grid", gap: 20 }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#223024" }}>Bot Coaching</div>
          <div style={{ color: "#56635a" }}>
            Watch bots play and rate their decisions. Your ratings are saved and used to improve bot weights.
          </div>

          {/* Bot slots */}
          <div style={CARD_STYLE}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#223024", marginBottom: 16 }}>Bots</div>
            <div style={{ display: "grid", gap: 14 }}>
              {settings.bots.map((bot, index) => (
                <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 10, border: "1px solid #d8dfd5", background: "#fbfcfb" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#56635a", fontWeight: 700, marginBottom: 4 }}>Name</div>
                    <input
                      type="text"
                      value={bot.name}
                      onChange={e => updateBotSlot(index, { name: e.target.value })}
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #c7d0c4", fontSize: 14, width: "100%", boxSizing: "border-box" }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#56635a", fontWeight: 700, marginBottom: 4 }}>Preset</div>
                    <select
                      value={bot.presetId}
                      onChange={e => updateBotSlot(index, { presetId: e.target.value as BotPresetId })}
                      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #c7d0c4", fontSize: 14, width: "100%" }}
                    >
                      {BOT_PRESET_IDS.map(id => (
                        <option key={id} value={id}>{getBotPresetLabel(id)}</option>
                      ))}
                    </select>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#223024", cursor: "pointer", whiteSpace: "nowrap", paddingTop: 18 }}>
                    <input
                      type="checkbox"
                      checked={bot.paused}
                      onChange={e => updateBotSlot(index, { paused: e.target.checked })}
                    />
                    Pause for coaching
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Decision types */}
          <div style={CARD_STYLE}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#223024", marginBottom: 4 }}>Decision types to coach</div>
            <div style={{ color: "#56635a", fontSize: 14, marginBottom: 16 }}>
              Only paused bots will stop for these decision types.
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {(Object.entries(DECISION_TYPE_LABELS) as [DecisionTypeKey, string][]).map(([key, label]) => (
                <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#223024", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={settings.pausedDecisionTypes.has(key)}
                    onChange={() => toggleDecisionType(key)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void startGame()}
            style={BUTTON_PRIMARY}
          >
            Start coaching session
          </button>

          <a href="/training.html" style={{ color: "#56635a", fontSize: 13 }}>← Back to training</a>
        </div>
      </div>
    )
  }

  if (!game) return null

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      {/* Board (view-only) */}
      <div style={{ pointerEvents: "auto" }}>
        <Board
          game={game}
          viewingPlayerId={pendingDecision?.botPlayerId ?? viewingPlayerId}
          suppressPeriodSummary={false}
          onPeriodSummaryVisibilityChange={setIsPeriodSummaryVisible}
          onClaimRoute={noop}
          onDrawCityOffer={noop}
          onSetActiveCityOfferKeptCityIds={noop}
          onBuyVehicleCard={noop}
          onUpgradeRailRoute={noop}
          onSetBureaucracyRouteVehicleCard={noop}
          onAddBureaucracyServiceSplit={noop}
          onMoveBureaucracyServiceCity={noop}
          onDeleteBureaucracyServicePod={noop}
          onAdvanceTurn={noop}
          onUndo={noopVoid}
          canUndo={false}
        />
      </div>

      {/* Decision panel */}
      {pendingDecision && (
        <div style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 440,
          background: "#ffffff",
          borderLeft: "2px solid #d8dfd5",
          zIndex: 50,
          padding: 20,
          overflowY: "auto",
          display: "grid",
          alignContent: "start",
          gap: 16,
          boxShadow: "-8px 0 32px rgba(0,0,0,0.15)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, color: "#56635a", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {pendingDecision.botPlayerName} · {DECISION_TYPE_LABELS[pendingDecision.decisionType] ?? pendingDecision.decisionType}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#223024", marginTop: 4 }}>
                  Rate this decision
                </div>
                {pendingDecision.nextPlannedLabel && (
                  <div style={{ fontSize: 12, color: "#8a9c8c", marginTop: 4 }}>
                    If accepted → next planned: <em>{pendingDecision.nextPlannedLabel}</em>
                  </div>
                )}
                {pendingDecision.operationsPlan && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "#f2f6f2", borderRadius: 8, fontSize: 12, color: "#223024" }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Full operations plan:</div>
                    {pendingDecision.operationsPlan.routes.length > 0 && (
                      <div>
                        <span style={{ fontWeight: 600 }}>Build rail: </span>
                        {pendingDecision.operationsPlan.routes.map((r, i) => (
                          <span key={i}>{r.cityNames.join(" → ")}{i < pendingDecision.operationsPlan!.routes.length - 1 ? ", " : ""}</span>
                        ))}
                      </div>
                    )}
                    {pendingDecision.operationsPlan.pods.length > 0 && (
                      <div style={{ marginTop: 2 }}>
                        <span style={{ fontWeight: 600 }}>Service pods: </span>
                        {pendingDecision.operationsPlan.pods.map((p, i) => (
                          <span key={i}>[{p.cityNames.join(" – ")}]{i < pendingDecision.operationsPlan!.pods.length - 1 ? ", " : ""}</span>
                        ))}
                      </div>
                    )}
                    {pendingDecision.operationsPlan.otherLabels.length > 0 && (
                      <div style={{ marginTop: 2, color: "#56635a" }}>
                        {pendingDecision.operationsPlan.otherLabels.join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button type="button" onClick={handleSkip} style={{ ...BUTTON_SECONDARY, fontSize: 13 }}>Skip</button>
            </div>

            {/* Candidates */}
            <div style={{ display: "grid", gap: 10 }}>
              {pendingDecision.candidates.map((candidate, index) => (
                <div
                  key={index}
                  style={{
                    border: `2px solid ${index === 0 ? "#223024" : "#d8dfd5"}`,
                    borderRadius: 12,
                    padding: "12px 14px",
                    background: index === 0 ? "#f7fbf6" : "#fbfcfb",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {index === 0 && (
                        <span style={{ fontSize: 11, fontWeight: 800, background: "#223024", color: "#fff", borderRadius: 6, padding: "2px 7px", letterSpacing: 0.3 }}>
                          BOT CHOICE
                        </span>
                      )}
                      <span style={{ fontSize: 15, fontWeight: index === 0 ? 800 : 600, color: "#223024" }}>
                        {candidate.label}
                      </span>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#56635a", whiteSpace: "nowrap" }}>
                      Score: {candidate.score.toFixed(1)}
                    </span>
                  </div>

                  {/* Breakdown for claim-route: no kind field */}
                  {candidate.breakdown && !("kind" in candidate.breakdown) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 12, color: "#56635a" }}>
                      {candidate.breakdown.modeBase !== 0 && <span>Mode base: {scorePts(candidate.breakdown.modeBase)}</span>}
                      {candidate.breakdown.populationScore !== 0 && <span>Population: {scorePts(candidate.breakdown.populationScore)}</span>}
                      {candidate.breakdown.newCityBonus !== 0 && <span>New cities: {scorePts(candidate.breakdown.newCityBonus)}</span>}
                      {candidate.breakdown.firstModeBonus !== 0 && <span>First mode: {scorePts(candidate.breakdown.firstModeBonus)}</span>}
                      {candidate.breakdown.regionPreference !== 0 && <span>Region pref: {scorePts(candidate.breakdown.regionPreference)}</span>}
                      {candidate.breakdown.sameRegionLinkBonus !== 0 && <span>Same region: {scorePts(candidate.breakdown.sameRegionLinkBonus)}</span>}
                      {candidate.breakdown.longDistancePreference !== 0 && <span>Long distance: {scorePts(candidate.breakdown.longDistancePreference)}</span>}
                      {candidate.breakdown.newRegionBonus !== 0 && <span>New region: {scorePts(candidate.breakdown.newRegionBonus)}</span>}
                      {candidate.breakdown.adjacentNetworkBonus !== 0 && <span>Network ext. ×{candidate.breakdown.adjacentNetworkCount}: {scorePts(candidate.breakdown.adjacentNetworkBonus)}</span>}
                      {candidate.breakdown.opponentBlockPenalty !== 0 && <span style={{ color: "#9b1c1c" }}>Opponent block ×{candidate.breakdown.opponentBlockCount}: −{scorePts(candidate.breakdown.opponentBlockPenalty)}</span>}
                      {candidate.breakdown.costPenalty !== 0 && <span style={{ color: "#9b1c1c" }}>Cost penalty: −{scorePts(candidate.breakdown.costPenalty)}</span>}
                    </div>
                  )}

                  {/* Breakdown for keep-city-offer */}
                  {candidate.breakdown && "kind" in candidate.breakdown && candidate.breakdown.kind === "keep-city" && (
                    <KeepCityBreakdownRow breakdown={candidate.breakdown} />
                  )}

                  {/* Breakdown for draw-city-offer */}
                  {candidate.breakdown && "kind" in candidate.breakdown && candidate.breakdown.kind === "draw-city" && (
                    <DrawCityBreakdownRow breakdown={candidate.breakdown} />
                  )}

                  {/* Breakdown for buy-vehicle */}
                  {candidate.breakdown && "kind" in candidate.breakdown && candidate.breakdown.kind === "buy-vehicle" && (
                    <BuyVehicleBreakdownRow breakdown={candidate.breakdown} />
                  )}

                  {/* Action buttons */}
                  <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                    {index === 0 ? (
                      <button
                        type="button"
                        onClick={handleAccept}
                        style={{ ...BUTTON_PRIMARY, padding: "7px 16px", fontSize: 13 }}
                      >
                        👍 Accept
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleReject(index)}
                        style={{ ...BUTTON_SECONDARY, padding: "7px 16px", fontSize: 13, borderColor: "#c7a0a0", color: "#9b1c1c" }}
                      >
                        👎 This was better
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 12, color: "#8a9c8c" }}>
              Accept = bot choice was correct. "This was better" = reject bot choice and indicate the preferred alternative.
            </div>
        </div>
      )}

      {/* Game over overlay */}
      {appPhase === "done" && !pendingDecision && (
        <div style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          background: "rgba(34, 48, 36, 0.6)",
          zIndex: 50,
        }}>
          <div style={{ ...CARD_STYLE, maxWidth: 480, width: "100%", gap: 16, display: "grid" }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#223024" }}>Game over</div>
            {session && (
              <div style={{ color: "#56635a", fontSize: 14 }}>
                {summarizeCoachingSession(session)}
              </div>
            )}
            {saveMessage && (
              <div style={{ fontSize: 13, color: "#1f5f2c", fontWeight: 700 }}>{saveMessage}</div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void handleSaveSession()}
                disabled={isSaving || session?.decisions.length === 0}
                style={{
                  ...BUTTON_PRIMARY,
                  opacity: isSaving || session?.decisions.length === 0 ? 0.5 : 1,
                  cursor: isSaving ? "wait" : "pointer",
                }}
              >
                {isSaving ? "Saving..." : "Save session"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppPhase("setup")
                  setGame(null)
                  setSession(null)
                  setPendingDecision(null)
                  setSaveMessage(null)
                }}
                style={BUTTON_SECONDARY}
              >
                New session
              </button>
              <a href="/training.html" style={{ ...BUTTON_SECONDARY, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                Back to training
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Coaching stats HUD */}
      {appPhase === "playing" && session && session.decisions.length > 0 && (
        <div style={{
          position: "absolute",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(34, 48, 36, 0.88)",
          color: "#ffffff",
          borderRadius: 14,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 700,
          zIndex: 10,
          whiteSpace: "nowrap",
        }}>
          🎓 {session.decisions.length} rated · {session.decisions.filter(d => d.rating === "accept").length} accepted · {session.decisions.filter(d => d.preferredIndex !== null).length} with preference
        </div>
      )}
    </div>
  )
}
