import * as fs from 'node:fs'
import * as net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Effect, Layer } from 'effect'
import {
  SocketServer,
  SocketServerLive,
  SocketConfig,
  getSocketPath,
} from './socketServer.js'
import { SessionManager, SessionManagerLive } from './sessionManager.js'

// Wire SessionManager and SocketConfig into SocketServer, then expose both for tests.
const socketConfigLive = Layer.succeed(SocketConfig, { socketPath: getSocketPath() })
const serverLayer = SocketServerLive.pipe(
  Layer.provide(SessionManagerLive),
  Layer.provide(socketConfigLive),
)
const TestLayer = Layer.merge(SessionManagerLive, serverLayer)

const connectClient = (socketPath: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath)
    sock.once('connect', () => resolve(sock))
    sock.once('error', reject)
  })

const writeLine = (sock: net.Socket, line: string): Promise<void> =>
  new Promise((resolve) => {
    sock.write(line + '\n', () => resolve())
  })

const closeClient = (sock: net.Socket): Promise<void> =>
  new Promise((resolve) => {
    sock.once('close', () => resolve())
    sock.destroy()
  })

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const withServer = <A>(
  f: (sm: SessionManager, ss: SocketServer) => Effect.Effect<A, unknown, never>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sm = yield* SessionManager
        const ss = yield* SocketServer
        return yield* f(sm, ss)
      }).pipe(Effect.provide(TestLayer)),
    ),
  )

describe('SocketServer', () => {
  afterEach(() => {
    try {
      fs.unlinkSync(getSocketPath())
    } catch {
      // ignore
    }
  })

  // Scenario 1
  it('creates socket file on start', () =>
    withServer((_sm, ss) =>
      Effect.sync(() => {
        expect(fs.existsSync(ss.socketPath)).toBe(true)
      }),
    ))

  // Scenario 2
  it('valid session_start JSON is processed by session manager', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'test-session-1',
              pid: 42,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(50))
        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.sessionId).toBe('test-session-1')
        expect(sessions[0]?.status).toBe('waiting_for_input')
        expect(sessions[0]?.pid).toBe(42)
        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 3 — malformed JSON
  it('malformed JSON does not crash server, valid next line is processed', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )
        yield* Effect.promise(() =>
          writeLine(client, 'this is not json at all {{{'),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'after-bad-json',
              pid: 1,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(50))
        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.sessionId).toBe('after-bad-json')
        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 3 sub-case — valid JSON with wrong schema
  it('valid JSON with wrong schema does not crash server', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({ event: 'unknown_event_type', session_id: 'c3b8f29d-7e14-4a5b-9d82-1f6e3a4c7b90' }),
          ),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 's1',
              pid: 5,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(50))
        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.sessionId).toBe('s1')
        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 4 — two events in one TCP chunk
  it('two events in one TCP chunk are both processed', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )
        const chunk =
          JSON.stringify({
            event: 'session_start',
            session_id: 'a',
            pid: 1,
          }) +
          '\n' +
          JSON.stringify({
            event: 'session_start',
            session_id: 'b',
            pid: 2,
          }) +
          '\n'
        yield* Effect.promise(
          () => new Promise<void>((resolve) => client.write(chunk, () => resolve())),
        )
        yield* Effect.promise(() => sleep(50))
        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(2)
        const ids = sessions.map((s) => s.sessionId).sort()
        expect(ids).toEqual(['a', 'b'])
        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 4 sub-case — event split across two TCP chunks
  it('event split across two TCP chunks is processed', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )
        const fullLine = JSON.stringify({
          event: 'session_start',
          session_id: 'split-test',
          pid: 99,
        })
        const half = Math.floor(fullLine.length / 2)
        yield* Effect.promise(
          () =>
            new Promise<void>((res) =>
              client.write(fullLine.slice(0, half), () => res()),
            ),
        )
        yield* Effect.promise(() => sleep(10))
        yield* Effect.promise(
          () =>
            new Promise<void>((res) =>
              client.write(fullLine.slice(half) + '\n', () => res()),
            ),
        )
        yield* Effect.promise(() => sleep(50))
        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.sessionId).toBe('split-test')
        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 5 — scope close deletes socket file
  it('scope close deletes the socket file', async () => {
    let socketPath: string | undefined

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ss = yield* SocketServer
          socketPath = ss.socketPath
          expect(fs.existsSync(socketPath)).toBe(true)
        }).pipe(Effect.provide(TestLayer)),
      ),
    )

    expect(fs.existsSync(socketPath!)).toBe(false)
  })

  // Scenario 5 sub-case — stale socket file is overwritten on start
  it('stale socket file from previous run is overwritten on start', () => {
    const socketPath = getSocketPath()
    fs.writeFileSync(socketPath, '')

    return withServer((_sm, ss) =>
      Effect.sync(() => {
        expect(fs.existsSync(ss.socketPath)).toBe(true)
      }),
    )
  })

  // Scenario 6 — two concurrent clients
  it('two concurrent clients both get events processed', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const clients = yield* Effect.promise(
          (): Promise<[net.Socket, net.Socket]> =>
            Promise.all([
              connectClient(ss.socketPath),
              connectClient(ss.socketPath),
            ]),
        )
        const [client1, client2] = clients
        yield* Effect.promise(() =>
          Promise.all([
            writeLine(
              client1,
              JSON.stringify({
                event: 'session_start',
                session_id: 'client1',
                pid: 10,
              }),
            ),
            writeLine(
              client2,
              JSON.stringify({
                event: 'session_start',
                session_id: 'client2',
                pid: 20,
              }),
            ),
          ]),
        )
        yield* Effect.promise(() => sleep(50))
        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(2)
        const ids = sessions.map((s) => s.sessionId).sort()
        expect(ids).toEqual(['client1', 'client2'])
        yield* Effect.promise(() =>
          Promise.all([closeClient(client1), closeClient(client2)]),
        )
      }),
    ))

  // Scenario 7 — full event lifecycle
  it('full lifecycle: session_start → running → waiting → inactive', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 's1',
              pid: 1,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('s1'))?.status).toBe('waiting_for_input')

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 's1',
              prompt: 'hello world',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        const rec = yield* sm.get('s1')
        expect(rec?.status).toBe('running')
        expect(rec?.subtitle).toBe('hello world')

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'pre_tool_use',
              session_id: 's1',
              tool_name: 'Bash',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('s1'))?.status).toBe('running')

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({ event: 'stop', session_id: 's1' }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('s1'))?.status).toBe('waiting_for_input')

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_end',
              session_id: 's1',
              pid: 1,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('s1'))?.status).toBe('inactive')

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 8 — empty lines are silently skipped
  it('empty lines are skipped without error', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )
        yield* Effect.promise(
          () =>
            new Promise<void>((res) =>
              client.write(
                '\n\n\n' +
                  JSON.stringify({
                    event: 'session_start',
                    session_id: 'nonempty',
                    pid: 7,
                  }) +
                  '\n',
                () => res(),
              ),
            ),
        )
        yield* Effect.promise(() => sleep(50))
        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.sessionId).toBe('nonempty')
        yield* Effect.promise(() => closeClient(client))
      }),
    ))
})
