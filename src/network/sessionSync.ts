import { usMap } from "../data/maps/usMap"
import { normalizeGameState } from "../engine/normalizeGameState"
import type {
  BotPresetId,
  ManagedBotPresetEntry,
  ManagedBotPresetId,
  ManagedBotPresetStorageId,
} from "../bots/presets"
import type { ScriptedBotLeverImportanceResults } from "../bots/training"
import type { GameState } from "../engine/types"

const DEFAULT_SESSION_SERVER_PORT = "8787"
const SESSION_QUERY_PARAM = "session"
const SERVER_QUERY_PARAM = "server"
const GAME_PATH_PATTERN = /^\/game\/([A-Z0-9]{6})\/?$/

export type LanSessionLobbyPlayer = {
  playerId: string
  claimedBy: string | null
  isReady: boolean
  isBot: boolean
  botPreset: BotPresetId | null
}

export type LanSessionLobby = {
  status: "forming" | "started"
  players: LanSessionLobbyPlayer[]
}

export type LanSessionStaticData = Pick<
  GameState,
  "cities" | "operatingConfig" | "chanceCatalog" | "vehicleCatalog" | "routeCatalog"
> & {
  mapId: GameState["map"]["id"]
}

export type LanSessionMutableGame = Omit<
  GameState,
  "map" | "cities" | "operatingConfig" | "chanceCatalog" | "vehicleCatalog" | "routeCatalog"
>

export type LanSessionSnapshot = {
  sessionId: string
  sessionName: string
  version: number
  createdAt: string
  updatedAt: string
  lobby: LanSessionLobby
  staticData: LanSessionStaticData
  game: LanSessionMutableGame
}

export type LanSessionRequest = {
  sessionName: string
  game: GameState
}

export type RequestedLanSession = {
  sessionId: string
  serverUrl: string
}

export type SessionServerHealth = {
  ok: true
  sessions: number
  activeSessionId: string | null
  lanAddresses: string[]
}

export type TrainingStartRequest = {
  iterations: number
  gamesPerCandidate: number
  playerCount: number
  baseSeed: number
  candidatesPerIteration: number
  mutationSeed: number
  maxSteps: number
}

export type TrainingIterationProgress = {
  currentIteration: number
  totalIterations: number
  temperature: number | null
  bestScore: number | null
  candidateScore: number | null
}

export type TrainingStatus = {
  status: "idle" | "running" | "completed" | "failed" | "cancelled"
  args: TrainingStartRequest | null
  pid: number | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  outputPath: string
  logs: string[]
  isRunning: boolean
  progress: TrainingIterationProgress | null
}

export type TrainingPresetStatus = {
  outputPath: string
  presets: Partial<Record<ManagedBotPresetStorageId, ManagedBotPresetEntry>>
}

export type PromoteTrainingPresetRequest = {
  presetId: ManagedBotPresetId
}

export type PromoteAutotuneRunPresetRequest = {
  playerCount: number
  generatedAt: string
}

export type TrainingImportanceStatus = {
  status: "idle" | "running" | "completed" | "failed"
  pid: number | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  outputPath: string
  sourceTrainingGeneratedAt: string | null
  error: string | null
  isRunning: boolean
  result: ScriptedBotLeverImportanceResults | null
}

export type AutotuneControlStatus = {
  status: "idle" | "running" | "stopping" | "completed" | "failed" | "unknown"
  pid: number | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  outputPath: string
  logs: string[]
  isRunning: boolean
  progress: TrainingIterationProgress | null
}

export type LanSessionSummary = {
  sessionId: string
  sessionName: string
  updatedAt: string
  lobbyStatus: LanSessionLobby["status"]
  playerCount: number
  readyPlayerCount: number
  isActive: boolean
}

export type LanSessionClosedEvent = {
  sessionId: string
  message: string
}

export type UpdateLanLobbyRequest = {
  clientId: string
  playerId?: string
  isReady?: boolean
  playerName?: string
  startGame?: boolean
}

export class LanSessionConflictError extends Error {
  snapshot: LanSessionSnapshot

  constructor(snapshot: LanSessionSnapshot) {
    super("The LAN session changed. Retry on the latest snapshot.")
    this.name = "LanSessionConflictError"
    this.snapshot = snapshot
  }
}

