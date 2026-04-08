import * as fs from 'node:fs'
import * as net from 'node:net'
import { Context, Effect, Runtime } from 'effect'
import { parseHookEventFromString } from './schemas.js'
import { SessionManager } from './sessionManager.js'

export const getSocketPath = (): string =>
  `/tmp/vscode-claude-${process.pid}.sock`

export class SocketConfig extends Context.Tag('SocketConfig')<
  SocketConfig,
  { readonly socketPath: string }
>() {}

class SocketServer extends Effect.Service<SocketServer>()('SocketServer', {
  scoped: Effect.gen(function* () {
    const sessionManager = yield* SessionManager
    const runtime = yield* Effect.runtime<never>()
    const { socketPath } = yield* SocketConfig
    const sockets = new Set<net.Socket>()

    yield* Effect.acquireRelease(
      Effect.async<net.Server, Error>((resume) => {
        try {
          fs.unlinkSync(socketPath)
        } catch {
          // Ignore — stale socket file may not exist
        }

        const srv = net.createServer((socket) => {
          sockets.add(socket)
          let buffer = ''

          socket.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8')
            const lines = buffer.split('\n')
            buffer = lines.at(-1) ?? ''
            for (const line of lines.slice(0, -1)) {
              const trimmed = line.trim()
              if (trimmed === '') continue
              Runtime.runFork(runtime)(
                parseHookEventFromString(trimmed).pipe(
                  Effect.tap((event) =>
                    Effect.logInfo(`Hook event received: ${event.event}`),
                  ),
                  Effect.flatMap((event) =>
                    sessionManager.processEvent(event),
                  ),
                  Effect.catchAll((err) =>
                    Effect.logWarning(
                      `Failed to parse hook event: ${String(err)}`,
                    ),
                  ),
                ),
              )
            }
          })

          socket.on('close', () => sockets.delete(socket))
          socket.on('error', () => sockets.delete(socket))
        })

        srv.on('listening', () => resume(Effect.succeed(srv)))
        srv.on('error', (err) => resume(Effect.fail(err)))
        srv.listen(socketPath)
      }),
      (srv) =>
        Effect.async<void>((resume) => {
          for (const socket of sockets) {
            socket.destroy()
          }
          sockets.clear()
          srv.close(() => {
            try {
              fs.unlinkSync(socketPath)
            } catch {
              // Best-effort deletion
            }
            resume(Effect.void)
          })
        }),
    )

    return { socketPath }
  }),
}) {}

export { SocketServer }
export const SocketServerLive = SocketServer.Default
