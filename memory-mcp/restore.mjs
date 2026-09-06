/* restore.mjs ── ★呼ぶ側の正本から【戻す】
 *
 * ★★判定は 1文字も 書きません。★★★契約（写しが最新か）を そのまま 呼びます
 *   → ★同じ判定を 2箇所に 書くと 必ず ずれます（★今日の型）
 *
 * ★★★書く口は _writeOne() の 1本だけ
 *   → ★検査は この 1本の 中に 置きます
 *   → ★★他の どこからも 書きません（★自己検査で 行範囲を 数えます）
 *
 * ★★2段（★書くのは、はっきり 呼ばれた ときだけ）
 *   plan()  … 測るだけ。★1バイトも 書かない
 *   apply() … 書く。★呼ぶ側が はっきり 呼んだ ときだけ
 *
 * 🔴 ★★★呼び方は【3つ】です
 *    直しました … ★★猶予（grace）の 考え方は 廃止しました
 *     理由 … 呼ぶ側で 全部 管理するので、猶予期間を 置く 必要が ありません
 *     → ★引数の graceDays も ★★RUN.GRACE も もう ありません
 *
 *   const r = judgeRunPermission(probe)
 *   ✅ RUN.ALLOW … apply(plan(recs), {...})   ← ★繋がって 許可あり → 戻す
 *   🔴 RUN.BLANK … blank(manifest, {...})     ← ★繋がって 不許可 → 空にする
 *   🟡 RUN.HOLD  … ★★何も呼ばない            ← ★繋がらない
 *        ★理由 … ★受け取れて いないので 戻す中身が ありません
 *        ★★★空にも しません（★「動かさない」と「空にする」は 別）
 *
 * 🟡 ★この道具は「許可なし」と「確かめられない」を ★★区別しません
 *   → ★区別するのは 契約（動いてよいか）の 仕事です（★判定を 2箇所に 置かない）
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, lstatSync, unlinkSync, rmSync, readdirSync, cpSync, renameSync, rmdirSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { judgeCopyFreshness, UNKNOWN } from './memory-contract.mjs'

const md5 = (b) => createHash('md5').update(b).digest('hex')

/* 1件を契約に通す。★★ここでは 書きません */
export function planOne(rec, { root } = {}) {
  const base = rec.root || root
  if (!base || !rec.rel) return { rec, action: 'ask', state: UNKNOWN, note: '🔴 root/rel が 無い' }
  const p = join(base, rec.rel)

  let localHash, localMtime
  if (existsSync(p)) {
    try {
      localHash = md5(readFileSync(p))
      localMtime = new Date(statSync(p).mtimeMs).toISOString()
    } catch (e) {
      // 🔴 ★読めなかった を「無い」に しない（★今日の型・0と未取得を混ぜない）
      return { rec, path: p, action: 'ask', state: UNKNOWN, note: `🔴 ローカルが 読めない: ${e.message}` }
    }
  }
  const r = judgeCopyFreshness({
    localHash, serverHash: rec.sha,
    localMtime, serverSyncedAt: rec.synced_at,
  })
  return { rec, path: p, action: r.action ?? 'ask', state: r.state, note: r.note }
}

export function plan(recs, opts = {}) {
  if (!Array.isArray(recs)) return { ok: false, reason: '🔴 引数の 形が 違います（測れなかった）' }
  const out = { ok: true, restore: [], none: [], keep: [], ask: [] }
  for (const rec of recs) {
    const d = planOne(rec, opts)
    ;(out[d.action] ?? out.ask).push(d)
  }
  return out
}

/* ── ★★★書く口は ここ 1本だけ ───────────────────────── */
function _writeOne(path, content, checks, backupDir) {
  // 🔴 ★★検査は 3値で 返ります（ok ／ blocked ／ ★測れなかった）
  //   ★前は blocked だけ 見て いました → ★★「測れなかった」が ★★★通過に なって いました
  //   ★★→ ★測れなければ 書きません。★★★落ちても 全体を 止めません
  for (const c of checks) {                      // 鍵の検査・機密の検査は ここを 通る
    let v
    try { v = c(path, content) }
    catch (e) { return { written: false, reason: `🟡 ${c.name || '検査'}: 落ちました（${e.message}）測れないので 書きません` } }
    if (v && v.blocked) return { written: false, reason: `🔴 ${c.name || '検査'}: ${v.reason}` }
    if (v && (v.measurable === false || v.ok === null)) {
      return { written: false, reason: `🟡 ${c.name || '検査'}: 測れませんでした（${v.reason ?? '理由なし'}）書きません` }
    }
  }
  if (existsSync(path)) {                        // 控えを 先に 取る
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, path.replace(/[/\\]/g, '_') + '.bak'), readFileSync(path))
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return { written: true }
}
/* ──────────────────────────────────────────────── */

/* ── ★★空にする─────────────
 * ★許可が無いと ローカルのファイルが 動かない 形に する
 * ★★消しません。★★★同じ _writeOne で 中身を 空に 書き直すだけです
 *
 * 🔴 ★対象は【指定された もの】だけ
 *   → ★ours:true と 書いて あるものしか 触りません
 *   → ★★ワイルドカードは 受け取りません（★1件ずつ はっきり 指定する）
 * 🔴 ★書いた あと 読み直します …「書いたつもりで 残る」を 見るため
 */
