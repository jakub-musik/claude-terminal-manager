import { Effect, ParseResult, Schema } from 'effect'

export const SessionStartEvent = Schema.Struct({
  event: Schema.Literal('session_start'),
  session_id: Schema.String,
  pid: Schema.optionalWith(Schema.Number, { exact: true, default: () => 0 }),
  branch: Schema.optionalWith(Schema.String, { exact: true }),
  cwd: Schema.optionalWith(Schema.String, { exact: true }),
  source: Schema.optionalWith(Schema.String, {
    exact: true,
    default: () => 'claude',
  }),
})

export const UserPromptSubmitEvent = Schema.Struct({
  event: Schema.Literal('user_prompt_submit'),
  session_id: Schema.String,
  prompt: Schema.String,
  source: Schema.optionalWith(Schema.String, {
    exact: true,
    default: () => 'claude',
  }),
})

export const PreToolUseEvent = Schema.Struct({
  event: Schema.Literal('pre_tool_use'),
  session_id: Schema.String,
  tool_name: Schema.String,
  source: Schema.optionalWith(Schema.String, {
    exact: true,
    default: () => 'claude',
  }),
})

export const StopEvent = Schema.Struct({
  event: Schema.Literal('stop'),
  session_id: Schema.String,
  stop_reason: Schema.optionalWith(Schema.String, { exact: true }),
  source: Schema.optionalWith(Schema.String, {
    exact: true,
    default: () => 'claude',
  }),
})

export const SessionEndEvent = Schema.Struct({
  event: Schema.Literal('session_end'),
  session_id: Schema.String,
  pid: Schema.Number,
  source: Schema.optionalWith(Schema.String, {
    exact: true,
    default: () => 'claude',
  }),
})

export const HookEvent = Schema.Union(
  SessionStartEvent,
  UserPromptSubmitEvent,
  PreToolUseEvent,
  StopEvent,
  SessionEndEvent,
)

export type SessionStartEvent = Schema.Schema.Type<typeof SessionStartEvent>
export type UserPromptSubmitEvent = Schema.Schema.Type<
  typeof UserPromptSubmitEvent
>
export type PreToolUseEvent = Schema.Schema.Type<typeof PreToolUseEvent>
export type StopEvent = Schema.Schema.Type<typeof StopEvent>
export type SessionEndEvent = Schema.Schema.Type<typeof SessionEndEvent>
export type HookEvent = Schema.Schema.Type<typeof HookEvent>

const decodeHookEvent = Schema.decodeUnknown(HookEvent)

export const parseHookEvent = (
  input: unknown,
): Effect.Effect<HookEvent, ParseResult.ParseError> => decodeHookEvent(input)

export const parseHookEventFromString = (
  line: string,
): Effect.Effect<HookEvent, ParseResult.ParseError | SyntaxError> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (err) {
    return Effect.fail(err as SyntaxError)
  }
  return decodeHookEvent(parsed)
}
