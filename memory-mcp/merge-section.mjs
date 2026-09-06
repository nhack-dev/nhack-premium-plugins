/* merge-section.mjs ── ★届いた 節を 指示書に 差し込む（★純粋な 関数）
 *
 * ★何を するか
 *   ① 印が 無い  → ★末尾に 足す（append）
 *   ② 印が 在る  → ★★その 間【だけ】差し替える（replace）
 *   ③ 中身が 同じ → ★★★1文字も 書かない（noop）
 *   ④ 印が 壊れている → 🔴 ★断る（refuse）。★★推測で 直しません
 *   ⑤ 🔴 お客様が 印の【中】を 手で 直していた → ★★その中身を 返す（★消す前に 渡す）
 *      （★実測: ★★渡さないと 上書きで 消えます。★★★お客様の 情報を 失います）
 *
 * ★★①②とも【印の 外】は 1文字も 触りません。
 *   → お客様が ご自身で 書かれた ところは そのまま 残ります。
 *
 * ★★★③が 大事です。
 *   同じ 中身を 書き直すと ★更新時刻が 変わります。
 *   → ★★変わっていない ものは 触らない。★これが 既定です。
 *
 * ★口は 持ちません（★書き込みも 通信も しません）。呼ぶ側が 決めます。
 */

import { createHash } from 'crypto'

/** ★中身の 指紋（★前に こちらが 書いた ものと 同じか 見るため）
 *  ★★呼ぶ側も この 関数を 使う。★同じ 計算を 2箇所に 書かない */
export function sectionSha(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** ★印の 出現位置を 全部 数える（★1個 だけとは 限らない） */
function findAll(text, needle) {
  const at = []
  let i = 0
  while (true) {
    const n = text.indexOf(needle, i)
    if (n < 0) break
    at.push(n)
    i = n + needle.length     // ★重ならないように 進める
  }
  return at
}

/**
 * @param {string} existing お客様の いまの 中身（★空文字も 可）
 * @param {string} section  届いた 節（★印は 含めない）
 * @param {{begin:string,end:string}} marker 節を 囲む 印
 * @param {{lastSha?:string}} [opts] ★前に こちらが 書いた 節の 指紋
 * @returns {{text:string|null, mode:'append'|'replace'|'noop'|'refuse'|'replace-edited',
 *            reason:string, edited?:string}}
 */
export function mergeSection(existing, section, marker, opts = {}) {
  if (typeof existing !== 'string') return { text: null, mode: 'refuse', reason: '中身が 文字列では ありません' }
  if (typeof section !== 'string')  return { text: null, mode: 'refuse', reason: '節が 文字列では ありません' }
  const begin = marker && marker.begin
  const end   = marker && marker.end
  if (!begin || !end) return { text: null, mode: 'refuse', reason: '印が 空です' }
  if (begin === end)  return { text: null, mode: 'refuse', reason: '始めと 終わりの 印が 同じです' }

  // ★節の 中に 印が 入っていたら 断る（★入れ子に なると 次から 数が 合わなくなる）
  if (section.includes(begin) || section.includes(end)) {
    return { text: null, mode: 'refuse', reason: '節の 中に 印が 入っています' }
  }

  const b = findAll(existing, begin)
  const e = findAll(existing, end)

  // ── ① 印が 無い → 末尾に 足す
  if (b.length === 0 && e.length === 0) {
    const sep = existing === '' ? '' : (existing.endsWith('\n') ? '\n' : '\n\n')
    return { text: existing + sep + begin + '\n' + section + '\n' + end + '\n', mode: 'append', reason: '印が 無いので 末尾に 足しました' }
  }

  // ── ④ 壊れている → 断る（★片方だけ／複数／順序が 逆）
  if (b.length !== 1 || e.length !== 1) {
    return { text: null, mode: 'refuse', reason: `印の 数が 合いません（始め ${b.length} 個 ／ 終わり ${e.length} 個）` }
  }
  if (e[0] < b[0] + begin.length) {
    return { text: null, mode: 'refuse', reason: '終わりの 印が 始めより 前に あります' }
  }

  // ── ②③ 間だけ 差し替える
  const head = existing.slice(0, b[0])
  const tail = existing.slice(e[0] + end.length)
  const now  = existing.slice(b[0] + begin.length, e[0])
  const next = '\n' + section + '\n'
  if (now === next) return { text: existing, mode: 'noop', reason: '中身が 同じなので 書きません' }

  // 🔴 ★お客様が 印の【中】を 手で 直していないか
  //   ★前に こちらが 書いた 指紋と 違えば、★★お客様が 触られています。
  //   ★★★消す前に その 中身を 返します（★呼ぶ側が 控えを 取れるように）。
  //   ★lastSha を 渡さない ときは 見ません（★これまでと 同じ 動き）。
  const lastSha = opts && opts.lastSha
  if (lastSha && sectionSha(now) !== lastSha) {
    return {
      text: head + begin + next + end + tail,
      mode: 'replace-edited',
      reason: '印の中が 変わっています',
      edited: now,
    }
  }

  return { text: head + begin + next + end + tail, mode: 'replace', reason: '印の 間だけ 差し替えました' }
}