export function blank(manifest, { root, agentRoot, backupDir, expectName, checks = [], dryRun = false } = {}) {
  if (!Array.isArray(manifest)) return { ok: false, reason: '🔴 引数の 形が 違います（測れませんでした）' }
  // 🟡 ★試すと 本物が 空に なる 経路です
  //   ★→ ★★dryRun のときは 控えも 要りません（★1バイトも 書かないので）
  if (!dryRun && !backupDir) return { ok: false, reason: '🔴 控えの 置き場が 無い（測れなかった）' }
  // 🔴 nameChecked …【照合が 何回 走ったか】を 数えます
  //   ★「両方に 在る」だけでは、★★噛み合って いるか 分かりません
  //   ★★実際に 0/9件 で 1度も 走って いなかったことが 在りました
  //   ★★★呼ぶ側は この数を 見て「0回なら まだ 揃って いない」と 判断できます
  const res = { dryRun, blanked: 0, nameChecked: 0, wouldBlank: [], refused: [], failed: [], skipped: [] }
  for (const m of manifest) {
    if (m?.ours !== true) { res.refused.push({ rel: m?.rel, why: '🔴 この 操作の 対象では ありません' }); continue }
    // 🔴 ★対象の 中にも【空にすると 壊れる】ものが 在ります
    //   例 … .in_use/（実行中の印）／ plugin.json（★空にすると Claude Code が 起動しない）
    //   ★★→ ★はっきり blankable:true と 書いて あるものだけ。★★★書いて無ければ 断る
    if (m.blankable !== true) { res.refused.push({ rel: m.rel, why: '🟡 触ってよいと 書かれていません（壊す恐れが あるので 断ります）' }); continue }
    // 🔴 ★範囲の 根を 手元に 固定
    //   対象は作業フォルダの配下だけ。
    //   ★★呼ぶ側が 何を 返しても、★範囲の 外は 触りません（★型①「絶対にやらないことは手元に固定」）
    if (agentRoot) {
      const abs = resolve(join(m.root || root || '', m.rel))
      const rootAbs = resolve(agentRoot)
      if (!abs.startsWith(rootAbs + sep) && abs !== rootAbs) {
        res.refused.push({ rel: m.rel, why: `🔴 範囲の 外です（${rootAbs} の 中では ありません）` }); continue
      }
    }
    // ★★plan() は 引数の root に 落ちるのに blank() は 落ちませんでした
    //   ★★→ ★同じ 引数を 別の入口から 渡すと ★★★片方だけ 落ちます。★形を 揃えます
    const base = m.root || root
    if (!base || !m.rel || /[*?]/.test(m.rel)) { res.refused.push({ rel: m?.rel, why: '🔴 置き場か 名前が 無い、または ワイルドカード' }); continue }
    const p = join(base, m.rel)
    // 🔴 置き場ごと 無いのを 見て いませんでした
    //   ★実測: 存在しない root を渡すと ok:true / blanked 0 / skipped 2
    //   ★★→ 「名前が違って 別の場所を 見ていた」と「もう 空だった」が ★★★同じ結果
    //   ★実際に、想定と違う名前の一式が同じ機械に入っていることがあります
    //   ★★→ 置き場が無いのは【異常】。ファイルが無いのは【正常】。分けます
    if (!existsSync(base)) {
      res.failed.push({ rel: m.rel, why: `🔴 置き場が 見つかりません: ${base}（名前か 版が 違うかも しれません）` })
      continue
    }
    // 🔴 置き場は在るが【別の製品】のことがあります
    //   ★実測: 名前の違う一式が2つ在り、どちらも plugin.json と .mcp.json を持っていました
    //   ★★どちらも plugin.json と .mcp.json を持つので、在る／無いだけでは見分けられません
    //   ★★★expectName が 渡された ときだけ照合します（★無ければ照合しない＝関所が止めます）
    // 🔴 引数は【上位に1つ】名前を持ち、実装が【1件ごと】を見ていました
    //   ★両方 揃っていても、高さが違うと照合が1度も走りません（★実測 0/9件）
    //   ★★「片方だけでは効かない」の一段先。数えるだけでは出ません
    //   ★★★1件ごとが在ればそれを、無ければ上位のものを使います
    const wantName = m.expectName || expectName
    if (wantName) {
      res.nameChecked++
      const pj = join(base, '.claude-plugin', 'plugin.json')
      if (!existsSync(pj)) {
        res.failed.push({ rel: m.rel, why: `🔴 製品の 名前を 確かめられません（${pj} が 在りません）` })
        continue
      }
      let nm
      try { nm = JSON.parse(readFileSync(pj, 'utf8')).name }
      catch (e) { res.failed.push({ rel: m.rel, why: `🔴 製品の 名前を 読めません: ${e.message}` }); continue }
      if (nm !== wantName) {
        res.failed.push({ rel: m.rel, why: '🔴 設定と 実物が 合いません（止めました）' })
        continue
      }
    }
    // 🔴🔴 ★★★ ── ★別々に 出た 実測
    //   ★「空で 上書き」は ★★リンクを 辿って ★★★リンク先の 中身を 空に します
    //   ★実測… link.txt に '' を書く → ★リンク先が 22バイト → 0バイト
    //   ★★unlink なら … ★リンクだけ 消えて ★リンク先は 22バイトの まま
    //   ★★★→ ★別の 実測の ご決定「リンク自体を 消す／リンク先は 触らない」
    //     理由 … 開始前にそのリンクは存在しなかった。
    if (existsSync(p)) {
      let st
      try { st = lstatSync(p) } catch (e) { res.failed.push({ rel: m.rel, why: `🔴 種別を 読めません: ${e.message}` }); continue }
      if (st.isSymbolicLink()) {
        if (dryRun) { res.wouldBlank.push({ rel: m.rel, why: '🔗 リンクなので 外します（リンク先は 触りません）' }); continue }
        try { unlinkSync(p); res.blanked++; continue }
        catch (e) { res.failed.push({ rel: m.rel, why: `🔴 リンクを 外せません: ${e.message}` }); continue }
      }
    }
    if (!existsSync(p)) { res.skipped.push({ rel: m.rel, why: '🟡 元から 在りません' }); continue }
    // 🔴 ★★いちばん 大きい ノウハウは 1ファイル 丸ごとでは ありません
    //   ★利用者の CLAUDE.md の【マーカーの 間】に 入ります
    //   ★★丸ごと 空にすると ★★★利用者が 自分で 書いた 分まで 消えます
    //   ★★→ ★marker が 指定されたら ★その 間だけ 空にする（★外は 1文字も 触らない）
    if (m.marker) {
      let cur
      try { cur = readFileSync(p, 'utf8') } catch (e) { res.failed.push({ rel: m.rel, why: `🟡 読めない: ${e.message}` }); continue }
      // 🔴 ★★START と END の 探し方が 非対称でした
      //   START … '-->' 抜きで 探す（★版が 付いても 当たる）
      //   END … '-->' 込みで 完全一致（★★版が 付いたら 外れる）
      //   ★★→ ★★★同じ 形に します。★どちらに 版が 付いても 当たります
      const S = `<!-- ${m.marker}_START`, E = `<!-- ${m.marker}_END`
      // 🔴 ★★目印が【2組】在ると 手前の1組だけ 空にして「成功」と 出ました
      //   ★★→ ★先に 数える。★★★半分だけ 消して 成功と 言うのが いちばん 悪い
      const count = (t, w) => { let n = 0, i = 0; while ((i = t.indexOf(w, i)) >= 0) { n++; i += w.length } return n }
      const nS = count(cur, S), nE = count(cur, E)
      // ★★片方だけ 在るのを「見つかりません」と 出して いました
      //   ★★→ ★症状で 書き分けます（★受け取った人が 何を すれば よいか 分かるように）
      if (nS === 0 && nE === 0) { res.skipped.push({ rel: m.rel, why: '🟡 目印が 見つかりません（まだ 入って いない か、消された）' }); continue }
      if (nS === 0 || nE === 0) {
        res.failed.push({ rel: m.rel, why: `🔴 目印が 片方だけ 在ります（開始 ${nS}・終了 ${nE}）どこまでが 対象か 決められないので 止めます` })
        continue
      }
      if (nS !== 1 || nE !== 1) {
        res.failed.push({ rel: m.rel, why: `🔴 目印が ${nS}組 在ります（どちらが 正か 決められないので 止めます）` })
        continue
      }
      const si = cur.indexOf(S), ei = cur.indexOf(E)
      if (ei < si) { res.failed.push({ rel: m.rel, why: '🔴 目印の 順番が 逆です（止めます）' }); continue }
      // 🔴 ★★目印を 書き直すと【版】が 落ちました
      //   前 <!-- X_START v1.2.3 -->  →  後 <!-- X_START -->
      //   ★★→ ★★★目印は そのまま 残す。★間だけ 空にする
      const so = cur.indexOf('-->', si)
      if (so < 0 || so > ei) { res.failed.push({ rel: m.rel, why: '🔴 目印が 閉じて いません（止めます）' }); continue }
      const next = cur.slice(0, so + 3) + '\n' + cur.slice(ei)   // ★ei は END の 先頭（★版が 付いても そのまま 残る）
      if (dryRun) { res.wouldBlank.push(`${m.rel}（目印の間だけ）`); continue }
      const w = _writeOne(p, next, checks, backupDir)
      if (!w.written) { res.failed.push({ rel: m.rel, why: w.reason }); continue }
      let after
      try { after = readFileSync(p, 'utf8') } catch (e) { res.failed.push({ rel: m.rel, why: `🟡 読み直せない: ${e.message}` }); continue }
      // ★★書いた ≠ 空に なった … ★目印の 間が 本当に 空か 数える
      const s2 = after.indexOf(S), e2 = after.indexOf(E)
      const inner = s2 >= 0 && e2 > s2 ? after.slice(after.indexOf('-->', s2) + 3, e2).trim() : 'x'
      if (inner.length !== 0) { res.failed.push({ rel: m.rel, why: '🔴 まだ 終わって いません（もう一度 お試しください）' }); continue }
      res.blanked++
      continue
    }
    if (dryRun) {
      // ★★検査だけは 本番と 同じに 通す（★通らないものを「空にする はず」と 数えない）
      const blocked = checks.map(c => [c, c(p, '')]).find(([, v]) => v && v.blocked)
      if (blocked) { res.failed.push({ rel: m.rel, why: `🔴 ${blocked[0].name || '検査'}: ${blocked[1].reason}` }); continue }
      res.wouldBlank.push(m.rel); continue          // ★★★「空にした」ではなく「空にする はずでした」
    }
    const w = _writeOne(p, '', checks, backupDir)
    if (!w.written) { res.failed.push({ rel: m.rel, why: w.reason }); continue }
    // ★★書いた ≠ 空に なった。★読み直して 数えます
    let after
    try { after = readFileSync(p, 'utf8') } catch (e) { res.failed.push({ rel: m.rel, why: `🟡 読み直せない: ${e.message}` }); continue }
    if (after.length !== 0) { res.failed.push({ rel: m.rel, why: '🔴 まだ 終わって いません（もう一度 お試しください）' }); continue }
    res.blanked++
  }
  res.limits = [
    '決められた もの以外は 1件も 触りません（あなたの 記憶・成果物は 対象外です）',
    '知らない ものが 混ざったら 断って 続けます（1件ずつ 独立して いる ため）',
    '控えを 残します（あとから 元に 戻せます）',
    'そのあと 動かなくなったかは 見ていません',
    '触ってよいと はっきり 書かれていない ファイルは 断ります（安全側）',
  ]
  // 🔴 ok が 中の失敗を 映して いませんでした
  //   ★入口のエラーは ok:false、★★でも中で failed が出ても ok:true を返していた
  //   ★実測: blank() を直接呼ぶと「ok=true / failed=2」が返り、誤読を招きました
  //   ★★boot 経由なら failed を見て引き下げるので実害は無かった（★呼ぶ側が1本だけ）
  //   ★★★refused は正常な動作（対象外を断る）なので ok には数えない
  return { ...res, ok: res.failed.length === 0 }
}

