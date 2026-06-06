import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { networkInterfaces } from "node:os"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"

const PORT = Number(process.env.PORT ?? 8787)
const sessions = new Map()
const sessionStreams = new Map()
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
const TRAINING_LOG_LIMIT = 400
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
}

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

function hasStaleAutotuneRun() {
  const existingAutotuneStatus = readAutotuneStatusFile()
  return isRecord(existingAutotuneStatus) && isRecord(existingAutotuneStatus.currentRun)
}

function getAutotuneControlStatusPayload() {
  if (activeAutotuneProcess === null && hasStaleAutotuneRun()) {
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
        ["bot-avg", "bot-best"].flatMap(presetId => {
          const preset = parsedValue.presets[presetId]

          if (!preset) {
            return []
          }

          if (
            !isRecord(preset) ||
            preset.presetId !== presetId ||
            typeof preset.promotedAt !== "string" ||
            typeof preset.sourceTrainingGeneratedAt !== "string" ||
            !isValidWeights(preset.weights) ||
            !isRecord(preset.sourceSummary) ||
            !isRecord(preset.sourceConfig)
          ) {
            return []
          }

          return [[presetId, {
            presetId,
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
  const nextStore = {
    version: 1,
    updatedAt: promotedAt,
    presets: {
      ...(readManagedBotPresetStore()?.presets ?? {}),
      [presetId]: {
        presetId,
        weights: trainingResults.final.weights,
        promotedAt,
        sourceTrainingGeneratedAt: trainingResults.generatedAt,
        sourceSummary: {
          score: trainingResults.final.score,
          winRate: trainingResults.final.winRate,
          averageRank: trainingResults.final.averageRank,
          averagePassengers: trainingResults.final.averagePassengers,
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
      },
    },
  }

  writeManagedBotPresetStore(nextStore)
  appendTrainingLog(`Promoted the latest training results into preset "${presetId}".`)
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
    args.playerCount < 2 ||
    args.playerCount > 4 ||
    args.candidatesPerIteration < 1 ||
    args.maxSteps < 1
  ) {
    const error = new Error("Training parameters must be positive integers, and player count must be between 2 and 4.")
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

  if (hasStaleAutotuneRun()) {
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
    lines.forEach(appendTrainingLog)
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

  if (hasStaleAutotuneRun()) {
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
    lines.forEach(appendAutotuneLog)
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
  }
  appendAutotuneLog("Stop requested. The autotune loop will exit after the current cycle finishes.")
  activeAutotuneProcess.kill("SIGINT")
}

function getLanAddresses() {
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

  return addresses.sort((addressA, addressB) => addressA.localeCompare(addressB))
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
    const error = new Error("This session is full.")
    error.statusCode = 409
    throw error
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

    if (lobbyPlayer.claimedBy && lobbyPlayer.claimedBy !== clientId) {
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
  const nextLobby = getNextLobby(session.lobby, lobbyUpdate.clientId, assignedPlayerId, lobbyUpdate.isReady)
  const trimmedPlayerName = lobbyUpdate.playerName?.trim() ?? ""
  const nextGame =
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

  for (const stream of streams) {
    sendEvent(stream, "snapshot", session)
  }
}

function closeSession(sessionId, message) {
  const streams = sessionStreams.get(sessionId)

  if (streams) {
    for (const stream of streams) {
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
    (value.startGame === undefined || typeof value.startGame === "boolean")
  )
}

function getSessionIdFromPath(pathname) {
  const match = pathname.match(/^\/sessions\/([A-Z0-9]{6})(?:\/(events|game|lobby))?$/)

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
    sendJson(response, 200, {
      ok: true,
      sessions: sessions.size,
      activeSessionId,
      lanAddresses: getLanAddresses(),
    })
    return
  }

  if (url.pathname.startsWith("/training")) {
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
      const session = {
        sessionId,
        sessionName: body.sessionName.trim() || `Transport Game ${sessionId}`,
        version: 1,
        createdAt: now,
        updatedAt: now,
        lobby: createLobby(body.game.players),
        staticData: body.staticData,
        game: body.game,
      }

      sessions.set(sessionId, session)
      activeSessionId = sessionId
      sendJson(response, 201, session)
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

      const nextSession = {
        ...session,
        version: session.version + 1,
        updatedAt: new Date().toISOString(),
        game: body.game,
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

   if (request.method === "PUT" && sessionPath.resource === "lobby") {
    try {
      const body = await readJsonBody(request)

      if (!isValidLobbyUpdate(body)) {
        sendJson(response, 400, {
          error: "Lobby updates must include clientId and may include playerId, isReady, playerName, and startGame.",
        })
        return
      }

      const { game, lobby } = getNextLobbySession(session, body)

      const nextSession = {
        ...session,
        version: session.version + 1,
        updatedAt: new Date().toISOString(),
        game,
        lobby,
      }

      sessions.set(sessionPath.sessionId, nextSession)
      sendJson(response, 200, nextSession)
      broadcastSession(sessionPath.sessionId)
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

    const streams = sessionStreams.get(sessionPath.sessionId) ?? new Set()
    streams.add(response)
    sessionStreams.set(sessionPath.sessionId, streams)
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
    })
    return
  }

  sendJson(response, 405, { error: "Method not allowed for this route." })
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Transport Game session server listening on http://0.0.0.0:${PORT}`)
})
