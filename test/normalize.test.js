import test from 'node:test'
import assert from 'node:assert/strict'
import { normalize, detectShape, segment } from '../lib/normalize.js'

test('joins PDF-style line breaks in a Latin sentence', () => {
  const { text, shape, applied, stats } = normalize('The model halluci-\nnated a citation\nthat never existed.')
  assert.equal(shape, 'prose')
  assert.equal(applied, true)
  assert.equal(stats.hyphens, 1)
  assert.equal(text, 'The model hallucinated a citation that never existed.')
})

test('joins Chinese lines without inserting spaces', () => {
  const { text } = normalize('这是一句被硬折\n断的中文句子。')
  assert.equal(text, '这是一句被硬折断的中文句子。')
})

test('keeps paragraph breaks', () => {
  const { text } = normalize('first line\nsecond line\n\nthird para\nfourth')
  assert.equal(text, 'first line second line\n\nthird para fourth')
})

test('never joins code', () => {
  const source = 'function a() {\n  return 1\n}\n\nconst b = 2'
  const { text, shape, applied, stats } = normalize(source, { mode: 'on' })
  assert.equal(shape, 'code')
  assert.equal(applied, false)
  assert.equal(text, source)
  assert.equal(stats.forcedSkip, 'code')
})

test('never joins a bullet list', () => {
  const source = '- alpha\n- beta\n- gamma\n- delta'
  const { shape, applied } = normalize(source, { mode: 'on' })
  assert.equal(shape, 'list')
  assert.equal(applied, false)
})

test('detects an aligned table', () => {
  assert.equal(detectShape('name    value\nalpha   1\nbeta    2'), 'table')
})

test('mode off keeps line breaks', () => {
  const { text, applied } = normalize('one\ntwo', { mode: 'off' })
  assert.equal(applied, false)
  assert.equal(text, 'one\ntwo')
})

test('strips zero width and full width spaces', () => {
  const { text, stats } = normalize('a\u200Bb\u3000c')
  assert.equal(text, 'ab c')
  assert.ok(stats.stripped >= 1)
})

test('handles CRLF and vertical tab', () => {
  assert.equal(normalize('a\r\nb').text, 'a b')
  assert.equal(normalize('a\vb').text, 'a b')
})

test('collapses runs of spaces after joining', () => {
  assert.equal(normalize('alpha  \n  beta').text, 'alpha beta')
})

test('empty input is empty output', () => {
  const result = normalize('   ')
  assert.equal(result.text, '')
  assert.equal(result.shape, 'empty')
  assert.equal(result.applied, false)
})

test('splits long text at sentence boundaries', () => {
  const text = '第一句话。第二句话。第三句话。'
  const chunks = segment(text, 6)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 6))
})

test('leaves short text unsplit', () => {
  assert.deepEqual(segment('short', 100), ['short'])
})