export function isLanSessionConflictError(error: unknown): error is LanSessionConflictError {
  return error instanceof LanSessionConflictError
}

function getBrowserHref(fallbackPath = "/") {
  if (typeof window === "undefined") {
    return `http://localhost${fallbackPath}`
  }

  return window.location.href
}

export function normalizeSessionServerUrl(rawUrl: string) {
  const trimmedValue = rawUrl.trim()

  if (!trimmedValue) {
    throw new Error("Enter a session server URL first.")
  }

  const normalizedUrl = new URL(trimmedValue.includes("://") ? trimmedValue : `http://${trimmedValue}`)
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+$/, "")
  normalizedUrl.search = ""
  normalizedUrl.hash = ""
  return normalizedUrl.toString().replace(/\/$/, "")
}

export function getDefaultSessionServerUrl(href = getBrowserHref()) {
  const location = new URL(href)
  const protocol = location.protocol === "https:" ? "https:" : "http:"
  const hostname = location.hostname || "localhost"
  return normalizeSessionServerUrl(`${protocol}//${hostname}:${DEFAULT_SESSION_SERVER_PORT}`)
}

function isLoopbackHostname(hostname: string) {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return normalizedHostname === "localhost" || normalizedHostname === "127.0.0.1" || normalizedHostname === "::1"
}

export function normalizeJoinAppUrl(rawUrl: string) {
  const trimmedValue = rawUrl.trim()

  if (!trimmedValue) {
    throw new Error("Enter the app URL other players should open.")
  }

  const normalizedUrl = new URL(trimmedValue.includes("://") ? trimmedValue : `http://${trimmedValue}`)
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/+$/, "")
  normalizedUrl.search = ""
  normalizedUrl.hash = ""
  return normalizedUrl.toString().replace(/\/$/, "")
}

export function getDefaultJoinAppUrl(href = getBrowserHref()) {
  const location = new URL(href)
  return normalizeJoinAppUrl(location.origin)
}

export function isLocalJoinAppUrl(rawUrl: string) {
  const normalizedUrl = new URL(rawUrl.includes("://") ? rawUrl : `http://${rawUrl}`)
  return isLoopbackHostname(normalizedUrl.hostname)
}

function getShareableSessionServerUrl(serverUrl: string, appUrl: string) {
  const normalizedServerUrl = new URL(normalizeSessionServerUrl(serverUrl))
  const normalizedAppUrl = new URL(normalizeJoinAppUrl(appUrl))

  if (isLoopbackHostname(normalizedServerUrl.hostname) && !isLoopbackHostname(normalizedAppUrl.hostname)) {
    normalizedServerUrl.hostname = normalizedAppUrl.hostname
  }

  return normalizeSessionServerUrl(normalizedServerUrl.toString())
}

export function getSuggestedJoinAppUrl(health: Pick<SessionServerHealth, "lanAddresses">, href = getBrowserHref()) {
  const location = new URL(href)
  const protocol = location.protocol === "https:" ? "https:" : "http:"
  const portSuffix = location.port ? `:${location.port}` : ""
  const preferredHostname = health.lanAddresses[0] ?? location.hostname ?? "localhost"
  return normalizeJoinAppUrl(`${protocol}//${preferredHostname}${portSuffix}`)
}

export function getRequestedLanSession(href = getBrowserHref()): RequestedLanSession | null {
  const location = new URL(href)
  const pathMatch = location.pathname.match(GAME_PATH_PATTERN)

  if (pathMatch) {
    const rawServerUrl = location.searchParams.get(SERVER_QUERY_PARAM)
    return {
      sessionId: pathMatch[1],
      serverUrl: normalizeSessionServerUrl(rawServerUrl?.trim() || getDefaultSessionServerUrl(href)),
    }
  }

  const sessionId = location.searchParams.get(SESSION_QUERY_PARAM)?.trim()

  if (!sessionId) {
    return null
  }

  const rawServerUrl = location.searchParams.get(SERVER_QUERY_PARAM)
  return {
    sessionId,
    serverUrl: normalizeSessionServerUrl(rawServerUrl?.trim() || getDefaultSessionServerUrl(href)),
  }
}

