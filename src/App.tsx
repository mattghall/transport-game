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
import {
  MAX_SETUP_PLAYERS,
  PLAYER_SETUP_PRESETS,
  createDefaultSetupPlayers,
} from "./gameSetup/defaultPlayers"
import {
  addBureaucracyServiceSplit,
  advanceTurn,
  buyVehicleCard,
  canPlayerEditOperations,
  claimRoute,
  confirmAddCityPicks,
  deleteBureaucracyServicePod,
  drawCityOffer,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedOperations,
  hasPlayerCompletedAddCity,
  markBureaucracyReady,
  markOperationsReady,
  moveBureaucracyServiceCity,
  setActiveCityOfferKeptCityIds,
  setBureaucracyRouteVehicleCard,
  upgradeRailRoute,
} from "./engine/actions"
import { applyBotAction, getBotLegalActions, getPendingBotPlayerId } from "./bots/actions"
import {
  BOT_PRESETS,
  createPresetBotController,
  DEFAULT_BOT_PRESET_ID,
  fetchManagedBotPresetWeightOverrides,
  getBotPresetLabel,
  getPlayerBotPreset,
  normalizeBotPresetId,
} from "./bots/presets"
import { findPlayerBureaucracyPlan } from "./engine/bureaucracy"
import {
  createGameState,
  DEFAULT_STARTING_MONEY,
  type GameSetupPlayer,
} from "./engine/createGameState"
import type { GameActionLogEntry, GameState, WeeklyPhase } from "./engine/types"
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
    case "add-city":
      return "add city"
    case "operations":
      return "operations"
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
    nextGame.currentPhase === "add-city" &&
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

type AppMode = "launcher" | "setup-lobby" | "joining" | "waiting" | "lobby" | "ready"
type SetupLobbyKind = "local" | "lan"

function createPlaceholderGame() {
  const initialUserDecks = loadUserDecks()

  return createGameState(usMap, {
    players: createDefaultSetupPlayers(),
    vehicleCards: initialUserDecks.vehicleCards,
    chanceCards: initialUserDecks.chanceCards,
    startingMoney: DEFAULT_STARTING_MONEY,
  })
}

function clampSetupPlayerCount(playerCount: number) {
  return Math.max(1, Math.min(MAX_SETUP_PLAYERS, Math.floor(playerCount) || 1))
}

function getDefaultSetupPlayerName(index: number, isBot: boolean) {
  return isBot ? `Bot ${index + 1}` : `Player ${index + 1}`
}

function normalizeSetupPlayers(players: GameSetupPlayer[]) {
  return PLAYER_SETUP_PRESETS.slice(0, clampSetupPlayerCount(players.length)).map((preset, index) => {
    const existingPlayer = players[index]
    const isBot = existingPlayer?.isBot ?? false
    const trimmedName = existingPlayer?.name?.trim() ?? ""
    const existingBotPreset = existingPlayer?.botPreset
      ? normalizeBotPresetId(existingPlayer.botPreset)
      : undefined

    return {
      ...preset,
      ...existingPlayer,
      isBot,
      botPreset: isBot ? existingBotPreset ?? DEFAULT_BOT_PRESET_ID : existingBotPreset,
      name: trimmedName || getDefaultSetupPlayerName(index, isBot),
    }
  })
}

function createSetupPlayers(playerCount: number, botSeatIndexes: number[] = []) {
  const botSeatIndexSet = new Set(botSeatIndexes)

  return normalizeSetupPlayers(
    PLAYER_SETUP_PRESETS.slice(0, clampSetupPlayerCount(playerCount)).map((player, index) => ({
      ...player,
      isBot: botSeatIndexSet.has(index),
      botPreset: botSeatIndexSet.has(index) ? DEFAULT_BOT_PRESET_ID : undefined,
      name: getDefaultSetupPlayerName(index, botSeatIndexSet.has(index)),
    })),
  )
}

type SetupPlayerUpdates = Partial<Pick<GameSetupPlayer, "name" | "isBot" | "botPreset">>

