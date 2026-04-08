import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn<
    (
      cmd: string,
      cb: (error: Error | null, stdout: string, stderr: string) => void,
    ) => void
  >(),
}))

vi.mock('node:child_process', () => ({
  exec: mockExec,
}))

vi.mock('vscode', () => ({}))

import {
  correlateSession,
  createTerminalCorrelator,
} from './terminalCorrelator.js'

const makeTerminal = (
  name: string,
  pid: number | undefined,
): { name: string; processId: Promise<number | undefined> } => ({
  name,
  processId: Promise.resolve(pid),
})

const setExecPpid = (ppid: number): void => {
  mockExec.mockImplementation((_cmd, cb) => {
    cb(null, `${ppid}\n`, '')
  })
}

const setExecError = (message: string): void => {
  mockExec.mockImplementation((_cmd, cb) => {
    cb(new Error(message), '', '')
  })
}

const setExecWalk = (ppids: number[]): void => {
  let call = 0
  mockExec.mockImplementation((_cmd, cb) => {
    const ppid = ppids[call++] ?? 1
    cb(null, `${ppid}\n`, '')
  })
}

describe('correlateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches when parent PID is a terminal PID', async () => {
    const terminal = makeTerminal('bash', 100)
    setExecPpid(100)

    const result = await Effect.runPromise(
      correlateSession(200, [terminal as never]),
    )

    expect(result).toBe(terminal)
  })

  it('walks two levels up to find the terminal', async () => {
    const terminal = makeTerminal('bash', 50)
    setExecWalk([150, 50])

    const result = await Effect.runPromise(
      correlateSession(200, [terminal as never]),
    )

    expect(result).toBe(terminal)
  })

  it('returns undefined after 20 hops without a match', async () => {
    const terminal = makeTerminal('bash', 9999)
    let current = 1000
    mockExec.mockImplementation((_cmd, cb) => {
      cb(null, `${--current}\n`, '')
    })

    const result = await Effect.runPromise(
      correlateSession(1000, [terminal as never]),
    )

    expect(result).toBeUndefined()
    expect(mockExec).toHaveBeenCalledTimes(20)
  })

  it('skips terminals whose processId is undefined', async () => {
    const t1 = makeTerminal('no-pid', undefined)
    const t2 = makeTerminal('bash', 100)
    setExecPpid(100)

    const result = await Effect.runPromise(
      correlateSession(200, [t1, t2] as never),
    )

    expect(result).toBe(t2)
  })

  it('returns undefined when ps command fails', async () => {
    const terminal = makeTerminal('bash', 100)
    setExecError('No such process')

    const result = await Effect.runPromise(
      correlateSession(200, [terminal as never]),
    )

    expect(result).toBeUndefined()
  })

  it('matches the correct terminal among multiple', async () => {
    const t1 = makeTerminal('bash-1', 100)
    const t2 = makeTerminal('bash-2', 200)
    const t3 = makeTerminal('bash-3', 300)
    setExecPpid(200)

    const result = await Effect.runPromise(
      correlateSession(400, [t1, t2, t3] as never),
    )

    expect(result).toBe(t2)
  })

  it('matches immediately when claudePid is itself a terminal PID', async () => {
    const terminal = makeTerminal('bash', 200)

    const result = await Effect.runPromise(
      correlateSession(200, [terminal as never]),
    )

    expect(result).toBe(terminal)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('returns undefined when walk reaches PID 1', async () => {
    const terminal = makeTerminal('bash', 999)
    setExecWalk([2, 1])

    const result = await Effect.runPromise(
      correlateSession(3, [terminal as never]),
    )

    expect(result).toBeUndefined()
  })
})

describe('createTerminalCorrelator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createTerminalCorrelator returns an object with correlateSession', async () => {
    const correlator = createTerminalCorrelator()
    const terminal = makeTerminal('bash', 100)
    setExecPpid(100)

    const result = await Effect.runPromise(
      correlator.correlateSession(200, [terminal as never]),
    )

    expect(result).toBe(terminal)
  })
})