export function apply(planned, { backupDir, checks = [] } = {}) {
  if (!planned?.ok) return { ok: false, reason: planned?.reason ?? '🔴 計画が 無い' }
  if (!backupDir) return { ok: false, reason: '🔴 控えの 置き場が 無い（測れなかった）' }
  const res = { written: 0, skipped: [], blocked: [] }
  for (const d of planned.restore) {
    const c = d.rec.content
    if (typeof c !== 'string') { res.skipped.push({ rel: d.rec.rel, why: '🟡 中身が 無い' }); continue }
    const w = _writeOne(d.path, c, checks, backupDir)
    if (w.written) res.written++
    else res.blocked.push({ rel: d.rec.rel, why: w.reason })
  }
  // 🟡 ★keep / ask は ★★1件も 書きません（★契約どおり）
  res.kept = planned.keep.length
  res.unknown = planned.ask.length
  res.limits = [
    '設定が 正しいかは 見て いません',
    '決められた もの以外は 見て いません',
    
  ]
  // 🟡 ★blank と 同じ形に 見えたので 同じ直しを 当てて 落としました
  //   ★apply の res は { written, skipped, blocked, kept } で ★★failed が 在りません
  //   ★blocked … 検査が 止めた（★鍵・機密）＝ ★★正常な 動作
  //   ★skipped … 中身が 無い＝ ★★契約どおり（keep / ask は 書かない）
  //   ★★→ ★apply には「失敗」が 無いので ★★★ok: true が 正しい
  return { ok: true, ...res }
}

/* ── ★★★大元の フォルダごと──────────────
 * 実測 … この案で正しく動きます。
 *   rmSync(dir, {recursive:true}) は ★★リンクを 辿りません
 *   ① 普通の フォルダ ……… 消える ／ 外 無事
 *   ② 中に リンクが ある … 消える ／ ★リンク先 無事（38バイトの まま）
 *   ③ 中の サブが リンク … 消える ／ ★リンク先 無事
 *   ④ ★フォルダ 自体が リンク … ★リンクだけ 消える ／ ★リンク先 無事
 *   ★★→ ★★別々に 出た 3つの 問題が ★1つの 操作で 消えます
 *
 * 🔴🔴🔴 ★ただし ★★★末尾の スラッシュ 1文字で 意味が 真逆に なります
 *   rmSync('C')   … ★リンクだけ 消える ／ 外 無事
 *   rmSync('C/')  … ★★★リンクを 辿って ★外の 中身を 全部 消した（★実測）
 *   rm -rf C3/    … ★★同じ ／ ★★★しかも 終了コード 0（「成功」と 出ます）
 *   ★★→ ★必ず resolve() を 通します（★実測 … resolve は 末尾を 落とす、
 *        ★★normalize は 落とさない、★`${d}/` も join(d,'/') も 残る）
 *
 * 🔴 ★控えの 置き場は ★★対象の 外に 置いて ください
 *   ★実測 … 中に 置くと ★★控えごと 消えます（★戻せなく なります）
 */
