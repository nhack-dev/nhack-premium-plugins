/* merge-section の 自己テスト
 *   ★正例 ／ 負例 ／ 往復 ／ ★★印の外が 無傷か ／ 陽性対照
 *   ★落ちたら exit=1
 */
import { mergeSection, sectionSha } from './merge-section.mjs'

const M = { begin: '<!-- X-BEGIN -->', end: '<!-- X-END -->' }
let ok = 0, ng = 0
const t = (name, cond, extra = '') => {
  if (cond) { ok++ } else { ng++; console.error(`  🔴 ${name} ${extra}`) }
}

// ───────── ① 正例
{
  const r = mergeSection('', 'あたらしい節', M)
  t('空から append', r.mode === 'append' && r.text.includes('あたらしい節'), r.mode)
}
{
  const cur = '# 指示書\n\nお客様が 書かれた 行\n'
  const r = mergeSection(cur, '節', M)
  t('印なし → append', r.mode === 'append')
  t('★既存が 1文字も 消えない', r.text.startsWith(cur), JSON.stringify(r.text?.slice(0, 20)))
}
{
  const cur = `頭\n${M.begin}\nふるい\n${M.end}\n尾\n`
  const r = mergeSection(cur, 'あたらしい', M)
  t('印あり → replace', r.mode === 'replace', r.mode)
  t('★印の【前】が 無傷', r.text.startsWith('頭\n'))
  t('★印の【後】が 無傷', r.text.endsWith('\n尾\n'))
  t('★ふるい が 消えた', !r.text.includes('ふるい'))
  t('★あたらしい が 入った', r.text.includes('あたらしい'))
}
{
  const cur = `頭\n${M.begin}\nおなじ\n${M.end}\n尾\n`
  const r = mergeSection(cur, 'おなじ', M)
  t('同じ中身 → noop', r.mode === 'noop', r.mode)
  t('★noop は 元の文字列を そのまま 返す', r.text === cur)
}
{
  const r = mergeSection('改行で 終わらない行', '節', M)
  t('改行なしでも append できる', r.mode === 'append' && r.text.includes('節'))
  t('★元の行が 残る', r.text.startsWith('改行で 終わらない行'))
}

// ───────── ② 負例（★全部 refuse）
const bad = [
  ['始めの印だけ',  `a\n${M.begin}\nb\n`],
  ['終わりの印だけ', `a\n${M.end}\nb\n`],
  ['順序が 逆',   `${M.end}\nx\n${M.begin}\n`],
  ['始めが 2個',   `${M.begin}\na\n${M.begin}\nb\n${M.end}\n`],
  ['終わりが 2個',  `${M.begin}\na\n${M.end}\nb\n${M.end}\n`],
]
for (const [name, cur] of bad) {
  const r = mergeSection(cur, '節', M)
  t(`負例 ${name}`, r.mode === 'refuse' && r.text === null, r.mode)
}
t('印が 空', mergeSection('a', 'b', { begin: '', end: 'x' }).mode === 'refuse')
t('印が 同じ', mergeSection('a', 'b', { begin: 'X', end: 'X' }).mode === 'refuse')
t('節の中に 印', mergeSection('a', `わる${M.begin}い`, M).mode === 'refuse')
t('中身が 文字列でない', mergeSection(null, 'b', M).mode === 'refuse')
t('節が 文字列でない', mergeSection('a', null, M).mode === 'refuse')
t('印が 無い(undefined)', mergeSection('a', 'b', undefined).mode === 'refuse')

// ───────── ③ 往復
{
  const cur = '# もとの 指示書\n\n手で 書いた 行\n'
  const a = mergeSection(cur, '一回目', M)
  t('往復① append', a.mode === 'append')
  const b = mergeSection(a.text, '一回目', M)
  t('往復② 同じなら noop', b.mode === 'noop', b.mode)
  const c = mergeSection(a.text, '二回目', M)
  t('往復③ 違えば replace', c.mode === 'replace', c.mode)
  t('★往復しても 手で書いた行が 残る', c.text.includes('手で 書いた 行'))
  t('★往復しても 一回目は 消える', !c.text.includes('一回目'))
  const d = mergeSection(c.text, '一回目', M)
  t('★往復④ 戻すと 最初と 一致', d.text === a.text)
}

// ───────── ③-2 🔴 お客様が 印の中を 手で 直された 場合
{
  const cur = '# 指示書\n\n手で 書いた 行\n'
  const a = mergeSection(cur, 'こちらが 書いた 節', M)
  const sha = sectionSha('\n' + 'こちらが 書いた 節' + '\n')

  // ★触られていない → これまでどおり replace
  const b = mergeSection(a.text, 'つぎの 節', M, { lastSha: sha })
  t('lastSha 一致 → replace', b.mode === 'replace', b.mode)
  t('lastSha 一致 → edited は 付かない', b.edited === undefined)

  // 🔴 ★お客様が 印の中を 直された
  const edited = a.text.replace('こちらが 書いた 節', 'お客様の 大事な メモ')
  const c = mergeSection(edited, 'つぎの 節', M, { lastSha: sha })
  t('🔴 触られていたら replace-edited', c.mode === 'replace-edited', c.mode)
  t('★お客様の 中身を 返す', c.edited && c.edited.includes('お客様の 大事な メモ'), JSON.stringify(c.edited))
  t('★新しい 節も ちゃんと 入る', c.text.includes('つぎの 節'))
  t('★印の 外は 無傷', c.text.includes('手で 書いた 行'))

  // ★lastSha を 渡さなければ これまでと 同じ
  const d = mergeSection(edited, 'つぎの 節', M)
  t('lastSha なし → これまでと 同じ replace', d.mode === 'replace', d.mode)

  // ★同じ中身なら 触られていても noop が 勝つ（★書かないのが 最優先）
  const e = mergeSection(edited, 'お客様の 大事な メモ', M, { lastSha: sha })
  t('★中身が 同じなら noop（★書かない）', e.mode === 'noop', e.mode)

  // ★指紋の 関数そのもの
  t('★指紋は 同じ入力で 同じ', sectionSha('あ') === sectionSha('あ'))
  t('★指紋は 違う入力で 違う', sectionSha('あ') !== sectionSha('い'))
  t('★指紋は 64文字', sectionSha('あ').length === 64)
}

// ───────── ④ 陽性対照（★テスト自体が 生きているか）
{
  const r = mergeSection(`${M.begin}\nx\n${M.end}`, 'y', M)
  t('★陽性対照: 壊れていない入力は refuse に ならない', r.mode !== 'refuse', r.mode)
  const bad2 = mergeSection(`${M.begin}\nx\n`, 'y', M)
  t('★陽性対照: 壊れた入力は refuse に なる', bad2.mode === 'refuse')
}

console.log(`\n  ✅ ${ok} 件 通過 ／ 🔴 ${ng} 件 失敗`)
process.exit(ng === 0 ? 0 : 1)
