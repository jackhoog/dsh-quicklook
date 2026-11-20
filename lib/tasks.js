/** In-flight call registry and a bounded response cache. */
import { createHash } from 'node:crypto'

/** Cancellation plus memoization for repeated selections. */
export class Tasks {
  #controllers = new Map()
  #cache = new Map()
  #limit = 200

  /**
   * Hash the inputs that decide a response.
   * @param parts - ordered inputs.
   * @returns a stable cache key.
   */
  static key(parts) {
    return createHash('sha256').update(parts.join('\u0000')).digest('hex')
  }

  /**
   * Start a task, cancelling any earlier task with the same key.
   * @param key - logical slot such as `translate:card-3`.
   * @returns the abort signal for this task.
   */
  begin(key) {
    this.cancel(key)
    const controller = new AbortController()
    this.#controllers.set(key, controller)
    return controller.signal
  }

  /** Abort one slot if it is running. */
  cancel(key) {
    const controller = this.#controllers.get(key)
    if (controller) {
      controller.abort()
      this.#controllers.delete(key)
    }
  }

  /** Mark one slot finished. */
  end(key) {
    this.#controllers.delete(key)
  }

  /** Abort every running call; used when the plugin unloads. */
  cancelAll() {
    for (const controller of this.#controllers.values()) controller.abort()
    this.#controllers.clear()
  }

  /** Read a cached response. */
  get(key) {
    const hit = this.#cache.get(key)
    if (hit === undefined) return undefined
    // Refresh recency.
    this.#cache.delete(key)
    this.#cache.set(key, hit)
    return hit
  }

  /** Store a response, evicting the oldest entry past the bound. */
  set(key, value) {
    this.#cache.set(key, value)
    while (this.#cache.size > this.#limit) {
      const oldest = this.#cache.keys().next().value
      this.#cache.delete(oldest)
    }
  }

  /** Drop the cache, e.g. after the glossary changes. */
  clearCache() {
    this.#cache.clear()
  }
}