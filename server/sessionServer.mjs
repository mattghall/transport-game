import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { createSocket } from "node:dgram"
import { networkInterfaces } from "node:os"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { extname } from "node:path"
import { usMap } from '../src/data/maps/usMap.ts'
import { normalizeGameState } from '../src/engine/normalizeGameState.ts'
import { applyBotAction, getBotLegalActions, getPendingBotPlayerId } from '../src/bots/actions.ts'
import { createPresetBotController, normalizeBotPresetId } from '../src/bots/presets.ts'
import { buildPlayerBureaucracySummary, buildServiceSlotId } from '../src/engine/bureaucracy.ts'
import {
  buyVehicleCard,
  exchangeVehicleCard,
  advanceTurn,
  drawCityOffer,
  setActiveCityOfferKeptCityIds,
  confirmAddCityPicks,
  claimRoute,
  markOperationsReady,
  markBureaucracyReady,
  setBureaucracyRouteVehicleCard,
  setBureaucracyServicePodCities,
  addBureaucracyServiceSplit,
  deleteBureaucracyServicePod,
  moveBureaucracyServiceCity,
  upgradeRailRoute,
  canPlayerPickCities,
  canPlayerEditOperations,
  canPlayerStartPhaseByPipeline,
  hasPlayerCompletedBureaucracy,
  hasPlayerCompletedOperations,
} from '../src/engine/actions.ts'

const PORT = Number(process.env.PORT ?? 8787)
const sessions = new Map()
const sessionStreams = new Map()
let lastLanAddressLogSignature = null
// pending seat-release timeouts keyed by `${sessionId}:${clientId}`
const pendingSeatReleases = new Map()
// active SSE connection counts per client, keyed by `${sessionId}:${clientId}`
const activeConnectionCounts = new Map()
// turn timer timeouts keyed by sessionId
const turnTimerTimeouts = new Map()
const SEAT_RELEASE_DELAY_MS = 12000
let activeSessionId = null
const BOT_CLAIM_PREFIX = "bot:"
const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")
const TSX_CLI_PATH = resolve(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs")
const TRAINING_SCRIPT_PATH = resolve(PROJECT_ROOT, "scripts/trainBotWeights.ts")
const TRAINING_IMPORTANCE_SCRIPT_PATH = resolve(PROJECT_ROOT, "scripts/analyzeBotWeights.ts")
const AUTOTUNE_SCRIPT_PATH = resolve(PROJECT_ROOT, "scripts/autotuneBots.ts")
const TRAINING_RESULTS_PATH = resolve(PROJECT_ROOT, "public/training-results/latest.json")
const TRAINING_IMPORTANCE_RESULTS_PATH = resolve(PROJECT_ROOT, "public/training-results/latest-importance.json")
const MANAGED_BOT_PRESETS_PATH = resolve(PROJECT_ROOT, "public/training-results/bot-presets.json")
const AUTOTUNE_STATUS_PATH = resolve(PROJECT_ROOT, "public/training-results/autotune-status.json")
const AUTOTUNE_HISTORY_PATH = resolve(PROJECT_ROOT, "public/training-results/autotune-history.json")
const AUTOTUNE_STOP_SIGNAL_PATH = resolve(PROJECT_ROOT, "public/training-results/autotune-stop-requested")
const TRAINING_CHRONICLE_PATH = resolve(PROJECT_ROOT, "public/training-results/training-chronicle.json")
const TRAINING_LOG_LIMIT = 400
const MANAGED_BOT_PRESET_STORAGE_IDS = ["bot-avg", "bot-best-1p", "bot-best-2p", "bot-best-3p", "bot-best-4p"]
const DIST_DIR = resolve(PROJECT_ROOT, "dist")
const PUBLIC_TRAINING_DIR = resolve(PROJECT_ROOT, "public/training-results")

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".txt":  "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}

const HTML_ENTRY_POINTS = new Set([
  "/index.html",
  "/admin.html",
  "/training.html",
  "/manual-training.html",
  "/compare.html",
  "/coach.html",
])

function serveStaticFile(response, filePath) {
  if (!existsSync(filePath)) return false
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return false
    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream"
    const content = readFileSync(filePath)
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Access-Control-Allow-Origin": "*",
    })
    response.end(content)
    return true
  } catch {
    return false
  }
}

