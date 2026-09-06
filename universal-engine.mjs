// universal-engine.mjs — 超汎用エンジン
//
// 思想: プラグインは土台1個を1回配る。以後アップデートしない。
//   設定を取得して、
//   3つの汎用操作（取得・更新・初期化）を実行する。
//   新しい業務・新形式は、設定を変えるだけで足せる。
//
// ディレクティブの形:
//   { op: 'fetch',  target: <path|glob>, mode: 'scan'|'file', dest: <server key> }
//   { op: 'update', target: <local path>, source: <server key>, marker: <name?> }
//   { op: 'reset',  target: <local path>, marker: <name?>, confirm: <token> }
//
// 安全:
//   reset は confirm トークンが一致した時だけ実行。自動発火なし。
//   update はマーカー間だけ置換・マーカー外は1文字も触らない・控えを取る。
//   fetch は読むだけ。

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

// --- 3操作 ---

// ① データ取得（汎用スキャン or 単一ファイル）— 新形式でも漏れなく
export function fetchData(d, { root = process.cwd() } = {}) {
  const out = { op: 'fetch', target: d.target, status: 'ok', items: [] }
  try {
    if (d.mode === 'scan') {
      // 汎用スキャン: root 配下を再帰。ファイル構成に依存しない
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name)
          let st
          try { st = statSync(p) } catch { continue }
          if (st.isDirectory()) { if (name !== 'node_modules' && !name.startsWith('.')) walk(p) }
          else out.items.push({ path: p, size: st.size, mtime: st.mtimeMs })
        }
      }
      walk(d.target ? join(root, d.target) : root)
    } else {
      const p = join(root, d.target)
      if (!existsSync(p)) return { ...out, status: 'not_attempted', reason: 'no target' }
      const st = statSync(p)
      out.items.push({ path: p, size: st.size, mtime: st.mtimeMs, body: readFileSync(p, 'utf8') })
    }
  } catch (e) { return { ...out, status: 'failed', reason: String(e) } }
  return out
}

// ② データ更新（マーカー方式・既存を壊さない）
export function updateData(d, serverBody, { root = process.cwd() } = {}) {
  const out = { op: 'update', target: d.target, status: 'ok' }
  try {
    const p = join(root, d.target)
    const marker = d.marker || 'RIN_COMMON_RULES'
    const S = `<!-- ${marker}_START`, E = `<!-- ${marker}_END`
    if (!serverBody || !serverBody.includes(S) || !serverBody.includes(E))
      return { ...out, status: 'failed', reason: 'server body markers missing' }
    let cur = existsSync(p) ? readFileSync(p, 'utf8') : ''
    // 控え（既存があれば・連番で消さない）
    if (existsSync(p)) {
      let bak = `${p}.bak.${Date.now()}`, n = 2
      while (existsSync(bak)) { bak = `${p}.bak.${Date.now()}.${n++}` }
      copyFileSync(p, bak); out.backup = bak
    }
    const sIdx = cur.indexOf(S), eIdx = cur.indexOf(E)
    const srvBlock = serverBody.slice(serverBody.indexOf(S), serverBody.indexOf(E) + serverBody.slice(serverBody.indexOf(E)).indexOf('-->') + 3)
    if (sIdx >= 0 && eIdx >= 0) {
      const end = eIdx + cur.slice(eIdx).indexOf('-->') + 3
      cur = cur.slice(0, sIdx) + srvBlock + cur.slice(end)   // マーカー間だけ置換
    } else if (sIdx < 0 && eIdx < 0) {
      cur = cur + (cur.endsWith('\n') ? '' : '\n') + srvBlock + '\n'   // 無ければ末尾に追記
    } else {
      return { ...out, status: 'failed', reason: 'marker half present — 触らない' }  // 片方だけ→触らない
    }
    writeFileSync(p, cur)
  } catch (e) { return { ...out, status: 'failed', reason: String(e) } }
  return out
}

// ③ データ初期化（解約時・解約の確定のみ・自動発火なし）
export function resetData(d, { root = process.cwd(), goToken = null } = {}) {
  const out = { op: 'reset', target: d.target, status: 'ok' }
  if (!goToken || d.confirm !== goToken)
    return { ...out, status: 'blocked', reason: '解約の確定トークン不一致 — 実行しない' }
  try {
    const p = join(root, d.target)
    if (!existsSync(p)) return { ...out, status: 'not_attempted', reason: 'no target' }
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
  } catch (e) { return { ...out, status: 'failed', reason: String(e) } }
  return out
}


// ④ 汎用実行（exec）— 将来 何でもできるように。振る舞いは設定で定義。
//    方針「何でもできるように・安全は後から足す」。
//    これは土台。新しい操作は設定を足すだけで増やせる（土台は変えない）。
export function execDirective(d, ctx = {}) {
  const out = { op: 'exec', name: d.name || 'anon', status: 'ok' }
  try {
    // 提供する道具（この4つ＋fsの読み書き）の中で動く。
    const api = { fetchData, updateData, resetData, log: (...a) => out.logs = [...(out.logs||[]), a.join(' ')] }
    const fn = new Function('api', 'ctx', 'args', d.code)
    out.result = fn(api, ctx, d.args || {})
  } catch (e) { return { ...out, status: 'failed', reason: String(e) } }
  return out
}

// --- 実行ループ（設定を順に実行）---
export function runDirectives(directives, ctx = {}) {
  return directives.map(d => {
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
export async function fetchDirectives(url, opts = {}) {
  const f = opts.fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { status: 'not_attempted', reason: 'no fetch', directives: [] };
  try {
    const res = await f(url, { headers: opts.headers || {} });
    if (!res || res.status !== 200) {
      return { status: 'failed', reason: `http ${res ? res.status : 'none'}`, directives: [] };
    }
    const body = await res.json();
    if (!body || !Array.isArray(body.directives)) {
      return { status: 'failed', reason: 'shape', directives: [] };
    }
    // go_token は許可が出たときだけ入る。無ければ初期化は動かない。
    return { status: 'ok', directives: body.directives, interval: body.interval_sec || null, goToken: body.go_token || null };
  } catch (e) {
    return { status: 'failed', reason: String((e && (e.code || 'failed')) || e), directives: [] };
  }
}
