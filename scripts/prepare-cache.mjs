#!/usr/bin/env node
// 新版の置き場を、配る前に作っておく道具。
//
// なぜ要るか: いま動いている古い版の更新処理は Windows で必ず失敗する（rsync が無い）。
//   失敗しても空のフォルダを指したまま登録を書き換え、「再起動してください」と送る。
//   ★新版を出した瞬間に壊れる。だから【出す前に】置き場を正しく作っておく。
//   置き場に中身があれば、古いコードの写しが失敗しても、指す先は正しい。
//
// ★この道具は登録（installed_plugins.json）を触らない。
//   触らない側の被害  … 何も起きない。今動いているものはそのまま動く
//   触った側の被害    … 版の不一致で更新処理が繰り返し走る（#28 の罠）
//   → 触らない。
//
// 使い方: node prepare-cache.mjs [バージョン] [ブランチ]
//         省略時は main の plugin.json から版を読む
import { execSync } from 'child_process'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const REPO = 'https://github.com/nhack-dev/nhack-premium-plugins.git'
const branch = process.argv[3] || 'main'
const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const mp = join(cfg, 'plugins', 'marketplaces', 'nhack-premium-plugins')

function sh(cmd, opts = {}) { return execSync(cmd, { encoding: 'utf8', timeout: 120000, stdio: ['ignore','pipe','pipe'], ...opts }) }

// 版を決める。指定が無ければ、引いてくるブランチの plugin.json から読む
let version = process.argv[2]
if (!version) {
  if (!existsSync(mp)) { console.error('marketplace が見つかりません:', mp); process.exit(1) }
  sh(`git -C "${mp}" fetch origin ${branch}`)
  version = JSON.parse(sh(`git -C "${mp}" show origin/${branch}:.claude-plugin/plugin.json`)).version
}
const dest = join(cfg, 'plugins', 'cache', 'nhack-premium-plugins', 'nhack-premium', version)
console.log(`版: ${version} / ブランチ: ${branch}`)
console.log(`置き場: ${dest}`)

// 既に正しく入っているなら何もしない
const stamp = join(dest, '.claude-plugin', 'plugin.json')
if (existsSync(stamp) && existsSync(join(dest, 'server.ts'))) {
  try {
    if (JSON.parse(readFileSync(stamp, 'utf8')).version === version) {
      console.log('✅ すでに正しく入っています（何もしません）'); process.exit(0)
    }
  } catch {}
  console.log('中身が版と合わないので入れ直します')
  rmSync(dest, { recursive: true, force: true })
}

// 作る。git clone を使う（tar / rsync に頼らない）
mkdirSync(join(dest, '..'), { recursive: true })
rmSync(dest, { recursive: true, force: true })
try {
  sh(`git clone --depth 1 --branch ${branch} "${REPO}" "${dest}"`)
} catch (e) {
  console.error('❌ 取得できませんでした:', String(e.message || e).split('\n')[0])
  rmSync(dest, { recursive: true, force: true })
  process.exit(1)
}

// ★入れたつもりで空、を弾く
const must = [stamp, join(dest, 'server.ts')]
const missing = must.filter(f => !existsSync(f))
if (missing.length) {
  console.error('❌ 中身が足りません:', missing.join(', '))
  rmSync(dest, { recursive: true, force: true }); process.exit(1)
}
const got = JSON.parse(readFileSync(stamp, 'utf8')).version
if (got !== version) {
  console.error(`❌ 版が合いません: 取れたのは ${got}、欲しいのは ${version}`)
  rmSync(dest, { recursive: true, force: true }); process.exit(1)
}

// 依存を入れる
try { sh('bun install --no-summary', { cwd: dest }) }
catch (e) {
  console.error('❌ 依存を入れられませんでした:', String(e.message || e).split('\n')[0])
  rmSync(dest, { recursive: true, force: true }); process.exit(1)
}

console.log('✅ 置き場を作りました（登録は触っていません）')
console.log('   → このあと新版が出たとき、写しに失敗しても正しく切り替わります')