export function blankTree(targets, { agentRoot, backupDir, dangerous = [], allowBackupInside = false, dryRun = false, scopeGate } = {}) {
  if (!Array.isArray(targets)) return { ok: false, reason: '🔴 対象が 配列では ありません（測れませんでした）' }
  if (!agentRoot) return { ok: false, reason: '🔴 大元が 渡されて いません（cwd は 使いません）' }
  if (!dryRun && !backupDir) return { ok: false, reason: '🔴 控えの 置き場が 無い（測れなかった）' }

  const rootAbs = resolve(agentRoot)                 // ★★ここで 末尾スラッシュが 落ちます
  const res = { dryRun, removed: 0, wouldRemove: [], refused: [], failed: [], skipped: [], warnings: [] }

  // 🔴 ★★★順番（★ 工程⑤）── ★呼ぶ側が 決めます（★手元では 決めません）
  //   ★実測… ★自分の フォルダを 消しても ★★走り続けます
  //     ① 動き出し ✅ ／ ② 自分を 消した ／ ③ ★消えた あとも 動いた
  //     🔴 ④ ★★まだ 読んで いない モジュールは 読めない（ERR_MODULE_NOT_FOUND）
  //     ✅ ⑥ 最後まで 走りきる ／ 終了コード 0
  //   ★★→ ★条件は ★★★「消す前に 全部 読み込み 済み」
  //     ★実測 … この一式に 動的 import は 0件（★条件を 満たして います）
  //   ★★order が 無いものは 0 として、★★★渡された 並びを 保ちます（★sort は 安定）
  const list = [...targets].sort((a, b) => ((a && a.order) || 0) - ((b && b.order) || 0))

  // 🔴 ★控えが 対象の 中に 在ると ★★控えごと 消えます（★実測）
  //   操作の可否は呼ぶ側が決める。戻す作業が簡単になるため。
  //   ★★→ ★既定は 止める（★復旧を 守る）／ ★★呼ぶ側が はっきり 許可したら 通す
  // 🔴 ★控えが 対象の 中に 在ると ★★控えごと 消えます（★実測）
  //   ★既定は 止める ／ ★呼ぶ側が allowBackupInside:true で 通せる
  if (backupDir && !allowBackupInside) {
    const bAbs = resolve(backupDir)
    if (bAbs === rootAbs || bAbs.startsWith(rootAbs + sep)) {
      return { ok: false, reason: `🔴 控えの 置き場が 消す 対象の 中に あります（${bAbs}）戻せなく なるので 止めます（通すなら allowBackupInside:true）` }
    }
  }

  // ★危険な 場所は 呼ぶ側が 渡す（★ここでは 決めない）
  //   ★渡されなかった ものは 止めずに 知らせるだけ（★入力ミスに 気づける ように）
  const home = process.env.HOME || ''
  const WELL_KNOWN = [home, '/', '/Users', '/System', '/Library', '/Applications',
                      join(home, 'Documents'), join(home, 'Desktop'), join(home, 'Downloads')]
    .filter(Boolean).map(x => resolve(x))
  // ★止めるのは ★★呼ぶ側が dangerous に 入れた ものだけ
  const never = new Set(dangerous.filter(Boolean).map(x => resolve(x)))
  const warn = (p) => { if (WELL_KNOWN.includes(p)) res.warnings.push(`🟡 ${p} は よく 知られた 場所です（止めて いません）`) }

  if (never.has(rootAbs)) {
    return { ok: false, reason: `🔴 この 操作は 許可されて いません（${rootAbs}）` }
  }
  warn(rootAbs)

  for (const t of list) {
    const rel = typeof t === 'string' ? t : t?.rel
    if (!rel || /[*?]/.test(rel)) { res.refused.push({ rel, why: '🔴 名前が 無い、または ワイルドカード' }); continue }
    if (t?.ours !== undefined && t.ours !== true) { res.refused.push({ rel, why: '🔴 この 操作の 対象では ありません' }); continue }

    const p = resolve(join(rootAbs, rel))            // ★★★末尾スラッシュは ここで 必ず 落ちます
    // 範囲の外は既定では止めない。呼ぶ側が判定を渡したときだけ止める。
    if (p !== rootAbs && !p.startsWith(rootAbs + sep)) {
      // 既定は知らせるだけ。
      //   ★★実測で「大元の 外の ファイルが 実際に 消える」ことを 確かめたため、
      //   ★★★呼ぶ側が 門（scopeGate）を 渡した ときだけ ★止める形に します。
      //   ★渡さなければ 従来どおり（★プラグインは 何でも できる のまま）。
      if (typeof scopeGate === 'function') {
        const g = scopeGate(rel)
        if (g && g.ok === false) {
          res.refused.push({ rel, why: `🔴 範囲の 外です（${g.gate || 'ESCAPES_ROOT'}）` })
          continue
        }
      }
      res.warnings.push(`🟡 ${rel} は 大元の 外を 指します（${typeof scopeGate === 'function' ? '門が 通しました' : '止めて いません'}）`)
    }
    if (never.has(p)) { res.refused.push({ rel, why: `🔴 この 操作は 許可されて いません（${p}）` }); continue }
    warn(p)

    let st
    try { st = lstatSync(p) }
    catch (e) {
      if (e.code === 'ENOENT') { res.skipped.push({ rel, why: '🟡 元から 在りません' }); continue }
      res.failed.push({ rel, why: `🔴 種別を 読めません: ${e.message}` }); continue
    }

    // ★対象 自体が リンク … ★★辿らずに リンクだけ 外す（★実測で 外は 無事）
    if (st.isSymbolicLink()) {
      if (dryRun) { res.wouldRemove.push({ rel, kind: 'リンク', why: '🔗 リンクだけ 外します（リンク先は 触りません）' }); continue }
      try { unlinkSync(p); res.removed++ } catch (e) { res.failed.push({ rel, why: `🔴 リンクを 外せません: ${e.message}` }) }
      continue
    }

    if (dryRun) {
      // 🔴 ★別の 実測（★読み取りが リンクを 辿る）を 受けて 見直しました
      //   ★こちらは recursive:true を 使って いません（★実測 0件）＝ ★穴は 当たって いません
      //   🟡 ★★ただし ここは【直下 だけ】数えて います
      //     ★「1件」と 出しても ★★その 中に もっと 多く 在ることが あります
      //     ★★★型「数える ときは 2本 出す」を ここに 当てます
      let n = 0, links = 0
      try {
        const ents = readdirSync(p, { withFileTypes: true })
        n = ents.length
        links = ents.filter(e => e.isSymbolicLink()).length
      } catch { n = -1 }
      res.wouldRemove.push({
        rel, kind: st.isDirectory() ? 'フォルダ' : 'ファイル',
        直下: n, リンク: links,
        note: n > 0 ? '🟡 直下の 数です（中の 深さは 数えて いません）' : undefined,
      })
      continue
    }

    // 🔴🔴🔴 ★★★ ── ★こちらの 実装漏れ
    //   ★backupDir を【要求】して いたのに、★★1度も 使って いませんでした
    //   ★★→ ★フォルダ 丸ごと 消すと ★★★戻せません
    //   ★実測 … cpSync は ★既定で リンクを 辿りません（★リンクの まま 控える）
    try {
      mkdirSync(backupDir, { recursive: true })
      cpSync(p, join(backupDir, rel.replace(/[/\\]/g, '_')), { recursive: true })
    } catch (e) {
      // ★控えが 取れないのに 消すのは ★★取り返しが つきません（★判断の 軸）
      res.failed.push({ rel, why: `🔴 控えを 取れません: ${e.message}（消して いません）` }); continue
    }
    try { rmSync(p, { recursive: true, force: true }) }
    catch (e) { res.failed.push({ rel, why: `🔴 消せません: ${e.message}` }); continue }

    // ★★消した ≠ 消えた。★読み直して 確かめます（★blank() と 同じ 型）
    if (existsSync(p)) { res.failed.push({ rel, why: '🔴 まだ 残って います' }); continue }
    res.removed++
  }

  res.limits = [
    '決められた もの以外は 1件も 触りません',
    'リンクは 外すだけ（リンク先は 触りません）',
    '控えを 取ってから 消します（取れなければ 消しません）',
    '控えは 対象の 外に 置いて ください（中に 置くと 一緒に 消えます）',
    'そのあと 動かなくなったかは 見て いません',
  ]
  return { ...res, ok: res.failed.length === 0 }
}

