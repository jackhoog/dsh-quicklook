'use strict'

const state = {
  token: '',
  settings: {},
  presets: [],
  revision: 0,
  clipboardRevision: 0,
  settingsRevision: 0,
  mode: 'translate',
  polling: null,
  history: [],
  pending: [],
  forceSearch: false,
  models: [],
}

/** Both modes keep their own source, output and identity; the window is shared. */
const panes = {
  translate: { source: '', origin: '', output: '', meta: '', historyId: '', imageId: '', starred: false, dirty: false, usedBudget: false, dictObj: null },
  ask: { source: '', origin: '', output: '', meta: '', historyId: '', imageId: '', starred: false, dirty: false, usedBudget: false, dictObj: null },
}

const el = {
  mode: document.getElementById('mode'),
  badges: document.getElementById('badges'),
  pin: document.getElementById('pin'),
  more: document.getElementById('more'),
  drawer: document.getElementById('drawer'),
  feed: document.getElementById('feed'),
  feedWrap: document.getElementById('feed-wrap'),
  feedTitle: document.getElementById('feed-title'),
  question: document.getElementById('question'),
  run: document.getElementById('run'),
  presets: document.getElementById('presets'),
  shell: document.getElementById('shell'),
  hkTranslate: document.getElementById('hk-translate'),
  hkAsk: document.getElementById('hk-ask'),
  normalize: document.getElementById('normalize'),
  budget: document.getElementById('budget'),
  target: document.getElementById('target'),
  winWidth: document.getElementById('win-width'),
  winHeight: document.getElementById('win-height'),
  modelTranslate: document.getElementById('model-translate'),
  modelAsk: document.getElementById('model-ask'),
  loadModels: document.getElementById('load-models'),
  searchMode: document.getElementById('search-mode'),
  dictCard: document.getElementById('dict-card'),
  includeSource: document.getElementById('include-source'),
  glossary: document.getElementById('glossary'),
}

/** Collect the DOM nodes that belong to one mode. */
function nodes(mode) {
  const pane = document.querySelector(`.pane[data-pane="${mode}"]`)
  return {
    pane,
    source: document.getElementById(`source-${mode}`),
    out: document.getElementById(`out-${mode}`),
    dict: document.getElementById(`dict-${mode}`),
    shot: document.getElementById(`shot-${mode}`),
    image: pane.querySelector('.shot-img'),
    shotOcr: pane.querySelector('.shot-ocr'),
    shotSend: pane.querySelector('.shot-send'),
    copy: pane.querySelector('.act-copy'),
    star: pane.querySelector('.act-star'),
    speak: pane.querySelector('.act-speak'),
    expand: pane.querySelector('.act-expand'),
    clear: pane.querySelector('.act-clear'),
  }
}

