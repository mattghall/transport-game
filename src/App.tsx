import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loadUserDecks } from "./data/deckData"
import {
  clearSavedGame,
  getLobbyClientId,
  clearActiveAdminLaunch,
  clearActiveSessionPlayer,
  loadJoinAppUrl,
  loadActiveSessionPlayer,
  loadPlayerName,
  saveActiveAdminLaunch,
  saveActiveSessionPlayer,
  saveJoinAppUrl,
  saveSavedGame,
  savePlayerName,
} from "./data/gameStorage"
import { usMap } from "./data/maps/usMap"
import { PLAYER_SETUP_PRESETS } from "./gameSetup/defaultPlayers"
import { createDefaultSetupPlayers } from "./gameSetup/defaultPlayers"
import {
  addBureaucracyServiceSplit,
  advanceTurn,
  buyResource,
  buyVehicleCard,
  canPlayerEditOperations,
  claimRoute,
  confirmClaimPicks,
  deleteBureaucracyServicePod,
  drawCityOffer,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedOperations,
  hasPlayerConfirmedClaimRoutes,
  markBureaucracyReady,
  markOperationsReady,
  moveBureaucracyServiceCity,
  setActiveCityOfferKeptCityIds,
  setBureaucracyRouteVehicleCard,
  upgradeRailRoute,
} from "./engine/actions"
import { findPlayerBureaucracyPlan } from "./engine/bureaucracy"
import { createGameState, DEFAULT_STARTING_MONEY } from "./engine/createGameState"
import type { GameActionLogEntry, GameState, PurchasableResource, WeeklyPhase } from "./engine/types"
import {
  buildLanSessionJoinUrl,
  createLanSession,
  deleteLanSession,
  fetchLanSession,
  getDefaultJoinAppUrl,
  fetchSessionServerHealth,
  getDefaultSessionServerUrl,
  getSuggestedJoinAppUrl,
  getRequestedLanSession,
  hydrateLanSessionGame,
  isLanSessionConflictError,
  isLocalJoinAppUrl,
  listLanSessions,
  normalizeJoinAppUrl,
  pushLanSessionGame,
  subscribeToLanSession,
  type LanSessionClosedEvent,
  updateLanLobby,
  type LanSessionLobby,
  type SessionServerHealth,
  type LanSessionSummary,
  type LanSessionSnapshot,
} from "./network/sessionSync"
import Board from "./ui/Board"

function formatPhaseLabel(phase: WeeklyPhase) {
  switch (phase) {
    case "purchase-equipment":
      return "purchase equipment"
    case "claim-routes":
      return "claim routes"
    case "operations":
      return "operations"
    case "purchase-fuel":
      return "purchase fuel"
    case "bureaucracy":
      return "bureaucracy"
  }
}

function appendActionLog(
  previousGame: GameState,
  nextGame: GameState,
  message: string,
  playerId: string | null = previousGame.currentPlayerId,
) {
  const playerName =
    (playerId && previousGame.players.find(player => player.id === playerId)?.name) ?? "System"
  const entry: GameActionLogEntry = {
    id: `action-${previousGame.actionLog.length + 1}`,
    playerId,
    playerName,
    week: previousGame.currentWeek,
    phase: previousGame.currentPhase,
    message,
  }

  return {
    ...nextGame,
    actionLog: [...nextGame.actionLog, entry],
  }
}

function getAdvanceTurnLogMessage(previousGame: GameState, nextGame: GameState) {
  const nextPlayer = nextGame.players.find(player => player.id === nextGame.currentPlayerId)

  return nextGame.currentWeek !== previousGame.currentWeek
    ? `advanced to month ${nextGame.currentWeek} ${formatPhaseLabel(nextGame.currentPhase)}`
    : nextGame.currentPhase !== previousGame.currentPhase
      ? `advanced to ${formatPhaseLabel(nextGame.currentPhase)}`
      : `ended turn, next player ${nextPlayer?.name ?? nextGame.currentPlayerId}`
}

function getPhaseDiscardLogMessage(previousGame: GameState, nextGame: GameState) {
  const burnedVehicleCards =
    previousGame.currentPhase === "purchase-equipment" &&
    nextGame.currentPhase === "claim-routes" &&
    previousGame.vehicleMarketCardIds.length !== nextGame.vehicleMarketCardIds.length
      ? previousGame.vehicleMarketCardIds
          .filter(cardId => !nextGame.vehicleMarketCardIds.includes(cardId))
          .map(cardId => previousGame.vehicleCatalog.find(card => card.id === cardId) ?? null)
          .filter((card): card is NonNullable<typeof card> => card !== null)
          .sort((cardA, cardB) => cardA.type.localeCompare(cardB.type) || cardA.number - cardB.number)
      : []
  const messages = [
    ...burnedVehicleCards.map(
      card =>
        `removed vehicle #${card.number} ${card.name} from the ${card.type} deck because nobody bought a ${card.type === "air" ? "plane" : card.type} this month`,
    ),
  ]

  return messages.length > 0 ? messages.join("; ") : null
}

type LanSessionConnection = {
  sessionId: string
  sessionName: string
  serverUrl: string
  version: number
}

type AppMode = "launcher" | "joining" | "waiting" | "lobby" | "ready"

function createPlaceholderGame() {
  const initialUserDecks = loadUserDecks()

  return createGameState(usMap, {
    players: createDefaultSetupPlayers(),
    vehicleCards: initialUserDecks.vehicleCards,
    chanceCards: initialUserDecks.chanceCards,
    startingMoney: DEFAULT_STARTING_MONEY,
  })
}

function createLauncherPlayers(playerCount: number) {
  return PLAYER_SETUP_PRESETS.slice(0, playerCount).map((player, index) => ({
    ...player,
    name: `Player ${index + 1}`,
  }))
}

function isLegacyLobbyApiError(error: unknown) {
  return (
    error instanceof Error &&
    (
      error.message.includes("Lobby updates must include playerId, clientId, and isReady.") ||
      error.message.includes("Lobby updates must include clientId and may include playerId, isReady, and playerName.") ||
      error.message.includes("Lobby updates must include clientId and may include playerId, isReady, playerName, and startGame.")
    )
  )
}

function isLegacyGameApiError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("Game updates must include a game object.")
  )
}

