import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  clearActiveAdminLaunch,
  clearSavedGame,
  loadActiveAdminLaunch,
  loadJoinAppUrl,
  loadSavedGame,
  saveActiveAdminLaunch,
  saveJoinAppUrl,
  saveSavedGame,
} from "./data/gameStorage"
import {
  createEmptyVehicleCard,
  createInitialUserDecks,
  loadUserDecks,
  normalizeVehicleCardsByPrice,
  saveUserDecks,
} from "./data/deckData"
import type { GameState, VehicleCard } from "./engine/types"
import {
  buildLanSessionJoinUrl,
  deleteLanSession,
  fetchActiveLanSession,
  fetchLanSession,
  getDefaultJoinAppUrl,
  fetchSessionServerHealth,
  hydrateLanSessionGame,
  getLocalSessionServerUrl,
  getSuggestedJoinAppUrl,
  isLocalJoinAppUrl,
  normalizeJoinAppUrl,
  pushLanSessionGame,
  subscribeToLanSession,
  type LanSessionClosedEvent,
  type LanSessionLobby,
  type SessionServerHealth,
} from "./network/sessionSync"

const PAGE_STYLE = {
  minHeight: "100%",
  background: "#f3f6f2",
  color: "#223024",
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const

type LanSessionConnection = {
  sessionId: string
  sessionName: string
  serverUrl: string
  version: number
}

function shouldReplaceJoinAppUrl(rawUrl: string) {
  try {
    return isLocalJoinAppUrl(normalizeJoinAppUrl(rawUrl))
  } catch {
    return true
  }
}

export default function AdminApp() {
  const initialActiveAdminLaunch = loadActiveAdminLaunch()
  const [game, setGame] = useState<GameState | null>(() => loadSavedGame())
  const [vehicleCards, setVehicleCards] = useState<VehicleCard[]>(() =>
    normalizeVehicleCardsByPrice(loadUserDecks().vehicleCards),
  )
  const [lanLobby, setLanLobby] = useState<LanSessionLobby | null>(null)
  const [moneyAmount, setMoneyAmount] = useState(100000)
  const [statusMessage, setStatusMessage] = useState("")
  const [statusTone, setStatusTone] = useState<"neutral" | "error">("neutral")
  const [serverUrl, setServerUrl] = useState(() => getLocalSessionServerUrl())
  const [joinAppUrl, setJoinAppUrl] = useState(() => loadJoinAppUrl() ?? getDefaultJoinAppUrl())
  const [serverHealth, setServerHealth] = useState<SessionServerHealth | null>(null)
  const [serverHealthTone, setServerHealthTone] = useState<"neutral" | "error">("neutral")
  const [serverHealthMessage, setServerHealthMessage] = useState("Checking session server...")
  const [lanSession, setLanSession] = useState<LanSessionConnection | null>(() =>
    initialActiveAdminLaunch
      ? {
          sessionId: initialActiveAdminLaunch.sessionId,
          sessionName: initialActiveAdminLaunch.sessionName,
          serverUrl: initialActiveAdminLaunch.serverUrl,
          version: 0,
        }
      : null,
  )
  const [isCancellingSession, setIsCancellingSession] = useState(false)
  const lanSessionRef = useRef<LanSessionConnection | null>(null)
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
  const applyLanSnapshot = useCallback(
    (snapshot: Awaited<ReturnType<typeof fetchLanSession>>, nextServerUrl: string) => {
      const nextGame = hydrateLanSessionGame(snapshot)
      const nextConnection = {
        sessionId: snapshot.sessionId,
        sessionName: snapshot.sessionName,
        serverUrl: nextServerUrl,
        version: snapshot.version,
      }

      lanSessionRef.current = nextConnection
      setLanSession(nextConnection)
      setGame(nextGame)
      setLanLobby(snapshot.lobby)
      saveSavedGame(nextGame)
      saveActiveAdminLaunch({
        sessionId: snapshot.sessionId,
        sessionName: snapshot.sessionName,
        serverUrl: nextServerUrl,
      })
    },
    [],
  )

  useEffect(() => {
    lanSessionRef.current = lanSession
  }, [lanSession])

  useEffect(() => {
    function handleStorage() {
      if (lanSessionRef.current) {
        return
      }

      setGame(loadSavedGame())
    }

    window.addEventListener("storage", handleStorage)

    return () => {
      window.removeEventListener("storage", handleStorage)
    }
  }, [])

  useEffect(() => {
    let isActive = true

    async function checkServerHealth() {
      try {
        const nextHealth = await fetchSessionServerHealth(serverUrl)

        if (!isActive) {
          return
        }

        adoptSuggestedJoinAppUrl(nextHealth)
        setServerHealth(nextHealth)
        setServerHealthTone("neutral")
        setServerHealthMessage(
          nextHealth.activeSessionId
            ? `Session server is online. Active session: ${nextHealth.activeSessionId}.`
            : "Session server is online. No active LAN game yet.",
        )

        if (!nextHealth.activeSessionId || lanSessionRef.current) {
          return
        }

        const snapshot = await fetchActiveLanSession(serverUrl)

        if (!isActive) {
          return
        }

        applyLanSnapshot(snapshot, serverUrl)
        setStatus(`Connected to ${snapshot.sessionName} (${snapshot.sessionId}).`)
      } catch (error) {
        if (!isActive) {
          return
        }

        setServerHealth(null)
        setServerHealthTone("error")
        setServerHealthMessage(error instanceof Error ? error.message : "Could not reach the session server.")
      }
    }

    void checkServerHealth()
    const pollId = window.setInterval(() => {
      void checkServerHealth()
    }, 5000)

    return () => {
      isActive = false
      window.clearInterval(pollId)
    }
  }, [adoptSuggestedJoinAppUrl, applyLanSnapshot, serverUrl])

  useEffect(() => {
    if (!lanSession) {
      return
    }

    return subscribeToLanSession(lanSession.serverUrl, lanSession.sessionId, {
      onSnapshot(snapshot) {
        if (snapshot.version <= (lanSessionRef.current?.version ?? 0)) {
          return
        }

        applyLanSnapshot(snapshot, lanSession.serverUrl)
        setStatusTone("neutral")
        setStatusMessage(`Synced ${snapshot.sessionName} (${snapshot.sessionId}).`)
      },
      onError() {
        setStatusTone("error")
        setStatusMessage(`Lost live sync to ${lanSession.sessionName}. Waiting to reconnect...`)
      },
      onClosed(event: LanSessionClosedEvent) {
        clearSavedGame()
        clearActiveAdminLaunch()
        lanSessionRef.current = null
        setLanSession(null)
        setLanLobby(null)
        setGame(null)
        setStatus(event.message, "error")
      },
    })
  }, [applyLanSnapshot, lanSession])

  useEffect(() => {
    if (!lanSession || lanSession.version > 0) {
      return
    }

    let isActive = true

    void fetchLanSession(lanSession.serverUrl, lanSession.sessionId)
      .then(snapshot => {
        if (!isActive) {
          return
        }

        applyLanSnapshot(snapshot, lanSession.serverUrl)
      })
      .catch(() => {
        if (!isActive) {
          return
        }

        clearActiveAdminLaunch()
        lanSessionRef.current = null
        setLanSession(null)
        setLanLobby(null)
        setGame(null)
      })

    return () => {
      isActive = false
    }
  }, [applyLanSnapshot, lanSession])

  const currentPlayer = useMemo(
    () => game?.players.find(player => player.id === game.currentPlayerId) ?? null,
    [game],
  )
  const joinUrl = useMemo(
    () => (lanSession ? buildLanSessionJoinUrl(lanSession.sessionId, lanSession.serverUrl, normalizedJoinAppUrl) : ""),
    [lanSession, normalizedJoinAppUrl],
  )
  const duplicateVehicleNumbers = useMemo(() => {
    const counts = new Map<string, number>()

    for (const card of vehicleCards) {
      const key = `${card.type}:${card.number}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
      .sort((a, b) => a.localeCompare(b))
  }, [vehicleCards])
  const nextVehicleNumber = useMemo(
    () => vehicleCards.reduce((highest, card) => Math.max(highest, card.number), 0) + 1,
    [vehicleCards],
  )

  useEffect(() => {
    const nextUserDecks = loadUserDecks()
    nextUserDecks.vehicleCards = vehicleCards
    saveUserDecks(nextUserDecks)
  }, [vehicleCards])

  function setStatus(message: string, tone: "neutral" | "error" = "neutral") {
    setStatusTone(tone)
    setStatusMessage(message)
  }

  function parseNumber(value: string, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function setNormalizedVehicleCards(
    updater: VehicleCard[] | ((currentCards: VehicleCard[]) => VehicleCard[]),
  ) {
    setVehicleCards(currentCards =>
      normalizeVehicleCardsByPrice(
        typeof updater === "function" ? updater(currentCards) : updater,
      ),
    )
  }

  function handleJoinAppUrlChange(rawUrl: string) {
    setJoinAppUrl(rawUrl)

    try {
      saveJoinAppUrl(normalizeJoinAppUrl(rawUrl))
    } catch {
      // Keep the field editable while the user types an incomplete URL.
    }
  }

  function commitGame(nextGame: GameState, message: string) {
    saveSavedGame(nextGame)
    setGame(nextGame)
    setStatus(message)

    const activeLanSession = lanSessionRef.current

    if (!activeLanSession) {
      return
    }

    void pushLanSessionGame(
      activeLanSession.serverUrl,
      activeLanSession.sessionId,
      nextGame,
      activeLanSession.version,
    )
      .then(snapshot => {
        if (snapshot.version <= (lanSessionRef.current?.version ?? 0)) {
          return
        }

        applyLanSnapshot(snapshot, activeLanSession.serverUrl)
        setStatus(`Synced ${snapshot.sessionName} (${snapshot.sessionId}).`)
      })
      .catch(error => {
        setStatus(
          `Could not push admin changes to ${activeLanSession.sessionName}: ${error instanceof Error ? error.message : "unknown error"}`,
          "error",
        )
      })
  }

  function handleAdjustMoney(playerId: string, delta: number) {
    if (!game) {
      return
    }

    const player = game.players.find(candidate => candidate.id === playerId)

    if (!player) {
      return
    }

    commitGame(
      {
        ...game,
        players: game.players.map(candidate =>
          candidate.id === playerId
            ? {
                ...candidate,
                money: candidate.money + delta,
              }
            : candidate,
        ),
      },
      `${delta >= 0 ? "Added" : "Removed"} ${Math.abs(delta).toLocaleString()} cash ${delta >= 0 ? "to" : "from"} ${player.name}.`,
    )
  }

  function handleReload() {
    const targetSession = lanSessionRef.current

    void (targetSession
      ? fetchLanSession(targetSession.serverUrl, targetSession.sessionId)
      : fetchActiveLanSession(serverUrl)
    )
      .then(snapshot => {
        applyLanSnapshot(snapshot, targetSession?.serverUrl ?? serverUrl)
        setStatus(`Connected to ${snapshot.sessionName} (${snapshot.sessionId}).`)
      })
      .catch(error => {
        setStatus(
          error instanceof Error ? error.message : "Could not reconnect to an active LAN game.",
          "error",
        )
      })
  }

  async function handleCopyJoinUrl() {
    if (!joinUrl) {
      return
    }

    try {
      await navigator.clipboard.writeText(joinUrl)
      setStatus(`Copied join URL for ${lanSession?.sessionName ?? "the LAN session"}.`)
    } catch (error) {
      setStatus(
        `Could not copy the join URL: ${error instanceof Error ? error.message : "unknown error"}`,
        "error",
      )
    }
  }

  async function handleCancelSession() {
    if (!lanSession) {
      setStatus("No active LAN game is connected.", "error")
      return
    }

    setIsCancellingSession(true)

    try {
      await deleteLanSession(lanSession.serverUrl, lanSession.sessionId)
      clearSavedGame()
      clearActiveAdminLaunch()
      lanSessionRef.current = null
      setLanSession(null)
      setLanLobby(null)
      setGame(null)
      setStatus(`Cancelled ${lanSession.sessionName} (${lanSession.sessionId}).`)
    } catch (error) {
      setStatus(
        `Could not cancel ${lanSession.sessionName}: ${error instanceof Error ? error.message : "unknown error"}`,
        "error",
      )
    } finally {
      setIsCancellingSession(false)
    }
  }

  function updateVehicleCard(cardId: string, updater: (card: VehicleCard) => VehicleCard) {
    setNormalizedVehicleCards(currentCards =>
      currentCards.map(card => (card.id === cardId ? updater(card) : card)),
    )
  }

  function renderVehicleCard(card: VehicleCard) {
    return (
      <div
        key={card.id}
        style={{
          border: "1px solid #d8dfd5",
          borderRadius: 12,
          padding: 12,
          background: "#ffffff",
          display: "grid",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "start",
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong>
              {card.type.toUpperCase()} #{card.number}
            </strong>
            <div style={{ color: "#56635a", fontSize: 13 }}>{card.name}</div>
          </div>
          <button
            type="button"
            onClick={() =>
              setNormalizedVehicleCards(currentCards =>
                currentCards.filter(currentCard => currentCard.id !== card.id),
              )
            }
            style={{
              padding: "8px 10px",
              borderRadius: 999,
              border: "1px solid #d2a4a4",
              background: "#fff7f7",
              color: "#9b1c1c",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Delete
          </button>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 10,
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Type</span>
            <select
              value={card.type}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => ({
                  ...currentCard,
                  type: event.target.value as VehicleCard["type"],
                }))
              }
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
            >
              <option value="bus">Bus</option>
              <option value="train">Train</option>
              <option value="air">Air</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Number</span>
            <input
              type="number"
              min={1}
              value={card.number}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => ({
                  ...currentCard,
                  number: Math.max(1, Math.round(parseNumber(event.target.value, currentCard.number))),
                }))
              }
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, gridColumn: "span 2" }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Name</span>
            <input
              type="text"
              value={card.name}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => ({
                  ...currentCard,
                  name: event.target.value,
                }))
              }
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Purchase price</span>
            <input
              type="number"
              min={0}
              step={100000}
              value={card.purchasePrice}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => ({
                  ...currentCard,
                  purchasePrice: Math.max(0, parseNumber(event.target.value, currentCard.purchasePrice)),
                }))
              }
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Capacity</span>
            <input
              type="number"
              min={1}
              value={card.capacityPerVehicle}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => {
                  const nextCapacity = Math.max(1, Math.round(parseNumber(event.target.value, currentCard.capacityPerVehicle)))
                  return {
                    ...currentCard,
                    capacityPerVehicle: nextCapacity,
                    totalPassengerCapacity: nextCapacity,
                  }
                })
              }
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Speed</span>
            <input
              type="number"
              min={1}
              value={card.speed}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => ({
                  ...currentCard,
                  speed: Math.max(1, parseNumber(event.target.value, currentCard.speed)),
                }))
              }
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Operating multiplier</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={card.operatingCostMultiplier}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => ({
                  ...currentCard,
                  operatingCostMultiplier: Math.max(0, parseNumber(event.target.value, currentCard.operatingCostMultiplier)),
                }))
              }
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, gridColumn: "1 / -1" }}>
            <span style={{ fontSize: 12, color: "#56635a", fontWeight: 700 }}>Fun fact</span>
            <textarea
              value={card.funFact}
              onChange={event =>
                updateVehicleCard(card.id, currentCard => ({
                  ...currentCard,
                  funFact: event.target.value,
                }))
              }
              rows={2}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14, resize: "vertical" }}
            />
          </label>
        </div>
      </div>
    )
  }

  return (
    <div style={PAGE_STYLE}>
      <div
        style={{
          maxWidth: 1320,
          margin: "0 auto",
          padding: 24,
          display: "grid",
          gap: 16,
        }}
      >
        <div
          style={{
            border: "1px solid #d8dfd5",
            borderRadius: 14,
            background: "#ffffff",
            padding: 16,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 800 }}>Transport Game Admin</div>
          <div style={{ color: "#56635a" }}>
            Use the home page to create local or LAN games. Keep this page for live admin controls
            like adding cash, reconnecting to the active game, and cancelling the current LAN session.
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 12,
            }}
          >
            <label style={{ display: "grid", gap: 6 }}>
              <strong>Session server</strong>
              <input
                type="text"
                value={serverUrl}
                onChange={event => setServerUrl(event.target.value)}
                placeholder="http://192.168.1.10:8787"
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
              />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <strong>Share app URL</strong>
              <input
                type="text"
                value={joinAppUrl}
                onChange={event => handleJoinAppUrlChange(event.target.value)}
                placeholder="http://192.168.1.42:5173"
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
              />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <strong>Money amount</strong>
              <input
                type="number"
                step={1000}
                value={moneyAmount}
                onChange={event => setMoneyAmount(Number(event.target.value) || 0)}
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14 }}
              />
            </label>
          </div>
          {!hasValidJoinAppUrl && (
            <div style={{ color: "#9b1c1c", fontSize: 13 }}>
              Enter a full LAN address like http://192.168.1.42:5173.
            </div>
          )}
          <div style={{ color: serverHealthTone === "error" ? "#9b1c1c" : "#56635a", fontSize: 13 }}>
            {serverHealthMessage}
          </div>
          {serverHealth && (
            <div style={{ color: "#56635a", fontSize: 13 }}>
              Tracked sessions: {serverHealth.sessions}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              onClick={handleReload}
              style={{
                padding: "8px 12px",
                borderRadius: 999,
                border: "1px solid #c7d0c4",
                background: "#ffffff",
                cursor: "pointer",
              }}
            >
              Reconnect active game
            </button>
            {lanSession && (
              <>
                <button
                  type="button"
                  onClick={handleCopyJoinUrl}
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
                  Copy join URL
                </button>
                <button
                  type="button"
                  onClick={() => void handleCancelSession()}
                  disabled={isCancellingSession}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: "1px solid #d2a4a4",
                    background: isCancellingSession ? "#f4dada" : "#fff7f7",
                    color: "#9b1c1c",
                    cursor: isCancellingSession ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  {isCancellingSession ? "Cancelling..." : "Cancel game"}
                </button>
              </>
            )}
          </div>
          {statusMessage ? (
            <div style={{ color: statusTone === "error" ? "#9b1c1c" : "#56635a", fontSize: 13 }}>
              {statusMessage}
            </div>
          ) : null}
        </div>

        <div
          style={{
            border: "1px solid #d8dfd5",
            borderRadius: 14,
            background: "#ffffff",
            padding: 16,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 800 }}>Admin workflow</div>
          <div style={{ color: "#56635a", fontSize: 14 }}>
            Create or delete LAN games from the home page. Once a game exists, this page attaches to
            the active session so you can inspect it, add or remove money, and cancel the game for
            every connected player.
          </div>
        </div>

        {lanSession && (
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 14,
              background: "#ffffff",
              padding: 16,
              display: "grid",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 800 }}>Active LAN session</div>
            <div>
              <strong>{lanSession.sessionName}</strong> ({lanSession.sessionId})
            </div>
            <div style={{ color: "#56635a", fontSize: 14 }}>
              Session server: {lanSession.serverUrl}
            </div>
            <div style={{ color: "#56635a", fontSize: 14 }}>
              Lobby: {lanLobby?.status === "started" ? "game started" : "waiting for players"}
            </div>
            <label style={{ display: "grid", gap: 6 }}>
              <strong>Join URL</strong>
              <input
                type="text"
                readOnly
                value={joinUrl}
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 14, color: "#324236" }}
              />
            </label>
            {game && lanLobby && (
              <div style={{ display: "grid", gap: 8 }}>
                <strong>Player readiness</strong>
                {game.players.map(player => {
                  const lobbyPlayer = lanLobby.players.find(candidate => candidate.playerId === player.id)
                  const isClaimed = Boolean(lobbyPlayer?.claimedBy)

                  return (
                    <div
                      key={player.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        flexWrap: "wrap",
                        border: "1px solid #d8dfd5",
                        borderRadius: 10,
                        padding: "10px 12px",
                        background: "#fbfcfb",
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>{player.name}</div>
                      <div
                        style={{
                          color: lobbyPlayer?.isReady ? "#1f5f2c" : isClaimed ? "#8a5a00" : "#56635a",
                          fontWeight: 700,
                        }}
                      >
                        {lobbyPlayer?.isReady ? "Ready" : isClaimed ? "Joined" : "Waiting"}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {!lanSession || !game ? (
          <div
            style={{
              border: "1px solid #d8dfd5",
              borderRadius: 14,
              background: "#ffffff",
              padding: 16,
              color: "#56635a",
            }}
          >
            No active LAN game is connected here yet. Start a game from the home page, then use this
            page to manage the live session.
          </div>
        ) : (
          <>
            <div
              style={{
                border: "1px solid #d8dfd5",
                borderRadius: 14,
                background: "#ffffff",
                padding: 16,
                display: "grid",
                gap: 6,
              }}
            >
              <div>
                <strong>Current player:</strong> {currentPlayer?.name ?? game.currentPlayerId}
              </div>
              <div>
                <strong>Month:</strong> {game.currentWeek}
              </div>
              <div>
                <strong>Phase:</strong> {game.currentPhase}
              </div>
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              {game.players.map(player => (
                <div
                  key={player.id}
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 14,
                    background: "#ffffff",
                    padding: 16,
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{player.name}</div>
                      <div style={{ color: "#56635a", fontSize: 13 }}>{player.id}</div>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>
                      ${Math.round(player.money).toLocaleString()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => handleAdjustMoney(player.id, moneyAmount)}
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
                      +{moneyAmount.toLocaleString()}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAdjustMoney(player.id, -moneyAmount)}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 999,
                        border: "1px solid #d2a4a4",
                        background: "#fff7f7",
                        color: "#9b1c1c",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      -{moneyAmount.toLocaleString()}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div
          style={{
            border: "1px solid #d8dfd5",
            borderRadius: 14,
            background: "#ffffff",
            padding: 16,
            display: "grid",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "start" }}>
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: 20, fontWeight: 800 }}>Vehicle deck</div>
              <div style={{ color: "#56635a", fontSize: 14 }}>
                This restores the old card editor in a better home. These are the exact vehicle cards the next game will use.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() =>
                  setNormalizedVehicleCards(currentCards => [
                    ...currentCards,
                    createEmptyVehicleCard(nextVehicleNumber),
                  ])
                }
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Add vehicle card
              </button>
              <button
                type="button"
                onClick={() => setNormalizedVehicleCards(createInitialUserDecks().vehicleCards)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                  cursor: "pointer",
                }}
              >
                Reset to defaults
              </button>
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
            }}
          >
            <div style={{ border: "1px solid #d8dfd5", borderRadius: 12, padding: 12, background: "#f9fbf8" }}>
              <strong>Total cards</strong>
              <div style={{ marginTop: 4 }}>{vehicleCards.length}</div>
            </div>
            {(["bus", "train", "air"] as const).map(type => (
              <div key={type} style={{ border: "1px solid #d8dfd5", borderRadius: 12, padding: 12, background: "#f9fbf8" }}>
                <strong>{type[0].toUpperCase() + type.slice(1)} cards</strong>
                <div style={{ marginTop: 4 }}>{vehicleCards.filter(card => card.type === type).length}</div>
              </div>
            ))}
          </div>
          {duplicateVehicleNumbers.length > 0 ? (
            <div style={{ color: "#9b1c1c", fontSize: 13 }}>
              Duplicate vehicle numbers: {duplicateVehicleNumbers.join(", ")}
            </div>
          ) : (
            <div style={{ color: "#56635a", fontSize: 13 }}>
              Vehicle numbers are unique within each type.
            </div>
          )}
          <div style={{ display: "grid", gap: 12 }}>
            {(["bus", "train", "air"] as const).map(type => (
              <div key={type} style={{ display: "grid", gap: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {type[0].toUpperCase() + type.slice(1)} cards
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {vehicleCards
                    .filter(card => card.type === type)
                    .sort((cardA, cardB) => cardA.purchasePrice - cardB.purchasePrice || cardA.number - cardB.number)
                    .map(card => renderVehicleCard(card))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
