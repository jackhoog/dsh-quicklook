/** HTTP surface shared by the shell and the popup window. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { normalize, segment } from './normalize.js'
import { resolveModel, runStream, supportsImages } from './model.js'
import {
  ASK_PRESETS, buildAskSystem, buildAskUser, buildDictSystem, buildOcrSystem, buildTranslateSystem,
  formatDictCard, isSingleWord, isWordForm, isPresetQuestion, looksLikeMetaAnswer, looksLikeQuestion, parseDictJson,
  resolveTargetLanguage, stripGloss, targetForDirection, unwrapFence,
} from './prompts.js'
import { searchContext, wantsSearch } from './search.js'
import { Tasks } from './tasks.js'

const UI = (name) => fileURLToPath(new URL(`../ui/${name}`, import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}
const TICKET_TTL_MS = 120_000
const BODY_LIMIT = 8 * 1024 * 1024

/** Read and parse a JSON body with a hard size cap. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response. */
function send(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Write one static file. */
async function sendFile(res, file) {
  try {
    const body = await fs.readFile(file)
    const extension = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, {
      'content-type': MIME[extension] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    send(res, 404, { error: '找不到资源' })
  }
}

/** Stream newline-delimited JSON events to the popup. */
function streamNdjson(res, producer) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  const write = (value) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(value)}\n`)
  }
  producer(write)
    .catch((error) => write({ error: String(error?.message ?? error) }))
    .finally(() => {
      if (!res.writableEnded) res.end()
    })
}

/**
 * Build every route this plugin owns.
 * @param ctx - host plugin context.
 * @param deps.store - settings and latest pick.
 * @param deps.tasks - cancellation and cache.
 * @param deps.shell - shell lifecycle.
 * @param deps.tokens - master token plus the live session token set.
 * @returns route descriptors for `webServer.register`.
 */
export function createRoutes(ctx, deps) {
  const { store, tasks, shell, tokens, images } = deps
  const tickets = new Map()
  const modelsCache = { value: null, at: 0 }

  /** Query parameters of this request; DSH handlers receive no URL argument. */
  const params = (req) => new URL(req.url ?? '/', 'http://localhost').searchParams

  const authorize = (req) => {
    const header = req.headers['x-qk-token']
    const token = typeof header === 'string' && header !== '' ? header : (params(req).get('t') ?? '')
    return token === tokens.master || tokens.sessions.has(token)
  }

  const mintTicket = () => {
    const ticket = randomUUID()
    tickets.set(ticket, Date.now() + TICKET_TTL_MS)
    // Drop expired tickets so the map cannot grow without bound.
    for (const [key, expiry] of tickets) {
      if (expiry < Date.now()) tickets.delete(key)
    }
    return ticket
  }

  const validTicket = (ticket) => {
    const expiry = tickets.get(ticket)
    return typeof expiry === 'number' && expiry > Date.now()
  }

  /**
   * Run a model call and stream its deltas.
   * @returns the accumulated raw text.
   */
  const streamModel = async (write, signal, request) => {
    let text = ''
    await runStream(ctx, { settings: store.settings, purpose: 'translate', ...request, signal }, (delta) => {
      text += delta
      write({ delta })
    })
    return text
  }

  const translate = (res, body) => {
    streamNdjson(res, async (write) => {
      const settings = store.settings
      const normalized = normalize(String(body.text ?? ''), { mode: body.normalizeMode ?? settings.normalize })
      if (normalized.text === '') {
        write({ error: '没有可翻译的文本' })
        return
      }
      const target = targetForDirection(body.direction ?? settings.direction ?? 'auto', normalized.text)
      const route = resolveModel(ctx, settings, 'translate')
      const cacheKey = Tasks.key([
        'translate', normalized.text, target, settings.budget ? '1' : '0',
        route.provider, route.model, JSON.stringify(settings.glossary),
      ])
      const cached = tasks.get(cacheKey)
      if (cached !== undefined) {
        const value = typeof cached === 'string' ? { final: cached } : cached
        write({ ...value, cached: true, shape: normalized.shape, stats: normalized.stats })
        return
      }

      const slot = `translate:${body.cardId ?? 'single'}`
      const signal = tasks.begin(slot)
      res.on('close', () => tasks.cancel(slot))
      const word = isSingleWord(normalized.text)
      const wantDict = word && (body.dict ?? settings.dictCard) !== false

      if (wantDict) {
        const raw = await streamModel(write, signal, {
          system: buildDictSystem(target),
          user: normalized.text,
          maxTokens: 600,
          temperature: 0.2,
        })
        const dict = parseDictJson(raw)
        if (dict !== null) {
          const plain = formatDictCard(dict)
          tasks.set(cacheKey, { final: plain, dict })
          let dictHistoryId = ''
          try {
            dictHistoryId = store.addHistory({
              action: 'translate',
              title: body.source,
              text: normalized.text,
              result: plain,
              shape: 'word',
              dict,
            }).id
          } catch {
            // History is a convenience; never fail the request over it.
          }
          write({ final: plain, dict, shape: 'word', stats: normalized.stats, historyId: dictHistoryId, cached: false })
          tasks.end(slot)
          return
        }
        // The model ignored the JSON contract; clear the partial output and translate plainly.
        write({ reset: true })
      }

      const pieces = segment(normalized.text, settings.maxTextChars)
      const system = buildTranslateSystem({
        target,
        glossary: settings.glossary,
        source: settings.includeSource === false ? '' : String(body.source ?? '').slice(0, 200),
      })

      let accumulated = ''
      try {
        for (let index = 0; index < pieces.length; index += 1) {
          const raw = await streamModel(write, signal, {
            system,
            user: pieces[index],
            maxTokens: word ? 120 : 800,
            temperature: 0.2,
          })
          accumulated += raw
          if (index < pieces.length - 1) {
            accumulated += '\n\n'
            write({ delta: '\n\n' })
          }
        }
        const final = unwrapFence(stripGloss(accumulated), normalized.text)
        if (final === '') {
          write({ error: '模型这次没有返回译文，请再试一次。' })
          return
        }
        tasks.set(cacheKey, final)
        let historyId = ''
        try {
          historyId = store.addHistory({
            action: 'translate',
            title: body.source,
            text: normalized.text,
            result: final,
            shape: normalized.shape,
          }).id
        } catch {
          // History is a convenience; never fail the request over it.
        }
        write({
          final,
          cached: false,
          shape: normalized.shape,
          stats: normalized.stats,
          words: pieces.length,
          historyId,
        })
      } finally {
        tasks.end(slot)
      }
    })
  }

  const ask = (res, body) => {
    streamNdjson(res, async (write) => {
      const settings = store.settings
      const normalized = normalize(String(body.text ?? ''), { mode: body.normalizeMode ?? settings.normalize })
      const question = String(body.question ?? '').trim() || '解释这段内容。'
      const budget = body.budget ?? settings.budget
      const captured = body.imageId ? images.get(String(body.imageId)) : undefined
      if (captured !== undefined && (await supportsImages(ctx)) === false) {
        write({ error: '当前默认模型不支持图片输入，请切到视觉模型，或先用「转文字」。' })
        return
      }
      const slot = `ask:${body.cardId ?? 'single'}`
      const signal = tasks.begin(slot)
      res.on('close', () => tasks.cancel(slot))
      try {
        const selectionText = normalized.text.trim()
        const selectionIsQuestion = looksLikeQuestion(selectionText)
        // A typed question outranks a leftover selection (e.g. clipboard text from earlier).
        const typed = question !== '解释这段内容。' && !isPresetQuestion(question)
        const focus = typed ? 'question' : 'selection'
        const autoSearch = typed
          ? wantsSearch(question, selectionText !== '')
          : (selectionText === '' || selectionIsQuestion || wantsSearch(question, selectionText !== ''))
        const doSearch = body.search === false ? false : (body.search === true ? true : autoSearch)
        // The settings page can force "never search" or "always search" globally.
        const searchMode = settings.searchMode ?? 'auto'
        const searchEnabled = body.search === undefined && searchMode !== 'auto'
          ? searchMode === 'on'
          : doSearch
        // Search what the user actually asked, not a stale selection.
        const query = typed
          ? question
          : (selectionIsQuestion && selectionText !== '' ? selectionText : question)

        const runOnce = async (withSearch) => {
          let searchText = ''
          let searched = false
          if (withSearch) {
            write({ phase: 'searching' })
            const found = await searchContext(ctx, query, signal)
            if (found !== null) {
              searchText = found
              searched = true
            }
          }
          let pendingText = ''
          const text = await runStream(ctx, {
            settings,
            purpose: 'ask',
            system: buildAskSystem({ budget, searched, selectionIsQuestion, focus }),
            user: buildAskUser({
              text: normalized.text,
              question,
              source: settings.includeSource === false ? '' : String(body.source ?? '').slice(0, 200),
              search: searchText,
              questionFirst: focus === 'question',
            }),
            images: captured ? [captured.ref] : undefined,
            maxTokens: budget ? 650 : 1100,
            temperature: 0.6,
            signal,
          }, (delta) => {
            pendingText += delta
            write({ delta })
          })
          return { text: pendingText, searched, truncated: text.truncated }
        }

        let attempt = await runOnce(searchEnabled)
        let final = attempt.text.trim()
        let searched = attempt.searched
        let truncated = attempt.truncated === true
        // The model answered about the input instead of answering it: retry once with web material.
        if (!searched && looksLikeMetaAnswer(final)) {
          write({ reset: true })
          attempt = await runOnce(true)
          final = attempt.text.trim()
          searched = attempt.searched
          truncated = attempt.truncated === true
        }
        if (final === '') {
          write({ error: '模型这次没有返回内容，请再试一次或换个问法。' })
          return
        }
        if (truncated) {
          final += budget
            ? '\n\n（已到长度上限，点「展开详细」看完整版）'
            : '\n\n（已到长度上限）'
        }
        let historyId = ''
        try {
          historyId = store.addHistory({
            action: 'ask',
            title: body.source,
            text: normalized.text,
            result: final,
            shape: normalized.shape,
          }).id
        } catch {
          // History is a convenience; never fail the request over it.
        }
        write({ final, shape: normalized.shape, stats: normalized.stats, historyId, searched, truncated })
      } finally {
        tasks.end(slot)
      }
    })
  }

  return [
    {
      kind: 'exact',
      path: '/qk/health',
      handler: (req, res) => send(res, 200, {
        ok: true,
        version: '0.9.3',
        shell: shell.status,
        revision: store.revision,
      }),
    },
    {
      kind: 'exact',
      path: '/qk/app.css',
      handler: (req, res) => sendFile(res, UI('popup.css')),
    },
    {
      kind: 'exact',
      path: '/qk/app.js',
      handler: (req, res) => sendFile(res, UI('popup.js')),
    },
    {
      kind: 'exact',
      path: '/qk/popup',
      handler: async (req, res) => {
        // A stable URL lets Edge reuse one app window instead of opening a new one.
        await sendFile(res, UI('popup.html'))
      },
    },
    {
      kind: 'exact',
      path: '/qk/session',
      handler: async (req, res) => {
        const body = await readJson(req)
        const ticket = String(body.ticket ?? '')
        const origin = ctx.webServer.getOrigin()
        const sameOrigin = req.headers.origin === origin || req.headers.origin === undefined
        if (ticket !== '' ? !validTicket(ticket) : !sameOrigin) {
          send(res, 401, { error: '未授权：请从划词小窗打开' })
          return
        }
        if (ticket !== '') tickets.delete(ticket)
        const token = randomUUID()
        tokens.sessions.add(token)
        if (tokens.sessions.size > 32) {
          const oldest = tokens.sessions.values().next().value
          tokens.sessions.delete(oldest)
        }
        send(res, 200, {
          token,
          settings: store.settings,
          revision: store.revision,
          settingsRevision: store.settingsRevision,
          latest: store.latest,
          presets: ASK_PRESETS,
        })
      },
    },
    {
      kind: 'exact',
      path: '/qk/latest',
      handler: (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const after = Number(params(req).get('after') ?? '0')
        const latest = store.latest
        if (latest === null || latest.revision <= after) {
          return send(res, 200, { revision: store.revision, pick: null, settingsRevision: store.settingsRevision })
        }
        return send(res, 200, { revision: latest.revision, pick: latest, settingsRevision: store.settingsRevision })
      },
    },
    {
      kind: 'exact',
      path: '/qk/pick',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const body = await readJson(req)
        const text = String(body.text ?? '')
        const notice = String(body.notice ?? '')
        if (text.trim() === '' && notice === '') return send(res, 200, { revision: store.revision, ignored: true })
        const pick = store.setLatest({
          text,
          title: String(body.title ?? '').slice(0, 300),
          action: body.action === 'ask' ? 'ask' : 'translate',
          notice,
        })
        const origin = ctx.webServer.getOrigin()
        const popupUrl = `${origin}/qk/popup`
        return send(res, 200, { revision: pick.revision, url: popupUrl })
      },
    },
    {
      kind: 'exact',
      path: '/qk/translate',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        translate(res, await readJson(req))
      },
    },
    {
      kind: 'exact',
      path: '/qk/ask',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        ask(res, await readJson(req))
      },
    },
    {
      kind: 'exact',
      path: '/qk/models',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const llm = ctx.get('llm')
        if (!llm) return send(res, 501, { error: '当前 profile 没有模型服务' })
        const now = Date.now()
        if (modelsCache.value !== null && now - modelsCache.at < 10 * 60_000) {
          return send(res, 200, modelsCache.value)
        }
        const providers = []
        let listed = []
        try {
          listed = llm.listProviders() ?? []
        } catch {
          listed = []
        }
        for (const provider of listed) {
          let models = []
          try {
            models = await llm.listModels(provider.id)
          } catch {
            models = []
          }
          providers.push({
            id: provider.id,
            name: provider.name ?? provider.id,
            models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
          })
        }
        const fallback = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
        const value = { providers, fallback, cachedAt: now }
        modelsCache.value = value
        modelsCache.at = now
        return send(res, 200, value)
      },
    },
    {
      kind: 'exact',
      path: '/qk/config',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        if (req.method === 'GET') {
          return send(res, 200, { settings: store.settings, revision: store.settingsRevision, shell: shell.status })
        }
        const body = await readJson(req)
        const before = store.settings
        const settings = store.patch(body)
        if (body.glossary !== undefined) tasks.clearCache()
        const hotkeysChanged = JSON.stringify(before.hotkeys) !== JSON.stringify(settings.hotkeys)
        const windowChanged = JSON.stringify(before.window) !== JSON.stringify(settings.window)
        if (hotkeysChanged || windowChanged) {
          await shell.restart(ctx.webServer.getOrigin())
        }
        return send(res, 200, {
          settings,
          shell: shell.status,
          hotkeysChanged,
          windowChanged,
          revision: store.settingsRevision,
        })
      },
    },
    {
      kind: 'exact',
      path: '/qk/capture',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const body = await readJson(req)
        const base64 = String(body.pngBase64 ?? '')
        if (base64 === '') return send(res, 400, { error: '没有图片数据' })
        const attachments = ctx.get('attachments')
        if (!attachments) return send(res, 501, { error: '当前 profile 没有图片服务，截图功能不可用' })
        let reference
        try {
          const data = Buffer.from(base64, 'base64')
          if (data.length === 0) return send(res, 400, { error: '图片为空' })
          reference = await attachments.saveImage({
            data: new Uint8Array(data),
            mediaType: 'image/png',
            name: 'quicklook.png',
          })
        } catch (error) {
          return send(res, 400, { error: `图片无法保存：${error?.message ?? error}` })
        }
        images.add(reference, { title: String(body.title ?? '').slice(0, 300) })
        const ocrText = String(body.ocrText ?? '').slice(0, 20000)
        const pick = store.setLatest({
          kind: 'image',
          imageId: reference.attachmentId,
          text: ocrText,
          ocrText,
          title: String(body.title ?? '').slice(0, 300),
          action: body.action === 'ask' ? 'ask' : 'translate',
          notice: '',
        })
        const origin = ctx.webServer.getOrigin()
        return send(res, 200, {
          revision: pick.revision,
          url: `${origin}/qk/popup`,
          imageId: reference.attachmentId,
          width: reference.width,
          height: reference.height,
        })
      },
    },
    {
      kind: 'exact',
      path: '/qk/image',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const entry = images.get(params(req).get('id') ?? '')
        if (entry === undefined) return send(res, 404, { error: '图片已过期，请重新截图' })
        const attachments = ctx.get('attachments')
        try {
          const stored = await attachments.readImage(entry.ref)
          res.writeHead(200, {
            'content-type': entry.ref.mediaType,
            'content-length': stored.data.length,
            'cache-control': 'no-store',
          })
          res.end(Buffer.from(stored.data))
        } catch (error) {
          send(res, 500, { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/qk/ocr',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const body = await readJson(req)
        const entry = images.get(String(body.imageId ?? ''))
        if (entry === undefined) return send(res, 404, { error: '图片已过期，请重新截图' })
        streamNdjson(res, async (write) => {
          const settings = store.settings
          const vision = await supportsImages(ctx)
          if (vision === false) {
            write({ error: '当前默认模型不支持图片输入，请在 DSH 里切到视觉模型后再试；也可以直接粘贴文字。' })
            return
          }
          const slot = `ocr:${body.cardId ?? 'single'}`
          const signal = tasks.begin(slot)
          res.on('close', () => tasks.cancel(slot))
          try {
            const raw = await streamModel(write, signal, {
              system: buildOcrSystem(),
              user: '读取这张图片里的文字。',
              images: [entry.ref],
              maxTokens: 1500,
              temperature: 0,
            })
            if (raw.trim() === 'NO_TEXT') {
              write({ final: '', noText: true })
              return
            }
            const normalized = normalize(raw, { mode: settings.normalize })
            write({ final: normalized.text, raw: raw.trim(), shape: normalized.shape, stats: normalized.stats })
          } finally {
            tasks.end(slot)
          }
        })
      },
    },
    {
      kind: 'exact',
      path: '/qk/clipboard',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        if (req.method === 'POST') {
          const body = await readJson(req)
          const clipboard = store.setClipboard(String(body.text ?? ''))
          return send(res, 200, { revision: clipboard.revision })
        }
        const after = Number(params(req).get('after') ?? '0')
        const clipboard = store.clipboard
        const fresh = Number.isFinite(after) && clipboard.revision > after
        return send(res, 200, {
          revision: clipboard.revision,
          text: fresh ? clipboard.text : '',
        })
      },
    },
    {
      kind: 'exact',
      path: '/qk/window',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const body = await readJson(req)
        const width = Math.round(Number(body.width))
        const height = Math.round(Number(body.height))
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 160 || height < 120) {
          return send(res, 400, { error: '尺寸不合法' })
        }
        // The user dragged the window: record it without bouncing the shell.
        const settings = store.patch({ window: { width, height } })
        return send(res, 200, { settings })
      },
    },
    {
      kind: 'exact',
      path: '/qk/test',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        try {
          // The shell watches for this file; a stat is cheaper than polling HTTP.
          await fs.writeFile(deps.testMarker, String(Date.now()), 'utf8')
          return send(res, 200, { ok: true })
        } catch (error) {
          return send(res, 500, { error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/qk/history',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        if (req.method === 'GET') {
          const requested = Number(params(req).get('limit') ?? '20')
          const limit = Number.isFinite(requested) ? requested : 20
          return send(res, 200, { history: store.listHistory(limit) })
        }
        const body = await readJson(req)
        if (body.clear) {
          store.clearHistory()
          return send(res, 200, { history: [] })
        }
        if (typeof body.remove === 'string') {
          return send(res, 200, { history: store.removeHistory(body.remove) })
        }
        if (typeof body.starred === 'boolean' && typeof body.id === 'string') {
          return send(res, 200, store.setStarred(body.id, body.starred))
        }
        return send(res, 400, { error: '未知操作' })
      },
    },
    {
      kind: 'exact',
      path: '/qk/favorites',
      handler: async (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        if (req.method === 'GET') return send(res, 200, { favorites: store.listFavorites() })
        const body = await readJson(req)
        return send(res, 200, { favorite: store.addFavorite(body), favorites: store.listFavorites() })
      },
    },
    {
      kind: 'exact',
      path: '/qk/favorites/export',
      handler: (req, res) => {
        if (!authorize(req)) return send(res, 401, { error: '未授权' })
        const markdown = store.exportFavorites()
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="quicklook-words.md"',
        })
        res.end(markdown)
      },
    },
  ]
}