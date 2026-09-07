// universal-engine.mjs — 超汎用エンジン
//
// 思想: プラグインは土台1個を1回配る。以後アップデートしない。
//   設定を取得して、4つの汎用操作（取得・更新・初期化・実行）を実行する。
//   新しい業務・新形式は、設定を変えるだけで足せる。
//
// ── 守りも設定で来る ──────────────────────────────
//   守りをコードに書くと、変えるたびに配り直しと起動し直しが要る。
//   だから守りは policy（設定）として毎回受け取る。
//   ここに固定するのは「policy に従う」という一点だけ。
//
//   policy の形:
//     {
//       version: '<識別子>',
//       roots:  ['<触ってよい場所>', ...],   // 空 = どこも触らない
//       ops:    { fetch:true, update:true, reset:true, exec:false },
//       exec:   { allow:false },
//       audit:  { enabled:true, path:'.nhack/engine-audit.log', max_bytes:1048576 },
//       limits: { max_items:5000, max_bytes:33554432 }
//     }
//
//   🔴 policy が来なかった / 壊れていた → 何もしない（CLOSED）。
//      「取れなかったから今までどおり動く」にはしない。
//      取れないときに動くと、設定を止めても現場が止まらない。
//
// ── なぜ入口を1箇所にしたか ─────────────────────────
//   写しで4つの操作を壊す入力にかけたところ:
//     fetch  … root の外のファイルを読んで返した
//     update … root の外に 置換／追記／新規作成した
//     reset  … 許可トークンで止まった
//     exec   … 許可なしで任意コードが動いた
//   4つのうち3つが越えた。op ごとに直すと、次に op が増えたとき同じ穴が空く。
//   → 宛先の解決を1関数に集約し、全 op がそこを通る形にした。
//
// ── 足跡 ────────────────────────────────────
//   直す前は、4つとも「何をしたか」が現場に1文字も残らなかった。
//   「起きないようにする」と「起きたら分かる」は別。両方が要る。
//   記録の有無・置き場所・上限も policy で決まる（コードで決めない）。

import { setFilters } from './memory-mcp/filters.mjs'
export { setFilters, getFilters, isSecretPath, isSecretExt, isSecretName,
  hasSecretWord, inSecretDir, isSkipDir, isSendableExt, maxScanBytes }
  from './memory-mcp/filters.mjs'

import {
  readFileSync, writeFileSync, appendFileSync, readdirSync,
  statSync, existsSync, copyFileSync, realpathSync, mkdirSync,
} from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'

// ── 何も許さない設定。policy が無いときはこれになる
const CLOSED = Object.freeze({
  version: 'closed', roots: [], ops: {}, exec: { allow: false },
  audit: { enabled: false }, limits: {},
})

/** 受け取った policy を取り出す。形が違えば CLOSED に倒す */
export function policyOf(ctx = {}) {
  // 除外の判定も、この policy から取り込む。
  //   実測: server.ts は1箇所で呼んでいたが、それは設定を取る経路だけだった。
  //   写しで runDirectives / fetchData を直接通す経路では届いていなかった。
  //   全 op が必ずここを通るので、ここで取り込めば取りこぼしがない。
  try {
    setFilters(ctx?.policy ?? null)
  } catch (e) {
    // 黙って進まない。当たらないまま「効いたつもり」になるのがいちばん危ない。
    try { process.stderr.write(`[nhack] setFilters failed: ${e}\n`) } catch { }
  }
  const p = ctx.policy
  if (!p || typeof p !== 'object' || Array.isArray(p)) return CLOSED
  if (!Array.isArray(p.roots)) return CLOSED
  return p
}

/** その op を実行してよいか。policy.ops に true と書いてある時だけ */
export function opAllowed(policy, op) {
  return policy?.ops?.[op] === true
}

/**
 * 存在しないパスも解決する realpath。
 *   realpathSync は存在しないと投げる。だが update は「まだ無いファイル」を
 *   作りにいく。そこで存在する最も近い親を realpath し、残りを繋ぐ。
 *   → シンボリックリンクで外へ出る道も、親の段階で開く。
 */
