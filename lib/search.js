/** Web search bridge: turn a question into model-ready reference text. */

/**
 * Should this question be answered from fresh web results?
 * @param question - what the user typed.
 * @param hasSelection - whether text was selected.
 * @returns true when searching is likely useful.
 */
export function wantsSearch(question, hasSelection) {
  if (!hasSelection) return true
  return /查|搜|找|资料|信息|最新|新闻|价格|版本|是谁|是什么|介绍|情况|对比|推荐|如何|怎么|为什么|多少|天气|气温|温度|汇率|日程|日程|赛程|why|what|who|when|where|news|latest|price|weather|compare/i
    .test(String(question ?? ''))
}

/**
 * Run one search and format the results for the prompt.
 * @param ctx - host plugin context.
 * @param query - the user's question.
 * @param signal - caller cancellation.
 * @returns formatted reference text, or null when search is unavailable.
 */
export async function searchContext(ctx, query, signal) {
  const web = ctx.get('web')
  if (!web) return null
  try {
    const result = await web.search({ query: String(query).slice(0, 400), maxResults: 6 }, signal)
    const lines = []
    if (result.content && result.content.trim() !== '') {
      lines.push(result.content.trim().slice(0, 3000))
    }
    result.sources.slice(0, 6).forEach((source, index) => {
      const title = source.title ?? ''
      lines.push(`[${index + 1}] ${title} ${source.url}`)
      const detail = source.summary ?? source.snippet ?? ''
      if (detail) lines.push(`    ${detail.replace(/\s+/g, ' ').slice(0, 300)}`)
    })
    if (lines.length === 0) return null
    return lines.join('\n')
  } catch {
    return null
  }
}