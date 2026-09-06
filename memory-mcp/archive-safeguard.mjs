// 継続中の利用者のデータを失わせない門
//
// 中身が減る操作は、状態の指定と控えの検算が両方そろったときだけ通す。
//
// 設計の芯 … 既定で「通さない」。通すには 4つ すべてが揃う必要がある。
//   判定に使う値が1つでも欠けていたら止める（undefined は「たぶん大丈夫」ではない）

import fs from 'node:fs'
import path from 'node:path'

// 中身が減る操作。ここに無い操作名も 既定では通さない（下の UNKNOWN 参照）
export const DESTRUCTIVE = new Set(['remove', 'clear', 'zero', 'overwrite', 'move'])
// 中身が減らない操作
export const SAFE = new Set(['collect', 'read', 'mkdir', 'keep', 'rewrite'])

export class Refused extends Error {
  constructor(code, msg) { super(msg); this.name = 'Refused'; this.code = code }
}

/**
 * @param {object}  a
 * @param {string}  a.op           操作名
 * @param {object}  a.client       呼び出し側が渡す利用者の状態
 * @param {string}  a.client.status 'continuing' | 'withdrawn'
 * @param {string}  a.client.id
 * @param {string}  a.target       触る場所（絶対パス）
 * @param {object=} a.backup       控えの結果（destructive のときは必須）
 */
export function assertAllowed(a) {
  const { op, client, target, backup } = a ?? {}

  // ── ① 引数そのものが揃っているか（★欠けていたら止める）
  if (!op || typeof op !== 'string') throw new Refused('NO_OP', '操作名がありません')
  if (!target || typeof target !== 'string') throw new Refused('NO_TARGET', '触る場所がありません')
  if (!path.isAbsolute(target)) throw new Refused('REL_TARGET', `触る場所が絶対パスではありません: ${target}`)
  if (!client || typeof client !== 'object') throw new Refused('NO_CLIENT', '利用者の情報がありません')
  if (!client.id) throw new Refused('NO_CLIENT_ID', '識別子がありません')

  // ── ② 知らない操作は通さない（★既定で拒否）
  const destructive = DESTRUCTIVE.has(op)
  if (!destructive && !SAFE.has(op)) {
    throw new Refused('UNKNOWN_OP', `知らない操作です: ${op}（安全側に倒して止めます）`)
  }
  if (!destructive) return { ok: true, op, destructive: false }

  // ── ③ 状態が 'withdrawn' のときだけ、消す操作を通す
  if (client.status !== 'withdrawn') {
    throw new Refused(
      'CLIENT_CONTINUING',
      'この操作は許可されていません'
    )
  }

  // ── ④ 控えの検算が通っていること
  if (!backup || typeof backup !== 'object') {
    throw new Refused('NO_BACKUP', `${op} には控えが要ります（控えの結果がありません）`)
  }
  if (backup.verified !== true) {
    throw new Refused('BACKUP_NOT_VERIFIED', '控えの検算が通っていません')
  }
  if (!Number.isInteger(backup.files) || backup.files < 1) {
    throw new Refused('BACKUP_EMPTY', '控えが揃っていません')
  }
  if (!Number.isInteger(backup.bytes) || backup.bytes < 1) {
    throw new Refused('BACKUP_ZERO_BYTES', '控えが揃っていません')
  }
  if (!backup.archive || !path.isAbsolute(backup.archive)) {
    throw new Refused('BACKUP_PATH', '控えの置き場が絶対パスではありません')
  }
  // 控えが対象の中にあると、消すときに一緒に消える
  const realTarget = safeReal(target)
  const realArchive = safeReal(backup.archive)
  if (realArchive === realTarget || realArchive.startsWith(realTarget + path.sep)) {
    throw new Refused('BACKUP_INSIDE_TARGET', '控えが対象の中にあります（消すときに一緒に消えます）')
  }
  // 控えが本当に在るか（記録ではなく実物を見る）
  if (!fs.existsSync(backup.archive)) {
    throw new Refused('BACKUP_MISSING', '控えが見つかりません')
  }
  const st = fs.statSync(backup.archive)
  if (st.size !== backup.bytes) {
    throw new Refused('BACKUP_SIZE_MISMATCH', '控えが揃いませんでした')
  }
  // 利用者が取り違わっていないか
  if (backup.clientId && backup.clientId !== client.id) {
    throw new Refused('BACKUP_OTHER_CLIENT', '控えが一致しません')
  }

  return { ok: true, op, destructive: true, files: backup.files, bytes: backup.bytes }
}

/**
 * 存在しない場所でも、正しく解いた絶対パスを返す。
 *
 * これが無いと、次の食い違いで判定を誤る。
 *   macOS の /var は /private/var へのリンク。
 *   大元は realpath されて /private/var/… になるのに、
 *   まだ存在しない控えの置き場は path.resolve のままで /var/… だった。
 *   → 同じ場所なのに startsWith が false になり、
 *     「控えを大元の中に置く」が通ってしまった（＝消すときに控えも消える）。
 *
 * 実在する一番近い祖先まで遡って realpath し、残りを繋ぎ直す。
 */
