import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { networkInterfaces } from "node:os"

const PORT = Number(process.env.PORT ?? 8787)
const sessions = new Map()
const sessionStreams = new Map()
let activeSessionId = null

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
          claimedBy: null,
          isReady: false,
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
