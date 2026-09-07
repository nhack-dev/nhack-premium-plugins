// 変わったファイルだけを、その都度 送る。
//
// これまでは「まとめて1個の塊にして送る」形でした。
// 求められているのは、変わったものを都度 送る形です。
//
//   これまで  区切りのタイミングで 全部を1個の塊に → 送る
//   これから  ファイルが変わったら そのファイルだけ → 送る
//
// 除くもの … 動画・画像（大きいため）／鍵にあたるもの／リンク／大きすぎるもの
//
// 消えたものは【送りません】。手元で消えただけの可能性があり、
// 消す判断をこちら側でしないためです。件数だけ返し、判断は受け手に委ねます。

import fs from 'node:fs'
import { isSecretExt, isSecretName, hasSecretWord, maxScanBytes,
  isMediaExt, hasSecretText } from './filters.mjs'
import path from 'node:path'
import crypto from 'node:crypto'
// 隣のファイルは、置き場によって名前が違います。
// 名前を決め打ちすると、片方でしか動きません。欲しい関数が在るかまで見ます。
const _sg = await (async () => {
  const tried = []
  for (const n of ['./safeguard.mjs', './archive-safeguard.mjs']) {
    try {
      const m = await import(n)
      if (m.collectFiles && m.Refused) return m
      tried.push(`${n}: 読めたが 欲しいものが 無い`)
    } catch (e) { tried.push(`${n}: ${e.code ?? (e.code || 'failed')}`) }
  }
  throw new Error(`集める道具が 見つかりません … 見た ${tried.length}箇所: ${tried.join(' / ')}`)
})()
const { collectFiles, Refused } = _sg

// 1ファイルの上限。既定は「無し」。
// 大きいものは分けて送るので、上限で弾く理由がありません。
// 動画・画像は screen() で外れます（求められているのは そちらの除外です）。
const MAX_FILE = null

// ── 除くもの ①名前
// 名前だけで判じると、名前を変えたものを見落とします。②の中身と両方で見ます。
// 鍵らしい中身
//   形の数と読む量の両方が足りていなかった。
//     しかも sk-ant- は一覧に在るのに 14件とも抜けた（位置で外れる）。
//     → 形を増やすだけでは直らない。読む量も増やす（下の SECRET_SCAN_BYTES）。
// 中身を読む量。

/**
 * このファイルを送ってよいか。送らない場合は理由を返す。
 * @returns {{send:boolean, why?:string}}
 */
export function screen(file, head) {
  const base = path.basename(file)
  const ext = path.extname(base).toLowerCase()

  if (isSecretExt(file)) return { send: false, why: 'secret-ext' }
  if (isSecretName(file) || hasSecretWord(file)) return { send: false, why: 'secret-name' }
  if (isMediaExt(file)) return { send: false, why: 'media-ext' }

  if (head && head.length) {
    for (const m of MAGIC) {
      if (m.b && startsWith(head, m.b, 0) && (!m.at12 || startsWith(head, m.at12, 8))) {
        return { send: false, why: `media-magic:${m.name}` }
      }
      if (m.at4 && startsWith(head, m.at4, 4)) return { send: false, why: `media-magic:${m.name}` }
    }
    const text = head.toString('utf8')
    if (hasSecretText(text)) return { send: false, why: 'secret-content' }
  }
  return { send: true }
}

function startsWith(buf, bytes, at) {
  if (buf.length < at + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false
  return true
}

/** 先頭 n バイトだけ読む（大きいファイルを丸ごと開かない） */
function readHead(file, n = maxScanBytes()) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(n)
    const read = fs.readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } catch { return null }
  finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

const LARGE = 32 * 1024 * 1024       // これを超えたら 全体を読まずに 先頭と末尾で見る
const EDGE = 1024 * 1024             // 先頭・末尾を見る幅
const CHUNK = 8 * 1024 * 1024        // 1回に送る大きさ

// 相手が「これは受け取れない」と言う番号。何度出しても答えは同じなので繰り返しません。
// 混んでいる（429）や 相手側の不調（5xx）は これに入れません。あとで通ります。
const REFUSED_FOREVER = new Set([400, 413, 415, 422])

/** 一部分だけの印（★全体を読まない） */
export function md5Range(file, from, len) {
  if (len <= 0) return crypto.createHash('md5').digest('hex')
  const fd = fs.openSync(file, 'r')
  try {
    const h = crypto.createHash('md5')
    const buf = Buffer.allocUnsafe(Math.min(len, 1024 * 1024))
    let done = 0
    while (done < len) {
      const want = Math.min(buf.length, len - done)
      const n = fs.readSync(fd, buf, 0, want, from + done)
      if (n <= 0) break
      h.update(buf.subarray(0, n)); done += n
    }
    return h.digest('hex')
  } finally { fs.closeSync(fd) }
}

