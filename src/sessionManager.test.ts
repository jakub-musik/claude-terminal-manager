import { describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Stream, TestClock } from 'effect'
import { expect } from 'vitest'
import { SessionManager, SessionManagerLive, makeSessionManagerLive } from './sessionManager.js'
import type { HookEvent } from './schemas.js'

const sessionStart = (session_id: string, pid = 42): HookEvent => ({
  event: 'session_start',
  session_id,
  pid,
})

const userPromptSubmit = (session_id: string, prompt: string): HookEvent => ({
  event: 'user_prompt_submit',
  session_id,
  prompt,
})

const stop = (session_id: string): HookEvent => ({
  event: 'stop',
  session_id,
})

const sessionEnd = (session_id: string, pid = 42): HookEvent => ({
  event: 'session_end',
  session_id,
  pid,
})

const preToolUse = (session_id: string, tool_name: string): HookEvent => ({
  event: 'pre_tool_use',
  session_id,
  tool_name,
})

describe('SessionManager', () => {
  // Scenario 1
  it.effect('SessionStart creates a new active session', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1', 99))
      const all = yield* mgr.getAll()
      expect(all).toHaveLength(1)
      const record = all[0]!
      expect(record.sessionId).toBe('test-1')
      expect(record.status).toBe('waiting_for_input')
      expect(record.pid).toBe(99)
      expect(record.subtitle).toBeUndefined()
      expect(record.terminalId).toBeUndefined()
      expect(record.customName).toBeUndefined()
      expect(record.statusLabel).toBeUndefined()
      expect(typeof record.lastEventAt).toBe('number')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 2
  it.effect('duplicate SessionStart updates pid and timestamp', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1', 10))
      const first = (yield* mgr.get('test-1'))!
      yield* mgr.processEvent(sessionStart('test-1', 20))
      const all = yield* mgr.getAll()
      expect(all).toHaveLength(1)
      const second = all[0]!
      expect(second.pid).toBe(20)
      expect(second.status).toBe('waiting_for_input')
      expect(second.lastEventAt).toBeGreaterThanOrEqual(first.lastEventAt)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 2b — /clear: new session with same pid retires old session
  it.effect('new SessionStart with same pid retires old session', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('old-session', 5000))
      yield* mgr.processEvent(userPromptSubmit('old-session', 'do work'))
      yield* mgr.processEvent(stop('old-session'))
      expect((yield* mgr.get('old-session'))?.status).toBe('waiting_for_input')

      // /clear creates a new session with the same pid
      yield* mgr.processEvent(sessionStart('new-session', 5000))
      const oldSession = yield* mgr.get('old-session')
      expect(oldSession?.status).toBe('inactive')
      const newSession = yield* mgr.get('new-session')
      expect(newSession?.status).toBe('waiting_for_input')
      // Only the new session should be non-inactive
      const all = yield* mgr.getAll()
      const active = all.filter((s) => s.status !== 'inactive')
      expect(active).toHaveLength(1)
      expect(active[0]!.sessionId).toBe('new-session')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 2c — pid=0 does not retire other sessions
  it.effect('SessionStart with pid=0 does not retire other sessions', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1', 0))
      yield* mgr.processEvent(sessionStart('s2', 0))
      const all = yield* mgr.getAll()
      expect(all).toHaveLength(2)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 3
  it.effect('UserPromptSubmit transitions to running and captures subtitle', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1'))
      yield* mgr.processEvent(userPromptSubmit('test-1', 'do something'))
      const record = (yield* mgr.get('test-1'))!
      expect(record.status).toBe('running')
      expect(record.subtitle).toBe('do something')
      expect(record.statusLabel).toBeUndefined()
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('UserPromptSubmit truncates subtitle to 70 chars', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1'))
      const longPrompt = 'x'.repeat(100)
      yield* mgr.processEvent(userPromptSubmit('test-1', longPrompt))
      const record = (yield* mgr.get('test-1'))!
      expect(record.subtitle).toHaveLength(70)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('subtitle updated on second UserPromptSubmit', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1'))
      yield* mgr.processEvent(userPromptSubmit('test-1', 'first prompt'))
      yield* mgr.processEvent(stop('test-1'))
      yield* mgr.processEvent(userPromptSubmit('test-1', 'second prompt'))
      const record = (yield* mgr.get('test-1'))!
      expect(record.subtitle).toBe('second prompt')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 4
  it.effect('Stop transitions to waiting_for_input with needsAttention=true', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1'))
      yield* mgr.processEvent(userPromptSubmit('test-1', 'do work'))
      yield* mgr.processEvent(stop('test-1'))
      const record = (yield* mgr.get('test-1'))!
      expect(record.status).toBe('waiting_for_input')
      expect(record.statusLabel).toBeUndefined()
      expect(record.needsAttention).toBe(true)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 5
  it.effect('SessionEnd transitions to inactive immediately', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1'))
      yield* mgr.processEvent(sessionEnd('test-1'))
      const record = (yield* mgr.get('test-1'))!
      expect(record.status).toBe('inactive')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('SessionEnd removes session after 5 seconds', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('test-1'))
      yield* mgr.processEvent(sessionEnd('test-1'))
      expect(yield* mgr.get('test-1')).toBeDefined()
      yield* TestClock.adjust('5 seconds')
      expect(yield* mgr.get('test-1')).toBeUndefined()
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 6 — auto-create sessions for unknown events
  it.effect('non-SessionStart events on unknown session auto-create a session', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(userPromptSubmit('unknown-1', 'hello'))
      const s1 = yield* mgr.get('unknown-1')
      expect(s1).toBeDefined()
      expect(s1!.status).toBe('running')
      expect(s1!.subtitle).toBe('hello')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('stop on unknown session auto-creates with waiting_for_input', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(stop('a1d9e4b7-83f2-4c06-b5a8-9f7e3d2c1b64'))
      const s = yield* mgr.get('a1d9e4b7-83f2-4c06-b5a8-9f7e3d2c1b64')
      expect(s).toBeDefined()
      expect(s!.status).toBe('waiting_for_input')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('preToolUse on unknown session auto-creates with running', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(preToolUse('unknown-3', 'Bash'))
      const s = yield* mgr.get('unknown-3')
      expect(s).toBeDefined()
      expect(s!.status).toBe('running')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('sessionEnd on unknown session auto-creates with inactive', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionEnd('unknown-4'))
      const s = yield* mgr.get('unknown-4')
      expect(s).toBeDefined()
      expect(s!.status).toBe('inactive')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 7
  it.effect('getAll returns all sessions', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(sessionStart('s2'))
      yield* mgr.processEvent(sessionStart('s3'))
      const all = yield* mgr.getAll()
      expect(all).toHaveLength(3)
      const ids = all.map((r) => r.sessionId).sort()
      expect(ids).toEqual(['s1', 's2', 's3'])
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 8
  it.effect('changes stream emits updated array after each processEvent', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager

      // Use a Deferred to synchronize: the stream fiber signals readiness
      // after emitting the first (current-snapshot) value, then the main
      // fiber sends events.  Without this, the forked fiber might not have
      // subscribed yet when processEvent fires, causing it to miss the
      // initial empty-state emission.
      const ready = yield* Deferred.make<void>()

      const streamFiber = yield* Effect.fork(
        mgr.changes.pipe(
          Stream.tap((_arr) => Deferred.succeed(ready, undefined)),
          Stream.take(3),
          Stream.runCollect,
        ),
      )

      // Suspend the main fiber here so the stream fiber runs, subscribes,
      // emits the initial snapshot, and completes the Deferred.
      yield* Deferred.await(ready)

      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(userPromptSubmit('s1', 'hello'))

      const emissions = yield* Fiber.join(streamFiber)
      const arr = Array.from(emissions)
      expect(arr).toHaveLength(3)
      expect(arr[0]).toHaveLength(0)
      expect(arr[1]).toHaveLength(1)
      expect(arr[1]![0]!.status).toBe('waiting_for_input')
      expect(arr[2]).toHaveLength(1)
      expect(arr[2]![0]!.status).toBe('running')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 9
  it.effect('concurrent processEvent calls do not corrupt state', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(userPromptSubmit('s1', 'prompt'))

      yield* Effect.all(
        Array.from({ length: 10 }, (_, i) =>
          mgr.processEvent(preToolUse('s1', `Tool${i}`)),
        ),
        { concurrency: 10 },
      )

      const all = yield* mgr.getAll()
      expect(all).toHaveLength(1)
      const record = all[0]!
      expect(record.status).toBe('running')
      expect(record.sessionId).toBe('s1')
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('concurrent SessionStart for different sessions are all recorded', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* Effect.all(
        Array.from({ length: 20 }, (_, i) =>
          mgr.processEvent(sessionStart(`session-${i}`)),
        ),
        { concurrency: 20 },
      )
      const all = yield* mgr.getAll()
      expect(all).toHaveLength(20)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Scenario 10
  it.effect('changes stream starts with current snapshot', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(sessionStart('s2'))

      const first = yield* mgr.changes.pipe(Stream.take(1), Stream.runCollect)
      const arr = Array.from(first)
      expect(arr).toHaveLength(1)
      expect(arr[0]).toHaveLength(2)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Additional: get() by ID
  it.effect('get returns the correct session by id', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1', 10))
      yield* mgr.processEvent(sessionStart('s2', 20))
      const s1 = yield* mgr.get('s1')
      const s2 = yield* mgr.get('s2')
      const missing = yield* mgr.get('unknown')
      expect(s1?.pid).toBe(10)
      expect(s2?.pid).toBe(20)
      expect(missing).toBeUndefined()
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // ─── verboseToolNames tests ────────────────────────────────────────────────

  it.effect(
    '(a) PreToolUse with verboseToolNames=true sets statusLabel to Running: Bash',
    () =>
      Effect.gen(function* () {
        const mgr = yield* SessionManager
        yield* mgr.processEvent(sessionStart('s1'))
        yield* mgr.processEvent(userPromptSubmit('s1', 'do work'))
        yield* mgr.processEvent(preToolUse('s1', 'Bash'))
        const record = (yield* mgr.get('s1'))!
        expect(record.statusLabel).toBe('Running: Bash')
      }).pipe(Effect.provide(makeSessionManagerLive(() => true))),
  )

  it.effect(
    '(b) PreToolUse with verboseToolNames=false does not set statusLabel',
    () =>
      Effect.gen(function* () {
        const mgr = yield* SessionManager
        yield* mgr.processEvent(sessionStart('s1'))
        yield* mgr.processEvent(userPromptSubmit('s1', 'do work'))
        yield* mgr.processEvent(preToolUse('s1', 'Bash'))
        const record = (yield* mgr.get('s1'))!
        expect(record.statusLabel).toBeUndefined()
      }).pipe(Effect.provide(makeSessionManagerLive(() => false))),
  )

  it.effect('(c) Stop clears statusLabel set by PreToolUse', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(userPromptSubmit('s1', 'do work'))
      yield* mgr.processEvent(preToolUse('s1', 'Bash'))
      yield* mgr.processEvent(stop('s1'))
      const record = (yield* mgr.get('s1'))!
      expect(record.statusLabel).toBeUndefined()
      expect(record.status).toBe('waiting_for_input')
    }).pipe(Effect.provide(makeSessionManagerLive(() => true))),
  )

  // ─── clearAttention tests ────────────────────────────────────────────────

  it.effect('clearAttention clears needsAttention on a waiting session', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(userPromptSubmit('s1', 'do work'))
      yield* mgr.processEvent(stop('s1'))
      const before = (yield* mgr.get('s1'))!
      expect(before.needsAttention).toBe(true)
      yield* mgr.clearAttention('s1')
      const after = (yield* mgr.get('s1'))!
      expect(after.needsAttention).toBe(false)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('clearAttention is a no-op when needsAttention is already false', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      const before = (yield* mgr.get('s1'))!
      expect(before.needsAttention).toBe(false)
      yield* mgr.clearAttention('s1')
      const after = (yield* mgr.get('s1'))!
      expect(after.needsAttention).toBe(false)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('clearAttention is a no-op for unknown session', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.clearAttention('nonexistent')
      const all = yield* mgr.getAll()
      expect(all).toHaveLength(0)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('clearAttention is a no-op when activeBlockingTool is set', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(userPromptSubmit('s1', 'do work'))
      yield* mgr.processEvent(preToolUse('s1', 'AskUserQuestion'))
      const before = (yield* mgr.get('s1'))!
      expect(before.needsAttention).toBe(true)
      expect(before.activeBlockingTool).toBe('AskUserQuestion')
      yield* mgr.clearAttention('s1')
      const after = (yield* mgr.get('s1'))!
      expect(after.needsAttention).toBe(true)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  it.effect('clearAttention works after blocking tool is cleared by user_prompt_submit', () =>
    Effect.gen(function* () {
      const mgr = yield* SessionManager
      yield* mgr.processEvent(sessionStart('s1'))
      yield* mgr.processEvent(userPromptSubmit('s1', 'do work'))
      yield* mgr.processEvent(preToolUse('s1', 'AskUserQuestion'))
      yield* mgr.processEvent(userPromptSubmit('s1', 'answer'))
      yield* mgr.processEvent(stop('s1'))
      const before = (yield* mgr.get('s1'))!
      expect(before.needsAttention).toBe(true)
      expect(before.activeBlockingTool).toBeUndefined()
      yield* mgr.clearAttention('s1')
      const after = (yield* mgr.get('s1'))!
      expect(after.needsAttention).toBe(false)
    }).pipe(Effect.provide(SessionManagerLive)),
  )

  // Additional: full lifecycle
  it.effect(
    'full session lifecycle: active → running → waiting → running → inactive',
    () =>
      Effect.gen(function* () {
        const mgr = yield* SessionManager
        yield* mgr.processEvent(sessionStart('s1'))
        expect((yield* mgr.get('s1'))?.status).toBe('waiting_for_input')

        yield* mgr.processEvent(userPromptSubmit('s1', 'first task'))
        expect((yield* mgr.get('s1'))?.status).toBe('running')

        yield* mgr.processEvent(stop('s1'))
        expect((yield* mgr.get('s1'))?.status).toBe('waiting_for_input')

        yield* mgr.processEvent(userPromptSubmit('s1', 'second task'))
        expect((yield* mgr.get('s1'))?.status).toBe('running')

        yield* mgr.processEvent(sessionEnd('s1'))
        expect((yield* mgr.get('s1'))?.status).toBe('inactive')
      }).pipe(Effect.provide(SessionManagerLive)),
  )
})
