import { useMemo, useRef, useState, type ChangeEvent } from "react"
import {
  coerceUserDecks,
  createEmptyChanceCard,
  createEmptyRouteCard,
  createEmptyVehicleCard,
  createInitialUserDecks,
} from "../data/deckData"
import { calculateDistanceMiles } from "../engine/trips"
import type {
  ChanceCard,
  City,
  RouteDeckCard,
  RouteMode,
  UserDeckData,
  VehicleCard,
} from "../engine/types"
import type { GameSetupPlayer } from "../engine/createGameState"

type StartMenuProps = {
  players: GameSetupPlayer[]
  startingMoney: number
  onStartingMoneyChange: (value: number) => void
  onSetupPlayerChange: (playerId: string, updates: Partial<GameSetupPlayer>) => void
  onMoveSetupPlayer: (playerId: string, direction: -1 | 1) => void
  onAddSetupPlayer: () => void
  onRemoveSetupPlayer: (playerId: string) => void
  onStartGame: () => void
  userDecks: UserDeckData
  onUserDecksChange: (nextUserDecks: UserDeckData) => void
  availableCities: City[]
}

type StartMenuTab = "setup" | "vehicles" | "chance" | "routes"

const MAX_SETUP_PLAYERS = 4
const TAB_LABELS: Record<StartMenuTab, string> = {
  setup: "Game setup",
  vehicles: "Vehicle deck",
  chance: "Chance deck",
  routes: "Route decks",
}
const ROUTE_MODE_ORDER: RouteMode[] = ["bus", "rail", "air"]
const ROUTE_MODE_LABELS: Record<RouteMode, string> = {
  bus: "Bus",
  rail: "Rail",
  air: "Air",
}
const VEHICLE_FIELD_LABEL_STYLE = {
  fontSize: 12,
  color: "#56635a",
  fontWeight: 700,
} as const

function getVehicleNumberKey(card: Pick<VehicleCard, "type" | "number">) {
  return `${card.type}:${card.number}`
}

