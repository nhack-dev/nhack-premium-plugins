/* apply-pull の 自己テスト（★口は 偽物に 差し替えて 測る） */
import { applyPull, safeJoin, keepOutside } from './apply-pull.mjs'
import { mergeSection, sectionSha } from './merge-section.mjs'

const M = { begin: '<!-- X-BEGIN -->', end: '<!-- X-END -->' }
let ok = 0, ng = 0
const t = (n, c, x = '') => { if (c) ok++; else { ng++; console.error(`  🔴 ${n} ${x}`) } }

/** ★偽の 読み書き（★記憶の 中だけ） */
const mkio = (files) => ({
  read: p => { if (!(p in files)) throw new Error('ENOENT'); return files[p] },
  write: (p, t2) => { files[p] = t2 },
})

// ───────── ① 置き場の 判定
t('safeJoin ふつう', safeJoin('/r', 'a/b.md') === '/r/a/b.md')
for (const bad of ['../x', 'a/../../x', '/etc/passwd', '', 'a\0b'])
  t(`safeJoin 断る: ${JSON.stringify(bad)}`, safeJoin('/r', bad) === null)
t('safeJoin 文字列でない', safeJoin('/r', null) === null)

// ───────── ② ふつうの 書き戻し
{
  const f = { '/r/CLAUDE.md': '# もとの\n\n手で 書いた 行\n' }
  const r = await applyPull({
    root: '/r', io: mkio(f), sendBack: async () => true,
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節1', marker: M }],
  })
  t('② append できた', r.applied.length === 1, JSON.stringify(r))
  t('② ★手で 書いた 行が 残る', f['/r/CLAUDE.md'].includes('手で 書いた 行'))
  t('② 逃がす 必要が ない', r.rescued.length === 0)
}

// ───────── ③ 2回目は noop（★書かない）
{
  const base = mergeSection('# もと\n', '節1', M).text
  const f = { '/r/CLAUDE.md': base }
  const sha = sectionSha('\n節1\n')
  const r = await applyPull({
    root: '/r', io: mkio(f), sendBack: async () => true,
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節1', marker: M, lastSha: sha }],
  })
  t('③ noop（★1文字も 書かない）', r.noop.length === 1 && r.applied.length === 0, JSON.stringify(r))
  t('③ 中身が 変わっていない', f['/r/CLAUDE.md'] === base)
}

// ───────── ④ 🔴 お客様が 直しておられた → ★消さずに 印の 外へ 移す
{
  const base = mergeSection('# もと\n', '節1', M).text
  const edited = base.replace('節1', 'お客様の 大事な メモ')
  const f = { '/r/CLAUDE.md': edited }
  const sha = sectionSha('\n節1\n')
  let sent = null
  const r = await applyPull({
    root: '/r', io: mkio(f), sendBack: async (rel, text) => { sent = { rel, text }; return true },
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節2', marker: M, lastSha: sha }],
  })
  t('④ 外へ 渡した', sent && sent.text.includes('お客様の 大事な メモ'))
  t('④ rescued に 出る', r.rescued.length === 1)
  t('④ 新しい 節が 入った', f['/r/CLAUDE.md'].includes('節2'))
  t('④ ★★お客様の メモが 消えていない', f['/r/CLAUDE.md'].includes('お客様の 大事な メモ'))
  const after = f['/r/CLAUDE.md']
  t('④ ★★★メモは【印の 外】に ある',
    after.indexOf('お客様の 大事な メモ') > after.indexOf(M.end), after)
}

// ───────── ⑤ 🔴🔴 送り返せなくても ★★お客様の 分は 失われない
{
  const base = mergeSection('# もと\n', '節1', M).text
  const edited = base.replace('節1', 'お客様の 大事な メモ')
  const f = { '/r/CLAUDE.md': edited }
  const r = await applyPull({
    root: '/r', io: mkio(f), sendBack: async () => false,   // ★送れない
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節2', marker: M, lastSha: sectionSha('\n節1\n') }],
  })
  t('⑤ 外が だめでも 書ける', r.applied.length === 1, JSON.stringify(r))
  t('⑤ ★★★お客様の メモが 残っている', f['/r/CLAUDE.md'].includes('お客様の 大事な メモ'))
  t('⑤ 新しい 節も 入る', f['/r/CLAUDE.md'].includes('節2'))
}
{
  const base = mergeSection('# もと\n', '節1', M).text
  const f = { '/r/CLAUDE.md': base.replace('節1', 'メモA') }
  const r = await applyPull({
    root: '/r', io: mkio(f), sendBack: async () => { throw new Error('切れた') },
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節2', marker: M, lastSha: sectionSha('\n節1\n') }],
  })
  t('⑤-2 例外でも メモは 残る', r.applied.length === 1 && f['/r/CLAUDE.md'].includes('メモA'))
}

