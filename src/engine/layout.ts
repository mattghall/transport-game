import { WORLD_HEIGHT, WORLD_WIDTH, latLngToWorld } from "./projection"

type City = {
  id: string
  name: string
  lat: number
  lng: number
  size: number
}

type Label = {
  cityId: string
  textX: number
  textY: number
  textAnchor: "start" | "middle" | "end"
  boxX: number
  boxY: number
  width: number
  height: number
  distance: number
  connectorX: number
  connectorY: number
}

const LABEL_HEIGHT = 16
const CHAR_WIDTH = 6.6
const LABEL_PADDING_X = 4
const LABEL_MARGIN = 4
const CITY_CLEARANCE = 6
const MAP_PADDING = 8

type CandidateDirection =
  | "east"
  | "west"
  | "north"
  | "south"
  | "northEast"
  | "northWest"
  | "southEast"
  | "southWest"

type Candidate = {
  direction: CandidateDirection
  distance: number
}

const ALL_DIRECTIONS: CandidateDirection[] = [
  "east",
  "west",
  "north",
  "south",
  "northEast",
  "northWest",
  "southEast",
  "southWest",
]

function estimateLabelWidth(name: string) {
  return name.length * CHAR_WIDTH + LABEL_PADDING_X * 2
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max))
}

function uniqueDirections(directions: CandidateDirection[]) {
  return directions.filter(
    (direction, index) => directions.indexOf(direction) === index,
  )
}

function getPreferredDirections(base: { x: number; y: number }): CandidateDirection[] {
  const edgeDistances = [
    { edge: "west", distance: base.x },
    { edge: "east", distance: WORLD_WIDTH - base.x },
    { edge: "north", distance: base.y },
    { edge: "south", distance: WORLD_HEIGHT - base.y },
  ].sort((a, b) => a.distance - b.distance)

  const [primaryEdge, secondaryEdge] = edgeDistances

  switch (primaryEdge.edge) {
    case "west":
      return uniqueDirections([
        "west",
        "northWest",
        "southWest",
        "north",
        "south",
        ...ALL_DIRECTIONS,
      ])
    case "east":
      return uniqueDirections([
        "east",
        "northEast",
        "southEast",
        "north",
        "south",
        ...ALL_DIRECTIONS,
      ])
    case "north":
      return uniqueDirections([
        "north",
        secondaryEdge.edge === "west" ? "northWest" : "northEast",
        secondaryEdge.edge === "west" ? "west" : "east",
        secondaryEdge.edge === "west" ? "northEast" : "northWest",
        secondaryEdge.edge === "west" ? "east" : "west",
        ...ALL_DIRECTIONS,
      ])
    case "south":
      return uniqueDirections([
        "south",
        secondaryEdge.edge === "west" ? "southWest" : "southEast",
        secondaryEdge.edge === "west" ? "west" : "east",
        secondaryEdge.edge === "west" ? "southEast" : "southWest",
        secondaryEdge.edge === "west" ? "east" : "west",
        ...ALL_DIRECTIONS,
      ])
  }

  return ALL_DIRECTIONS
}

function measureOverflow(label: Label) {
  const overflowLeft = Math.max(0, MAP_PADDING - label.boxX)
  const overflowTop = Math.max(0, MAP_PADDING - label.boxY)
  const overflowRight = Math.max(
    0,
    label.boxX + label.width - (WORLD_WIDTH - MAP_PADDING),
  )
  const overflowBottom = Math.max(
    0,
    label.boxY + label.height - (WORLD_HEIGHT - MAP_PADDING),
  )

  return overflowLeft + overflowTop + overflowRight + overflowBottom
}

function createLabel(
  city: City,
  base: { x: number; y: number },
  candidate: Candidate,
): Label {
  const width = estimateLabelWidth(city.name)
  const height = LABEL_HEIGHT
  const distance = candidate.distance

  let boxX = base.x
  let boxY = base.y - height / 2
  let textX = base.x
  let textAnchor: Label["textAnchor"] = "start"

  switch (candidate.direction) {
    case "east":
      boxX = base.x + distance
      boxY = base.y - height / 2
      textX = boxX + LABEL_PADDING_X
      textAnchor = "start"
      break
    case "west":
      boxX = base.x - distance - width
      boxY = base.y - height / 2
      textX = boxX + width - LABEL_PADDING_X
      textAnchor = "end"
      break
    case "north":
      boxX = base.x - width / 2
      boxY = base.y - distance - height
      textX = base.x
      textAnchor = "middle"
      break
    case "south":
      boxX = base.x - width / 2
      boxY = base.y + distance
      textX = base.x
      textAnchor = "middle"
      break
    case "northEast":
      boxX = base.x + distance
      boxY = base.y - distance - height
      textX = boxX + LABEL_PADDING_X
      textAnchor = "start"
      break
    case "northWest":
      boxX = base.x - distance - width
      boxY = base.y - distance - height
      textX = boxX + width - LABEL_PADDING_X
      textAnchor = "end"
      break
    case "southEast":
      boxX = base.x + distance
      boxY = base.y + distance
      textX = boxX + LABEL_PADDING_X
      textAnchor = "start"
      break
    case "southWest":
      boxX = base.x - distance - width
      boxY = base.y + distance
      textX = boxX + width - LABEL_PADDING_X
      textAnchor = "end"
      break
  }

  const connectorX =
    candidate.direction === "east" ||
    candidate.direction === "northEast" ||
    candidate.direction === "southEast"
      ? boxX
      : candidate.direction === "west" ||
          candidate.direction === "northWest" ||
          candidate.direction === "southWest"
        ? boxX + width
        : base.x

  const connectorY =
    candidate.direction === "north" ||
    candidate.direction === "northEast" ||
    candidate.direction === "northWest"
      ? boxY + height
      : candidate.direction === "south" ||
          candidate.direction === "southEast" ||
          candidate.direction === "southWest"
        ? boxY
        : base.y

  return {
    cityId: city.id,
    textX,
    textY: clamp(boxY + height / 2, MAP_PADDING, WORLD_HEIGHT - MAP_PADDING),
    textAnchor,
    boxX,
    boxY,
    width,
    height,
    distance,
    connectorX: clamp(connectorX, boxX, boxX + width),
    connectorY: clamp(connectorY, boxY, boxY + height),
  }
}

