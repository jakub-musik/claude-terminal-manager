import { describe, expect, it } from 'vitest'
import type {
  HookEvent,
  SessionStartEvent,
  StopEvent,
  UserPromptSubmitEvent,
} from './schemas.js'
import {
  createSession,
  createSessionFromEvent,
  transitionSession,
  truncateSubtitle,
} from './stateMachine.js'

const makeStart = (
  session_id = 'test-session',
  pid = 42,
  source = 'claude',
): SessionStartEvent => ({ event: 'session_start', session_id, pid, source })

describe('truncateSubtitle', () => {
  it('returns string unchanged when shorter than 70 chars', () => {
    const s = 'hello world'
    expect(truncateSubtitle(s)).toBe(s)
  })

  it('returns string unchanged when exactly 70 chars', () => {
    const s = 'a'.repeat(70)
    expect(truncateSubtitle(s)).toBe(s)
  })

  it('truncates to 70 chars when longer', () => {
    const s = 'a'.repeat(80)
    expect(truncateSubtitle(s)).toBe('a'.repeat(70))
    expect(truncateSubtitle(s).length).toBe(70)
  })

  it('respects a custom len parameter', () => {
    expect(truncateSubtitle('hello world', 5)).toBe('hello')
  })
})

describe('createSession', () => {
  it('returns correct initial record', () => {
    const record = createSession(makeStart('abc', 99))
    expect(record.sessionId).toBe('abc')
    expect(record.pid).toBe(99)
    expect(record.status).toBe('waiting_for_input')
    expect(record.subtitle).toBeUndefined()
    expect(record.terminalId).toBeUndefined()
    expect(record.customName).toBeUndefined()
    expect(record.statusLabel).toBeUndefined()
    expect(record.needsAttention).toBe(false)
    expect(typeof record.lastEventAt).toBe('number')
  })

  it('sets customName from branch when provided', () => {
    const record = createSession({
      event: 'session_start',
      session_id: 's1',
      pid: 1,
      branch: 'feature/my-branch',
      source: 'claude',
    })
    expect(record.customName).toBe('feature/my-branch')
  })
})

