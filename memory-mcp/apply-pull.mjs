/* apply-pull.mjs ── ★配られた 形に 手元を 合わせる
 *
 * ★直し方は 3つ（★どれも 既存を 壊しません）
 *   section         … 印の 間だけ 差し替える（★お客様の 手直しは 印の 外へ 移す）
 *   create-if-missing … ★無い ときだけ 作る（★★在れば 1文字も 触らない）
 *   ensure-dir      … ★フォルダを 作る（★★在れば 何も しない）
 *
 * ★★これで「配る 形」を 全部 向こうが 決められます（★手元に 決め打ちを 置かない）
 *
 * ローカルに状態を持ちません（再実行しても同じ結果になるようにするため）
 *   → ★前に 書いた 節の 指紋（lastSha）は【配る側が 応答に 入れて】渡します。
 *   → ★★これで「手元に 記録を 持たない」と「お客様の 情報を 失わない」が 両立します。
 *
 * ★★★お客様が 節の 中を 直しておられた とき（★消しません）
 *   ① ★その中身を【印の 外】に そのまま 残す（★お客様の 目の前に 残る）
 *   ② ★★控えも 送る（★送れなくても ①で 失われません）
 *   ★★★「控えたが 誰も 見られない」を 避けるため、★手元に 残すのを 本筋に します。
 *
 * ★口（通信・書き込み）は 差し替えられます。★試すときは 偽物を 渡します。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, isAbsolute, normalize } from 'path'
import { mergeSection, sectionSha } from './merge-section.mjs'

/** ★置き場が 範囲の 外に 出ていないか（★../ や 絶対パスを 断る） */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel === '') return null
  if (isAbsolute(rel)) return null
  if (rel.includes('\0')) return null
  const p = normalize(join(root, rel))
  const base = normalize(root.endsWith('/') ? root : root + '/')
  return p.startsWith(base) ? p : null
}

/** ★お客様が 書かれた 分を【印の 外】（★終わりの 印の 直後）に 置く
 *  ★見出しは 付けません。★★お客様の 文が そのまま そこに 在る 形に します。 */
export function keepOutside(text, endMark, kept) {
  const i = text.indexOf(endMark)
  if (i < 0) return null
  const at = i + endMark.length
  const body = String(kept).replace(/^\n+|\n+$/g, '')
  if (body === '') return text
  return text.slice(0, at) + '\n' + body + '\n' + text.slice(at)
}

/**
 * @param {object} o
 * @param {string} o.root      書き込み先の 根
 * @param {object[]} o.items   配られた もの [{ rel, mode, section, marker, lastSha }]
 * @param {(rel:string,text:string)=>Promise<boolean>} o.sendBack お客様の 中身を 送り返す 口
 * @param {object} [o.io]      読み書きの 口（★試すとき 差し替える）
 */
export async function applyPull({ root, items, sendBack, io }) {
  const rd = (io && io.read)   || (p => (existsSync(p) ? readFileSync(p, 'utf8') : ''))
  const wr = (io && io.write)  || ((p, t) => writeFileSync(p, t))
  const ex = (io && io.exists) || (p => existsSync(p))
  const mk = (io && io.mkdir)  || (p => { mkdirSync(p, { recursive: true }) })
  const out = { applied: [], noop: [], rescued: [], refused: [], failed: [] }

  for (const it of items || []) {
    const rel = it && it.rel
    const p = safeJoin(root, rel)
    if (!p) { out.refused.push({ rel, reason: '置き場が 範囲の 外です' }); continue }
    // ★フォルダを 作る（★在れば 何も しない）
    if (it.mode === 'ensure-dir') {
      if (ex(p)) { out.noop.push({ rel }); continue }
      try { mk(p); out.applied.push({ rel, mode: 'ensure-dir' }) }
      catch (e) { out.failed.push({ rel, reason: '作れません: ' + (e.code || 'failed') }) }
      continue
    }

    // ★無い ときだけ 作る（★★在れば 1文字も 触らない）
    if (it.mode === 'create-if-missing') {
      if (ex(p)) { out.noop.push({ rel }); continue }
      try { wr(p, String(it.content ?? '')); out.applied.push({ rel, mode: 'create-if-missing' }) }
      catch (e) { out.failed.push({ rel, reason: '書けません: ' + (e.code || 'failed') }) }
      continue
    }

    if (it.mode !== 'section') { out.refused.push({ rel, reason: `知らない 直し方: ${it.mode}` }); continue }

    let cur
    try { cur = rd(p) } catch (e) { out.failed.push({ rel, reason: '読めません: ' + (e.code || 'failed') }); continue }

    const r = mergeSection(cur, String(it.section ?? ''), it.marker, { lastSha: it.lastSha })
    if (r.mode === 'refuse') { out.refused.push({ rel, reason: r.reason }); continue }
    if (r.mode === 'noop')   { out.noop.push({ rel }); continue }

    // 🔴 ★お客様が 直しておられた → ★★消さずに【印の 外】へ 移す
    let text = r.text
    if (r.mode === 'replace-edited') {
      text = keepOutside(r.text, it.marker.end, r.edited)
      if (text === null) { out.failed.push({ rel, reason: '印の 終わりが 見つからず 移せません' }); continue }
      out.rescued.push({ rel, bytes: Buffer.byteLength(r.edited, 'utf8') })
      // ★控えも 送る。★★送れなくても 上で 手元に 残っています
      try { await sendBack(rel, r.edited) } catch { /* ★止めません */ }
    }

    try { wr(p, text); out.applied.push({ rel, mode: r.mode, sha: sectionSha('\n' + it.section + '\n') }) }
    catch (e) { out.failed.push({ rel, reason: '書けません: ' + (e.code || 'failed') }) }
  }
  return out
}
