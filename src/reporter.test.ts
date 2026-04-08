import * as cp from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPORTER = fileURLToPath(new URL('../bin/reporter', import.meta.url))

const makeSockPath = (): string =>
  path.join(os.tmpdir(), 'reporter-test-' + process.pid + '-' + Date.now() + '.sock')

/**
 * Start a Unix socket server, run bin/reporter with the given args and stdin,
 * and return the first line received on the socket.
 */
const runReporter = (
  args: string[],
  stdinJson: object,
  sockPath: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let received = ''

    const server = net.createServer((conn) => {
      conn.on('data', (chunk) => {
        received += chunk.toString()
      })
      conn.on('end', () => {
        server.close()
        resolve(received.trim())
      })
    })

    server.on('error', reject)

    server.listen(sockPath, () => {
      const proc = cp.spawn('bash', [REPORTER, ...args], {
        env: { ...process.env, VSCODE_CLAUDE_SOCKET: sockPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      proc.stdin!.write(JSON.stringify(stdinJson))
      proc.stdin!.end()
      proc.on('error', reject)
    })
  })

describe('bin/reporter', () => {
  const sockPaths: string[] = []

  afterEach(() => {
    for (const p of sockPaths) {
      try {
        fs.unlinkSync(p)
      } catch {
        // best-effort
      }
    }
    sockPaths.length = 0
  })

  it('sends session_start with pid when --pid is given', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--save-session', '/dev/null', '--pid', '99999'],
      { session_id: 'sess-a', hook_event_name: 'SessionStart' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('session_start')
    expect(parsed['session_id']).toBe('sess-a')
    expect(parsed['pid']).toBe(99999)
  })

  it('sends session_start with pid=0 when --pid is not given', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--save-session', '/dev/null'],
      { session_id: 'sess-b', hook_event_name: 'SessionStart' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('session_start')
    expect(parsed['session_id']).toBe('sess-b')
    expect(parsed['pid']).toBe(0)
  })

  it('sends stop event with stop_reason when present', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-sr',
        hook_event_name: 'Stop',
        stop_reason: 'end_turn',
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('stop')
    expect(parsed['session_id']).toBe('sess-sr')
    expect(parsed['stop_reason']).toBe('end_turn')
  })

  it('sends stop event without stop_reason when absent', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-ns',
        hook_event_name: 'Stop',
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('stop')
    expect(parsed['session_id']).toBe('sess-ns')
    expect('stop_reason' in parsed).toBe(false)
  })

  it('sends user_prompt_submit without pid field', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      {
        session_id: 'sess-c',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hello world',
      },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['event']).toBe('user_prompt_submit')
    expect(parsed['session_id']).toBe('sess-c')
    expect(parsed['prompt']).toBe('hello world')
    expect('pid' in parsed).toBe(false)
  })
})

describe('--source flag (T5.3)', () => {
  const sockPaths: string[] = []

  afterEach(() => {
    for (const sockPath of sockPaths) {
      try {
        fs.unlinkSync(sockPath)
      } catch {
        // best-effort
      }
    }
    sockPaths.length = 0
  })

  it('(a) without --source, emitted event has source=claude', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      [],
      { session_id: 'abc', hook_event_name: 'Stop' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['source']).toBe('claude')
  })

  it('(b) with --source codex, emitted event has source=codex', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--source', 'codex'],
      { session_id: 'abc', hook_event_name: 'Stop' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['source']).toBe('codex')
  })

  it('(c) --source flag with SessionStart includes source alongside pid', async () => {
    const sockPath = makeSockPath()
    sockPaths.push(sockPath)

    const line = await runReporter(
      ['--source', 'codex', '--pid', '123'],
      { session_id: 'abc', hook_event_name: 'SessionStart' },
      sockPath,
    )

    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed['source']).toBe('codex')
    expect(parsed['pid']).toBe(123)
    expect(parsed['event']).toBe('session_start')
  })
})
