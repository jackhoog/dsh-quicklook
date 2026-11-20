/** Quicklook host half: owns the HTTP surface and the PowerShell shell. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRoutes } from './lib/router.js'
import { ImageRegistry } from './lib/images.js'
import { Shell } from './lib/shell.js'
import { Store } from './lib/state.js'
import { Tasks } from './lib/tasks.js'

export const name = 'quicklook'
export const inject = ['webServer']

/** Token file lets a local script call the API without scraping process memory. */
function tokenFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'dsh-quicklook', 'token')
}

/**
 * Register routes, then start the shell that owns hotkeys and the window.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const store = new Store()
  const tasks = new Tasks()
  const tokens = { master: randomUUID(), sessions: new Set() }
  const shell = new Shell(ctx, { store, tokens, testMarker: path.join(path.dirname(tokenFile()), 'test-window') })
  const images = new ImageRegistry()
  const testMarker = path.join(path.dirname(tokenFile()), 'test-window')
  const routes = createRoutes(ctx, { store, tasks, shell, tokens, images, testMarker })

  const file = tokenFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, tokens.master, 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`quicklook token file not written: ${error?.message ?? error}`)
  }

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'quicklook: http routes')

  ctx.effect(() => {
    try {
      shell.start(ctx.webServer.getOrigin())
    } catch (error) {
      ctx.logger?.warn?.(`quicklook shell not started: ${error?.message ?? error}`)
    }
    return () => {
      tasks.cancelAll()
      images.clear()
      void shell.stop()
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // The token file is a convenience; leaving it behind is harmless.
      }
    }
  }, 'quicklook: shell process')

  ctx.logger?.info?.('quicklook ready')
}