/* ── ★★★構成を【直す】────────
 *
 * 🔴 ★1つでも 失敗したら 全部 戻す（★途中で 止まった 形を 残さない）
 * ★★→ ★この 関数は【★★★1つでも 失敗したら 全部 戻します】
 *
 * 🔴 ★今日 6体で 出した 実測（★どれも「中身は 消えて いない のに 壊れる」）
 * 　① 相対リンクが 切れる ……………… ★深さ 3→2 で 実証
 * 　② 設定の 中の 絶対パス ………… {"path":"…/OLD"} が 迷子
 * 　③ ★★古い フォルダが【作り直される】… ★稼働中に 動かすと 記憶が 2つに 割れる
 * 　④ 途中で 落ちると 半分だけ
 *
 * ★★→ ★①② は rewrite で 直す（★動詞を 分けた 理由）
 * ★★→ ★③ は「起動時に 直す」で 避ける（★呼ぶ側の 責任・ここでは 見ません）
 * ★★→ ★④ は ★★★この 関数の ロールバックで 塞ぎます
 *
 * ★動詞（★どれを どの順で 使うかは 呼ぶ側が 決める）
 * 　mkdir   … 無ければ 作る（★在れば 触らない）
 * 　move    … 動かす（★行き先が 在ったら 止める。★★上書きしません）
 * 　rewrite … ファイルの 中の 文字列を 置き換える（★move した 先を 指す 文字列）
 * 　keep    … 何も しない（★はっきり 書いて おく ための もの）
 */