async function api(path, init = {}) {
  const headers = { 'content-type': 'application/json' }
  if (state.token) headers['x-qk-token'] = state.token
  const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  const text = await response.text()
  let value
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(text.slice(0, 300) || `HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
  return value
}

function shapeLabel(shape) {
  if (shape === 'code') return '代码'
  if (shape === 'list') return '列表'
  if (shape === 'table') return '表格'
  return '长文本'
}

function describe(stats, shape) {
  const parts = []
  if (stats && stats.newlines) parts.push(`合并 ${stats.newlines} 处换行`)
  if (stats && stats.hyphens) parts.push(`修复 ${stats.hyphens} 处断词`)
  if (stats && stats.forcedSkip) parts.push(`检测到${shapeLabel(stats.forcedSkip)}，已跳过合并`)
  else if (shape && shape !== 'prose' && shape !== 'empty' && !(stats && stats.newlines)) {
    parts.push(`${shapeLabel(shape)}：保留原样`)
  }
  return parts.join(' · ')
}

function renderBadges() {
  const items = []
  const normalize = state.settings.normalize || 'auto'
  if (normalize !== 'off') items.push(normalize === 'on' ? '去换行·强制' : '去换行·自动')
  if (state.mode === 'ask' && state.settings.budget) items.push('精简')
  if (state.pending.length > 0) items.push(`待 ${state.pending.length}`)
  el.badges.textContent = ''
  for (const text of items) {
    const span = document.createElement('span')
    span.textContent = text
    el.badges.append(span)
  }
  el.pin.classList.toggle('on', Boolean(state.settings.pinned))
}

/** Push the pane state into its DOM. */
function render(mode) {
  const data = panes[mode]
  const view = nodes(mode)
  if (view.source.value !== data.source) view.source.value = data.source
  if (view.out.textContent !== data.output) view.out.textContent = data.output
  view.out.classList.toggle('error', data.error === true)
  view.out.hidden = Boolean(data.dictObj)
  view.star.classList.toggle('on', data.starred)
  view.expand.hidden = !(mode === 'ask' && data.usedBudget && data.output !== '')
  if (data.imageId) {
    view.shot.hidden = false
    const url = `/qk/image?id=${encodeURIComponent(data.imageId)}&t=${encodeURIComponent(state.token)}`
    if (view.image.getAttribute('src') !== url) view.image.src = url
  } else {
    view.shot.hidden = true
  }
}

function setMode(mode, { keepFocus = false } = {}) {
  state.mode = mode === 'ask' ? 'ask' : 'translate'
  for (const button of el.mode.children) button.classList.toggle('on', button.dataset.mode === state.mode)
  for (const pane of document.querySelectorAll('.pane')) {
    pane.hidden = pane.dataset.pane !== state.mode
  }
  el.question.hidden = state.mode !== 'ask'
  el.presets.hidden = state.mode !== 'ask'
  el.run.textContent = state.mode === 'ask' ? '问' : '翻译'
  renderBadges()
  render(state.mode)
  if (keepFocus) {
    if (state.mode === 'ask') el.question.focus()
    else nodes('translate').source.focus()
  }
}

/** Append text to a container, wrapping occurrences of `word` in <strong>. */
function appendHighlighted(container, text, word) {
  const source = String(text ?? '')
  const target = String(word ?? '').trim()
  if (target === '') {
    container.append(document.createTextNode(source))
    return
  }
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let pattern
  try {
    pattern = new RegExp(`(${escaped})`, 'ig')
  } catch {
    container.append(document.createTextNode(source))
    return
  }
  for (const part of source.split(pattern)) {
    if (part === '') continue
    if (part.toLowerCase() === target.toLowerCase()) {
      const strong = document.createElement('strong')
      strong.textContent = part
      container.append(strong)
    } else {
      container.append(document.createTextNode(part))
    }
  }
}

/** Render the structured dictionary card, or clear it. */
function renderDict(mode, dict) {
  const box = nodes(mode).dict
  if (!box) return
  box.textContent = ''
  if (!dict) {
    box.hidden = true
    return
  }
  box.hidden = false
  const head = document.createElement('div')
  head.className = 'dict-head'
  const word = document.createElement('span')
  word.className = 'dict-word'
  word.textContent = dict.word
  head.append(word)
  if (dict.phonetic) {
    const phonetic = document.createElement('span')
    phonetic.className = 'dict-phonetic'
    phonetic.textContent = dict.phonetic
    head.append(phonetic)
  }
  box.append(head)
  for (const entry of dict.pos) {
    const row = document.createElement('div')
    row.className = 'dict-pos'
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = entry.tag
    const senses = document.createElement('span')
    senses.textContent = entry.senses.join('；')
    row.append(tag, senses)
    box.append(row)
  }
  for (const example of dict.examples) {
    const line = document.createElement('div')
    line.className = 'dict-ex'
    appendHighlighted(line, example.en, dict.word)
    if (example.zh) {
      const zh = document.createElement('div')
      zh.className = 'dict-ex-zh'
      zh.textContent = example.zh
      line.append(zh)
    }
    box.append(line)
  }
}

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  utterance.lang = cjk > text.length * 0.2 ? 'zh-CN' : 'en-US'
  window.speechSynthesis.speak(utterance)
}

function applyEvent(mode, event) {
  const data = panes[mode]
  const view = nodes(mode)
  if (event.phase === 'searching') {
    return
  }
  if (event.reset) {
    data.output = ''
    view.out.textContent = ''
    renderDict(mode, null)
    return
  }
  if (event.error) {
    data.error = true
    data.output = `⚠ ${event.error}`
    render(mode)
    return
  }
  if (event.delta) {
    data.output += event.delta
    data.error = false
    view.out.textContent = data.output
    view.out.classList.remove('error')
    return
  }
  if (event.final === undefined) return

  if (event.noText) {
    data.output = '这张图里没识别到文字。'
    render(mode)
    return
  }
  if (event.raw !== undefined) {
    data.source = event.final
    data.dirty = false
    view.source.value = data.source
    data.meta = '识别完成，可直接改字后重译'
    render(mode)
    if (state.mode === 'translate') void runTranslate()
    return
  }
  data.error = false
  data.output = event.final
  data.dictObj = event.dict ?? null
  if (data.dictObj) {
    // The card already shows everything; the plain copy would just repeat it.
    view.out.textContent = ''
    view.out.hidden = true
  } else {
    view.out.hidden = false
  }
  renderDict(mode, data.dictObj)
  if (event.historyId) {
    data.historyId = event.historyId
    data.starred = false
  }
  const notes = []
  if (event.searched) notes.push('已联网')
  if (event.cached) notes.push('缓存')
  const described = describe(event.stats, event.shape)
  if (described) notes.push(described)
  data.meta = notes.join(' · ')
  render(mode)
  void refreshFeed()
}

async function stream(path, payload, mode) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qk-token': state.token },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text.slice(0, 300) || `HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let index = pending.indexOf('\n')
    while (index >= 0) {
      const raw = pending.slice(0, index).trim()
      pending = pending.slice(index + 1)
      if (raw !== '') {
        try {
          applyEvent(mode, JSON.parse(raw))
        } catch {
          // A malformed line must not kill the stream.
        }
      }
      index = pending.indexOf('\n')
    }
  }
}