function updateSetupPlayer(
  players: GameSetupPlayer[],
  playerId: string,
  updates: SetupPlayerUpdates,
) {
  return normalizeSetupPlayers(
    players.map((player, index) => {
      if (player.id !== playerId) {
        return player
      }

      const previousIsBot = player.isBot ?? false
      const nextIsBot = updates.isBot ?? previousIsBot
      const previousDefaultName = getDefaultSetupPlayerName(index, previousIsBot)
      const nextDefaultName = getDefaultSetupPlayerName(index, nextIsBot)
      const requestedName = updates.name ?? player.name
      const nextBotPreset =
        updates.botPreset !== undefined
          ? normalizeBotPresetId(updates.botPreset)
          : player.botPreset
            ? normalizeBotPresetId(player.botPreset)
            : DEFAULT_BOT_PRESET_ID

      return {
        ...player,
        ...updates,
        isBot: nextIsBot,
        botPreset: nextIsBot ? nextBotPreset : player.botPreset,
        name: requestedName === previousDefaultName ? nextDefaultName : requestedName,
      }
    }),
  )
}

function getSetupValidationError(players: GameSetupPlayer[]) {
  if (players.length === 0) {
    return "Add at least one seat."
  }

  const nameCounts = new Map<string, number>()

  for (const player of normalizeSetupPlayers(players)) {
    const normalizedName = player.name.trim().toLowerCase()
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) ?? 0) + 1)
  }

  const duplicateName = [...nameCounts.entries()].find(([, count]) => count > 1)?.[0] ?? null

  if (duplicateName) {
    return "Seat names must be unique."
  }

  return null
}

function getDefaultLocalViewingPlayerId(game: GameState) {
  const humanPlayers = game.players.filter(player => !player.isBot)

  if (humanPlayers.length === 0) {
    return null
  }

  if (game.currentPhase === "operations") {
    return (
      humanPlayers.find(player => canPlayerEditOperations(game, player.id) && !hasPlayerCompletedOperations(game, player.id))
        ?.id ??
      humanPlayers[0]?.id ??
      null
    )
  }

  if (game.currentPhase === "bureaucracy") {
    return (
      humanPlayers.find(player => !hasPlayerCompletedBureaucracy(game, player.id))?.id ??
      humanPlayers[0]?.id ??
      null
    )
  }

  if (game.currentPhase === "add-city") {
    const currentHumanPlayer = humanPlayers.find(player => player.id === game.currentPlayerId)

    if (currentHumanPlayer && !hasPlayerCompletedAddCity(game, currentHumanPlayer.id)) {
      return currentHumanPlayer.id
    }

    return (
      humanPlayers.find(player => canPlayerEditOperations(game, player.id) && !hasPlayerCompletedOperations(game, player.id))
        ?.id ??
      currentHumanPlayer?.id ??
      humanPlayers[0]?.id ??
      null
    )
  }

  return humanPlayers.find(player => player.id === game.currentPlayerId)?.id ?? humanPlayers[0]?.id ?? null
}

function getNextLocalViewingPlayerId(game: GameState, currentSelectedPlayerId: string | null = null) {
  const humanPlayers = game.players.filter(player => !player.isBot)

  if (humanPlayers.length === 0) {
    return null
  }

  if (
    currentSelectedPlayerId &&
    humanPlayers.some(player => player.id === currentSelectedPlayerId)
  ) {
    if (game.currentPhase === "operations" && canPlayerEditOperations(game, currentSelectedPlayerId)) {
      return currentSelectedPlayerId
    }

    if (game.currentPhase === "bureaucracy" && !hasPlayerCompletedBureaucracy(game, currentSelectedPlayerId)) {
      return currentSelectedPlayerId
    }

    if (
      game.currentPhase === "add-city" &&
      (currentSelectedPlayerId === game.currentPlayerId || canPlayerEditOperations(game, currentSelectedPlayerId))
    ) {
      return currentSelectedPlayerId
    }

    if (game.currentPhase === "purchase-equipment" && currentSelectedPlayerId === game.currentPlayerId) {
      return currentSelectedPlayerId
    }
  }

  return getDefaultLocalViewingPlayerId(game)
}

