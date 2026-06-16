import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { loadUserDecks } from "./data/deckData"
import {
  clearPendingLocalLaunch,
  clearSavedGame,
  getLobbyClientId,
  clearActiveAdminLaunch,
  clearActiveSessionPlayer,
  loadJoinAppUrl,
  loadSavedGame,
  loadPendingLocalLaunch,
  loadActiveSessionPlayer,
  loadPlayerName,
  saveActiveAdminLaunch,
  saveActiveSessionPlayer,
  saveJoinAppUrl,
  saveSavedGame,
  savePlayerName,
} from "./data/gameStorage"
import { usMap } from "./data/maps/usMap"
import { usOutline } from "./data/maps/usOutline"
import { latLngToWorld, WORLD_WIDTH, WORLD_HEIGHT } from "./engine/projection"
import { createDefaultSetupPlayers } from "./gameSetup/defaultPlayers"
import {
  addBureaucracyServiceSplit,
  advanceTurn,
  buyVehicleCard,
  canPlayerEditOperations,
  canPlayerPickCities,
  canPlayerStartPhaseByPipeline,
  claimRoute,
  confirmAddCityPicks,
  deleteBureaucracyServicePod,
  drawCityOffer,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedOperations,
  hasPlayerCompletedAddCity,
  hasPlayerCompletedPurchaseEquipment,
  markBureaucracyReady,
  markOperationsReady,
  moveBureaucracyServiceCity,
  setActiveCityOfferKeptCityIds,
  setBureaucracyRouteVehicleCard,
  upgradeRailRoute,
} from "./engine/actions"
import { getPendingBotPlayerId } from "./bots/actions"
import {
  BOT_PRESETS,
  type BotPresetId,
  fetchManagedBotPresetWeightOverrides,
} from "./bots/presets"
import { findPlayerBureaucracyPlan } from "./engine/bureaucracy"
import {
  createGameState,
  DEFAULT_STARTING_MONEY,
} from "./engine/createGameState"
import type { GameState } from "./engine/types"
import type { GameAction } from "./engine/gameActions"
import { MAX_SETUP_PLAYERS } from "./gameSetup/defaultPlayers"
import {
  appendActionLog,
  createSetupPlayers,
  getAdvanceTurnLogMessage,
  getDefaultLocalViewingPlayerId,
  getNextLocalViewingPlayerId,
  getPhaseDiscardLogMessage,
  runBotTurns,
} from "./game/gameHelpers"
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
  isLocalJoinAppUrl,
  listLanSessions,
  normalizeJoinAppUrl,
  postLanSessionAction,
  subscribeToLanSession,
  toggleLanLobbyBotSeat,
  type LanSessionClosedEvent,
  updateLanLobby,
  type LanSessionLobby,
  type SessionServerHealth,
  type LanSessionSummary,
  type LanSessionSnapshot,
} from "./network/sessionSync"
import Board from "./ui/Board"

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

type GameMutationFailure = {
  ok: false
  error: string
}

const REGION_FILL_MAP: Record<string, string> = {
  Pacific: "#4d9de0", Mountain: "#8a6dd3", South: "#e27d60",
  Southeast: "#4fb286", Midwest: "#d8a031", Northeast: "#d35d9e",
}
const REGION_BASE_R: Record<string, number> = {
  Pacific: 36, Mountain: 38, South: 28, Southeast: 28, Midwest: 30, Northeast: 26,
}
const REGION_ANCHORS_APP = [
  { region: "Pacific", lat: 45.8, lng: -121.3, r: 72 }, { region: "Pacific", lat: 40.8, lng: -121.2, r: 76 },
  { region: "Pacific", lat: 35.8, lng: -119.8, r: 72 }, { region: "Pacific", lat: 39.3, lng: -117.2, r: 64 },
  { region: "Mountain", lat: 45.2, lng: -111.5, r: 78 }, { region: "Mountain", lat: 40.7, lng: -111.2, r: 82 },
  { region: "Mountain", lat: 35.8, lng: -108.8, r: 78 }, { region: "Mountain", lat: 47.1, lng: -108.2, r: 64 },
  { region: "Mountain", lat: 46.7, lng: -101.6, r: 62 }, { region: "Mountain", lat: 44.8, lng: -101.8, r: 66 },
  { region: "Mountain", lat: 41.1, lng: -100.3, r: 60 },
]
const appOutlinePath = usOutline
  .map(([lng, lat]) => { const p = latLngToWorld({ lng, lat }); return `${p.x},${p.y}` })
  .join(" L ")
const appRegionBlobs = [
  ...usMap.cities.map(city => {
    const region = city.region?.[0]
    if (!region || !REGION_FILL_MAP[region]) return null
    const { x, y } = latLngToWorld(city)
    return { region, x, y, r: (REGION_BASE_R[region] ?? 30) + city.size * 8 }
  }).filter((b): b is NonNullable<typeof b> => b !== null),
  ...REGION_ANCHORS_APP.map(a => { const { x, y } = latLngToWorld(a); return { ...a, x, y } }),
]

