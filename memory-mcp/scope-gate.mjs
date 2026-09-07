// 触ってよい範囲を確かめる。
//   ここでは判断しない。尋ねて、答えをそのまま返すだけ。
//   答えが得られないときは null を返す（呼ぶ側が決める）。

const DEFAULT_BASE = 'https://nhack-skill-server.sam-254.workers.dev'

/** ★まとめて 尋ねる（★1回の 通信で 全部）。★戻り値 … Map<rel, {ok, gate}> ／ 尋ねられなければ null */
export async function askScope(targets, { base = DEFAULT_BASE, timeoutMs = 8000, fetchImpl } = {}) {
  const list = (Array.isArray(targets) ? targets : [targets]).filter(x => typeof x === 'string')
  if (!list.length) return null
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!f) return null
  const ac = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
  try {
    const res = await f(`${base}/api/scope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: list }),
      signal: ac ? ac.signal : undefined,
    })
    if (!res || !res.ok) return null
    const ct = String(res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '')
    if (!ct.includes('json')) return null          // 存在しない口も 200 を返すことがある
    const body = await res.json()
    if (!body || typeof body !== 'object' || !('ok' in body)) return null
    const m = new Map()
    for (const r of (body.refused || [])) if (r && r.target) m.set(r.target, { ok: false, gate: r.gate })
    for (const t of list) if (!m.has(t)) m.set(t, { ok: true })
    return m
  } catch { return null }
  finally { if (timer) clearTimeout(timer) }
}

/** 呼び出し側に渡す形（その場で答える関数）にする */
export function toGate(map) {
  if (!map) return undefined                        // ★尋ねられなかった → ★★従来どおり（止めない）
  return (rel) => map.get(rel) || { ok: false, gate: 'NOT_ASKED' }
}

/* ─────────────────────────────────────────────
 * 送ってよいものかを 名前で 見る。
 *   ここでは 中身を 開かない。名前だけで 決める。
 *   止めた 理由は 符号で 返す（画面に 出しても 中が 読めない形）。
 * ───────────────────────────────────────────── */

// 🔴 区切りに「/」が無いと、フォルダ直下（a/secret.txt）が1件も落ちない。
//   位置の概念が無い門なので、語を足せば必ず当たる（中身を見る門とはここが違う）。
import { isSecretPath } from './filters.mjs'
const VIDEO_RE = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|mpg|mpeg)$/i
const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|ico|svg)$/i
const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i
// 中身が読めない・重い書類。テキストでないので送っても使えず、量だけ増える。
const DOC_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|tsv|ods|odt|rtf|pages|numbers|key|sqlite3?|db|zip|tar|gz|7z|dmg|pkg|exe|dll|so|dylib)$/i

/**
 * @param {Array<{path?:string, rel?:string, bytes?:number}>} files
 * @param {{maxBytes?:number|null, perRequestBytes?:number|null}} opt
 *   maxBytes … 既定は null（大きさでは 切らない）
 * @returns {{ok:boolean|null, send:object[], blocked:object[], needsSplit:object[], notMeasured:object[], limits:string[]}}
 */
export function screenForUpload(files, { maxBytes = null, perRequestBytes = null } = {}) {
  const empty = { send: [], blocked: [], needsSplit: [], notMeasured: [] }
  if (!Array.isArray(files)) return { ok: null, ...empty, limits: [] }
  if (files.length === 0) return { ok: null, ...empty, limits: [] }

  const send = [], blocked = [], needsSplit = [], notMeasured = []
  for (const f of files) {
    const p = f && (typeof f.path === 'string' ? f.path : typeof f.rel === 'string' ? f.rel : null)
    if (!p) { notMeasured.push({ path: null, why: '名前が ありません' }); continue }
    const bytes = f && Number.isFinite(f.bytes) ? f.bytes : null

    if (isSecretPath(p)) { blocked.push({ path: p, code: 'S1' }); continue }
    if (VIDEO_RE.test(p) || IMAGE_RE.test(p) || AUDIO_RE.test(p) || DOC_RE.test(p)) { blocked.push({ path: p, code: 'S2' }); continue }

    if (bytes === null) { notMeasured.push({ path: p, why: '大きさが 分かりません' }); continue }
    if (maxBytes !== null && bytes > maxBytes) { blocked.push({ path: p, code: 'S3' }); continue }
    if (perRequestBytes !== null && bytes > perRequestBytes) {
      needsSplit.push({ path: p, bytes }); continue
    }
    send.push({ path: p, bytes })
  }

  return {
    ok: send.length + blocked.length + needsSplit.length + notMeasured.length === 0 ? null : true,
    send, blocked, needsSplit, notMeasured,
    limits: [
      '名前で 判定します（中身は 開きません）',
      'code は 画面に 出してよい 符号。理由は 出しません',
      maxBytes === null ? '大きさでは 切りません' : '大きさの 上限が 入って います',
    ],
  }
}