export function buildLanSessionJoinUrl(
  sessionId: string,
  serverUrl: string,
  appUrl = getDefaultJoinAppUrl(),
) {
  const location = new URL(`game/${sessionId}`, normalizeJoinAppUrl(appUrl))
  const normalizedServerUrl = getShareableSessionServerUrl(serverUrl, appUrl)

  if (normalizedServerUrl !== getDefaultSessionServerUrl(location.toString())) {
    location.searchParams.set(SERVER_QUERY_PARAM, normalizedServerUrl)
  }

  return location.toString()
}

export function dehydrateLanSessionGame(game: GameState): Pick<LanSessionSnapshot, "staticData" | "game"> {
  const {
    map,
    cities,
    operatingConfig,
    chanceCatalog,
    vehicleCatalog,
    routeCatalog,
    ...mutableGame
  } = game

  return {
    staticData: {
      mapId: map.id,
      cities,
      operatingConfig,
      chanceCatalog,
      vehicleCatalog,
      routeCatalog,
    },
    game: mutableGame,
  }
}

function getSupportedMap(mapId: string) {
  if (mapId === usMap.id) {
    return usMap
  }

  throw new Error(`Unsupported session map ${mapId}.`)
}

export function hydrateLanSessionGame(snapshot: LanSessionSnapshot): GameState {
  return normalizeGameState({
    map: getSupportedMap(snapshot.staticData.mapId),
    cities: snapshot.staticData.cities,
    operatingConfig: snapshot.staticData.operatingConfig,
    chanceCatalog: snapshot.staticData.chanceCatalog,
    vehicleCatalog: snapshot.staticData.vehicleCatalog,
    routeCatalog: snapshot.staticData.routeCatalog,
    ...snapshot.game,
  })
}

async function requestSessionJson<T>(url: string, init?: RequestInit) {
  let response: Response

  try {
    response = await fetch(url, init)
  } catch (error) {
    if (error instanceof TypeError) {
      const endpoint = new URL(url)
      throw new Error(
        `Could not reach the session server at ${endpoint.origin}. Start \`npm run session-server\` and try again.`,
        { cause: error },
      )
    }

    throw error
  }

  if (!response.ok) {
    const responseText = await response.text()

    if (responseText) {
      try {
        const parsedResponse = JSON.parse(responseText) as { error?: unknown }

        if (typeof parsedResponse.error === "string") {
          throw new Error(parsedResponse.error)
        }
      } catch {
        // Fall through to the raw response text below if the body is not JSON.
      }
    }

    throw new Error(responseText || `Request failed with status ${response.status}.`)
  }

  return (await response.json()) as T
}

export async function createLanSession(serverUrl: string, request: LanSessionRequest) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)

  return requestSessionJson<LanSessionSnapshot>(`${normalizedServerUrl}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionName: request.sessionName,
      ...dehydrateLanSessionGame(request.game),
    }),
  })
}

export async function fetchLanSession(serverUrl: string, sessionId: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<LanSessionSnapshot>(
    `${normalizedServerUrl}/sessions/${encodeURIComponent(sessionId)}`,
  )
}

export async function fetchSessionServerHealth(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<SessionServerHealth>(`${normalizedServerUrl}/health`)
}

export async function fetchTrainingStatus(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingStatus>(`${normalizedServerUrl}/training/status`)
}

export async function startTraining(serverUrl: string, request: TrainingStartRequest) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingStatus>(`${normalizedServerUrl}/training/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  })
}

export async function cancelTraining(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingStatus>(`${normalizedServerUrl}/training/cancel`, {
    method: "POST",
  })
}

export async function stopTraining(serverUrl: string) {
  return cancelTraining(serverUrl)
}

export async function fetchTrainingPresets(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingPresetStatus>(`${normalizedServerUrl}/training/presets`)
}

export async function promoteTrainingPreset(serverUrl: string, request: PromoteTrainingPresetRequest) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingPresetStatus>(`${normalizedServerUrl}/training/presets/promote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  })
}

export async function promoteAutotuneRunToStickbug(serverUrl: string, request: PromoteAutotuneRunPresetRequest) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingPresetStatus>(`${normalizedServerUrl}/training/presets/promote-autotune-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  })
}

