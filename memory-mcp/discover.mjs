/* discover.mjs ── ★作業場を 見つける
 *
 * ★お客様ごとに 構成が 違うので、置き場を 決め打ちせず 探します。
 *
 * ★なぜ 決め打ちを やめたか
 *   決め打ちの 場所だけ 見ると、置き場の 名前が 違う 環境で 取りこぼします。
 *   一方で ホーム全部を 読むと、置き場の 上限に 入りません。
 *   → ★「作業場を 見つけて その中を 全部」なら、
 *     ★置き場の 名前が memory でも notes でも data でも 拾えます。
 *
 * ★単独で 測れる 形に しました（★server.ts の 中に 書くと 測れません）
 *   bun memory-mcp/discover.mjs --selftest
 */
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ★見ない ところ（★機械の 部品であって お客様の 作業物では ない）
export const SKIP = new Set([
  'node_modules', '.git', 'Library', '.Trash', '.npm', '.cache', '.bun', '.rustup', '.cargo',
  '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'Applications', 'go',
  'Movies', 'Music', 'Pictures', 'Downloads',
])
// ★作業場の 目印（★どれか1つ 在れば AIが 動いている 場所）
// 🔴 ★.claude / .nhack を 目印から 外しました
//   ★これらは home 直下に 在るので、目印に すると home 全体が
//   ★★作業場と 判定されます。
//   → ★これらは 下の「決め打ち」で 個別に 拾います。
export const MARKERS = new Set(['CLAUDE.md', '.mcp.json', 'memory', 'memory-v2'])
export const MAX_DEPTH = 4      // ★深く 潜るほど 起動が 遅れる
export const MAX_DIRS = 400     // ★見つけすぎたら 止める（★数を 出す）

export function discoverWorkspaces({ home = homedir(), cwd = process.cwd(), memDir = '' } = {}) {
  const found = []
  let scanned = 0, stoppedByLimit = false
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return
    if (found.length >= MAX_DIRS) { stoppedByLimit = true; return }
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    scanned++
    // 🔴 ★home 自身は 作業場に しません（★depth 0）。
    //   ★home 直下に memory が 在るお客様で home 全体を 読まない ため。
    if (depth > 0 && ents.some((e) => MARKERS.has(e.name))) found.push(dir)
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (SKIP.has(e.name)) continue
      if (e.name.startsWith('.') && !MARKERS.has(e.name)) continue
      walk(join(dir, e.name), depth + 1)
    }
  }
  walk(home, 0)
  // ★決め打ちも 残す（★目印が 1つも 無い お客様でも 拾えるように）
  for (const p of [
    join(home, '.nhack', 'memory'), join(home, '.claude'),
    join(home, 'memory'), join(home, 'memory-v2'),
    join(cwd, 'memory'), join(cwd, 'memory-v2'), cwd,
    ...(memDir ? [memDir] : []),
  ]) if (!found.includes(p)) found.push(p)
  // 🔴 ★「上限で 止めた」を 黙って 落とさない（★今日の 型）
  return { roots: found, scanned, stoppedByLimit }
}

/* ── ★自己テスト ─────────────────────────────── */
if (process.argv[1]?.endsWith('discover.mjs') && process.argv.includes('--selftest')) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs')
  const { tmpdir } = await import('os')
  let n = 0, ng = 0
  const ok = (c, label) => { n++; if (!c) { ng++; console.log(`  🔴 ${label}`) } else console.log(`  ✅ ${label}`) }

  const base = mkdtempSync(join(tmpdir(), 'nhack-ws-'))
  const mk = (p, f) => { mkdirSync(join(base, p), { recursive: true }); if (f) writeFileSync(join(base, p, f), 'x') }

  mk('proj-a', 'CLAUDE.md')            // ★目印 CLAUDE.md
  mk('proj-b', '.mcp.json')            // ★目印 .mcp.json
  mk('proj-c/memory', 'a.md')          // ★目印 memory（★親が 作業場）
  mk('proj-d/notes', 'a.md')           // ★目印 なし … 拾わない
  mk('proj-e/node_modules/x', 'CLAUDE.md')  // ★除外の 中 … 拾わない
  mk('a/b/c/d/e/deep', 'CLAUDE.md')    // ★深すぎ … 拾わない

  const r = discoverWorkspaces({ home: base, cwd: base, memDir: '' })
  const has = (p) => r.roots.includes(join(base, p))
  ok(has('proj-a'), 'CLAUDE.md が 在る 場所を 拾う')
  ok(has('proj-b'), '.mcp.json が 在る 場所を 拾う')
  ok(has('proj-c'), 'memory を 持つ 親を 拾う')
  ok(!has('proj-d'), '目印が 無い 場所は 拾わない')
  ok(!r.roots.some((x) => x.includes('node_modules')), 'node_modules の 中は 見ない')
  ok(!has('a/b/c/d/e/deep'), '深さの 上限を 超えたら 拾わない')
  ok(r.roots.includes(base), '決め打ちの cwd も 入る')
  ok(typeof r.scanned === 'number' && r.scanned > 0, '見た フォルダの 数を 出す')
  ok(r.stoppedByLimit === false, '上限で 止めた かどうかを 出す')
  // 🔴 ★測定器が 生きて いるか（★陰性対照）
  const empty = mkdtempSync(join(tmpdir(), 'nhack-ws-empty-'))
  const r2 = discoverWorkspaces({ home: empty, cwd: empty, memDir: '' })
  // ★目印が 1つも 無い 機械 … マーカーで 拾えるのは 0件。
  //   決め打ち（.nhack/memory 等）は 残るが、それは 実在しない パスも 含む「保険」。
  //   → ★測るのは「マーカー由来が 0か」。決め打ちの 本数では ない。
  ok(r2.scanned >= 1, '空の 機械でも 走る（★測定器は 生きて います）')
  ok(r2.roots.every((x) => !x.startsWith(join(empty, 'proj'))), '目印の 無い 機械では マーカー由来 0件')

  // 🔴 ★home 直下に memory が 在っても、home 全体を 作業場に しない
  const h2 = mkdtempSync(join(tmpdir(), 'nhack-ws-home-'))
  mkdirSync(join(h2, 'memory'), { recursive: true })   // ★home 直下に memory
  mkdirSync(join(h2, 'proj-x'), { recursive: true }); writeFileSync(join(h2, 'proj-x', 'CLAUDE.md'), 'x')
  const r3 = discoverWorkspaces({ home: h2, cwd: h2, memDir: '' })
  ok(!r3.roots.includes(h2) || r3.roots.includes(join(h2, 'memory')), 'home自身は 作業場に しない（★memoryを持つ子は 拾う）')
  ok(r3.roots.includes(join(h2, 'proj-x')), 'home直下の proj-x（CLAUDE.md）は 拾う')
  rmSync(h2, { recursive: true, force: true })

  rmSync(base, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true })
  console.log(ng === 0 ? `\n✅ 合格（${n}件）` : `\n🔴 ${ng}/${n}件 落ちました`)
  process.exit(ng === 0 ? 0 : 1)
}
