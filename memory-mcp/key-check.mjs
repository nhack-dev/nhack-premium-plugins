/* key-check.mjs ── ★書く前に 鍵が 混ざって いないかを 見る
 *
 * ★中身の 判定は 1行も 書きません。★★pre-send-secret-check.py が 決めます。
 * ★★ここは 呼んで 終了コードを 3値で 受けるだけ です。
 *
 *   0 … 混ざって いない → 書く
 *   1 … 混ざって いる  → 🔴 書かない
 *   2 … 測れなかった   → 🔴 書かない（★「測れなかった」を 通過に しない）
 *   ★道具が 動かない（python が 無い 等）… 🟡 { measurable: false } → ★★書きません
 *     ★★★{ ok: false } では 呼ぶ側の実装で【通過】します（★実測）。
 *     ★「測れなかった」を 通過に しない ── ★★今日 何度も 出た 形です。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// ★自己テストで 道具を 見失わせる ため、★1箇所から 引く形に する
export const SCRIPT_OVERRIDE = { path: join(import.meta.dirname ?? '.', 'pre-send-secret-check.py') }

export function keyCheck(path, content) {
  const SCRIPT = SCRIPT_OVERRIDE.path
  if (!existsSync(SCRIPT)) return { measurable: false, reason: '検査の道具がありません' }
  const dir = mkdtempSync(join(tmpdir(), 'nhack-kc-'))
  // ★元の名前のまま 置く（★名前で分かる鍵（.env / *.pem）を 拾わせるため）
  const t = join(dir, String(path).replace(/^\/+/, '').replace(/\.\./g, '_'))
  try {
    mkdirSync(dirname(t), { recursive: true })
    writeFileSync(t, content ?? '', 'utf8')
    execFileSync('python3', [SCRIPT, t], { stdio: 'pipe', timeout: 20000 })
    return { ok: true }
  } catch (e) {
    if (e?.status === 1) {
      // 🔴 ★exit 1 は 2つの 意味を 持つ（★実測で 確定）
      //   ① 鍵が 混ざって いる       … 検査が 走って 判定を 出した
      //   ② 道具が 壊れて いる       … python が 文法エラー等で 落ちた（★同じ exit 1）
      //   ★★どちらでも 書きませんが、★★★人に 出す 言葉が 違います。
      //   ★「鍵が 混ざって います」と 出すと、人は 鍵を 探しに 行きます。
      //   ★★道具が 壊れて いる ときは 探しても 見つからず、★道具は 直されません。
      //   ★★★見分け方 … ★出力に【判定の行】が あるか（★終了コードだけで 決めない）
      const out = String(e?.stdout ?? '') + String(e?.stderr ?? '')
      const judged = /見たファイル|鍵が混ざっています|鍵は混ざっていません/.test(out)
      if (judged) return { blocked: true, reason: '鍵が混ざっています' }
      return { measurable: false, reason: `測れませんでした（検査が判定を出していません: ${out.trim().split('\n').pop()?.slice(0, 60) || 'no output'}）` }
    }
    // 🔴 ★exit 2 も 道具が動かない も ★★全部【測れなかった】に 倒します（★3値の 形）
    //   ★呼ぶ側は measurable:false で 止めます。★★{ok:false} では 通ります
    return { measurable: false, reason: `測れませんでした（${String(e?.status ?? e?.code ?? e?.message ?? e).slice(0, 60)}）` }
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch { } }
}
keyCheck.checkName = '鍵検査'

/* ── ★自己テスト（★実測で 確定した 形）───────────
 *   ★手で 測っただけ では ★★次に 誰かが 触ったとき 誰も 気づきません。
 *   ★★走らせる ものが 要る。
 *   使い方: bun key-check.mjs --selftest   （★exit 0 合格 ／ 1 不合格）
 */
if (process.argv.includes('--selftest')) {
  const cases = [
    ['✅ ふつうの記憶',        'facts/x.md', 'ふつうの文です',                          'ok'],
    ['🔴 名前で分かる（.env）', '.env',       'なんでも',                                'blocked'],
    ['🔴 名前で分かる（.pem）', 'a/b.pem',    '-----BEGIN PRIVATE KEY-----',             'blocked'],
    // 🔴 検体をそのまま書くと、配る先の自動検査が「本物の鍵」と読んで押し戻す（実測）。
    //   形は保ったまま、走らせる時に組み立てる。判定する側には同じものが渡る。
    ['🔴 中身で分かる',        'notes.md',   'DISCORD_BOT_TOKEN=' + 'M' + 'A'.repeat(23) + '.GaBcDe.' + 'B'.repeat(27), 'blocked'],
    ['✅ 空の中身',            'empty.md',   '',                                        'ok'],
  ]
  let ng = 0
  for (const [name, path, content, want] of cases) {
    const r = keyCheck(path, content)
    const got = r.blocked ? 'blocked' : (r.measurable === false ? 'measurable-false' : 'ok')
    const ok = got === want
    if (!ok) ng++
    console.log(`${ok ? '✅' : '🔴'} ${name} → ${got}（期待 ${want}）${r.reason ? ' / ' + r.reason : ''}`)
  }
  // 🔴 ★止まるべき枝を 2つとも 通す（★実測:
  //   ★★「道具が無い」だけ測ると【存在チェック】しか通らず、
  //   ★★★実行が こけた ときの枝（catch の中）が 一度も 走りません）
  const saved = SCRIPT_OVERRIDE.path
  {
    SCRIPT_OVERRIDE.path = '/does/not/exist.py'          // ★① 道具が 無い
    const r = keyCheck('notes.md', 'DISCORD_BOT_TOKEN=xxx')
    const ok = r.measurable === false
    if (!ok) ng++
    console.log(`${ok ? '✅' : '🔴'} 🟡 道具が無い → ${ok ? 'measurable:false（止まる）' : '通ってしまう'}`)
  }
  {
    // ★② 道具は 在るが 走らせると こける（★★exit 1 でも 2 でもない枝）
    const d = mkdtempSync(join(tmpdir(), 'nhack-kcbad-'))
    const bad = join(d, 'broken.py')
    writeFileSync(bad, 'def (  # ← わざと 壊した python\n', 'utf8')
    SCRIPT_OVERRIDE.path = bad
    const r = keyCheck('notes.md', 'DISCORD_BOT_TOKEN=xxx')
    // 🔴 ★実測で分かったこと（）:
    //   ★python が 文法エラーで 落ちても 終了コードは 1。
    //   ★★つまり exit 1 は【鍵が 混ざっている】と【道具が 壊れている】の 2つの意味を持つ。
    //   ★★★どちらでも【書かない】。★見分けは つかないが、★安全側に 倒れる。
    // ★★★期待を 戻しました… ★道具が 壊れた ときは measurable:false
    //   ★blocked（鍵が 混ざって いる）と 同じ 言葉に しない
    const ok = r.measurable === false
    if (!ok) ng++
    console.log(`${ok ? '✅' : '🔴'} 🟡 走らせるとこける → ${ok ? 'measurable:false（止まる・言葉も 分かれる）' : '' + (r.blocked ? '「鍵が混ざっています」と 誤って 出る' : '通ってしまう')}`)
    rmSync(d, { recursive: true, force: true })
  }
  SCRIPT_OVERRIDE.path = saved
  console.log(ng === 0 ? '\n自己テスト: 合格（7件）' : `\n🔴 自己テスト: 不合格 ${ng}件`)
  process.exit(ng ? 1 : 0)
}
