window.__ModuleLoader__.load({
  id: '@local/dsh-quicklook',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const DIRECTIONS = [
      { value: 'auto', label: '自动（中文→英文，其他→中文）' },
      { value: 'zh2en', label: '中译英' },
      { value: 'en2zh', label: '英译中' },
      { value: 'to-zh', label: '一律译成中文' },
    ]
    const SEARCH_MODES = [
      { value: 'auto', label: '自动判断' },
      { value: 'on', label: '总是联网' },
      { value: 'off', label: '不联网' },
    ]
    const PRESETS = [
      { width: 256, height: 300 },
      { width: 256, height: 341 },
      { width: 320, height: 427 },
      { width: 360, height: 480 },
    ]

    let token = ''

    async function api(path, init) {
      const headers = { 'content-type': 'application/json' }
      if (token) headers['x-qk-token'] = token
      const response = await fetch(path, { ...init, headers: { ...headers, ...(init && init.headers) } })
      const text = await response.text()
      let value
      try {
        value = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`)
      }
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }

    const rowStyle = { display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))' }
    const labelStyle = { flex: '0 0 190px', fontSize: 13, color: 'var(--dsw-alias-text-secondary, #667085)' }
    const controlStyle = { flex: 1, minWidth: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
    const inputStyle = {
      border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35))',
      borderRadius: 6,
      padding: '4px 8px',
      font: 'inherit',
      fontSize: 13,
      background: 'var(--dsw-alias-surface-raised, transparent)',
      color: 'var(--dsw-alias-text-primary, inherit)',
      minWidth: 0,
    }
    const hintStyle = { fontSize: 11, color: 'var(--dsw-alias-text-tertiary, #98a2b3)', width: '100%' }
    const sectionStyle = { marginBottom: 18 }
    const titleStyle = { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-text-secondary, #667085)', margin: '0 0 4px' }

    function Row({ label, hint, children }) {
      return h('div', { style: rowStyle },
        h('div', { style: labelStyle }, label),
        h('div', { style: controlStyle }, children, hint ? h('div', { style: hintStyle }, hint) : null))
    }

    function Button({ children, onClick, disabled, tone }) {
      return h('button', {
        type: 'button',
        disabled: Boolean(disabled),
        onClick,
        style: {
          border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,.35))',
          borderRadius: 6,
          padding: '4px 12px',
          font: 'inherit',
          fontSize: 13,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          background: tone === 'primary' ? 'var(--dsw-alias-accent-fill, #2563eb)' : 'transparent',
          color: tone === 'primary' ? '#fff' : 'inherit',
        },
      }, children)
    }

    function modelValue(entry) {
      return entry && entry.provider && entry.model ? `${entry.provider}||${entry.model}` : ''
    }

    function parseModel(value) {
      if (!value) return null
      const [provider, model] = value.split('||')
      if (!provider || !model) return null
      return { provider, model }
    }

    function QuicklookSettings() {
      const [settings, setSettings] = useState(null)
      const [models, setModels] = useState(null)
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      const [dirty, setDirty] = useState(false)

      const load = useCallback(async () => {
        try {
          const session = await api('/qk/session', { method: 'POST', body: JSON.stringify({ ticket: '' }) })
          token = session.token
          const config = await api('/qk/config')
          setSettings(config.settings)
          setStatus(`壳：${config.shell.state}`)
        } catch (error) {
          setStatus(`读取失败：${error.message || error}`)
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const update = (patch) => {
        setSettings((current) => ({ ...current, ...patch }))
        setDirty(true)
      }

      const updateWindow = (patch) => {
        setSettings((current) => ({ ...current, window: { ...current.window, ...patch } }))
        setDirty(true)
      }

      const updateHotkey = (slot, value) => {
        setSettings((current) => ({ ...current, hotkeys: { ...current.hotkeys, [slot]: value } }))
        setDirty(true)
      }

      const loadModels = async () => {
        setBusy(true)
        try {
          const result = await api('/qk/models')
          setModels(result.providers || [])
          if ((result.providers || []).length === 0) setStatus('没有可选模型（模型服务未就绪）')
        } catch (error) {
          setStatus(`模型列表读取失败：${error.message || error}`)
        } finally {
          setBusy(false)
        }
      }

      const save = async () => {
        setBusy(true)
        try {
          const payload = {
            window: settings.window,
            direction: settings.direction,
            model: settings.model,
            budget: settings.budget,
            searchMode: settings.searchMode,
            includeSource: settings.includeSource,
            dictCard: settings.dictCard,
            hotkeys: settings.hotkeys,
            shellAutoStart: settings.shellAutoStart,
            hideTitleBar: settings.hideTitleBar !== false,
            historyLimit: Number(settings.historyLimit) || 200,
          }
          const result = await api('/qk/config', { method: 'POST', body: JSON.stringify(payload) })
          setSettings(result.settings)
          setDirty(false)
          setStatus(result.windowChanged || result.hotkeysChanged ? '已保存，壳正在重启…' : '已保存')
        } catch (error) {
          setStatus(`保存失败：${error.message || error}`)
        } finally {
          setBusy(false)
        }
      }

      const clearHistory = async () => {
        try {
          await api('/qk/history', { method: 'POST', body: JSON.stringify({ clear: true }) })
          setStatus('历史已清空')
        } catch (error) {
          setStatus(`清空失败：${error.message || error}`)
        }
      }

      if (settings === null) {
        return h('div', { style: { padding: 16, fontSize: 13 } }, status || '读取中…')
      }

      const modelOptions = (current) => {
        const options = [h('option', { key: '', value: '' }, '跟随 DSH 默认')]
        for (const provider of models || []) {
          for (const model of provider.models) {
            options.push(h('option', { key: `${provider.id}||${model.id}`, value: `${provider.id}||${model.id}` },
              `${provider.name} · ${model.name}`))
          }
        }
        void current
        return options
      }

      return h('div', { style: { padding: '4px 2px 24px', fontSize: 13 } },
        h('p', { style: hintStyle }, '这里改的是同一份配置；小窗里的 ⋯ 也生效。改完点保存。'),

        h('div', { style: sectionStyle },
          h('h3', { style: titleStyle }, '窗口'),
          h(Row, { label: '尺寸', hint: '3:4 是竖版小窗；自定义宽高至少 200。' },
            h('select', {
              style: inputStyle,
              value: `${settings.window.width}x${settings.window.height}`,
              onChange: (event) => {
                const [width, height] = event.target.value.split('x').map(Number)
                updateWindow({ width, height })
              },
            }, presetOptions),
            h('input', {
              style: { ...inputStyle, width: 72 },
              type: 'number', min: 200, max: 1200, value: settings.window.width,
              onChange: (event) => updateWindow({ width: Number(event.target.value) || 256 }),
            }),
            h('span', null, '×'),
            h('input', {
              style: { ...inputStyle, width: 72 },
              type: 'number', min: 200, max: 1600, value: settings.window.height,
              onChange: (event) => updateWindow({ height: Number(event.target.value) || 341 }),
            }))),

        h('div', { style: sectionStyle },
          h('h3', { style: titleStyle }, '翻译'),
          h(Row, { label: '目标语言' },
            h('select', {
              style: inputStyle,
              value: settings.direction,
              onChange: (event) => update({ direction: event.target.value }),
            }, DIRECTIONS.map((item) => h('option', { key: item.value, value: item.value }, item.label)))),
          h(Row, { label: '词典卡', hint: '选中的是单个单词时，给音标、多义与例句。' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(settings.dictCard),
              onChange: (event) => update({ dictCard: event.target.checked }),
            })),
          h(Row, {
            label: '翻译模型',
            hint: models === null ? '点右侧按钮加载 DSH 模型列表后可选。' : '留空表示跟随 DSH 默认模型。',
          },
            h('select', {
              style: { ...inputStyle, minWidth: 220 },
              value: modelValue(settings.model.translate),
              onChange: (event) => update({ model: { ...settings.model, translate: parseModel(event.target.value) } }),
              disabled: models === null,
            }, modelOptions(settings.model.translate)),
            models === null ? h(Button, { onClick: loadModels, disabled: busy }, '加载模型') : null)),

        h('div', { style: sectionStyle },
          h('h3', { style: titleStyle }, '对话'),
          h(Row, { label: '提问模型' },
            h('select', {
              style: { ...inputStyle, minWidth: 220 },
              value: modelValue(settings.model.ask),
              onChange: (event) => update({ model: { ...settings.model, ask: parseModel(event.target.value) } }),
              disabled: models === null,
            }, modelOptions(settings.model.ask))),
          h(Row, { label: '精简输出' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(settings.budget),
              onChange: (event) => update({ budget: event.target.checked }),
            })),
          h(Row, { label: '联网' },
            h('select', {
              style: inputStyle,
              value: settings.searchMode,
              onChange: (event) => update({ searchMode: event.target.value }),
            }, SEARCH_MODES.map((item) => h('option', { key: item.value, value: item.value }, item.label)))),
          h(Row, { label: '带上来源' }, 
            h('input', {
              type: 'checkbox',
              checked: Boolean(settings.includeSource),
              onChange: (event) => update({ includeSource: event.target.checked }),
            }))),

        h('div', { style: sectionStyle },
          h('h3', { style: titleStyle }, '快捷键'),
          h(Row, { label: '翻译', hint: '格式如 Ctrl+Shift+Q；在小窗里按键录制更省事。' },
            h('input', {
              style: { ...inputStyle, width: 160 },
              value: settings.hotkeys.translate || '',
              onChange: (event) => updateHotkey('translate', event.target.value),
            })),
          h(Row, { label: '对话' },
            h('input', {
              style: { ...inputStyle, width: 160 },
              value: settings.hotkeys.ask || '',
              onChange: (event) => updateHotkey('ask', event.target.value),
            })),
          h(Row, { label: '截图' },
            h('input', {
              style: { ...inputStyle, width: 160 },
              value: settings.hotkeys.capture || '',
              onChange: (event) => updateHotkey('capture', event.target.value),
            }))),

        h('div', { style: sectionStyle },
          h('h3', { style: titleStyle }, '高级'),
          h(Row, { label: '自动启动壳', hint: '关掉后热键失效，直到你重新打开。' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(settings.shellAutoStart),
              onChange: (event) => update({ shellAutoStart: event.target.checked }),
            })),
          h(Row, { label: '历史保留条数' },
            h('input', {
              style: { ...inputStyle, width: 96 },
              type: 'number', min: 20, max: 1000, value: settings.historyLimit,
              onChange: (event) => update({ historyLimit: Number(event.target.value) || 200 }),
            })),
          h(Row, { label: '隐藏标题栏', hint: '去掉最小化/最大化/关闭按钮；按 Esc 关闭窗口。' },
            h('input', {
              type: 'checkbox',
              checked: settings.hideTitleBar !== false,
              onChange: (event) => update({ hideTitleBar: event.target.checked }),
            })),
          h(Row, { label: '数据' },
            h(Button, { onClick: clearHistory }, '清空历史'),
            h(Button, { onClick: () => { void load() }, disabled: busy }, '重新读取'))),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 } },
          h(Button, { onClick: save, disabled: busy || !dirty, tone: 'primary' }, dirty ? '保存' : '已保存'),
          h('span', { style: hintStyle }, status)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'quicklook',
          order: 60,
          label: '划词小窗',
        }, QuicklookSettings))
      },
    }
  },
})