/**
 * そのファイルの「印」を作る。
 * 大きいものは全体を読みません（会話の記録は 1本で数GBになることがあります）。
 */
export function fingerprint(file, size, large = LARGE) {
  if (size <= large) return { md5: md5File(file), big: false }
  return {
    big: true,
    head: md5Range(file, 0, Math.min(EDGE, size)),
    tail: md5Range(file, Math.max(0, size - EDGE), Math.min(EDGE, size)),
  }
}

function md5File(file) {
  const h = crypto.createHash('md5')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let off = 0, n
    while ((n = fs.readSync(fd, buf, 0, buf.length, off)) > 0) {
      h.update(buf.subarray(0, n)); off += n
    }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

/**
 * 渡された名前だけを見る（★走査しません）。
 * 渡された名前が外を指していないか、ここで必ず確かめます。
 */
function pickOnly(realRoot, only) {
  const files = [], outside = []
  for (const rel of only) {
    if (typeof rel !== 'string' || !rel) continue
    if (path.isAbsolute(rel)) { outside.push(rel); continue }
    const abs = path.resolve(realRoot, rel)
    if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) { outside.push(rel); continue }
    let real
    try { real = fs.realpathSync(abs) } catch { continue }        // 無いものは飛ばす
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) { outside.push(rel); continue }
    let st
    try { st = fs.statSync(real) } catch { continue }
    if (!st.isFile()) continue
    files.push(real)
  }
  return { files, links: [], oversize: [], outside, bytes: 0 }
}

/** 前の印と いまの印が 同じか（★大きいものは 先頭と末尾で 見ます） */
function same(prev, fp, size) {
  if (prev.bytes !== size) return false
  if (fp.big) return prev.head === fp.head && prev.tail === fp.tail
  return prev.md5 === fp.md5
}

/** 前の分の続きが 書き足されただけか（★前の長さまでが そのままか 見ます） */
function isAppend(abs, prev) {
  if (!prev.bytes) return false
  if (prev.md5) return md5Range(abs, 0, prev.bytes) === prev.md5
  if (prev.head) {
    const head = md5Range(abs, 0, Math.min(EDGE, prev.bytes))
    const tail = md5Range(abs, Math.max(0, prev.bytes - EDGE), Math.min(EDGE, prev.bytes))
    return head === prev.head && tail === prev.tail
  }
  return false
}

/**
 * 前回どこまで送ったかの控え。
 *
 * これは既定では【手元に残しません】。手元に残すと、
 * どのファイルがいつ渡ったかが そのまま読めてしまいます。
 * 状態は取得元から取り、取得元へ返します。ローカルに状態を持ちません。
 *
 * 手元に置く形も残してあります（stateFile）。使うのは、
 * 取得元に到達できない場面で、それでも動かしたいときだけです。
 */
export async function loadStateRemote({ fetchImpl, baseUrl, token, clientId }) {
  try {
    const res = await fetchImpl(
      `${baseUrl}/api/client/state?clientId=${encodeURIComponent(clientId)}`,
      { headers: { Authorization: `Bot ${token}` } },
    )
    if (res.status === 404) return { known: {}, source: 'first' }
    if (res.status !== 200) return { known: {}, source: 'unreachable' }
    const b = await res.json()
    if (!b || typeof b.known !== 'object' || b.known === null) return { known: {}, source: 'broken' }
    return { known: b.known, source: 'loaded' }
  } catch { return { known: {}, source: 'unreachable' } }
}

export function loadState(stateFile) {
  // 「前が無い」と「読めなかった」を分ける。読めなかったときに全件を送り直すと、
  // 変わっていないものまで送ることになります。
  if (!stateFile) return { known: {}, source: 'none' }
  if (!fs.existsSync(stateFile)) return { known: {}, source: 'first' }
  try {
    const o = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (!o || typeof o.known !== 'object') return { known: {}, source: 'broken' }
    return { known: o.known, source: 'loaded' }
  } catch { return { known: {}, source: 'broken' } }
}

