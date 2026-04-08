import { Effect, Layer, Stream, SubscriptionRef } from 'effect'
import type { HookEvent } from './schemas.js'
import {
  createSession,
  createSessionFromEvent,
  transitionSession,
} from './stateMachine.js'
import type { SessionRecord } from './stateMachine.js'

const makeSessionManagerEffect = (
  getVerboseMode: () => boolean,
  initialSessions: ReadonlyArray<SessionRecord> = [],
) =>
  Effect.gen(function* () {
    const initial = new Map(
      initialSessions.map((s) => [s.sessionId, s]),
    )
    const stateRef = yield* SubscriptionRef.make<
      ReadonlyMap<string, SessionRecord>
    >(initial)

    const processEvent = (event: HookEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.event === 'session_start') {
          yield* SubscriptionRef.update(stateRef, (map) => {
            const next = new Map(map)
            // Retire old sessions from the same pid (e.g. after /clear)
            if (event.pid > 0) {
              for (const [id, session] of map) {
                if (
                  id !== event.session_id &&
                  session.pid === event.pid &&
                  session.status !== 'inactive'
                ) {
                  next.set(id, {
                    ...session,
                    status: 'inactive',
                    lastEventAt: Date.now(),
                  })
                }
              }
            }
            const existing = map.get(event.session_id)
            if (existing === undefined) {
              next.set(event.session_id, createSession(event))
            } else {
              next.set(
                event.session_id,
                transitionSession(existing, event),
              )
            }
            return next
          })
        } else if (event.event === 'session_end') {
          yield* SubscriptionRef.update(stateRef, (map) => {
            const existing = map.get(event.session_id)
            const next = new Map(map)
            if (existing === undefined) {
              next.set(
                event.session_id,
                createSessionFromEvent(event, getVerboseMode()),
              )
            } else {
              next.set(event.session_id, transitionSession(existing, event))
            }
            return next
          })
          // Schedule removal after 5 seconds without blocking the caller
          yield* SubscriptionRef.update(stateRef, (map) => {
            const next = new Map(map)
            next.delete(event.session_id)
            return next
          }).pipe(Effect.delay('5 seconds'), Effect.fork, Effect.asVoid)
        } else {
          yield* SubscriptionRef.update(stateRef, (map) => {
            const existing = map.get(event.session_id)
            const next = new Map(map)
            if (existing === undefined) {
              next.set(
                event.session_id,
                createSessionFromEvent(event, getVerboseMode()),
              )
            } else {
              next.set(
                event.session_id,
                transitionSession(existing, event, getVerboseMode()),
              )
            }
            return next
          })
        }
      })

    const getAll = (): Effect.Effect<ReadonlyArray<SessionRecord>> =>
      SubscriptionRef.get(stateRef).pipe(
        Effect.map((map) => Array.from(map.values())),
      )

    const get = (
      sessionId: string,
    ): Effect.Effect<SessionRecord | undefined> =>
      SubscriptionRef.get(stateRef).pipe(
        Effect.map((map) => map.get(sessionId)),
      )

    const setTerminalId = (
      sessionId: string,
      terminalId: number,
    ): Effect.Effect<void> =>
      SubscriptionRef.update(stateRef, (map) => {
        const existing = map.get(sessionId)
        if (existing === undefined || existing.terminalId === terminalId) return map
        const next = new Map(map)
        next.set(sessionId, { ...existing, terminalId })
        return next
      })

    const clearTerminalId = (terminalPid: number): Effect.Effect<void> =>
      SubscriptionRef.update(stateRef, (map) => {
        let changed = false
        const next = new Map(map)
        for (const [id, session] of map) {
          if (session.terminalId === terminalPid) {
            next.set(id, { ...session, terminalId: undefined })
            changed = true
          }
        }
        return changed ? next : map
      })

    const setSlug = (
      sessionId: string,
      slug: string,
    ): Effect.Effect<void> =>
      SubscriptionRef.update(stateRef, (map) => {
        const existing = map.get(sessionId)
        if (existing === undefined || existing.slug === slug) return map
        const next = new Map(map)
        next.set(sessionId, { ...existing, slug })
        return next
      })

    const changes: Stream.Stream<ReadonlyArray<SessionRecord>> =
      stateRef.changes.pipe(
        Stream.map((map) => Array.from(map.values())),
      )

    const clearAttention = (sessionId: string): Effect.Effect<void> =>
      SubscriptionRef.update(stateRef, (map) => {
        const existing = map.get(sessionId)
        if (existing === undefined || !existing.needsAttention) return map
        if (existing.activeBlockingTool !== undefined) return map
        const next = new Map(map)
        next.set(sessionId, { ...existing, needsAttention: false })
        return next
      })

    const clearAll = (): Effect.Effect<void> =>
      SubscriptionRef.set(stateRef, new Map())

    return { processEvent, getAll, get, setTerminalId, clearTerminalId, setSlug, clearAttention, changes, clearAll }
  })

class SessionManager extends Effect.Service<SessionManager>()(
  'SessionManager',
  {
    effect: makeSessionManagerEffect(() => false),
  },
) {}

export { SessionManager }

export const makeSessionManagerLive = (
  getVerboseMode: () => boolean = () => false,
  initialSessions: ReadonlyArray<SessionRecord> = [],
): Layer.Layer<SessionManager> =>
  Layer.effect(
    SessionManager,
    // Effect.Service uses Object.assign(Object.create(proto), impl) internally.
    // The cast is safe: phantom _tag/_id fields come from the prototype at runtime.
    makeSessionManagerEffect(getVerboseMode, initialSessions).pipe(
      Effect.map((x) => x as unknown as SessionManager),
    ),
  )

export const SessionManagerLive = makeSessionManagerLive()