export function fixTree(plan, { agentRoot, backupDir, dryRun = false } = {}) {
  if (!Array.isArray(plan)) return { ok: false, reason: '🔴 手順が 配列では ありません（測れませんでした）' }
  if (!agentRoot) return { ok: false, reason: '🔴 大元が 渡されて いません（cwd は 使いません）' }
  if (!dryRun && !backupDir) return { ok: false, reason: '🔴 控えの 置き場が 無い（測れなかった）' }

  const rootAbs = resolve(agentRoot)
  const res = { dryRun, done: 0, steps: [], failed: [], skipped: [], warnings: [], rolledBack: 'none' }

  if (backupDir) {
    const bAbs = resolve(backupDir)
    if (bAbs === rootAbs || bAbs.startsWith(rootAbs + sep)) {
      return { ok: false, reason: `🔴 控えの 置き場が 直す 対象の 中に あります（${bAbs}）戻せなく なるので 止めます` }
    }
  }

  const list = [...plan].sort((a, b) => ((a && a.order) || 0) - ((b && b.order) || 0))
  const undo = []                     // ★★★戻す 手順（★逆順に 実行）

  const inside = (p) => p === rootAbs || p.startsWith(rootAbs + sep)

  for (const s of list) {
    const op = s?.op
    try {
      if (op === 'keep') { res.steps.push({ op, rel: s.rel, why: '🟡 そのまま' }); continue }

      if (op === 'mkdir') {
        const p = resolve(join(rootAbs, s.rel || ''))
        if (!inside(p)) res.warnings.push(`🟡 ${s.rel} は 大元の 外です（止めて いません）`)
        if (existsSync(p)) { res.skipped.push({ op, rel: s.rel, why: '🟡 もう 在ります（触りません）' }); continue }
        if (dryRun) { res.steps.push({ op, rel: s.rel, why: '作ります' }); continue }
        // 🔴🔴 ★★★別の 実測 ── ★深い ところを 作ると【親も 一緒に】できます
        //   ★戻す ときに 指定した ところ 1つしか 消して いませんでした
        //   ★★→ ★途中で できた 親が 残り、★しかも 警告も 出ませんでした
        //   ✅ ★mkdirSync は【最初に できた ところ】を 返します（★実測）
        const firstMade = mkdirSync(p, { recursive: true })
        // 🔴 ★★ ── ★ここは 最初 rmSync(p,{recursive:false}) と 書いて いました
        //   ★★フォルダには 使えず ERR_FS_EISDIR で 落ち、★catch が それを 隠して いました
        //   ★★★実測 … 戻した はずの activity が 残って いた（★対照 ② で 発見）
        //   ★rmdirSync … ★★空の ときだけ 消える（★中身が 在れば 落ちる＝安全）
        //   ★★落ちた ことを 記録する（★★★握りつぶさない）
        undo.push(() => {
          // ★消す 対象 … firstMade から p までの 階層（★★深い ほうから 順に）
          const chain = []
          if (firstMade) {
            let cur = p
            const top = resolve(firstMade)
            while (true) {
              chain.push(cur)
              if (resolve(cur) === top) break
              const up = dirname(cur)
              if (up === cur) break
              cur = up
            }
          } else { chain.push(p) }
          for (const c of chain) {
            try { rmdirSync(c) }
            catch (e) {
              // ★空で なければ 落ちます（★中身が 在れば 消さない＝安全）
              if (e.code !== 'ENOENT') res.warnings.push(`🟡 戻せません（作った フォルダが 残ります）: ${c.slice(rootAbs.length + 1)} — ${e.code}`)
              break
            }
          }
        })
        res.steps.push({ op, rel: s.rel, why: '✅ 作りました' }); res.done++
        continue
      }

      if (op === 'move') {
        const from = resolve(join(rootAbs, s.from || ''))
        const to   = resolve(join(rootAbs, s.to   || ''))
        if (!inside(from)) res.warnings.push(`🟡 ${s.from} は 大元の 外です（止めて いません）`)
        if (!existsSync(from)) { res.skipped.push({ op, rel: s.from, why: '🟡 元が 在りません' }); continue }
        // 🔴 ★行き先が 在ったら 止める … ★★上書きは【情報を 失う】ので しません
        if (existsSync(to)) { res.failed.push({ op, rel: s.to, why: '🔴 行き先が もう 在ります（上書きしません）' }); break }
        if (dryRun) { res.steps.push({ op, from: s.from, to: s.to, why: '動かします' }); continue }
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
        undo.push(() => {
          try { renameSync(to, from) }
          catch (e) { res.warnings.push(`🔴 戻せません（動かした ものが 戻りません）: ${s.from} — ${e.code}`) }
        })
        res.steps.push({ op, from: s.from, to: s.to, why: '✅ 動かしました' }); res.done++
        continue
      }

      if (op === 'rewrite') {
        const p = resolve(join(rootAbs, s.rel || ''))
        if (!inside(p)) res.warnings.push(`🟡 ${s.rel} は 大元の 外です（止めて いません）`)
        if (!existsSync(p)) { res.skipped.push({ op, rel: s.rel, why: '🟡 在りません' }); continue }
        if (typeof s.find !== 'string' || s.find === '') { res.failed.push({ op, rel: s.rel, why: '🔴 探す 文字列が ありません' }); break }
        let cur
        try { cur = readFileSync(p, 'utf8') } catch (e) { res.failed.push({ op, rel: s.rel, why: `🔴 読めません: ${e.message}` }); break }
        const n = cur.split(s.find).length - 1
        // 🔴🔴 ★★★ ── ★別の 実測
        //   ★「rewrite で 0箇所」＝ ★★指定が 間違って いる 合図
        //   ★★動かして から 気づくと ★★★もう 戻せません
        //   ★→ ★呼ぶ側が expect を 書いた ときだけ 数を 突き合わせます
        //     ★★書かなければ 今まで どおり（★既に 正しい 形の 利用者は 0箇所が 正常）
        //   判断は呼ぶ側が持つ。
        if (typeof s.expect === 'number' && n !== s.expect) {
          res.failed.push({ op, rel: s.rel, why: '🔴 設定と 実物が 合いません（もう一度 お試しください）' })
          break
        }
        if (n === 0) { res.skipped.push({ op, rel: s.rel, why: '🟡 設定と 実物が 合いません' }); continue }
        if (dryRun) { res.steps.push({ op, rel: s.rel, hits: n, why: `${n}箇所 書き換えます` }); continue }
        // ★控えを 取ってから 書く（★戻せる ように）
        mkdirSync(backupDir, { recursive: true })
        const bak = join(backupDir, s.rel.replace(/[/\\]/g, '_') + '.bak')
        writeFileSync(bak, cur)
        writeFileSync(p, cur.split(s.find).join(s.replace ?? ''))
        undo.push(() => {
          try { writeFileSync(p, readFileSync(bak)) }
          catch (e) { res.warnings.push(`🔴 戻せません（書き換えが 戻りません）: ${s.rel} — ${e.code} ／ 控え ${bak}`) }
        })
        res.steps.push({ op, rel: s.rel, hits: n, why: `✅ ${n}箇所 書き換えました` }); res.done++
        continue
      }

      res.failed.push({ op: op ?? '(無い)', rel: s?.rel, why: '🔴 知らない 動詞です' }); break
    } catch (e) {
      res.failed.push({ op, rel: s?.rel ?? s?.from, why: `🔴 落ちました: ${e.message}` }); break
    }
  }

  // 1つでも失敗したら全部戻す（情報を失わないため）。
  if (!dryRun && res.failed.length > 0 && undo.length > 0) {
    const before = res.warnings.length
    for (let i = undo.length - 1; i >= 0; i--) undo[i]()
    // 🔴 ★★★案B ── ★「全部 戻った」と「一部 残った」を 分けます
    //   ★前は true / false の 2値でした
    //   ★★→ ★戻し切れなかった ものが 在るのに true と 出て いました
    //   ★★★「全部 戻しました」と 言い切るのが、★失敗そのものより 危ない
    res.rolledBack = res.warnings.length > before ? 'partial' : 'full'
    res.done = 0
  } else if (!dryRun && res.failed.length > 0) {
    res.rolledBack = 'none'                                // ★戻す ものが 無かった
  }

  res.limits = [
    '1つでも 失敗したら 戻します（rolledBack … full ／ partial ／ none）',
    '知らない ものが 混ざったら 止めます（飛ばしません。順番に 意味が ある ため）',
    '戻し切れなかった ものは warnings に 出します',
    '行き先が もう 在るときは 動かしません（上書きしません）',
    '控えは 対象の 外に 置いて ください',
    '動いて いる 最中に 呼ばないで ください（起動時に 呼ぶ ためのものです）',
  ]
  return { ...res, ok: res.failed.length === 0 }
}

/* ── ★構成を 直す ための【数だけ】返す 口 ─────────────────
 * ★構成を 直す とき、★move した 先を 指す 文字列を rewrite で 直します
 * 🔴 ★でも【どのファイルに 何箇所 在るか】は 中を 見ないと 分かりません
 *   ★★中身は 1バイトも 外へ 出しません
 *   ★★★→ ★「その 文字列が 何箇所 在るか」だけ 返します
 *
 * ★返す もの … rel ／ find ／ count
 * 🔴 返さない もの … 中身 ／ 前後の 文字 ／ 何行目か ／ ファイルの 大きさ
 *
 * ★読めなかった ときは count を null に します（★★0 に しません）
 *   → ★「0箇所」と「読めなかった」は 別（★今日の 型）
 */