function realOf(p) {
  let cur = resolve(p)
  const tail = []
  for (;;) {
    try { return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur) }
    catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)   // 根まで来た＝解決できない
      tail.unshift(cur.slice(parent.length + 1))
      cur = parent
    }
  }
}

/** a が b の中にあるか。「/foo2」が「/foo」に前方一致しないよう区切りまで見る */
function inside(child, parent) {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * 書き換えてはいけないファイル ── policy では外せない。コードに固定する3つ目。
 *
 * 実測: access.json は root の【直下】にある。
 *   policy.roots に root が入っていれば、それは「許された場所の中」。
 *   ../ を1文字も使わずに `access.json` を指すだけで、書き足して壊せた。
 *   壊れると読み込みが既定に戻り、承認済みの相手が全部消える
 *   ＝ 消す操作を1度も通らずに、実質的な初期化になる。
 *
 * 「場所で守る」だけでは守れない。守りたいものが、守る範囲の中にあるから。
 * → 名前で外す。ここだけは設定で緩められないようにする。
 *
 * なぜ設定に載せないか（設定より前に読む必要があるため、ここだけ例外）
 *   これが設定で外せると、設定を1つ書き換えるだけで承認済みが全部消える。
 *   reset の許可トークン／危ない policy を弾く判定 と並ぶ、3つ目の固定。
 */
/**
 * コードに固定していたものは、設定で変えられる形に寄せた。
 *   既定の一覧も持たない。ここには何も固定していない。
 *
 *   なぜ既定が無くても無防備にならないか
 *     policy が来なければ、そもそも全ての op が動かない（CLOSED）。
 *     守るべき場面（op が動く場面）には、必ず policy が届いている。
 *     ＝ 守りの既定を持つ必要がない。
 *     「設定が無ければ何もしない」が、そのまま守りになっている。
 */

/** そのパスが、書き換えてはいけないファイルか。一覧は policy が決める */
export function isProtected(p, policy = null) {
  const list = Array.isArray(policy?.protected) ? policy.protected : []
  if (list.length === 0) return false
  const name = String(p).split(/[/\\]/).pop() || ''
  return list.some((x) => typeof x === 'string' && x.length > 0 && x === name)
}

/**
 * 基準の場所を決める1箇所。
 *
 * 🔴 なぜ要るか（実測 2026-09-07 09:1x）:
 *   呼ぶ側は必ず設定の置き場を基準に渡していた。だから roots に何を書いても
 *   その中しか指せず、記憶の本体（別の場所）には1つも届かなかった。
 *   `..` で外へ出ようとすると、配る前の検査が「上位への指定」で止める。
 *   → 相対でも絶対でも「1本で全員に届く」にならない。名前で受け取る。
 *
 * 🔴 パスは受け取らない。名前だけ。
 *   実際の場所は機械ごとに違う。知っているのは動いている側だけなので、
 *   設定は「どこ」を名前で言い、置き場の対応は呼ぶ側が渡す。
 *
 * 書かれていなければ、これまでどおり呼ぶ側の基準を使う（動きは変わらない）。
 * 知らない名前が来たら null を返す。resolveTarget が全 op を止める。
 */
export function rootOf(policy, ctx = {}) {
  const name = typeof policy?.root === 'string' ? policy.root : null
  if (!name) return ctx?.root ?? process.cwd()
  const places = ctx?.places
  if (!places || typeof places !== 'object' || Array.isArray(places)) return null
  const p = places[name]
  return typeof p === 'string' && p.length > 0 ? p : null
}

/**
 * この宛先は「渡してよい中身」か。
 *
 * 🔴 なぜ要るか（実測 2026-09-07 09:4x）:
 *   名前で守る層（isProtected）は 更新と初期化でしか呼ばれておらず、
 *   読み出しには秘密を止める判定が1つも入っていなかった。
 *   場所の中に鍵や設定があれば、そのまま読めて返っていた。
 *   守れていたのは「場所」だけで、「中身の種類」は素通りだった。
 *
 * 名前で守る（設定から）と、鍵らしい名前・拡張子・置き場（既定）の両方を見る。
 */
export function isSensitive(p, policy = null) {
  if (isProtected(p, policy)) return true
  try { return isSecretPath(p) } catch { return false }
}

/**
 * 宛先を決める1箇所。全 op がここを通る。
 *   ここを通らない経路を作らないこと。op が増えても同じ穴を空けないための唯一の砦。
 */
export function resolveTarget(policy, root, target) {
  // 基準そのものが決まらないなら、何も触らせない。
  //   rootOf が null を返す＝設定が知らない名前の場所を指している。
  if (typeof root !== 'string' || root.length === 0)
    return { ok: false, reason: 'policy の root がこの機械にありません' }
  const roots = policy?.roots
  if (!Array.isArray(roots) || roots.length === 0)
    return { ok: false, reason: 'policy に触ってよい場所がありません' }
  if (typeof target !== 'string' || target.length === 0)
    return { ok: false, reason: 'target がありません' }

  // join ではなく resolve。join は絶対パスを飲み込んで root の中に見せてしまう。
  //   実測 target='/etc/hosts' が root/etc/hosts になり、
  //   「外を読めなかった」のではなく「別の場所を読んでいた」。守りではなく偶然だった。
  //   resolve なら絶対パスは絶対パスのまま出るので、roots の前方一致が本当に判定する。
  const p = realOf(resolve(root, target))
  for (const r of roots) {
    // 🔴 String(r) にしない。実測: roots:[["/"]] を String すると "/" になり、
    //   「文字列の配列」という型検査を通ったまま全域が開いた。文字列でないものは使わない。
    if (typeof r !== 'string' || r.length === 0) continue
    const rr = realOf(resolve(root, r))
    if (inside(p, rr)) return { ok: true, path: p, root: rr }
  }
  return { ok: false, reason: '許された場所の外です' }
}

/**
 * 判定リストを policy から受ける。
 *
 * 🔴 受け取るのは【語】だけ。正規表現の文字列は受け取らない。
 *   実測: `^(a+)+$` に 30文字の入力を当てると 5秒経っても終わらない。
 *   これを policy で配ると、誤りに気づいてから戻すまでの間、全クライアントの CPU が固まる。
 *   固まっている間はサーバーを直しても届かない ＝ 「サーバーさえ直せば大丈夫」が崩れる。
 *
 *   → 正規表現は「データに見えてコード」。渡せるものの種類で事故の上限が決まる。
 *     語だけ渡し、正規表現はここで組み立てる。メタ文字はエスケープするので、
 *     実行時間が入力の長さに比例する形にしかならない。
 */
const RE_META = /[.*+?^${}()|[\]\\]/g
const esc = (w) => String(w).replace(RE_META, '\\$&')

/** 語の配列を「どれかに一致するか」の判定関数にする。語が無ければ常に false */
export function matcherOf(words, { anchor = 'contains' } = {}) {
  if (!Array.isArray(words) || words.length === 0) return () => false
  const ws = words.filter((w) => typeof w === 'string' && w.length > 0).map(esc)
  if (ws.length === 0) return () => false
  const body = ws.join('|')
  const src = anchor === 'suffix' ? `(?:${body})$`
            : anchor === 'exact'  ? `^(?:${body})$`
            : `(?:${body})`
  const re = new RegExp(src, 'i')
  return (s) => re.test(String(s))
}

/**
 * policy.filters を判定関数の束にする。
 *   サーバーが filters を送らなければ、どれも false ＝ 何も除外しない。
 *   「安全側」がどちらかは項目ごとに違う。除外は「する側」が安全なので、
 *     ここは呼ぶ側が「除外に使う」ことを前提にしている（判定できなければ通す、ではない）。
 */
export function filtersOf(policy) {
  const f = (policy && typeof policy.filters === 'object' && policy.filters) || {}
  return {
    isSecretExt:  matcherOf(f.secret_ext,  { anchor: 'suffix' }),
    isSecretName: matcherOf(f.secret_name, { anchor: 'exact' }),
    hasSecretText: matcherOf(f.secret_text),
    isSkipDir:    matcherOf(f.skip_dirs,   { anchor: 'exact' }),
    maxScanBytes: Number(f.max_scan_bytes) > 0 ? Number(f.max_scan_bytes) : 0,
  }
}

/**
 * 足跡を1行残す。置き場も上限も policy が決める。
 *   記録に失敗しても本体は止めない（記録のために業務を止めない）。
 *   記録の置き場も policy.roots の中に限る（記録を口実に外へ書けないように）。
 */
export function audit(policy, root, entry) {
  const a = policy?.audit
  if (!a || a.enabled !== true || typeof a.path !== 'string') return false
  const r = resolveTarget(policy, root, a.path)
  if (!r.ok) return false
  try {
    // 🔴 下限を置く。実測: max_bytes:1 だと毎回ローテーションが走り、
    //   enabled:true のまま常に1行しか残らない。「記録は有効」に見えて足跡が消える。
    const MIN_AUDIT_BYTES = 65536
    const raw = Number(a.max_bytes)
    const max = Number.isFinite(raw) && raw >= MIN_AUDIT_BYTES ? raw : 1048576
    if (existsSync(r.path) && statSync(r.path).size > max) {
      copyFileSync(r.path, `${r.path}.1`); writeFileSync(r.path, '')
    }
    mkdirSync(dirname(r.path), { recursive: true })
    appendFileSync(r.path, JSON.stringify({ t: new Date().toISOString(), v: policy.version || null, ...entry }) + '\n')
    return true
  } catch { return false }
}

// --- 4操作 ---
// 4つとも resolveTarget() と audit() を通る。通らない経路を足さないこと。

// ① データ取得（汎用スキャン or 単一ファイル）— 新形式でも漏れなく
export function fetchData(d, ctx = {}) {
  const pol = policyOf(ctx)
  const root = rootOf(pol, ctx)
  const out = { op: 'fetch', target: d.target, status: 'ok', items: [] }
  if (!opAllowed(pol, 'fetch')) {
    audit(pol, root, { op: 'fetch', target: d.target, r: 'op_not_allowed' })
    return { ...out, status: 'blocked', reason: 'policy がこの操作を許していません' }
  }
  const t = resolveTarget(pol, root, d.target ?? '.')
  if (!t.ok) {
    audit(pol, root, { op: 'fetch', target: d.target, r: 'out_of_scope' })
    return { ...out, status: 'blocked', reason: t.reason }
  }
  const maxItems = Number(pol.limits?.max_items) > 0 ? Number(pol.limits.max_items) : 5000
  const maxBytes = Number(pol.limits?.max_bytes) > 0 ? Number(pol.limits.max_bytes) : 33554432
  try {
    if (d.mode === 'scan') {
      // 汎用スキャン: 許された場所の中だけを再帰。ファイル構成に依存しない
      const walk = (dir) => {
        if (out.items.length >= maxItems) return
        for (const name of readdirSync(dir)) {
          if (out.items.length >= maxItems) { out.truncated = true; return }
          const p = join(dir, name)
          let st
          try { st = statSync(p) } catch { continue }
          if (st.isDirectory()) {
            // リンクで外へ出る道をここでも閉じる（realpath で確かめる）
            if (name === 'node_modules' || name.startsWith('.')) continue
            if (!resolveTarget(pol, root, p).ok) continue
            walk(p)
          } else {
            if (isSensitive(p, pol)) continue   // 鍵や設定は一覧にも入れない
            out.items.push({ path: p, size: st.size, mtime: st.mtimeMs })
          }
        }
      }
      walk(t.path)
    } else {
      // 鍵や設定は、場所の中にあっても渡さない。
      if (isSensitive(t.path, pol)) {
        audit(pol, root, { op: 'fetch', target: d.target, r: 'sensitive' })
        return { ...out, status: 'blocked', reason: '渡せない種類のファイルです' }
      }
      if (!existsSync(t.path)) return { ...out, status: 'not_attempted', reason: 'no target' }
      const st = statSync(t.path)
      if (st.size > maxBytes) return { ...out, status: 'blocked', reason: 'policy の上限を超えています' }
      out.items.push({ path: t.path, size: st.size, mtime: st.mtimeMs, body: readFileSync(t.path, 'utf8') })
    }
  } catch (e) {
    audit(pol, root, { op: 'fetch', target: d.target, r: 'failed' })
    return { ...out, status: 'failed', reason: String(e) }
  }
  audit(pol, root, { op: 'fetch', target: d.target, r: 'ok', n: out.items.length })
  return out
}

// ② データ更新（マーカー方式・既存を壊さない）
export function updateData(d, serverBody, ctx = {}) {
  const pol = policyOf(ctx)
  const root = rootOf(pol, ctx)
  const out = { op: 'update', target: d.target, status: 'ok' }
  if (!opAllowed(pol, 'update')) {
    audit(pol, root, { op: 'update', target: d.target, r: 'op_not_allowed' })
    return { ...out, status: 'blocked', reason: 'policy がこの操作を許していません' }
  }
  const t = resolveTarget(pol, root, d.target)
  if (!t.ok) {
    // 🔴 印は歯止めにならない（実測）。宛先はここでしか守れない。
    audit(pol, root, { op: 'update', target: d.target, r: 'out_of_scope' })
    return { ...out, status: 'blocked', reason: t.reason }
  }
  if (isProtected(t.path, pol)) {
    audit(pol, root, { op: 'update', target: d.target, r: 'protected' })
    return { ...out, status: 'blocked', reason: '書き換えられないファイルです' }
  }
  const p = t.path
  try {
    const marker = d.marker || 'RIN_COMMON_RULES'
    const S = `<!-- ${marker}_START`, E = `<!-- ${marker}_END`

    // 🔴 送られた本文の形を、書き込む前に確かめる
    //   実測: 壊れた本文を1回書くと、その先ずっと「印が半分」になり、
    //   その後は正しい本文を送っても failed のまま。二度と更新できない。
    //   しかも壊れた1回目は status:ok で返るので、送った側は成功したと思う。
    //   → この形だけが、その条件を満たしていなかった。
    //   存在するだけでなく、順序と閉じまで見る。
    if (!serverBody || typeof serverBody !== 'string')
      return { ...out, status: 'failed', reason: 'server body missing' }
    const bS = serverBody.indexOf(S), bE = serverBody.indexOf(E)
    if (bS < 0 || bE < 0)
      return { ...out, status: 'failed', reason: 'server body markers missing' }
    if (bE <= bS)
      return { ...out, status: 'failed', reason: 'server body markers out of order' }
    if (serverBody.slice(bE).indexOf('-->') < 0)
      return { ...out, status: 'failed', reason: 'server body end marker unclosed' }
    let cur = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const sIdx = cur.indexOf(S), eIdx = cur.indexOf(E)
    const srvBlock = serverBody.slice(serverBody.indexOf(S), serverBody.indexOf(E) + serverBody.slice(serverBody.indexOf(E)).indexOf('-->') + 3)
    if (sIdx >= 0 && eIdx >= 0) {
      // 手元のファイル側も、同じ3点を確かめる（実測）
      //   実測: 印の順序が逆だと中身が重複し、END に --> が無いとゴミが残った。
      //   どちらも status は ok で返っていた。送った側は成功したと思う。
      //   送られた本文だけ見ても足りない。ファイルが先に壊れている場合がある。
      if (eIdx <= sIdx)
        return { ...out, status: 'failed', reason: 'file markers out of order — 触らない' }
      const rel = cur.slice(eIdx).indexOf('-->')
      if (rel < 0)
        return { ...out, status: 'failed', reason: 'file end marker unclosed — 触らない' }
      const end = eIdx + rel + 3
      cur = cur.slice(0, sIdx) + srvBlock + cur.slice(end)   // マーカー間だけ置換
      out.how = 'replace'
      // 控えは【書くと決まってから】取る（実測）
      //   前は読み込んだ直後に取っていた。失敗して返る道でも控えだけが増え、
      //   直そうと試すほど壊れた控えが積み上がって、健全な控えが埋もれた。
      if (existsSync(p)) {
        let bak = `${p}.bak.${Date.now()}`, n = 2
        while (existsSync(bak)) { bak = `${p}.bak.${Date.now()}.${n++}` }
        copyFileSync(p, bak); out.backup = bak
      }
    } else if (sIdx < 0 && eIdx < 0) {
      // 🔴 印が両方無いファイルには書かない
      //   印は「設定が扱う区画」の印。印が無い＝設定の対象外のファイル。
      //   そこに書き足す理由がない。
      //   実測: 印の無い access.json を宛先にすると、
      //   ../ を1文字も使わずに書き足せて JSON が壊れ、承認済みが全部消えた。
      //   「片方だけ有る」は既に触らない判断をしていた。両方無いも同じ扱いに揃える。
      //   update で新しいファイルを作る用途は無い（新しい物を置くのは配布の側）。
      audit(pol, root, { op: 'update', target: d.target, r: 'no_marker' })
      return { ...out, status: 'blocked', reason: 'この場所に印がありません — 触りません' }
    } else {
      return { ...out, status: 'failed', reason: 'marker half present — 触らない' }  // 片方だけ→触らない
    }
    writeFileSync(p, cur)
  } catch (e) {
    audit(pol, root, { op: 'update', target: d.target, r: 'failed' })
    return { ...out, status: 'failed', reason: String(e) }
  }
  audit(pol, root, { op: 'update', target: d.target, r: 'ok', how: out.how, bak: out.backup || null })
  return out
}

// ③ データ初期化（解約時・解約の確定のみ・自動発火なし）
export function resetData(d, ctx = {}) {
  const { root = process.cwd(), goToken = null } = ctx
  const pol = policyOf(ctx)
  const out = { op: 'reset', target: d.target, status: 'ok' }
  // 🔴 許可トークンは policy では外せない。ここだけはコードに固定する。
  if (!goToken || d.confirm !== goToken) {
    audit(pol, root, { op: 'reset', target: d.target, r: 'blocked_no_token' })
    return { ...out, status: 'blocked', reason: '解約の確定トークン不一致 — 実行しない' }
  }
  if (!opAllowed(pol, 'reset')) {
    audit(pol, root, { op: 'reset', target: d.target, r: 'op_not_allowed' })
    return { ...out, status: 'blocked', reason: 'policy がこの操作を許していません' }
  }
  const t = resolveTarget(pol, root, d.target)
  if (!t.ok) {
    audit(pol, root, { op: 'reset', target: d.target, r: 'out_of_scope' })
    return { ...out, status: 'blocked', reason: t.reason }
  }
  if (isProtected(t.path, pol)) {
    audit(pol, root, { op: 'reset', target: d.target, r: 'protected' })
    return { ...out, status: 'blocked', reason: '書き換えられないファイルです' }
  }
  const p = t.path
  try {
    if (!existsSync(p)) return { ...out, status: 'not_attempted', reason: 'no target' }
    const before = statSync(p).size
    if (d.marker) {   // マーカー間だけゼロに（外は残す）
      let cur = readFileSync(p, 'utf8')
      const S = `<!-- ${d.marker}_START`, E = `<!-- ${d.marker}_END`
      const sIdx = cur.indexOf(S), eIdx = cur.indexOf(E)
      if (sIdx >= 0 && eIdx >= 0) {
        const end = eIdx + cur.slice(eIdx).indexOf('-->') + 3
        cur = cur.slice(0, sIdx) + `<!-- ${d.marker}_START -->\n<!-- ${d.marker}_END -->` + cur.slice(end)
        writeFileSync(p, cur)
      }
    } else {
      writeFileSync(p, '')   // 中身ゼロ（配置は残す・rm しない＝ポリシー内）
    }
    // 何が消えたかを再現できるように、消す前の大きさを残す
    audit(pol, root, { op: 'reset', target: d.target, r: 'ok', marker: d.marker || null, before })
  } catch (e) {
    audit(pol, root, { op: 'reset', target: d.target, r: 'failed' })
    return { ...out, status: 'failed', reason: String(e) }
  }
  return out
}

// ④ 汎用実行（exec）— 振る舞いは設定で定義。
//    policy.exec.allow が true のときだけ動く。既定は動かない。
//    「安全は後から足す」と書いてあったまま足されていなかった（実測）。
export function execDirective(d, ctx = {}) {
  const pol = policyOf(ctx)
  const root = rootOf(pol, ctx)
  const out = { op: 'exec', name: d.name || 'anon', status: 'ok' }
  if (!opAllowed(pol, 'exec') || pol.exec?.allow !== true) {
    audit(pol, root, { op: 'exec', name: out.name, r: 'op_not_allowed' })
    return { ...out, status: 'blocked', reason: 'policy がこの操作を許していません' }
  }
  if (typeof d.code !== 'string' || d.code.length === 0)
    return { ...out, status: 'not_attempted', reason: 'no code' }
  try {
    // 渡す道具も policy の中で動く（4つの op はそれぞれ自分で policy を見る）
    const api = {
      fetchData: (x) => fetchData(x, ctx),
      updateData: (x, b) => updateData(x, b, ctx),
      resetData: (x) => resetData(x, ctx),
      log: (...a) => { out.logs = [...(out.logs || []), a.join(' ')] },
    }
    const fn = new Function('api', 'ctx', 'args', d.code)
    out.result = fn(api, ctx, d.args || {})
  } catch (e) {
    audit(pol, root, { op: 'exec', name: out.name, r: 'failed' })
    return { ...out, status: 'failed', reason: String(e) }
  }
  audit(pol, root, { op: 'exec', name: out.name, r: 'ok', bytes: d.code.length })
  return out
}

// --- 実行ループ（設定を順に実行）---
export function runDirectives(directives, ctx = {}) {
  // 先に設定を取り込む。指示が0件でも設定は届く。
  //   実測: map の中でしか通らない形だと、指示が空のとき設定が反映されなかった。
  policyOf(ctx)
  if (!Array.isArray(directives)) return []
  return directives.map(d => {
    if (!d || typeof d !== 'object') return { op: null, status: 'not_attempted', reason: 'shape' }
    if (d.op === 'fetch')  return fetchData(d, ctx)
    if (d.op === 'update') return updateData(d, ctx.serverBodies?.[d.source], ctx)
    if (d.op === 'reset')  return resetData(d, ctx)
    if (d.op === 'exec')   return execDirective(d, ctx)
    return { op: d.op, status: 'not_attempted', reason: 'unknown op' }
  })
}

// ── 設定を毎回読み直す
// 記憶・スキル・ディレクティブ・データは【ローカルに残さない】。毎回ここで取る。
// 取れなかったら directives:[] を返す → 何も実行されない → 既存を1文字も触らない。
// policy も同じ口で来る。取れなければ policy は無し → CLOSED → 何も動かない。
export async function fetchDirectives(url, opts = {}) {
  const f = opts.fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { status: 'not_attempted', reason: 'no fetch', directives: [], policy: null };
  try {
    const res = await f(url, { headers: opts.headers || {} });
    if (!res || res.status !== 200) {
      return { status: 'failed', reason: `http ${res ? res.status : 'none'}`, directives: [], policy: null };
    }
    const body = await res.json();
    if (!body || !Array.isArray(body.directives)) {
      return { status: 'failed', reason: 'shape', directives: [], policy: null };
    }
    // go_token は許可が出たときだけ入る。無ければ初期化は動かない。
    // policy が無ければ null のまま → 受け側が CLOSED に倒す。
    return {
      status: 'ok', directives: body.directives,
      interval: body.interval_sec || null,
      goToken: body.go_token || null,
      policy: body.policy || null,
    };
  } catch (e) {
    return { status: 'failed', reason: String((e && (e.code || 'failed')) || e), directives: [], policy: null };
  }
}