function rectCircleCollide(
  rect: Label,
  circle: { x: number; y: number; r: number },
) {
  const closestX = Math.max(
    rect.boxX - LABEL_MARGIN,
    Math.min(circle.x, rect.boxX + rect.width + LABEL_MARGIN),
  )

  const closestY = Math.max(
    rect.boxY - LABEL_MARGIN,
    Math.min(circle.y, rect.boxY + rect.height + LABEL_MARGIN),
  )

  const dx = circle.x - closestX
  const dy = circle.y - closestY

  const clearanceRadius = circle.r + CITY_CLEARANCE

  return dx * dx + dy * dy < clearanceRadius * clearanceRadius
}

function intersects(a: Label, b: Label) {
  return !(
    a.boxX + a.width + LABEL_MARGIN < b.boxX - LABEL_MARGIN ||
    a.boxX - LABEL_MARGIN > b.boxX + b.width + LABEL_MARGIN ||
    a.boxY + a.height + LABEL_MARGIN < b.boxY - LABEL_MARGIN ||
    a.boxY - LABEL_MARGIN > b.boxY + b.height + LABEL_MARGIN
  )
}

export function computeLabels(cities: City[], zoomScale = 1): Label[] {
  const labels: Label[] = []
  const spreadFactor = 1 + Math.max(0, zoomScale - 1) * 0.45

  // city collision shapes
  const circles = cities.map(city => {
    const p = latLngToWorld(city)
    return {
      cityId: city.id,
      x: p.x,
      y: p.y,
      r: city.size * 2.5,
    }
  })

  const getPenalty = (
    city: City,
    label: Label,
    directionRank: number,
  ) => {
    let penalty = measureOverflow(label) * 100
    const distanceWeight = city.size <= 2 ? 24 : city.size <= 4 ? 16 : 10
    const directionPenalty = directionRank * 40

    penalty += Math.max(0, label.distance - (city.size * 2.5 + 4)) * distanceWeight
    penalty += directionPenalty

    for (const c of circles) {
      if (c.cityId === city.id) {
        continue
      }

      if (rectCircleCollide(label, c)) {
        penalty += 1000
      }
    }

    for (const l of labels) {
      if (intersects(label, l)) {
        penalty += 1200
      }
    }

    return penalty
  }

  const orderedCities = [...cities].sort((a, b) => {
    if (b.size !== a.size) {
      return b.size - a.size
    }

    return a.name.localeCompare(b.name)
  })

  for (const city of orderedCities) {
    const base = latLngToWorld(city)
    const directions = getPreferredDirections(base)
    const startDistance = (city.size * 2.5 + 4) * spreadFactor
    const distanceSteps = city.size <= 2
      ? [
          startDistance,
          startDistance + 6 * spreadFactor,
          startDistance + 12 * spreadFactor,
          startDistance + 18 * spreadFactor,
          startDistance + 26 * spreadFactor,
        ]
      : [
          startDistance,
          startDistance + 8 * spreadFactor,
          startDistance + 16 * spreadFactor,
          startDistance + 26 * spreadFactor,
          startDistance + 38 * spreadFactor,
        ]

    let bestLabel: Label | undefined
    let bestPenalty = Number.POSITIVE_INFINITY

    for (const distance of distanceSteps) {
      for (const [directionRank, direction] of directions.entries()) {
        const label = createLabel(city, base, { direction, distance })
        const penalty = getPenalty(city, label, directionRank)

        if (penalty < bestPenalty) {
          bestPenalty = penalty
          bestLabel = label
        }

        if (penalty === 0) {
          labels.push(label)
          bestLabel = undefined
          bestPenalty = 0
          break
        }
      }

      if (bestPenalty === 0) {
        break
      }
    }

    if (bestLabel) {
      labels.push(bestLabel)
      continue
    }
  }

  return labels
}
