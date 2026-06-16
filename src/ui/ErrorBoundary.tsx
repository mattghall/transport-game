import React from "react"
import { usOutline } from "../data/maps/usOutline"
import { usMap } from "../data/maps/usMap"
import { latLngToWorld, WORLD_WIDTH, WORLD_HEIGHT } from "../engine/projection"

interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

// Mirrors the region styles from Board.tsx
const REGION_STYLES: Record<string, { fill: string }> = {
  Pacific:   { fill: "#4d9de0" },
  Mountain:  { fill: "#8a6dd3" },
  South:     { fill: "#e27d60" },
  Southeast: { fill: "#4fb286" },
  Midwest:   { fill: "#d8a031" },
  Northeast: { fill: "#d35d9e" },
}

const REGION_BASE_RADIUS: Record<string, number> = {
  Pacific: 36, Mountain: 38, South: 28, Southeast: 28, Midwest: 30, Northeast: 26,
}

// Extra anchor blobs for better coverage (matches REGION_SHADE_ANCHORS in Board.tsx)
const REGION_ANCHORS = [
  { region: "Pacific",   lat: 45.8, lng: -121.3, radius: 72 },
  { region: "Pacific",   lat: 40.8, lng: -121.2, radius: 76 },
  { region: "Pacific",   lat: 35.8, lng: -119.8, radius: 72 },
  { region: "Pacific",   lat: 39.3, lng: -117.2, radius: 64 },
  { region: "Mountain",  lat: 45.2, lng: -111.5, radius: 78 },
  { region: "Mountain",  lat: 40.7, lng: -111.2, radius: 82 },
  { region: "Mountain",  lat: 35.8, lng: -108.8, radius: 78 },
  { region: "Mountain",  lat: 47.1, lng: -108.2, radius: 64 },
  { region: "Mountain",  lat: 46.7, lng: -101.6, radius: 62 },
  { region: "Mountain",  lat: 44.8, lng: -101.8, radius: 66 },
  { region: "Mountain",  lat: 41.1, lng: -100.3, radius: 60 },
]

// Pre-compute outline path and blobs once (module load, not per-render)
const outlinePath = usOutline
  .map(([lng, lat]) => { const p = latLngToWorld({ lng, lat }); return `${p.x},${p.y}` })
  .join(" L ")

const regionBlobs = [
  ...usMap.cities.map(city => {
    const region = city.region?.[0]
    if (!region || !REGION_STYLES[region]) return null
    const { x, y } = latLngToWorld(city)
    return { region, x, y, radius: (REGION_BASE_RADIUS[region] ?? 30) + city.size * 8 }
  }).filter((b): b is NonNullable<typeof b> => b !== null),
  ...REGION_ANCHORS.map(a => { const { x, y } = latLngToWorld(a); return { ...a, x, y } }),
]

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("React ErrorBoundary caught:", error, info)
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <>
          {/* Layer 1: map background */}
          <div style={{ position: "fixed", inset: 0, zIndex: 99996, background: "#e8efe6" }}>
            <svg
              viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
              width="100%"
              height="100%"
              preserveAspectRatio="xMidYMid slice"
              style={{ display: "block" }}
            >
              <defs>
                <clipPath id="err-map-clip">
                  <path d={`M ${outlinePath} Z`} />
                </clipPath>
                <filter id="err-region-blur" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="20" />
                </filter>
              </defs>
              <path d={`M ${outlinePath} Z`} fill="#f4f1e8" stroke="#c9c2b3" strokeWidth={2} opacity={0.9} />
              <g clipPath="url(#err-map-clip)" filter="url(#err-region-blur)">
                {regionBlobs.map((blob, i) => (
                  <circle
                    key={i}
                    cx={blob.x}
                    cy={blob.y}
                    r={blob.radius}
                    fill={REGION_STYLES[blob.region]?.fill ?? "#888"}
                    opacity={0.22}
                  />
                ))}
              </g>
            </svg>
          </div>
          {/* Layer 2: centered error card */}
          <div style={{
            position: "fixed",
            inset: 0,
            zIndex: 99997,
            overflow: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            boxSizing: "border-box",
          }}>
            <div style={{
              background: "rgba(255,255,255,0.88)",
              backdropFilter: "blur(6px)",
              borderRadius: 16,
              padding: "32px 36px",
              maxWidth: 640,
              width: "100%",
              boxShadow: "0 8px 32px rgba(34,48,36,0.18)",
              border: "1px solid rgba(201,194,179,0.6)",
            }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>🚂💥</div>
              <h1 style={{ color: "#b42318", fontSize: 22, margin: "0 0 6px", fontFamily: "sans-serif", fontWeight: 800 }}>
                Application Error
              </h1>
              <p style={{ color: "#56635a", fontSize: 13, margin: "0 0 16px", fontFamily: "sans-serif" }}>
                Something went wrong. The error details are below.
              </p>
              <div style={{
                background: "#fdf0ec",
                border: "1px solid #e2b8b0",
                borderRadius: 10,
                padding: "12px 14px",
                marginBottom: 16,
              }}>
                <div style={{ color: "#7c1c14", fontWeight: 700, fontFamily: "sans-serif", fontSize: 14, marginBottom: 4 }}>
                  {error.message}
                </div>
                {error.stack && (
                  <pre style={{ color: "#56635a", fontSize: 11, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}>
                    {error.stack}
                  </pre>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => location.reload()}
                  style={{ padding: "9px 20px", background: "#223024", color: "#e8efe6", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "sans-serif", fontWeight: 600 }}
                >
                  Reload page
                </button>
                <button
                  onClick={() => this.setState({ error: null })}
                  style={{ padding: "9px 20px", background: "transparent", color: "#223024", border: "1px solid #c9c2b3", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "sans-serif", fontWeight: 600 }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </>
      )
    }
    return this.props.children
  }
}
