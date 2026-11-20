/** Short-lived registry of screenshots the popup may still reference. */

/** Keeps a bounded number of captured images with their attachment references. */
export class ImageRegistry {
  #entries = new Map()
  #limit

  constructor(limit = 12) {
    this.#limit = limit
  }

  /**
   * Remember one captured image.
   * @param ref - durable attachment reference.
   * @param meta - extra display facts.
   * @returns the stored entry.
   */
  add(ref, meta = {}) {
    const entry = { ref, ...meta, ts: Date.now() }
    this.#entries.set(ref.attachmentId, entry)
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value
      this.#entries.delete(oldest)
    }
    return entry
  }

  /** Resolve one captured image by id. */
  get(id) {
    return this.#entries.get(id)
  }

  /** Drop every entry. */
  clear() {
    this.#entries.clear()
  }
}