import { Effect, ParseResult } from 'effect'
import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'
import {
  parseHookEvent,
  parseHookEventFromString,
} from './schemas.js'

describe('parseHookEvent', () => {
  it.effect('parses SessionStartEvent', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'session_start',
        session_id: 'abc123',
        pid: 42,
      })
      expect(result).toEqual({
        event: 'session_start',
        session_id: 'abc123',
        pid: 42,
        source: 'claude',
      })
    }),
  )

  it.effect('parses SessionStartEvent when pid is absent (defaults to 0)', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'session_start',
        session_id: 'abc123',
      })
      expect(result).toEqual({
        event: 'session_start',
        session_id: 'abc123',
        pid: 0,
        source: 'claude',
      })
    }),
  )

  it.effect('parses SessionStartEvent with branch', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'session_start',
        session_id: 'abc123',
        pid: 42,
        branch: 'feature/my-branch',
      })
      expect(result).toEqual({
        event: 'session_start',
        session_id: 'abc123',
        pid: 42,
        branch: 'feature/my-branch',
        source: 'claude',
      })
    }),
  )

  it.effect('parses UserPromptSubmitEvent', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'user_prompt_submit',
        session_id: 'e9c4f28a-3b17-4d56-a891-6c5e7f2d0b3a',
        prompt: 'hello world',
      })
      expect(result).toEqual({
        event: 'user_prompt_submit',
        session_id: 'e9c4f28a-3b17-4d56-a891-6c5e7f2d0b3a',
        prompt: 'hello world',
        source: 'claude',
      })
    }),
  )

  it.effect('parses PreToolUseEvent', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'pre_tool_use',
        session_id: 'abc123',
        tool_name: 'Bash',
      })
      expect(result).toEqual({
        event: 'pre_tool_use',
        session_id: 'abc123',
        tool_name: 'Bash',
        source: 'claude',
      })
    }),
  )

  it.effect('parses StopEvent', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'stop',
        session_id: 'abc123',
      })
      expect(result).toEqual({
        event: 'stop',
        session_id: 'abc123',
        source: 'claude',
      })
    }),
  )

  it.effect('parses StopEvent with stop_reason', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'stop',
        session_id: 'abc123',
        stop_reason: 'end_turn',
      })
      expect(result).toEqual({
        event: 'stop',
        session_id: 'abc123',
        stop_reason: 'end_turn',
        source: 'claude',
      })
    }),
  )

  it.effect('parses SessionEndEvent', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'session_end',
        session_id: 'abc123',
        pid: 99,
      })
      expect(result).toEqual({
        event: 'session_end',
        session_id: 'abc123',
        pid: 99,
        source: 'claude',
      })
    }),
  )

  it.effect('accepts extra unknown fields (passthrough)', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEvent({
        event: 'stop',
        session_id: 'abc123',
        extra_field: 'ignored',
      })
      expect(result.event).toBe('stop')
      expect(result.session_id).toBe('abc123')
    }),
  )

  it.effect('fails with ParseError on missing session_id', () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        parseHookEvent({ event: 'stop' }),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(ParseResult.ParseError)
      }
    }),
  )

  it.effect('fails with ParseError on unknown event type', () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        parseHookEvent({ event: 'unknown_event', session_id: 'abc123' }),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(ParseResult.ParseError)
      }
    }),
  )
})

describe('parseHookEventFromString', () => {
  it.effect('parses valid JSON string', () =>
    Effect.gen(function* () {
      const result = yield* parseHookEventFromString(
        JSON.stringify({
          event: 'session_start',
          session_id: 'abc123',
          pid: 42,
        }),
      )
      expect(result).toEqual({
        event: 'session_start',
        session_id: 'abc123',
        pid: 42,
        source: 'claude',
      })
    }),
  )

  it.effect('fails with SyntaxError on invalid JSON', () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        parseHookEventFromString('not valid json {{{'),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(SyntaxError)
      }
    }),
  )

  it.effect('fails with ParseError on valid JSON but wrong schema', () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        parseHookEventFromString(
          JSON.stringify({ event: 'unknown_event', session_id: 'abc' }),
        ),
      )
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(ParseResult.ParseError)
      }
    }),
  )
})

describe('source field (T5.1)', () => {
  it('(a) session_start without source defaults to claude', () => {
    const result = Effect.runSync(
      parseHookEvent({ event: 'session_start', session_id: 'abc' }),
    )
    expect(result.source).toBe('claude')
  })

  it('(b) session_start with source=codex preserves it', () => {
    const result = Effect.runSync(
      parseHookEvent({
        event: 'session_start',
        session_id: 'abc',
        source: 'codex',
      }),
    )
    expect(result.source).toBe('codex')
  })

  it('(c) user_prompt_submit without source defaults to claude', () => {
    const result = Effect.runSync(
      parseHookEvent({
        event: 'user_prompt_submit',
        session_id: 'abc',
        prompt: 'hello',
      }),
    )
    expect(result.source).toBe('claude')
  })

  it('(d) pre_tool_use with source=codex preserves it', () => {
    const result = Effect.runSync(
      parseHookEvent({
        event: 'pre_tool_use',
        session_id: 'abc',
        tool_name: 'Bash',
        source: 'codex',
      }),
    )
    expect(result.source).toBe('codex')
  })

  it('(e) stop without source defaults to claude', () => {
    const result = Effect.runSync(
      parseHookEvent({ event: 'stop', session_id: 'abc' }),
    )
    expect(result.source).toBe('claude')
  })

  it('(f) session_end without source defaults to claude', () => {
    const result = Effect.runSync(
      parseHookEvent({ event: 'session_end', session_id: 'abc', pid: 123 }),
    )
    expect(result.source).toBe('claude')
  })

  it('(g) parseHookEventFromString with source field', () => {
    const json = JSON.stringify({
      event: 'session_start',
      session_id: 'x',
      source: 'codex',
    })
    const result = Effect.runSync(parseHookEventFromString(json))
    expect(result.source).toBe('codex')
  })
})
