/** One-shot model calls that do not belong to any session. */

/**
 * Resolve the services and the model route for one purpose.
 * @param ctx - host plugin context.
 * @param settings - current plugin settings; a per-purpose override wins over the DSH default.
 * @param purpose - `translate` or `ask`.
 * @returns the llm service plus the concrete route.
 */
export function resolveModel(ctx, settings, purpose = 'ask') {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('llm 服务不可用：当前 profile 没有加载模型服务')
  const override = settings?.model?.[purpose]
  const selector = ctx.get('agentDefaultModel')
  const selection = selector?.currentSelection?.()
  if (override && override.provider && override.model) {
    return { llm, provider: override.provider, model: override.model, reasoningEffort: undefined, overridden: true }
  }
  if (!selection || !selection.provider || !selection.model) {
    throw new Error('没有可用的默认模型，请先在 DSH 里选择模型')
  }
  return { llm, provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort, overridden: false }
}

/**
 * Ask the adapter whether the default route accepts images.
 * @param ctx - host plugin context.
 * @returns true/false, or null when the adapter cannot answer.
 */
export async function supportsImages(ctx, settings, purpose = 'ask') {
  try {
    const { llm, provider, model } = resolveModel(ctx, settings, purpose)
    const info = await llm.resolveModelInfo(provider, model)
    const modalities = info?.inputModalities
    if (!Array.isArray(modalities)) return null
    return modalities.includes('image')
  } catch {
    return null
  }
}

/**
 * Stream one completion and forward text deltas to a callback.
 * @param ctx - host plugin context.
 * @param request.system - system prompt.
 * @param request.user - the single user message.
 * @param request.maxTokens - hard output cap.
 * @param request.temperature - sampling temperature.
 * @param request.signal - caller cancellation.
 * @param onDelta - receives each text delta.
 * @returns the full text plus token usage.
 */
export async function runStream(ctx, request, onDelta) {
  const { llm, provider, model, reasoningEffort } = resolveModel(ctx, request.settings, request.purpose ?? 'ask')
  const content = []
  for (const image of request.images ?? []) content.push({ type: 'image', attachment: image })
  if (request.user) content.push({ type: 'text', text: request.user })
  const options = {
    provider,
    model,
    messages: [{ role: 'user', content }],
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    signal: request.signal,
  }
  if (request.system) options.system = request.system
  if (reasoningEffort) options.reasoningEffort = reasoningEffort

  let text = ''
  let usage = null
  let truncated = false
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      onDelta?.(chunk.text)
      continue
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
      if (kind === 'aborted') throw Object.assign(new Error('已取消'), { cancelled: true })
      if (kind === 'max-tokens') truncated = true
      if (chunk.usage) usage = chunk.usage
    }
  }
  return { text, usage, provider, model, truncated }
}