function serveStaticOrSPA(response, pathname) {
  if (!existsSync(DIST_DIR)) {
    sendJson(response, 503, { error: "Game frontend not built. Run: npm run build" })
    return
  }

  // training-results/ files are written at runtime to public/ — serve them live, not from the stale dist/ copy
  if (pathname.startsWith("/training-results/")) {
    const liveFile = resolve(PUBLIC_TRAINING_DIR, pathname.replace(/^\/training-results\//, ""))
    if (serveStaticFile(response, liveFile)) return
  }

  // Exact file match
  const exactPath = resolve(DIST_DIR, pathname.replace(/^\//, ""))
  if (serveStaticFile(response, exactPath)) return

  // SPA fallback — determine which HTML entry point to serve
  // /game/*, /setup, / → index.html
  // /admin/* → admin.html
  // /training → training.html
  // /manual-training → manual-training.html
  // /compare → compare.html
  // /coach → coach.html
  let htmlFile = "index.html"
  if (pathname.startsWith("/admin")) htmlFile = "admin.html"
  else if (pathname.startsWith("/training")) htmlFile = "training.html"
  else if (pathname.startsWith("/manual-training")) htmlFile = "manual-training.html"
  else if (pathname.startsWith("/compare")) htmlFile = "compare.html"
  else if (pathname.startsWith("/coach")) htmlFile = "coach.html"

  const htmlPath = resolve(DIST_DIR, htmlFile)
  if (!serveStaticFile(response, htmlPath)) {
    sendJson(response, 404, { error: "Not found." })
  }
}

const TRAINED_WEIGHT_KEYS = [
  "vehiclePriorityBus",
  "vehiclePriorityTrain",
  "vehiclePriorityAir",
  "claimRailBaseScore",
  "claimAirBaseScore",
  "claimPopulationPerMillionScore",
  "claimNewCityBonus",
  "claimFirstModeBonus",
  "claimRailCostPenaltyPerMillion",
  "buyBusOwnedCityBonus",
  "buyTrainPotentialClaimBonus",
  "buyTrainFallbackOwnedCityBonus",
  "buyTrainNoClaimPenalty",
  "buyAirPotentialClaimBonus",
  "buyAirFallbackOwnedCityBonus",
  "buyAirNoClaimPenalty",
  "buyDuplicateVehiclePenalty",
  "buyFirstTrainBonus",
  "buyFirstAirBonus",
  "earlyExpansionMultiplier",
  "midExpansionMultiplier",
  "lateExpansionMultiplier",
  "earlyPopulationMultiplier",
  "midPopulationMultiplier",
  "latePopulationMultiplier",
  "earlyReadyOperationsScore",
  "midReadyOperationsScore",
  "lateReadyOperationsScore",
  "earlyClaimBudget",
  "midClaimBudget",
  "lateClaimBudget",
]
let activeTrainingProcess = null
let activeTrainingKillTimeoutId = null
let activeTrainingImportanceProcess = null
let activeAutotuneProcess = null
let trainingStatus = {
  status: "idle",
  args: null,
  pid: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  signal: null,
  outputPath: TRAINING_RESULTS_PATH,
  logs: [],
  progress: null,
}
let trainingImportanceStatus = {
  status: "idle",
  pid: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  signal: null,
  outputPath: TRAINING_IMPORTANCE_RESULTS_PATH,
  sourceTrainingGeneratedAt: null,
  error: null,
}
let autotuneControlStatus = {
  status: "idle",
  pid: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  signal: null,
  outputPath: AUTOTUNE_STATUS_PATH,
  logs: [],
  progress: null,
}

// --- Engine helpers ---

function getVehicleTypeForMode(mode) {
  switch (mode) {
    case 'rail':
      return 'train'
    case 'air':
      return 'air'
    case 'bus':
      return 'bus'
  }
}

function getAutoAssignableVehicleCardId(game, playerId, corridorId) {
  const player = game.players.find(candidate => candidate.id === playerId)
  const summary = buildPlayerBureaucracySummary(game, playerId)
  const routeMode =
    summary?.routePlans.find(plan => !plan.isDisconnected && plan.corridorId === corridorId)?.route.mode ?? null

  if (!player || !summary || routeMode === null) {
    return null
  }

  const assignedVehicleCardIds = new Set(
    summary.routePlans
      .map(plan => plan.vehicleCard?.id)
      .filter(cardId => cardId !== undefined),
  )

  return (
    player.ownedVehicleCardIds.find(cardId => {
      if (assignedVehicleCardIds.has(cardId)) {
        return false
      }

      return game.vehicleCatalog.find(card => card.id === cardId)?.type === getVehicleTypeForMode(routeMode)
    }) ?? null
  )
}

function hydrateServerGame(session) {
  const map = session.staticData.mapId === 'us' ? usMap : null
  if (!map) throw new Error(`Unsupported map: ${session.staticData.mapId}`)
  return normalizeGameState({
    map,
    cities: session.staticData.cities,
    operatingConfig: session.staticData.operatingConfig,
    chanceCatalog: session.staticData.chanceCatalog,
    vehicleCatalog: session.staticData.vehicleCatalog,
    routeCatalog: session.staticData.routeCatalog,
    ...session.game,
  })
}

function runServerBotTurns(game, session) {
  const botPlayerIds = new Set(
    session.lobby.players.filter(p => p.isBot).map(p => p.playerId),
  )

  // During auto-play, treat ALL players as bots until the target week is reached
  const isAutoPlaying = game.autoPlayUntilWeek > 0 && game.currentWeek <= game.autoPlayUntilWeek && !game.isGameOver
  const effectiveBotIds = isAutoPlaying
    ? new Set(game.players.map(p => p.id))
    : botPlayerIds

  if (effectiveBotIds.size === 0) return game

  let nextGame = game
  // Use a higher limit during auto-play to handle multi-month, multi-player games
  let safetyLimit = isAutoPlaying ? 10_000 : 1_000

  while (safetyLimit-- > 0) {
    const pendingBotId = getPendingBotPlayerId(nextGame, effectiveBotIds)
    if (!pendingBotId) break

    // Re-check auto-play condition after each tick (week may have advanced)
    const stillAutoPlaying = nextGame.autoPlayUntilWeek > 0 && nextGame.currentWeek <= nextGame.autoPlayUntilWeek && !nextGame.isGameOver
    const currentEffectiveBotIds = stillAutoPlaying ? new Set(nextGame.players.map(p => p.id)) : botPlayerIds
    const stillPending = getPendingBotPlayerId(nextGame, currentEffectiveBotIds)
    if (!stillPending) break

    const legalActions = getBotLegalActions(nextGame, stillPending)
    if (legalActions.length === 0) break

    const player = nextGame.players.find(p => p.id === stillPending)
    const bot = createPresetBotController(
      stillPending,
      player?.botPreset,
      nextGame.botPresetWeightsById,
    )
    const phase = player?.phase ?? nextGame.currentPhase
    const action = bot.pickAction({ game: nextGame, playerId: stillPending, legalActions, phase })
    nextGame = applyBotAction(nextGame, stillPending, action)
  }

  return nextGame
}

/**
 * After a game starts or an action is taken, if auto-play is still in progress,
 * schedule another bot pass on the next tick so the UI stays responsive.
 */
function scheduleAutoPlayContinuation(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return
  const game = session.game
  if (!game || !game.autoPlayUntilWeek || game.autoPlayUntilWeek <= 0) return
  if (game.isGameOver || game.currentWeek > game.autoPlayUntilWeek) return

  setTimeout(() => {
    const currentSession = sessions.get(sessionId)
    if (!currentSession) return
    try {
      const hydratedGame = hydrateServerGame(currentSession)
      if (hydratedGame.isGameOver || hydratedGame.currentWeek > hydratedGame.autoPlayUntilWeek) return
      const gameAfterBots = runServerBotTurns(hydratedGame, currentSession)
      const nextSession = {
        ...currentSession,
        version: currentSession.version + 1,
        updatedAt: new Date().toISOString(),
        game: dehydrateGame(gameAfterBots),
      }
      sessions.set(sessionId, nextSession)
      broadcastSession(sessionId)
      // Recurse in case one pass wasn't enough
      scheduleAutoPlayContinuation(sessionId)
    } catch (err) {
      console.error(`[auto-play] Continuation failed for session ${sessionId}:`, err)
    }
  }, 0)
}

function dehydrateGame(game) {
  const { map: _map, cities: _cities, operatingConfig: _oc, chanceCatalog: _cc, vehicleCatalog: _vc, routeCatalog: _rc, ...mutableGame } = game
  return mutableGame
}

function canPlayerAct(game, playerId, session) {
  if (!playerId) return false

  // Reject bot impersonation — bots are run server-side only
  const lobbyPlayer = session.lobby.players.find(p => p.playerId === playerId)
  if (!lobbyPlayer || lobbyPlayer.isBot) return false

  // During auto-play, all seats are controlled by bots — block human actions
  if (game.autoPlayUntilWeek > 0 && game.currentWeek <= game.autoPlayUntilWeek && !game.isGameOver) {
    return false
  }

  const player = game.players.find(p => p.id === playerId)
  if (!player) return false

  switch (player.phase) {
    case 'purchase-equipment':
      return canPlayerStartPhaseByPipeline(game, playerId, 'purchase-equipment')
    case 'add-city':
      return canPlayerPickCities(game, playerId) || canPlayerEditOperations(game, playerId)
    case 'operations':
      return canPlayerEditOperations(game, playerId)
    case 'bureaucracy':
      return !hasPlayerCompletedBureaucracy(game, playerId)
    default:
      return false
  }
}

function applyGameAction(game, playerId, action) {
  switch (action.type) {
    case 'advance-turn': {
      let g = game
      // Apply pending city selection sent by client (kept local on client, synced only on confirm)
      if (action.keptCityIds && g.activeCityOffer && g.activeCityOffer.playerId === playerId) {
        const keptResult = setActiveCityOfferKeptCityIds(g, action.keptCityIds, playerId)
        if (!keptResult.ok) throw new Error(keptResult.error)
        g = keptResult.game
      }
      if (canPlayerPickCities(g, playerId)) {
        const result = confirmAddCityPicks(g, playerId)
        if (!result.ok) throw new Error(result.error)
        return result.game
      }
      if (canPlayerEditOperations(g, playerId)) {
        const result = markOperationsReady(g, playerId)
        if (!result.ok) throw new Error(result.error)
        return result.game
      }
      if (
        (g.currentPhase === 'bureaucracy' || hasPlayerCompletedOperations(g, playerId)) &&
        !hasPlayerCompletedBureaucracy(g, playerId)
      ) {
        const result = markBureaucracyReady(g, playerId)
        if (!result.ok) throw new Error(result.error)
        return result.game
      }
      return advanceTurn(g, playerId)
    }
    case 'buy-vehicle': {
      // Human buy-vehicle also auto-advances turn (bot buy-vehicle does not)
      const result = buyVehicleCard(game, action.cardId, action.quantity, playerId)
      if (!result.ok) throw new Error(result.error)
      return advanceTurn(result.game, playerId)
    }
    case 'exchange-vehicle': {
      const result = exchangeVehicleCard(game, action.newCardId, action.oldCardId, playerId)
      if (!result.ok) throw new Error(result.error)
      return advanceTurn(result.game, playerId)
    }
    case 'stop-auto-play': {
      return { ...game, autoPlayUntilWeek: 0, turnTimerExpiresAt: null }
    }
    case 'set-route-vehicle': {
      const result = setBureaucracyRouteVehicleCard(game, action.routeId, action.vehicleCardId, playerId)
      if (!result.ok) throw new Error(result.error)
      return result.game
    }
    case 'set-service-pod-cities': {
      const result = setBureaucracyServicePodCities(
        game,
        action.corridorId,
        action.routeIds,
        action.cityIds,
        playerId,
      )
      if (!result.ok) throw new Error(result.error)
      return result.game
    }
    case 'add-service-split': {
      const nextSlotIndex = Math.max(1, game.bureaucracyServiceSlotCountsByCorridorId[action.corridorId] ?? 1)
      const newRouteId = buildServiceSlotId(action.corridorId, nextSlotIndex)
      const autoAssignableVehicleCardId = getAutoAssignableVehicleCardId(game, playerId, action.corridorId)
      const result = addBureaucracyServiceSplit(game, action.corridorId, playerId, action.initialCityIds ?? undefined)
      if (!result.ok) throw new Error(result.error)
      if (!autoAssignableVehicleCardId) {
        return result.game
      }

      const vehicleAssignmentResult = setBureaucracyRouteVehicleCard(
        result.game,
        newRouteId,
        autoAssignableVehicleCardId,
        playerId,
      )
      if (!vehicleAssignmentResult.ok) throw new Error(vehicleAssignmentResult.error)
      return vehicleAssignmentResult.game
    }
    case 'move-service-city': {
      const result = moveBureaucracyServiceCity(game, action.corridorId, action.cityId, action.routeId, action.sourceRouteId, playerId)
      if (!result.ok) throw new Error(result.error)
      return result.game
    }
    case 'delete-service-pod': {
      const result = deleteBureaucracyServicePod(game, action.corridorId, action.routeId, playerId)
      if (!result.ok) throw new Error(result.error)
      return result.game
    }
    case 'upgrade-rail': {
      const result = upgradeRailRoute(game, action.routeId, playerId)
      if (!result.ok) throw new Error(result.error)
      return result.game
    }
    default:
      // claim-route: handle explicitly to support bus mode and segmentPairs (not in BotAction)
      if (action.type === 'claim-route') {
        const result = claimRoute(game, { mode: action.mode, cityIds: action.cityIds, segmentPairs: action.segmentPairs }, playerId)
        if (!result.ok) throw new Error(result.error)
        return result.game
      }
      // All remaining BotAction types (draw-city-offer, keep-city-offer, confirm-add-city-picks,
      // create-service-pod, remove-pod-city, ready-operations, ready-bureaucracy, end-turn)
      return applyBotAction(game, playerId, action)
  }
}

// ---

function isLoopbackRemoteAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  )
}

function isLocalTrainingRequest(request) {
  return isLoopbackRemoteAddress(request.socket.remoteAddress ?? "")
}

function appendTrainingLog(line) {
  const trimmedLine = line.trim()

  if (!trimmedLine) {
    return
  }

  trainingStatus.logs = [...trainingStatus.logs, `[${new Date().toISOString()}] ${trimmedLine}`].slice(-TRAINING_LOG_LIMIT)
}

function getTrainingStatusPayload() {
  return {
    ...trainingStatus,
    isRunning: activeTrainingProcess !== null,
  }
}

function readTrainingResults() {
  if (!existsSync(TRAINING_RESULTS_PATH)) {
    return null
  }

  try {
    const parsedValue = JSON.parse(readFileSync(TRAINING_RESULTS_PATH, "utf8"))
    return isRecord(parsedValue) ? parsedValue : null
  } catch {
    return null
  }
}

function readTrainingImportanceResults() {
  if (!existsSync(TRAINING_IMPORTANCE_RESULTS_PATH)) {
    return null
  }

  try {
    const parsedValue = JSON.parse(readFileSync(TRAINING_IMPORTANCE_RESULTS_PATH, "utf8"))

    if (
      !isRecord(parsedValue) ||
      typeof parsedValue.generatedAt !== "string" ||
      typeof parsedValue.sourceTrainingGeneratedAt !== "string" ||
      !isRecord(parsedValue.reference) ||
      !Array.isArray(parsedValue.rows) ||
      !isRecord(parsedValue.config)
    ) {
      return null
    }

    return parsedValue
  } catch {
    return null
  }
}

function getTrainingImportancePayload() {
  return {
    ...trainingImportanceStatus,
    isRunning: activeTrainingImportanceProcess !== null,
    result: readTrainingImportanceResults(),
  }
}

function appendAutotuneLog(line) {
  const trimmedLine = line.trim()

  if (!trimmedLine) {
    return
  }

  autotuneControlStatus.logs = [...autotuneControlStatus.logs, `[${new Date().toISOString()}] ${trimmedLine}`].slice(
    -TRAINING_LOG_LIMIT,
  )
}

function updateIterationProgress(targetStatus, payload) {
  targetStatus.progress = {
    currentIteration: Math.max(0, Math.trunc(payload.iteration)),
    totalIterations: Math.max(1, Math.trunc(payload.totalIterations)),
    temperature: isFiniteNumber(payload.temperature) ? payload.temperature : null,
    bestScore: isFiniteNumber(payload.bestScore) ? payload.bestScore : null,
    candidateScore: isFiniteNumber(payload.candidateScore) ? payload.candidateScore : null,
  }
}

function handleTrainingOutputLine(line) {
  appendTrainingLog(line)

  try {
    const parsedValue = JSON.parse(line)

    if (
      isRecord(parsedValue) &&
      parsedValue.stage === "iteration-progress" &&
      isFiniteNumber(parsedValue.iteration) &&
      isFiniteNumber(parsedValue.totalIterations)
    ) {
      updateIterationProgress(trainingStatus, parsedValue)
    }
  } catch {}
}

function handleAutotuneOutputLine(line) {
  appendAutotuneLog(line)

  try {
    const parsedValue = JSON.parse(line)

    if (!isRecord(parsedValue) || typeof parsedValue.stage !== "string") {
      return
    }

    if (parsedValue.stage === "cycle-start" && isFiniteNumber(parsedValue.iterations)) {
      autotuneControlStatus.progress = {
        currentIteration: 0,
        totalIterations: Math.max(1, Math.trunc(parsedValue.iterations)),
        temperature: null,
        bestScore: null,
        candidateScore: null,
      }
      return
    }

    if (
      parsedValue.stage === "iteration-progress" &&
      isFiniteNumber(parsedValue.iteration) &&
      isFiniteNumber(parsedValue.totalIterations)
    ) {
      updateIterationProgress(autotuneControlStatus, parsedValue)
      return
    }

    if (parsedValue.stage === "cycle-finish" && autotuneControlStatus.progress) {
      autotuneControlStatus.progress = {
        ...autotuneControlStatus.progress,
        currentIteration: autotuneControlStatus.progress.totalIterations,
      }
    }
  } catch {}
}

function readAutotuneStatusFile() {
  if (!existsSync(AUTOTUNE_STATUS_PATH)) {
    return null
  }

  try {
    const parsedValue = JSON.parse(readFileSync(AUTOTUNE_STATUS_PATH, "utf8"))
    return isRecord(parsedValue) ? parsedValue : null
  } catch {
    return null
  }
}

function readChronicle() {
  if (!existsSync(TRAINING_CHRONICLE_PATH)) {
    return { version: 1, ruleChanges: [], pastChampions: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(TRAINING_CHRONICLE_PATH, "utf8"))
    if (!isRecord(parsed) || parsed.version !== 1) {
      return { version: 1, ruleChanges: [], pastChampions: [] }
    }
    return {
      version: 1,
      ruleChanges: Array.isArray(parsed.ruleChanges) ? parsed.ruleChanges : [],
      pastChampions: Array.isArray(parsed.pastChampions) ? parsed.pastChampions : [],
    }
  } catch {
    return { version: 1, ruleChanges: [], pastChampions: [] }
  }
}

function writeChronicle(chronicle) {
  mkdirSync(dirname(TRAINING_CHRONICLE_PATH), { recursive: true })
  const tmp = `${TRAINING_CHRONICLE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(chronicle, null, 2))
  renameSync(tmp, TRAINING_CHRONICLE_PATH)
}

function writeAutotuneStatusFile(status) {
  mkdirSync(dirname(AUTOTUNE_STATUS_PATH), { recursive: true })
  const temporaryPath = `${AUTOTUNE_STATUS_PATH}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(status, null, 2))
  renameSync(temporaryPath, AUTOTUNE_STATUS_PATH)
}

function clearAutotuneCurrentRun(logMessage) {
  const existingAutotuneStatus = readAutotuneStatusFile()

  if (!isRecord(existingAutotuneStatus) || !isRecord(existingAutotuneStatus.currentRun)) {
    return false
  }

  writeAutotuneStatusFile({
    ...existingAutotuneStatus,
    currentRun: null,
    updatedAt: new Date().toISOString(),
  })

  if (logMessage) {
    appendAutotuneLog(logMessage)
  }

  return true
}

function findDetachedAutotuneProcess() {
  const result = spawnSync("ps", ["-Ao", "pid=,command="], {
    encoding: "utf8",
  })

  if (result.status !== 0) {
    return null
  }

  const processLine = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.includes(AUTOTUNE_SCRIPT_PATH) || line.includes("scripts/autotuneBots.ts"))

  if (!processLine) {
    return null
  }

  const [rawPid] = processLine.split(/\s+/, 1)
  const pid = Number.parseInt(rawPid ?? "", 10)
  return Number.isFinite(pid) ? pid : null
}

