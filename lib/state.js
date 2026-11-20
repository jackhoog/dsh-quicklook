/** Durable plugin settings, history and favorites. One JSON document under the harness home. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Defaults used on first run and after an unreadable document. */
export const DEFAULT_SETTINGS = Object.freeze({
  window: { width: 256, height: 260 },
  direction: 'auto',
  model: { translate: null, ask: null },
  normalize: 'auto',
  budget: true,
  pinned: false,
  glossary: [],
  hotkeys: { translate: 'Ctrl+Shift+Q', ask: 'Ctrl+Shift+E', capture: 'Ctrl+Shift+S' },
  shellAutoStart: true,
  browser: '',
  maxTextChars: 4000,
  ocr: true,
  hideTitleBar: true,
  searchMode: 'auto',
  includeSource: true,
  dictCard: true,
  historyLimit: 200,
})

const HISTORY_LIMIT = 200

/** Resolve the plugin data directory without touching the workspace. */
function dataDirectory() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'dsh-quicklook')
}

/** Merge stored values over defaults, tolerating unknown keys. */
function withDefaults(stored) {
  if (stored === null || typeof stored !== 'object') return structuredClone(DEFAULT_SETTINGS)
  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...stored }
  merged.hotkeys = { ...DEFAULT_SETTINGS.hotkeys, ...(stored.hotkeys ?? {}) }
  merged.window = { ...DEFAULT_SETTINGS.window, ...(stored.window ?? {}) }
  merged.model = { ...DEFAULT_SETTINGS.model, ...(stored.model ?? {}) }
  if (!Array.isArray(merged.glossary)) merged.glossary = []
  // Older documents stored a single target language; keep the closest direction.
  if (merged.direction === undefined && typeof stored.targetLanguage === 'string') {
    merged.direction = stored.targetLanguage === '中文' ? 'to-zh' : 'auto'
  }
  delete merged.targetLanguage
  return merged
}

/** Settings, history and favorites with atomic synchronous persistence. */
export class Store {
  #file
  #settings
  #history = []
  #favorites = []
  #latest = null
  #revision = 0
  #settingsRevision = 0
  #clipboard = { text: '', revision: 0 }