function getBotActionLogMessage(previousGame: GameState, nextGame: GameState, action: ReturnType<typeof getBotLegalActions>[number]) {
  return action.type === "buy-vehicle"
    ? (() => {
        const card = previousGame.vehicleCatalog.find(vehicleCard => vehicleCard.id === action.cardId)
        return card
          ? `purchased ${action.quantity} vehicle${action.quantity === 1 ? "" : "s"} of #${card.number} ${card.name}`
          : "purchased a vehicle"
      })()
    : action.type === "draw-city-offer"
      ? `drew 4 city cards from the ${action.region} deck`
      : action.type === "keep-city-offer"
        ? "picked 2 city cards from the draw"
        : action.type === "confirm-add-city-picks"
          ? nextGame.currentPhase === "operations"
            ? "confirmed city picks and opened Operations for every player"
            : `confirmed city picks; ${nextGame.players.find(player => player.id === nextGame.currentPlayerId)?.name ?? nextGame.currentPlayerId} is selecting cities`
          : action.type === "create-service-pod"
            ? (() => {
                const cityMap = new Map(previousGame.cities.map(city => [city.id, city]))
                const cityLabel = action.cityIds
                  .map(cityId => cityMap.get(cityId)?.name ?? cityId)
                  .join(" - ")
                return `created a service pod for ${cityLabel}`
              })()
          : action.type === "ready-operations"
            ? nextGame.currentPhase === "bureaucracy"
              ? "finished operations planning and advanced to bureaucracy"
              : "finished operations planning"
            : action.type === "ready-bureaucracy"
              ? nextGame.currentPhase === "purchase-equipment"
                ? "finished bureaucracy review and advanced to purchase equipment"
                : "finished bureaucracy review"
              : getAdvanceTurnLogMessage(previousGame, nextGame)
}

