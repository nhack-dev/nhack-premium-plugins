/* ★書き戻す 前の ふるい ── ★受け取った ものを そのまま 書かない
 *
 * 🔴 なぜ 要るか（★ご指示の 原文から）
 *   「重要なのが、今の 継続して いる クライアントさんが 情報を 失わない こと」
 *   ★上書きは ★★消す ことでも あります
 *
 * 🔴 ここでは 書きません。★判定するだけ です。
 *   → ★書くか どうかは ★★呼ぶ側が 決めます
 *
 * 🔴 ★置き場所の 正しさ（範囲の 外・キーの 形）は ★★別の 判定器が 見ます
 *   → ★ここでは ★★★中身の 種類だけ 見ます（★2組に しない ため）
 */

/* ★鍵らしい もの … ★送る 側と 同じ 見方（★1つの 正本に する） */
const SECRET_RE = /(^|\/)(\.env|\.netrc|\.npmrc|\.git-credentials)|(^|[._-])(secret|token|credential|password|passwd|apikey|api_key|private[._-]?key)|\.(key|pem|p12|pfx|jks|keystore)$/i

/**
 * ★items … [{ rel, bytes, exists }]
 *   rel … 大元からの 相対パス
 *   bytes … 書こうとして いる 中身の 大きさ（★無ければ 測れて いない）
 *   exists … いま その 場所に ものが あるか（★呼ぶ側が 調べて 渡す）
 *
 * ★戻り … { ok, write, hold, notMeasured, limits }
 *   write … ★そのまま 書いて よい
 *   hold … ★★人の 判断が 要る（★止める では ありません）
 *   notMeasured … ★材料が 足りず 判定して いない
 */
export function screenForWrite(items, {
  allowSecretOverwrite = false,
  allowEmptyOverwrite = false,
  // 🔴 ★場面で 判定が 変わります（★決定）
  //   'daily'   … 日常の 運用（★既定）。★空で 上書きは 保留
  //   'offboard' … ★★お終いの ときの 片づけ。★★★空で 上書きが【目的】
  //   → ★offboard は ★★明示の 指示が あるときだけ 渡して ください
  mode = 'daily',
} = {}) {
  if (!Array.isArray(items)) {
    return { ok: null, reason: '一覧が 渡されて いません', write: [], hold: [], notMeasured: [] }
  }
  if (items.length === 0) {
    return { ok: null, reason: '一覧が 空です（見る ものが ありません）', write: [], hold: [], notMeasured: [] }
  }

  const write = []
  const hold = []
  const notMeasured = []

  for (const it of items) {
    const rel = typeof it === 'string' ? it : it && it.rel
    if (typeof rel !== 'string' || rel === '') {
      notMeasured.push({ item: it, why: '道筋が 読めません' })
      continue
    }
    const bytes = it && typeof it.bytes === 'number' ? it.bytes : null
    const exists = it && typeof it.exists === 'boolean' ? it.exists : null

    // 🔴 ★鍵の 入れ物を 上書きするか
    //   → ★消えると 動かなく なります
    //   → ★★これを 通してよいかは ★★★決めて いただく ことです（★既定は 保留）
    // 🔴 ★お終いの 場面では 鍵の 入れ物も 消す 対象です
    const secretOk = allowSecretOverwrite || mode === 'offboard'
    if (SECRET_RE.test(rel) && !secretOk) {
      hold.push({ rel, code: 'W1', kind: '鍵らしい 場所への 上書き', why: '消えると 動かなく なります' })
      continue
    }

    // 🔴 ★いま 在る ものを【空】で 上書きするか
    //   ★実測の 教訓 … ★★消すは 印だけ。★★★空で 上書きは 実体を 0に します
    // 🔴 ★お終いの 場面でも「消す」と「戻す」は 別です
    //   ★方針 … ★★はじめに 取った 控えに 在る ものは【戻す】
    //         ★★★控えに 無い ものは【消す】
    //   → ★時刻は 見ません。★★場所でも 決めません。★★★控えが 範囲です
    //   → ★材料（inBaseline）が 無ければ ★★判定しません
    const inBase = it && typeof it.inBaseline === 'boolean' ? it.inBaseline : null
    if (mode === 'offboard' && bytes === 0 && exists === true && inBase === null) {
      notMeasured.push({ rel, why: 'はじめの 控えに 在るか 分かりません（空に して よいか 決められません）' })
      continue
    }
    // ★控えに 無い … 空に して よい（★消す）
    // ★★控えに 在る … 空に しない（★★★戻すのは 控えの 中身であって 空では ない）
    const emptyOk = allowEmptyOverwrite || (mode === 'offboard' && inBase === false)
    if (exists === true && bytes === 0 && !emptyOk) {
      hold.push({ rel, code: 'W2', kind: '空で 上書き', why: 'いま 在る ものが 0に なります' })
      continue
    }

    // 🟡 ★在るか どうかが 分からない
    if (exists === null) {
      notMeasured.push({ rel, why: 'いま 在るかが 分かりません（上書きか 新規か 決められません）' })
      continue
    }

    // 🟡 ★大きさが 分からない
    if (bytes === null) {
      notMeasured.push({ rel, why: '中身の 大きさが 分かりません' })
      continue
    }

    write.push({ rel, bytes, exists })
  }

  return {
    // 1本も 見て いない ときだけ null。測れなかった ものも「見た」うちに 数える。
    ok: write.length + hold.length + notMeasured.length === 0 ? null : true,
    write,
    hold,
    notMeasured,
    limits: [
      '名前で 判定します（中身は 開きません）',
      'code は 画面に 出して よい 符号 ／ kind と why は 出さないで ください',
      '置き場所の 正しさ（範囲の 外・キーの 形）は ここでは 見ません',
      'お客様が 作った ものかは 判定して いません（材料が ありません）',
      allowSecretOverwrite ? '鍵らしい 場所も 通す 設定です' : '鍵らしい 場所は 保留します',
      allowEmptyOverwrite ? '空での 上書きも 通す 設定です' : '空での 上書きは 保留します',
      mode === 'offboard'
        ? '🔴 お終いの 場面です（構築の 後に 作られた ものだけ 空に できます）'
        : '日常の 運用です（お終いの 片づけには mode を 渡して ください）',
      mode === 'offboard'
        ? 'inBaseline を 渡して ください（無いと 空に する 判定を しません）'
        : 'はじめの 控えは ここでは 見て いません',
    ],
  }
}

