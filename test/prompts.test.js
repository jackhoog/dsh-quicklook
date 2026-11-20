import test from 'node:test'
import assert from 'node:assert/strict'
import { isWordForm, resolveTargetLanguage, stripGloss, unwrapFence, buildTranslateSystem } from '../lib/prompts.js'

test('recognises a single word', () => {
  assert.equal(isWordForm('hallucinate'), true)
  assert.equal(isWordForm('New York'), true)
})

test('rejects a sentence', () => {
  assert.equal(isWordForm('The model hallucinated a citation.'), false)
  assert.equal(isWordForm('这是一句话。'), false)
})

test('picks the opposite language for Chinese source', () => {
  assert.equal(resolveTargetLanguage('这是一段中文', 'auto'), 'English')
  assert.equal(resolveTargetLanguage('This is English', 'auto'), '中文')
})

test('honours an explicit target', () => {
  assert.equal(resolveTargetLanguage('This is English', '中文'), '中文')
})

test('strips an explanatory parenthetical', () => {
  assert.equal(stripGloss('该模型虚构了一处引用。（意为编造）'), '该模型虚构了一处引用。')
})

test('strips a note line', () => {
  assert.equal(stripGloss('译文正文\n注：此处为意译'), '译文正文')
})

test('keeps ordinary parentheses', () => {
  const text = 'The result (Figure 2) is lower.'
  assert.equal(stripGloss(text), text)
})

test('unwraps a fence the model added', () => {
  const out = unwrapFence('```javascript\nconst a = 1\n```', 'const a = 1')
  assert.equal(out, 'const a = 1')
})

test('keeps a fence the user wrote', () => {
  const source = '```js\nconst a = 1\n```'
  assert.equal(unwrapFence(source, source), source)
})

test('prompt carries the target language and glossary', () => {
  const system = buildTranslateSystem({ target: 'English', glossary: [{ from: '划词', to: 'selection' }] })
  assert.match(system, /English/)
  assert.match(system, /划词 => selection/)
})