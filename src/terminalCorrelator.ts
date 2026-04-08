import * as child_process from 'node:child_process'
import * as vscode from 'vscode'
import { Effect } from 'effect'

// 7f3a9b2e
const MAX_HOPS = 20

const getParentPid = (pid: number): Effect.Effect<number, Error> =>
  Effect.tryPromise({
    try: (): Promise<number> =>
      new Promise((resolve, reject) => {
        child_process.exec(`ps -o ppid= ${pid}`, (err, stdout) => {
          if (err !== null) {
            reject(err)
            return
          }
          const trimmed = stdout.trim()
          const ppid = parseInt(trimmed, 10)
          if (isNaN(ppid)) {
            reject(new Error(`Could not parse ppid: ${trimmed}`))
          } else {
            resolve(ppid)
          }
        })
      }),
    catch: (e): Error => (e instanceof Error ? e : new Error(String(e))),
  })

const collectTerminalPids = (
  terminals: ReadonlyArray<vscode.Terminal>,
): Effect.Effect<ReadonlyMap<number, vscode.Terminal>, never> =>
  Effect.gen(function* () {
    const map = new Map<number, vscode.Terminal>()
    for (const terminal of terminals) {
      const pid = yield* Effect.tryPromise({
        try: async (): Promise<number | undefined> => terminal.processId,
        catch: (e): Error => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(
        Effect.catchAll((_e) => Effect.succeed<number | undefined>(undefined)),
      )
      if (pid !== undefined) {
        map.set(pid, terminal)
      }
    }
    return map
  })

export const correlateSession = (
  claudePid: number,
  terminals: ReadonlyArray<vscode.Terminal>,
): Effect.Effect<vscode.Terminal | undefined, never> =>
  Effect.gen(function* () {
    const terminalPids = yield* collectTerminalPids(terminals)

    let currentPid = claudePid

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const match = terminalPids.get(currentPid)
      if (match !== undefined) {
        return match
      }

      if (currentPid <= 1) {
        return undefined
      }

      const parentPid = yield* getParentPid(currentPid).pipe(
        Effect.catchAll((_e) => Effect.succeed<number | undefined>(undefined)),
      )

      if (parentPid === undefined) {
        return undefined
      }

      currentPid = parentPid
    }

    return undefined
  })

export interface TerminalCorrelator {
  readonly correlateSession: (
    claudePid: number,
    terminals: ReadonlyArray<vscode.Terminal>,
  ) => Effect.Effect<vscode.Terminal | undefined, never>
}

export const createTerminalCorrelator = (): TerminalCorrelator => ({
  correlateSession,
})