function parseNumber(value: string, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getChanceMultiplierValue(value: number | undefined) {
  return value === undefined ? "" : String(value)
}

export default function StartMenu({
  players,
  startingMoney,
  onStartingMoneyChange,
  onSetupPlayerChange,
  onMoveSetupPlayer,
  onAddSetupPlayer,
  onRemoveSetupPlayer,
  onStartGame,
  userDecks,
  onUserDecksChange,
  availableCities,
}: StartMenuProps) {
  const [activeTab, setActiveTab] = useState<StartMenuTab>("setup")
  const [deckMessage, setDeckMessage] = useState("")
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const sortedCities = useMemo(
    () => [...availableCities].sort((cityA, cityB) => cityA.name.localeCompare(cityB.name)),
    [availableCities],
  )
  const cityNameById = useMemo(
    () => Object.fromEntries(availableCities.map(city => [city.id, city.name])),
    [availableCities],
  )
  const cityById = useMemo(
    () => Object.fromEntries(availableCities.map(city => [city.id, city])),
    [availableCities],
  )
  const nextVehicleNumber = useMemo(
    () => userDecks.vehicleCards.reduce((highest, card) => Math.max(highest, card.number), 0) + 1,
    [userDecks.vehicleCards],
  )
  const duplicateVehicleNumbers = useMemo(() => {
    const counts = new Map<string, number>()

    for (const card of userDecks.vehicleCards) {
      const key = getVehicleNumberKey(card)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key]) => key),
    )
  }, [userDecks.vehicleCards])
  const routeCardsByMode = useMemo(
    () =>
      ROUTE_MODE_ORDER.map(mode => ({
        mode,
        cards: userDecks.routeCards.filter(card => card.mode === mode),
      })),
    [userDecks.routeCards],
  )

  function setUserVehicleCards(nextVehicleCards: VehicleCard[]) {
    onUserDecksChange({
      ...userDecks,
      vehicleCards: nextVehicleCards,
    })
  }

  function setUserChanceCards(nextChanceCards: ChanceCard[]) {
    onUserDecksChange({
      ...userDecks,
      chanceCards: nextChanceCards,
    })
  }

  function setUserRouteCards(nextRouteCards: RouteDeckCard[]) {
    onUserDecksChange({
      ...userDecks,
      routeCards: nextRouteCards,
    })
  }

  function handleExportUserDecks() {
    const blob = new Blob([JSON.stringify(userDecks, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "transport-game-user-decks.json"
    link.click()
    URL.revokeObjectURL(url)
    setDeckMessage("Exported the current deck JSON.")
  }

  async function handleImportUserDecks(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    try {
      const fileText = await file.text()
      onUserDecksChange(coerceUserDecks(JSON.parse(fileText)))
      setDeckMessage(`Imported deck JSON from ${file.name}.`)
    } catch (error) {
      console.error("Failed to import user deck file.", error)
      setDeckMessage("Could not import that JSON file.")
    } finally {
      event.target.value = ""
    }
  }

  function handleResetUserDecks() {
    onUserDecksChange(createInitialUserDecks())
    setDeckMessage("Reset the deck back to the shipped starter cards.")
  }

  function handleUpdateVehicleCard(
    cardId: string,
    field: keyof VehicleCard,
    value: string | number,
  ) {
    if (
      (field === "number" || field === "type") &&
      userDecks.vehicleCards.some(card => {
        if (card.id === cardId) {
          return false
        }

        const nextType = field === "type" ? (value as VehicleCard["type"]) : card.type
        const nextNumber = field === "number" ? Number(value) : card.number
        return card.type === nextType && card.number === nextNumber
      })
    ) {
      const currentCard = userDecks.vehicleCards.find(card => card.id === cardId)
      const nextType = field === "type" ? (value as VehicleCard["type"]) : currentCard?.type ?? "bus"
      const nextNumber = field === "number" ? Number(value) : currentCard?.number ?? 0
      setDeckMessage(`Vehicle #${nextNumber} already exists for ${nextType}. Vehicle numbers must be unique within each type.`)
      return
    }

    setUserVehicleCards(
      userDecks.vehicleCards.map(card => {
        if (card.id !== cardId) {
          return card
        }

        const nextCard = {
          ...card,
          [field]: value,
        } as VehicleCard

        nextCard.vehicleCount = 1
        nextCard.totalPassengerCapacity = nextCard.capacityPerVehicle

        return nextCard
      }),
    )
  }

  function handleUpdateChanceCard(cardId: string, updater: (card: ChanceCard) => ChanceCard) {
    setUserChanceCards(
      userDecks.chanceCards.map(card => (card.id === cardId ? updater(card) : card)),
    )
  }

  function handleUpdateRouteCard(cardId: string, updater: (card: RouteDeckCard) => RouteDeckCard) {
    setUserRouteCards(
      userDecks.routeCards.map(card => (card.id === cardId ? updater(card) : card)),
    )
  }

  function moveRouteStop(card: RouteDeckCard, index: number, direction: -1 | 1) {
    const nextIndex = index + direction

    if (nextIndex < 0 || nextIndex >= card.cityIds.length) {
      return
    }

    handleUpdateRouteCard(card.id, current => {
      const nextCityIds = [...current.cityIds]
      const [movedCityId] = nextCityIds.splice(index, 1)
      nextCityIds.splice(nextIndex, 0, movedCityId)

      return {
        ...current,
        cityIds: nextCityIds,
      }
    })
  }

  function getRouteCardDistance(card: RouteDeckCard) {
    const totalSegmentDistance = card.cityIds.reduce((total, cityId, index) => {
      if (index === 0) {
        return total
      }

      const previousCity = cityById[card.cityIds[index - 1]]
      const currentCity = cityById[cityId]

      if (!previousCity || !currentCity) {
        return total
      }

      return total + calculateDistanceMiles(previousCity, currentCity)
    }, 0)
    const closingLoopDistance =
      card.isLoop && card.cityIds.length >= 2
        ? (() => {
            const firstCity = cityById[card.cityIds[0]]
            const lastCity = cityById[card.cityIds[card.cityIds.length - 1]]

            if (!firstCity || !lastCity) {
              return 0
            }

            return calculateDistanceMiles(lastCity, firstCity)
          })()
        : 0

    if (card.cityIds.length < 2) {
      return 0
    }

    return card.isLoop
      ? totalSegmentDistance + closingLoopDistance
      : totalSegmentDistance * 2
  }

  function renderRouteShapePreview(card: RouteDeckCard) {
    const previewCities = card.cityIds
      .map(cityId => cityById[cityId])
      .filter((city): city is City => city !== undefined)

    if (previewCities.length < 2) {
      return (
        <div style={{ color: "#56635a", fontSize: 13 }}>
          Add at least two stops to preview this route.
        </div>
      )
    }

    const previewWidth = 340
    const previewHeight = 100
    const previewPadding = 28
    const lngValues = previewCities.map(city => city.lng)
    const latValues = previewCities.map(city => city.lat)
    const minLng = Math.min(...lngValues)
    const maxLng = Math.max(...lngValues)
    const minLat = Math.min(...latValues)
    const maxLat = Math.max(...latValues)
    const lngRange = Math.max(maxLng - minLng, 1)
    const latRange = Math.max(maxLat - minLat, 1)
    const drawableWidth = previewWidth - previewPadding * 2
    const drawableHeight = previewHeight - previewPadding * 2
    const scale = Math.min(drawableWidth / lngRange, drawableHeight / latRange)
    const contentWidth = lngRange * scale
    const contentHeight = latRange * scale
    const xOffset = previewPadding + (drawableWidth - contentWidth) / 2
    const yOffset = previewPadding + (drawableHeight - contentHeight) / 2
    const previewPoints = previewCities.map(city => ({
      city,
      x: xOffset + (city.lng - minLng) * scale,
      y: yOffset + (maxLat - city.lat) * scale,
    }))
    const polylinePoints = previewPoints.map(point => `${point.x},${point.y}`).join(" ")
    const closedLoopPoints =
      card.isLoop && previewPoints.length >= 2
        ? `${polylinePoints} ${previewPoints[0].x},${previewPoints[0].y}`
        : polylinePoints

    return (
      <div style={{ display: "grid", gap: 8 }}>
        <svg
          viewBox={`0 0 ${previewWidth} ${previewHeight}`}
          style={{
            width: "100%",
            aspectRatio: `${previewWidth} / ${previewHeight}`,
            borderRadius: 10,
            background: "#f6faf5",
            border: "1px solid #e1e6df",
          }}
        >
          {card.isLoop ? (
            <polygon
              points={closedLoopPoints}
              fill="rgba(69, 123, 157, 0.08)"
              stroke="#457b9d"
              strokeWidth={3}
              strokeLinejoin="round"
            />
          ) : (
            <polyline
              points={polylinePoints}
              fill="none"
              stroke="#457b9d"
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {previewPoints.map((point, index) => (
            <g key={`${card.id}-${point.city.id}`}>
              <circle cx={point.x} cy={point.y} r={7} fill="#223024" />
              <circle cx={point.x} cy={point.y} r={5} fill="#ffffff" />
              <text
                x={point.x}
                y={point.y - 10}
                textAnchor="middle"
                fontSize="11"
                fontWeight="700"
                fill="#223024"
              >
                {index + 1}
              </text>
            </g>
          ))}
        </svg>
        <div style={{ color: "#56635a", fontSize: 13 }}>
          {card.isLoop
            ? "Loop preview closes from the last stop back to the first."
            : "Out-and-back preview follows the selected stop order and returns on the same corridor."}
        </div>
      </div>
    )
  }

  function renderVehicleCard(card: VehicleCard) {
    const hasDuplicateNumber = duplicateVehicleNumbers.has(getVehicleNumberKey(card))

    return (
      <div
        key={card.id}
        style={{
          border: "1px solid #d8dfd5",
          borderRadius: 12,
          padding: 12,
          background: "#ffffff",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 120px", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>🔢 Number</span>
            <input
              type="number"
              value={card.number}
              onChange={event =>
                handleUpdateVehicleCard(card.id, "number", parseNumber(event.target.value, card.number))
              }
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: `1px solid ${hasDuplicateNumber ? "#b42318" : "#c7d0c4"}`,
              }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>🏷️ Name</span>
            <input
              type="text"
              value={card.name}
              onChange={event => handleUpdateVehicleCard(card.id, "name", event.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>🚍 Type</span>
            <select
              value={card.type}
              onChange={event =>
                handleUpdateVehicleCard(card.id, "type", event.target.value as VehicleCard["type"])
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            >
              <option value="bus">Bus</option>
              <option value="train">Train</option>
              <option value="air">Air</option>
            </select>
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>💵 Price</span>
            <input
              type="number"
              value={card.purchasePrice}
              onChange={event =>
                handleUpdateVehicleCard(
                  card.id,
                  "purchasePrice",
                  parseNumber(event.target.value, card.purchasePrice),
                )
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              justifyContent: "center",
              borderRadius: 8,
              border: "1px solid #d8dfd5",
              background: "#f7faf6",
              padding: "8px 10px",
            }}
          >
            <span style={VEHICLE_FIELD_LABEL_STYLE}>🚚 Vehicles</span>
            <span style={{ color: "#223024", fontSize: 14, fontWeight: 700 }}>1 per card</span>
            <span style={{ color: "#56635a", fontSize: 11 }}>
              Fleet size scales during bureaucracy.
            </span>
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>👤 Seats</span>
            <input
              type="number"
              value={card.capacityPerVehicle}
              onChange={event =>
                handleUpdateVehicleCard(
                  card.id,
                  "capacityPerVehicle",
                  parseNumber(event.target.value, card.capacityPerVehicle),
                )
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>⚡ Speed</span>
            <input
              type="number"
              value={card.speed}
              onChange={event =>
                handleUpdateVehicleCard(card.id, "speed", parseNumber(event.target.value, card.speed))
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>⚙️ Op multiplier</span>
            <input
              type="number"
              step="0.01"
              value={card.operatingCostMultiplier}
              onChange={event =>
                handleUpdateVehicleCard(
                  card.id,
                  "operatingCostMultiplier",
                  parseNumber(event.target.value, card.operatingCostMultiplier),
                )
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            👥 Total cap {card.totalPassengerCapacity.toLocaleString()} per vehicle
          </div>
          <button
            type="button"
            onClick={() =>
              setUserVehicleCards(userDecks.vehicleCards.filter(userCard => userCard.id !== card.id))
            }
            style={{
              padding: "8px 10px",
              borderRadius: 999,
              border: "1px solid #c7d0c4",
              background: "#ffffff",
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={VEHICLE_FIELD_LABEL_STYLE}>💬 Fun fact</span>
          <textarea
            value={card.funFact}
            onChange={event => handleUpdateVehicleCard(card.id, "funFact", event.target.value)}
            rows={3}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4", resize: "vertical" }}
          />
        </label>
        {hasDuplicateNumber && (
          <div style={{ color: "#b42318", fontSize: 13 }}>
            Vehicle #{card.number} is duplicated within {card.type}. Pick a unique number for that type.
          </div>
        )}
      </div>
    )
  }

  function renderChanceCard(card: ChanceCard) {
    return (
      <div
        key={card.id}
        style={{
          border: "1px solid #d8dfd5",
          borderRadius: 12,
          padding: 12,
          background: "#ffffff",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={VEHICLE_FIELD_LABEL_STYLE}>Title</span>
          <input
            type="text"
            value={card.title}
            onChange={event =>
              handleUpdateChanceCard(card.id, current => ({
                ...current,
                title: event.target.value,
              }))
            }
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={VEHICLE_FIELD_LABEL_STYLE}>Description</span>
          <textarea
            value={card.description}
            onChange={event =>
              handleUpdateChanceCard(card.id, current => ({
                ...current,
                description: event.target.value,
              }))
            }
            rows={3}
            style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4", resize: "vertical" }}
          />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>Diesel multiplier</span>
            <input
              type="number"
              step="0.05"
              value={getChanceMultiplierValue(card.fuelPriceMultiplier?.diesel)}
              onChange={event =>
                handleUpdateChanceCard(card.id, current => ({
                  ...current,
                  fuelPriceMultiplier: {
                    ...current.fuelPriceMultiplier,
                    diesel:
                      event.target.value === ""
                        ? undefined
                        : parseNumber(event.target.value, current.fuelPriceMultiplier?.diesel ?? 1),
                  },
                }))
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>Jet fuel multiplier</span>
            <input
              type="number"
              step="0.05"
              value={getChanceMultiplierValue(card.fuelPriceMultiplier?.jetFuel)}
              onChange={event =>
                handleUpdateChanceCard(card.id, current => ({
                  ...current,
                  fuelPriceMultiplier: {
                    ...current.fuelPriceMultiplier,
                    jetFuel:
                      event.target.value === ""
                        ? undefined
                        : parseNumber(event.target.value, current.fuelPriceMultiplier?.jetFuel ?? 1),
                  },
                }))
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>Demand regions</span>
            <input
              type="text"
              value={card.demandBoost?.regions.join(", ") ?? ""}
              onChange={event =>
                handleUpdateChanceCard(card.id, current => ({
                  ...current,
                  demandBoost: {
                    regions: event.target.value
                      .split(",")
                      .map(region => region.trim())
                      .filter(Boolean),
                    bonusPerCity: current.demandBoost?.bonusPerCity ?? 0,
                  },
                }))
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>Demand bonus per city</span>
            <input
              type="number"
              value={card.demandBoost?.bonusPerCity ?? ""}
              onChange={event =>
                handleUpdateChanceCard(card.id, current => ({
                  ...current,
                  demandBoost:
                    event.target.value === ""
                      ? undefined
                      : {
                          regions: current.demandBoost?.regions ?? [],
                          bonusPerCity: parseNumber(event.target.value, current.demandBoost?.bonusPerCity ?? 0),
                        },
                }))
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>Connection bonus city size</span>
            <input
              type="number"
              value={card.connectionBonus?.citySize ?? ""}
              onChange={event =>
                handleUpdateChanceCard(card.id, current => ({
                  ...current,
                  connectionBonus:
                    event.target.value === ""
                      ? undefined
                      : {
                          citySize: parseNumber(event.target.value, current.connectionBonus?.citySize ?? 0),
                          bonusPerCity: current.connectionBonus?.bonusPerCity ?? 0,
                        },
                }))
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={VEHICLE_FIELD_LABEL_STYLE}>Connection bonus per city</span>
            <input
              type="number"
              value={card.connectionBonus?.bonusPerCity ?? ""}
              onChange={event =>
                handleUpdateChanceCard(card.id, current => ({
                  ...current,
                  connectionBonus:
                    event.target.value === ""
                      ? undefined
                      : {
                          citySize: current.connectionBonus?.citySize ?? 0,
                          bonusPerCity: parseNumber(event.target.value, current.connectionBonus?.bonusPerCity ?? 0),
                        },
                }))
              }
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() =>
            setUserChanceCards(userDecks.chanceCards.filter(userCard => userCard.id !== card.id))
          }
          style={{
            alignSelf: "flex-start",
            padding: "8px 10px",
            borderRadius: 999,
            border: "1px solid #c7d0c4",
            background: "#ffffff",
            cursor: "pointer",
          }}
        >
          Delete
        </button>
      </div>
    )
  }

  function renderRouteCard(card: RouteDeckCard) {
    const totalRouteDistance = getRouteCardDistance(card)

    return (
      <div
        key={card.id}
        style={{
          border: "1px solid #d8dfd5",
          borderRadius: 12,
          padding: 12,
          background: "#ffffff",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px auto", gap: 8 }}>
              <input
                type="text"
                value={card.title}
                onChange={event =>
                  handleUpdateRouteCard(card.id, current => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
              />
              <select
                value={card.mode}
                onChange={event =>
                  handleUpdateRouteCard(card.id, current => ({
                    ...current,
                    mode: event.target.value as RouteMode,
                    cityIds:
                      event.target.value === "air" ? current.cityIds.slice(0, 2) : current.cityIds,
                    isLoop: event.target.value === "air" ? false : current.isLoop,
                  }))
                }
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
              >
                <option value="bus">Bus</option>
                <option value="rail">Rail</option>
                <option value="air">Air</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  setUserRouteCards(userDecks.routeCards.filter(userCard => userCard.id !== card.id))
                }
                style={{
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: "#ffffff",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {card.cityIds.map((cityId, index) => (
                <div
                  key={`${card.id}-${index}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto auto",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <select
                    value={cityId}
                    onChange={event =>
                      handleUpdateRouteCard(card.id, current => ({
                        ...current,
                        cityIds: current.cityIds.map((candidate, candidateIndex) =>
                          candidateIndex === index ? event.target.value : candidate,
                        ),
                      }))
                    }
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4" }}
                    >
                      {sortedCities.map(city => (
                        <option key={city.id} value={city.id}>
                          {city.name}
                        </option>
                      ))}
                    </select>
                  <button
                    type="button"
                    onClick={() => moveRouteStop(card, index, -1)}
                    disabled={index === 0}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 999,
                      border: "1px solid #c7d0c4",
                      background: index === 0 ? "#f2f2f2" : "#ffffff",
                      cursor: index === 0 ? "not-allowed" : "pointer",
                    }}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    onClick={() => moveRouteStop(card, index, 1)}
                    disabled={index === card.cityIds.length - 1}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 999,
                      border: "1px solid #c7d0c4",
                      background: index === card.cityIds.length - 1 ? "#f2f2f2" : "#ffffff",
                      cursor: index === card.cityIds.length - 1 ? "not-allowed" : "pointer",
                    }}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleUpdateRouteCard(card.id, current => ({
                        ...current,
                        cityIds:
                          current.cityIds.length <= 2
                            ? current.cityIds
                            : current.cityIds.filter((_, candidateIndex) => candidateIndex !== index),
                      }))
                    }
                    disabled={card.cityIds.length <= 2}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 999,
                      border: "1px solid #c7d0c4",
                      background: card.cityIds.length <= 2 ? "#f2f2f2" : "#ffffff",
                      cursor: card.cityIds.length <= 2 ? "not-allowed" : "pointer",
                    }}
                  >
                    Remove stop
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  handleUpdateRouteCard(card.id, current => ({
                    ...current,
                    cityIds: [...current.cityIds, sortedCities[0]?.id ?? current.cityIds[0] ?? ""],
                  }))
                }
                disabled={card.mode === "air" && card.cityIds.length >= 2}
                style={{
                  alignSelf: "flex-start",
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "1px solid #c7d0c4",
                  background: card.mode === "air" && card.cityIds.length >= 2 ? "#f2f2f2" : "#ffffff",
                  cursor: card.mode === "air" && card.cityIds.length >= 2 ? "not-allowed" : "pointer",
                }}
              >
                Add stop
              </button>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: card.mode === "air" ? "#848484" : "#324236",
                }}
              >
                <input
                  type="checkbox"
                  checked={card.isLoop}
                  onChange={event =>
                    handleUpdateRouteCard(card.id, current => ({
                      ...current,
                      isLoop: current.mode === "air" ? false : event.target.checked,
                    }))
                  }
                  disabled={card.mode === "air"}
                />
                Loop route
              </label>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                {card.mode === "air"
                  ? "Air routes must stay as two-city pairs."
                  : card.isLoop
                    ? "Loop distance = all segments + last city back to first."
                    : "Out-and-back distance = all segments x 2."}
              </div>
              <div style={{ color: "#324236", fontSize: 13 }}>
                {card.cityIds.map(cityId => cityNameById[cityId] ?? cityId).join(" -> ")}
              </div>
              <div style={{ color: "#56635a", fontSize: 13 }}>
                Total distance: {totalRouteDistance.toFixed(1)} mi
              </div>
              <textarea
                value={card.notes ?? ""}
                onChange={event =>
                  handleUpdateRouteCard(card.id, current => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
                rows={2}
                placeholder="Notes"
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #c7d0c4", resize: "vertical" }}
              />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {renderRouteShapePreview(card)}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "linear-gradient(180deg, #e8efe6 0%, #dce7ef 100%)",
        fontFamily: "system-ui, sans-serif",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      <input
        ref={importInputRef}
        type="file"
        accept="application/json"
        onChange={handleImportUserDecks}
        style={{ display: "none" }}
      />
      <div
        style={{
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          background: "rgba(255, 255, 255, 0.95)",
          borderRadius: 18,
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.14)",
          padding: 20,
          display: "grid",
          gridTemplateRows: "auto auto 1fr",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 800, color: "#223024" }}>Transport Game</div>
            <div style={{ color: "#56635a" }}>
              Configure players and edit the active card decks before starting.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              style={{ padding: "10px 14px", borderRadius: 999, border: "1px solid #c7d0c4", background: "#ffffff", cursor: "pointer", fontWeight: 600 }}
            >
              Import JSON
            </button>
            <button
              type="button"
              onClick={handleExportUserDecks}
              style={{ padding: "10px 14px", borderRadius: 999, border: "1px solid #c7d0c4", background: "#ffffff", cursor: "pointer", fontWeight: 600 }}
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={handleResetUserDecks}
              style={{ padding: "10px 14px", borderRadius: 999, border: "1px solid #c7d0c4", background: "#ffffff", cursor: "pointer", fontWeight: 600 }}
            >
              Reset to starter deck
            </button>
            <button
              type="button"
              onClick={onStartGame}
              disabled={duplicateVehicleNumbers.size > 0}
              style={{
                padding: "10px 18px",
                borderRadius: 999,
                border: "1px solid #223024",
                background: duplicateVehicleNumbers.size > 0 ? "#c7d0c4" : "#223024",
                color: "#ffffff",
                cursor: duplicateVehicleNumbers.size > 0 ? "not-allowed" : "pointer",
                fontWeight: 700,
              }}
            >
              Start game
            </button>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(Object.keys(TAB_LABELS) as StartMenuTab[]).map(tab => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${activeTab === tab ? "#223024" : "#c7d0c4"}`,
                  background: activeTab === tab ? "#223024" : "#ffffff",
                  color: activeTab === tab ? "#ffffff" : "#223024",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            This single editable deck is the exact data the next game will use.
          </div>
        </div>
        <div style={{ overflowY: "auto", paddingRight: 4 }}>
          {deckMessage && (
            <div style={{ marginBottom: 12, color: "#324236", fontSize: 14 }}>{deckMessage}</div>
          )}
          {duplicateVehicleNumbers.size > 0 && (
            <div style={{ marginBottom: 12, color: "#b42318", fontSize: 14 }}>
              Fix duplicate vehicle numbers before starting:{" "}
              {[...duplicateVehicleNumbers]
                .sort((a, b) => a.localeCompare(b))
                .map(key => {
                  const [type, number] = key.split(":")
                  return `${type} #${number}`
                })
                .join(", ")}
            </div>
          )}
          {activeTab === "setup" && (
            <div style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                <div style={{ border: "1px solid #d8dfd5", borderRadius: 12, padding: 12, background: "#ffffff" }}>
                  <strong>Vehicle deck</strong>
                  <div style={{ marginTop: 4 }}>{userDecks.vehicleCards.length} cards</div>
                </div>
                <div style={{ border: "1px solid #d8dfd5", borderRadius: 12, padding: 12, background: "#ffffff" }}>
                  <strong>Chance deck</strong>
                  <div style={{ marginTop: 4 }}>{userDecks.chanceCards.length} cards</div>
                </div>
                <div style={{ border: "1px solid #d8dfd5", borderRadius: 12, padding: 12, background: "#ffffff" }}>
                  <strong>Route deck library</strong>
                  <div style={{ marginTop: 4 }}>{userDecks.routeCards.length} cards</div>
                </div>
                <label
                  style={{
                    border: "1px solid #d8dfd5",
                    borderRadius: 12,
                    padding: 12,
                    background: "#ffffff",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <strong>Starting money</strong>
                  <input
                    type="number"
                    min={0}
                    step={1000000}
                    value={startingMoney}
                    onChange={event =>
                      onStartingMoneyChange(parseNumber(event.target.value, startingMoney))
                    }
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                  />
                </label>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {players.map((player, index) => (
                  <div
                    key={player.id}
                    style={{
                      border: "1px solid #d8dfd5",
                      borderRadius: 12,
                      padding: 12,
                      background: "#ffffff",
                      display: "grid",
                      gridTemplateColumns: "auto 1fr auto auto auto",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <div style={{ fontWeight: 700, color: "#223024", minWidth: 24 }}>{index + 1}.</div>
                    <input
                      type="text"
                      value={player.name}
                      onChange={event => onSetupPlayerChange(player.id, { name: event.target.value })}
                      placeholder={`Player ${index + 1}`}
                      style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #c7d0c4", fontSize: 15 }}
                    />
                    <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#324236", fontSize: 14 }}>
                      Color
                      <input
                        type="color"
                        value={player.color}
                        onChange={event => onSetupPlayerChange(player.id, { color: event.target.value })}
                        style={{ width: 44, height: 36, border: "1px solid #c7d0c4", borderRadius: 8, background: "transparent", padding: 2, cursor: "pointer" }}
                      />
                    </label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => onMoveSetupPlayer(player.id, -1)}
                        disabled={index === 0}
                        style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #c7d0c4", background: index === 0 ? "#f2f2f2" : "#ffffff", cursor: index === 0 ? "not-allowed" : "pointer" }}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        onClick={() => onMoveSetupPlayer(player.id, 1)}
                        disabled={index === players.length - 1}
                        style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #c7d0c4", background: index === players.length - 1 ? "#f2f2f2" : "#ffffff", cursor: index === players.length - 1 ? "not-allowed" : "pointer" }}
                      >
                        Down
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveSetupPlayer(player.id)}
                      disabled={players.length <= 2}
                      style={{ padding: "8px 10px", borderRadius: 999, border: "1px solid #c7d0c4", background: players.length <= 2 ? "#f2f2f2" : "#ffffff", cursor: players.length <= 2 ? "not-allowed" : "pointer" }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div>
                  <button
                    type="button"
                    onClick={onAddSetupPlayer}
                    disabled={players.length >= MAX_SETUP_PLAYERS}
                    style={{ padding: "10px 16px", borderRadius: 999, border: "1px solid #c7d0c4", background: players.length >= MAX_SETUP_PLAYERS ? "#f2f2f2" : "#ffffff", cursor: players.length >= MAX_SETUP_PLAYERS ? "not-allowed" : "pointer", fontWeight: 600 }}
                  >
                    Add player
                  </button>
                </div>
              </div>
            </div>
          )}
          {activeTab === "vehicles" && (
            <div style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ color: "#56635a" }}>
                  Edit the vehicle deck directly. These cards are the exact ones the game will use.
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setUserVehicleCards([...userDecks.vehicleCards, createEmptyVehicleCard(nextVehicleNumber)])
                  }
                  style={{ padding: "10px 14px", borderRadius: 999, border: "1px solid #c7d0c4", background: "#ffffff", cursor: "pointer", fontWeight: 600 }}
                >
                  Add vehicle card
                </button>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {userDecks.vehicleCards.map(card => renderVehicleCard(card))}
              </div>
            </div>
          )}
          {activeTab === "chance" && (
            <div style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ color: "#56635a" }}>
                  Edit the chance deck directly. These monthly modifiers are the exact cards the game will shuffle.
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setUserChanceCards([
                      ...userDecks.chanceCards,
                      createEmptyChanceCard(userDecks.chanceCards.length + 1),
                    ])
                  }
                  style={{ padding: "10px 14px", borderRadius: 999, border: "1px solid #c7d0c4", background: "#ffffff", cursor: "pointer", fontWeight: 600 }}
                >
                  Add chance card
                </button>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                {userDecks.chanceCards.map(card => renderChanceCard(card))}
              </div>
            </div>
          )}
          {activeTab === "routes" && (
            <div style={{ display: "grid", gap: 18 }}>
              <div style={{ display: "grid", gap: 18 }}>
                <div style={{ color: "#56635a" }}>
                  Route cards are grouped by transportation type. These are editable now and ready for later gameplay use.
                </div>
                {routeCardsByMode.map(({ mode, cards }) => (
                  <div key={mode} style={{ display: "grid", gap: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                      <strong>{ROUTE_MODE_LABELS[mode]} routes</strong>
                      <button
                        type="button"
                        onClick={() => {
                          const starterCityIds = sortedCities.slice(0, 2).map(city => city.id)
                          const newRouteCard = {
                            ...createEmptyRouteCard(mode),
                            cityIds: starterCityIds,
                          }
                          setUserRouteCards([...userDecks.routeCards, newRouteCard])
                        }}
                        style={{ padding: "10px 14px", borderRadius: 999, border: "1px solid #c7d0c4", background: "#ffffff", cursor: "pointer", fontWeight: 600 }}
                      >
                        Add {ROUTE_MODE_LABELS[mode].toLowerCase()} route
                      </button>
                    </div>
                    <div style={{ display: "grid", gap: 12 }}>
                      {cards.length === 0 ? (
                        <div style={{ color: "#56635a" }}>No {ROUTE_MODE_LABELS[mode].toLowerCase()} route cards yet.</div>
                      ) : (
                        cards.map(card => renderRouteCard(card))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