async function runTranslate() {
  const data = panes.translate
  if (data.source.trim() === '') return
  data.output = ''
  data.error = false
  data.dictObj = null
  data.meta = '翻译中…'
  render('translate')
  renderDict('translate', null)
  try {
    await stream('/qk/translate', {
      text: data.source,
      cardId: 'translate',
      normalizeMode: state.settings.normalize,
      direction: state.settings.direction,
      source: data.origin,
    }, 'translate')
  } catch (error) {
    applyEvent('translate', { error: String(error.message || error) })
  }
}

async function runAsk({ detailed = false } = {}) {
  const data = panes.ask
  const question = el.question.value.trim()
  if (question === '' && data.source.trim() === '') {
    data.meta = '先在来源框里放点内容，或写一个问题'
    render('ask')
    return
  }
  data.output = ''
  data.error = false
  data.usedBudget = detailed ? false : Boolean(state.settings.budget)
  data.meta = '思考中…'
  render('ask')
  try {
    await stream('/qk/ask', {
      text: data.source,
      question,
      cardId: 'ask',
      normalizeMode: state.settings.normalize,
      budget: data.usedBudget,
      source: data.origin,
      imageId: data.imageId || undefined,
      search: state.forceSearch ? true : undefined,
    }, 'ask')
  } catch (error) {
    applyEvent('ask', { error: String(error.message || error) })
  }
}

async function runOcr(mode) {
  const data = panes[mode]
  if (!data.imageId) return
  data.meta = '正在识别…'
  render(mode)
  try {
    await stream('/qk/ocr', { imageId: data.imageId, cardId: mode }, mode)
  } catch (error) {
    applyEvent(mode, { error: String(error.message || error) })
  }
}

function runCurrent() {
  if (state.mode === 'ask') void runAsk()
  else void runTranslate()
}

/** Load one entry (pending pick or history row) into its pane without re-running. */
function openEntry(entry) {
  const mode = entry.action === 'ask' ? 'ask' : 'translate'
  const data = panes[mode]
  setMode(mode)
  data.source = entry.text || ''
  data.origin = entry.title || ''
  data.output = entry.result || ''
  data.meta = entry.ts ? new Date(entry.ts).toLocaleString('zh-CN') : ''
  data.historyId = entry.historyId || entry.id || ''
  data.starred = Boolean(entry.starred)
  data.imageId = entry.imageId || ''
  data.dirty = false
  data.error = false
  data.usedBudget = false
  data.dictObj = entry.dict ?? null
  render(mode)
  renderDict(mode, data.dictObj)
  if (entry.result) void refreshFeed()
}