/* ── 自己テスト ─────────────────────────── */
function selftest() {
  const t = []
  const ok = (name, cond) => t.push({ name, pass: !!cond })
  const S = (items, o) => screenForWrite(items, o)

  // ✅ 通るべき
  ok('ふつうの 上書きは 通る', S([{ rel: 'memory/a.md', bytes: 100, exists: true }]).write.length === 1)
  ok('新しく 作るのも 通る',   S([{ rel: 'memory/b.md', bytes: 100, exists: false }]).write.length === 1)
  ok('空の 新規は 通る（消して いません）',
     S([{ rel: 'memory/c.md', bytes: 0, exists: false }]).write.length === 1)

  // 🔴 保留すべき
  ok('鍵らしい 場所は 保留', S([{ rel: '.env', bytes: 10, exists: true }]).hold.length === 1)
  ok('空で 上書きは 保留',  S([{ rel: 'memory/a.md', bytes: 0, exists: true }]).hold.length === 1)

  // 🟡 測れない
  ok('在るか 不明なら 判定しない', S([{ rel: 'x.md', bytes: 1 }]).notMeasured.length === 1)
  ok('大きさ 不明なら 判定しない', S([{ rel: 'x.md', exists: true }]).notMeasured.length === 1)
  ok('一覧が 空なら ok は null',  S([]).ok === null)
  ok('一覧が 無ければ ok は null', S(null).ok === null)

  // ✅ 呼ぶ側が 決められる
  ok('鍵を 通す 設定なら 通る',
     S([{ rel: '.env', bytes: 10, exists: true }], { allowSecretOverwrite: true }).write.length === 1)
  ok('空を 通す 設定なら 通る',
     S([{ rel: 'a.md', bytes: 0, exists: true }], { allowEmptyOverwrite: true }).write.length === 1)

  // ✅ 陰性対照
  ok('陰性対照: 名前に env を 含むだけの 文書は 通る',
     S([{ rel: 'environment.md', bytes: 10, exists: true }]).write.length === 1)

  // 🔴 ★場面の 軸（★決定）
  ok('お終い ＋ 控えに 無い → 空に できる（消す）',
     S([{ rel: 'memory/a.md', bytes: 0, exists: true, inBaseline: false }],
       { mode: 'offboard' }).write.length === 1)
  ok('🔴 お終い ＋ 控えに 在る → 空に しない（戻すのは 控えの 中身）',
     S([{ rel: 'CLAUDE.md', bytes: 0, exists: true, inBaseline: true }],
       { mode: 'offboard' }).write.length === 0)
  ok('🟡 控えに 在るか 分からなければ 判定しない',
     S([{ rel: 'x.md', bytes: 0, exists: true }], { mode: 'offboard' }).notMeasured.length === 1)
  // 🔴 ★検体の 大きさを 0 から 変えました（★実装を 変えたら 測り方も 変える）
  //   ★0 だと ★★新しく 足した「空に して よいか」の 判定に 入ります
  //   → ★ここで 見たいのは【鍵の 入れ物か どうか】だけ です
  ok('お終いの 場面では 鍵の 入れ物も 通る',
     S([{ rel: '.env', bytes: 10, exists: true }], { mode: 'offboard' }).write.length === 1)
  ok('お終い ＋ 鍵 ＋ 空 ＋ 控えに 無い → 通る',
     S([{ rel: '.env', bytes: 0, exists: true, inBaseline: false }],
       { mode: 'offboard' }).write.length === 1)
  ok('陰性対照: 日常では どちらも 保留の まま',
     S([{ rel: '.env', bytes: 0, exists: true }]).hold.length === 1)

  // ✅ 陽性対照（★kind を 名指し）
  ok('陽性対照: 鍵の 判定が 生きて いる',
     S([{ rel: '.env', bytes: 1, exists: true }]).hold.some((h) => h.kind === '鍵らしい 場所への 上書き'))
  ok('陽性対照: 空の 判定が 生きて いる',
     S([{ rel: 'a.md', bytes: 0, exists: true }]).hold.some((h) => h.kind === '空で 上書き'))

  const bad = t.filter((x) => !x.pass)
  t.forEach((x) => console.log(`    ${x.pass ? '✅' : '🔴'} ${x.name}`))
  console.log(`\n    ${t.length - bad.length}/${t.length} ${bad.length ? '🔴 落ちました' : '✅ 合格'}`)
  return bad.length === 0 ? 0 : 1
}

const _isMain = await (async () => {
  try {
    if (!process.argv[1]) return false
    const [{ realpath }, { fileURLToPath }] = await Promise.all([
      import('node:fs/promises'), import('node:url'),
    ])
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
  } catch { return false }
})()
if (_isMain && process.argv[2] === '--selftest') process.exit(selftest())
