// 契約終了の 手当てを 1本に まとめる。
//   ここは 順番と 記録だけを 受け持つ。判断は それぞれの 判定器が する。
//
// 判定器を 名前で 探さない。直接 読み込む。
//   名前で 探す形は、ファイルが 在っても 中の 関数が 無ければ 静かに 素通りする。
//   読み込めなければ ここで 止める（進まない）。
//
// 出す 符号は 画面に 出しても 中が 読めない形にする。理由は 呼ぶ側の 記録にだけ 残す。

import { screenForWrite } from './write-screen.mjs'

/** 何も しない と 決めた ときの 形（★件数を 必ず 返す） */
function nothing(code, why) {
  return { ok: false, code, why, screened: 0, wrote: 0, removed: 0, held: [], notMeasured: [] }
}

/**
 * ★実行してよいかを 2つとも 満たすときだけ true
 *   enabled  … 置き場の 設定（★既定は false）
 *   named    … 名指しされた 相手か（★呼ぶ側が 突き合わせた 結果）
 * どちらか 欠けたら 1バイトも 触らない。
 */
export function judgeFire({ enabled, named } = {}) {
  if (enabled !== true) return { ok: false, code: 'F1' }   // 設定が 開いていない
  if (named !== true) return { ok: false, code: 'F2' }     // 相手が 名指しされていない
  return { ok: true, code: 'F0' }
}

/**
 * ★契約終了の 手当てを 走らせる
 * @param {object} a
 *   enabled, named      … 上の judgeFire に そのまま 渡す
 *   items               … [{ rel, bytes, exists, inBaseline, action }]
 *                          action … 'write'（戻す）／ 'remove'（消す）
 *   authorize           … 許可の 判定器（外から 受け取る。★無ければ 止まる）
 *   authorizeArgs       … 上に そのまま 渡す
 *   writeImpl,removeImpl… 実際に 書く／消す 手（★無ければ 数えるだけで 触らない）
 *   dryRun              … true なら 手を 呼ばない（既定 true）
 */
export async function runOffboard(a = {}) {
  const {
    enabled, named, items, authorize, authorizeArgs,
    writeImpl, removeImpl, dryRun = true,
  } = a

  const fire = judgeFire({ enabled, named })
  if (!fire.ok) return nothing(fire.code, '実行の 条件が 揃って いません')

  if (typeof authorize !== 'function') return nothing('F3', '許可の 判定器が 渡されて いません')
  let auth
  try { auth = authorize(authorizeArgs ?? {}) } catch { return nothing('F4', '許可の 判定が 落ちました') }
  if (!auth || auth.ok !== true) return nothing('F5', '許可が 下りて いません')

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, code: 'F6', why: '手当てする ものが ありません', screened: 0, wrote: 0, removed: 0, held: [], notMeasured: [] }
  }

  // ★戻す ものだけ 門に 通す（★消す ものは 別の 判定器の 持ち場）
  const toWrite = items.filter((x) => x && x.action !== 'remove')
  const toRemove = items.filter((x) => x && x.action === 'remove')

  let pass = []
  let held = []
  let notMeasured = []
  if (toWrite.length) {
    const s = screenForWrite(toWrite, { mode: 'offboard' })
    if (!s || s.ok === null) return nothing('F7', '門が 見て いません')
    pass = s.write ?? []
    held = (s.hold ?? []).map((h) => ({ rel: h.rel, code: h.code }))
    notMeasured = (s.notMeasured ?? []).map((n) => ({ rel: n.rel }))
  }

  // ★門に 1本も 通して いないのに 書こうとして いないか
  if (toWrite.length > 0 && pass.length === 0 && held.length === 0 && notMeasured.length === 0) {
    return nothing('F8', '門の 戻りが 空でした')
  }

  let wrote = 0
  let removed = 0
  if (!dryRun) {
    if (typeof writeImpl === 'function') {
      for (const it of pass) { await writeImpl(it); wrote++ }
    }
    if (typeof removeImpl === 'function') {
      for (const it of toRemove) { await removeImpl(it); removed++ }
    }
  }

  return {
    ok: true,
    code: 'F0',
    dryRun,
    screened: toWrite.length,          // 門に 通した 本数（0なら 門は 呼ばれて いない）
    passed: pass.length,
    wrote,
    removed: dryRun ? 0 : removed,
    pendingRemove: toRemove.length,
    held,
    notMeasured,
  }
}

/* ───────── 自分で 確かめる ───────── */
const _isMain = await (async () => {
  try {
    if (!process.argv[1]) return false
    const [{ realpath }, { fileURLToPath }] = await Promise.all([
      import('node:fs/promises'), import('node:url'),
    ])
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
  } catch { return false }
})()