function loadPick(pick) {
  state.revision = pick.revision
  // The pane that would receive this pick decides: only a pane that already has
  // content is protected by pinning, so the very first pick still shows up.
  const target = panes[pick.action === 'ask' ? 'ask' : 'translate']
  if (state.settings.pinned && (target.source !== '' || target.output !== '')) {
    state.pending.unshift({
      kind: 'pending',
      id: `p-${Date.now()}`,
      action: pick.action === 'ask' ? 'ask' : 'translate',
      text: pick.text || '',
      title: pick.title || '',
      imageId: pick.imageId || '',
      ts: Date.now(),
    })
    const data = panes[state.mode]
    data.meta = '已钉住：新内容进入了下方列表'
    render(state.mode)
    renderFeed()
    renderBadges()
    try {
      el.feedWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el.feedWrap.classList.add('flash')
      setTimeout(() => el.feedWrap.classList.remove('flash'), 900)
    } catch {
      // Scrolling is cosmetic.
    }
    return
  }
  const mode = pick.action === 'ask' ? 'ask' : 'translate'
  setMode(mode)
  const data = panes[mode]
  data.source = pick.text || ''
  data.origin = pick.title || ''
  data.output = ''
  data.meta = ''
  data.historyId = ''
  data.starred = false
  data.imageId = pick.imageId || ''
  data.dirty = false
  data.error = false
  data.usedBudget = false
  data.dictObj = null
  render(mode)
  renderDict(mode, null)

  if (pick.notice === 'capture-failed') {
    data.output = '没取到文字：把内容粘贴到上面，按 Enter 翻译'
    render(mode)
    nodes(mode).source.focus()
    return
  }
  if (pick.kind === 'image') {
    data.meta = data.source ? '本地识别完成，可直接改字后重译' : '截图已就绪：可转文字，或切到「问」发给模型'
    render(mode)
    if (data.source && mode === 'translate') void runTranslate()
    return
  }
  if (mode === 'ask') el.question.focus()
  else void runTranslate()
}

async function poll() {
  try {
    const result = await api(`/qk/latest?after=${state.revision}`)
    if (result.pick) loadPick(result.pick)
    // Settings changed elsewhere (DSH settings page): pull them in.
    if (typeof result.settingsRevision === 'number' && result.settingsRevision > state.settingsRevision) {
      state.settingsRevision = result.settingsRevision
      const config = await api('/qk/config')
      state.settings = config.settings
      if (typeof config.revision === 'number') state.settingsRevision = config.revision
      fillSettings()
      render(state.mode)
    }
  } catch {
    // Transient failures are not worth a visible error.
  }
  try {
    const clipboard = await api(`/qk/clipboard?after=${state.clipboardRevision}`)
    state.clipboardRevision = clipboard.revision
    if (clipboard.text) applyClipboard(clipboard.text)
  } catch {
    // The shell reports clipboard changes only while it is running.
  }
}

/** Put new clipboard text into the visible pane unless the user is editing it. */
function applyClipboard(text) {
  const mode = state.mode
  const data = panes[mode]
  if (data.dirty) {
    data.meta = '剪贴板有新内容：清空来源框后会自动填入'
    render(mode)
    return
  }
  data.source = text
  data.origin = ''
  data.output = ''
  data.meta = ''
  data.historyId = ''
  data.imageId = ''
  data.starred = false
  render(mode)
}

async function refreshFeed() {
  try {
    const result = await api('/qk/history?limit=20')
    state.history = result.history || []
  } catch {
    // Keep the previous list on a transient failure.
  }
  renderFeed()
}

function renderFeed() {
  const rows = [
    ...state.pending.map((item) => ({ ...item, pendingRow: true })),
    ...state.history.map((item) => ({ ...item, pendingRow: false })),
  ]
  el.feedWrap.hidden = rows.length === 0
  const pendingNote = state.pending.length > 0 ? ` · 待 ${state.pending.length}` : ''
  el.feedTitle.textContent = `历史 ${state.history.length}${pendingNote}`
  el.feed.textContent = ''
  for (const row of rows) {
    const node = document.createElement('div')
    node.className = `feed-item${row.pendingRow ? ' pending' : ''}`
    const tag = document.createElement('span')
    tag.className = `tag${row.pendingRow ? ' pending' : ''}`
    tag.textContent = row.pendingRow ? '待' : (row.action === 'ask' ? '问' : '译')
    const text = document.createElement('span')
    text.className = 'txt'
    text.textContent = (row.text || '').split('\n')[0].slice(0, 60)
      || (row.action === 'ask' ? '（提问）' : '（翻译）')
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove'
    remove.textContent = '×'
    remove.title = '删除这条'
    remove.addEventListener('click', async (event) => {
      event.stopPropagation()
      if (row.pendingRow) {
        state.pending = state.pending.filter((item) => item.id !== row.id)
        renderFeed()
        return
      }
      try {
        const result = await api('/qk/history', { method: 'POST', body: JSON.stringify({ remove: row.id }) })
        state.history = result.history || []
        renderFeed()
      } catch {
        // A failed delete leaves the row in place; the next refresh reconciles.
      }
    })
    node.append(tag, text, remove)
    node.addEventListener('click', () => {
      if (row.pendingRow) state.pending = state.pending.filter((item) => item !== row)
      openEntry(row)
      renderFeed()
    })
    el.feed.append(node)
  }
}