// ───────── ⑤-3 ★★★往復 ── ★2回 更新しても お客様の 分は 消えない
{
  const base = mergeSection('# もと\n', '節1', M).text
  const f = { '/r/CLAUDE.md': base.replace('節1', 'メモA') }
  const io = mkio(f)
  await applyPull({ root: '/r', io, sendBack: async () => true,
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節2', marker: M, lastSha: sectionSha('\n節1\n') }] })
  await applyPull({ root: '/r', io, sendBack: async () => true,
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節3', marker: M, lastSha: sectionSha('\n節2\n') }] })
  t('⑤-3 ★2回目の 更新でも メモA が 残る', f['/r/CLAUDE.md'].includes('メモA'), f['/r/CLAUDE.md'])
  t('⑤-3 最新の 節が 入っている', f['/r/CLAUDE.md'].includes('節3'))
  t('⑤-3 古い 節2 は 消えている', !f['/r/CLAUDE.md'].includes('節2'))
}

// ───────── ⑤-4 keepOutside そのもの
t('keepOutside 印が 無ければ null', keepOutside('abc', '<!--E-->', 'x') === null)
t('keepOutside 空なら そのまま', keepOutside('a<!--E-->b', '<!--E-->', '\n\n') === 'a<!--E-->b')
t('keepOutside 印の 直後に 入る',
  keepOutside('a<!--E-->b', '<!--E-->', 'X') === 'a<!--E-->\nX\nb')

// ───────── ⑥ 断るもの
{
  const f = { '/r/CLAUDE.md': 'x' }
  const r = await applyPull({
    root: '/r', io: mkio(f), sendBack: async () => true,
    items: [
      { rel: '../out.md', mode: 'section', section: 'a', marker: M },
      { rel: 'CLAUDE.md', mode: 'まるごと',  section: 'a', marker: M },
      { rel: 'CLAUDE.md', mode: 'section', section: 'a', marker: { begin: '', end: 'x' } },
    ],
  })
  t('⑥ 3件とも 断る', r.refused.length === 3, JSON.stringify(r.refused))
  t('⑥ 1件も 書いていない', f['/r/CLAUDE.md'] === 'x')
}

// ───────── ⑦ 読めない / 書けない
{
  const r = await applyPull({
    root: '/r', io: { read: () => { throw new Error('ENOENT') }, write: () => {} },
    sendBack: async () => true,
    items: [{ rel: 'nai.md', mode: 'section', section: 'a', marker: M }],
  })
  t('⑦ 読めない → failed', r.failed.length === 1, JSON.stringify(r))
}
{
  const r = await applyPull({
    root: '/r', io: { read: () => '', write: () => { throw new Error('EACCES') } },
    sendBack: async () => true,
    items: [{ rel: 'a.md', mode: 'section', section: 'a', marker: M }],
  })
  t('⑦ 書けない → failed', r.failed.length === 1 && r.applied.length === 0)
}

// ───────── ⑧ ★手元に 何も 残さない（★書いた 先が 配られた もの だけか）
{
  const f = { '/r/CLAUDE.md': '# もと\n' }
  const before = Object.keys(f).slice()
  await applyPull({
    root: '/r', io: mkio(f), sendBack: async () => true,
    items: [{ rel: 'CLAUDE.md', mode: 'section', section: '節', marker: M }],
  })
  t('⑧ ★増えた ファイルは 0件（★記録を 残さない）',
    Object.keys(f).length === before.length, JSON.stringify(Object.keys(f)))
}

// ───────── ⑧-2 ★フォルダを 作る（ensure-dir）
{
  const made = []
  const io = { read: () => '', write: () => {}, exists: p => p === '/r/aru', mkdir: p => made.push(p) }
  const r = await applyPull({ root: '/r', io, sendBack: async () => true, items: [
    { rel: 'memory', mode: 'ensure-dir' },
    { rel: 'aru',    mode: 'ensure-dir' },     // ★既に 在る
    { rel: '../soto', mode: 'ensure-dir' },    // ★範囲の 外
  ]})
  t('⑧-2 無い フォルダを 作った', made.length === 1 && made[0] === '/r/memory', JSON.stringify(made))
  t('⑧-2 在る フォルダは noop', r.noop.length === 1)
  t('⑧-2 範囲の 外は 断る', r.refused.length === 1)
}

// ───────── ⑧-3 ★無い ときだけ 作る（create-if-missing）
{
  const f = { '/r/aru.md': '★お客様が 前から 持って おられる 中身' }
  const io = { read: p => f[p] ?? '', write: (p, t2) => { f[p] = t2 }, exists: p => p in f, mkdir: () => {} }
  const r = await applyPull({ root: '/r', io, sendBack: async () => true, items: [
    { rel: 'nai.md', mode: 'create-if-missing', content: '雛形の 中身' },
    { rel: 'aru.md', mode: 'create-if-missing', content: '★上書きしては いけない' },
  ]})
  t('⑧-3 無い ファイルを 作った', f['/r/nai.md'] === '雛形の 中身', JSON.stringify(f))
  t('⑧-3 ★★在る ファイルは 1文字も 触らない',
    f['/r/aru.md'] === '★お客様が 前から 持って おられる 中身')
  t('⑧-3 在るものは noop', r.noop.length === 1 && r.applied.length === 1, JSON.stringify(r))
  // ★content が 無ければ 空で 作る
  const r2 = await applyPull({ root: '/r', io, sendBack: async () => true,
    items: [{ rel: 'kara.md', mode: 'create-if-missing' }] })
  t('⑧-3 content 無しでも 作れる', f['/r/kara.md'] === '' && r2.applied.length === 1)
}

// ───────── ⑨ 陽性対照
{
  const f = { '/r/a.md': '' }
  const r = await applyPull({ root: '/r', io: mkio(f), sendBack: async () => true,
    items: [{ rel: 'a.md', mode: 'section', section: 'ok', marker: M }] })
  t('⑨ 陽性対照: ふつうの 1件は 通る', r.applied.length === 1, JSON.stringify(r))
  const r2 = await applyPull({ root: '/r', io: mkio(f), sendBack: async () => true, items: [] })
  t('⑨ 陽性対照: 0件なら 0件', r2.applied.length === 0)
}

console.log(`\n  ✅ ${ok} 件 通過 ／ 🔴 ${ng} 件 失敗`)
process.exit(ng === 0 ? 0 : 1)