function reconcileAutotuneRunState() {
  const existingAutotuneStatus = readAutotuneStatusFile()

  if (!isRecord(existingAutotuneStatus) || !isRecord(existingAutotuneStatus.currentRun)) {
    return { hasExternalRun: false, recoveredStaleRun: false }
  }

  if (activeAutotuneProcess !== null) {
    return { hasExternalRun: false, recoveredStaleRun: false }
  }

  const detachedPid = findDetachedAutotuneProcess()

  if (detachedPid !== null) {
    return { hasExternalRun: true, recoveredStaleRun: false }
  }

  clearAutotuneCurrentRun("Recovered from a stale autotune status file by clearing a run with no live process.")
  if (autotuneControlStatus.status === "unknown") {
    autotuneControlStatus = {
      ...autotuneControlStatus,
      status: "idle",
      pid: null,
      progress: null,
    }
  }
  return { hasExternalRun: false, recoveredStaleRun: true }
}

function tryDeleteStopSignalFile() {
  try { unlinkSync(AUTOTUNE_STOP_SIGNAL_PATH) } catch { /* already gone */ }
}

function forceStopAutotuneProcess() {
  tryDeleteStopSignalFile()
  const detachedPid = activeAutotuneProcess === null ? findDetachedAutotuneProcess() : null

  if (activeAutotuneProcess) {
    autotuneControlStatus = {
      ...autotuneControlStatus,
      status: "stopping",
    }
    appendAutotuneLog("Force stop requested. Sending SIGKILL to the live autotune process and clearing the status file lock.")
    activeAutotuneProcess.kill("SIGKILL")
    clearAutotuneCurrentRun("Cleared autotune currentRun after force stop was requested.")
    return
  }

  if (detachedPid !== null) {
    try {
      process.kill(detachedPid, "SIGKILL")
    } catch {
      clearAutotuneCurrentRun("Cleared an autotune status lock after the detached process was already gone.")
      autotuneControlStatus = {
        ...autotuneControlStatus,
        status: "idle",
        pid: null,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        progress: null,
      }
      return
    }
    clearAutotuneCurrentRun(`Force-stopped detached autotune process ${detachedPid} and cleared the status file lock.`)
    autotuneControlStatus = {
      ...autotuneControlStatus,
      status: "idle",
      pid: null,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: "SIGKILL",
      progress: null,
    }
    return
  }

  const clearedStaleRun = clearAutotuneCurrentRun("Force-cleared a stale autotune status file lock.")

  if (clearedStaleRun || autotuneControlStatus.status === "unknown") {
    autotuneControlStatus = {
      ...autotuneControlStatus,
      status: "idle",
      pid: null,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      progress: null,
    }
    return
  }

  const error = new Error("No autotune process or stale lock is present to force stop.")
  error.statusCode = 409
  throw error
}

