/* boot.mjs ── ★起動したときに 1回 呼ぶ 入口
 *
 * ★★★呼ぶ側は これを 1行 呼ぶだけです:
 *     import { onStartup } from './memory-mcp/boot.mjs'
 *     const r = await onStartup({ probe, recs, manifest, backupDir, checks })
 *
 * ★判定は 1文字も 書きません（★契約が 全部 決めます）
 * ★★書くのは restore.mjs の _writeOne 1本だけ
 */
import { judgeRunPermission, judgeGetResponse, RUN, OK } from './memory-contract.mjs'
import { plan, apply, blank } from './restore.mjs'

export async function onStartup({
  probe, getProbe, botId, recs = [], manifest = [], roots = {}, backupDir, checks = [], dryRun = false,
  expectName,
} = {}) {
  const r = judgeRunPermission(probe)
  const base = { run: r.run, state: r.state, note: r.note }

  // 許可があるとき … 正本で書き直す
  if (r.run === RUN.ALLOW) {
    // 🔴🔴 ★★recs を そのまま 使って いました
    //   ★★★別の 体の 記憶が 返って きても 気づかず、★この お客様の 機械に 書きます
    //   ★お客様の 記憶が 別の お客様に 見える ＝ いちばん 重い 事故
    //   ★★→ ★契約（get の 応答）に 通してから でないと 使いません
    const g = judgeGetResponse(getProbe, botId)
    if (g.state !== OK) {
      return { ...base, ok: false, written: 0, blanked: 0,
               reason: `🔴 受け取った 記憶を 使えません: ${g.note}\n1バイトも 書いて いません` }
    }
    const p = plan(recs)
    if (!p.ok) return { ...base, ok: false, reason: p.reason }
    return { ...base, ok: true, ...apply(p, { backupDir, checks }) }
  }

  // 🔴 繋がって【はっきり 不許可】… ★中身を 空に 書き直す（★消しません）
  if (r.run === RUN.BLANK) {
    // 🔴 ★★置き場が 2種類 在ります（★プラグイン ／ お客様の CLAUDE.md）
    //   ★呼び忘れると ★★「元から 無い」と 同じ skipped に 見えて、★★★成功で 終わります
    //   ★★→ 設定が持つ種類の数を数える。★全部 通らなければ 成功に しない
    // 🔴 nameChecked を 上まで 出します
    //   ★呼ぶ側が expectName を 渡し忘れると 照合が 0回に なります
    //   ★★blank の 中では 数えて いましたが、★★★ここで 落ちて いました
    //   ★実測: 配る側と 同じ 呼び方（expectName なし）で 空にする 2件・ok=true
    const done = [], missing = [], merged = {
      blanked: 0, nameChecked: 0, wouldBlank: [], refused: [], failed: [], skipped: [],
    }
    // 🔴 ★★kind が 無いとき 'plugin' と 決めつけて いました
    //   ★受け取る側で 推測すると、★★別の 置き場の ものを その置き場で 探します
    //   ★★→ ★★★推測しない。★書いて なければ 断る（設定を作る側が決めます）
    const noKind = manifest.filter((m) => !m?.kind)
    for (const m of noKind) {
      merged.refused.push({ rel: m?.rel, why: '🔴 どの置き場の ものか 書かれて いません（kind）推測しません' })
    }
    const withKind = manifest.filter((m) => m?.kind)
    const want = [...new Set(withKind.map((m) => m.kind))]
    for (const kind of want) {
      const root = roots?.[kind]
      if (!root) { missing.push(kind); continue }          // 🔴 ★渡されて いない 置き場
      const part = withKind.filter((m) => m.kind === kind)
      const res = blank(part, { root, backupDir, expectName, checks, dryRun })
      // 🔴 ok=false には 2つの 意味が あります
      //   ① 入口で 断られた（配列でない・控えが無い）… ★置き場として 処理できて いない
      //   ② 中で 止めた（別の製品・置き場が無い）…… ★処理は した。止めたのが 結果
      //   ★★①だけを missing にします。②を missing に すると
      //   ★★★「別の製品なので 止めた」が「置き場が 渡されて いない」に すり替わります
      //   ★実測: expectName を渡すと failed 2件 → ok=false → 誤った理由が出ていました
      if (!res.ok && res.failed === undefined) { missing.push(kind); continue }
      done.push(kind)
      merged.blanked += res.blanked
      // 🔴 「数が 無い」を 0 に しません（★0回 と 測れなかった は 別）
      //   ★古い版の restore.mjs と 組むと、照合が 走って いても 0 に 見えます
      if (typeof res.nameChecked === 'number') merged.nameChecked += res.nameChecked
      else merged.nameCheckUnknown = (merged.nameCheckUnknown || 0) + 1
      for (const k of ['wouldBlank', 'refused', 'failed', 'skipped']) merged[k].push(...res[k])
    }
    return {
      ...base, ...merged,
      kinds: { want, done, missing },
      // 🔴 ★★「止めた」も 成功に しません
      //   ★2組の 目印などで 止めると、★★次の起動でも また 止まります
      //   ★★→ ★★★誰かの 目に 届かないと ★永久に ノウハウが 残ります
      ok: missing.length === 0 && merged.failed.length === 0 && noKind.length === 0,
      ...(missing.length || merged.failed.length
        ? { reason: [
            missing.length ? `🔴 置き場が 渡されて いません: ${missing.join(', ')}` : '',
            merged.failed.length ? `🔴 止めた ${merged.failed.length}件 … ${merged.failed.map((f) => `${f.rel}（${f.why}）`).join(' / ')}` : '',
            'まだ 終わって いません。人の 手が 要ります',
          ].filter(Boolean).join('\n') }
        : {}),
    }
  }

  // 🟡 HOLD（繋がらない）／ SKIP（材料が渡されていない）
  //   ★どちらも ★★1バイトも 書きません
  //   ★★→ ★「動かさない」と「空にする」は 別
  //   ★★★→ ★材料が 揃わないときは ★お客様を 空に しない
  return { ...base, ok: true, written: 0, blanked: 0, touched: 0 }
}