async function starCurrent() {
  const mode = state.mode
  const data = panes[mode]
  if (data.output.trim() === '') return
  try {
    if (data.historyId) {
      const result = await api('/qk/history', {
        method: 'POST',
        body: JSON.stringify({ id: data.historyId, starred: !data.starred }),
      })
      state.history = result.history || state.history
    } else {
      await api('/qk/favorites', {
        method: 'POST',
        body: JSON.stringify({ text: data.source, result: data.output, title: data.origin, action: mode }),
      })
    }
    data.starred = !data.starred
    render(mode)
    renderFeed()
  } catch (error) {
    data.meta = `收藏失败：${error.message || error}`
    render(mode)
  }
}

function keyFromEvent(event) {
  const code = event.code || ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code
  const map = {
    Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\',
  }
  return map[code] || ''
}

function recordHotkey(input, slot) {
  el.drawer.dataset.recording = slot
  input.classList.add('recording')
  input.value = '按下新的组合键…'
}

document.addEventListener('keydown', async (event) => {
  const slot = el.drawer.dataset.recording
  if (!slot) {
    if (event.key === 'Escape') {
      if (!el.drawer.hidden) {
        el.drawer.hidden = true
        return
      }
      // The title bar is hidden, so Escape is the way out.
      window.close()
    }
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    el.drawer.dataset.recording = ''
    return
  }
  const key = keyFromEvent(event)
  if (key === '') return
  const modifiers = []
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (event.metaKey) modifiers.push('Win')
  if (modifiers.length === 0) return
  const spec = [...modifiers, key].join('+')
  el.drawer.dataset.recording = ''
  await saveHotkey(slot, spec)
})

async function saveHotkey(slot, spec) {
  try {
    const hotkeys = { ...state.settings.hotkeys, [slot]: spec }
    const result = await api('/qk/config', { method: 'POST', body: JSON.stringify({ hotkeys }) })
    state.settings = result.settings
    fillSettings()
    el.hkTranslate.classList.remove('recording')
    el.hkAsk.classList.remove('recording')
    el.shell.textContent = `已保存，壳重启中（${result.shell.state}）`
  } catch (error) {
    el.shell.textContent = `保存失败：${error.message || error}`
  }
}

function fillSettings() {
  el.hkTranslate.value = state.settings.hotkeys.translate || ''
  el.hkAsk.value = state.settings.hotkeys.ask || ''
  el.normalize.value = state.settings.normalize || 'auto'
  el.budget.value = state.settings.budget ? '1' : '0'
  el.target.value = state.settings.direction || 'auto'
  const win = state.settings.window || { width: 256, height: 300 }
  el.winWidth.value = win.width
  el.winHeight.value = win.height
  el.searchMode.value = state.settings.searchMode || 'auto'
  el.dictCard.checked = state.settings.dictCard !== false
  el.includeSource.checked = state.settings.includeSource !== false
  fillModelSelect(el.modelTranslate, state.settings.model?.translate)
  fillModelSelect(el.modelAsk, state.settings.model?.ask)
  const glossary = Array.isArray(state.settings.glossary) ? state.settings.glossary : []
  el.glossary.value = glossary.map((pair) => `${pair.from}=${pair.to}`).join('\n')
  renderBadges()
}

