/**
 * Worker thread: receives game simulation tasks, runs them, posts results back.
 * Long-lived — handles many tasks over its lifetime via message passing.
 */
import { parentPort } from "worker_threads"
import { measureBotStructure } from "../src/bots/evaluationMetrics.ts"
import { runBotSimulation } from "../src/bots/simulate.ts"
import { createScriptedBot, mergeScriptedBotWeights, type ScriptedBotWeights } from "../src/bots/scriptedBot.ts"
import { buildVictoryStandings } from "../src/engine/economy.ts"
import type { GameSetupPlayer } from "../src/engine/createGameState.ts"
import type { ScriptedBotWeightSample } from "../src/bots/training.ts"

export type SimWorkerTask = {
  seed: number
  /** Corresponds to the seed's index in the seeds array; used to rotate candidate seat and opponent pool. */
  taskIndex: number
  players: GameSetupPlayer[]
  candidateWeights: ScriptedBotWeights
  opponentWeights: ScriptedBotWeights[]
  maxSteps: number
}

export type SimWorkerResponse =
  | { ok: true; result: ScriptedBotWeightSample }
  | { ok: false; error: string }

if (!parentPort) {
  throw new Error("simulationWorker.ts must be run as a worker thread, not directly.")
}

parentPort.on("message", (task: SimWorkerTask) => {
  try {
    const { seed, taskIndex, players, candidateWeights, opponentWeights, maxSteps } = task
    const candidatePlayerId = players[taskIndex % players.length]?.id ?? players[0].id
    let opponentSeatIndex = 0

    const botsByPlayerId = Object.fromEntries(
      players.map(player => [
        player.id,
        createScriptedBot(
          player.id,
          player.id === candidatePlayerId
            ? mergeScriptedBotWeights(candidateWeights)
            : mergeScriptedBotWeights(
                opponentWeights[(taskIndex + opponentSeatIndex++) % opponentWeights.length],
              ),
        ),
      ]),
    )

    const result = runBotSimulation({ seed, players, maxSteps, recordTrace: false, botsByPlayerId })
    const standings = buildVictoryStandings(result.game)
    const candidateStanding = standings.find(s => s.player.id === candidatePlayerId)
    const strongestOpponentStanding = standings.find(s => s.player.id !== candidatePlayerId)
    const passengers = candidateStanding?.player.totalPassengersServed ?? 0
    const opponentPassengers = strongestOpponentStanding?.player.totalPassengersServed ?? 0
    const structureMetrics = measureBotStructure(result.game, candidatePlayerId)

    const response: SimWorkerResponse = {
      ok: true,
      result: {
        seed,
        candidatePlayerId,
        rank:
          candidateStanding === undefined
            ? standings.length + 1
            : standings.findIndex(s => s.player.id === candidatePlayerId) + 1,
        passengers,
        opponentPassengers,
        passengerMargin: passengers - opponentPassengers,
        connectedCities: candidateStanding?.connectedCities ?? 0,
        money: candidateStanding?.player.money ?? 0,
        timedOut: result.timedOut,
        ...structureMetrics,
      },
    }
    parentPort!.postMessage(response)
  } catch (error) {
    const response: SimWorkerResponse = { ok: false, error: String(error) }
    parentPort!.postMessage(response)
  }
})
