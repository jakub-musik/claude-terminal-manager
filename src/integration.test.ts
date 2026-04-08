import * as fs from 'node:fs'
import * as net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Deferred, Effect, Fiber, Layer, Stream } from 'effect'
import {
  SocketServer,
  SocketServerLive,
  SocketConfig,
  getSocketPath,
} from './socketServer.js'
import { SessionManager, SessionManagerLive } from './sessionManager.js'

// Wire SessionManager and SocketConfig into SocketServer, then expose both.
const socketConfigLive = Layer.succeed(SocketConfig, { socketPath: getSocketPath() })
const serverLayer = SocketServerLive.pipe(
  Layer.provide(SessionManagerLive),
  Layer.provide(socketConfigLive),
)
const TestLayer = Layer.merge(SessionManagerLive, serverLayer)

// ── helpers ──────────────────────────────────────────────────────────────────

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

/** Run a test inside a scoped Effect environment with real layers. */
const withServer = <A>(
  f: (sm: SessionManager, ss: SocketServer) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sm = yield* SessionManager
        const ss = yield* SocketServer
        return yield* f(sm, ss)
      }).pipe(Effect.provide(TestLayer)),
    ),
  )

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Integration: full event pipeline (socket → session manager → state)', () => {
  afterEach(() => {
    try {
      fs.unlinkSync(getSocketPath())
    } catch {
      // Best-effort; withServer's scope finaliser already deletes it.
    }
  })

  // Scenario 1: full event sequence with per-step assertions
  it(
    'SessionStart → UserPromptSubmit → PreToolUse → Stop → SessionEnd transitions state correctly',
    () =>
      withServer((sm, ss) =>
        Effect.gen(function* () {
          const client = yield* Effect.promise(() =>
            connectClient(ss.socketPath),
          )

          // Step 1 — session_start: 1 session, status='active', pid set
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'session_start',
                session_id: 'sess-1',
                pid: 1001,
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const sessions1 = yield* sm.getAll()
          expect(sessions1).toHaveLength(1)
          const r1 = sessions1[0]!
          expect(r1.sessionId).toBe('sess-1')
          expect(r1.status).toBe('waiting_for_input')
          expect(r1.pid).toBe(1001)

          // Step 2 — user_prompt_submit: status='running', subtitle captured
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'user_prompt_submit',
                session_id: 'sess-1',
                prompt: 'Do the thing',
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r2 = (yield* sm.get('sess-1'))!
          expect(r2.status).toBe('running')
          expect(r2.subtitle).toBe('Do the thing')

          // Step 3 — pre_tool_use: still running, no state change
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'pre_tool_use',
                session_id: 'sess-1',
                tool_name: 'Bash',
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r3 = (yield* sm.get('sess-1'))!
          expect(r3.status).toBe('running')

          // Step 4 — stop: status='waiting_for_input'
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({ event: 'stop', session_id: 'sess-1' }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r4 = (yield* sm.get('sess-1'))!
          expect(r4.status).toBe('waiting_for_input')

          // Step 5 — session_end: status='inactive'
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'session_end',
                session_id: 'sess-1',
                pid: 1001,
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r5 = (yield* sm.get('sess-1'))!
          expect(r5.status).toBe('inactive')

          yield* Effect.promise(() => closeClient(client))
        }),
      ),
  )

  // Scenario 2: subtitle is only captured from the first UserPromptSubmit
  it('subtitle is updated on each UserPromptSubmit', () =>
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
              session_id: 'sess-sub',
              pid: 2001,
            }),
          ),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 'sess-sub',
              prompt: 'first prompt here',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('sess-sub'))?.subtitle).toBe('first prompt here')

        // Cycle back to waiting_for_input, then send a second UserPromptSubmit
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({ event: 'stop', session_id: 'sess-sub' }),
          ),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 'sess-sub',
              prompt: 'second prompt should not overwrite',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        const rec = (yield* sm.get('sess-sub'))!
        expect(rec.subtitle).toBe('second prompt should not overwrite')
        expect(rec.status).toBe('running')

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 3: changes stream receives all socket-triggered updates
  it('changes stream emits an entry for every socket event processed', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )

        // Use a Deferred to gate on the stream fiber's first (snapshot)
        // emission before sending events — prevents missed updates.
        const ready = yield* Deferred.make<void>()

        const streamFiber = yield* Effect.fork(
          sm.changes.pipe(
            Stream.tap((_arr) => Deferred.succeed(ready, undefined)),
            Stream.take(3),
            Stream.runCollect,
          ),
        )

        // Suspend main fiber until stream fiber has subscribed and emitted
        // the initial empty snapshot.
        yield* Deferred.await(ready)

        // Send 2 events — together with the initial snapshot these yield 3
        // total emissions, satisfying Stream.take(3).
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'stream-1',
              pid: 3001,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 'stream-1',
              prompt: 'stream test',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        // Fiber.join blocks until Stream.take(3) is satisfied.
        const emissions = yield* Fiber.join(streamFiber)
        const arr = Array.from(emissions)
        expect(arr).toHaveLength(3)

        // Emission 1: initial empty snapshot
        expect(arr[0]).toHaveLength(0)

        // Emission 2: after session_start — 1 active session
        expect(arr[1]).toHaveLength(1)
        expect(arr[1]![0]!.status).toBe('waiting_for_input')
        expect(arr[1]![0]!.sessionId).toBe('stream-1')

        // Emission 3: after user_prompt_submit — running
        expect(arr[2]).toHaveLength(1)
        expect(arr[2]![0]!.status).toBe('running')

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 4: malformed JSON between valid events does not crash the server
  it('server continues processing after malformed JSON', () =>
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
              session_id: 'before-bad',
              pid: 4001,
            }),
          ),
        )
        // Malformed JSON
        yield* Effect.promise(() =>
          writeLine(client, '{ this is : not : valid json !!!'),
        )
        // Valid JSON with wrong schema
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({ event: 'unknown_event_xyz', session_id: 'x' }),
          ),
        )
        // Valid event after the bad ones
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'after-bad',
              pid: 4002,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(50))

        const sessions = yield* sm.getAll()
        expect(sessions).toHaveLength(2)
        const ids = sessions.map((s) => s.sessionId).sort()
        expect(ids).toEqual(['after-bad', 'before-bad'])

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 5: session_start without pid defaults to pid=0
  it('session_start without pid field creates session with pid=0', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({ event: 'session_start', session_id: 'no-pid' }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        const session = yield* sm.get('no-pid')
        expect(session).toBeDefined()
        expect(session!.pid).toBe(0)

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 6: session_start with pid uses provided value
  it('session_start with pid field creates session with that pid', () =>
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
              session_id: 'with-pid',
              pid: 42,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        const session = yield* sm.get('with-pid')
        expect(session).toBeDefined()
        expect(session!.pid).toBe(42)

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Scenario 7: two concurrent sessions tracked independently
  it('two concurrent sessions are tracked independently through the full lifecycle', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )

        // Start both sessions
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'session-A',
              pid: 5001,
            }),
          ),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'session-B',
              pid: 5002,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.getAll())).toHaveLength(2)

        // Advance both to running
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 'session-A',
              prompt: 'A prompt',
            }),
          ),
        )
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 'session-B',
              prompt: 'B prompt',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('session-A'))?.status).toBe('running')
        expect((yield* sm.get('session-B'))?.status).toBe('running')
        expect((yield* sm.get('session-A'))?.subtitle).toBe('A prompt')
        expect((yield* sm.get('session-B'))?.subtitle).toBe('B prompt')

        // Stop session-A — session-B must remain running
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({ event: 'stop', session_id: 'session-A' }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('session-A'))?.status).toBe('waiting_for_input')
        expect((yield* sm.get('session-B'))?.status).toBe('running')

        // Stop session-B — session-A must remain waiting_for_input
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({ event: 'stop', session_id: 'session-B' }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('session-A'))?.status).toBe('waiting_for_input')
        expect((yield* sm.get('session-B'))?.status).toBe('waiting_for_input')

        yield* Effect.promise(() => closeClient(client))
      }),
    ))
})