/** Fill a model select from the loaded provider list, keeping the saved choice. */
function fillModelSelect(select, current) {
  const value = current && current.provider && current.model ? `${current.provider}||${current.model}` : ''
  select.textContent = ''
  const fallback = document.createElement('option')
  fallback.value = ''
  fallback.textContent = '跟随 DSH 默认'
  select.append(fallback)
  for (const provider of state.models) {
    for (const model of provider.models) {
      const option = document.createElement('option')
      option.value = `${provider.id}||${model.id}`
      option.textContent = `${provider.name} · ${model.name}`
      select.append(option)
    }
  }
  select.value = value
  if (select.value !== value) {
    // Saved model is not in the fetched list (yet): show it rather than silently resetting.
    const custom = document.createElement('option')
    custom.value = value
    custom.textContent = value.replace('||', ' · ')
    select.append(custom)
    select.value = value
  }
}

/** Clear the visible pane: source, result, card and identity. */
function clearPane(mode) {
  const data = panes[mode]
  data.source = ''
  data.origin = ''
  data.output = ''
  data.meta = ''
  data.historyId = ''
  data.imageId = ''
  data.starred = false
  data.dirty = false
  data.dictObj = null
  data.error = false
  if (mode === 'ask') el.question.value = ''
  render(mode)
  renderDict(mode, null)
  nodes(mode).source.focus()
}

function readGlossary() {
  const pairs = []
  for (const line of el.glossary.value.split('\n')) {
    const text = line.trim()
    const index = text.indexOf('=')
    if (text === '' || index <= 0) continue
    const from = text.slice(0, index).trim()
    const to = text.slice(index + 1).trim()
    if (from !== '' && to !== '') pairs.push({ from, to })
  }
  return pairs
}

async function patchSettings(partial) {
  const result = await api('/qk/config', { method: 'POST', body: JSON.stringify(partial) })
  state.settings = result.settings
  if (typeof result.revision === 'number') state.settingsRevision = result.revision
  fillSettings()
}

function buildPresets() {
  el.presets.textContent = ''
  for (const preset of state.presets) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = preset.label
    button.addEventListener('click', () => {
      const data = panes.ask
      if (data.source.trim() === '') {
        data.meta = '先在来源框里放点内容，再用这个动作'
        render('ask')
        return
      }
      el.question.value = preset.question
      void runAsk()
    })
    el.presets.append(button)
  }
}

async function boot() {
  const ticket = new URLSearchParams(location.search).get('t') || ''
  try {
    const session = await api('/qk/session', { method: 'POST', body: JSON.stringify({ ticket }) })
    state.token = session.token
    state.settings = session.settings
    state.presets = session.presets || []
    state.revision = session.revision
    state.settingsRevision = session.settingsRevision ?? 0
    fillSettings()
    buildPresets()
    setMode('translate')
    await refreshFeed()
    if (session.latest) loadPick(session.latest)
    state.polling = setInterval(poll, 700)
  } catch (error) {
    const data = panes.translate
    data.error = true
    data.output = `⚠ 打开失败：${error.message || error}\n再按一次热键即可重新打开。`
    render('translate')
  }
}

for (const mode of ['translate', 'ask']) {
  const view = nodes(mode)
  view.source.addEventListener('input', () => {
    panes[mode].source = view.source.value
    panes[mode].dirty = true
  })
  view.source.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      setMode(mode)
      runCurrent()
    }
  })
  view.copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(panes[mode].output || panes[mode].source || '')
  })
  view.star.addEventListener('click', () => {
    setMode(mode)
    void starCurrent()
  })
  view.speak.addEventListener('click', () => speak(panes[mode].output || panes[mode].source))
  view.expand.addEventListener('click', () => {
    setMode('ask')
    void runAsk({ detailed: true })
  })
  view.clear.addEventListener('click', () => clearPane(mode))
  if (view.shotOcr) {
    view.shotOcr.addEventListener('click', () => {
      setMode(mode)
      void runOcr(mode)
    })
  }
  if (view.shotSend) {
    view.shotSend.addEventListener('click', () => {
      setMode('ask')
      const askPane = panes.ask
      if (askPane.imageId !== panes[mode].imageId) {
        askPane.imageId = panes[mode].imageId
        askPane.source = panes[mode].source
        askPane.origin = panes[mode].origin
      }
      void runAsk()
    })
  }
}

el.mode.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]')
  if (button) setMode(button.dataset.mode, { keepFocus: true })
})