export async function fetchTrainingImportance(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingImportanceStatus>(`${normalizedServerUrl}/training/importance`)
}

export async function startTrainingImportance(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<TrainingImportanceStatus>(`${normalizedServerUrl}/training/importance/start`, {
    method: "POST",
  })
}

export async function fetchAutotuneStatus(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<AutotuneControlStatus>(`${normalizedServerUrl}/training/autotune/status`)
}

export async function startAutotune(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<AutotuneControlStatus>(`${normalizedServerUrl}/training/autotune/start`, {
    method: "POST",
  })
}

export async function stopAutotune(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<AutotuneControlStatus>(`${normalizedServerUrl}/training/autotune/stop`, {
    method: "POST",
  })
}

export async function forceStopAutotune(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<AutotuneControlStatus>(`${normalizedServerUrl}/training/autotune/force-stop`, {
    method: "POST",
  })
}

export async function resetAutotuneData(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<{ deleted: string[] }>(`${normalizedServerUrl}/training/autotune/reset`, {
    method: "POST",
  })
}

export async function listLanSessions(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<LanSessionSummary[]>(`${normalizedServerUrl}/sessions`)
}

export async function fetchActiveLanSession(serverUrl: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<LanSessionSnapshot>(`${normalizedServerUrl}/sessions/active`)
}

export async function deleteLanSession(serverUrl: string, sessionId: string) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<{ ok: true; sessionId: string }>(
    `${normalizedServerUrl}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    },
  )
}

export async function updateLanLobby(serverUrl: string, sessionId: string, request: UpdateLanLobbyRequest) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  return requestSessionJson<LanSessionSnapshot>(
    `${normalizedServerUrl}/sessions/${encodeURIComponent(sessionId)}/lobby`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  )
}

export async function pushLanSessionGame(
  serverUrl: string,
  sessionId: string,
  game: GameState,
  baseVersion: number,
) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  const response = await fetch(
    `${normalizedServerUrl}/sessions/${encodeURIComponent(sessionId)}/game`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        baseVersion,
        game: dehydrateLanSessionGame(game).game,
      }),
    },
  )

  if (response.status === 409) {
    const parsedResponse = (await response.json()) as { snapshot?: LanSessionSnapshot }

    if (parsedResponse.snapshot) {
      throw new LanSessionConflictError(parsedResponse.snapshot)
    }
  }

  if (!response.ok) {
    const responseText = await response.text()

    if (responseText) {
      try {
        const parsedResponse = JSON.parse(responseText) as { error?: unknown }

        if (typeof parsedResponse.error === "string") {
          throw new Error(parsedResponse.error)
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error
        }
      }
    }

    throw new Error(responseText || `Request failed with status ${response.status}.`)
  }

  return (await response.json()) as LanSessionSnapshot
}

export function subscribeToLanSession(
  serverUrl: string,
  sessionId: string,
  callbacks: {
    onSnapshot: (snapshot: LanSessionSnapshot) => void
    onError?: () => void
    onClosed?: (event: LanSessionClosedEvent) => void
  },
) {
  const normalizedServerUrl = normalizeSessionServerUrl(serverUrl)
  const eventSource = new EventSource(
    `${normalizedServerUrl}/sessions/${encodeURIComponent(sessionId)}/events`,
  )
  let isClosed = false

  const handleSnapshot = (event: MessageEvent<string>) => {
    callbacks.onSnapshot(JSON.parse(event.data) as LanSessionSnapshot)
  }
  const handleClosed = (event: MessageEvent<string>) => {
    isClosed = true
    eventSource.close()
    callbacks.onClosed?.(JSON.parse(event.data) as LanSessionClosedEvent)
  }

  eventSource.addEventListener("snapshot", handleSnapshot as EventListener)
  eventSource.addEventListener("closed", handleClosed as EventListener)
  eventSource.onerror = () => {
    if (isClosed) {
      return
    }

    callbacks.onError?.()
  }

  return () => {
    isClosed = true
    eventSource.removeEventListener("snapshot", handleSnapshot as EventListener)
    eventSource.removeEventListener("closed", handleClosed as EventListener)
    eventSource.close()
  }
}
