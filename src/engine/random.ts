const DEFAULT_RANDOM_SEED = 0x6d2b79f5

export function createInitialRandomState(seed?: number) {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    const normalizedSeed = Math.trunc(seed) >>> 0
    return normalizedSeed === 0 ? DEFAULT_RANDOM_SEED : normalizedSeed
  }

  const fallbackSeed = Math.floor(Math.random() * 0x1_0000_0000) >>> 0
  return fallbackSeed === 0 ? DEFAULT_RANDOM_SEED : fallbackSeed
}

export function nextRandomState(state?: number) {
  let nextState = createInitialRandomState(state)
  nextState ^= nextState << 13
  nextState ^= nextState >>> 17
  nextState ^= nextState << 5
  nextState >>>= 0

  return nextState === 0 ? DEFAULT_RANDOM_SEED : nextState
}

export function randomFloatFromState(state?: number) {
  const nextStateValue = nextRandomState(state)
  return {
    value: nextStateValue / 0x1_0000_0000,
    randomState: nextStateValue,
  }
}

export function shuffleWithRandomState<T>(items: readonly T[], startingState?: number) {
  const shuffledItems = [...items]
  let randomState = createInitialRandomState(startingState)

  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    const nextRandom = randomFloatFromState(randomState)
    randomState = nextRandom.randomState
    const swapIndex = Math.floor(nextRandom.value * (index + 1))
    const currentItem = shuffledItems[index]
    shuffledItems[index] = shuffledItems[swapIndex]
    shuffledItems[swapIndex] = currentItem
  }

  return {
    items: shuffledItems,
    randomState,
  }
}