export function countMatches(queries, { agentRoot, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!Array.isArray(queries)) return { ok: false, reason: '🔴 引数の 形が 違います（測れませんでした）' }
  if (!agentRoot) return { ok: false, reason: '🔴 大元が 渡されて いません（cwd は 使いません）' }
  const rootAbs = resolve(agentRoot)
  const out = []
  for (const q of queries) {
    const rel = q?.rel, find = q?.find
    if (!rel || typeof find !== 'string' || find === '') {
      out.push({ rel, find, count: null, why: '🔴 引数の 形が 違います' }); continue
    }
    const p = resolve(join(rootAbs, rel))
    if (p !== rootAbs && !p.startsWith(rootAbs + sep)) {
      out.push({ rel, find, count: null, why: '🔴 この 操作の 対象では ありません' }); continue
    }
    // 🔴🔴 ★★★別の 実測の ④「回避されないか」で 見つかった 穴
    //   ★途中に リンクが 在ると、★★名前の 上では 中に 見えて、★実体は 外に 出ます
    //   ★実測 … 'nakami/himitsu.txt'（nakami が 外への リンク）で ★★外の 中身を 数えた
    //   ★★→ ★実体（realpath）で もう一度 確かめます
    try {
      const real = realpathSync(p)
      const realRoot = realpathSync(rootAbs)
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        out.push({ rel, find, count: null, why: '🔴 この 操作の 対象では ありません（実体が 外に 出ます）' }); continue
      }
    } catch { /* ★無い ものは 下の lstat で 扱う */ }
    let st
    try { st = lstatSync(p) }
    catch (e) {
      out.push({ rel, find, count: e.code === 'ENOENT' ? 0 : null, why: e.code === 'ENOENT' ? '🟡 在りません' : `🟡 読めません: ${e.code}` })
      continue
    }
    // ★リンクは 辿りません（★外の 中身を 数えない）
    if (st.isSymbolicLink()) { out.push({ rel, find, count: null, why: '🟡 リンクなので 数えません' }); continue }
    if (!st.isFile()) { out.push({ rel, find, count: null, why: '🟡 ファイルでは ありません' }); continue }
    // ★大きすぎる ものは 読みません（★時間と 記憶を 使いすぎない）
    if (st.size > maxBytes) { out.push({ rel, find, count: null, why: '🟡 大きいので 数えません' }); continue }
    let s
    try { s = readFileSync(p, 'utf8') }
    catch (e) { out.push({ rel, find, count: null, why: `🟡 読めません: ${e.code}` }); continue }
    out.push({ rel, find, count: s.split(find).length - 1 })
  }
  return { ok: true, results: out, limits: ['数だけ 返します（中身・行番号・大きさは 返しません）'] }
}

/* ── ★いまの 構成を【形だけ】返す ────────────────────────
 * ★「正しい 構成に 揃える」の 前に、★いま どう なって いるかを 測る 口
 *
 * 🔴 ★利用者の 情報を 守る（★これが 設計の 芯）
 *   ★決められた 名前（allow）の ものだけ ★名前を 返す
 *   ★★それ以外は ★★★名前を 返さず「その他 N件」とだけ 返す
 *   → ★利用者が 自分で 作った 書類の 名前が 外へ 出ません
 *   → ★★でも「うちが 期待する ものが 在るか」は 分かります
 *
 * 🔴 返さない もの
 *   ・中身（★1バイトも）    ・ファイルの 大きさ
 *   ・allow の 外の 名前     ・深い ところの 中身
 *
 * ★深さは 1段だけ（★直下）。★★リンクは 辿りません（★外を 数えない）
 */
export function scanLayout({ agentRoot, allow = [], maxEntries = 200 } = {}) {
  if (!agentRoot) return { ok: false, reason: '🔴 大元が 渡されて いません（cwd は 使いません）' }
  if (!Array.isArray(allow)) return { ok: false, reason: '🔴 引数の 形が 違います（測れませんでした）' }
  const rootAbs = resolve(agentRoot)
  let ents
  try { ents = readdirSync(rootAbs, { withFileTypes: true }) }
  catch (e) { return { ok: false, reason: `🔴 大元を 読めません: ${e.code}（測れませんでした）` } }

  const known = new Set(allow)
  const entries = []
  let others = 0, truncated = false
  for (const e of ents) {
    if (entries.length >= maxEntries) { truncated = true; break }
    if (!known.has(e.name)) { others++; continue }        // ★★名前を 返さない
    const kind = e.isSymbolicLink() ? 'link' : (e.isDirectory() ? 'dir' : 'file')
    const rec = { rel: e.name, kind }
    // ★直下の 数だけ（★空か どうかで move の 可否が 変わる ため）
    if (kind === 'dir') {
      try { rec.n = readdirSync(join(rootAbs, e.name), { withFileTypes: true }).length }
      catch { rec.n = null }                              // ★読めなかった（★0 に しない）
    }
    entries.push(rec)
  }
  // ★allow に 在るのに 見つからなかった もの（★これが「揃って いない」の 材料）
  const missing = allow.filter(a => !entries.some(x => x.rel === a))
  return {
    ok: true, entries, missing, others, truncated,
    limits: [
      '決められた 名前の ものだけ 返します（それ以外は 数だけ）',
      '中身は 1バイトも 返しません',
      '直下だけ 見ます（深い ところは 数えません）',
      'リンクは 辿りません',
    ],
  }
}

/* ── ★差分から 手順を 作る ────────────────────────────
 * ★scanLayout の 結果（いまの 形）と、★★あるべき 形を 比べて
 * ★★★fixTree が 食える 手順に します
 *
 * 🔴 ★ここは【判断を しません】。★引数で 渡された ものだけ 見ます
 *   want    … あるべき もの（★呼ぶ側が 決める）
 *   aliases … 別の 名前で 在る ものの 対応（★呼ぶ側が 決める）
 *
 * ★なぜ aliases が 要るか
 *   ★「memory-old が memory の 古い 名前」だとは、★★形からは 分かりません
 *   ★★→ ★呼ぶ側が 対応表を 持ちます。★ここでは 推測しません
 *
 * 🔴 ★順番（★実測から）
 *   ① mkdir → ② move → ★★★③ rewrite（★最後）→ ④ keep
 *   ★rewrite を move より 先に すると、★★まだ 動いて いない ものを 指す 形に なります
 */