// ── T5.11 Codex integration tests ────────────────────────────────────────────

describe('Codex session integration (T5.11)', () => {
  afterEach(() => {
    try {
      fs.unlinkSync(getSocketPath())
    } catch {
      // Best-effort cleanup
    }
  })

  // Test 1.1 — Full Codex session lifecycle with source='codex'
  it(
    'full Codex session lifecycle: start → prompt → tool → stop → end',
    () =>
      withServer((sm, ss) =>
        Effect.gen(function* () {
          const client = yield* Effect.promise(() =>
            connectClient(ss.socketPath),
          )

          // Step 1 — session_start with source='codex'
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'session_start',
                session_id: 'codex-1',
                pid: 7001,
                source: 'codex',
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r1 = (yield* sm.get('codex-1'))!
          expect(r1.status).toBe('waiting_for_input')
          expect(r1.pid).toBe(7001)
          expect(r1.source).toBe('codex')

          // Step 2 — user_prompt_submit
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'user_prompt_submit',
                session_id: 'codex-1',
                prompt: 'Build the thing',
                source: 'codex',
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r2 = (yield* sm.get('codex-1'))!
          expect(r2.status).toBe('running')
          expect(r2.subtitle).toBe('Build the thing')
          expect(r2.source).toBe('codex')

          // Step 3 — pre_tool_use (Bash) — no attention dot
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'pre_tool_use',
                session_id: 'codex-1',
                tool_name: 'Bash',
                source: 'codex',
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r3 = (yield* sm.get('codex-1'))!
          expect(r3.status).toBe('running')
          expect(r3.needsAttention).toBe(false)
          expect(r3.source).toBe('codex')

          // Step 4 — stop: triggers attention dot
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'stop',
                session_id: 'codex-1',
                source: 'codex',
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r4 = (yield* sm.get('codex-1'))!
          expect(r4.status).toBe('waiting_for_input')
          expect(r4.needsAttention).toBe(true)
          expect(r4.source).toBe('codex')

          // Step 5 — session_end
          yield* Effect.promise(() =>
            writeLine(
              client,
              JSON.stringify({
                event: 'session_end',
                session_id: 'codex-1',
                pid: 7001,
                source: 'codex',
              }),
            ),
          )
          yield* Effect.promise(() => sleep(30))
          const r5 = (yield* sm.get('codex-1'))!
          expect(r5.status).toBe('inactive')
          expect(r5.source).toBe('codex')

          yield* Effect.promise(() => closeClient(client))
        }),
      ),
  )

  // Test 1.2 — session_start without source defaults to 'claude'
  it('session_start without explicit source defaults to claude', () =>
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
              session_id: 'no-src',
              pid: 7002,
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        const session = (yield* sm.get('no-src'))!
        expect(session).toBeDefined()
        expect(session.source).toBe('claude')

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Test 1.3 — Codex source preserved through changes stream
  it('Codex source preserved through changes stream', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )

        const ready = yield* Deferred.make<void>()

        const streamFiber = yield* Effect.fork(
          sm.changes.pipe(
            Stream.tap((_arr) => Deferred.succeed(ready, undefined)),
            Stream.take(3),
            Stream.runCollect,
          ),
        )

        yield* Deferred.await(ready)

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'codex-stream',
              pid: 7003,
              source: 'codex',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 'codex-stream',
              prompt: 'stream test',
              source: 'codex',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        const emissions = yield* Fiber.join(streamFiber)
        const arr = Array.from(emissions)
        expect(arr).toHaveLength(3)

        // Emission 1: initial empty snapshot
        expect(arr[0]).toHaveLength(0)

        // Emission 2: after session_start — source='codex'
        expect(arr[1]).toHaveLength(1)
        expect(arr[1]![0]!.source).toBe('codex')
        expect(arr[1]![0]!.status).toBe('waiting_for_input')

        // Emission 3: after user_prompt_submit — still source='codex'
        expect(arr[2]).toHaveLength(1)
        expect(arr[2]![0]!.source).toBe('codex')
        expect(arr[2]![0]!.status).toBe('running')

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Test 2.1 — Mixed Claude + Codex sessions tracked independently
  it('mixed Claude and Codex sessions tracked independently', () =>
    withServer((sm, ss) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() =>
          connectClient(ss.socketPath),
        )

        // Start Claude session (no source — defaults to claude)
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'claude-sess',
              pid: 8001,
            }),
          ),
        )
        // Start Codex session
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'session_start',
              session_id: 'codex-sess',
              pid: 8002,
              source: 'codex',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))

        const all = yield* sm.getAll()
        expect(all).toHaveLength(2)
        const claudeSession = all.find(
          (session) => session.sessionId === 'claude-sess',
        )!
        const codexSession = all.find(
          (session) => session.sessionId === 'codex-sess',
        )!
        expect(claudeSession.source).toBe('claude')
        expect(codexSession.source).toBe('codex')

        // Advance only codex-sess to running
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'user_prompt_submit',
              session_id: 'codex-sess',
              prompt: 'codex prompt',
              source: 'codex',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('codex-sess'))!.status).toBe('running')
        expect((yield* sm.get('claude-sess'))!.status).toBe(
          'waiting_for_input',
        )

        // Stop claude-sess — codex-sess remains running
        yield* Effect.promise(() =>
          writeLine(
            client,
            JSON.stringify({
              event: 'stop',
              session_id: 'claude-sess',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(30))
        expect((yield* sm.get('claude-sess'))!.needsAttention).toBe(true)
        expect((yield* sm.get('codex-sess'))!.status).toBe('running')
        expect((yield* sm.get('codex-sess'))!.source).toBe('codex')
        expect((yield* sm.get('claude-sess'))!.source).toBe('claude')

        yield* Effect.promise(() => closeClient(client))
      }),
    ))

  // Test 6.1 — Slug resolution skipped for Codex sessions (indirect)
  it('Codex session slug remains undefined (slug resolution skipped)', () =>
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
              session_id: 'codex-noslug',
              pid: 9001,
              source: 'codex',
            }),
          ),
        )
        yield* Effect.promise(() => sleep(50))

        const session = (yield* sm.get('codex-noslug'))!
        expect(session.source).toBe('codex')
        expect(session.slug).toBeUndefined()

        yield* Effect.promise(() => closeClient(client))
      }),
    ))
})