function getAutotuneControlStatusPayload() {
  const autotuneRunState = reconcileAutotuneRunState()

  if (activeAutotuneProcess === null && autotuneRunState.hasExternalRun) {
    return {
      ...autotuneControlStatus,
      status: "unknown",
      isRunning: false,
    }
  }

  return {
    ...autotuneControlStatus,
    isRunning: activeAutotuneProcess !== null,
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
}

function isValidWeights(value) {
  return isRecord(value) && TRAINED_WEIGHT_KEYS.every(key => isFiniteNumber(value[key]))
}

function getTrainingPresetPayload() {
  return {
    outputPath: MANAGED_BOT_PRESETS_PATH,
    presets: readManagedBotPresetStore()?.presets ?? {},
  }
}

function normalizeManagedPresetStorageId(presetId, sourcePlayerCount) {
  if (presetId === "bot-avg") {
    return "bot-avg"
  }

  if (MANAGED_BOT_PRESET_STORAGE_IDS.includes(presetId)) {
    return presetId
  }

  if (presetId === "bot-best" && (sourcePlayerCount === 1 || sourcePlayerCount === 2 || sourcePlayerCount === 3 || sourcePlayerCount === 4)) {
    return `bot-best-${sourcePlayerCount}p`
  }

  return null
}

function resolveManagedPresetStorageId(presetId, playerCount) {
  if (presetId === "bot-avg") {
    return "bot-avg"
  }

  if (presetId === "bot-best" && (playerCount === 1 || playerCount === 2 || playerCount === 3 || playerCount === 4)) {
    return `bot-best-${playerCount}p`
  }

  if (MANAGED_BOT_PRESET_STORAGE_IDS.includes(presetId)) {
    return presetId
  }

  return null
}

function readManagedBotPresetStore() {
  if (!existsSync(MANAGED_BOT_PRESETS_PATH)) {
    return null
  }

  try {
    const parsedValue = JSON.parse(readFileSync(MANAGED_BOT_PRESETS_PATH, "utf8"))

    if (
      !isRecord(parsedValue) ||
      parsedValue.version !== 1 ||
      typeof parsedValue.updatedAt !== "string" ||
      !isRecord(parsedValue.presets)
    ) {
      return null
    }

    return {
      version: 1,
      updatedAt: parsedValue.updatedAt,
      presets: Object.fromEntries(
        Object.keys(parsedValue.presets).flatMap(presetId => {
          const preset = parsedValue.presets[presetId]

          if (!preset) {
            return []
          }

          const normalizedPresetId = normalizeManagedPresetStorageId(
            presetId,
            isRecord(preset.sourceConfig) && isFiniteNumber(preset.sourceConfig.playerCount)
              ? preset.sourceConfig.playerCount
              : undefined,
          )

          if (
            !isRecord(preset) ||
            !normalizedPresetId ||
            typeof preset.promotedAt !== "string" ||
            typeof preset.sourceTrainingGeneratedAt !== "string" ||
            !isValidWeights(preset.weights) ||
            !isRecord(preset.sourceSummary) ||
            !isRecord(preset.sourceConfig)
          ) {
            return []
          }

          return [[normalizedPresetId, {
            presetId: normalizedPresetId,
            promotedAt: preset.promotedAt,
            sourceTrainingGeneratedAt: preset.sourceTrainingGeneratedAt,
            weights: preset.weights,
            sourceSummary: preset.sourceSummary,
            sourceConfig: preset.sourceConfig,
          }]]
        }),
      ),
    }
  } catch {
    return null
  }
}

function writeManagedBotPresetStore(store) {
  mkdirSync(dirname(MANAGED_BOT_PRESETS_PATH), { recursive: true })
  const temporaryPath = `${MANAGED_BOT_PRESETS_PATH}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(store, null, 2))
  renameSync(temporaryPath, MANAGED_BOT_PRESETS_PATH)
}

function buildManagedPresetEntry(storagePresetId, trainingResults, promotedAt = new Date().toISOString()) {
  return {
    presetId: storagePresetId,
    weights: trainingResults.final.weights,
    promotedAt,
    sourceTrainingGeneratedAt: trainingResults.generatedAt,
    sourceSummary: {
      score: trainingResults.final.score,
      winRate: trainingResults.final.winRate,
      averageRank: trainingResults.final.averageRank,
      averagePassengers: trainingResults.final.averagePassengers,
      averagePassengerMargin: trainingResults.final.averagePassengerMargin,
      averageConnectedCities: trainingResults.final.averageConnectedCities,
      averageMoney: trainingResults.final.averageMoney,
      timeoutRate: trainingResults.final.timeoutRate,
      sampleCount: trainingResults.final.sampleCount,
    },
    sourceConfig: {
      iterations: trainingResults.config.iterations,
      gamesPerCandidate: trainingResults.config.gamesPerCandidate,
      playerCount: trainingResults.config.playerCount ?? 4,
      baseSeed: trainingResults.config.baseSeed,
      candidatesPerIteration: trainingResults.config.candidatesPerIteration,
      mutationSeed: trainingResults.config.mutationSeed,
      maxSteps: trainingResults.config.maxSteps,
      outputPath: trainingResults.config.outputPath,
    },
  }
}

function readAutotuneHistoryFile() {
  if (!existsSync(AUTOTUNE_HISTORY_PATH)) {
    return null
  }

  try {
    const parsedValue = JSON.parse(readFileSync(AUTOTUNE_HISTORY_PATH, "utf8"))
    return isRecord(parsedValue) ? parsedValue : null
  } catch {
    return null
  }
}

function promoteLatestTrainingResultsToPreset(presetId) {
  if (activeTrainingProcess) {
    const error = new Error("Cannot promote training results while training is still running.")
    error.statusCode = 409
    throw error
  }

  if (presetId !== "bot-best" && presetId !== "bot-avg") {
    const error = new Error("Only Malcolm Gladwell or Stickbug can be overwritten from training results right now.")
    error.statusCode = 400
    throw error
  }

  if (!existsSync(TRAINING_RESULTS_PATH)) {
    const error = new Error("No training results file exists yet. Run training first.")
    error.statusCode = 404
    throw error
  }

  let trainingResults

  try {
    trainingResults = JSON.parse(readFileSync(TRAINING_RESULTS_PATH, "utf8"))
  } catch {
    const error = new Error("The latest training results file could not be read.")
    error.statusCode = 500
    throw error
  }

  if (
    !isRecord(trainingResults) ||
    typeof trainingResults.generatedAt !== "string" ||
    !isRecord(trainingResults.config) ||
    !isRecord(trainingResults.final) ||
    !isValidWeights(trainingResults.final.weights)
  ) {
    const error = new Error("The latest training results file does not contain a complete final preset.")
    error.statusCode = 422
    throw error
  }

  const promotedAt = new Date().toISOString()
  const storagePresetId = resolveManagedPresetStorageId(presetId, trainingResults.config.playerCount)

  if (!storagePresetId) {
    const error = new Error(`Stickbug only supports managed variants for 2-player, 3-player, or 4-player runs right now.`)
    error.statusCode = 422
    throw error
  }

  const nextStore = {
    version: 1,
    updatedAt: promotedAt,
    presets: {
      ...(readManagedBotPresetStore()?.presets ?? {}),
      [storagePresetId]: buildManagedPresetEntry(storagePresetId, trainingResults, promotedAt),
    },
  }

  writeManagedBotPresetStore(nextStore)
  appendTrainingLog(`Promoted the latest training results into preset "${storagePresetId}".`)
  return nextStore
}

function findAutotuneRunForPromotion(playerCount, generatedAt) {
  const sources = [
    ...(Array.isArray(readAutotuneStatusFile()?.recentRuns) ? readAutotuneStatusFile().recentRuns : []),
    ...(Array.isArray(readAutotuneHistoryFile()?.runs) ? readAutotuneHistoryFile().runs : []),
  ]
  const matchingRun = sources.find(run =>
    isRecord(run) &&
    run.playerCount === playerCount &&
    run.generatedAt === generatedAt &&
    isRecord(run.final) &&
    isValidWeights(run.final.weights),
  )

  if (matchingRun) {
    return {
      generatedAt,
      config: {
        iterations: 0,
        gamesPerCandidate: 0,
        playerCount,
        baseSeed: 0,
        candidatesPerIteration: 0,
        mutationSeed: 0,
        maxSteps: 0,
        outputPath: AUTOTUNE_HISTORY_PATH,
      },
      final: {
        ...matchingRun.final,
        weights: matchingRun.final.weights,
        averageConnectedCities: 0,
        averageMoney: 0,
        timeoutRate: 0,
      },
    }
  }

  const latestModeResultsPath = resolve(PROJECT_ROOT, `public/training-results/latest-${playerCount}p.json`)

  if (!existsSync(latestModeResultsPath)) {
    return null
  }

  try {
    const latestModeResults = JSON.parse(readFileSync(latestModeResultsPath, "utf8"))

    if (
      isRecord(latestModeResults) &&
      latestModeResults.generatedAt === generatedAt &&
      isRecord(latestModeResults.config) &&
      isRecord(latestModeResults.final) &&
      isValidWeights(latestModeResults.final.weights)
    ) {
      return latestModeResults
    }
  } catch {}

  return null
}

function promoteAutotuneRunToStickbug(playerCount, generatedAt) {
  const storagePresetId = resolveManagedPresetStorageId("bot-best", playerCount)

  if (!storagePresetId) {
    const error = new Error("Stickbug autotune promotions only support 1-player through 4-player runs.")
    error.statusCode = 422
    throw error
  }

  const trainingResults = findAutotuneRunForPromotion(playerCount, generatedAt)

  if (!trainingResults || !isRecord(trainingResults.final) || !isValidWeights(trainingResults.final.weights)) {
    const error = new Error("That autotune run no longer has promotable weights available.")
    error.statusCode = 404
    throw error
  }

  const promotedAt = new Date().toISOString()
  const nextStore = {
    version: 1,
    updatedAt: promotedAt,
    presets: {
      ...(readManagedBotPresetStore()?.presets ?? {}),
      [storagePresetId]: buildManagedPresetEntry(storagePresetId, trainingResults, promotedAt),
    },
  }

  writeManagedBotPresetStore(nextStore)
  appendAutotuneLog(`Promoted autotune run ${generatedAt} into preset "${storagePresetId}".`)
  return nextStore
}

function isValidTrainingStartPayload(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.iterations === "number" &&
    Number.isFinite(value.iterations) &&
    typeof value.gamesPerCandidate === "number" &&
    Number.isFinite(value.gamesPerCandidate) &&
    typeof value.playerCount === "number" &&
    Number.isFinite(value.playerCount) &&
    typeof value.baseSeed === "number" &&
    Number.isFinite(value.baseSeed) &&
    typeof value.candidatesPerIteration === "number" &&
    Number.isFinite(value.candidatesPerIteration) &&
    typeof value.mutationSeed === "number" &&
    Number.isFinite(value.mutationSeed) &&
    typeof value.maxSteps === "number" &&
    Number.isFinite(value.maxSteps)
  )
}

function isValidTrainingPresetPromotionPayload(value) {
  return isRecord(value) && (value.presetId === "bot-best" || value.presetId === "bot-avg")
}

function isValidAutotuneRunPresetPromotionPayload(value) {
  return (
    isRecord(value) &&
    isFiniteNumber(value.playerCount) &&
    typeof value.generatedAt === "string"
  )
}

function normalizeTrainingArgs(body) {
  const args = {
    iterations: Math.trunc(body.iterations),
    gamesPerCandidate: Math.trunc(body.gamesPerCandidate),
    playerCount: Math.trunc(body.playerCount),
    baseSeed: Math.trunc(body.baseSeed),
    candidatesPerIteration: Math.trunc(body.candidatesPerIteration),
    mutationSeed: Math.trunc(body.mutationSeed),
    maxSteps: Math.trunc(body.maxSteps),
  }

  if (
    args.iterations < 1 ||
    args.gamesPerCandidate < 1 ||
    args.playerCount < 1 ||
    args.playerCount > 4 ||
    args.candidatesPerIteration < 1 ||
    args.maxSteps < 1
  ) {
    const error = new Error("Training parameters must be positive integers, and player count must be between 1 and 4.")
    error.statusCode = 400
    throw error
  }

  if (
    args.iterations > 200 ||
    args.gamesPerCandidate > 50 ||
    args.candidatesPerIteration > 20 ||
    args.maxSteps > 5000
  ) {
    const error = new Error("Training parameters exceed safe local limits.")
    error.statusCode = 400
    throw error
  }

  return args
}

function startTrainingProcess(args) {
  if (activeTrainingProcess) {
    const error = new Error("Training is already running.")
    error.statusCode = 409
    throw error
  }

  if (activeAutotuneProcess) {
    const error = new Error("Autotune is already running. Stop it before starting a manual training run.")
    error.statusCode = 409
    throw error
  }

  const autotuneRunState = reconcileAutotuneRunState()

  if (autotuneRunState.hasExternalRun) {
    const error = new Error("Autotune may still be running from a previous server session. Verify it is stopped before starting a manual training run.")
    error.statusCode = 409
    throw error
  }

  trainingStatus = {
    status: "running",
    args,
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    outputPath: TRAINING_RESULTS_PATH,
    logs: [
      `[${new Date().toISOString()}] Starting training run with args ${JSON.stringify(args)}`,
    ],
    progress: {
      currentIteration: 0,
      totalIterations: args.iterations,
      temperature: null,
      bestScore: null,
      candidateScore: null,
    },
  }
  trainingImportanceStatus = {
    status: "idle",
    pid: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    outputPath: TRAINING_IMPORTANCE_RESULTS_PATH,
    sourceTrainingGeneratedAt: null,
    error: null,
  }

  const child = spawn(
    process.execPath,
    [
      TSX_CLI_PATH,
      TRAINING_SCRIPT_PATH,
      String(args.iterations),
      String(args.gamesPerCandidate),
      String(args.playerCount),
      String(args.baseSeed),
      String(args.candidatesPerIteration),
      String(args.mutationSeed),
      String(args.maxSteps),
    ],
    {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  activeTrainingProcess = child
  trainingStatus.pid = child.pid ?? null
  let stdoutRemainder = ""
  let stderrRemainder = ""

  child.stdout.on("data", chunk => {
    const combinedOutput = stdoutRemainder + chunk.toString("utf8")
    const lines = combinedOutput.split(/\r?\n/)
    stdoutRemainder = lines.pop() ?? ""
    lines.forEach(handleTrainingOutputLine)
  })

  child.stderr.on("data", chunk => {
    const combinedOutput = stderrRemainder + chunk.toString("utf8")
    const lines = combinedOutput.split(/\r?\n/)
    stderrRemainder = lines.pop() ?? ""
    lines.forEach(line => appendTrainingLog(`stderr: ${line}`))
  })

  child.on("error", error => {
    appendTrainingLog(`Failed to launch training: ${error.message}`)
  })

  child.on("exit", (exitCode, signal) => {
    if (stdoutRemainder) {
      appendTrainingLog(stdoutRemainder)
    }

    if (stderrRemainder) {
      appendTrainingLog(`stderr: ${stderrRemainder}`)
    }

    if (activeTrainingKillTimeoutId) {
      clearTimeout(activeTrainingKillTimeoutId)
      activeTrainingKillTimeoutId = null
    }

    activeTrainingProcess = null
    trainingStatus = {
      ...trainingStatus,
      status:
        trainingStatus.status === "cancelled"
          ? "cancelled"
          : exitCode === 0
            ? "completed"
            : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      pid: null,
      progress:
        exitCode === 0 && trainingStatus.progress
          ? {
              ...trainingStatus.progress,
              currentIteration: trainingStatus.progress.totalIterations,
            }
          : trainingStatus.progress,
    }
    appendTrainingLog(
      trainingStatus.status === "completed"
        ? "Training finished successfully."
        : trainingStatus.status === "cancelled"
          ? "Training was cancelled."
          : `Training exited with code ${exitCode ?? "unknown"}${signal ? ` (${signal})` : ""}.`,
    )
  })
}

function startTrainingImportanceProcess() {
  if (activeTrainingProcess) {
    const error = new Error("Wait for the active training run to finish before analyzing lever importance.")
    error.statusCode = 409
    throw error
  }

  if (activeTrainingImportanceProcess) {
    return
  }

  const trainingResults = readTrainingResults()

  if (!trainingResults || typeof trainingResults.generatedAt !== "string") {
    const error = new Error("No completed training results are available to analyze yet.")
    error.statusCode = 404
    throw error
  }

  const cachedImportance = readTrainingImportanceResults()

  if (cachedImportance?.sourceTrainingGeneratedAt === trainingResults.generatedAt) {
    trainingImportanceStatus = {
      ...trainingImportanceStatus,
      status: "completed",
      pid: null,
      startedAt: trainingImportanceStatus.startedAt,
      finishedAt: trainingImportanceStatus.finishedAt ?? cachedImportance.generatedAt,
      exitCode: 0,
      signal: null,
      sourceTrainingGeneratedAt: trainingResults.generatedAt,
      error: null,
    }
    return
  }

  trainingImportanceStatus = {
    status: "running",
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    outputPath: TRAINING_IMPORTANCE_RESULTS_PATH,
    sourceTrainingGeneratedAt: trainingResults.generatedAt,
    error: null,
  }

  const child = spawn(
    process.execPath,
    [TSX_CLI_PATH, TRAINING_IMPORTANCE_SCRIPT_PATH],
    {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  activeTrainingImportanceProcess = child
  trainingImportanceStatus.pid = child.pid ?? null
  let stderrOutput = ""

  child.stdout.on("data", () => {})
  child.stderr.on("data", chunk => {
    stderrOutput += chunk.toString("utf8")
  })

  child.on("exit", (exitCode, signal) => {
    activeTrainingImportanceProcess = null
    trainingImportanceStatus = {
      ...trainingImportanceStatus,
      status: exitCode === 0 ? "completed" : "failed",
      pid: null,
      finishedAt: new Date().toISOString(),
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      error:
        exitCode === 0
          ? null
          : stderrOutput.trim() || `Importance analysis exited with code ${exitCode ?? "unknown"}.`,
    }
  })
}

function cancelTrainingProcess() {
  if (!activeTrainingProcess) {
    const error = new Error("No training process is currently running.")
    error.statusCode = 409
    throw error
  }

  trainingStatus = {
    ...trainingStatus,
    status: "cancelled",
  }
  appendTrainingLog("Cancellation requested.")
  activeTrainingProcess.kill("SIGTERM")
  activeTrainingKillTimeoutId = setTimeout(() => {
    if (activeTrainingProcess) {
      appendTrainingLog("Training did not stop after SIGTERM; sending SIGKILL.")
      activeTrainingProcess.kill("SIGKILL")
    }
  }, 2000)
}

function startAutotuneProcess() {
  if (activeAutotuneProcess) {
    const error = new Error("Autotune is already running.")
    error.statusCode = 409
    throw error
  }

  if (activeTrainingProcess) {
    const error = new Error("A manual training run is already running. Wait for it to finish before starting autotune.")
    error.statusCode = 409
    throw error
  }

  const autotuneRunState = reconcileAutotuneRunState()

  if (autotuneRunState.hasExternalRun) {
    autotuneControlStatus = {
      ...autotuneControlStatus,
      status: "unknown",
      logs: [
        ...autotuneControlStatus.logs,
        `[${new Date().toISOString()}] Autotune status file still shows an active run. Verify no older autotune process is still running before starting another one.`,
      ].slice(-TRAINING_LOG_LIMIT),
    }
    const error = new Error("Autotune may still be running from a previous server session. Verify it is stopped before starting another autotune loop.")
    error.statusCode = 409
    throw error
  }

  autotuneControlStatus = {
    status: "running",
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    outputPath: AUTOTUNE_STATUS_PATH,
    logs: [`[${new Date().toISOString()}] Starting autotune loop.`],
    progress: null,
  }

  const child = spawn(process.execPath, [TSX_CLI_PATH, AUTOTUNE_SCRIPT_PATH], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  activeAutotuneProcess = child
  autotuneControlStatus.pid = child.pid ?? null
  let stdoutRemainder = ""
  let stderrRemainder = ""

  child.stdout.on("data", chunk => {
    const combinedOutput = stdoutRemainder + chunk.toString("utf8")
    const lines = combinedOutput.split(/\r?\n/)
    stdoutRemainder = lines.pop() ?? ""
    lines.forEach(handleAutotuneOutputLine)
  })

  child.stderr.on("data", chunk => {
    const combinedOutput = stderrRemainder + chunk.toString("utf8")
    const lines = combinedOutput.split(/\r?\n/)
    stderrRemainder = lines.pop() ?? ""
    lines.forEach(line => appendAutotuneLog(`stderr: ${line}`))
  })

  child.on("error", error => {
    appendAutotuneLog(`Failed to launch autotune: ${error.message}`)
  })

  child.on("exit", (exitCode, signal) => {
    if (stdoutRemainder) {
      appendAutotuneLog(stdoutRemainder)
    }

    if (stderrRemainder) {
      appendAutotuneLog(`stderr: ${stderrRemainder}`)
    }

    activeAutotuneProcess = null
    autotuneControlStatus = {
      ...autotuneControlStatus,
      status:
        autotuneControlStatus.status === "stopping"
          ? "completed"
          : exitCode === 0
            ? "completed"
            : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      pid: null,
      progress: null,
    }
    appendAutotuneLog(
      autotuneControlStatus.status === "completed"
        ? "Autotune loop stopped."
        : `Autotune exited with code ${exitCode ?? "unknown"}${signal ? ` (${signal})` : ""}.`,
    )
  })
}

function stopAutotuneProcess() {
  if (!activeAutotuneProcess) {
    const error = new Error("No autotune process is currently running.")
    error.statusCode = 409
    throw error
  }

  if (autotuneControlStatus.status === "stopping") {
    return
  }

  autotuneControlStatus = {
    ...autotuneControlStatus,
    status: "stopping",
    progress: autotuneControlStatus.progress,
  }
  appendAutotuneLog("Stop requested. The autotune loop will exit after the current cycle finishes.")
  // Write a stop-signal file. The autotune loop polls this file between cycles
  // and exits cleanly after the current cycle finishes.
  // We do NOT send SIGINT — on Windows that kills the process immediately.
  try {
    writeFileSync(AUTOTUNE_STOP_SIGNAL_PATH, new Date().toISOString())
  } catch {
    // non-fatal
  }
}

function getInterfaceLanAddresses() {
  const interfaces = networkInterfaces()
  const addresses = []

  for (const interfaceAddresses of Object.values(interfaces)) {
    for (const addressInfo of interfaceAddresses ?? []) {
      if (
        addressInfo.family === "IPv4" &&
        !addressInfo.internal &&
        typeof addressInfo.address === "string" &&
        !addresses.includes(addressInfo.address)
      ) {
        addresses.push(addressInfo.address)
      }
    }
  }

  return addresses
}

function getPreferredOutboundLanAddress(timeoutMs = 200) {
  return new Promise(resolve => {
    const socket = createSocket("udp4")
    let settled = false

    const finish = address => {
      if (settled) {
        return
      }

      settled = true
      try {
        socket.close()
      } catch {
        // ignore cleanup errors
      }
      resolve(address)
    }

    const timeoutId = setTimeout(() => finish(null), timeoutMs)

    socket.once("error", () => {
      clearTimeout(timeoutId)
      finish(null)
    })

    socket.connect(53, "8.8.8.8", () => {
      clearTimeout(timeoutId)
      try {
        const socketAddress = socket.address()
        finish(
          typeof socketAddress === "object" &&
            socketAddress !== null &&
            socketAddress.family === "IPv4" &&
            typeof socketAddress.address === "string"
            ? socketAddress.address
            : null,
        )
      } catch {
        finish(null)
      }
    })
  })
}

async function getLanAddressDiagnostics() {
  const interfaceLanAddresses = getInterfaceLanAddresses()
  const preferredLanAddress = await getPreferredOutboundLanAddress()

  if (!preferredLanAddress || !interfaceLanAddresses.includes(preferredLanAddress)) {
    return {
      interfaceLanAddresses,
      preferredLanAddress,
      lanAddresses: interfaceLanAddresses,
    }
  }

  return {
    interfaceLanAddresses,
    preferredLanAddress,
    lanAddresses: [
      preferredLanAddress,
      ...interfaceLanAddresses.filter(address => address !== preferredLanAddress),
    ],
  }
}

function createLobby(players) {
  return {
    status: "forming",
    players: Array.isArray(players)
      ? players.map(player => ({
          playerId: player.id,
          claimedBy: player.isBot ? `${BOT_CLAIM_PREFIX}${player.id}` : null,
          isReady: Boolean(player.isBot),
          isBot: Boolean(player.isBot),
          botPreset: player.isBot ? player.botPreset ?? null : null,
        }))
      : [],
  }
}

function canStartLobby(lobby) {
  const claimedPlayers = (lobby?.players ?? []).filter(player => player.claimedBy)
  return claimedPlayers.length > 0 && claimedPlayers.every(player => player.isReady)
}

function getStartedPlayerIds(lobby) {
  return (lobby?.players ?? []).filter(player => player.claimedBy && player.isReady).map(player => player.playerId)
}

function getStartedGame(game, startedPlayerIds) {
  const nextPlayers = Array.isArray(game?.players)
    ? game.players.filter(player => startedPlayerIds.includes(player.id))
    : []

  if (nextPlayers.length === 0) {
    const error = new Error("At least one ready player is required to start the game.")
    error.statusCode = 409
    throw error
  }

  return {
    ...game,
    players: nextPlayers,
    currentPlayerId: nextPlayers.some(player => player.id === game.currentPlayerId)
      ? game.currentPlayerId
      : nextPlayers[0].id,
  }
}

function applyLobbySettingsToGame(game, settings, totalWeeks) {
  if (!settings) {
    return game
  }

  const maxAutoPlayWeeks =
    typeof totalWeeks === "number" && Number.isFinite(totalWeeks) && totalWeeks > 0
      ? Math.round(totalWeeks)
      : null

  const nextChanceCardsEnabled =
    typeof settings.chanceCardsEnabled === "boolean"
      ? settings.chanceCardsEnabled
      : game.chanceCardsEnabled
  const nextTurnTimerSeconds =
    typeof settings.turnTimerSeconds === "number" && Number.isFinite(settings.turnTimerSeconds)
      ? Math.max(0, Math.round(settings.turnTimerSeconds))
      : game.turnTimerSeconds
  const nextAutoPlayUntilWeek =
    typeof settings.autoPlayUntilWeek === "number" && Number.isFinite(settings.autoPlayUntilWeek)
      ? Math.max(
          0,
          maxAutoPlayWeeks === null
            ? Math.round(settings.autoPlayUntilWeek)
            : Math.min(Math.round(settings.autoPlayUntilWeek), maxAutoPlayWeeks),
        )
      : game.autoPlayUntilWeek

  const shouldRewriteHumanPreviewPreset =
    settings.previewPlayerId !== undefined ||
    settings.previewBotPreset !== undefined ||
    nextAutoPlayUntilWeek !== game.autoPlayUntilWeek

  const nextPlayers = shouldRewriteHumanPreviewPreset
    ? game.players.map(player => {
        if (player.isBot) {
          return player
        }

        const previewPlayerId =
          typeof settings.previewPlayerId === "string" && settings.previewPlayerId.length > 0
            ? settings.previewPlayerId
            : null
        const previewEnabled = nextAutoPlayUntilWeek > 0 && previewPlayerId !== null
        const previewPreset =
          previewEnabled
            ? normalizeBotPresetId(
                typeof settings.previewBotPreset === "string" && settings.previewBotPreset.length > 0
                  ? settings.previewBotPreset
                  : player.botPreset ?? "bot-avg",
              )
            : undefined

        return {
          ...player,
          botPreset: previewEnabled && player.id === previewPlayerId ? previewPreset : undefined,
        }
      })
    : game.players

  return {
    ...game,
    chanceCardsEnabled: nextChanceCardsEnabled,
    turnTimerSeconds: nextTurnTimerSeconds,
    turnTimerExpiresAt: null,
    autoPlayUntilWeek: nextAutoPlayUntilWeek,
    players: nextPlayers,
  }
}

function getAssignedPlayerId(lobby, clientId, requestedPlayerId) {
  const currentLobby = lobby ?? { status: "forming", players: [] }
  const claimedPlayer = currentLobby.players.find(lobbyPlayer => lobbyPlayer.claimedBy === clientId) ?? null

  if (requestedPlayerId) {
    return requestedPlayerId
  }

  if (claimedPlayer) {
    return claimedPlayer.playerId
  }

  const nextAvailablePlayer = currentLobby.players.find(lobbyPlayer => lobbyPlayer.claimedBy === null) ?? null

  if (!nextAvailablePlayer) {
    // No seat available — allow joining as spectator (SSE-only, no write path needed)
    return null
  }

  return nextAvailablePlayer.playerId
}

function getNextLobby(lobby, clientId, playerId, isReady) {
  const currentLobby = lobby ?? { status: "forming", players: [] }
  const currentPlayer = currentLobby.players.find(lobbyPlayer => lobbyPlayer.playerId === playerId) ?? null

  if (!currentPlayer) {
    const error = new Error(`Player ${playerId} was not found in this session.`)
    error.statusCode = 404
    throw error
  }

  const nextPlayers = currentLobby.players.map(lobbyPlayer => {
    if (lobbyPlayer.claimedBy === clientId && lobbyPlayer.playerId !== playerId) {
      return {
        ...lobbyPlayer,
        claimedBy: null,
        isReady: false,
      }
    }

    if (lobbyPlayer.playerId !== playerId) {
      return lobbyPlayer
    }

    if (lobbyPlayer.claimedBy && lobbyPlayer.claimedBy !== clientId && currentLobby.status !== "started") {
      const error = new Error(`Player ${playerId} has already been claimed by another browser.`)
      error.statusCode = 409
      throw error
    }

    return {
      ...lobbyPlayer,
      claimedBy: clientId,
      isReady: isReady ?? currentPlayer.isReady,
    }
  })
  return {
    status: currentLobby.status === "started" ? "started" : "forming",
    players: nextPlayers,
  }
}

function getNextLobbySession(session, lobbyUpdate) {
  const assignedPlayerId = getAssignedPlayerId(session.lobby, lobbyUpdate.clientId, lobbyUpdate.playerId)

  // Spectator: no seat to claim, just return current state (or start game if requested)
  if (assignedPlayerId === null) {
    const currentLobby = session.lobby ?? { status: "forming", players: [] }
    if (!lobbyUpdate.startGame) {
      return session
    }
    if (!canStartLobby(currentLobby)) {
      const error = new Error("Every filled seat must be ready before starting the game.")
      error.statusCode = 409
      throw error
    }
    const startedPlayerIds = getStartedPlayerIds(currentLobby)
    return {
      game: getStartedGame(session.game, startedPlayerIds),
      lobby: { ...currentLobby, status: "started" },
    }
  }

  const nextLobby = getNextLobby(session.lobby, lobbyUpdate.clientId, assignedPlayerId, lobbyUpdate.isReady)
  const trimmedPlayerName = lobbyUpdate.playerName?.trim() ?? ""
  const renamedGame =
    trimmedPlayerName.length === 0
      ? session.game
      : {
          ...session.game,
          players: session.game.players.map(player =>
            player.id === assignedPlayerId
              ? {
                  ...player,
                  name: trimmedPlayerName,
                }
              : player,
          ),
        }
  const nextGame = applyLobbySettingsToGame(
    renamedGame,
    lobbyUpdate.settings,
    session.staticData?.operatingConfig?.totalWeeks,
  )

  const nextSession = {
    game: nextGame,
    lobby: nextLobby,
  }

  if (!lobbyUpdate.startGame) {
    return nextSession
  }

  if (!canStartLobby(nextLobby)) {
    const error = new Error("Every filled seat must be ready before starting the game.")
    error.statusCode = 409
    throw error
  }

  const startedPlayerIds = getStartedPlayerIds(nextLobby)

  return {
    ...nextSession,
    game: getStartedGame(nextGame, startedPlayerIds),
    lobby: {
      ...nextLobby,
      status: "started",
    },
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  })
  response.end(JSON.stringify(payload))
}

function sendNoContent(response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  })
  response.end()
}

function sendEvent(stream, eventName, payload) {
  stream.write(`event: ${eventName}\n`)
  stream.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function broadcastSession(sessionId) {
  const session = sessions.get(sessionId)
  const streams = sessionStreams.get(sessionId)

  if (!session || !streams) {
    return
  }

  for (const stream of streams.keys()) {
    sendEvent(stream, "snapshot", session)
  }
}

/** Cancel any existing turn timer for a session and set up a new one if applicable. */
function setupTurnTimer(sessionId) {
  // Cancel existing timer
  if (turnTimerTimeouts.has(sessionId)) {
    clearTimeout(turnTimerTimeouts.get(sessionId))
    turnTimerTimeouts.delete(sessionId)
  }

  const session = sessions.get(sessionId)
  if (!session) return

  const game = session.game
  const clearStoredExpiry = () => {
    if (!game || game.turnTimerExpiresAt === null) {
      return
    }

    const nextSession = {
      ...session,
      game: { ...game, turnTimerExpiresAt: null },
    }
    sessions.set(sessionId, nextSession)
    broadcastSession(sessionId)
  }

  if (!game || !game.turnTimerSeconds || game.turnTimerSeconds <= 0 || game.isGameOver) {
    clearStoredExpiry()
    return
  }

  // Find a human player who still needs to act this phase
  const lobby = session.lobby
  const humanPlayerIds = new Set((lobby?.players ?? []).filter(p => !p.isBot).map(p => p.playerId))
  const hydratedGame = hydrateServerGame(session)

  const pendingHumanPlayer = hydratedGame.players.find(p =>
    humanPlayerIds.has(p.id) && canPlayerAct(hydratedGame, p.id, session)
  )

  if (!pendingHumanPlayer) {
    clearStoredExpiry()
    return
  }

  const expiresAt = Date.now() + game.turnTimerSeconds * 1000

  // Update turnTimerExpiresAt in the stored game
  const nextSession = {
    ...session,
    game: { ...game, turnTimerExpiresAt: expiresAt },
  }
  sessions.set(sessionId, nextSession)
  broadcastSession(sessionId)

  const timeoutId = setTimeout(() => {
    turnTimerTimeouts.delete(sessionId)
    const currentSession = sessions.get(sessionId)
    if (!currentSession) return

    const currentGame = hydrateServerGame(currentSession)
    if (currentGame.isGameOver) return

    // Auto-advance the human player whose timer expired
    try {
      const playerId = pendingHumanPlayer.id
      if (!canPlayerAct(currentGame, playerId, currentSession)) return

      const gameAfterAction = applyGameAction(currentGame, playerId, { type: 'advance-turn' })
      const gameAfterBots = runServerBotTurns(gameAfterAction, currentSession)
      const mutableGame = dehydrateGame(gameAfterBots)

      const timedOutSession = {
        ...currentSession,
        version: currentSession.version + 1,
        updatedAt: new Date().toISOString(),
        game: mutableGame,
      }
      sessions.set(sessionId, timedOutSession)
      broadcastSession(sessionId)
      setupTurnTimer(sessionId)
    } catch (err) {
      console.error(`[timer] Auto-advance failed for session ${sessionId}:`, err)
    }
  }, game.turnTimerSeconds * 1000)

  turnTimerTimeouts.set(sessionId, timeoutId)
}

function closeSession(sessionId, message) {
  const streams = sessionStreams.get(sessionId)

  if (streams) {
    for (const stream of streams.keys()) {
      sendEvent(stream, "closed", { sessionId, message })
      stream.end()
    }

    sessionStreams.delete(sessionId)
  }

  sessions.delete(sessionId)

  if (activeSessionId === sessionId) {
    activeSessionId = null
  }
}

function summarizeSession(sessionId, session) {
  return {
    sessionId,
    sessionName: session.sessionName,
    updatedAt: session.updatedAt,
    lobbyStatus: session.lobby?.status ?? "forming",
    playerCount: Array.isArray(session.game?.players) ? session.game.players.length : 0,
    readyPlayerCount: Array.isArray(session.lobby?.players)
      ? session.lobby.players.filter(player => player.isReady).length
      : 0,
    isActive: activeSessionId === sessionId,
  }
}

function createSessionId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let sessionId = ""

  while (sessionId.length < 6) {
    const byte = randomBytes(1)[0]
    sessionId += alphabet[byte % alphabet.length]
  }

  return sessions.has(sessionId) ? createSessionId() : sessionId
}

async function readJsonBody(request) {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(chunk)
  }

  if (chunks.length === 0) {
    return null
  }

  const rawBody = Buffer.concat(chunks).toString("utf8")
  return rawBody ? JSON.parse(rawBody) : null
}

function isValidSessionPayload(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.sessionName === "string" &&
    typeof value.staticData === "object" &&
    value.staticData !== null &&
    typeof value.staticData.mapId === "string" &&
    typeof value.game === "object" &&
    value.game !== null
  )
}

function isValidGameUpdate(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.baseVersion === "number" &&
    Number.isFinite(value.baseVersion) &&
    typeof value.game === "object" &&
    value.game !== null
  )
}

function isValidLobbyUpdate(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.clientId === "string" &&
    (value.playerId === undefined || typeof value.playerId === "string") &&
    (value.isReady === undefined || typeof value.isReady === "boolean") &&
    (value.playerName === undefined || typeof value.playerName === "string") &&
    (value.startGame === undefined || typeof value.startGame === "boolean") &&
    (value.settings === undefined || (
      typeof value.settings === "object" &&
      value.settings !== null &&
      (value.settings.chanceCardsEnabled === undefined || typeof value.settings.chanceCardsEnabled === "boolean") &&
      (value.settings.turnTimerSeconds === undefined || (typeof value.settings.turnTimerSeconds === "number" && Number.isFinite(value.settings.turnTimerSeconds))) &&
      (value.settings.autoPlayUntilWeek === undefined || (typeof value.settings.autoPlayUntilWeek === "number" && Number.isFinite(value.settings.autoPlayUntilWeek))) &&
      (value.settings.previewPlayerId === undefined || value.settings.previewPlayerId === null || typeof value.settings.previewPlayerId === "string") &&
      (value.settings.previewBotPreset === undefined || value.settings.previewBotPreset === null || typeof value.settings.previewBotPreset === "string")
    )) &&
    (value.setSeatBot === undefined || (
      typeof value.setSeatBot === "object" &&
      value.setSeatBot !== null &&
      typeof value.setSeatBot.playerId === "string" &&
      typeof value.setSeatBot.isBot === "boolean" &&
      (value.setSeatBot.botPreset === undefined || value.setSeatBot.botPreset === null || typeof value.setSeatBot.botPreset === "string") &&
      (value.setSeatBot.botName === undefined || typeof value.setSeatBot.botName === "string")
    ))
  )
}

function getSessionIdFromPath(pathname) {
  const match = pathname.match(/^\/sessions\/([A-Z0-9]{6})(?:\/(events|game|lobby|action))?$/)

  if (!match) {
    return null
  }

  return {
    sessionId: decodeURIComponent(match[1]),
    resource: match[2] ?? "",
  }
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    sendJson(response, 400, { error: "Missing request URL." })
    return
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`)

  if (request.method === "OPTIONS") {
    sendNoContent(response)
    return
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const healthDiagnostics = await getLanAddressDiagnostics()
    const lanAddressLogSignature = JSON.stringify(healthDiagnostics)

    if (lanAddressLogSignature !== lastLanAddressLogSignature) {
      lastLanAddressLogSignature = lanAddressLogSignature
      console.info("[session-server] LAN address diagnostics", healthDiagnostics)
    }

    sendJson(response, 200, {
      ok: true,
      sessions: sessions.size,
      activeSessionId,
      ...healthDiagnostics,
    })
    return
  }

  if (url.pathname === "/training" || url.pathname === "/manual-training" || url.pathname.startsWith("/training/") || url.pathname.startsWith("/manual-training/")) {
    if (!isLocalTrainingRequest(request)) {
      sendJson(response, 403, { error: "Training endpoints are local-only." })
      return
    }

    if (request.method === "GET" && url.pathname === "/training/status") {
      sendJson(response, 200, getTrainingStatusPayload())
      return
    }

    if (request.method === "GET" && url.pathname === "/training/importance") {
      sendJson(response, 200, getTrainingImportancePayload())
      return
    }

    if (request.method === "GET" && url.pathname === "/training/autotune/status") {
      sendJson(response, 200, getAutotuneControlStatusPayload())
      return
    }

    if (request.method === "GET" && url.pathname === "/training/presets") {
      sendJson(response, 200, getTrainingPresetPayload())
      return
    }

    if (request.method === "POST" && url.pathname === "/training/start") {
      try {
        const body = await readJsonBody(request)

        if (!isValidTrainingStartPayload(body)) {
          sendJson(response, 400, {
            error: "Training start requests must include iterations, gamesPerCandidate, playerCount, baseSeed, candidatesPerIteration, mutationSeed, and maxSteps.",
          })
          return
        }

        const args = normalizeTrainingArgs(body)
        startTrainingProcess(args)
        sendJson(response, 202, getTrainingStatusPayload())
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not start training.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/cancel") {
      try {
        cancelTrainingProcess()
        sendJson(response, 202, getTrainingStatusPayload())
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not cancel training.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/autotune/start") {
      try {
        startAutotuneProcess()
        sendJson(response, 202, getAutotuneControlStatusPayload())
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not start autotune.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/autotune/stop") {
      try {
        stopAutotuneProcess()
        sendJson(response, 202, getAutotuneControlStatusPayload())
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not stop autotune.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/autotune/force-stop") {
      try {
        forceStopAutotuneProcess()
        sendJson(response, 202, getAutotuneControlStatusPayload())
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not force stop autotune.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/importance/start") {
      try {
        startTrainingImportanceProcess()
        sendJson(response, 202, getTrainingImportancePayload())
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not start lever importance analysis.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/presets/promote") {
      try {
        const body = await readJsonBody(request)

        if (!isValidTrainingPresetPromotionPayload(body)) {
          sendJson(response, 400, {
            error: "Preset promotion requests must include presetId: \"bot-avg\" or \"bot-best\".",
          })
          return
        }

        const nextStore = promoteLatestTrainingResultsToPreset(body.presetId)
        sendJson(response, 200, {
          outputPath: MANAGED_BOT_PRESETS_PATH,
          presets: nextStore.presets,
        })
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not promote training results.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/presets/promote-autotune-run") {
      try {
        const body = await readJsonBody(request)

        if (!isValidAutotuneRunPresetPromotionPayload(body)) {
          sendJson(response, 400, {
            error: "Autotune preset promotion requests must include playerCount and generatedAt.",
          })
          return
        }

        const nextStore = promoteAutotuneRunToStickbug(Math.trunc(body.playerCount), body.generatedAt)
        sendJson(response, 200, {
          outputPath: MANAGED_BOT_PRESETS_PATH,
          presets: nextStore.presets,
        })
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Could not promote autotune run.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/autotune/reset") {
      try {
        if (activeTrainingProcess || activeAutotuneProcess) {
          const error = new Error("Cannot reset while training or autotune is running. Stop it first.")
          error.statusCode = 409
          throw error
        }
        // Archive current champions to the chronicle before deleting them
        const currentStatus = readAutotuneStatusFile()
        const currentCycle = isRecord(currentStatus) && isFiniteNumber(currentStatus?.cycle) ? currentStatus.cycle : 0
        const chronicle = readChronicle()
        for (const playerCount of [1, 2, 3, 4]) {
          const championPath = resolve(PROJECT_ROOT, `public/training-results/champion-${playerCount}p.json`)
          if (existsSync(championPath)) {
            try {
              const champion = JSON.parse(readFileSync(championPath, "utf8"))
              if (isRecord(champion) && isRecord(champion.benchmark)) {
                chronicle.pastChampions = chronicle.pastChampions.filter(pc => pc.playerCount !== playerCount)
                chronicle.pastChampions.push({
                  playerCount,
                  fromCycle: isFiniteNumber(champion.cycle) ? champion.cycle : currentCycle,
                  sessionEndCycle: currentCycle,
                  benchmarkScore: isFiniteNumber(champion.benchmark?.score) ? champion.benchmark.score : 0,
                  averagePassengers: isFiniteNumber(champion.benchmark?.averagePassengers) ? champion.benchmark.averagePassengers : 0,
                  averagePassengerMargin: isFiniteNumber(champion.benchmark?.averagePassengerMargin) ? champion.benchmark.averagePassengerMargin : 0,
                  winRate: isFiniteNumber(champion.benchmark?.winRate) ? champion.benchmark.winRate : 0,
                })
              }
            } catch { /* ignore unreadable champion files */ }
          }
        }
        writeChronicle(chronicle)

        const filesToDelete = [
          resolve(PROJECT_ROOT, "public/training-results/autotune-status.json"),
          resolve(PROJECT_ROOT, "public/training-results/autotune-history.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-1p.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-2p.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-3p.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-4p.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-1p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-2p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-3p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/champion-4p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-1p.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-2p.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-3p.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-4p.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-1p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-2p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-3p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-4p-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest-importance.json"),
          resolve(PROJECT_ROOT, "public/training-results/latest.json"),
        ]
        const deleted = []
        for (const filePath of filesToDelete) {
          if (existsSync(filePath)) {
            unlinkSync(filePath)
            deleted.push(filePath.split("/").pop())
          }
        }
        sendJson(response, 200, { deleted })
        return
      } catch (error) {
        sendJson(response, error?.statusCode ?? 500, {
          error: error instanceof Error ? error.message : "Could not reset autotune data.",
        })
        return
      }
    }

    if (request.method === "POST" && url.pathname === "/training/chronicle/rule-change") {
      try {
        const body = await readJsonBody(request)
        if (!isRecord(body) || typeof body.label !== "string" || !body.label.trim()) {
          sendJson(response, 400, { error: "Rule change requires a non-empty label." })
          return
        }
        const currentStatus = readAutotuneStatusFile()
        const cycle = isRecord(currentStatus) && isFiniteNumber(currentStatus?.cycle) ? currentStatus.cycle : 0
        const chronicle = readChronicle()
        chronicle.ruleChanges.push({ cycle, label: body.label.trim(), date: new Date().toISOString() })
        writeChronicle(chronicle)
        sendJson(response, 200, chronicle)
        return
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "Could not add rule change." })
        return
      }
    }

    // GET /training and GET /manual-training are SPA pages — fall through to static serving
    if (request.method === "GET" && (url.pathname === "/training" || url.pathname === "/manual-training")) {
      serveStaticOrSPA(response, url.pathname)
      return
    }

    sendJson(response, 405, { error: "Method not allowed for this training route." })
    return
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    try {
      const body = await readJsonBody(request)

      if (!isValidSessionPayload(body)) {
        sendJson(response, 400, { error: "Session payload must include sessionName, staticData, and game." })
        return
      }

      const sessionId = createSessionId()
      const now = new Date().toISOString()
      const initialSession = {
        sessionId,
        sessionName: body.sessionName.trim() || `Transport Game ${sessionId}`,
        version: 1,
        createdAt: now,
        updatedAt: now,
        lobby: createLobby(body.game.players),
        staticData: body.staticData,
        game: body.game,
      }

      // Run any bot-only opening turns immediately (e.g., all-bot games)
      const hydratedGame = hydrateServerGame(initialSession)
      const gameAfterBots = runServerBotTurns(hydratedGame, initialSession)
      const session = {
        ...initialSession,
        game: dehydrateGame(gameAfterBots),
      }

      sessions.set(sessionId, session)
      activeSessionId = sessionId
      sendJson(response, 201, session)
      // If auto-play is configured, schedule a follow-up pass in case the initial run didn't complete
      scheduleAutoPlayContinuation(sessionId)
      return
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not parse JSON request body.",
      })
      return
    }
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(
      response,
      200,
      [...sessions.entries()]
        .map(([sessionId, session]) => summarizeSession(sessionId, session))
        .sort(
          (sessionA, sessionB) =>
            Number(sessionB.isActive) - Number(sessionA.isActive) ||
            sessionB.updatedAt.localeCompare(sessionA.updatedAt),
        ),
    )
    return
  }

  if (request.method === "GET" && url.pathname === "/sessions/active") {
    if (!activeSessionId) {
      sendJson(response, 404, { error: "No active session has been launched yet." })
      return
    }

    const activeSession = sessions.get(activeSessionId)

    if (!activeSession) {
      activeSessionId = null
      sendJson(response, 404, { error: "The active session is no longer available." })
      return
    }

    sendJson(response, 200, activeSession)
    return
  }

  const sessionPath = getSessionIdFromPath(url.pathname)

  if (!sessionPath) {
    // Not an API route — serve static files for GET requests, 404 otherwise
    if (request.method === "GET") {
      serveStaticOrSPA(response, url.pathname)
      return
    }
    sendJson(response, 404, { error: "Route not found." })
    return
  }

  const session = sessions.get(sessionPath.sessionId)

  if (!session) {
    sendJson(response, 404, { error: `Session ${sessionPath.sessionId} was not found.` })
    return
  }

  if (request.method === "GET" && sessionPath.resource === "") {
    sendJson(response, 200, session)
    return
  }

  if (request.method === "DELETE" && sessionPath.resource === "") {
    closeSession(sessionPath.sessionId, `${session.sessionName} was cancelled.`)
    sendJson(response, 200, { ok: true, sessionId: sessionPath.sessionId })
    return
  }

  if (request.method === "PUT" && sessionPath.resource === "game") {
    try {
      const body = await readJsonBody(request)

      if (!isValidGameUpdate(body)) {
        sendJson(response, 400, { error: "Game updates must include baseVersion and a game object." })
        return
      }

      if (body.baseVersion !== session.version) {
        sendJson(response, 409, {
          error: "The LAN session changed. Retry on the latest snapshot.",
          snapshot: session,
        })
        return
      }

      // Run any pending bot turns server-side before saving
      const incomingSession = { ...session, game: body.game }
      const hydratedGame = hydrateServerGame(incomingSession)
      const gameAfterBots = runServerBotTurns(hydratedGame, session)
      const mutableGame = dehydrateGame(gameAfterBots)

      const nextSession = {
        ...session,
        version: session.version + 1,
        updatedAt: new Date().toISOString(),
        game: mutableGame,
      }

      sessions.set(sessionPath.sessionId, nextSession)
      sendJson(response, 200, nextSession)
      broadcastSession(sessionPath.sessionId)
      return
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not parse JSON request body.",
      })
      return
    }
  }

  if (request.method === "POST" && sessionPath.resource === "action") {
    try {
      const body = await readJsonBody(request)

      if (
        typeof body !== "object" ||
        body === null ||
        typeof body.playerId !== "string" ||
        typeof body.action !== "object" ||
        body.action === null ||
        typeof body.action.type !== "string"
      ) {
        sendJson(response, 400, { error: "Action requests must include playerId and action with a type." })
        return
      }

      const hydratedGame = hydrateServerGame(session)

      // stop-auto-play can be called by any human player in the session
      const isStopAutoPlay = body.action.type === 'stop-auto-play'
      const isHumanPlayer = session.lobby?.players?.some(p => p.playerId === body.playerId && !p.isBot)
      if (!isStopAutoPlay && !canPlayerAct(hydratedGame, body.playerId, session)) {
        sendJson(response, 403, { error: "It is not your turn to act." })
        return
      }
      if (isStopAutoPlay && !isHumanPlayer) {
        sendJson(response, 403, { error: "Only human players can take over auto-play." })
        return
      }

      const gameAfterAction = applyGameAction(hydratedGame, body.playerId, body.action)
      const gameAfterBots = runServerBotTurns(gameAfterAction, session)
      const mutableGame = dehydrateGame(gameAfterBots)

      const nextSession = {
        ...session,
        version: session.version + 1,
        updatedAt: new Date().toISOString(),
        game: mutableGame,
      }

      sessions.set(sessionPath.sessionId, nextSession)
      sendJson(response, 200, { ok: true })
      broadcastSession(sessionPath.sessionId)
      setupTurnTimer(sessionPath.sessionId)
      return
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Could not apply action.",
      })
      return
    }
  }

   if (request.method === "PUT" && sessionPath.resource === "lobby") {
    try {
      const body = await readJsonBody(request)

      if (!isValidLobbyUpdate(body)) {
        sendJson(response, 400, {
          error: "Lobby updates must include clientId and may include playerId, isReady, playerName, startGame, settings, and setSeatBot.",
        })
        return
      }

      // Bot-seat toggle — host can flip any unclaimed seat to/from bot before game starts
      if (body.setSeatBot !== undefined) {
        const { playerId, isBot, botPreset, botName } = body.setSeatBot
        const lobbyPlayer = session.lobby.players.find(p => p.playerId === playerId)
        if (!lobbyPlayer) {
          sendJson(response, 404, { error: `Seat ${playerId} was not found.` })
          return
        }
        if (lobbyPlayer.claimedBy && !lobbyPlayer.isBot) {
          sendJson(response, 409, { error: `Seat ${playerId} is already claimed by a human player.` })
          return
        }
        const resolvedBotPreset = isBot ? (botPreset ?? lobbyPlayer.botPreset ?? "bot-best") : null
        const trimmedBotName = typeof botName === "string" ? botName.trim() : null
        const nextLobby = {
          ...session.lobby,
          players: session.lobby.players.map(p =>
            p.playerId !== playerId ? p : {
              ...p,
              isBot,
              botPreset: resolvedBotPreset,
              claimedBy: isBot ? `${BOT_CLAIM_PREFIX}${playerId}` : null,
              isReady: isBot,
            }
          ),
        }
        const nextGame = {
          ...session.game,
          players: session.game.players.map(p => {
            if (p.id !== playerId) return p
            const next = { ...p, isBot, botPreset: resolvedBotPreset }
            if (isBot && trimmedBotName) next.name = trimmedBotName
            return next
          }),
        }
        const nextSession = {
          ...session,
          version: session.version + 1,
          updatedAt: new Date().toISOString(),
          game: nextGame,
          lobby: nextLobby,
        }
        sessions.set(sessionPath.sessionId, nextSession)
        sendJson(response, 200, nextSession)
        broadcastSession(sessionPath.sessionId)
        return
      }

      const { game, lobby } = getNextLobbySession(session, body)

      // Run any pending bot turns server-side (important when lobby starts and bots move first)
      let finalGame = game
      if (body.startGame && lobby.status === "started") {
        try {
          const startedSession = { ...session, game, lobby }
          const hydratedGame = hydrateServerGame(startedSession)
          const gameAfterBots = runServerBotTurns(hydratedGame, startedSession)
          finalGame = dehydrateGame(gameAfterBots)
        } catch {
          finalGame = game
        }
      }

      const nextSession = {
        ...session,
        version: session.version + 1,
        updatedAt: new Date().toISOString(),
        game: finalGame,
        lobby,
      }

      sessions.set(sessionPath.sessionId, nextSession)
      sendJson(response, 200, nextSession)
      broadcastSession(sessionPath.sessionId)
      setupTurnTimer(sessionPath.sessionId)
      // If auto-play is configured, kick off bot continuation for all seats
      scheduleAutoPlayContinuation(sessionPath.sessionId)
      return
    } catch (error) {
      sendJson(response, error?.statusCode ?? 400, {
        error: error instanceof Error ? error.message : "Could not parse JSON request body.",
      })
      return
    }
  }

  if (request.method === "GET" && sessionPath.resource === "events") {
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    })
    response.write("\n")

    const streams = sessionStreams.get(sessionPath.sessionId) ?? new Map()
    const clientId = url.searchParams.get("clientId") ?? null
    streams.set(response, clientId)
    sessionStreams.set(sessionPath.sessionId, streams)

    // Track active connections per client; cancel any pending release on reconnect
    if (clientId) {
      const releaseKey = `${sessionPath.sessionId}:${clientId}`
      const count = activeConnectionCounts.get(releaseKey) ?? 0
      activeConnectionCounts.set(releaseKey, count + 1)
      const pending = pendingSeatReleases.get(releaseKey)
      if (pending) {
        clearTimeout(pending)
        pendingSeatReleases.delete(releaseKey)
      }
    }

    sendEvent(response, "snapshot", session)

    request.on("close", () => {
      const nextStreams = sessionStreams.get(sessionPath.sessionId)

      if (!nextStreams) {
        return
      }

      nextStreams.delete(response)

      if (nextStreams.size === 0) {
        sessionStreams.delete(sessionPath.sessionId)
      }

      if (clientId) {
        const releaseKey = `${sessionPath.sessionId}:${clientId}`
        const count = (activeConnectionCounts.get(releaseKey) ?? 1) - 1

        if (count <= 0) {
          // Last connection for this client dropped — start release timer
          activeConnectionCounts.delete(releaseKey)
          const timeoutId = setTimeout(() => {
            pendingSeatReleases.delete(releaseKey)
            const currentSession = sessions.get(sessionPath.sessionId)
            if (currentSession?.lobby?.status === "forming") {
              const hadClaim = currentSession.lobby.players.some(p => p.claimedBy === clientId)
              if (hadClaim) {
                const nextLobby = {
                  ...currentSession.lobby,
                  players: currentSession.lobby.players.map(p =>
                    p.claimedBy === clientId ? { ...p, claimedBy: null, isReady: false } : p,
                  ),
                }
                const nextSession = {
                  ...currentSession,
                  version: currentSession.version + 1,
                  updatedAt: new Date().toISOString(),
                  lobby: nextLobby,
                }
                sessions.set(sessionPath.sessionId, nextSession)
                broadcastSession(sessionPath.sessionId)
              }
            }
          }, SEAT_RELEASE_DELAY_MS)
          pendingSeatReleases.set(releaseKey, timeoutId)
        } else {
          activeConnectionCounts.set(releaseKey, count)
        }
      }
    })
    return
  }

  sendJson(response, 405, { error: "Method not allowed for this route." })
})

server.listen(PORT, "0.0.0.0", () => {
  const distExists = existsSync(DIST_DIR)
  console.log(`Transport Game session server listening on http://0.0.0.0:${PORT}`)
  if (distExists) {
    console.log(`Serving game frontend from ${DIST_DIR}`)
  } else {
    console.log(`No dist/ folder found — run 'npm run build' to enable frontend serving`)
  }
})
