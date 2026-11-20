/** Lifecycle of the PowerShell shell that owns hotkeys, picking and the window. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../shell/quicklook.ps1', import.meta.url))
const HOST = 'powershell.exe'

/** Spawns, restarts and stops the shell process. */
export class Shell {
  #ctx
  #store
  #tokens
  #handle = null
  #testMarker = ''
  #state = 'stopped'
  #lastExit = null
  #stderr = ''

  constructor(ctx, { store, tokens, testMarker }) {
    this.#ctx = ctx
    this.#store = store
    this.#tokens = tokens
    this.#testMarker = testMarker ?? ''
  }

  /** Observable state for the settings panel. */
  get status() {
    return { state: this.#state, lastExit: this.#lastExit, stderr: this.#stderr.slice(-2000) }
  }

  /**
   * Start the shell with the current settings.
   * @param origin - the browser origin the shell should call back on.
   */
  start(origin) {
    if (this.#handle !== null) return this.status
    const subprocess = this.#ctx.get('subprocess')
    if (!subprocess) {
      this.#state = 'unavailable'
      this.#stderr = 'subprocess 服务不可用，无法启动壳'
      return this.status
    }
    const settings = this.#store.settings
    if (!settings.shellAutoStart) {
      this.#state = 'disabled'
      return this.status
    }

    const environment = {
      ...process.env,
      QK_ORIGIN: origin,
      QK_TOKEN: this.#tokens.master,
      QK_HOTKEYS: JSON.stringify(settings.hotkeys),
      QK_WINDOW: `${settings.window?.width ?? 256}x${settings.window?.height ?? 341}`,
      QK_TEST: this.#testMarker,
      QK_FRAME: settings.hideTitleBar === false ? '0' : '1',
      QK_BROWSER: settings.browser ?? '',
    }

    try {
      const handle = subprocess.spawn({
        argv: [HOST, '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCRIPT],
        cwd: path.dirname(SCRIPT),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        env: environment,
        graceMs: 3000,
      })
      this.#handle = handle
      this.#state = 'running'
      this.#lastExit = null
      this.#stderr = ''
      handle.done.then((outcome) => {
        this.#handle = null
        this.#lastExit = outcome
        this.#state = 'exited'
        this.#readStderr(handle)
      }).catch((error) => {
        this.#handle = null
        this.#state = 'failed'
        this.#stderr = String(error?.message ?? error)
      })
    } catch (error) {
      this.#state = 'failed'
      this.#stderr = String(error?.message ?? error)
    }
    return this.status
  }

  #readStderr(handle) {
    try {
      const read = handle.collected.stderr?.readFrom(0)
      if (read?.text) this.#stderr = read.text
    } catch {
      // Collected output is best-effort diagnostics only.
    }
  }

  /** Stop the shell, waiting briefly for the process to settle. */
  async stop() {
    const handle = this.#handle
    if (handle === null) return
    this.#handle = null
    this.#state = 'stopping'
    try {
      handle.terminate()
      await handle.waitForExit(new AbortController().signal)
    } catch {
      // Termination is best-effort; the provider still owns cleanup.
    }
    this.#state = 'stopped'
  }

  /**
   * Restart after a settings change so new hotkeys take effect.
   * @param origin - browser origin for the callback.
   */
  async restart(origin) {
    await this.stop()
    return this.start(origin)
  }
}