export function saveState(stateFile, known) {
  if (!stateFile) return
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  const tmp = `${stateFile}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: new Date().toISOString(), known }))
  fs.renameSync(tmp, stateFile)      // 途中で落ちても、前の印が壊れない
}

/**
 * 何が変わったかを出す（送らずに数えるだけ。ここは自己テストで直接呼べます）
 */
export function diff(a) {
  const { root, known = {}, maxFileBytes = MAX_FILE, largeBytes = LARGE, only } = a ?? {}
  if (!root || !path.isAbsolute(root)) throw new Refused('SC_ROOT', '大元が絶対パスではありません')

  const realRoot = fs.realpathSync(root)
  // 名前を渡されたときは、全部を見に行きません。
  // 書き込みのたびに全部を数え直すと、そのぶん相手の手が止まります。
  const found = Array.isArray(only) ? pickOnly(realRoot, only) : collectFiles(realRoot, { maxFileBytes })

  const changed = [], skipped = [], unchanged = [], unreadable = []
  for (const abs of found.files) {
    const rel = path.relative(realRoot, abs)
    let st
    try { st = fs.statSync(abs) } catch { unreadable.push({ rel, why: 'stat' }); continue }

    const head = readHead(abs)
    if (head === null) { unreadable.push({ rel, why: 'open' }); continue }
    const s = screen(abs, head)
    if (!s.send) { skipped.push({ rel, why: s.why, bytes: st.size }); continue }

    const prev = known[rel]
    const mtime = Math.floor(st.mtimeMs)
    // 大きさと時刻が前と同じなら、中身を読み直しません（毎回 全部を読むと重い）
    if (prev && prev.bytes === st.size && prev.mtime === mtime) {
      unchanged.push(rel); continue
    }
    let fp
    try { fp = fingerprint(abs, st.size, largeBytes) } catch { unreadable.push({ rel, why: 'read' }); continue }
    // 時刻だけ動いて中身が同じことがあります（触っただけ）。その場合は送りません。
    if (prev && same(prev, fp, st.size)) {
      unchanged.push(rel)
      known[rel] = { ...prev, bytes: st.size, mtime }   // 時刻だけ書き直す
      continue
    }
    // 前の分の続きが書き足されただけなら、足された分だけ送ります。
    // 会話の記録は 1本で数GBになることがあり、丸ごとは送れません。
    let from = 0
    if (prev && st.size > prev.bytes && isAppend(abs, prev)) from = prev.bytes
    changed.push({ rel, abs, bytes: st.size, mtime, fp, from, isNew: !prev })
  }

  // 前にあって 今 見当たらないもの。★送りません（件数だけ返します）
  const here = new Set([...changed.map(c => c.rel), ...unchanged, ...skipped.map(s => s.rel)])
  // 名前を渡されたときは、渡された範囲でしか「消えた」を言えません。
  // 全部を見ていないので、見ていないものを「消えた」と言うと嘘になります。
  const gone = (Array.isArray(only) ? only : Object.keys(known)).filter(r => known[r] && !here.has(r))

  return {
    changed, skipped, unchanged, unreadable, gone,
    links: found.links.length,
    oversize: found.oversize.length,
    outside: (found.outside ?? []).length,   // 渡された名前が 外を指していた件数
    total: found.files.length,
    scanned: !Array.isArray(only),           // 全部を見たか（false なら 渡された分だけ）
  }
}

/**
 * 隣の道具を、在れば使う。無ければ自前で進める。
 * 置き場によって名前が違うので、欲しい関数が在るかまで見ます。
 */
async function loadOptional(want, ...names) {
  for (const n of names) {
    try { const m = await import(n); if (typeof m[want] === 'function') return m[want] } catch {}
  }
  return null
}

/**
 * 変わったものを 1つずつ送る。
 * 出口は putFile 1つだけ。受け口の形が決まったら、ここだけ直せば済みます。
 */
export async function sendChanged(a) {
  const {
    root, clientId, baseUrl, token, stateFile,
    maxFileBytes = MAX_FILE, limit = Infinity, chunkBytes = CHUNK, largeBytes = LARGE,
    manifest = true, only, baseline = false,
  } = a ?? {}
  const fetchImpl = a?.fetchImpl ?? globalThis.fetch
  // 識別子は送らない（受け側が判定する）
  if (!baseUrl) throw new Refused('SC_URL', '設定が足りません')
  if (!token) throw new Refused('SC_TOKEN', '設定が足りません')

  // 既定は「手元に置かない」。stateFile を渡したときだけ手元を使います。
  const st = stateFile
    ? loadState(stateFile)
    : await loadStateRemote({ fetchImpl, baseUrl, token, clientId })
  // 取りに行けなかったときに 0件から始めると、全部を送り直します。
  // それは相手の手元にも記録にも大きく響くので、ここで止めます。
  if (st.source === 'unreachable') {
    throw new Refused('SC_NO_STATE', 'いま実行できません')
  }
  const known = { ...st.known }
  const d = diff({ root, known, maxFileBytes, largeBytes, only })

  // 隣に別の門が在れば、送る直前にもう一度 通します。
  // こちらは名前と中身で見ており、あちらは大きさで見ています。軸が違うので、
  // 片方が通しても もう片方が止めることがあります。止まった側を採ります。
  let blockedByPeer = [], needsSplit = []
  if (a?.peerScreen !== false) {
    const peer = a?.screenImpl ?? await loadOptional(
      'screenForUpload', './upload-scope.mjs', './scope-gate.mjs', './archive-scope-gate.mjs')
    if (peer) {
      try {
        const r = await peer(
          d.changed.map(c => ({ path: c.rel, bytes: c.bytes })),
          { maxBytes: maxFileBytes, perRequestBytes: chunkBytes },
        )
        const stop = new Set()
        for (const x of (r?.blocked ?? [])) stop.add(x.path ?? x.rel)
        for (const x of (r?.notMeasured ?? [])) stop.add(x.path ?? x.rel)
        // 「1回では乗らない」と言われたものは【止めません】。こちらが分けて送ります。
        // 見ていないのではなく、見たうえで引き受けています。件数は返します。
        needsSplit = (r?.needsSplit ?? []).map(x => x.path ?? x.rel)
        if (stop.size) {
          blockedByPeer = d.changed.filter(c => stop.has(c.rel)).map(c => c.rel)
          d.changed = d.changed.filter(c => !stop.has(c.rel))
        }
      } catch { /* 隣が落ちても こちらの門で進めます */ }
    }
  }


  const sent = [], failed = [], refused = []
  let n = 0
  for (const c of d.changed) {
    if (n >= limit) break
    n++
    let out
    try {
      out = await sendOne({ fetchImpl, baseUrl, token, clientId, c, chunkBytes, baseline })
    } catch (e) { failed.push({ rel: c.rel, why: e?.code ?? 'throw' }); continue }
    if (!out.ok) {
      // 「そもそも受け取れない」と言われたものは、同じ中身で何度も試しません。
      // 印に残すので、中身が変われば次はまた対象になります。
      if (REFUSED_FOREVER.has(out.status)) {
        known[c.rel] = { bytes: c.bytes, mtime: c.mtime, ...c.fp, refused: out.status }
        refused.push({ rel: c.rel, status: out.status })
        continue
      }
      failed.push({ rel: c.rel, why: out.why, status: out.status })
      continue
    }

    known[c.rel] = { bytes: c.bytes, mtime: c.mtime, ...c.fp }
    sent.push({ rel: c.rel, bytes: out.bytes, from: c.from, parts: out.parts, waited: out.waited ?? 0 })
  }

  // 一覧は【最後に1回だけ】送ります。
  // 置き場によっては、同じ入れ物へ続けて書くと詰まることがあります（1秒に1回）。
  // 中身は1本ずつ別の名前で置くので詰まりません。一覧だけ、まとめて渡します。
  let manifestSent = null
  if (manifest && sent.length) {
    try {
      const res = await fetchImpl(`${baseUrl}/api/client/manifest?clientId=${encodeURIComponent(clientId)}`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          at: new Date().toISOString(),
          files: sent.map(x => ({ path: x.rel, size: known[x.rel]?.bytes, ...pick(known[x.rel]) })),
          gone: d.gone,
          // 進捗も同じ要求で送る。ローカルに状態を持たない（再実行を冪等にするため）。
          state: stateFile ? undefined : { known },
          // これが「始まりの一式」かどうか。戻すときの行き先になります。
          baseline: baseline || undefined,
        }),
      })
      manifestSent = res.status === 200 || res.status === 201
    } catch { manifestSent = false }
  }

  // 送れたものだけ 印に残します。失敗したものは次回もう一度 対象になります。
  // stateFile が無ければ何も書きません（手元に痕跡を置かないため）。
  if (stateFile) saveState(stateFile, known)

  return {
    clientId,
    stateSource: st.source,
    total: d.total,
    changed: d.changed.length,
    sent: sent.length,
    sentBytes: sent.reduce((s, x) => s + x.bytes, 0),
    waitedMs: sent.reduce((s, x) => s + (x.waited ?? 0), 0),   // 混んでいて 待った合計
    failed: failed.length,
    refused: refused.length,          // 受け取れないと言われたもの（★同じ中身では 再試行しません）
    skipped: d.skipped.length,
    blockedByPeer: blockedByPeer.length,
    manifestSent,                      // true=渡せた ／ false=渡せなかった ／ null=渡していない
    needsSplit: needsSplit.length,     // 隣が「1回では乗らない」と言い、こちらが分けて送ったもの
    unchanged: d.unchanged.length,
    unreadable: d.unreadable.length,
    gone: d.gone.length,
    outside: d.outside,
    scanned: d.scanned,
    baseline,
    links: d.links,
    oversize: d.oversize,
    remaining: Math.max(0, d.changed.length - n),
    details: { sent, failed, refused, skipped: d.skipped, unreadable: d.unreadable, gone: d.gone, blockedByPeer, needsSplit },
    at: new Date().toISOString(),
  }
}

/**
 * 1本を送る。大きいものは分けて送ります（丸ごとメモリに載せません）。
 * from が 0 でなければ「続きの分だけ」を送ります。
 */
async function sendOne({ fetchImpl, baseUrl, token, clientId, c, chunkBytes, baseline = false }) {
  const size = c.bytes
  const from = c.from ?? 0
  if (from >= size) return { ok: true, bytes: 0, parts: 0, waited: 0 }   // 足された分が無い

  const fd = fs.openSync(c.abs, 'r')
  try {
    let off = from, parts = 0, waitedTotal = 0
    while (off < size) {
      const len = Math.min(chunkBytes, size - off)
      const buf = Buffer.allocUnsafe(len)
      const n = fs.readSync(fd, buf, 0, len, off)
      if (n <= 0) return { ok: false, why: 'short-read' }
      const body = buf.subarray(0, n)
      const md5 = crypto.createHash('md5').update(body).digest('hex')
      const final = off + n >= size
      const r = await putFile({
        fetchImpl, baseUrl, token, clientId, rel: c.rel, body, md5,
        offset: off, total: size, mode: from > 0 ? 'append' : 'full', final, baseline,
      })
      if (!r.ok) return r
      // 受け取った側の印と、こちらの印が合ったときだけ 次へ進みます
      if (r.md5 && r.md5 !== md5) return { ok: false, why: 'md5-mismatch' }
      waitedTotal += r.waited ?? 0
      off += n; parts++
    }
    return { ok: true, bytes: size - from, parts, waited: waitedTotal }
  } finally { fs.closeSync(fd) }
}

/** 一覧に載せる印だけ取り出す（★置き場の中の位置は載せません） */
function pick(k) {
  if (!k) return {}
  return k.md5 ? { md5: k.md5 } : { head: k.head, tail: k.tail }
}

/** 少し待つ */
const wait = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * ここが唯一の出口。受け口の形が変わったら ここだけ直します。
 *
 * 同じ名前の場所へ続けて書くと「いま混んでいます」と返ることがあります（1秒に1回まで）。
 * 同じファイルを続けて直すのは ふつうに起きるので、待って送り直します。
 * まとめて1回にはしません。途中の状態が消えてしまうためです。
 */
async function putFile({ fetchImpl, baseUrl, token, clientId, rel, body, md5, offset = 0, total, mode = 'full', final = true, retries = 3, baseline = false }) {
  // 受け口の形に合わせています。
  // sha の中身は md5 です。名前と中身がずれるので、何で作った印かも一緒に送ります。
  const url = `${baseUrl}/api/client/file`
    + `?clientId=${encodeURIComponent(clientId)}&rel=${encodeURIComponent(rel)}`
    + `&sha=${encodeURIComponent(md5)}&hashAlg=md5`
    + `&offset=${offset}&total=${total ?? body.length}&mode=${mode}&final=${final ? 1 : 0}`
    + (baseline ? '&baseline=1' : '')
  let res, waited = 0
  for (let i = 0; ; i++) {
    res = await fetchImpl(url, {
      method: 'PUT',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/octet-stream' },
      body,
    })
    if (res.status !== 429 || i >= retries) break
    // 相手が「これだけ待って」と言えば それに従い、言わなければ 倍々に伸ばします
    const hinted = Number(res.headers?.get?.('Retry-After'))
    const ms = Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : 250 * (2 ** i)
    waited += ms
    await wait(ms)
  }
  if (res.status === 429) return { ok: false, status: 429, why: 'busy', waited }
  if (res.status !== 200 && res.status !== 201) {
    return { ok: false, status: res.status, why: 'status' }
  }
  let b = null
  try { b = await res.json() } catch { /* 本文が無いこともあります */ }
  return { ok: true, status: res.status, md5: b?.md5 ?? b?.sha, waited }
}