function MapBackdrop() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, background: "#e8efe6" }}>
      <svg
        viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        style={{ display: "block" }}
      >
        <defs>
          <clipPath id="app-map-clip">
            <path d={`M ${appOutlinePath} Z`} />
          </clipPath>
          <filter id="app-region-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="20" />
          </filter>
        </defs>
        <path d={`M ${appOutlinePath} Z`} fill="#f4f1e8" stroke="#c9c2b3" strokeWidth={2} opacity={0.9} />
        <g clipPath="url(#app-map-clip)" filter="url(#app-region-blur)">
          {appRegionBlobs.map((blob, i) => (
            <circle key={i} cx={blob.x} cy={blob.y} r={blob.r} fill={REGION_FILL_MAP[blob.region]} opacity={0.22} />
          ))}
        </g>
      </svg>
    </div>
  )
}

export default function App() {
  const lobbyClientId = getLobbyClientId()
  const requestedLanSession = getRequestedLanSession()
  const requestedLanSessionId = requestedLanSession?.sessionId ?? null
  const requestedLanSessionServerUrl = requestedLanSession?.serverUrl ?? null
  const isLauncherRoute = requestedLanSessionId === null
  const pendingLocalLaunch = requestedLanSession ? null : loadPendingLocalLaunch()
  const pendingLocalGame = requestedLanSession ? null : (pendingLocalLaunch ? loadSavedGame() : null)
  const defaultSessionServerUrl = getDefaultSessionServerUrl()
  const [joinAppUrl, setJoinAppUrl] = useState(() => loadJoinAppUrl() ?? getDefaultJoinAppUrl())
  const [game, setGame] = useState(() => pendingLocalGame ?? createPlaceholderGame())
  const [history, setHistory] = useState<typeof game[]>([])
  const [lanSession, setLanSession] = useState<LanSessionConnection | null>(null)
  const [lanLobby, setLanLobby] = useState<LanSessionLobby | null>(null)
  const lanSessionRef = useRef<LanSessionConnection | null>(null)
  const autoAssignAttemptedSessionIdRef = useRef<string | null>(null)
  const [lanStatusMessage, setLanStatusMessage] = useState(() => {
    if (requestedLanSessionId) {
      return `Connecting to session ${requestedLanSessionId}...`
    }

    if (pendingLocalLaunch && pendingLocalGame) {
      return "Resumed a local bot-only game."
    }

    return "Create a local or LAN game, or join an existing session."
  })
  const [lanStatusTone, setLanStatusTone] = useState<"neutral" | "error">("neutral")
  const [appMode, setAppMode] = useState<AppMode>(() =>
    requestedLanSession ? "joining" : pendingLocalLaunch && pendingLocalGame ? "ready" : "launcher",
  )
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(
    () => pendingLocalLaunch?.selectedPlayerId ?? null,
  )
  const [lanSeatCount, setLanSeatCount] = useState(4)
  const [playerName, setPlayerName] = useState("")
  const [isUpdatingLobby, setIsUpdatingLobby] = useState(false)
  // Pending bot name edits keyed by playerId — sent on input blur
  const [pendingBotNames, setPendingBotNames] = useState<Record<string, string>>({})
  const [launcherSessions, setLauncherSessions] = useState<LanSessionSummary[]>([])
  const [launcherServerOnline, setLauncherServerOnline] = useState<boolean | null>(null)
  const [isLaunchingSession, setIsLaunchingSession] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [isPeriodSummaryVisible, setIsPeriodSummaryVisible] = useState(false)
  const localBotTurnSignatureRef = useRef<string | null>(null)
  const gameRef = useRef(game)
  const normalizedJoinAppUrl = useMemo(() => {
    try {
      return normalizeJoinAppUrl(joinAppUrl)
    } catch {
      return getDefaultJoinAppUrl()
    }
  }, [joinAppUrl])
  const hasStarted = appMode === "ready"

  useEffect(() => { gameRef.current = game }, [game])

  useEffect(() => {
    document.body.style.overflow = hasStarted ? "hidden" : ""
    return () => { document.body.style.overflow = "" }
  }, [hasStarted])

  useEffect(() => {
    if (!pendingLocalLaunch) {
      return
    }

    clearPendingLocalLaunch()
  }, [pendingLocalLaunch])

  useEffect(() => {
    lanSessionRef.current = lanSession
  }, [lanSession])

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

  // LAN-only: the session server is authoritative, so incoming snapshots replace local UI state.
  // Local hotseat never hydrates from snapshots; it owns the GameState directly in React state/history.
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

        let nextGame = hydrateLanSessionGame(snapshot)

        // Preserve the local player's pending city selection — keep-city-offer is local-only
        // and never sent to the server, so SSE updates would otherwise discard the preview.
        const currentGame = gameRef.current
        if (
          nextGame.activeCityOffer &&
          currentGame.activeCityOffer &&
          nextGame.activeCityOffer.playerId === currentGame.activeCityOffer.playerId &&
          nextGame.activeCityOffer.cityIds.join(",") === currentGame.activeCityOffer.cityIds.join(",") &&
          currentGame.activeCityOffer.keptCityIds.length > 0
        ) {
          nextGame = {
            ...nextGame,
            activeCityOffer: {
              ...nextGame.activeCityOffer,
              keptCityIds: currentGame.activeCityOffer.keptCityIds,
            },
          }
        }
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
    }, lobbyClientId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const player = sourceGame.players.find(entry => entry.id === playerId)

    if (!player) {
      return "That seat is no longer available."
    }

    switch (player.phase) {
      case "purchase-equipment":
        if (!canPlayerStartPhaseByPipeline(sourceGame, playerId, "purchase-equipment")) {
          return "Wait for the previous player to finish purchasing."
        }
        return "Finish your purchase before moving on."
      case "add-city":
        if (!canPlayerPickCities(sourceGame, playerId)) {
          return "Wait for the previous player to finish picking cities before starting yours."
        }
        return "Confirm picks before moving on."
      case "operations":
        return "Finish your operations planning before moving on."
      case "bureaucracy":
        return hasPlayerCompletedBureaucracy(sourceGame, playerId)
          ? "You already clicked Next player for bureaucracy."
          : "Review bureaucracy before moving on."
    }
  }, [])

  const canPlayerWriteLiveGame = useCallback((sourceGame: GameState, playerId: string | null) => {
    if (!playerId) return false
    const player = sourceGame.players.find(p => p.id === playerId)
    if (!player) return false

    switch (player.phase) {
      case "purchase-equipment":
        return canPlayerStartPhaseByPipeline(sourceGame, playerId, "purchase-equipment")
      case "add-city":
        return canPlayerPickCities(sourceGame, playerId) || canPlayerEditOperations(sourceGame, playerId)
      case "operations":
        return canPlayerEditOperations(sourceGame, playerId)
      case "bureaucracy":
        return !hasPlayerCompletedBureaucracy(sourceGame, playerId)
    }
  }, [])

  // Shared gameplay handlers all funnel through this helper.
  // Local mode applies the mutation directly to React state/history.
  // LAN mode sends the action to the session server (which is authoritative),
  // and computes the mutation locally to get rich return values for UI feedback.
  // The authoritative state update arrives via SSE.
  const commitGameMutation = useCallback(
    async <T extends { ok: true; game: GameState }>(
      mutate: (baseGame: GameState, actingPlayerId: string) => T | GameMutationFailure,
      action: GameAction,
    ): Promise<T | GameMutationFailure> => {
      const activeLanSession = lanSessionRef.current
      const actingPlayerId = activeLanSession
        ? selectedPlayerId
        : getDefaultLocalViewingPlayerId(game) ?? game.currentPlayerId

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
          setSelectedPlayerId(currentSelectedPlayerId =>
            getNextLocalViewingPlayerId(result.game, currentSelectedPlayerId),
          )
          saveSavedGame(result.game)
        }

        return result
      }

      if (!actingPlayerId) {
        return {
          ok: false,
          error: "Pick your player seat in the lobby before playing.",
        }
      }

      // Compute result locally for rich UI feedback; state arrives authoritatively via SSE.
      const result = mutate(game, actingPlayerId)

      if (!result.ok) {
        return result
      }

      if (result.game === game) {
        return result
      }

      try {
        await postLanSessionAction(
          activeLanSession.serverUrl,
          activeLanSession.sessionId,
          actingPlayerId,
          action,
        )
        setLanStatusTone("neutral")
        setLanStatusMessage(`Synced ${activeLanSession.sessionName}.`)
      } catch (error) {
        const message = isLegacyGameApiError(error)
          ? "Client/server mismatch. Restart `npm run session-server` and reload this page."
          : `Could not push to ${activeLanSession.sessionName}: ${error instanceof Error ? error.message : "unknown error"}`
        setLanStatusTone("error")
        setLanStatusMessage(message)
        return {
          ok: false,
          error: message,
        }
      }

      return result
    },
    [canPlayerWriteLiveGame, game, getBlockedLanActionMessage, selectedPlayerId],
  )
  // Local hotseat derives the acting seat from the current overlap state.
  // LAN uses the seat the client claimed in the lobby, even when another player is the turn owner.
  const resolveActingPlayerId = useCallback(
    (baseGame: GameState) =>
      lanSession
        ? selectedPlayerId ?? baseGame.currentPlayerId
        : getDefaultLocalViewingPlayerId(baseGame) ?? baseGame.currentPlayerId,
    [lanSession, selectedPlayerId],
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

  const handleClaimSeat = useCallback(
    async (playerId: string) => {
      const activeLanSession = lanSessionRef.current

      if (!activeLanSession) {
        return
      }

      setIsUpdatingLobby(true)

      try {
        const snapshot = await updateLanLobby(activeLanSession.serverUrl, activeLanSession.sessionId, {
          clientId: lobbyClientId,
          playerId,
        })
        applyLanSnapshot(snapshot, activeLanSession.serverUrl)
      } catch (error) {
        setLanStatusTone("error")
        setLanStatusMessage(
          error instanceof Error ? error.message : "Could not claim that seat.",
        )
      } finally {
        setIsUpdatingLobby(false)
      }
    },
    [applyLanSnapshot, lobbyClientId],
  )

  const handleCreateAndJoinSession = useCallback(async () => {
    setIsLaunchingSession(true)

    try {
      const players = createSetupPlayers(lanSeatCount)
      const initialUserDecks = loadUserDecks()
      const managedBotPresetWeights = await fetchManagedBotPresetWeightOverrides(players.length)
      const snapshot = await createLanSession(defaultSessionServerUrl, {
        sessionName: `Transport Game (${players.length} seats)`,
        game: createGameState(usMap, {
          players,
          vehicleCards: initialUserDecks.vehicleCards,
          chanceCards: initialUserDecks.chanceCards,
          startingMoney: DEFAULT_STARTING_MONEY,
          botPresetWeightsById: managedBotPresetWeights,
        }),
      })

      setLanStatusTone("neutral")
      setLanStatusMessage(
        `Created ${snapshot.sessionName}. Share the join link to invite others.`,
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
      applyLanSnapshot(snapshot, defaultSessionServerUrl)
    } catch (error) {
      setLanStatusTone("error")
      setLanStatusMessage(error instanceof Error ? error.message : "Could not launch the LAN session.")
    } finally {
      setIsLaunchingSession(false)
    }
  }, [applyLanSnapshot, defaultSessionServerUrl, lanSeatCount])

  const handleToggleLobbyBotSeat = useCallback(async (playerId: string, isBot: boolean) => {
    const activeLanSession = lanSessionRef.current
    if (!activeLanSession) return
    const seatNum = playerId.replace(/^p/i, "")
    const defaultBotName = `Bot ${seatNum}`
    try {
      const snapshot = await toggleLanLobbyBotSeat(
        activeLanSession.serverUrl,
        activeLanSession.sessionId,
        lobbyClientId,
        playerId,
        isBot,
        isBot ? "bot-avg" : null,
        isBot ? defaultBotName : undefined,
      )
      applyLanSnapshot(snapshot, activeLanSession.serverUrl)
    } catch (error) {
      setLanStatusTone("error")
      setLanStatusMessage(error instanceof Error ? error.message : "Could not update seat.")
    }
  }, [applyLanSnapshot, lobbyClientId])

  const handleUpdateLobbyBotConfig = useCallback(async (playerId: string, botPreset: BotPresetId, botName: string) => {
    const activeLanSession = lanSessionRef.current
    if (!activeLanSession) return
    try {
      const snapshot = await toggleLanLobbyBotSeat(
        activeLanSession.serverUrl,
        activeLanSession.sessionId,
        lobbyClientId,
        playerId,
        true,
        botPreset,
        botName.trim() || undefined,
      )
      applyLanSnapshot(snapshot, activeLanSession.serverUrl)
    } catch (error) {
      setLanStatusTone("error")
      setLanStatusMessage(error instanceof Error ? error.message : "Could not update bot config.")
    }
  }, [applyLanSnapshot, lobbyClientId])

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
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame)
          const claimResult = claimRoute(baseGame, { mode, cityIds, segmentPairs }, actingPlayerId)

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
            actingPlayerId,
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
        },
        { type: "claim-route", mode, cityIds, segmentPairs },
      ),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleDrawCityOffer = useCallback(
    async (region: NonNullable<GameState["activeCityOffer"]>["region"]) =>
      commitGameMutation(
        (baseGame, actingPlayerId) => {
          const result = drawCityOffer(baseGame, region, actingPlayerId)

          if (!result.ok) {
            return result
          }

          return {
            ...result,
            game: appendActionLog(
              baseGame,
              result.game,
              `drew ${result.cityIds.length} city cards from the ${region} deck`,
              actingPlayerId,
            ),
          }
        },
        { type: "draw-city-offer", region },
      ),
    [commitGameMutation],
  )

  const handleAdvanceTurn = useCallback(
    async () =>
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame) ?? baseGame.currentPlayerId

          if (actingPlayerId && canPlayerPickCities(baseGame, actingPlayerId)) {
            const result = confirmAddCityPicks(baseGame, actingPlayerId)

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

          if (actingPlayerId && canPlayerEditOperations(baseGame, actingPlayerId)) {
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

          if (
            baseGame.currentPhase === "bureaucracy" ||
            (actingPlayerId &&
              hasPlayerCompletedOperations(baseGame, actingPlayerId) &&
              !hasPlayerCompletedBureaucracy(baseGame, actingPlayerId))
          ) {
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

          const nextGame = advanceTurn(baseGame, actingPlayerId)
          const message = getAdvanceTurnLogMessage(baseGame, nextGame)
          const discardMessage = getPhaseDiscardLogMessage(baseGame, nextGame)
          const fullMessage = discardMessage
            ? `${message}; ${discardMessage}`
            : message

          return {
            ok: true as const,
            game: appendActionLog(baseGame, nextGame, fullMessage, actingPlayerId),
          }
        },
        { type: "advance-turn", keptCityIds: gameRef.current.activeCityOffer?.keptCityIds },
      ),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleSetActiveCityOfferKeptCityIds = useCallback(
    async (cityIds: string[]) => {
      // In LAN mode: apply locally only — city card preview is personal and never broadcast.
      // The confirmed selection is sent to the server as part of the advance-turn action.
      if (lanSessionRef.current) {
        const actingPlayerId = selectedPlayerId
        if (!actingPlayerId) return { ok: false as const, error: "No player selected." }
        const result = setActiveCityOfferKeptCityIds(game, cityIds, actingPlayerId)
        if (result.ok) setGame(result.game)
        return result
      }
      return commitGameMutation(
        (baseGame, actingPlayerId) => {
          const result = setActiveCityOfferKeptCityIds(baseGame, cityIds, actingPlayerId)
          return result.ok ? { ...result, game: result.game } : result
        },
        { type: "keep-city-offer", cityIds },
      )
    },
    [commitGameMutation, game, selectedPlayerId],
  )

  const handleBuyVehicleCardAndAdvance = useCallback(
    async (cardId: string, quantity: number) =>
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame) ?? baseGame.currentPlayerId
          const purchaseResult = buyVehicleCard(baseGame, cardId, quantity, actingPlayerId)

          if (!purchaseResult.ok) {
            return purchaseResult
          }

          const purchasedGame = appendActionLog(
            baseGame,
            purchaseResult.game,
            `purchased ${purchaseResult.quantity} vehicle${purchaseResult.quantity === 1 ? "" : "s"} of #${purchaseResult.card.number} ${purchaseResult.card.name}`,
            actingPlayerId,
          )
          const advancedGame = advanceTurn(purchasedGame, actingPlayerId)
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
        },
        { type: "buy-vehicle", cardId, quantity },
      ),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleSetBureaucracyRouteVehicleCard = useCallback(
    async (routeId: string, vehicleCardId: string | null) =>
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame)
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
        },
        { type: "set-route-vehicle", routeId, vehicleCardId },
      ),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleAddBureaucracyServiceSplit = useCallback(
    async (corridorId: string) =>
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame)
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
        },
        { type: "add-service-split", corridorId },
      ),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleMoveBureaucracyServiceCity = useCallback(
    async (
      corridorId: string,
      cityId: string,
      routeId: string,
      sourceRouteId: string | null = null,
    ) =>
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame)
          const result = moveBureaucracyServiceCity(
            baseGame,
            corridorId,
            cityId,
            routeId,
            sourceRouteId,
            actingPlayerId,
          )

          if (!result.ok) {
            return result
          }

          const cityName = baseGame.cities.find(city => city.id === cityId)?.name ?? cityId
          const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
          const sourcePlan =
            sourceRouteId === null
              ? null
              : findPlayerBureaucracyPlan(baseGame, actingPlayerId, sourceRouteId)
          const actionLabel =
            plan?.isDisconnected
              ? `removed ${cityName} from ${sourcePlan?.serviceLabel ?? "that route"}`
              : `copied ${cityName} into ${plan?.serviceLabel ?? routeId}`

          return {
            ...result,
            game: appendActionLog(
              baseGame,
              result.game,
              actionLabel,
              actingPlayerId,
            ),
          }
        },
        { type: "move-service-city", corridorId, cityId, routeId, sourceRouteId },
      ),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleDeleteBureaucracyServicePod = useCallback(
    async (corridorId: string, routeId: string) =>
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame)
          const result = deleteBureaucracyServicePod(baseGame, corridorId, routeId, actingPlayerId)

          if (!result.ok) {
            return result
          }

          const plan = findPlayerBureaucracyPlan(baseGame, actingPlayerId, routeId)
          const movedCitiesLabel =
            result.cityIds.length === 0
              ? "deleted an empty route"
              : result.disconnectedCityIds.length === 0
                ? `deleted ${plan?.serviceLabel ?? "a route"}`
                : `deleted ${plan?.serviceLabel ?? "a route"} and moved ${result.disconnectedCityIds.length} cit${result.disconnectedCityIds.length === 1 ? "y" : "ies"} to disconnected`

          return {
            ...result,
            game: appendActionLog(baseGame, result.game, movedCitiesLabel, actingPlayerId),
          }
        },
        { type: "delete-service-pod", corridorId, routeId },
      ),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleUpgradeRailRoute = useCallback(
    async (routeId: string) =>
      commitGameMutation(
        baseGame => {
          const actingPlayerId = resolveActingPlayerId(baseGame)
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
        },
        { type: "upgrade-rail", routeId },
      ),
    [commitGameMutation, resolveActingPlayerId],
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
      setSelectedPlayerId(currentSelectedPlayerId =>
        getNextLocalViewingPlayerId(previousGame, currentSelectedPlayerId),
      )
      saveSavedGame(previousGame)
      return current.slice(0, -1)
    })
  }, [])

  const selectedPlayer = selectedPlayerId
    ? game.players.find(player => player.id === selectedPlayerId) ?? null
    : null
  const isSpectator = lanSession !== null && appMode === "ready" && selectedPlayerId === null
  // Local hotseat can auto-follow whichever seat should currently be editing.
  // LAN keeps the board pinned to the explicitly claimed seat because each client owns one seat.
  // Spectators follow the current player's perspective.
  const activeViewingPlayerId =
    isSpectator
      ? game.currentPlayerId
      : lanSession || appMode !== "ready"
        ? selectedPlayerId
        : selectedPlayerId ?? getDefaultLocalViewingPlayerId(game)
  const selectedLobbyPlayer = selectedPlayerId
    ? lanLobby?.players.find(player => player.playerId === selectedPlayerId) ?? null
    : null
  const claimedLobbyPlayers = lanLobby?.players.filter(player => player.claimedBy) ?? []
  const readyLobbyPlayers = claimedLobbyPlayers.filter(player => player.isReady)
  const canStartLobby = claimedLobbyPlayers.length > 0 && claimedLobbyPlayers.every(player => player.isReady)
  const currentTurnPlayer = game.players.find(player => player.id === game.currentPlayerId) ?? null
  // In phases where players independently ready up, currentPlayerId may not reflect who's actually
  // blocking — find the first player who hasn't completed the current phase.
  const waitingForPlayer = useMemo(() => {
    if (game.currentPhase === "purchase-equipment") {
      return (
        game.players.find(p => canPlayerPickCities(game, p.id)) ??
        game.players.find(p => canPlayerEditOperations(game, p.id)) ??
        game.players.find(
          p =>
            !hasPlayerCompletedPurchaseEquipment(game, p.id) &&
            canPlayerStartPhaseByPipeline(game, p.id, "purchase-equipment"),
        ) ??
        currentTurnPlayer
      )
    }
    if (game.currentPhase === "operations") {
      return game.players.find(p => canPlayerEditOperations(game, p.id)) ?? currentTurnPlayer
    }
    if (game.currentPhase === "bureaucracy") {
      return game.players.find(p => !hasPlayerCompletedBureaucracy(game, p.id)) ?? currentTurnPlayer
    }
    return currentTurnPlayer
  }, [game, currentTurnPlayer])
  const localBotPlayerIds = useMemo(
    () => new Set(game.players.filter(player => player.isBot).map(player => player.id)),
    [game.players],
  )
  const isLocalPlayerInteractive = !isSpectator && Boolean(activeViewingPlayerId) && (() => {
    if (!activeViewingPlayerId) return false
    const player = game.players.find(p => p.id === activeViewingPlayerId)
    if (!player) return false
    switch (player.phase) {
      case "purchase-equipment":
        return canPlayerStartPhaseByPipeline(game, activeViewingPlayerId, "purchase-equipment")
      case "add-city":
        return canPlayerPickCities(game, activeViewingPlayerId) || canPlayerEditOperations(game, activeViewingPlayerId)
      case "operations":
        return canPlayerEditOperations(game, activeViewingPlayerId)
      case "bureaucracy":
        return !hasPlayerCompletedBureaucracy(game, activeViewingPlayerId)
      default:
        return false
    }
  })()
  const pendingBotPlayerId = useMemo(
    () => getPendingBotPlayerId(game, localBotPlayerIds),
    [game, localBotPlayerIds],
  )
  const isBotOnlyLocalGame =
    appMode === "ready" &&
    lanSession === null &&
    game.players.length > 0 &&
    game.players.every(player => player.isBot)
  const shouldRunLocalBots =
    appMode === "ready" && lanSession === null && pendingBotPlayerId !== null
  const blockingLocalBotPlayerId =
    lanSession === null && (isBotOnlyLocalGame || !isLocalPlayerInteractive) ? pendingBotPlayerId : null
  const isLocalBotTurn = blockingLocalBotPlayerId !== null
  const pendingBotPlayer = pendingBotPlayerId
    ? game.players.find(player => player.id === pendingBotPlayerId) ?? null
    : null

  // Local bots commit directly to local state (saved games / local hotseat).
  // LAN bots run server-side; clients do not manage bot turns for LAN games.
  useEffect(() => {
    if (!shouldRunLocalBots || isPeriodSummaryVisible || !pendingBotPlayerId) {
      localBotTurnSignatureRef.current = null
      return
    }

    const turnSignature = JSON.stringify({
      week: game.currentWeek,
      phase: game.currentPhase,
      currentPlayerId: game.currentPlayerId,
      playerPhases: game.players.map(player => [player.id, player.phase]),
      bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds,
      pendingBotPlayerId,
    })

    if (localBotTurnSignatureRef.current === turnSignature) {
      return
    }

    localBotTurnSignatureRef.current = turnSignature
    const previousGame = game
    const { game: nextGame, hasChanged } = runBotTurns(game, localBotPlayerIds)

    if (!hasChanged || nextGame === previousGame) {
      return
    }

    const commitId = window.setTimeout(() => {
      setHistory(current => [...current, previousGame])
      setGame(nextGame)
      setSelectedPlayerId(currentSelectedPlayerId =>
        getNextLocalViewingPlayerId(nextGame, currentSelectedPlayerId),
      )
      saveSavedGame(nextGame)
    }, 0)

    return () => {
      window.clearTimeout(commitId)
    }
  }, [
    game,
    pendingBotPlayerId,
    isPeriodSummaryVisible,
    localBotPlayerIds,
    shouldRunLocalBots,
  ])


  return (
    <div
      style={
        hasStarted
          ? { position: "fixed", inset: 0, overflow: "hidden" }
          : { position: "relative", minHeight: "100vh", overflowX: "hidden", background: "#f3f6f2" }
      }
    >
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
            minHeight: "100vh",
            padding: 24,
            overflowY: "auto",
            position: "relative",
          }}
        >
          <MapBackdrop />
          <div
            style={{
              maxWidth: 1080,
              margin: "0 auto",
              display: "grid",
              gap: 20,
              position: "relative",
              zIndex: 1,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
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
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#223024" }}>New game</div>
                  <div style={{ color: "#56635a" }}>
                    Create a new game lobby, set up players and bots, then share the join link.
                  </div>
                </div>
                <label style={{ display: "grid", gap: 6, maxWidth: 180 }}>
                  <strong>Seats</strong>
                  <select
                    value={lanSeatCount}
                    onChange={event => setLanSeatCount(Number(event.target.value))}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                  >
                    {Array.from({ length: MAX_SETUP_PLAYERS }, (_, index) => index + 1).map(playerCount => (
                      <option key={playerCount} value={playerCount}>
                        {playerCount}
                      </option>
                    ))}
                  </select>
                </label>
                <div style={{ color: "#56635a", fontSize: 13 }}>
                  Share this machine&apos;s LAN address so others can join via the copied link.
                </div>
                <div style={{ color: launcherServerOnline === false ? "#9b1c1c" : "#56635a", fontSize: 14 }}>
                  Session server: {defaultSessionServerUrl}{" "}
                  {launcherServerOnline === false ? "⚠ offline — run npm run session-server" : launcherServerOnline ? "✓ online" : "checking..."}
                </div>
                <button
                  type="button"
                  onClick={() => void handleCreateAndJoinSession()}
                  disabled={launcherServerOnline === false || isLaunchingSession}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    background: launcherServerOnline === false || isLaunchingSession ? "#c7d0c4" : "#223024",
                    color: "#ffffff",
                    cursor: launcherServerOnline === false || isLaunchingSession ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  {isLaunchingSession ? "Creating..." : "Create game lobby"}
                </button>
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
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: 24,
            position: "relative",
          }}
        >
          <MapBackdrop />
          <div
            style={{
              maxWidth: 520,
              width: "100%",
              borderRadius: 18,
              border: "1px solid #d8dfd5",
              background: "rgba(255,255,255,0.92)",
              backdropFilter: "blur(6px)",
              padding: 24,
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
              display: "grid",
              gap: 14,
              position: "relative",
              zIndex: 1,
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#223024" }}>Waiting in lobby</div>
              <div style={{ color: "#56635a" }}>
                Human players are assigned the next open seat automatically. Bot seats start filled and
                ready, and the game can begin once every filled seat is ready.
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
                {selectedPlayer ? `Seat ${selectedPlayer.id.replace(/^p/i, "")}` : "Spectator"}
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
                const isBotSeat = Boolean(lobbyPlayer?.isBot)
                const seatLabel = `Seat ${player.id.replace(/^p/i, "")}`
                const statusLabel = isBotSeat ? (isReady ? "Bot ready" : "Bot") : isReady ? "Ready" : isFilled ? "Filled" : "Waiting"
                const accentColor = isBotSeat ? "#5c4a8a" : isReady ? "#1f5f2c" : isFilled ? "#8a5a00" : "#56635a"
                const borderColor = isBotSeat ? "#cbb9ec" : isReady ? "#98c7a4" : isFilled ? "#d7c08a" : "#d8dfd5"
                const background = isBotSeat ? "#f8f4ff" : isReady ? "#f3fbf4" : isFilled ? "#fff9ef" : "#fbfcfb"
                const currentBotPreset = (BOT_PRESETS.some(p => p.id === player.botPreset) ? player.botPreset : "bot-avg") as BotPresetId
                const pendingName = pendingBotNames[player.id] ?? player.name

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
                    {!isFilled && lanLobby?.status !== "started" && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#56635a", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={isBotSeat}
                          onChange={event => void handleToggleLobbyBotSeat(player.id, event.target.checked)}
                        />
                        Bot seat
                      </label>
                    )}
                    {isBotSeat && lanLobby?.status !== "started" && (
                      <div style={{ display: "grid", gap: 5, marginTop: 2 }}>
                        <input
                          type="text"
                          value={pendingName}
                          onChange={e => setPendingBotNames(prev => ({ ...prev, [player.id]: e.target.value }))}
                          onBlur={e => {
                            const name = e.target.value.trim()
                            const seatNum = player.id.replace(/^p/i, "")
                            const finalName = name || `Bot ${seatNum}`
                            void handleUpdateLobbyBotConfig(player.id, currentBotPreset, finalName)
                          }}
                          placeholder={`Bot ${player.id.replace(/^p/i, "")}`}
                          style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid #cbb9ec", fontSize: 12, background: "#fff", width: "100%", boxSizing: "border-box" }}
                        />
                        <select
                          value={currentBotPreset}
                          onChange={e => void handleUpdateLobbyBotConfig(player.id, e.target.value as BotPresetId, pendingName)}
                          style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid #cbb9ec", fontSize: 12, background: "#fff", cursor: "pointer" }}
                        >
                          {BOT_PRESETS.map(preset => (
                            <option key={preset.id} value={preset.id}>{preset.label}</option>
                          ))}
                        </select>
                      </div>
                    )}
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
                disabled={!canStartLobby || isUpdatingLobby}
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  border: "1px solid #1f5f2c",
                  background: !canStartLobby || isUpdatingLobby ? "#c7d0c4" : "#1f5f2c",
                  color: "#ffffff",
                  cursor: !canStartLobby || isUpdatingLobby ? "not-allowed" : "pointer",
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
              pointerEvents: lanSession
                ? isLocalPlayerInteractive || isPeriodSummaryVisible || isSpectator ? "auto" : "none"
                : !isLocalBotTurn || isPeriodSummaryVisible ? "auto" : "none",
            }}
          >
            <Board
              game={game}
              viewingPlayerId={activeViewingPlayerId}
              suppressPeriodSummary={isBotOnlyLocalGame}
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
              onBuyVehicleCard={handleBuyVehicleCardAndAdvance}
              onUpgradeRailRoute={handleUpgradeRailRoute}
              onSetBureaucracyRouteVehicleCard={handleSetBureaucracyRouteVehicleCard}
              onAddBureaucracyServiceSplit={handleAddBureaucracyServiceSplit}
              onMoveBureaucracyServiceCity={handleMoveBureaucracyServiceCity}
              onDeleteBureaucracyServicePod={handleDeleteBureaucracyServicePod}
              onAdvanceTurn={handleAdvanceTurn}
              onUndo={handleUndo}
              canUndo={history.length > 0 && lanSession === null && !isLocalBotTurn}
            />
          </div>
          {isLocalBotTurn && !isPeriodSummaryVisible && (
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
                  {pendingBotPlayer?.name ?? "Bot"} is taking its turn
                </div>
                <div style={{ color: "#56635a", fontSize: 14 }}>
                  The board will unlock again once the bot finishes its actions.
                </div>
              </div>
            </div>
          )}
          {lanSession && pendingBotPlayerId && !isLocalPlayerInteractive && !isPeriodSummaryVisible && (
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
                  {pendingBotPlayer?.name ?? "Bot"} is taking its turn
                </div>
                <div style={{ color: "#56635a", fontSize: 14 }}>
                  Bot seats in LAN games resolve automatically once their turn comes up.
                </div>
              </div>
            </div>
          )}
          {lanSession && !pendingBotPlayerId && !isLocalPlayerInteractive && !isPeriodSummaryVisible && !isSpectator && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                background: "rgba(243, 246, 242, 0.2)",
                pointerEvents: selectedPlayer ? "none" : "auto",
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
                    ? game.currentPhase === "add-city" && hasPlayerCompletedAddCity(game, selectedPlayerId)
                      ? "Operations locked in"
                      : `Waiting for ${waitingForPlayer?.name ?? game.currentPlayerId}`
                    : "Viewing live game"}
                </div>
                <div style={{ color: "#56635a", fontSize: 14 }}>
                  {selectedPlayer
                    ? game.currentPhase === "add-city" && hasPlayerCompletedAddCity(game, selectedPlayerId)
                      ? hasPlayerCompletedOperations(game, selectedPlayerId)
                        ? "You already clicked Next player for Operations."
                        : "Your operations panel stays open while the next player picks cities."
                      : game.currentPhase === "bureaucracy" && hasPlayerCompletedBureaucracy(game, selectedPlayerId)
                        ? "You already clicked Next player for Bureaucracy."
                        : `You joined as ${selectedPlayer.name}.`
                    : "Pick a seat to join the game."}
                </div>
                {!selectedPlayer && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
                    {game.players.filter(p => !p.isBot).map(player => {
                      const lobbyPlayer = lanLobby?.players.find(lp => lp.playerId === player.id)
                      const isClaimed = Boolean(lobbyPlayer?.claimedBy)
                      return (
                        <button
                          key={player.id}
                          disabled={isUpdatingLobby}
                          onClick={() => { void handleClaimSeat(player.id) }}
                          style={{
                            padding: "7px 16px",
                            borderRadius: 8,
                            border: `1px solid ${isClaimed ? "#d8dfd5" : "#223024"}`,
                            background: isClaimed ? "#f3f6f2" : "#223024",
                            color: isClaimed ? "#56635a" : "#fff",
                            fontWeight: 700,
                            fontSize: 13,
                            cursor: isUpdatingLobby ? "wait" : "pointer",
                          }}
                        >
                          {player.name}{isClaimed ? " (taken)" : ""}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {isSpectator && (
            <div
              style={{
                position: "absolute",
                top: 12,
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(34, 48, 36, 0.88)",
                color: "#ffffff",
                borderRadius: 14,
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 700,
                zIndex: 2,
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span>👁 Spectating · Viewing {game.players.find(p => p.id === game.currentPlayerId)?.name ?? "current player"}</span>
              {lanLobby?.players
                .filter(lp => !lp.isBot)
                .map(lp => {
                  const player = game.players.find(p => p.id === lp.playerId)
                  if (!player) return null
                  return (
                    <button
                      key={lp.playerId}
                      type="button"
                      disabled={isUpdatingLobby}
                      onClick={() => handleClaimSeat(lp.playerId)}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 999,
                        border: "1px solid rgba(255,255,255,0.35)",
                        background: "rgba(255,255,255,0.15)",
                        color: "#ffffff",
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: isUpdatingLobby ? "not-allowed" : "pointer",
                        opacity: isUpdatingLobby ? 0.6 : 1,
                      }}
                    >
                      {isUpdatingLobby ? "Joining…" : `Join as ${player.name}`}
                    </button>
                  )
                })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