function shouldReplaceJoinAppUrl(rawUrl: string) {
  try {
    return isLocalJoinAppUrl(normalizeJoinAppUrl(rawUrl))
  } catch {
    return true
  }
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

type GameMutationFailure = {
  ok: false
  error: string
}

export default function App() {
  const lobbyClientId = getLobbyClientId()
  const requestedLanSession = getRequestedLanSession()
  const requestedLanSessionId = requestedLanSession?.sessionId ?? null
  const requestedLanSessionServerUrl = requestedLanSession?.serverUrl ?? null
  const isLauncherRoute = requestedLanSessionId === null
  const defaultSessionServerUrl = getDefaultSessionServerUrl()
  const [joinAppUrl, setJoinAppUrl] = useState(() => loadJoinAppUrl() ?? getDefaultJoinAppUrl())
  const [game, setGame] = useState(() => createPlaceholderGame())
  const [history, setHistory] = useState<typeof game[]>([])
  const [lanSession, setLanSession] = useState<LanSessionConnection | null>(null)
  const [lanLobby, setLanLobby] = useState<LanSessionLobby | null>(null)
  const lanSessionRef = useRef<LanSessionConnection | null>(null)
  const autoAssignAttemptedSessionIdRef = useRef<string | null>(null)
  const [lanStatusMessage, setLanStatusMessage] = useState(() => {
    if (requestedLanSessionId) {
      return `Connecting to session ${requestedLanSessionId}...`
    }

    return "Create a LAN game or join an existing one."
  })
  const [lanStatusTone, setLanStatusTone] = useState<"neutral" | "error">("neutral")
  const [appMode, setAppMode] = useState<AppMode>(() => (requestedLanSession ? "joining" : "launcher"))
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null)
  const [playerName, setPlayerName] = useState("")
  const [isUpdatingLobby, setIsUpdatingLobby] = useState(false)
  const [maxPlayers, setMaxPlayers] = useState(4)
  const [launcherSessions, setLauncherSessions] = useState<LanSessionSummary[]>([])
  const [launcherServerOnline, setLauncherServerOnline] = useState<boolean | null>(null)
  const [isLaunchingSession, setIsLaunchingSession] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [isPeriodSummaryVisible, setIsPeriodSummaryVisible] = useState(false)
  const normalizedJoinAppUrl = useMemo(() => {
    try {
      return normalizeJoinAppUrl(joinAppUrl)
    } catch {
      return getDefaultJoinAppUrl()
    }
  }, [joinAppUrl])
  const hasValidJoinAppUrl = useMemo(() => {
    try {
      normalizeJoinAppUrl(joinAppUrl)
      return true
    } catch {
      return false
    }
  }, [joinAppUrl])

  const hasStarted = appMode === "ready"

  useEffect(() => {
    lanSessionRef.current = lanSession
  }, [lanSession])

  const handleJoinAppUrlChange = useCallback((rawUrl: string) => {
    setJoinAppUrl(rawUrl)

    try {
      saveJoinAppUrl(normalizeJoinAppUrl(rawUrl))
    } catch {
      // Keep the current field value while the user edits an incomplete URL.
    }
  }, [])
  const adoptSuggestedJoinAppUrl = useCallback((health: Pick<SessionServerHealth, "lanAddresses">) => {
    const suggestedJoinAppUrl = getSuggestedJoinAppUrl(health)

    setJoinAppUrl(currentJoinAppUrl => {
      if (!shouldReplaceJoinAppUrl(currentJoinAppUrl)) {
        return currentJoinAppUrl
      }

      saveJoinAppUrl(suggestedJoinAppUrl)
      return suggestedJoinAppUrl
    })
  }, [])

  const applyLanSnapshot = useCallback((snapshot: LanSessionSnapshot, serverUrl: string) => {
    const nextConnection = {
      sessionId: snapshot.sessionId,
      sessionName: snapshot.sessionName,
      serverUrl,
      version: snapshot.version,
    }
    const nextGame = hydrateLanSessionGame(snapshot)
    const storedPlayerId = loadActiveSessionPlayer(snapshot.sessionId)
    const storedLobbyPlayer = storedPlayerId
      ? snapshot.lobby.players.find(player => player.playerId === storedPlayerId) ?? null
      : null
    const claimedLobbyPlayer =
      snapshot.lobby.players.find(player => player.claimedBy === lobbyClientId) ?? null
    const nextSelectedPlayerId =
      storedLobbyPlayer && (!storedLobbyPlayer.claimedBy || storedLobbyPlayer.claimedBy === lobbyClientId)
        ? storedPlayerId
        : claimedLobbyPlayer?.playerId ?? null
    const nextSelectedPlayer =
      nextSelectedPlayerId
        ? nextGame.players.find(player => player.id === nextSelectedPlayerId) ?? null
        : null
    const storedPlayerName = loadPlayerName()

    lanSessionRef.current = nextConnection
    setLanSession(nextConnection)
    setLanLobby(snapshot.lobby)
    setGame(nextGame)
    setHistory([])
    setSelectedPlayerId(nextSelectedPlayerId)
    setPlayerName(storedPlayerName ?? nextSelectedPlayer?.name ?? "")
    saveSavedGame(nextGame)
    saveActiveAdminLaunch({
      sessionId: snapshot.sessionId,
      sessionName: snapshot.sessionName,
      serverUrl,
    })
    if (nextSelectedPlayerId) {
      saveActiveSessionPlayer(snapshot.sessionId, nextSelectedPlayerId)
    } else {
      clearActiveSessionPlayer(snapshot.sessionId)
    }
    setLanStatusTone("neutral")
    setLanStatusMessage(
      snapshot.lobby.status === "started"
        ? `Connected to ${snapshot.sessionName} (${snapshot.sessionId}).`
        : `Joined ${snapshot.sessionName} (${snapshot.sessionId}). Waiting for every player to ready up.`,
    )
    setAppMode(snapshot.lobby.status === "started" ? "ready" : "lobby")
  }, [lobbyClientId])

  useEffect(() => {
    if (isLauncherRoute) {
      return
    }

    let isActive = true

    async function bootstrapSession() {
      if (!requestedLanSessionId || !requestedLanSessionServerUrl) {
        return
      }

      try {
        const snapshot = await fetchLanSession(requestedLanSessionServerUrl, requestedLanSessionId)

        if (!isActive) {
          return
        }

        applyLanSnapshot(snapshot, requestedLanSessionServerUrl)
      } catch (error) {
        if (!isActive) {
          return
        }

        lanSessionRef.current = null
        setLanSession(null)
        setLanLobby(null)
        setSelectedPlayerId(null)
        setLanStatusTone("error")
        setLanStatusMessage(
          error instanceof Error
            ? error.message
            : `Could not join session ${requestedLanSessionId}.`,
        )
        setAppMode("waiting")
      }
    }

    void bootstrapSession()

    return () => {
      isActive = false
    }
  }, [
    applyLanSnapshot,
    isLauncherRoute,
    requestedLanSessionId,
    requestedLanSessionServerUrl,
  ])

  useEffect(() => {
    let isActive = true
    const activeServerUrl = requestedLanSessionServerUrl ?? defaultSessionServerUrl

    void fetchSessionServerHealth(activeServerUrl)
      .then(health => {
        if (!isActive) {
          return
        }

        adoptSuggestedJoinAppUrl(health)
      })
      .catch(() => {
        // Leave the stored join URL alone when the session server is unavailable.
      })

    return () => {
      isActive = false
    }
  }, [adoptSuggestedJoinAppUrl, defaultSessionServerUrl, requestedLanSessionServerUrl])

  useEffect(() => {
    if (!isLauncherRoute) {
      return
    }

    let isActive = true

    async function refreshLauncherState() {
      try {
        const [health, sessions] = await Promise.all([
          fetchSessionServerHealth(defaultSessionServerUrl),
          listLanSessions(defaultSessionServerUrl),
        ])

        if (!isActive) {
          return
        }

        adoptSuggestedJoinAppUrl(health)
        setLauncherServerOnline(health.ok)
        setLauncherSessions(sessions)
        setLanStatusTone("neutral")
        setLanStatusMessage(
          sessions.length === 0
            ? "No LAN games are running yet."
            : `${sessions.length} LAN game${sessions.length === 1 ? "" : "s"} available.`,
        )
      } catch (error) {
        if (!isActive) {
          return
        }

        setLauncherServerOnline(false)
        setLauncherSessions([])
        setLanStatusTone("error")
        setLanStatusMessage(
          error instanceof Error ? error.message : "Could not reach the session server.",
        )
      }
    }

    void refreshLauncherState()
    const pollId = window.setInterval(() => {
      void refreshLauncherState()
    }, 5000)

    return () => {
      isActive = false
      window.clearInterval(pollId)
    }
  }, [adoptSuggestedJoinAppUrl, defaultSessionServerUrl, isLauncherRoute])

  useEffect(() => {
    if (!lanSession) {
      return
    }

    return subscribeToLanSession(lanSession.serverUrl, lanSession.sessionId, {
      onSnapshot(snapshot) {
        if (snapshot.version <= (lanSessionRef.current?.version ?? 0)) {
          return
        }

        const nextGame = hydrateLanSessionGame(snapshot)
        const nextConnection = {
          sessionId: snapshot.sessionId,
          sessionName: snapshot.sessionName,
          serverUrl: lanSession.serverUrl,
          version: snapshot.version,
        }

        lanSessionRef.current = nextConnection
        setLanSession(nextConnection)
        setLanLobby(snapshot.lobby)
        setGame(nextGame)
        setHistory([])
        saveSavedGame(nextGame)
        saveActiveAdminLaunch({
          sessionId: snapshot.sessionId,
          sessionName: snapshot.sessionName,
          serverUrl: lanSession.serverUrl,
        })
        setLanStatusTone("neutral")
        setLanStatusMessage(
          snapshot.lobby.status === "started"
            ? `Synced ${snapshot.sessionName} (${snapshot.sessionId}).`
            : `Joined ${snapshot.sessionName} (${snapshot.sessionId}). Waiting for every player to ready up.`,
        )
        setAppMode(snapshot.lobby.status === "started" ? "ready" : "lobby")
      },
      onError() {
        setLanStatusTone("error")
        setLanStatusMessage(`Lost live sync to ${lanSession.sessionName}. Waiting to reconnect...`)
      },
      onClosed(event: LanSessionClosedEvent) {
        clearSavedGame()
        clearActiveAdminLaunch()
        clearActiveSessionPlayer(event.sessionId)
        setLanSession(null)
        setLanLobby(null)
        setSelectedPlayerId(null)
        setAppMode("launcher")
        setLanStatusTone("error")
        setLanStatusMessage(event.message)
        window.alert(event.message)
        window.location.replace("/")
      },
    })
  }, [lanSession])

  useEffect(() => {
    if (!hasStarted) {
      return
    }

    const currentUrl = window.location.href
    window.history.pushState({ transportGameGuard: true }, "", currentUrl)

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ""
    }

    function handlePopState() {
      window.history.pushState({ transportGameGuard: true }, "", currentUrl)
      window.alert("Use the in-game controls instead of the browser Back button so you don't lose your game.")
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    window.addEventListener("popstate", handlePopState)

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
      window.removeEventListener("popstate", handlePopState)
    }
  }, [hasStarted])

  const getBlockedLanActionMessage = useCallback((sourceGame: GameState, playerId: string | null) => {
    if (!playerId) {
      return "Pick your player seat in the lobby before playing."
    }

    if (sourceGame.currentPhase === "purchase-equipment") {
      return `It is ${sourceGame.players.find(player => player.id === sourceGame.currentPlayerId)?.name ?? sourceGame.currentPlayerId}'s turn.`
    }

    if (sourceGame.currentPhase === "claim-routes") {
      if (playerId === sourceGame.currentPlayerId) {
        return "Confirm picks before moving on."
      }

      if (hasPlayerCompletedOperations(sourceGame, playerId)) {
        return "You already clicked Next player for Operations."
      }

      if (hasPlayerConfirmedClaimRoutes(sourceGame, playerId)) {
        return "Finish your operations planning before moving on."
      }

      return `Wait for ${sourceGame.players.find(player => player.id === sourceGame.currentPlayerId)?.name ?? sourceGame.currentPlayerId} to finish picking cities.`
    }

    if (sourceGame.currentPhase === "operations") {
      if (hasPlayerCompletedOperations(sourceGame, playerId)) {
        return "You already clicked Next player for Operations."
      }

      return "Confirm your city picks before using Operations."
    }

    if (sourceGame.currentPhase === "bureaucracy") {
      return hasPlayerCompletedBureaucracy(sourceGame, playerId)
        ? "You already clicked Next player for bureaucracy."
        : "Wait for Bureaucracy to unlock."
    }

    return "That action is not available right now."
  }, [])

  const canPlayerWriteLiveGame = useCallback((sourceGame: GameState, playerId: string | null) => {
    if (!playerId) {
      return false
    }

    switch (sourceGame.currentPhase) {
      case "purchase-equipment":
        return playerId === sourceGame.currentPlayerId
      case "claim-routes":
        return playerId === sourceGame.currentPlayerId || canPlayerEditOperations(sourceGame, playerId)
      case "operations":
        return canPlayerEditOperations(sourceGame, playerId)
      case "bureaucracy":
        return Boolean(
          sourceGame.players.find(player => player.id === playerId) &&
          !hasPlayerCompletedBureaucracy(sourceGame, playerId),
        )
    }
  }, [])

  const commitGameMutation = useCallback(
    async <T extends { ok: true; game: GameState }>(
      mutate: (baseGame: GameState, actingPlayerId: string) => T | GameMutationFailure,
    ): Promise<T | GameMutationFailure> => {
      const activeLanSession = lanSessionRef.current
      const actingPlayerId = activeLanSession ? selectedPlayerId : game.currentPlayerId

      if (activeLanSession && !canPlayerWriteLiveGame(game, actingPlayerId)) {
        const message = getBlockedLanActionMessage(game, actingPlayerId)
        setLanStatusTone("error")
        setLanStatusMessage(message)
        return {
          ok: false,
          error: message,
        }
      }

      if (!activeLanSession) {
        const result = mutate(game, actingPlayerId ?? game.currentPlayerId)

        if (result.ok) {
          setHistory(current => [...current, game])
          setGame(result.game)
          saveSavedGame(result.game)
        }

        return result
      }

      let baseGame = game
      let baseVersion = activeLanSession.version

      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!actingPlayerId) {
          return {
            ok: false,
            error: "Pick your player seat in the lobby before playing.",
          }
        }

        const result = mutate(baseGame, actingPlayerId)

        if (!result.ok) {
          return result
        }

        if (result.game === baseGame) {
          return result
        }

        try {
          const snapshot = await pushLanSessionGame(
            activeLanSession.serverUrl,
            activeLanSession.sessionId,
            result.game,
            baseVersion,
          )

          applyLanSnapshot(snapshot, activeLanSession.serverUrl)
          setLanStatusTone("neutral")
          setLanStatusMessage(`Synced ${snapshot.sessionName} (${snapshot.sessionId}).`)
          return result
        } catch (error) {
          if (isLanSessionConflictError(error)) {
            applyLanSnapshot(error.snapshot, activeLanSession.serverUrl)
            baseGame = hydrateLanSessionGame(error.snapshot)
            baseVersion = error.snapshot.version
            await wait(40 * (attempt + 1) + Math.floor(Math.random() * 40))
            continue
          }

          const message = isLegacyGameApiError(error)
            ? "Client/server mismatch. Restart `npm run session-server` and reload this page."
            : `Could not push updates to ${activeLanSession.sessionName}: ${error instanceof Error ? error.message : "unknown error"}`
          setLanStatusTone("error")
          setLanStatusMessage(message)
          return {
            ok: false,
            error: message,
          }
        }
      }

      const message = "Live changes kept colliding. Try that move again."
      setLanStatusTone("error")
      setLanStatusMessage(message)
      return {
        ok: false,
        error: message,
      }
    },
    [applyLanSnapshot, canPlayerWriteLiveGame, game, getBlockedLanActionMessage, selectedPlayerId],
  )

  const applyLobbyUpdate = useCallback(
    async (updates: { isReady?: boolean; playerName?: string; startGame?: boolean }) => {
      const activeLanSession = lanSessionRef.current

      if (!activeLanSession) {
        setLanStatusTone("error")
        setLanStatusMessage("Not connected to a LAN session.")
        return
      }

      setIsUpdatingLobby(true)

      try {
        if (updates.isReady !== undefined) {
          const trimmedLobbyName = playerName.trim()

          if (trimmedLobbyName) {
            savePlayerName(trimmedLobbyName)
          }
        }

        const snapshot = await updateLanLobby(activeLanSession.serverUrl, activeLanSession.sessionId, {
          clientId: lobbyClientId,
          playerId: selectedPlayerId ?? undefined,
          isReady: updates.isReady,
          playerName: updates.playerName,
          startGame: updates.startGame,
        })

        applyLanSnapshot(snapshot, activeLanSession.serverUrl)
      } catch (error) {
        if (isLegacyLobbyApiError(error)) {
          setLanStatusTone("error")
          setLanStatusMessage(
            "Client/server mismatch. Restart `npm run session-server` and reload this page.",
          )
          return
        }

        setLanStatusTone("error")
        setLanStatusMessage(
          error instanceof Error ? error.message : "Could not update the lobby.",
        )
      } finally {
        setIsUpdatingLobby(false)
      }
    },
    [applyLanSnapshot, lobbyClientId, playerName, selectedPlayerId],
  )

  useEffect(() => {
    if (appMode !== "lobby" || !lanSession || selectedPlayerId || isUpdatingLobby) {
      return
    }

    if (autoAssignAttemptedSessionIdRef.current === lanSession.sessionId) {
      return
    }

    autoAssignAttemptedSessionIdRef.current = lanSession.sessionId
    void applyLobbyUpdate({})
  }, [appMode, applyLobbyUpdate, isUpdatingLobby, lanSession, selectedPlayerId])

  const handleUpdateLobby = useCallback(
    async (updates: { isReady?: boolean; playerName?: string; startGame?: boolean }) => {
      await applyLobbyUpdate(updates)
    },
    [applyLobbyUpdate],
  )

  const handleLaunchLanSession = useCallback(async () => {
    setIsLaunchingSession(true)

    try {
      const initialUserDecks = loadUserDecks()
      const snapshot = await createLanSession(defaultSessionServerUrl, {
        sessionName: `Transport Game LAN (${maxPlayers}P)`,
        game: createGameState(usMap, {
          players: createLauncherPlayers(maxPlayers),
          vehicleCards: initialUserDecks.vehicleCards,
          chanceCards: initialUserDecks.chanceCards,
          startingMoney: DEFAULT_STARTING_MONEY,
        }),
      })

      setLanStatusTone("neutral")
      setLanStatusMessage(
        `Created ${snapshot.sessionName}. Open ${buildLanSessionJoinUrl(snapshot.sessionId, defaultSessionServerUrl, normalizedJoinAppUrl)} to join.`,
      )
      setLauncherSessions(current => {
        const nextSessions = current.filter(session => session.sessionId !== snapshot.sessionId)
        return [
          {
            sessionId: snapshot.sessionId,
            sessionName: snapshot.sessionName,
            updatedAt: snapshot.updatedAt,
            lobbyStatus: snapshot.lobby.status,
            playerCount: snapshot.game.players.length,
            readyPlayerCount: snapshot.lobby.players.filter(player => player.isReady).length,
            isActive: true,
          },
          ...nextSessions.map(session => ({
            ...session,
            isActive: false,
          })),
        ]
      })
    } catch (error) {
      setLanStatusTone("error")
      setLanStatusMessage(error instanceof Error ? error.message : "Could not launch the LAN session.")
    } finally {
      setIsLaunchingSession(false)
    }
  }, [defaultSessionServerUrl, maxPlayers, normalizedJoinAppUrl])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    setDeletingSessionId(sessionId)

    try {
      await deleteLanSession(defaultSessionServerUrl, sessionId)
      clearSavedGame()
      clearActiveAdminLaunch()
      clearActiveSessionPlayer(sessionId)
      setLauncherSessions(current => current.filter(session => session.sessionId !== sessionId))
      setLanStatusTone("neutral")
      setLanStatusMessage(`Deleted session ${sessionId}.`)
    } catch (error) {
      setLanStatusTone("error")
      setLanStatusMessage(error instanceof Error ? error.message : `Could not delete session ${sessionId}.`)
    } finally {
      setDeletingSessionId(current => (current === sessionId ? null : current))
    }
  }, [defaultSessionServerUrl])

  const handleCopyJoinLink = useCallback(async (sessionId: string, serverUrl = defaultSessionServerUrl) => {
    const joinUrl = buildLanSessionJoinUrl(sessionId, serverUrl, normalizedJoinAppUrl)

    try {
      await navigator.clipboard.writeText(joinUrl)
      setLanStatusTone("neutral")
      setLanStatusMessage(`Copied ${joinUrl}`)
    } catch {
      setLanStatusTone("error")
      setLanStatusMessage(`Could not copy ${joinUrl}.`)
    }
  }, [defaultSessionServerUrl, normalizedJoinAppUrl])

  const handleClaimRouteAndAdvance = useCallback(
    async (mode: "bus" | "rail" | "air", cityIds: string[], segmentPairs?: Array<[string, string]>) =>
      commitGameMutation(baseGame => {
        const claimResult = claimRoute(baseGame, { mode, cityIds, segmentPairs }, selectedPlayerId ?? baseGame.currentPlayerId)

        if (!claimResult.ok) {
          return claimResult
        }

        const routeLabel = claimResult.routes
          .map(route => {
            const cityA = baseGame.cities.find(city => city.id === route.cityA)?.name ?? route.cityA
            const cityB = baseGame.cities.find(city => city.id === route.cityB)?.name ?? route.cityB

            return `${cityA} - ${cityB}`
          })
          .join(", ")
        const claimedGame = appendActionLog(
          baseGame,
          claimResult.game,
          `claimed a ${mode} route across ${routeLabel}${claimResult.connectionBonus > 0 ? ` and earned ${Math.round(claimResult.connectionBonus).toLocaleString()}` : ""}`,
          selectedPlayerId ?? baseGame.currentPlayerId,
        )

        return {
          ok: true as const,
          game: claimedGame,
          routes: claimResult.routes,
          cost: claimResult.cost,
          connectionBonus: claimResult.connectionBonus,
          newCityIds: claimResult.newCityIds,
          nextPhase: claimedGame.currentPhase,
          nextPlayerName:
            claimedGame.players.find(player => player.id === claimedGame.currentPlayerId)?.name ??
            claimedGame.currentPlayerId,
          advancedPhase: false,
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleDrawCityOffer = useCallback(
    async (region: NonNullable<GameState["activeCityOffer"]>["region"]) =>
      commitGameMutation(baseGame => {
        const result = drawCityOffer(baseGame, region)

        if (!result.ok) {
          return result
        }

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `drew ${result.cityIds.length} city cards from the ${region} deck`,
            selectedPlayerId ?? baseGame.currentPlayerId,
          ),
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleAdvanceTurn = useCallback(
    async () =>
      commitGameMutation(baseGame => {
        const actingPlayerId = selectedPlayerId ?? baseGame.currentPlayerId

        if (baseGame.currentPhase === "claim-routes" && actingPlayerId === baseGame.currentPlayerId) {
          const result = confirmClaimPicks(baseGame)

          if (!result.ok) {
            return result
          }

          const nextGame = appendActionLog(
            baseGame,
            result.game,
            result.advancedPhase
              ? "confirmed city picks and opened Operations for every player"
              : `confirmed city picks; ${result.game.players.find(player => player.id === result.game.currentPlayerId)?.name ?? result.game.currentPlayerId} is selecting cities`,
            actingPlayerId,
          )

          return {
            ok: true as const,
            game: nextGame,
          }
        }

        if (baseGame.currentPhase === "claim-routes" || baseGame.currentPhase === "operations") {
          const result = markOperationsReady(baseGame, actingPlayerId)

          if (!result.ok) {
            return result
          }

          const nextGame = appendActionLog(
            baseGame,
            result.game,
            result.advancedPhase
              ? "finished operations planning and advanced to bureaucracy"
              : "finished operations planning",
            actingPlayerId,
          )

          return {
            ok: true as const,
            game: nextGame,
          }
        }

        if (baseGame.currentPhase === "bureaucracy") {
          const result = markBureaucracyReady(baseGame, actingPlayerId)

          if (!result.ok) {
            return result
          }

          const nextGame = appendActionLog(
            baseGame,
            result.game,
            result.advancedPhase
              ? "finished bureaucracy review and advanced to purchase equipment"
              : "finished bureaucracy review",
            actingPlayerId,
          )

          return {
            ok: true as const,
            game: nextGame,
          }
        }

        const nextGame = advanceTurn(baseGame)
        const message = getAdvanceTurnLogMessage(baseGame, nextGame)
        const discardMessage = getPhaseDiscardLogMessage(baseGame, nextGame)
        const fullMessage = discardMessage
          ? `${message}; ${discardMessage}`
          : message

        return {
          ok: true as const,
          game: appendActionLog(baseGame, nextGame, fullMessage, actingPlayerId),
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleSetActiveCityOfferKeptCityIds = useCallback(
    async (cityIds: string[]) =>
      commitGameMutation(baseGame => {
        const result = setActiveCityOfferKeptCityIds(baseGame, cityIds)

        return result.ok
          ? {
              ...result,
              game: result.game,
            }
          : result
      }),
    [commitGameMutation],
  )

  const handleBuyResource = useCallback(
    async (resource: PurchasableResource, quantity: number) =>
      commitGameMutation(baseGame => {
        const result = buyResource(baseGame, resource, quantity)

        if (!result.ok) {
          return result
        }

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `bought ${result.quantity} ${resource === "diesel" ? "diesel" : "jet fuel"} for ${Math.round(result.cost).toLocaleString()}`,
            selectedPlayerId ?? baseGame.currentPlayerId,
          ),
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleBuyVehicleCardAndAdvance = useCallback(
    async (cardId: string, quantity: number) =>
      commitGameMutation(baseGame => {
        const purchaseResult = buyVehicleCard(baseGame, cardId, quantity)

        if (!purchaseResult.ok) {
          return purchaseResult
        }

        const actingPlayerId = selectedPlayerId ?? baseGame.currentPlayerId
        const purchasedGame = appendActionLog(
          baseGame,
          purchaseResult.game,
          `purchased ${purchaseResult.quantity} vehicle${purchaseResult.quantity === 1 ? "" : "s"} of #${purchaseResult.card.number} ${purchaseResult.card.name}`,
          actingPlayerId,
        )
        const advancedGame = advanceTurn(purchasedGame)
        const finalGame = appendActionLog(
          purchasedGame,
          advancedGame,
          getAdvanceTurnLogMessage(purchasedGame, advancedGame),
          actingPlayerId,
        )

        return {
          ok: true as const,
          game: finalGame,
          card: purchaseResult.card,
          quantity: purchaseResult.quantity,
          cost: purchaseResult.cost,
          nextPhase: advancedGame.currentPhase,
          nextPlayerName:
            advancedGame.players.find(player => player.id === advancedGame.currentPlayerId)?.name ??
            advancedGame.currentPlayerId,
          advancedPhase: advancedGame.currentPhase !== purchasedGame.currentPhase,
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleSetBureaucracyRouteVehicleCard = useCallback(
    async (routeId: string, vehicleCardId: string | null) =>
      commitGameMutation(baseGame => {
        const actingPlayerId = selectedPlayerId ?? baseGame.currentPlayerId
        const result = setBureaucracyRouteVehicleCard(baseGame, routeId, vehicleCardId, actingPlayerId)

        if (!result.ok) {
          return result
        }

        const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
        const cardName =
          vehicleCardId === null
            ? "no vehicle"
            : baseGame.vehicleCatalog.find(card => card.id === vehicleCardId)?.name ?? vehicleCardId

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `assigned ${cardName} to ${plan?.serviceLabel ?? routeId}`,
            actingPlayerId,
          ),
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleAddBureaucracyServiceSplit = useCallback(
    async (corridorId: string) =>
      commitGameMutation(baseGame => {
        const actingPlayerId = selectedPlayerId ?? baseGame.currentPlayerId
        const result = addBureaucracyServiceSplit(baseGame, corridorId, actingPlayerId)

        return result.ok
          ? {
              ...result,
              game: appendActionLog(
                baseGame,
                result.game,
                `added split service on corridor ${corridorId}`,
                actingPlayerId,
              ),
            }
          : result
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleMoveBureaucracyServiceCity = useCallback(
    async (corridorId: string, cityId: string, routeId: string) =>
      commitGameMutation(baseGame => {
        const actingPlayerId = selectedPlayerId ?? baseGame.currentPlayerId
        const result = moveBureaucracyServiceCity(baseGame, corridorId, cityId, routeId, actingPlayerId)

        if (!result.ok) {
          return result
        }

        const cityName = baseGame.cities.find(city => city.id === cityId)?.name ?? cityId
        const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `moved ${cityName} into ${plan?.serviceLabel ?? routeId}`,
            actingPlayerId,
          ),
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleDeleteBureaucracyServicePod = useCallback(
    async (corridorId: string, routeId: string) =>
      commitGameMutation(baseGame => {
        const actingPlayerId = selectedPlayerId ?? baseGame.currentPlayerId
        const result = deleteBureaucracyServicePod(baseGame, corridorId, routeId, actingPlayerId)

        if (!result.ok) {
          return result
        }

        const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
        const movedCitiesLabel =
          result.cityIds.length === 0
            ? "deleted an empty route"
            : `deleted ${plan?.serviceLabel ?? "a route"} and moved ${result.cityIds.length} cit${result.cityIds.length === 1 ? "y" : "ies"} to disconnected`

        return {
          ...result,
          game: appendActionLog(baseGame, result.game, movedCitiesLabel, actingPlayerId),
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleUpgradeRailRoute = useCallback(
    async (routeId: string) =>
      commitGameMutation(baseGame => {
        const actingPlayerId = selectedPlayerId ?? baseGame.currentPlayerId
        const result = upgradeRailRoute(baseGame, routeId, actingPlayerId)

        if (!result.ok) {
          return result
        }

        const route = baseGame.routes.find(candidate => candidate.id === routeId)
        const cityA = baseGame.cities.find(city => city.id === route?.cityA)?.name ?? route?.cityA ?? routeId
        const cityB = baseGame.cities.find(city => city.id === route?.cityB)?.name ?? route?.cityB ?? routeId

        return {
          ...result,
          game: appendActionLog(
            baseGame,
            result.game,
            `electrified rail route ${cityA} - ${cityB}`,
            actingPlayerId,
          ),
        }
      }),
    [commitGameMutation, selectedPlayerId],
  )

  const handleUndo = useCallback(() => {
    if (lanSessionRef.current) {
      return
    }

    setHistory(current => {
      const previousGame = current[current.length - 1]

      if (!previousGame) {
        return current
      }

      setGame(previousGame)
      saveSavedGame(previousGame)
      return current.slice(0, -1)
    })
  }, [])

  const selectedPlayer = selectedPlayerId
    ? game.players.find(player => player.id === selectedPlayerId) ?? null
    : null
  const selectedLobbyPlayer = selectedPlayerId
    ? lanLobby?.players.find(player => player.playerId === selectedPlayerId) ?? null
    : null
  const claimedLobbyPlayers = lanLobby?.players.filter(player => player.claimedBy) ?? []
  const readyLobbyPlayers = claimedLobbyPlayers.filter(player => player.isReady)
  const canStartLobby = claimedLobbyPlayers.length > 0 && claimedLobbyPlayers.every(player => player.isReady)
  const currentTurnPlayer = game.players.find(player => player.id === game.currentPlayerId) ?? null
  const isLocalPlayerInteractive = Boolean(selectedPlayerId) && (
    game.currentPhase === "purchase-equipment"
      ? selectedPlayerId === game.currentPlayerId
      : game.currentPhase === "claim-routes"
        ? selectedPlayerId === game.currentPlayerId || canPlayerEditOperations(game, selectedPlayerId)
        : game.currentPhase === "operations"
          ? canPlayerEditOperations(game, selectedPlayerId)
          : game.currentPhase === "bureaucracy"
            ? !hasPlayerCompletedBureaucracy(game, selectedPlayerId)
            : false
  )

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      {appMode !== "ready" && (lanSession || lanStatusMessage) && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 20,
            maxWidth: 360,
            minWidth: 280,
            padding: "12px 14px",
            borderRadius: 14,
            border: `1px solid ${lanStatusTone === "error" ? "#d2a4a4" : "#c7d0c4"}`,
            background: "#ffffff",
            boxShadow: "0 10px 28px rgba(0, 0, 0, 0.12)",
            color: "#223024",
            display: "grid",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            {lanSession ? `LAN session ${lanSession.sessionId}` : "LAN status"}
          </div>
          {lanSession && (
            <div style={{ fontSize: 14 }}>
              {lanSession.sessionName} • undo disabled while connected
            </div>
          )}
          {selectedPlayer && (
            <div style={{ fontSize: 13, color: "#56635a" }}>
              You joined as {selectedPlayer.name}
            </div>
          )}
          {lanStatusMessage && (
            <div style={{ fontSize: 13, color: lanStatusTone === "error" ? "#9b1c1c" : "#56635a" }}>
              {lanStatusMessage}
            </div>
          )}
        </div>
      )}

      {appMode === "launcher" ? (
        <div
          style={{
            minHeight: "100%",
            background: "#f3f6f2",
            padding: 24,
            overflow: "auto",
          }}
        >
          <div
            style={{
              maxWidth: 1080,
              margin: "0 auto",
              display: "grid",
              gap: 20,
            }}
          >
            <div
              style={{
                borderRadius: 18,
                border: "1px solid #d8dfd5",
                background: "#ffffff",
                padding: 24,
                boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
                display: "grid",
                gap: 14,
              }}
            >
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 32, fontWeight: 800, color: "#223024" }}>Transport Game LAN</div>
                <div style={{ color: "#56635a" }}>
                  Start a new game here, then open the join link in any browser on the same network.
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <strong>Max players</strong>
                  <select
                    value={maxPlayers}
                    onChange={event => setMaxPlayers(Number(event.target.value))}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                  >
                    {[1, 2, 3, 4, 5, 6].map(playerCount => (
                      <option key={playerCount} value={playerCount}>
                        {playerCount}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void handleLaunchLanSession()}
                  disabled={isLaunchingSession || launcherServerOnline === false}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    background: isLaunchingSession || launcherServerOnline === false ? "#c7d0c4" : "#223024",
                    color: "#ffffff",
                    cursor: isLaunchingSession || launcherServerOnline === false ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  {isLaunchingSession ? "Launching..." : "Launch LAN game"}
                </button>
              </div>
              <label style={{ display: "grid", gap: 6 }}>
                <strong>Share app URL</strong>
                <input
                  type="text"
                  value={joinAppUrl}
                  onChange={event => handleJoinAppUrlChange(event.target.value)}
                  placeholder="http://192.168.1.42:5173"
                  style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                />
              </label>
              {!hasValidJoinAppUrl && (
                <div style={{ color: "#9b1c1c", fontSize: 13 }}>
                  Enter a full LAN address like http://192.168.1.42:5173.
                </div>
              )}
              <div style={{ color: "#56635a", fontSize: 13 }}>
                Use this machine&apos;s LAN address so other computers can open the copied join link.
              </div>
              <div style={{ color: launcherServerOnline === false ? "#9b1c1c" : "#56635a", fontSize: 14 }}>
                Session server: {defaultSessionServerUrl} {launcherServerOnline === false ? "offline" : launcherServerOnline ? "online" : "checking..."}
              </div>
            </div>

            <div
              style={{
                borderRadius: 18,
                border: "1px solid #d8dfd5",
                background: "#ffffff",
                padding: 24,
                boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
                display: "grid",
                gap: 14,
              }}
            >
              <div style={{ fontSize: 24, fontWeight: 800, color: "#223024" }}>Existing LAN games</div>
              {launcherSessions.length === 0 ? (
                <div style={{ color: "#56635a" }}>No LAN games are currently running.</div>
              ) : (
                <div style={{ display: "grid", gap: 12 }}>
                  {launcherSessions.map(session => {
                    const joinUrl = buildLanSessionJoinUrl(session.sessionId, defaultSessionServerUrl, normalizedJoinAppUrl)

                    return (
                      <div
                        key={session.sessionId}
                        style={{
                          border: "1px solid #d8dfd5",
                          borderRadius: 12,
                          padding: 16,
                          display: "grid",
                          gap: 10,
                          background: session.isActive ? "#f7fbf6" : "#fbfcfb",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                          <div style={{ display: "grid", gap: 4 }}>
                            <div style={{ fontSize: 18, fontWeight: 800, color: "#223024" }}>
                              {session.sessionName} {session.isActive ? "• Active" : ""}
                            </div>
                            <div style={{ color: "#56635a", fontSize: 14 }}>
                              {session.playerCount} players • {session.readyPlayerCount} ready • {session.lobbyStatus}
                            </div>
                            <div style={{ color: "#56635a", fontSize: 13 }}>{joinUrl}</div>
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <a
                              href={joinUrl}
                              style={{
                                padding: "10px 16px",
                                borderRadius: 999,
                                border: "1px solid #223024",
                                background: "#223024",
                                color: "#ffffff",
                                textDecoration: "none",
                                fontWeight: 700,
                              }}
                            >
                              Open game
                            </a>
                            <button
                              type="button"
                              onClick={() => void handleCopyJoinLink(session.sessionId)}
                              style={{
                                padding: "10px 16px",
                                borderRadius: 999,
                                border: "1px solid #c7d0c4",
                                background: "#ffffff",
                                cursor: "pointer",
                                fontWeight: 700,
                              }}
                            >
                              Copy link
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteSession(session.sessionId)}
                              disabled={deletingSessionId === session.sessionId}
                              style={{
                                padding: "10px 16px",
                                borderRadius: 999,
                                border: "1px solid #b43b3b",
                                background: deletingSessionId === session.sessionId ? "#e8c4c4" : "#ffffff",
                                color: "#9b1c1c",
                                cursor: deletingSessionId === session.sessionId ? "not-allowed" : "pointer",
                                fontWeight: 700,
                              }}
                            >
                              {deletingSessionId === session.sessionId ? "Deleting..." : "Delete"}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : appMode === "joining" ? (
        <div
          style={{
            height: "100%",
            display: "grid",
            placeItems: "center",
            background: "#f3f6f2",
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 420,
              width: "100%",
              borderRadius: 18,
              border: "1px solid #d8dfd5",
              background: "#ffffff",
              padding: 24,
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
              display: "grid",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 28, fontWeight: 800, color: "#223024" }}>Joining LAN session</div>
            <div style={{ color: "#56635a" }}>
              {requestedLanSession
                ? `Loading session ${requestedLanSession.sessionId} from ${requestedLanSession.serverUrl}.`
                : lanStatusMessage}
            </div>
          </div>
        </div>
      ) : appMode === "waiting" ? (
        <div
          style={{
            height: "100%",
            display: "grid",
            placeItems: "center",
            background: "#f3f6f2",
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 520,
              width: "100%",
              borderRadius: 18,
              border: "1px solid #d8dfd5",
              background: "#ffffff",
              padding: 24,
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 28, fontWeight: 800, color: "#223024" }}>Game unavailable</div>
            <div style={{ color: "#56635a" }}>
              This LAN game could not be reached. It may have been deleted or the session server may be offline.
            </div>
            <div style={{ color: "#56635a", fontSize: 14 }}>{lanStatusMessage}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <a
                href="/"
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  border: "1px solid #223024",
                  background: "#223024",
                  color: "#ffffff",
                  textDecoration: "none",
                  fontWeight: 700,
                }}
              >
                Back to launcher
              </a>
            </div>
          </div>
        </div>
      ) : appMode === "lobby" ? (
        <div
          style={{
            height: "100%",
            display: "grid",
            placeItems: "center",
            background: "#f3f6f2",
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 520,
              width: "100%",
              borderRadius: 18,
              border: "1px solid #d8dfd5",
              background: "#ffffff",
              padding: 24,
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
              display: "grid",
              gap: 14,
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#223024" }}>Waiting in lobby</div>
              <div style={{ color: "#56635a" }}>
                You will be assigned the next open slot automatically. Enter your name, click Ready, then start once every filled seat is ready.
              </div>
            </div>
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 10,
                padding: "12px 14px",
                background: "#fbfcfb",
                display: "grid",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 14, color: "#56635a", fontWeight: 700 }}>Assigned slot</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#223024" }}>
                {selectedPlayer ? `Seat ${selectedPlayer.id.replace(/^p/i, "")}` : "Assigning..."}
              </div>
              <div style={{ color: "#56635a", fontSize: 14 }}>
                {lanLobby ? `${readyLobbyPlayers.length} of ${claimedLobbyPlayers.length} filled seats ready.` : ""}
              </div>
            </div>
            {lanSession && (
              <div
                style={{
                  border: "1px solid #d8dfd5",
                  borderRadius: 10,
                  padding: "12px 14px",
                  background: "#fbfcfb",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 14, color: "#56635a", fontWeight: 700 }}>Shareable join link</div>
                <input
                  type="text"
                  readOnly
                  value={buildLanSessionJoinUrl(lanSession.sessionId, lanSession.serverUrl, normalizedJoinAppUrl)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid #c7d0c4",
                    fontSize: 14,
                    color: "#324236",
                    background: "#ffffff",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => void handleCopyJoinLink(lanSession.sessionId, lanSession.serverUrl)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: "1px solid #86a889",
                      background: "#f7faf6",
                      color: "#1f5f2c",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    Copy link
                  </button>
                </div>
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 10,
              }}
            >
              {game.players.map(player => {
                const lobbyPlayer = lanLobby?.players.find(candidate => candidate.playerId === player.id) ?? null
                const isFilled = Boolean(lobbyPlayer?.claimedBy)
                const isReady = Boolean(lobbyPlayer?.isReady)
                const seatLabel = `Seat ${player.id.replace(/^p/i, "")}`
                const statusLabel = isReady ? "Ready" : isFilled ? "Filled" : "Waiting"
                const accentColor = isReady ? "#1f5f2c" : isFilled ? "#8a5a00" : "#56635a"
                const borderColor = isReady ? "#98c7a4" : isFilled ? "#d7c08a" : "#d8dfd5"
                const background = isReady ? "#f3fbf4" : isFilled ? "#fff9ef" : "#fbfcfb"

                return (
                  <div
                    key={player.id}
                    style={{
                      border: `1px solid ${borderColor}`,
                      borderRadius: 12,
                      padding: 12,
                      background,
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#56635a", fontWeight: 700 }}>{seatLabel}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "#223024" }}>
                      {isFilled ? player.name : "Waiting"}
                    </div>
                    <div style={{ fontSize: 13, color: accentColor, fontWeight: 700 }}>{statusLabel}</div>
                  </div>
                )
              })}
            </div>
            <label style={{ display: "grid", gap: 6 }}>
              <strong>Player name</strong>
              <input
                type="text"
                value={playerName}
                onChange={event => setPlayerName(event.target.value)}
                placeholder="Enter your name"
                disabled={!selectedPlayerId || isUpdatingLobby}
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() =>
                  void handleUpdateLobby({
                    isReady: !(selectedLobbyPlayer?.isReady ?? false),
                    playerName: playerName.trim() || undefined,
                  })
                }
                disabled={
                  !selectedPlayerId ||
                  isUpdatingLobby ||
                  (!(selectedLobbyPlayer?.isReady ?? false) && playerName.trim().length === 0)
                }
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  border: "1px solid #223024",
                  background:
                    !selectedPlayerId ||
                    isUpdatingLobby ||
                    (!(selectedLobbyPlayer?.isReady ?? false) && playerName.trim().length === 0)
                      ? "#c7d0c4"
                      : "#223024",
                  color: "#ffffff",
                  cursor:
                    !selectedPlayerId ||
                    isUpdatingLobby ||
                    (!(selectedLobbyPlayer?.isReady ?? false) && playerName.trim().length === 0)
                      ? "not-allowed"
                      : "pointer",
                  fontWeight: 700,
                }}
              >
                {selectedLobbyPlayer?.isReady ? "Not ready" : "Ready"}
              </button>
              <button
                type="button"
                onClick={() => void handleUpdateLobby({ startGame: true })}
                disabled={!selectedPlayerId || !canStartLobby || isUpdatingLobby}
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  border: "1px solid #1f5f2c",
                  background: !selectedPlayerId || !canStartLobby || isUpdatingLobby ? "#c7d0c4" : "#1f5f2c",
                  color: "#ffffff",
                  cursor: !selectedPlayerId || !canStartLobby || isUpdatingLobby ? "not-allowed" : "pointer",
                  fontWeight: 700,
                }}
              >
                Start game
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div
            style={{
              pointerEvents:
                isLocalPlayerInteractive || lanSession === null || isPeriodSummaryVisible ? "auto" : "none",
            }}
          >
            <Board
              game={game}
              viewingPlayerId={selectedPlayerId}
              onPeriodSummaryVisibilityChange={setIsPeriodSummaryVisible}
              lanSessionStatus={
                lanSession
                  ? {
                      sessionId: lanSession.sessionId,
                      sessionName: lanSession.sessionName,
                      playerName: selectedPlayer?.name ?? null,
                      statusMessage: lanStatusMessage,
                      statusTone: lanStatusTone,
                    }
                  : null
              }
              onClaimRoute={handleClaimRouteAndAdvance}
              onDrawCityOffer={handleDrawCityOffer}
              onSetActiveCityOfferKeptCityIds={handleSetActiveCityOfferKeptCityIds}
              onBuyResource={handleBuyResource}
              onBuyVehicleCard={handleBuyVehicleCardAndAdvance}
              onUpgradeRailRoute={handleUpgradeRailRoute}
              onSetBureaucracyRouteVehicleCard={handleSetBureaucracyRouteVehicleCard}
              onAddBureaucracyServiceSplit={handleAddBureaucracyServiceSplit}
              onMoveBureaucracyServiceCity={handleMoveBureaucracyServiceCity}
              onDeleteBureaucracyServicePod={handleDeleteBureaucracyServicePod}
              onAdvanceTurn={handleAdvanceTurn}
              onUndo={handleUndo}
              canUndo={history.length > 0 && lanSession === null}
            />
          </div>
          {lanSession && !isLocalPlayerInteractive && !isPeriodSummaryVisible && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                background: "rgba(243, 246, 242, 0.2)",
                pointerEvents: "none",
                zIndex: 1,
              }}
            >
              <div
                style={{
                  borderRadius: 18,
                  border: "1px solid #d8dfd5",
                  background: "rgba(255, 255, 255, 0.95)",
                  padding: "18px 22px",
                  boxShadow: "0 10px 28px rgba(0, 0, 0, 0.12)",
                  display: "grid",
                  gap: 4,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 800, color: "#223024" }}>
                  {selectedPlayer
                    ? game.currentPhase === "claim-routes" && hasPlayerConfirmedClaimRoutes(game, selectedPlayerId)
                      ? "Operations locked in"
                      : `Waiting for ${currentTurnPlayer?.name ?? game.currentPlayerId}`
                    : "Viewing live game"}
                </div>
                <div style={{ color: "#56635a", fontSize: 14 }}>
                  {selectedPlayer
                    ? game.currentPhase === "claim-routes" && hasPlayerConfirmedClaimRoutes(game, selectedPlayerId)
                      ? hasPlayerCompletedOperations(game, selectedPlayerId)
                        ? "You already clicked Next player for Operations."
                        : "Your operations panel stays open while the next player picks cities."
                      : game.currentPhase === "bureaucracy" && hasPlayerCompletedBureaucracy(game, selectedPlayerId)
                        ? "You already clicked Next player for Bureaucracy."
                        : `You joined as ${selectedPlayer.name}.`
                    : "Reload from the lobby browser if you want an assigned seat."}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
