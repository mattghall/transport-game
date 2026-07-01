import { DEFAULT_BOT_PRESET_ID, normalizeBotPresetId, type BotPresetId } from "../bots/presets"
import { MAX_SETUP_PLAYERS } from "../gameSetup/defaultPlayers"
import type { OperatingConfig } from "../engine/types"

const ADMIN_DEMAND_SETTINGS_STORAGE_KEY = "transport-game-admin-demand-settings-v1"

export type AdminDemandSettings = Pick<
  OperatingConfig,
  "demandPointsPerCitySize" | "passengersPerDemandPoint"
> & {
  dynamicDemand: OperatingConfig["dynamicDemand"]
  chanceCardsEnabled: boolean
  turnTimerSeconds: number
  defaultBotPresetBySeat: Record<string, BotPresetId>
}

export const DEFAULT_ADMIN_DEMAND_SETTINGS: AdminDemandSettings = {
  demandPointsPerCitySize: 45,
  passengersPerDemandPoint: 50,
  chanceCardsEnabled: true,
  turnTimerSeconds: 60,
  defaultBotPresetBySeat: Object.fromEntries(
    Array.from({ length: MAX_SETUP_PLAYERS }, (_, index) => [`p${index + 1}`, DEFAULT_BOT_PRESET_ID]),
  ),
  dynamicDemand: {
    enabled: false,
    lowServiceThreshold: 0.25,
    lowServiceMultiplier: 0.95,
    noServiceThreshold: 0,
    noServiceMultiplier: 0.9,
    highServiceThreshold: 0.75,
    highServiceMultiplier: 1.1,
    fullServiceThreshold: 1,
    fullServiceMultiplier: 1.15,
  },
}

function cloneAdminDemandSettings(settings: AdminDemandSettings): AdminDemandSettings {
  return {
    demandPointsPerCitySize: settings.demandPointsPerCitySize,
    passengersPerDemandPoint: settings.passengersPerDemandPoint,
    chanceCardsEnabled: settings.chanceCardsEnabled,
    turnTimerSeconds: settings.turnTimerSeconds,
    defaultBotPresetBySeat: { ...settings.defaultBotPresetBySeat },
    dynamicDemand: { ...settings.dynamicDemand },
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isAdminDemandSettings(value: unknown): value is AdminDemandSettings {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const settings = value as Partial<AdminDemandSettings>
  const dynamicDemand = settings.dynamicDemand as Partial<OperatingConfig["dynamicDemand"]> | undefined

  return (
    isFiniteNumber(settings.demandPointsPerCitySize) &&
    isFiniteNumber(settings.passengersPerDemandPoint) &&
    (settings.chanceCardsEnabled === undefined || typeof settings.chanceCardsEnabled === "boolean") &&
    (settings.turnTimerSeconds === undefined || isFiniteNumber(settings.turnTimerSeconds)) &&
    typeof dynamicDemand?.enabled === "boolean" &&
    isFiniteNumber(dynamicDemand.lowServiceThreshold) &&
    isFiniteNumber(dynamicDemand.lowServiceMultiplier) &&
    isFiniteNumber(dynamicDemand.noServiceThreshold) &&
    isFiniteNumber(dynamicDemand.noServiceMultiplier) &&
    isFiniteNumber(dynamicDemand.highServiceThreshold) &&
    isFiniteNumber(dynamicDemand.highServiceMultiplier) &&
    isFiniteNumber(dynamicDemand.fullServiceThreshold) &&
    isFiniteNumber(dynamicDemand.fullServiceMultiplier)
  )
}

function normalizeAdminDemandSettings(settings: AdminDemandSettings): AdminDemandSettings {
  return {
    ...cloneAdminDemandSettings(DEFAULT_ADMIN_DEMAND_SETTINGS),
    ...settings,
    chanceCardsEnabled:
      typeof settings.chanceCardsEnabled === "boolean"
        ? settings.chanceCardsEnabled
        : DEFAULT_ADMIN_DEMAND_SETTINGS.chanceCardsEnabled,
    turnTimerSeconds: isFiniteNumber(settings.turnTimerSeconds)
      ? Math.max(0, Math.round(settings.turnTimerSeconds))
      : DEFAULT_ADMIN_DEMAND_SETTINGS.turnTimerSeconds,
    defaultBotPresetBySeat: Object.fromEntries(
      Array.from({ length: MAX_SETUP_PLAYERS }, (_, index) => {
        const playerId = `p${index + 1}`
        const rawPreset = settings.defaultBotPresetBySeat?.[playerId]
        return [playerId, normalizeBotPresetId(rawPreset)]
      }),
    ),
    dynamicDemand: {
      ...DEFAULT_ADMIN_DEMAND_SETTINGS.dynamicDemand,
      ...settings.dynamicDemand,
    },
  }
}

export function loadAdminDemandSettings(): AdminDemandSettings {
  if (typeof window === "undefined") {
    return cloneAdminDemandSettings(DEFAULT_ADMIN_DEMAND_SETTINGS)
  }

  const rawValue = window.localStorage.getItem(ADMIN_DEMAND_SETTINGS_STORAGE_KEY)

  if (!rawValue) {
    return cloneAdminDemandSettings(DEFAULT_ADMIN_DEMAND_SETTINGS)
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown
    return isAdminDemandSettings(parsed)
      ? normalizeAdminDemandSettings(parsed)
      : cloneAdminDemandSettings(DEFAULT_ADMIN_DEMAND_SETTINGS)
  } catch {
    return cloneAdminDemandSettings(DEFAULT_ADMIN_DEMAND_SETTINGS)
  }
}

export function saveAdminDemandSettings(settings: AdminDemandSettings) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(
    ADMIN_DEMAND_SETTINGS_STORAGE_KEY,
    JSON.stringify(cloneAdminDemandSettings(settings)),
  )
}

export function pickAdminDemandSettings(
  config: OperatingConfig,
  baseSettings: AdminDemandSettings = DEFAULT_ADMIN_DEMAND_SETTINGS,
): AdminDemandSettings {
  return {
    ...cloneAdminDemandSettings(baseSettings),
    demandPointsPerCitySize: config.demandPointsPerCitySize,
    passengersPerDemandPoint: config.passengersPerDemandPoint,
    dynamicDemand: { ...config.dynamicDemand },
  }
}

export function applyAdminDemandSettings(
  config: OperatingConfig,
  settings: AdminDemandSettings,
): OperatingConfig {
  return {
    ...config,
    demandPointsPerCitySize: settings.demandPointsPerCitySize,
    passengersPerDemandPoint: settings.passengersPerDemandPoint,
    dynamicDemand: {
      ...config.dynamicDemand,
      ...settings.dynamicDemand,
    },
  }
}

export function getDefaultBotPresetForSeat(
  settings: Pick<AdminDemandSettings, "defaultBotPresetBySeat">,
  playerId: string,
) {
  return normalizeBotPresetId(settings.defaultBotPresetBySeat[playerId])
}