el.run.addEventListener('click', () => runCurrent())

el.question.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    runCurrent()
  }
})

el.pin.addEventListener('click', () => {
  void patchSettings({ pinned: !state.settings.pinned })
})

document.getElementById('web').addEventListener('click', (event) => {
  state.forceSearch = !state.forceSearch
  event.currentTarget.classList.toggle('on', state.forceSearch)
  const data = panes.ask
  data.meta = state.forceSearch ? '下次提问会强制联网' : '联网：自动判断'
  render('ask')
})

document.getElementById('clear-history').addEventListener('click', async () => {
  try {
    await api('/qk/history', { method: 'POST', body: JSON.stringify({ clear: true }) })
    state.history = []
    renderFeed()
  } catch (error) {
    el.shell.textContent = `清空失败：${error.message || error}`
  }
})

document.getElementById('export-words').addEventListener('click', () => {
  const link = document.createElement('a')
  link.href = `/qk/favorites/export?t=${encodeURIComponent(state.token)}`
  link.download = 'quicklook-words.md'
  link.click()
})

el.more.addEventListener('click', async () => {
  el.drawer.hidden = false
  try {
    const result = await api('/qk/config')
    state.settings = result.settings
    fillSettings()
    el.shell.textContent = `${result.shell.state}${result.shell.stderr ? ' · ' + result.shell.stderr.slice(0, 60) : ''}`
  } catch (error) {
    el.shell.textContent = String(error.message || error)
  }
  if (state.models.length === 0) {
    try {
      const models = await api('/qk/models')
      state.models = models.providers || []
      fillModelSelect(el.modelTranslate, state.settings.model?.translate)
      fillModelSelect(el.modelAsk, state.settings.model?.ask)
    } catch {
      // The model list is optional; the select still offers "follow default".
    }
  }
})

document.getElementById('close-drawer').addEventListener('click', () => {
  el.drawer.hidden = true
  el.drawer.dataset.recording = ''
})

el.hkTranslate.addEventListener('focus', () => recordHotkey(el.hkTranslate, 'translate'))
el.hkAsk.addEventListener('focus', () => recordHotkey(el.hkAsk, 'ask'))
el.normalize.addEventListener('change', () => void patchSettings({ normalize: el.normalize.value }))
el.budget.addEventListener('change', () => void patchSettings({ budget: el.budget.value === '1' }))
el.target.addEventListener('change', () => void patchSettings({ direction: el.target.value }))

const patchWindow = () => {
  const width = Number(el.winWidth.value) || 256
  const height = Number(el.winHeight.value) || 300
  void patchSettings({ window: { width, height } })
}
el.winWidth.addEventListener('change', patchWindow)
el.winHeight.addEventListener('change', patchWindow)

el.modelTranslate.addEventListener('change', () => {
  const [provider, model] = el.modelTranslate.value.split('||')
  void patchSettings({ model: { ...state.settings.model, translate: provider && model ? { provider, model } : null } })
})
el.modelAsk.addEventListener('change', () => {
  const [provider, model] = el.modelAsk.value.split('||')
  void patchSettings({ model: { ...state.settings.model, ask: provider && model ? { provider, model } : null } })
})
el.loadModels.addEventListener('click', async () => {
  el.loadModels.textContent = '加载中…'
  try {
    const result = await api('/qk/models')
    state.models = result.providers || []
    fillModelSelect(el.modelTranslate, state.settings.model?.translate)
    fillModelSelect(el.modelAsk, state.settings.model?.ask)
    el.loadModels.textContent = `已加载 ${state.models.length} 个服务商`
  } catch (error) {
    el.loadModels.textContent = `加载失败：${error.message || error}`
  }
})
el.searchMode.addEventListener('change', () => void patchSettings({ searchMode: el.searchMode.value }))
el.dictCard.addEventListener('change', () => void patchSettings({ dictCard: el.dictCard.checked }))
el.includeSource.addEventListener('change', () => void patchSettings({ includeSource: el.includeSource.checked }))
document.getElementById('save-glossary').addEventListener('click', async () => {
  try {
    await patchSettings({ glossary: readGlossary() })
    el.shell.textContent = `术语表已保存（${readGlossary().length} 条）`
  } catch (error) {
    el.shell.textContent = `保存失败：${error.message || error}`
  }
})

void boot()