export function planLayoutFix(current, { want = [], aliases = [] } = {}) {
  if (!current || !Array.isArray(current.entries)) {
    return { ok: false, reason: '🔴 引数の 形が 違います（測れませんでした）' }
  }
  if (!Array.isArray(want) || !Array.isArray(aliases)) {
    return { ok: false, reason: '🔴 引数の 形が 違います（測れませんでした）' }
  }
  const have = new Map(current.entries.map(e => [e.rel, e]))
  const steps = []
  const notes = []
  let order = 0

  // ★② move … 対応表に 在り、★古い 名前が 実在し、★新しい 名前が まだ 無い もの
  const moved = new Set()
  for (const a of aliases) {
    if (!a?.from || !a?.to) { notes.push('🟡 対応表の 形が 違うので 飛ばしました'); continue }
    if (!have.has(a.from)) continue                       // ★古い 名前が 無い → 何も しない
    if (have.has(a.to)) {                                 // 🔴 両方 在る … ★上書きしない
      notes.push(`🔴 ${a.from} と ${a.to} が 両方 在ります（動かしません）`); continue
    }
    steps.push({ op: 'move', from: a.from, to: a.to, order: ++order })
    moved.add(a.to)
  }

  // ★① mkdir … あるべき もので、★実在せず、★move でも 埋まらない もの
  //   ★★mkdir は move より 前に 置きます（★move の 行き先の 親が 要る ため）
  const mk = []
  for (const w of want) {
    const rel = typeof w === 'string' ? w : w?.rel
    const kind = typeof w === 'string' ? 'dir' : (w?.kind || 'dir')
    if (!rel) { notes.push('🟡 あるべき ものの 形が 違うので 飛ばしました'); continue }
    if (have.has(rel) || moved.has(rel)) continue
    if (kind !== 'dir') { notes.push(`🟡 ${rel} は ここでは 作りません（フォルダだけ 作ります）`); continue }
    mk.push({ op: 'mkdir', rel, order: 0 })
  }
  // ★★順番を 振り直す（mkdir を 先頭に）
  const out = []
  let n = 0
  for (const s of mk) out.push({ ...s, order: ++n })
  for (const s of steps) out.push({ ...s, order: ++n })

  // ★③ rewrite … move した もの だけ。★対応表が 指す ファイルに 対して
  for (const a of aliases) {
    if (!out.some(s => s.op === 'move' && s.from === a.from)) continue
    for (const rel of (a.rewriteIn || [])) {
      out.push({
        op: 'rewrite', rel,
        find: a.findText ?? a.from, replace: a.replaceText ?? a.to,
        // 🔴 expect は ここでは 決めません（★countMatches で 測った 数を 呼ぶ側が 入れます）
        order: ++n,
      })
    }
  }

  // ★④ keep … あるべき ものが すでに 在る（★何も しないと はっきり 書く）
  for (const w of want) {
    const rel = typeof w === 'string' ? w : w?.rel
    if (rel && have.has(rel) && !out.some(s => s.rel === rel || s.to === rel)) {
      out.push({ op: 'keep', rel })
    }
  }

  return {
    ok: true, steps: out, notes,
    limits: [
      '別の 名前かどうかは 対応表だけで 決めます（形からは 推測しません）',
      'フォルダだけ 作ります（ファイルは 作りません）',
      '両方 在るときは 動かしません（上書きしません）',
      'expect は 入って いません（数を 測ってから 呼ぶ側が 入れて ください）',
    ],
  }
}

/* ── ★決められた 一覧に 無い 接続先が いくつ 在るか（★数だけ）────────────
 * 🔴 ★countMatches では 測れません
 *   ★countMatches は「★指定した 文字列が 何箇所 在るか」しか 数えません
 *   ★★「★一覧に 無い もの」は ★★★指定できません（★知らないから）
 *
 * ✅ ★形で 数えて、★★一覧に 在る ものを 引く
 *   → ★「17〜20桁の 数字」を 全部 数える（★Discord の ID の 形）
 *   → ★★そのうち 一覧に 在る ものを 数える
 *   → ★★★差が「一覧に 無い 接続先」の 数
 *
 * 🔴 ★返さない もの … ★実際の ID ／ 前後の 文字 ／ 何行目か ／ 中身
 *   → ★数だけ 返します（★どれが 知らない ID かは 返しません）
 */
export function countUnknownIds(rels, { agentRoot, known = [], pattern = /\b\d{17,20}\b/g, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!Array.isArray(rels)) return { ok: false, reason: '🔴 引数の 形が 違います（測れませんでした）' }
  if (!agentRoot) return { ok: false, reason: '🔴 大元が 渡されて いません（cwd は 使いません）' }
  if (!Array.isArray(known)) return { ok: false, reason: '🔴 引数の 形が 違います（測れませんでした）' }
  const rootAbs = resolve(agentRoot)
  const knownSet = new Set(known.map(String))
  const out = []
  for (const rel of rels) {
    if (typeof rel !== 'string' || !rel) { out.push({ rel, total: null, known: null, unknown: null, why: '🔴 引数の 形が 違います' }); continue }
    const p = resolve(join(rootAbs, rel))
    if (p !== rootAbs && !p.startsWith(rootAbs + sep)) { out.push({ rel, total: null, known: null, unknown: null, why: '🔴 この 操作の 対象では ありません' }); continue }
    // 🔴 ★実体で もう一度（★途中の リンクで 外に 出る のを 止める）
    try {
      const real = realpathSync(p), realRoot = realpathSync(rootAbs)
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        out.push({ rel, total: null, known: null, unknown: null, why: '🔴 この 操作の 対象では ありません（実体が 外に 出ます）' }); continue
      }
    } catch {}
    let st
    try { st = lstatSync(p) }
    catch (e) { out.push({ rel, total: e.code === 'ENOENT' ? 0 : null, known: e.code === 'ENOENT' ? 0 : null, unknown: e.code === 'ENOENT' ? 0 : null, why: e.code === 'ENOENT' ? '🟡 在りません' : `🟡 読めません: ${e.code}` }); continue }
    if (st.isSymbolicLink()) { out.push({ rel, total: null, known: null, unknown: null, why: '🟡 リンクなので 数えません' }); continue }
    if (!st.isFile()) { out.push({ rel, total: null, known: null, unknown: null, why: '🟡 ファイルでは ありません' }); continue }
    if (st.size > maxBytes) { out.push({ rel, total: null, known: null, unknown: null, why: '🟡 大きいので 数えません' }); continue }
    let s
    try { s = readFileSync(p, 'utf8') } catch (e) { out.push({ rel, total: null, known: null, unknown: null, why: `🟡 読めません: ${e.code}` }); continue }
    const found = s.match(pattern) || []
    const uniq = [...new Set(found)]
    const k = uniq.filter(x => knownSet.has(x)).length
    out.push({ rel, total: uniq.length, known: k, unknown: uniq.length - k })
  }
  return { ok: true, results: out, limits: ['数だけ 返します（どの ID かは 返しません）', '17〜20桁の 数字を 数えます（別の 形は 数えません）'] }
}