describe('transitionSession', () => {
  describe('SessionStart (session_start)', () => {
    it('updates pid and timestamp on an existing session', () => {
      const r = createSession(makeStart('s1', 1))
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.pid).toBe(2)
      expect(result.status).toBe('waiting_for_input')
      expect(result.lastEventAt).toBeGreaterThanOrEqual(r.lastEventAt)
    })

    it('preserves other fields on session restart', () => {
      const r = { ...createSession(makeStart('s1', 1)), subtitle: 'hello' }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 99,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.subtitle).toBe('hello')
    })

    it('resets slug on session_start so it can be re-resolved', () => {
      const r = { ...createSession(makeStart('s1', 1)), slug: 'old-slug' }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.slug).toBeUndefined()
    })

    it('sets customName from branch on session_start', () => {
      const r = createSession(makeStart('s1', 1))
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        branch: 'fix/login-bug',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.customName).toBe('fix/login-bug')
    })

    it('preserves customName when branch is not provided', () => {
      const r = { ...createSession(makeStart('s1', 1)), customName: 'my-branch' }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 's1',
        pid: 2,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.customName).toBe('my-branch')
    })
  })

  describe('UserPromptSubmit (user_prompt_submit)', () => {
    it('transitions from active to running and captures subtitle', () => {
      const r = { ...createSession(makeStart()), status: 'active' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'do something',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.status).toBe('running')
      expect(result.subtitle).toBe('do something')
      expect(result.statusLabel).toBeUndefined()
      expect(result.needsAttention).toBe(false)
    })

    it('transitions from waiting_for_input to running', () => {
      const r = { ...createSession(makeStart()), status: 'waiting_for_input' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'next prompt',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.status).toBe('running')
    })

    it('updates subtitle on second UserPromptSubmit', () => {
      const r = createSession(makeStart())
      const first: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'first prompt',
        source: 'claude',
      }
      const afterFirst = transitionSession(r, first)
      // Simulate stop → waiting_for_input → second prompt
      const stopped = transitionSession(afterFirst, {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      })
      const second: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'second prompt',
        source: 'claude',
      }
      const afterSecond = transitionSession(stopped, second)
      expect(afterSecond.subtitle).toBe('second prompt')
    })

    it('is a no-op when status is running', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'ignored',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result).toBe(r)
    })

    it('is a no-op when status is inactive', () => {
      const r = { ...createSession(makeStart()), status: 'inactive' as const }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'ignored',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result).toBe(r)
    })

    it('truncates prompt to 70 chars for subtitle', () => {
      const r = createSession(makeStart())
      const longPrompt = 'x'.repeat(100)
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: longPrompt,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.subtitle).toBe('x'.repeat(70))
    })

    it('clears statusLabel when transitioning to running', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'waiting_for_input' as const,
        statusLabel: 'Running: Bash',
      }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'go',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.statusLabel).toBeUndefined()
    })
  })

  describe('PreToolUse (pre_tool_use)', () => {
    it('stays running; sets statusLabel when verboseMode=true', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.statusLabel).toBe('Running: Bash')
    })

    it('does not set statusLabel when verboseMode=false', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, false)
      expect(result.statusLabel).toBeUndefined()
    })

    it('does not set statusLabel when verboseMode is omitted', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.statusLabel).toBeUndefined()
    })

    it('is a no-op when active', () => {
      const r = { ...createSession(makeStart()), status: 'active' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result).toBe(r)
    })

    it('transitions from waiting_for_input to running', () => {
      const r = { ...createSession(makeStart()), status: 'waiting_for_input' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.statusLabel).toBe('Running: Bash')
    })

    it('is a no-op when inactive', () => {
      const r = { ...createSession(makeStart()), status: 'inactive' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result).toBe(r)
    })

    it('sets needsAttention=true when tool is AskUserQuestion', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.statusLabel).toBe('Running: AskUserQuestion')
      expect(result.needsAttention).toBe(true)
    })

    it('sets needsAttention=true when tool is ExitPlanMode', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'ExitPlanMode',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.status).toBe('running')
      expect(result.needsAttention).toBe(true)
    })

    it('clears needsAttention when tool is not AskUserQuestion', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        needsAttention: true,
      }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event, true)
      expect(result.needsAttention).toBe(false)
    })
  })

  describe('Stop (stop)', () => {
    it('transitions to waiting_for_input and clears statusLabel', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        statusLabel: 'Running: Bash',
      }
      const event: HookEvent = {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.status).toBe('waiting_for_input')
      expect(result.statusLabel).toBeUndefined()
      expect(result.needsAttention).toBe(true)
    })

    it('transitions to waiting_for_input from active', () => {
      const r = createSession(makeStart())
      const event: HookEvent = { event: 'stop', session_id: 'test-session', source: 'claude' }
      const result = transitionSession(r, event)
      expect(result.status).toBe('waiting_for_input')
      expect(result.needsAttention).toBe(true)
    })
  })

  describe('SessionEnd (session_end)', () => {
    it('transitions to inactive from any status', () => {
      const statuses = [
        'active',
        'running',
        'waiting_for_input',
      ] as const
      for (const status of statuses) {
        const r = { ...createSession(makeStart()), status }
        const event: HookEvent = {
          event: 'session_end',
          session_id: 'test-session',
          pid: 42,
          source: 'claude',
        }
        const result = transitionSession(r, event)
        expect(result.status).toBe('inactive')
        expect(result.needsAttention).toBe(false)
      }
    })
  })

  describe('createSessionFromEvent', () => {
    it('user_prompt_submit creates running session with subtitle', () => {
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 's1',
        prompt: 'do something',
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.sessionId).toBe('s1')
      expect(record.status).toBe('running')
      expect(record.pid).toBe(0)
      expect(record.subtitle).toBe('do something')
      expect(record.needsAttention).toBe(false)
    })

    it('pre_tool_use creates running session with statusLabel when verbose', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'Bash',
        source: 'claude',
      }
      const record = createSessionFromEvent(event, true)
      expect(record.status).toBe('running')
      expect(record.statusLabel).toBe('Running: Bash')
    })

    it('pre_tool_use creates running session without statusLabel when not verbose', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'Bash',
        source: 'claude',
      }
      const record = createSessionFromEvent(event, false)
      expect(record.status).toBe('running')
      expect(record.statusLabel).toBeUndefined()
    })

    it('pre_tool_use with AskUserQuestion creates session with needsAttention=true', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const record = createSessionFromEvent(event, true)
      expect(record.status).toBe('running')
      expect(record.statusLabel).toBe('Running: AskUserQuestion')
      expect(record.needsAttention).toBe(true)
    })

    it('stop creates session with waiting_for_input and needsAttention=true', () => {
      const event: HookEvent = { event: 'stop', session_id: 's1', source: 'claude' }
      const record = createSessionFromEvent(event)
      expect(record.status).toBe('waiting_for_input')
      expect(record.needsAttention).toBe(true)
    })

    it('session_end creates session with inactive', () => {
      const event: HookEvent = {
        event: 'session_end',
        session_id: 's1',
        pid: 42,
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.status).toBe('inactive')
    })

    it('session_start creates session with running (default)', () => {
      const event: HookEvent = {
        event: 'session_start',
        session_id: 'f7d3b195-c4e8-41a2-b6f9-8d2e5a7c3b10',
        pid: 42,
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.sessionId).toBe('f7d3b195-c4e8-41a2-b6f9-8d2e5a7c3b10')
      expect(record.status).toBe('running')
      expect(record.pid).toBe(0) // base pid, not from event
    })
  })

  describe('activeBlockingTool lifecycle', () => {
    it('createSession sets activeBlockingTool to undefined', () => {
      const record = createSession(makeStart())
      expect(record.activeBlockingTool).toBeUndefined()
    })

    it('pre_tool_use(AskUserQuestion) sets activeBlockingTool', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBe('AskUserQuestion')
    })

    it('pre_tool_use(ExitPlanMode) sets activeBlockingTool', () => {
      const r = { ...createSession(makeStart()), status: 'running' as const }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'ExitPlanMode',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBe('ExitPlanMode')
    })

    it('pre_tool_use(Bash) clears activeBlockingTool', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 'test-session',
        tool_name: 'Bash',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBeUndefined()
    })

    it('user_prompt_submit clears activeBlockingTool', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'waiting_for_input' as const,
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'answer',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBeUndefined()
    })

    it('stop clears activeBlockingTool', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        activeBlockingTool: 'ExitPlanMode' as string | undefined,
      }
      const event: HookEvent = {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBeUndefined()
    })

    it('session_end clears activeBlockingTool', () => {
      const r = {
        ...createSession(makeStart()),
        status: 'running' as const,
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'session_end',
        session_id: 'test-session',
        pid: 42,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBeUndefined()
    })

    it('session_start preserves existing fields (activeBlockingTool unchanged)', () => {
      const r = {
        ...createSession(makeStart()),
        activeBlockingTool: 'AskUserQuestion' as string | undefined,
      }
      const event: HookEvent = {
        event: 'session_start',
        session_id: 'test-session',
        pid: 99,
        source: 'claude',
      }
      const result = transitionSession(r, event)
      expect(result.activeBlockingTool).toBe('AskUserQuestion')
    })

    it('createSessionFromEvent sets activeBlockingTool for AskUserQuestion', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'AskUserQuestion',
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.activeBlockingTool).toBe('AskUserQuestion')
    })

    it('createSessionFromEvent does not set activeBlockingTool for Bash', () => {
      const event: HookEvent = {
        event: 'pre_tool_use',
        session_id: 's1',
        tool_name: 'Bash',
        source: 'claude',
      }
      const record = createSessionFromEvent(event)
      expect(record.activeBlockingTool).toBeUndefined()
    })

    it('createSessionFromEvent sets activeBlockingTool=undefined for stop', () => {
      const event: HookEvent = { event: 'stop', session_id: 's1', source: 'claude' }
      const record = createSessionFromEvent(event)
      expect(record.activeBlockingTool).toBeUndefined()
    })
  })

  describe('statusLabel lifecycle', () => {
    it('statusLabel cleared on Stop after being set', () => {
      const base = createSession(makeStart())
      const running = transitionSession(base, {
        event: 'user_prompt_submit',
        session_id: 'test-session',
        prompt: 'do work',
        source: 'claude',
      })
      const withLabel = transitionSession(
        running,
        { event: 'pre_tool_use', session_id: 'test-session', tool_name: 'Bash', source: 'claude' },
        true,
      )
      expect(withLabel.statusLabel).toBe('Running: Bash')
      const stopped = transitionSession(withLabel, {
        event: 'stop',
        session_id: 'test-session',
        source: 'claude',
      })
      expect(stopped.statusLabel).toBeUndefined()
    })
  })
})