  constructor() {
    this.#file = path.join(dataDirectory(), 'state.json')
    this.#load()
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.#file, 'utf8')
      const parsed = JSON.parse(raw)
      // Older documents stored settings at the top level.
      this.#settings = withDefaults(parsed.settings ?? parsed)
      this.#history = Array.isArray(parsed.history) ? parsed.history : []
      this.#favorites = Array.isArray(parsed.favorites) ? parsed.favorites : []
    } catch {
      this.#settings = structuredClone(DEFAULT_SETTINGS)
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      const document = { settings: this.#settings, history: this.#history, favorites: this.#favorites }
      const temporary = `${this.#file}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(document, null, 2), 'utf8')
      fs.renameSync(temporary, this.#file)
    } catch (error) {
      // Settings are a convenience; failing to persist must not break the plugin.
      console.error('[quicklook] state not saved:', error?.message ?? error)
    }
  }

  /** Current settings (a copy). */
  get settings() {
    return structuredClone(this.#settings)
  }

  /**
   * Apply a partial update and persist it.
   * @param partial - keys to overwrite.
   * @returns the merged settings.
   */
  patch(partial) {
    this.#settings = withDefaults({ ...this.#settings, ...partial })
    this.#settingsRevision += 1
    this.#save()
    return this.settings
  }

  /** Bumped on every settings write so open windows can refresh. */
  get settingsRevision() {
    return this.#settingsRevision
  }

  /** Latest text picked by the shell. */
  get latest() {
    return this.#latest
  }

  get revision() {
    return this.#revision
  }

  /** Latest clipboard text reported by the shell. */
  get clipboard() {
    return this.#clipboard
  }

  /**
   * Record a clipboard change; identical text is ignored so the watcher can poll freely.
   * @param text - current clipboard text.
   * @returns the stored clipboard state.
   */
  setClipboard(text) {
    const value = String(text ?? '')
    if (value === this.#clipboard.text) return this.#clipboard
    this.#clipboard = { text: value, revision: this.#clipboard.revision + 1 }
    return this.#clipboard
  }

  /**
   * Record one pick from the shell and bump the revision the popup polls.
   * @param pick - selected text plus where it came from.
   */
  setLatest(pick) {
    this.#revision += 1
    this.#latest = { ...pick, revision: this.#revision, ts: Date.now() }
    return this.#latest
  }

  /**
   * Append one finished result to the history ring.
   * @param entry - action, source text and result.
   * @param limit - how many results to keep from the caller.
   * @returns the stored entry.
   */
  addHistory(entry, limit = 20) {
    const record = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      action: entry.action,
      title: String(entry.title ?? '').slice(0, 200),
      text: String(entry.text ?? '').slice(0, 2000),
      result: String(entry.result ?? '').slice(0, 4000),
      shape: entry.shape ?? '',
      dict: entry.dict ?? null,
      starred: false,
    }
    this.#history.unshift(record)
    if (this.#history.length > HISTORY_LIMIT) this.#history.length = HISTORY_LIMIT
    this.#save()
    return record
  }

  /**
   * Read the newest history entries.
   * @param limit - maximum entries to return.
   */
  listHistory(limit = 20) {
    return this.#history.slice(0, Math.max(1, Math.min(200, limit)))
  }

  /** Drop every history entry. */
  clearHistory() {
    this.#history = []
    this.#save()
  }

  /**
   * Remove one history entry.
   * @param id - history entry id.
   * @returns the remaining entries.
   */
  removeHistory(id) {
    this.#history = this.#history.filter((item) => item.id !== id)
    this.#favorites = this.#favorites.filter((item) => item.id !== id)
    this.#save()
    return this.listHistory()
  }

  /**
   * Star or unstar a history entry, mirroring the star into favorites.
   * @param id - history entry id.
   * @param starred - desired state.
   * @returns the updated entries.
   */
  setStarred(id, starred) {
    const entry = this.#history.find((item) => item.id === id)
    if (entry === undefined) return { history: this.listHistory(), favorites: this.listFavorites() }
    entry.starred = Boolean(starred)
    if (entry.starred) {
      if (!this.#favorites.some((item) => item.id === id)) {
        this.#favorites.unshift({ ...entry, starred: true })
        if (this.#favorites.length > HISTORY_LIMIT) this.#favorites.length = HISTORY_LIMIT
      }
    } else {
      this.#favorites = this.#favorites.filter((item) => item.id !== id)
    }
    this.#save()
    return { history: this.listHistory(), favorites: this.listFavorites() }
  }

  /** Star an arbitrary text/result pair that has no history entry yet. */
  addFavorite(entry) {
    const record = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      action: entry.action ?? 'translate',
      title: String(entry.title ?? '').slice(0, 200),
      text: String(entry.text ?? '').slice(0, 2000),
      result: String(entry.result ?? '').slice(0, 4000),
      starred: true,
    }
    this.#favorites.unshift(record)
    if (this.#favorites.length > HISTORY_LIMIT) this.#favorites.length = HISTORY_LIMIT
    this.#save()
    return record
  }

  /** Every starred entry, newest first. */
  listFavorites() {
    return structuredClone(this.#favorites)
  }

  /** Render favorites as a Markdown word book. */
  exportFavorites() {
    const lines = ['# 划词小窗 · 生词与收藏', '']
    for (const item of this.#favorites) {
      lines.push(`## ${item.text.split('\n')[0].slice(0, 80)}`)
      lines.push('')
      lines.push(`> ${item.text.replace(/\n/g, '\n> ')}`)
      lines.push('')
      lines.push(item.result)
      lines.push('')
      lines.push(`<sub>${new Date(item.ts).toLocaleString('zh-CN')} · ${item.action}</sub>`)
      lines.push('')
    }
    return lines.join('\n')
  }
}