import { useMemo, useState } from "react"
import { CircleMarker, LayerGroup, LayersControl, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet"
import { usMap } from "./data/maps/usMap"

type CompareSegment = {
  id: string
  points: [number, number][]
  allowRail: boolean
}

function buildSegmentPoints(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  curve?: { x?: number; y?: number },
) {
  if (!curve?.x && !curve?.y) {
    return [
      [a.lat, a.lng],
      [b.lat, b.lng],
    ] as [number, number][]
  }

  const midpointLat = (a.lat + b.lat) / 2
  const midpointLng = (a.lng + b.lng) / 2
  const segmentLength = Math.hypot(b.lat - a.lat, b.lng - a.lng)
  const controlLat = midpointLat + segmentLength * (curve.y ?? 0)
  const controlLng = midpointLng + segmentLength * (curve.x ?? 0)

  return Array.from({ length: 17 }, (_, index) => {
    const t = index / 16
    const oneMinusT = 1 - t

    return [
      oneMinusT * oneMinusT * a.lat + 2 * oneMinusT * t * controlLat + t * t * b.lat,
      oneMinusT * oneMinusT * a.lng + 2 * oneMinusT * t * controlLng + t * t * b.lng,
    ] as [number, number]
  })
}

function buildAdjacentSegments() {
  const cityMap = Object.fromEntries(usMap.cities.map(city => [city.id, city]))
  const seenPairs = new Set<string>()

  return usMap.cities.flatMap<CompareSegment>(city =>
    (city.adjacentCities ?? []).flatMap(adjacentCity => {
      const targetCity = cityMap[adjacentCity.id]

      if (!targetCity) {
        return []
      }

      const pairKey = [city.id, targetCity.id].sort().join("|")

      if (seenPairs.has(pairKey)) {
        return []
      }

      seenPairs.add(pairKey)

      const reverseConnection = targetCity.adjacentCities?.find(candidate => candidate.id === city.id)
      const curve = adjacentCity.curve ?? reverseConnection?.curve

      return [
        {
          id: pairKey,
          points: buildSegmentPoints(city, targetCity, curve),
          allowRail:
            adjacentCity.allowRail ??
            reverseConnection?.allowRail ??
            true,
        },
      ]
    }),
  )
}

export default function CompareApp() {
  const [showCityNames, setShowCityNames] = useState(true)
  const [showCities, setShowCities] = useState(true)
  const [showConnections, setShowConnections] = useState(true)
  const [connectionColor, setConnectionColor] = useState("#000000")
  const [railOpacity, setRailOpacity] = useState(0.75)

  const adjacentSegments = useMemo(() => buildAdjacentSegments(), [])
  const bounds = useMemo(
    () => usMap.cities.map(city => [city.lat, city.lng] as [number, number]),
    [],
  )

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: "320px minmax(0, 1fr)",
        fontFamily: "system-ui, sans-serif",
        background: "#edf2ec",
      }}
    >
      <aside
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          borderRight: "1px solid #d5ddd2",
          background: "rgba(255, 255, 255, 0.96)",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <strong>Rail comparison</strong>
          <div style={{ color: "#56635a", fontSize: 13 }}>
            Compare your city graph against OpenRailwayMap without changing the game board.
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gap: 10,
            padding: 12,
            border: "1px solid #d8dfd5",
            borderRadius: 12,
            background: "#f7faf6",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#324236" }}>
            <input type="checkbox" checked={showConnections} onChange={event => setShowConnections(event.target.checked)} />
            <span>Show adjacency lines</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#324236" }}>
            <input type="checkbox" checked={showCities} onChange={event => setShowCities(event.target.checked)} />
            <span>Show city markers</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#324236" }}>
            <input type="checkbox" checked={showCityNames} onChange={event => setShowCityNames(event.target.checked)} />
            <span>Show city names</span>
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 14, color: "#324236" }}>
            <span>OpenRailwayMap opacity: {Math.round(railOpacity * 100)}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(railOpacity * 100)}
              onChange={event => setRailOpacity(Number(event.target.value) / 100)}
            />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 14, color: "#324236" }}>
            <span>Adjacency line color</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="color"
                value={connectionColor}
                onChange={event => setConnectionColor(event.target.value)}
                style={{ width: 40, height: 32, padding: 0, border: "none", background: "transparent" }}
              />
              <code>{connectionColor}</code>
            </div>
          </label>
        </div>

        <div
          style={{
            display: "grid",
            gap: 6,
            padding: 12,
            border: "1px solid #d8dfd5",
            borderRadius: 12,
            background: "#ffffff",
            fontSize: 13,
            color: "#324236",
          }}
        >
          <div>
            <strong>{usMap.cities.length}</strong> cities
          </div>
          <div>
            <strong>{adjacentSegments.length}</strong> unique adjacency links
          </div>
          <div style={{ color: "#56635a" }}>
            URL: <code>/compare.html</code>
          </div>
        </div>

        <div style={{ fontSize: 12, color: "#56635a", lineHeight: 1.45 }}>
          Tiles: OpenStreetMap + OpenRailwayMap. Data and style attribution are shown on the map.
        </div>
        <div style={{ fontSize: 12, color: "#56635a", lineHeight: 1.45 }}>
          Solid lines are car/train. Dashed lines are car-only.
        </div>

        <a href="/" style={{ color: "#1d5d76", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
          Back to game
        </a>
      </aside>

      <main style={{ minWidth: 0 }}>
        <MapContainer
          bounds={bounds}
          scrollWheelZoom
          style={{ height: "100%", width: "100%" }}
        >
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="OpenStreetMap">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
            </LayersControl.BaseLayer>

            <LayersControl.Overlay checked name="OpenRailwayMap">
              <TileLayer
                attribution='Data <a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap contributors</a>, Style <a href="https://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA 2.0</a> <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>'
                url="https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png"
                opacity={railOpacity}
                maxZoom={19}
              />
            </LayersControl.Overlay>

            <LayersControl.Overlay checked={showConnections} name="Transport game links">
              <LayerGroup>
                {showConnections &&
                  adjacentSegments.map(segment => (
                    <Polyline
                      key={segment.id}
                      positions={segment.points}
                      pathOptions={{
                        color: connectionColor,
                        weight: 3,
                        dashArray: segment.allowRail ? undefined : "10 8",
                        opacity: 0.9,
                      }}
                    />
                  ))}
              </LayerGroup>
            </LayersControl.Overlay>

            <LayersControl.Overlay checked={showCities} name="Transport game cities">
              <LayerGroup>
                {showCities &&
                  usMap.cities.map(city => (
                    <CircleMarker
                      key={city.id}
                      center={[city.lat, city.lng]}
                      radius={Math.max(4, city.size + 1)}
                      pathOptions={{
                        color: "#223024",
                        weight: 1.5,
                        fillColor: "#ffffff",
                        fillOpacity: 0.95,
                      }}
                    >
                      {showCityNames && (
                        <Tooltip permanent direction="top" offset={[0, -8]} opacity={1}>
                          {city.name}
                        </Tooltip>
                      )}
                    </CircleMarker>
                  ))}
              </LayerGroup>
            </LayersControl.Overlay>
          </LayersControl>
        </MapContainer>
      </main>
    </div>
  )
}