export function resolveDeep(p) {
  const abs = path.resolve(p)
  const rest = []
  let cur = abs
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur)
    if (parent === cur) return abs
    rest.unshift(path.basename(cur))
    cur = parent
  }
  try { return path.join(fs.realpathSync(cur), ...rest) } catch { return abs }
}

function safeReal(p) { return resolveDeep(p) }

// ────────────────────────────────────────────────────────────
// 集める側（上り）の門
//
// 集める側もリンクを辿らない。辿ると件数が桁違いに増える環境がある
// （外向きのリンクが1本あるだけで、範囲の外がまるごと入る）。
//
// 消す側で間違えると利用者が気づく（動かなくなるから）。
// 集める側で間違えても誰も気づかない。手元は何も変わらず、成功として終わる。
// ────────────────────────────────────────────────────────────

/**
 * 大元の中の実体ファイルだけを集める。リンクは辿らない。
 * @param {string} root  大元（絶対パス・呼び出し側が決めたもの）
 * @param {object=} opt
 * @param {number=} opt.maxFileBytes  1ファイルの上限（超えたら集めず一覧に載せる）
 * @returns {{files:string[], bytes:number, links:object[], oversize:object[], outside:object[]}}
 */
// 🔴 機械が作るフォルダは集めない（名前で落とす）
//   .git … 中身が圧縮されているので、文字を探す門は原理的に届かない。
//          しかも過去に一度でも記録した鍵は、消したあとも objects に残り続ける。
//   node_modules … 依存。送っても使えず、量だけ増える。
//   ★この門は名前だけを見る＝位置の概念が無い。だから足せば必ず効く
//     （中身を見る門は「どこを読むか」が先にあるので、足しても届かないことがある）。
//   ★実測: 除いても、利用者が作ったファイルは1本も減らない。
const SKIP_DIRS = new Set(['.git', 'node_modules'])

export function collectFiles(root, opt = {}) {
  if (!root || !path.isAbsolute(root)) throw new Refused('COLLECT_ROOT', '大元が絶対パスではありません')
  if (!fs.existsSync(root)) throw new Refused('COLLECT_ROOT_MISSING', `大元が在りません: ${root}`)

  // 大元そのものがリンクの下にあることがあるので、こちらも解く
  const realRoot = fs.realpathSync(root)
  const max = Number.isInteger(opt.maxFileBytes) ? opt.maxFileBytes : null

  const files = [], links = [], oversize = [], outside = [], skippedDirs = []
  let bytes = 0

  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch (e) { return }               // 読めない場所は飛ばす（記録は残す）
    for (const e of entries) {
      const p = path.join(dir, e.name)

      // ① リンクは辿らない。中身を読まず、指し先だけ記録する
      if (e.isSymbolicLink()) {
        let to = null
        try { to = fs.realpathSync(p) } catch { to = null }
        const escapes = !to || (to !== realRoot && !to.startsWith(realRoot + path.sep))
        links.push({ path: p, to, escapes })
        continue
      }

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { skippedDirs.push({ path: p, name: e.name }); continue }
        walk(p); continue
      }
      if (!e.isFile()) continue        // ソケット・FIFO・デバイスは集めない

      // ② 実体も realpath して 大元の中か確かめる（ハードリンク・マウント越え対策）
      let real
      try { real = fs.realpathSync(p) } catch { continue }
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        outside.push({ path: p, real })
        continue
      }

      let st
      try { st = fs.statSync(p) } catch { continue }
      if (max !== null && st.size > max) { oversize.push({ path: p, bytes: st.size }); continue }

      files.push(p)
      bytes += st.size
    }
  }
  walk(realRoot)
  return { files, bytes, links, oversize, outside, skippedDirs }
}

/**
 * 集めた結果が、送ってよい形かを確かめる。
 * 「0件だから安全」ではなく「外に出るものが0件で、中のものがN件ある」ことを見る。
 */
export function assertCollectSafe(result, { minFiles = 1 } = {}) {
  if (!result || !Array.isArray(result.files)) throw new Refused('COLLECT_SHAPE', '集めた結果の形が違います')
  if (result.outside.length > 0) {
    throw new Refused('COLLECT_OUTSIDE', '範囲の外のものが混ざっています')
  }
  const escaping = result.links.filter(l => l.escapes)
  if (escaping.length > 0 && result.files.some(f => escaping.some(l => f.startsWith(l.path + path.sep)))) {
    throw new Refused('COLLECT_VIA_LINK', 'リンクの先のファイルが混ざっています')
  }
  if (result.files.length < minFiles) {
    throw new Refused('COLLECT_TOO_FEW', '集まりませんでした')
  }
  return { ok: true, files: result.files.length, bytes: result.bytes, skippedLinks: result.links.length }
}
