import type { HookEvent, SessionStartEvent } from './schemas.js'

export type SessionStatus =
  | 'active'
  | 'running'
  | 'waiting_for_input'
  | 'inactive'

export interface SessionRecord {
  readonly sessionId: string
  readonly status: SessionStatus
  readonly pid: number
  readonly subtitle: string | undefined
  readonly terminalId: number | undefined
  readonly customName: string | undefined
  readonly slug: string | undefined
  readonly cwd: string | undefined
  readonly lastEventAt: number
  readonly statusLabel: string | undefined
  readonly needsAttention: boolean
  readonly activeBlockingTool: string | undefined
  readonly source: string
}

export const truncateSubtitle = (s: string, len = 70): string =>
  s.length <= len ? s : s.slice(0, len)

export const createSession = (event: SessionStartEvent): SessionRecord => ({
  sessionId: event.session_id,
  status: 'waiting_for_input',
  pid: event.pid,
  subtitle: undefined,
  terminalId: undefined,
  customName: event.branch,
  slug: undefined,
  cwd: event.cwd,
  lastEventAt: Date.now(),
  statusLabel: undefined,
  needsAttention: false,
  activeBlockingTool: undefined,
  source: event.source,
})

export const createSessionFromEvent = (
  event: HookEvent,
  verboseMode?: boolean,
): SessionRecord => {
  const base: SessionRecord = {
    sessionId: event.session_id,
    status: 'running',
    pid: 0,
    subtitle: undefined,
    terminalId: undefined,
    customName: undefined,
    slug: undefined,
    cwd: undefined,
    lastEventAt: Date.now(),
    statusLabel: undefined,
    needsAttention: false,
    activeBlockingTool: undefined,
    source: event.source,
  }
  switch (event.event) {
    case 'user_prompt_submit':
      return { ...base, subtitle: truncateSubtitle(event.prompt) }
    case 'pre_tool_use': {
      const isBlocking =
        event.tool_name === 'AskUserQuestion' ||
        event.tool_name === 'ExitPlanMode'
      return {
        ...base,
        statusLabel:
          verboseMode === true ? `Running: ${event.tool_name}` : undefined,
        needsAttention: isBlocking,
        activeBlockingTool: isBlocking ? event.tool_name : undefined,
      }
    }
    case 'stop':
      return { ...base, status: 'waiting_for_input', needsAttention: true }
    case 'session_end':
      return { ...base, status: 'inactive' }
    default:
      return base
  }
}

export const transitionSession = (
  record: SessionRecord,
  event: HookEvent,
  verboseMode?: boolean,
): SessionRecord => {
  const now = Date.now()
  switch (event.event) {
    case 'session_start':
      return {
        ...record,
        pid: event.pid,
        slug: undefined, // reset so the async slug resolver re-reads from JSONL
        ...(event.branch !== undefined ? { customName: event.branch } : {}),
        ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
        source: event.source,
        lastEventAt: now,
      }

    case 'user_prompt_submit': {
      if (
        record.status !== 'active' &&
        record.status !== 'waiting_for_input'
      ) {
        return record
      }
      return {
        ...record,
        status: 'running',
        subtitle: truncateSubtitle(event.prompt),
        statusLabel: undefined,
        needsAttention: false,
        activeBlockingTool: undefined,
        lastEventAt: now,
      }
    }

    case 'pre_tool_use': {
      if (record.status !== 'running' && record.status !== 'waiting_for_input') {
        return record
      }
      const isAttentionTool =
        event.tool_name === 'AskUserQuestion' ||
        event.tool_name === 'ExitPlanMode'
      return {
        ...record,
        status: 'running',
        statusLabel: verboseMode === true
          ? `Running: ${event.tool_name}`
          : record.statusLabel,
        needsAttention: isAttentionTool,
        activeBlockingTool: isAttentionTool ? event.tool_name : undefined,
        lastEventAt: now,
      }
    }

    case 'stop':
      return {
        ...record,
        status: 'waiting_for_input',
        statusLabel: undefined,
        needsAttention: true,
        activeBlockingTool: undefined,
        lastEventAt: now,
      }

    case 'session_end':
      return {
        ...record,
        status: 'inactive',
        needsAttention: false,
        activeBlockingTool: undefined,
        lastEventAt: now,
      }

    default: {
      // Exhaustive check — all HookEvent variants handled above.
      // At runtime this is unreachable; kept for defensive safety.
      const _exhaustive: never = event
      void _exhaustive
      return record
    }
  }
}