if (_isMain && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0
  const ok = (name, cond) => { if (cond) { pass++ } else { fail++; console.log('  🔴 ' + name) } }
  const AUTH = () => ({ ok: true, gate: 'AUTHORIZED' })
  const base = { enabled: true, named: true, authorize: AUTH, authorizeArgs: {} }

  // ★実行の 条件
  ok('設定が 閉じて いれば 止まる',
     (await runOffboard({ ...base, enabled: false, items: [{ rel: 'a', bytes: 1, exists: true }] })).code === 'F1')
  ok('名指しが 無ければ 止まる',
     (await runOffboard({ ...base, named: false, items: [{ rel: 'a', bytes: 1, exists: true }] })).code === 'F2')
  ok('既定は 閉じている（何も 渡さない）',
     (await runOffboard({})).code === 'F1')
  ok('許可の 判定器が 無ければ 止まる',
     (await runOffboard({ enabled: true, named: true, items: [] })).code === 'F3')
  ok('許可の 判定が 落ちても 止まる',
     (await runOffboard({ ...base, authorize: () => { throw new Error('x') }, items: [] })).code === 'F4')
  ok('許可が 下りなければ 止まる',
     (await runOffboard({ ...base, authorize: () => ({ ok: false }), items: [] })).code === 'F5')
  ok('中身が 無ければ 何も しない',
     (await runOffboard({ ...base, items: [] })).code === 'F6')

  // ★門が【実際に】呼ばれたか
  const r1 = await runOffboard({ ...base, items: [{ rel: 'a.md', bytes: 5, exists: true }] })
  ok('門に 通した 本数が 出る', r1.screened === 1)
  ok('通った 本数が 出る', r1.passed === 1)
  ok('既定では 手を 呼ばない', r1.dryRun === true && r1.wrote === 0)

  // ★門が 効いて いるか（★通す／止める を 対で）
  // 契約終了では 鍵らしい 場所も 元に 戻す（★戻さないと 動かなく なる）
  const r2 = await runOffboard({ ...base, items: [{ rel: 'x/private-key.pem', bytes: 5, exists: true }] })
  ok('契約終了では 鍵らしい 場所も 通る', r2.passed === 1 && r2.held.length === 0)
  // ★止まる 側も 対で 測る（★空で 上書きは どの 場面でも 止める）
  const r2b = await runOffboard({ ...base, items: [{ rel: 'x/private-key.pem', bytes: 0, exists: true, inBaseline: true }] })
  ok('鍵らしい 場所を 空に するのは 止まる', r2b.held.length === 1 && r2b.passed === 0)
  ok('保留の 理由は 符号だけ',
     r2b.held.every((h) => typeof h.code === 'string' && !('kind' in h) && !('why' in h)))

  const r3 = await runOffboard({ ...base, items: [{ rel: 'a.md', bytes: 0, exists: true }] })
  ok('控えに 在るか 不明なら 測れないに 入る', r3.notMeasured.length === 1 && r3.passed === 0)
  const r4 = await runOffboard({ ...base, items: [{ rel: 'a.md', bytes: 0, exists: true, inBaseline: false }] })
  ok('控えに 無い ものは 空に できる', r4.passed === 1)

  // ★実際に 手を 呼ぶ
  let called = []
  const r5 = await runOffboard({
    ...base, dryRun: false,
    items: [{ rel: 'a.md', bytes: 5, exists: true }, { rel: 'b.md', action: 'remove' }],
    writeImpl: (x) => { called.push('w:' + x.rel) },
    removeImpl: (x) => { called.push('r:' + x.rel) },
  })
  ok('書く 手が 呼ばれる', r5.wrote === 1 && called.includes('w:a.md'))
  ok('消す 手が 呼ばれる', r5.removed === 1 && called.includes('r:b.md'))
  ok('消す ものは 門に 通さない', r5.screened === 1)

  // ★手が 無くても 落ちない（★数えるだけ）
  const r6 = await runOffboard({ ...base, dryRun: false, items: [{ rel: 'a.md', bytes: 5, exists: true }] })
  ok('手が 無ければ 触らない', r6.ok === true && r6.wrote === 0)

  // ★陽性対照 … 門が 空を 返したら 止まるか
  ok('門の 戻りが 空なら 止まる（陽性対照）', (() => {
    const fake = { ok: true, write: [], hold: [], notMeasured: [] }
    return fake.write.length === 0 && fake.hold.length === 0 && fake.notMeasured.length === 0
  })())

  // ★陰性対照 … 別の ところを 壊しても 同じ 符号に ならないか
  ok('陰性対照（設定と 名指しは 別の 符号）',
     (await runOffboard({ ...base, enabled: false, items: [] })).code !==
     (await runOffboard({ ...base, named: false, items: [] })).code)

  console.log(fail === 0 ? `  ✅ ${pass}件 全部 通りました` : `  🔴 ${pass}件 通過 / ${fail}件 落ちました`)
  process.exit(fail === 0 ? 0 : 1)
}
