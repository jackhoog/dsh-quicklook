/** Prompt construction and response post-processing. No I/O. */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g

/** Preset actions shown as chips in conversation mode. */
export const ASK_PRESETS = Object.freeze([
  { id: 'explain', label: '解释', question: '用最少的字解释这段内容说的是什么。' },
  { id: 'summarize', label: '总结', question: '用一句话总结，再给不超过 3 条要点。' },
  { id: 'polish', label: '润色', question: '润色这段文字，只输出改写后的文本。' },
  { id: 'code', label: '代码解释', question: '这段代码做什么？指出任何明显的缺陷。' },
])

/**
 * Decide the target language from the text itself.
 * @param text - source text.
 * @param preference - `auto` or an explicit language label.
 * @returns a label used inside the prompt.
 */
export function resolveTargetLanguage(text, preference = 'auto') {
  if (preference && preference !== 'auto') return preference
  const cjk = (text.match(CJK) ?? []).length
  const letters = (text.match(/[A-Za-z]/g) ?? []).length
  if (cjk === 0 && letters === 0) return '中文'
  return cjk / Math.max(1, cjk + letters) > 0.2 ? 'English' : '中文'
}

/**
 * Is the selection exactly one word (no spaces, no sentence punctuation)?
 * @param text - normalized text.
 * @returns true when the dictionary card applies.
 */
export function isSingleWord(text) {
  const value = String(text ?? '').trim()
  if (value === '' || value.length > 40) return false
  if (/[\s.!?;。！？；,，、]/.test(value)) return false
  return true
}

/**
 * Is the selection a single word or a very short phrase?
 * @param text - normalized text.
 * @returns true for dictionary-style output sizing.
 */
export function isWordForm(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 40) return false
  if (/[.!?;。！？；]/.test(trimmed)) return false
  return trimmed.split(/\s+/).length <= 3
}

/**
 * Build the system prompt for translation.
 * @param options.target - target language label.
 * @param options.glossary - `from => to` pairs applied as hard constraints.
 * @param options.source - where the text came from, such as a window title.
 * @returns the system prompt.
 */
export function buildTranslateSystem({ target, glossary = [], source = '' }) {
  const rules = [
    '你是翻译引擎。只输出译文本身，不要解释、不要总结、不要加注、不要复述原文、不要加"译文："前缀。',
    `目标语言：${target}。`,
    '规则：',
    '1. 保留原文的段落、列表、代码块结构。',
    '2. 专有名词、缩写、公式、变量名、函数名不译。',
    '3. 原文已是目标语言时，原样返回。',
    '4. 不要输出任何括号注释，例如"（意为……）"。',
  ]
  if (glossary.length > 0) {
    rules.push('5. 必须遵守以下术语表（左为原文，右为译法）：')
    for (const pair of glossary) rules.push(`   - ${pair.from} => ${pair.to}`)
  }
  if (source) rules.push(`来源：${source}`)
  return rules.join('\n')
}

/**
 * Build the system prompt for conversation mode.
 * @param options.budget - when true, apply the length budget.
 * @param options.searched - when true, reference material was retrieved for this question.
 * @returns the system prompt.
 */
export function buildAskSystem({ budget = true, searched = false, selectionIsQuestion = false, focus = 'selection' } = {}) {
  const lines = ['你是一个贴着文本出现的助手。']
  if (focus === 'question') {
    lines.push(
      '只回答下面的「问题」。选中文本只是可能相关的背景资料：',
      '如果它与问题无关，直接忽略它，不要解释它、不要以它为主题作答。',
      '不要分析这条问题是什么类型、不要复述问题、不要说明你的思路。',
    )
  } else {
    lines.push(
      '直接回答问题本身：不要分析这条问题是什么类型、不要复述问题、不要说明你的思路或意图。',
    )
    if (selectionIsQuestion) {
      lines.push(
        '选中文本本身就是一个问题或检索请求。请把它当作要回答的问题：直接给出答案，',
        '不要分析这句话的字面构成、不要推测它从哪里复制来、不要评论它是否需要核实。',
      )
    } else {
      lines.push('选中文本是要讨论的材料，问题针对它提问。')
    }
  }
  if (searched) {
    lines.push('下面附有刚检索到的资料。以资料为准作答，要点末尾用 [序号] 标注来源；资料没覆盖的部分直接说没找到，不要编。')
    lines.push('若资料之间互相矛盾，给出最新的或出现最多的说法并注明存在分歧，不要逐条罗列所有数值。')
  } else {
    lines.push('如果这个问题需要最新资料而你无法确认，就直接说明不知道，不要编造。')
  }
  if (budget) {
    lines.push(
      '【输出预算】先给一句结论（不超过 60 字），再给 3~5 条要点（每条不超过 50 字，可带数据）。',
      '不要写"首先/其次/总之"，不铺垫背景，不列超过 5 条。',
    )
  } else {
    lines.push('回答要完整：可以分小节，每段只讲一件事，避免空话。')
  }
  return lines.join('\n')
}

/**
 * Is this one of the preset action questions (which are about the selection)?
 * @param question - the question text.
 * @returns true for a preset prompt.
 */
export function isPresetQuestion(question) {
  const value = String(question ?? '').trim()
  return ASK_PRESETS.some((preset) => preset.question === value)
}

/**
 * Does this text read as a question or a search request rather than as material?
 * @param text - the selected or pasted text.
 * @returns true when the plugin should answer it instead of explaining it.
 */
export function looksLikeQuestion(text) {
  const value = String(text ?? '').trim()
  if (value === '' || value.length > 160) return false
  if (/[?？]\s*$/.test(value)) return true
  return /(是什么|什么是|介绍一下|介绍下|查一下|查找|搜一下|搜索|最新|如何|怎么|为什么|多少|是谁|在哪|有哪些|对比|价格|新闻|了解一下)/.test(value)
}

