/* pull-once の 自己テスト（★通信も 読み書きも 偽物） */
import { pullOnce, sift, whyBad } from './pull-once.mjs'
const M = { begin: '<!--B-->', end: '<!--E-->' }
let ok = 0, ng = 0
const t = (n, c, x = '') => { if (c) ok++; else { ng++; console.error(`  🔴 ${n} ${x}`) } }
const res = (status, body) => ({ status, json: async () => body })
const mkio = f => ({ read: p => f[p] ?? '', write: (p, v) => { f[p] = v }, exists: p => p in f, mkdir: () => {} })

// ───────── ① 1件の 形（whyBad）
t('良い ensure-dir', whyBad({ rel: 'a', mode: 'ensure-dir' }) === null)
t('良い create', whyBad({ rel: 'a', mode: 'create-if-missing', content: 'x' }) === null)
t('良い create（content なし）', whyBad({ rel: 'a', mode: 'create-if-missing' }) === null)
t('良い section', whyBad({ rel: 'a', mode: 'section', section: 's', marker: M }) === null)
for (const [name, it] of [
  ['null',            null],
  ['rel が 無い',       { mode: 'ensure-dir' }],
  ['rel が 空',        { rel: '', mode: 'ensure-dir' }],
  ['知らない 直し方',     { rel: 'a', mode: 'nazo' }],
  ['直し方 が 無い',     { rel: 'a' }],
  ['content が 数',     { rel: 'a', mode: 'create-if-missing', content: 5 }],
  ['section が 無い',   { rel: 'a', mode: 'section', marker: M }],
  ['印 が 無い',        { rel: 'a', mode: 'section', section: 's' }],
  ['印 の end が 空',   { rel: 'a', mode: 'section', section: 's', marker: { begin: 'B', end: '' } }],
  ['指紋 が 数',        { rel: 'a', mode: 'section', section: 's', marker: M, lastSha: 1 }],
]) t(`断る: ${name}`, whyBad(it) !== null, JSON.stringify(whyBad(it)))

// ───────── ② 一覧の ふるい分け
t('配列で ない', sift({ items: 'x' }).note !== null)
t('body が null', sift(null).note !== null)
{
  const r = sift({ items: [
    { rel: 'a', mode: 'ensure-dir' },
    { rel: 'b', mode: 'nazo' },              // ★これだけ 壊れている
    { rel: 'c', mode: 'create-if-missing' },
  ]})
  t('★壊れた 1件だけ 外す', r.ok.length === 2 && r.dropped.length === 1, JSON.stringify(r))
  t('★★良い ものは 捨てない', r.ok.map(x => x.rel).join(',') === 'a,c')
  t('外した 理由が 付く', typeof r.dropped[0].why === 'string' && r.dropped[0].why !== '')
}

// ───────── ③ 通信の 結果ごと
const base = { root: '/r', sendBack: async () => true, url: 'u' }
t('外に 出られない', (await pullOnce({ ...base, fetchImpl: async () => { throw new Error('切断') } })).state === 'no-network')
t('返りが 変', (await pullOnce({ ...base, fetchImpl: async () => null })).state === 'bad-response')
t('304 は 何もしない', (await pullOnce({ ...base, fetchImpl: async () => res(304) })).state === 'unchanged')
t('500 は 何もしない', (await pullOnce({ ...base, fetchImpl: async () => res(500) })).state === 'not-ok')
t('JSON が 壊れている', (await pullOnce({ ...base, fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('x') } }) })).state === 'bad-json')
t('形が 違う', (await pullOnce({ ...base, fetchImpl: async () => res(200, { items: 'x' }) })).state === 'bad-shape')
t('中身が 空', (await pullOnce({ ...base, fetchImpl: async () => res(200, { items: [] }) })).state === 'nothing')

// ───────── ④ 通る場合（★壊れた1件が 混ざっても 良い分は 当たる）
{
  const f = { '/r/CLAUDE.md': '# もと\n' }
  const r = await pullOnce({
    ...base, io: mkio(f),
    fetchImpl: async () => res(200, { items: [
      { rel: 'CLAUDE.md', mode: 'section', section: '手引き', marker: M },
      { rel: 'warui',     mode: 'nazo' },
    ]}),
  })
  t('④ 当たった', r.state === 'applied' && r.applied.length === 1, JSON.stringify(r))
  t('④ ★壊れた 1件は 外れた', r.dropped.length === 1)
  t('④ 手引きが 入った', f['/r/CLAUDE.md'].includes('手引き'))
  t('④ ★元の 中身が 残る', f['/r/CLAUDE.md'].startsWith('# もと\n'))
}

// ───────── ⑤ 🔴 壊れた 応答で ★★1文字も 書かない
for (const [name, body] of [['配列でない', { items: 'x' }], ['空', { items: [] }], ['全部 壊れている', { items: [{ rel: 'a', mode: 'nazo' }] }]]) {
  const f = { '/r/CLAUDE.md': '★お客様の 中身' }
  await pullOnce({ ...base, io: mkio(f), fetchImpl: async () => res(200, body) })
  t(`⑤ ${name} → 1文字も 書かない`, f['/r/CLAUDE.md'] === '★お客様の 中身')
}

// ───────── ⑥ 陽性対照
{
  const f = { '/r/a.md': '' }
  const r = await pullOnce({ ...base, io: mkio(f),
    fetchImpl: async () => res(200, { items: [{ rel: 'a.md', mode: 'section', section: 'ok', marker: M }] }) })
  t('⑥ 陽性対照: ふつうの 1件は 通る', r.state === 'applied' && r.applied.length === 1, JSON.stringify(r))
}

console.log(`\n  ✅ ${ok} 件 通過 ／ 🔴 ${ng} 件 失敗`)
process.exit(ng === 0 ? 0 : 1)