function runBotTurns(game: GameState, botPlayerIds: ReadonlySet<string>) {
  let nextGame = game
  let hasChanged = false

  while (true) {
    const actingBotPlayerId = getPendingBotPlayerId(nextGame, botPlayerIds)

    if (!actingBotPlayerId) {
      break
    }

    const legalActions = getBotLegalActions(nextGame, actingBotPlayerId)

    if (legalActions.length === 0) {
      break
    }

    const action = createPresetBotController(
      actingBotPlayerId,
      getPlayerBotPreset(nextGame.players.find(player => player.id === actingBotPlayerId) ?? null),
      nextGame.botPresetWeightsById,
    ).pickAction({
      game: nextGame,
      playerId: actingBotPlayerId,
      legalActions,
      phase: nextGame.currentPhase,
    })
    const advancedGame = applyBotAction(nextGame, actingBotPlayerId, action)
    const discardMessage =
      action.type === "end-turn" ? getPhaseDiscardLogMessage(nextGame, advancedGame) : null
    const actionMessage = getBotActionLogMessage(nextGame, advancedGame, action)
    const fullMessage = discardMessage ? `${actionMessage}; ${discardMessage}` : actionMessage

    nextGame = appendActionLog(nextGame, advancedGame, fullMessage, actingBotPlayerId)
    hasChanged = true
  }

  return {
    game: nextGame,
    hasChanged,
  }
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
  const [setupLobbyKind, setSetupLobbyKind] = useState<SetupLobbyKind | null>(null)
  const [localSeatCount, setLocalSeatCount] = useState(2)
  const [lanSeatCount, setLanSeatCount] = useState(4)
  const [localSetupPlayers, setLocalSetupPlayers] = useState<GameSetupPlayer[]>(() =>
    createSetupPlayers(2),
  )
  const [lanSetupPlayers, setLanSetupPlayers] = useState<GameSetupPlayer[]>(() =>
    createSetupPlayers(4),
  )
  const [playerName, setPlayerName] = useState("")
  const [isUpdatingLobby, setIsUpdatingLobby] = useState(false)
  const [launcherSessions, setLauncherSessions] = useState<LanSessionSummary[]>([])
  const [launcherServerOnline, setLauncherServerOnline] = useState<boolean | null>(null)
  const [isLaunchingSession, setIsLaunchingSession] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [isPeriodSummaryVisible, setIsPeriodSummaryVisible] = useState(false)
  const localBotTurnSignatureRef = useRef<string | null>(null)
  const lanBotTurnSignatureRef = useRef<string | null>(null)
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
  const localSetupError = useMemo(() => getSetupValidationError(localSetupPlayers), [localSetupPlayers])
  const lanSetupError = useMemo(() => getSetupValidationError(lanSetupPlayers), [lanSetupPlayers])

  const hasStarted = appMode === "ready"

  useEffect(() => {
    if (!pendingLocalLaunch) {
      return
    }

    clearPendingLocalLaunch()
  }, [pendingLocalLaunch])

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
  const handleCreateLocalLobby = useCallback(() => {
    setLocalSetupPlayers(createSetupPlayers(localSeatCount))
    setSetupLobbyKind("local")
    setAppMode("setup-lobby")
    setLanStatusTone("neutral")
    setLanStatusMessage("Configure the local lobby, then start the game.")
  }, [localSeatCount])
  const handleCreateLanLobby = useCallback(() => {
    setLanSetupPlayers(createSetupPlayers(lanSeatCount))
    setSetupLobbyKind("lan")
    setAppMode("setup-lobby")
    setLanStatusTone("neutral")
    setLanStatusMessage("Configure the LAN lobby, then create the session.")
  }, [lanSeatCount])
  const handleBackToLauncher = useCallback(() => {
    setSetupLobbyKind(null)
    setAppMode("launcher")
  }, [])
  const handleLocalSetupPlayerChange = useCallback(
    (playerId: string, updates: SetupPlayerUpdates) => {
      setLocalSetupPlayers(currentPlayers => updateSetupPlayer(currentPlayers, playerId, updates))
    },
    [],
  )
  const handleLanSetupPlayerChange = useCallback(
    (playerId: string, updates: SetupPlayerUpdates) => {
      setLanSetupPlayers(currentPlayers => updateSetupPlayer(currentPlayers, playerId, updates))
    },
    [],
  )

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
    setSetupLobbyKind(null)
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

    if (sourceGame.currentPhase === "add-city") {
      if (playerId === sourceGame.currentPlayerId) {
        return "Confirm picks before moving on."
      }

      if (hasPlayerCompletedOperations(sourceGame, playerId)) {
        return "You already clicked Next player for Operations."
      }

      if (hasPlayerCompletedAddCity(sourceGame, playerId)) {
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
      case "add-city":
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

  // Shared gameplay handlers all funnel through this helper.
  // Local mode applies the mutation directly to React state/history, while LAN mode must push the
  // mutated game through the session server and retry on version conflicts.
  const commitGameMutation = useCallback(
    async <T extends { ok: true; game: GameState }>(
      mutate: (baseGame: GameState, actingPlayerId: string) => T | GameMutationFailure,
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

  const handleLaunchLanSession = useCallback(async () => {
    const launchPlayers = normalizeSetupPlayers(lanSetupPlayers)
    const validationError = getSetupValidationError(launchPlayers)

    if (validationError) {
      setLanStatusTone("error")
      setLanStatusMessage(validationError)
      return
    }

    setIsLaunchingSession(true)

    try {
      const initialUserDecks = loadUserDecks()
      const managedBotPresetWeights = await fetchManagedBotPresetWeightOverrides(launchPlayers.length)
      const snapshot = await createLanSession(defaultSessionServerUrl, {
        sessionName: `Transport Game LAN (${launchPlayers.length} seats)`,
        game: createGameState(usMap, {
          players: launchPlayers,
          vehicleCards: initialUserDecks.vehicleCards,
          chanceCards: initialUserDecks.chanceCards,
          startingMoney: DEFAULT_STARTING_MONEY,
          botPresetWeightsById: managedBotPresetWeights,
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
      applyLanSnapshot(snapshot, defaultSessionServerUrl)
    } catch (error) {
      setLanStatusTone("error")
      setLanStatusMessage(error instanceof Error ? error.message : "Could not launch the LAN session.")
    } finally {
      setIsLaunchingSession(false)
    }
  }, [applyLanSnapshot, defaultSessionServerUrl, lanSetupPlayers, normalizedJoinAppUrl])

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
      }),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleDrawCityOffer = useCallback(
    async (region: NonNullable<GameState["activeCityOffer"]>["region"]) =>
      commitGameMutation((baseGame, actingPlayerId) => {
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
      }),
    [commitGameMutation],
  )

  const handleAdvanceTurn = useCallback(
    async () =>
      commitGameMutation(baseGame => {
        const actingPlayerId = resolveActingPlayerId(baseGame)

        if (baseGame.currentPhase === "add-city" && actingPlayerId === baseGame.currentPlayerId) {
          const result = confirmAddCityPicks(baseGame)

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

        if (baseGame.currentPhase === "add-city" || baseGame.currentPhase === "operations") {
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
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleSetActiveCityOfferKeptCityIds = useCallback(
    async (cityIds: string[]) =>
      commitGameMutation((baseGame, actingPlayerId) => {
        const result = setActiveCityOfferKeptCityIds(baseGame, cityIds, actingPlayerId)

        return result.ok
          ? {
              ...result,
              game: result.game,
            }
          : result
      }),
    [commitGameMutation],
  )

  const handleBuyVehicleCardAndAdvance = useCallback(
    async (cardId: string, quantity: number) =>
      commitGameMutation(baseGame => {
        const purchaseResult = buyVehicleCard(baseGame, cardId, quantity)

        if (!purchaseResult.ok) {
          return purchaseResult
        }

        const actingPlayerId = resolveActingPlayerId(baseGame)
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
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleSetBureaucracyRouteVehicleCard = useCallback(
    async (routeId: string, vehicleCardId: string | null) =>
      commitGameMutation(baseGame => {
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
      }),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleAddBureaucracyServiceSplit = useCallback(
    async (corridorId: string) =>
      commitGameMutation(baseGame => {
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
      }),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleMoveBureaucracyServiceCity = useCallback(
    async (
      corridorId: string,
      cityId: string,
      routeId: string,
      sourceRouteId: string | null = null,
    ) =>
      commitGameMutation(baseGame => {
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
      }),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleDeleteBureaucracyServicePod = useCallback(
    async (corridorId: string, routeId: string) =>
      commitGameMutation(baseGame => {
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
      }),
    [commitGameMutation, resolveActingPlayerId],
  )

  const handleUpgradeRailRoute = useCallback(
    async (routeId: string) =>
      commitGameMutation(baseGame => {
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
      }),
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
  const isLocalPlayerInteractive = !isSpectator && Boolean(activeViewingPlayerId) && (
    game.currentPhase === "purchase-equipment"
      ? activeViewingPlayerId === game.currentPlayerId
      : game.currentPhase === "add-city"
        ? activeViewingPlayerId === game.currentPlayerId || canPlayerEditOperations(game, activeViewingPlayerId)
        : game.currentPhase === "operations"
          ? canPlayerEditOperations(game, activeViewingPlayerId)
          : game.currentPhase === "bureaucracy"
            ? !hasPlayerCompletedBureaucracy(game, activeViewingPlayerId)
            : false
  )
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
  const shouldRunLanBots =
    appMode === "ready" && lanSession !== null && pendingBotPlayerId !== null
  const blockingLocalBotPlayerId =
    lanSession === null && (isBotOnlyLocalGame || !isLocalPlayerInteractive) ? pendingBotPlayerId : null
  const isLocalBotTurn = blockingLocalBotPlayerId !== null
  const pendingBotPlayer = pendingBotPlayerId
    ? game.players.find(player => player.id === pendingBotPlayerId) ?? null
    : null

  // Local bots share the same engine logic as LAN bots, but they can commit directly into local state.
  useEffect(() => {
    if (!shouldRunLocalBots || isPeriodSummaryVisible || !pendingBotPlayerId) {
      localBotTurnSignatureRef.current = null
      return
    }

    const turnSignature = JSON.stringify({
      week: game.currentWeek,
      phase: game.currentPhase,
      currentPlayerId: game.currentPlayerId,
      addCityReadyPlayerIds: game.addCityReadyPlayerIds,
      operationsReadyPlayerIds: game.operationsReadyPlayerIds,
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

  // LAN bots also use the shared engine logic, but every bot step still has to publish through the
  // session server because the live session snapshot is the source of truth for all clients.
  useEffect(() => {
    if (!shouldRunLanBots || isPeriodSummaryVisible || !pendingBotPlayerId || !lanSession) {
      lanBotTurnSignatureRef.current = null
      return
    }

    const turnSignature = JSON.stringify({
      sessionId: lanSession.sessionId,
      version: lanSession.version,
      week: game.currentWeek,
      phase: game.currentPhase,
      currentPlayerId: game.currentPlayerId,
      addCityReadyPlayerIds: game.addCityReadyPlayerIds,
      operationsReadyPlayerIds: game.operationsReadyPlayerIds,
      bureaucracyReadyPlayerIds: game.bureaucracyReadyPlayerIds,
      pendingBotPlayerId,
    })

    if (lanBotTurnSignatureRef.current === turnSignature) {
      return
    }

    lanBotTurnSignatureRef.current = turnSignature
    let isActive = true

    void (async () => {
      const activeLanSession = lanSessionRef.current

      if (!activeLanSession) {
        return
      }

      let baseGame = game
      let baseVersion = activeLanSession.version

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = runBotTurns(baseGame, localBotPlayerIds)

        if (!result.hasChanged || result.game === baseGame) {
          return
        }

        try {
          const snapshot = await pushLanSessionGame(
            activeLanSession.serverUrl,
            activeLanSession.sessionId,
            result.game,
            baseVersion,
          )

          if (!isActive) {
            return
          }

          applyLanSnapshot(snapshot, activeLanSession.serverUrl)
          setLanStatusTone("neutral")
          setLanStatusMessage(`Synced ${snapshot.sessionName} (${snapshot.sessionId}).`)
          return
        } catch (error) {
          if (isLanSessionConflictError(error)) {
            if (!isActive) {
              return
            }

            applyLanSnapshot(error.snapshot, activeLanSession.serverUrl)
            baseGame = hydrateLanSessionGame(error.snapshot)
            baseVersion = error.snapshot.version
            await wait(40 * (attempt + 1) + Math.floor(Math.random() * 40))
            continue
          }

          if (!isActive) {
            return
          }

          setLanStatusTone("error")
          setLanStatusMessage(
            `Could not run the bot turn for ${activeLanSession.sessionName}: ${error instanceof Error ? error.message : "unknown error"}`,
          )
          return
        }
      }

      if (!isActive) {
        return
      }

      setLanStatusTone("error")
      setLanStatusMessage("Bot turns kept colliding with other updates. Try again in a moment.")
    })()

    return () => {
      isActive = false
    }
  }, [
    applyLanSnapshot,
    game,
    isPeriodSummaryVisible,
    lanSession,
    localBotPlayerIds,
    pendingBotPlayerId,
    shouldRunLanBots,
  ])

  const handleStartLocalGame = useCallback(async () => {
    const players = normalizeSetupPlayers(localSetupPlayers)
    const validationError = getSetupValidationError(players)

    if (validationError) {
      setLanStatusTone("error")
      setLanStatusMessage(validationError)
      return
    }

    const initialUserDecks = loadUserDecks()
    const managedBotPresetWeights = await fetchManagedBotPresetWeightOverrides(players.length)
    const nextGame = createGameState(usMap, {
      players,
      vehicleCards: initialUserDecks.vehicleCards,
      chanceCards: initialUserDecks.chanceCards,
      startingMoney: DEFAULT_STARTING_MONEY,
      botPresetWeightsById: managedBotPresetWeights,
    })

    setLanSession(null)
    setLanLobby(null)
    setHistory([])
    setGame(nextGame)
    setSetupLobbyKind(null)
    setSelectedPlayerId(getDefaultLocalViewingPlayerId(nextGame))
    setPlayerName(players.find(player => !player.isBot)?.name ?? "")
    setAppMode("ready")
    setLanStatusTone("neutral")
    setLanStatusMessage(
      players.every(player => player.isBot)
        ? "Started a local bot-only game."
        : players.some(player => player.isBot)
          ? "Started a local game with bots."
          : "Started a local hotseat game.",
    )
    clearActiveAdminLaunch()
    clearPendingLocalLaunch()
    const leadHumanPlayer = players.find(player => !player.isBot)
    if (leadHumanPlayer) {
      savePlayerName(leadHumanPlayer.name)
    }
    saveSavedGame(nextGame)
  }, [localSetupPlayers])

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
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#223024" }}>Local game</div>
                  <div style={{ color: "#56635a" }}>
                    Create a local lobby first, then set names and bots on the next screen.
                  </div>
                </div>
                <label style={{ display: "grid", gap: 6, maxWidth: 180 }}>
                  <strong>Seats</strong>
                  <select
                    value={localSeatCount}
                    onChange={event => setLocalSeatCount(Number(event.target.value))}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                  >
                    {Array.from({ length: MAX_SETUP_PLAYERS }, (_, index) => index + 1).map(playerCount => (
                      <option key={playerCount} value={playerCount}>
                        {playerCount}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={handleCreateLocalLobby}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    background: "#223024",
                    color: "#ffffff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Create local lobby
                </button>
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
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#223024" }}>LAN game</div>
                  <div style={{ color: "#56635a" }}>
                    Create the LAN lobby first, then set names and bots before opening the join link.
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
                  Use this machine&apos;s LAN address so other computers can open the copied join link.
                </div>
                <div style={{ color: launcherServerOnline === false ? "#9b1c1c" : "#56635a", fontSize: 14 }}>
                  Session server: {defaultSessionServerUrl} {launcherServerOnline === false ? "offline" : launcherServerOnline ? "online" : "checking..."}
                </div>
                <button
                  type="button"
                  onClick={handleCreateLanLobby}
                  disabled={launcherServerOnline === false}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 999,
                    border: "1px solid #223024",
                    background: launcherServerOnline === false ? "#c7d0c4" : "#223024",
                    color: "#ffffff",
                    cursor: launcherServerOnline === false ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  Create LAN lobby
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
      ) : appMode === "setup-lobby" ? (
        <div
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "start center",
            padding: "88px 24px 24px",
          }}
        >
          <div
            style={{
              maxWidth: 720,
              width: "100%",
              borderRadius: 18,
              border: "1px solid #d8dfd5",
              background: "#ffffff",
              padding: 24,
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
              display: "grid",
              gap: 16,
            }}
          >
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#223024" }}>
                {setupLobbyKind === "lan" ? "LAN lobby" : "Local lobby"}
              </div>
              <div style={{ color: "#56635a" }}>
                {setupLobbyKind === "lan"
                  ? "Set names and bot seats here before creating the LAN session."
                  : "Set names and bot seats here before starting the local game."}
              </div>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {(setupLobbyKind === "lan" ? lanSetupPlayers : localSetupPlayers).map((player, index) => (
                <div
                  key={player.id}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    padding: 12,
                    background: "#fbfcfb",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <div style={{ fontWeight: 800, color: "#223024" }}>Seat {index + 1}</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#324236", fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(player.isBot)}
                        onChange={event =>
                          (setupLobbyKind === "lan"
                            ? handleLanSetupPlayerChange
                            : handleLocalSetupPlayerChange)(player.id, { isBot: event.target.checked })
                        }
                      />
                      Bot
                    </label>
                  </div>
                  <input
                    type="text"
                    value={player.name}
                    onChange={event =>
                      (setupLobbyKind === "lan"
                        ? handleLanSetupPlayerChange
                        : handleLocalSetupPlayerChange)(player.id, { name: event.target.value })
                    }
                    placeholder={getDefaultSetupPlayerName(index, Boolean(player.isBot))}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                  />
                  {player.isBot && (
                    <label style={{ display: "grid", gap: 6 }}>
                      <span style={{ fontSize: 13, color: "#56635a", fontWeight: 700 }}>Bot preset</span>
                      <select
                        value={normalizeBotPresetId(player.botPreset)}
                        onChange={event =>
                          (setupLobbyKind === "lan"
                            ? handleLanSetupPlayerChange
                            : handleLocalSetupPlayerChange)(player.id, {
                            botPreset: normalizeBotPresetId(event.target.value),
                          })
                        }
                        style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                      >
                        {BOT_PRESETS.map(preset => (
                          <option key={preset.id} value={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                      <div style={{ color: "#56635a", fontSize: 13 }}>
                        {BOT_PRESETS.find(preset => preset.id === normalizeBotPresetId(player.botPreset))?.description}
                      </div>
                    </label>
                  )}
                </div>
              ))}
            </div>
            {setupLobbyKind === "lan" && (
              <>
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
              </>
            )}
            {(setupLobbyKind === "lan" ? lanSetupError : localSetupError) && (
              <div style={{ color: "#9b1c1c", fontSize: 13 }}>
                {setupLobbyKind === "lan" ? lanSetupError : localSetupError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={handleBackToLauncher}
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void (setupLobbyKind === "lan" ? handleLaunchLanSession() : handleStartLocalGame())}
                disabled={
                  setupLobbyKind === "lan"
                    ? isLaunchingSession || launcherServerOnline === false || lanSetupError !== null || !hasValidJoinAppUrl
                    : localSetupError !== null
                }
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  border: "1px solid #223024",
                  background:
                    (setupLobbyKind === "lan"
                      ? isLaunchingSession || launcherServerOnline === false || lanSetupError || !hasValidJoinAppUrl
                      : localSetupError)
                      ? "#c7d0c4"
                      : "#223024",
                  color: "#ffffff",
                  cursor:
                    (setupLobbyKind === "lan"
                      ? isLaunchingSession || launcherServerOnline === false || lanSetupError !== null || !hasValidJoinAppUrl
                      : localSetupError !== null)
                      ? "not-allowed"
                      : "pointer",
                  fontWeight: 700,
                }}
              >
                {setupLobbyKind === "lan"
                  ? isLaunchingSession
                    ? "Creating LAN lobby..."
                    : "Create LAN lobby"
                  : "Save and start local game"}
              </button>
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
                const botPresetLabel = isBotSeat ? getBotPresetLabel(player.botPreset) : null
                const seatLabel = `Seat ${player.id.replace(/^p/i, "")}`
                const statusLabel = isBotSeat ? (isReady ? "Bot ready" : "Bot") : isReady ? "Ready" : isFilled ? "Filled" : "Waiting"
                const accentColor = isBotSeat ? "#5c4a8a" : isReady ? "#1f5f2c" : isFilled ? "#8a5a00" : "#56635a"
                const borderColor = isBotSeat ? "#cbb9ec" : isReady ? "#98c7a4" : isFilled ? "#d7c08a" : "#d8dfd5"
                const background = isBotSeat ? "#f8f4ff" : isReady ? "#f3fbf4" : isFilled ? "#fff9ef" : "#fbfcfb"

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
                    {botPresetLabel && (
                      <div style={{ fontSize: 12, color: "#6b5a93", fontWeight: 700 }}>
                        {botPresetLabel}
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
                background: "rgba(34, 48, 36, 0.82)",
                color: "#ffffff",
                borderRadius: 999,
                padding: "5px 14px",
                fontSize: 13,
                fontWeight: 700,
                pointerEvents: "none",
                zIndex: 2,
                whiteSpace: "nowrap",
              }}
            >
              👁 Spectating · Viewing {game.players.find(p => p.id === game.currentPlayerId)?.name ?? "current player"}
            </div>
          )}
        </>
      )}
    </div>
  )
}
