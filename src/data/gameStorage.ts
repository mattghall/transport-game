import { normalizeGameState } from "../engine/normalizeGameState"
import type { GameState } from "../engine/types"

export const SAVED_GAME_STORAGE_KEY = "transport-game-saved-game-v2"
export const ACTIVE_ADMIN_LAUNCH_STORAGE_KEY = "transport-game-active-admin-launch-v2"
export const PENDING_LOCAL_LAUNCH_STORAGE_KEY = "transport-game-pending-local-launch-v2"
export const LOBBY_CLIENT_ID_STORAGE_KEY = "transport-game-lobby-client-id-v1"
const ACTIVE_SESSION_PLAYER_STORAGE_KEY_PREFIX = "transport-game-active-session-player-v2"
const PLAYER_NAME_STORAGE_KEY = "transport-game-player-name-v1"
const JOIN_APP_URL_STORAGE_KEY = "transport-game-join-app-url-v1"

export type ActiveAdminLaunch = {
  sessionId: string
  sessionName: string
  serverUrl: string
}

export type PendingLocalLaunch = {
  selectedPlayerId: string | null
}

export function loadSavedGame() {
  if (typeof window === "undefined") {
    return null
  }

  const rawValue = window.localStorage.getItem(SAVED_GAME_STORAGE_KEY)

  if (!rawValue) {
    return null
  }

  try {
    return normalizeGameState(JSON.parse(rawValue) as GameState)
  } catch {
    return null
  }
}

export function saveSavedGame(game: GameState) {
  if (typeof window === "undefined") {
    return
  }

  const persistenceCandidates: GameState[] = [
    game,
    {
      ...game,
      actionLog: game.actionLog.slice(-250),
    },
    {
      ...game,
      actionLog: [],
    },
  ]

  for (const candidate of persistenceCandidates) {
    try {
      window.localStorage.setItem(SAVED_GAME_STORAGE_KEY, JSON.stringify(candidate))
      return
    } catch {
      // Try a smaller snapshot before giving up.
    }
  }

  try {
    window.localStorage.removeItem(SAVED_GAME_STORAGE_KEY)
  } catch {
    // Ignore cleanup failures so the app never crashes on storage limits.
  }
}

export function clearSavedGame() {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.removeItem(SAVED_GAME_STORAGE_KEY)
}

export function loadActiveAdminLaunch() {
  if (typeof window === "undefined") {
    return null
  }

  const rawValue = window.localStorage.getItem(ACTIVE_ADMIN_LAUNCH_STORAGE_KEY)

  if (!rawValue) {
    return null
  }

  try {
    const parsedValue = JSON.parse(rawValue) as Partial<ActiveAdminLaunch>

    if (
      typeof parsedValue.sessionId !== "string" ||
      typeof parsedValue.sessionName !== "string" ||
      typeof parsedValue.serverUrl !== "string"
    ) {
      return null
    }

    return {
      sessionId: parsedValue.sessionId,
      sessionName: parsedValue.sessionName,
      serverUrl: parsedValue.serverUrl,
    }
  } catch {
    return null
  }
}

export function saveActiveAdminLaunch(launch: ActiveAdminLaunch) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(ACTIVE_ADMIN_LAUNCH_STORAGE_KEY, JSON.stringify(launch))
}

export function clearActiveAdminLaunch() {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.removeItem(ACTIVE_ADMIN_LAUNCH_STORAGE_KEY)
}

export function loadPendingLocalLaunch() {
  if (typeof window === "undefined") {
    return null
  }

  const rawValue = window.localStorage.getItem(PENDING_LOCAL_LAUNCH_STORAGE_KEY)

  if (!rawValue) {
    return null
  }

  try {
    const parsedValue = JSON.parse(rawValue) as Partial<PendingLocalLaunch>

    if (!("selectedPlayerId" in parsedValue)) {
      return null
    }

    if (parsedValue.selectedPlayerId !== null && typeof parsedValue.selectedPlayerId !== "string") {
      return null
    }

    return {
      selectedPlayerId: parsedValue.selectedPlayerId,
    }
  } catch {
    return null
  }
}

export function savePendingLocalLaunch(launch: PendingLocalLaunch) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(PENDING_LOCAL_LAUNCH_STORAGE_KEY, JSON.stringify(launch))
}

export function clearPendingLocalLaunch() {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.removeItem(PENDING_LOCAL_LAUNCH_STORAGE_KEY)
}

function createLobbyClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }

  return `client-${Math.random().toString(36).slice(2, 10)}`
}

export function getLobbyClientId() {
  if (typeof window === "undefined") {
    return "server"
  }

  const existingValue = window.localStorage.getItem(LOBBY_CLIENT_ID_STORAGE_KEY)

  if (existingValue) {
    return existingValue
  }

  const nextValue = createLobbyClientId()
  window.localStorage.setItem(LOBBY_CLIENT_ID_STORAGE_KEY, nextValue)
  return nextValue
}

function getActiveSessionPlayerStorageKey(sessionId: string) {
  return `${ACTIVE_SESSION_PLAYER_STORAGE_KEY_PREFIX}-${sessionId}`
}

export function loadActiveSessionPlayer(sessionId: string) {
  if (typeof window === "undefined") {
    return null
  }

  return window.localStorage.getItem(getActiveSessionPlayerStorageKey(sessionId))
}

export function saveActiveSessionPlayer(sessionId: string, playerId: string) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(getActiveSessionPlayerStorageKey(sessionId), playerId)
}

export function clearActiveSessionPlayer(sessionId: string) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.removeItem(getActiveSessionPlayerStorageKey(sessionId))
}

export function loadPlayerName() {
  if (typeof window === "undefined") {
    return null
  }

  return window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY)
}

export function savePlayerName(playerName: string) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, playerName)
}

export function loadJoinAppUrl() {
  if (typeof window === "undefined") {
    return null
  }

  return window.localStorage.getItem(JOIN_APP_URL_STORAGE_KEY)
}

export function saveJoinAppUrl(joinAppUrl: string) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(JOIN_APP_URL_STORAGE_KEY, joinAppUrl)
}
