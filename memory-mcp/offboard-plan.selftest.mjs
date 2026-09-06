/* offboard-plan の 自己テスト
 *   ★★いちばん 大事な 検査 … ★外す 命令が 1つも 無いこと（★機械で 確かめる） */
import { planOffboard, renderPlan, CATALOG } from './offboard-plan.mjs'
import { readFileSync } from 'fs'
let ok = 0, ng = 0
const t = (n, c, x = '') => { if (c) ok++; else { ng++; console.error(`  🔴 ${n} ${x}`) } }

// ───────── ① 一覧に 在るか だけで 決める
{
  const r = planOffboard({ found: [
    { key: 'bun' },
    { key: 'homebrew', deps: 147 },
    { key: 'ffmpeg' },              // ★一覧に 無い
    { key: 'tmux' },
  ]})
  t('① 一覧に 在る 3つを 外す', r.remove.length === 3, JSON.stringify(r.remove.map(x=>x.key)))
  t('① ★入った 日を 見ない（Homebrew も 外す）', r.remove.some(x => x.key === 'homebrew'))
  t('① 一覧に 無い ものは 触らない', r.unknown.length === 1 && r.unknown[0].key === 'ffmpeg')
  t('① ★道連れの 数は 残る（★見せる ため）', r.remove.find(x=>x.key==='homebrew').deps === 147)
  t('① ★道連れが 在っても 止めない', r.remove.find(x=>x.key==='homebrew').why === 'こちらが 入れさせました')
}

// ───────── ② 形が 違うとき
t('② 配列で ない → 断る', planOffboard({ found: 'x' }).note !== null)
t('② 配列で ない → 外す 0件', planOffboard({ found: 'x' }).remove.length === 0)
t('② 空でも 落ちない', planOffboard({ found: [] }).remove.length === 0)
t('② key が 無い → 触らない', planOffboard({ found: [{}] }).unknown.length === 1)
t('② key が 数 → 触らない', planOffboard({ found: [{ key: 5 }] }).unknown.length === 1)
t('② null が 混ざる → 触らない', planOffboard({ found: [null] }).unknown.length === 1)

// ───────── ③ 一覧に 在る もの 全部（★取りこぼしが 無いか）
{
  const r = planOffboard({ found: CATALOG.map(c => ({ key: c.key })) })
  t('③ 一覧の 全部が 外す 側に 入る', r.remove.length === CATALOG.length, `${r.remove.length}/${CATALOG.length}`)
  t('③ 触らない は 0件', r.unknown.length === 0)
}

// ───────── ④ 見せる 一覧
{
  const rows = renderPlan(planOffboard({ found: [{ key: 'bun' }, { key: 'zzz' }] }))
  t('④ 2行 出る', rows.length === 2)
  t('④ 印が 2種', new Set(rows.map(r => r.mark)).size === 2)
  t('④ 何を／道連れ が 添う', rows.every(r => 'key' in r && 'deps' in r))
}

// ───────── ⑤ 🔴🔴 ★外す 命令が 1つも 無いこと（★機械で 確かめる）
{
  const src = readFileSync(new URL('./offboard-plan.mjs', import.meta.url), 'utf8')
  const NG = ['rmSync', 'unlink', 'rmdir', 'execSync', 'spawn', 'exec(', 'child_process', 'writeFile', 'uninstall']
  const hit = NG.filter(w => src.includes(w))
  t('⑤ ★★外す・書く・叩く 命令 0件', hit.length === 0, JSON.stringify(hit))
  t('⑤ ★陽性対照（★検査が 生きている）', src.includes('planOffboard'))
  t('⑤ 一覧が 空でない', CATALOG.length > 0)
  t('⑤ ★入った 日を 見て いない', !src.includes('baseAt'))
}

console.log(`\n  ✅ ${ok} 件 通過 ／ 🔴 ${ng} 件 失敗`)
process.exit(ng === 0 ? 0 : 1)