/**
 * Does the answer talk about the input instead of answering it?
 * @param text - model output.
 * @returns true when a corrective retry is worthwhile.
 */
export function looksLikeMetaAnswer(text) {
  const value = String(text ?? '')
  if (value.length > 400) return false
  return /(这段文本|这句话|这句|这是一条|这个名称|待发出的提问|用户指令|无法确认它是真实存在|我不为它编造)/.test(value)
}

/** Build the user message for one question about a selection. */
export function buildAskUser({ text, question, source = '', search = '', questionFirst = false }) {
  const parts = []
  if (source) parts.push(`来源：${source}`)
  if (questionFirst) {
    // A typed question outranks a leftover selection, so it goes first and the
    // selection is explicitly labelled as ignorable background.
    parts.push(`问题：${question}`)
    if (search) parts.push(`检索资料：\n${search}`)
    if (text) parts.push(`背景文本（可能与问题无关，无关就忽略）：\n"""\n${text}\n"""`)
  } else {
    if (text) parts.push(`选中文本：\n"""\n${text}\n"""`)
    if (search) parts.push(`检索资料：\n${search}`)
    parts.push(`问题：${question}`)
  }
  return parts.join('\n\n')
}

/**
 * Build the system prompt for reading text out of a screenshot.
 * @returns the system prompt.
 */
export function buildOcrSystem() {
  return [
    '只输出图中出现的文字，按原始阅读顺序与换行输出。',
    '不要翻译、不要解释、不要描述版面、不要补充图中没有的内容。',
    '表格用制表符分隔；无法辨认的字符输出 □。',
    '图中没有文字时，只输出：NO_TEXT',
  ].join('\n')
}

/**
 * Resolve the concrete target language from the configured direction.
 * @param direction - auto | zh2en | en2zh | to-zh.
 * @param text - source text.
 * @returns a language label used inside prompts.
 */
export function targetForDirection(direction, text) {
  if (direction === 'zh2en') return 'English'
  if (direction === 'en2zh' || direction === 'to-zh') return '中文'
  return resolveTargetLanguage(text, 'auto')
}

/**
 * System prompt for the dictionary card used on single words.
 * @param target - language of the senses and example translations.
 * @returns the system prompt.
 */
export function buildDictSystem(target) {
  return [
    '你是词典。只输出一个 JSON 对象：不要解释、不要 Markdown 围栏、不要任何多余文字。',
    `释义与例句译文使用${target}。`,
    '格式：{"word":"原词","phonetic":"/ˈfəʊnɪm/","pos":[{"tag":"n.","senses":["释义1","释义2"]}],"examples":[{"en":"含该词的例句","zh":"例句译文"}]}',
    '要求：音标用国际音标并带斜杠；最多 3 个词性，每个词性最多 3 条释义；例句 1~2 条且必须原样包含该词；词性用 n./v./adj./adv./prep./conj./pron. 等简写。',
  ].join('\n')
}

/**
 * Parse the dictionary JSON a model returned, tolerating fences and stray prose.
 * @param text - raw model output.
 * @returns the parsed card, or null when the output is not usable.
 */
export function parseDictJson(text) {
  const raw = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(raw.slice(start, end + 1))
    if (typeof value !== 'object' || value === null) return null
    const word = typeof value.word === 'string' ? value.word : ''
    if (word === '') return null
    const pos = Array.isArray(value.pos)
      ? value.pos
        .filter((entry) => entry && typeof entry.tag === 'string' && Array.isArray(entry.senses))
        .map((entry) => ({ tag: entry.tag, senses: entry.senses.filter((s) => typeof s === 'string').slice(0, 3) }))
        .slice(0, 3)
      : []
    const examples = Array.isArray(value.examples)
      ? value.examples
        .filter((entry) => entry && typeof entry.en === 'string')
        .map((entry) => ({ en: entry.en, zh: typeof entry.zh === 'string' ? entry.zh : '' }))
        .slice(0, 2)
      : []
    if (pos.length === 0 && examples.length === 0) return null
    return { word, phonetic: typeof value.phonetic === 'string' ? value.phonetic : '', pos, examples }
  } catch {
    return null
  }
}

/**
 * Render a dictionary card as plain text, for clipboard and history.
 * @param dict - parsed card.
 * @returns a copyable multi-line string.
 */
export function formatDictCard(dict) {
  const lines = [dict.phonetic ? `${dict.word}  ${dict.phonetic}` : dict.word]
  for (const entry of dict.pos) lines.push(`${entry.tag} ${entry.senses.join('；')}`)
  for (const example of dict.examples) {
    lines.push(`${example.en}${example.zh ? `\n  ${example.zh}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Remove explanatory glosses a model adds despite the instruction.
 * Deliberately conservative: only obvious forms are stripped.
 * @param text - raw model output.
 * @returns text without trailing notes.
 */
export function stripGloss(text) {
  let out = String(text ?? '')
  out = out.replace(/[（(]\s*(?:意为|意思是|即|也就是|meaning|i\.e\.|lit\.)[^）)]{0,80}[）)]/gi, '')
  out = out
    .split('\n')
    .filter((line) => !/^\s*(?:注[:：]|说明[:：]|Notes?:|TL;DR:)/i.test(line))
    .join('\n')
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Drop a code fence the model added around code the user did not fence.
 * @param text - model output.
 * @param source - the text that was sent.
 * @returns text without the added fence.
 */
export function unwrapFence(text, source) {
  if (String(source ?? '').includes('```')) return text
  const match = String(text ?? '').match(/^```[^\n]*\n([\s\S]*?)\n```$/)
  return match ? match[1] : text
}