describe('source field (T5.2)', () => {
  it('(a) createSession sets source from event', () => {
    const session = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'codex',
    } as SessionStartEvent)
    expect(session.source).toBe('codex')
  })

  it('(b) createSession defaults source to claude when event has default', () => {
    const session = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'claude',
    } as SessionStartEvent)
    expect(session.source).toBe('claude')
  })

  it('(c) createSessionFromEvent sets source from event', () => {
    const session = createSessionFromEvent({
      event: 'stop',
      session_id: 'abc',
      source: 'codex',
    } as StopEvent)
    expect(session.source).toBe('codex')
  })

  it('(d) transitionSession preserves source through transitions', () => {
    const initial = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'codex',
    } as SessionStartEvent)
    const after = transitionSession(initial, {
      event: 'user_prompt_submit',
      session_id: 'abc',
      prompt: 'hi',
      source: 'codex',
    } as UserPromptSubmitEvent)
    expect(after.source).toBe('codex')
  })

  it('(e) transitionSession on session_start updates source', () => {
    const initial = createSession({
      event: 'session_start',
      session_id: 'abc',
      pid: 1,
      source: 'claude',
    } as SessionStartEvent)
    const after = transitionSession(initial, {
      event: 'session_start',
      session_id: 'abc',
      pid: 2,
      source: 'codex',
    } as SessionStartEvent)
    expect(after.source).toBe('codex')
  })

  it('(f) createSessionFromEvent for each event type carries source', () => {
    const events: HookEvent[] = [
      { event: 'user_prompt_submit', session_id: 'x', prompt: 'hi', source: 'codex' },
      { event: 'pre_tool_use', session_id: 'x', tool_name: 'Bash', source: 'codex' },
      { event: 'stop', session_id: 'x', source: 'codex' },
      { event: 'session_end', session_id: 'x', pid: 1, source: 'codex' },
    ]
    for (const evt of events) {
      const session = createSessionFromEvent(evt)
      expect(session.source).toBe('codex')
    }
  })

  it('(g) source is preserved through stop transition', () => {
    const initial = createSession(makeStart('s1', 1, 'codex'))
    const stopped = transitionSession(initial, {
      event: 'stop',
      session_id: 's1',
      source: 'codex',
    } as StopEvent)
    expect(stopped.source).toBe('codex')
  })

  it('(h) source is preserved through session_end transition', () => {
    const initial = createSession(makeStart('s1', 1, 'codex'))
    const ended = transitionSession(initial, {
      event: 'session_end',
      session_id: 's1',
      pid: 1,
      source: 'codex',
    } as HookEvent)
    expect(ended.source).toBe('codex')
  })
})
