#!/usr/bin/env node
/*
 * memory-contract.mjs — 記憶を保存先に置く構成で「満たしていなければならないこと」を判定する
 *
 *   node memory-contract.mjs --selftest
 *
 * ■ なぜ実装より先に契約を書くか
 *
 *   先に決めておかないと、実装ができてから基準を後付けすることになり、
 *   実装に都合の良い基準になる（この順序を崩すと、自己テストが実装の写しになる）。
 *
 * ■ 実測で確定した前提
 *
 *   受講生の記憶は Basic Memory ではなく **素の Markdown**
 *   → MCP化とは「AI が Read でファイルを読む」を「AI が MCP ツールで読む」に替えること
 *
 * ■ 🔴 実物の API の形（受け口の仕様＋catch-all を実測）
 *
 *   GET  API_SHAPE.getPath  → { bot_id, files: { "パス": "中身" }, synced_at }
 *                            ★files は配列ではなくオブジェクト
 *                            ★中身が無いときも **HTTP 200** で { files: {} }
 *   POST API_SHAPE.syncPath → { files: {...} } を送る → { ok, file_count }
 *                            🔴 丸ごと上書き（差分ではない）
 *                               = files に入れなかったものは消える
 *   失敗   401 Authorization が Bot で始まらない
 *          403 ★解約（ギルドに居ない）
 *          🔴 ここには長く「403 は解約と鍵の誤りの両方＝見分け不能」と書いてあった。
 *             実測（3通り叩いた）: 鍵がでたらめ / 鍵が空 / 鍵の欄が無い ―― 3つとも 401。
 *             403 が鍵の誤りで返ることは、実測した範囲では起きなかった。
 *             ただし下の判定は 403 を判定不能のままにしてある（緩めない）。
 *             理由は「いま 401 だから将来も 401」とは言えないため。
 *             緩める条件: 403 の応答に理由が必ず入ることを、送る側と受ける側の両方で決めること。
 *          400 files が無い（sync のみ）
 *   🔴 受け口に catch-all がある（実測）
 *          存在しない口（でたらめなパス）も **200** で文字列を返す
 *          → HTTP 200 だけでは「口が在る」を判定できない
 *
 * ■ 判定は3値（共通の型に揃える）
 *   0 = 契約を満たす ／ 1 = 満たさない ／ 2 = 判定不能
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export const OK = "満たす";
export const NG = "満たさない";
export const UNKNOWN = "判定不能";

/*
 * 🔴 実物の形を「定数」として置く。
 *   自己テストがこの定数そのものを読む（記憶 selftest-must-read-the-constant-it-guards）。
 *   ここを書き換えたら自己テストが落ちる＝実装が形を変えたことに気づける。
 */
export const API_SHAPE = {
  getPath: "/api/memory/get",
  syncPath: "/api/memory/sync",
  appendPath: "/api/memory/append",  // ★案Bを選んだ場合の口（まだ存在しない）
  filesIsObject: true,        // ★配列ではない
  emptyReturnsHttp200: true,  // ★中身が無くても 200
  // 🔴 syncOverwritesAll は【値を変えない】（判断）
  //   受け口は足す形（merge）＝送らなかったものは消えない、とされている。
  //   だが【私はそれを実測していない】。ここは「実物の形」を書く場所なので、
  //   自分で確かめていない値に書き換えない（記憶 write-the-verb-i-measured）。
  //
  //   🟢 それとは別に、契約5（judgeNoSilentDelete）は残す。理由:
  //     ・契約5 はこの定数を読んでいない。before と sending を比べるだけ。
  //       ＝足す形でも判定は「消える記憶なし」になり、邪魔にならない
  //     ・実装が丸ごと上書きに戻ったとき、送る側だけで気づける
  //     ・払う代償は「毎回全部送る」ことだけ（いまの記録数なら軽い）
  //
  //   📌 false に変える条件（どれか1つでは足りない・両方）:
  //     ① 受け口が足す形であることを【自分で叩いて】確かめる
  //        （2件送って、送らなかった1件が残っていることを見る）
  //     ② 毎回全部送るのが重くなった（件数・サイズを測って判断する）
  //
  //   ✅ 実現した:
  //     受け口が【自分の挙動】を応答に載せる { "sync_mode": "merge" | "overwrite" }
  //     → get / sync とも 'merge' が返ることを実装側が実測（報告）
  //     → 条件①は「自分で2件送って確かめる」より簡単になった＝応答を読むだけ
  //       merge     → 差分で送ってよい
  //       overwrite → 全部送る（いまの門）
  //       欄が無い  → 🟡 全部送る（安全側）
  //     ＝ 受け取る側で推測するのをやめて、知っている側に言わせる。
  //     403 の理由・bot_id の照合と同じ形（どちらも応答から読み取れなかった）。
  //
  //   🟡 それでも いま判定は変えない:
  //     ・判定を緩めても、送る側が差分送信に切り替えなければ何も変わらない
  //     ・その送る側は「重くないのでどちらでも」＝切り替える動機がない
  //     ・つまり②（重くなった）が来るまで、変えても誰の動作も変わらない
  //     ＝ 使われない判定を先に作らない（投機的な実装を避ける）
  //
  //   📌 見直す条件: 送る側が差分送信に切り替え、受け口が自分の挙動を応答で示すこと。
  //     両方が揃うまでは、この値は変えない。
  //   📌 false にしてよい実測（この3手順が通ったとき）:
  //     ① 記憶を2件送る ② 次に1件だけ送る ③ 送らなかった1件を取得して残っているか見る
  //     残る → 上書きではない（false にできる）／消える → true のまま
  //     ※①を飛ばすと測れない。0件からでは「消えた」を判定できない。
  syncOverwritesAll: true,    // ★差分ではない＝送らなかったものは消える
  forbiddenIsAmbiguous: true, // ★403 が「解約」と「鍵の誤り」の2つの意味を持つ
  hasCatchAll: true,          // ★存在しない口も 200 を返す
};

/*
 * 🔴 走査範囲は「見る場所を書く」（確定）
 *   ❌ 除外リスト … 次に別の写しが増えたら また除外を足す → 漏れる
 *   ✅ ホワイトリスト … 増えても漏れない
 *   ★対象外（ローカルに要るもの・レビューの実測）:
 *     設定ファイル・鍵・補助スクリプトなど（記憶の置き場の外にあるもの）
 *     → これらは「除外」ではなく「最初から見ない」
 */
export const MEMORY_PATHS = ["memory/"];

export function isInMemoryScope(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  return MEMORY_PATHS.some((p) => path.startsWith(p));
}

/** files が実物の形（オブジェクト・配列でない）か */
function isFilesShape(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* ─────────────────────────────────────────────
 * 契約1 ローカルに記憶が残っていないこと
 *
 * 🔴 「無いこと」だけで合格にしない（記憶 assert-arrival-not-just-absence）。
 *   「そもそも見に行っていない」を合格にしない。
 * ───────────────────────────────────────────── */
export function judgeNoLocalMemory(scan) {
  if (scan === null || typeof scan !== "object") {
    return { state: UNKNOWN, note: "走査の結果そのものが無い" };
  }
  if (!Object.hasOwn(scan, "scanned")) {
    return { state: UNKNOWN, note: "走査したかどうかが分からない" };
  }
  if (scan.scanned !== true) {
    return { state: UNKNOWN, note: `走査していない（${scan.reason || "理由なし"}）` };
  }
  if (!Array.isArray(scan.files)) {
    return { state: UNKNOWN, note: "見つけたファイルの一覧が配列でない" };
  }
  // 🔴 範囲の外のファイルが混ざっていたら、走査そのものを信用しない
  const outside = scan.files.filter((f) => !isInMemoryScope(f));
  if (outside.length > 0) {
    return { state: UNKNOWN, note: `記憶の置き場の外を見ている（例: ${outside[0]}）＝走査範囲が誤り` };
  }
  return scan.files.length === 0
    ? { state: OK, note: "ローカルに記憶ファイルなし（走査済み）" }
    : { state: NG, note: `${scan.files.length}件 残っている（例: ${scan.files[0]}）` };
}

/* ─────────────────────────────────────────────
 * 契約2 書いたものが読み戻せること
 *
 * 🔴 実物の形に当て直した。
 *   files は **オブジェクト**（{ "パス": "中身" }）。配列ではない。
 *   1ファイルぶんの文字列比較も残す（部分的な確認に使う）。
 * ───────────────────────────────────────────── */
export function judgeRoundTrip(wrote, read) {
  if (wrote === undefined || wrote === null) return { state: UNKNOWN, note: "書いた値が無い" };
  if (read === undefined) return { state: UNKNOWN, note: "読み戻していない" };
  if (read === null) return { state: NG, note: "読み戻せなかった（null）" };

  // ── 1ファイルぶん（文字列同士）
  if (typeof wrote === "string" || typeof read === "string") {
    if (typeof wrote !== typeof read) {
      return { state: NG, note: "書いた形と読んだ形が違う（片方だけ文字列）" };
    }
    return wrote === read
      ? { state: OK, note: "書いた値と読んだ値が一致" }
      : { state: NG, note: "書いた値と読んだ値が違う" };
  }

  // ── files まるごと（オブジェクト同士）
  if (!isFilesShape(wrote) || !isFilesShape(read)) {
    return { state: UNKNOWN, note: "files の形（オブジェクト）でない＝実物の形と違う" };
  }
  const wroteKeys = Object.keys(wrote);
  const missing = wroteKeys.filter((k) => !Object.hasOwn(read, k));
  if (missing.length > 0) {
    return { state: NG, note: `${missing.length}件 読み戻せない（例: ${missing[0]}）` };
  }
  const differ = wroteKeys.filter((k) => wrote[k] !== read[k]);
  if (differ.length > 0) {
    return { state: NG, note: `${differ.length}件 中身が違う（例: ${differ[0]}）` };
  }
  // 🔴 書いていないものが返るのも異常（他のBotの記憶が混ざる形）
  const extra = Object.keys(read).filter((k) => !Object.hasOwn(wrote, k));
  if (extra.length > 0) {
    return { state: NG, note: `🔴 書いていない ${extra.length}件が返った（例: ${extra[0]}）＝別のBotの記憶が混ざっている疑い` };
  }
  return { state: OK, note: `${wroteKeys.length}件 すべて一致` };
}

/* ─────────────────────────────────────────────
 * 契約3 取得の応答を「実物の形」で判定する
 *
 * 🔴 これが実測でいちばん効いた発見。
 *
 *   ① HTTP を見ずに中身のキーだけで判定すると、403 を「200で空」と誤読する
 *      → 入口で httpStatus が無ければ **判定不能**（中身だけの判定を合格にしない）
 *   ② 403 を「解約」と決めつけない
 *      → 実測では鍵の誤りは 401 に分かれていたが、403 の理由は応答に入っていない。
 *        理由が入っていない以上、こちら側では決められない → **判定不能**
 *   ③ catch-all があり、存在しない口も 200 を返す
 *      → 200 でも files が無ければ **判定不能**（口が在ることを 200 で証明しない）
 *   ④ { files: {} } は3つの意味を持つ
 *        本当に0件 ／ 読めなかった ／ 保存が空
 *
 *   🔴 ④ は当初案（synced_at 無し＝ok）とは違う形にした。
 *      「②（読めなかった）は分けられない」ことが分かっているため。
 *      分けられないものを ok に倒すと、保存側の障害が黙って通ります。
 *      → synced_at 無し＋空 は **判定不能**。減らすには受け口側の応答を増やすしかない。
 * ───────────────────────────────────────────── */
export function judgeGetResponse(probe, expectedBotId) {
  if (probe === null || typeof probe !== "object") {
    return { state: UNKNOWN, note: "応答そのものが無い" };
  }
  if (!Object.hasOwn(probe, "httpStatus")) {
    return { state: UNKNOWN, note: "🔴 HTTP status を見ていない（中身のキーだけで判定している）" };
  }
  const s = probe.httpStatus;
  if (s === 401) {
    return { state: NG, note: "401 Authorization が Bot で始まっていない（鍵の渡し方が誤り）" };
  }
  if (s === 403) {
    return { state: UNKNOWN, note: "🔴 403 の理由が応答に入っていない＝こちら側では決められない（実測では鍵の誤りは 401 側に分かれた）" };
  }
  if (s !== 200) {
    return { state: UNKNOWN, note: `想定外の HTTP ${s}（形が分からない）` };
  }
  if (!Object.hasOwn(probe, "body")) {
    return { state: UNKNOWN, note: "本文を読んでいない" };
  }
  const body = probe.body;
  if (body === null || typeof body !== "object") {
    return { state: UNKNOWN, note: "🔴 200 だが本文が object でない（catch-all が文字列を返している疑い）" };
  }
  if (!Object.hasOwn(body, "files")) {
    return { state: UNKNOWN, note: "🔴 200 だが files が無い＝口が存在しない可能性（catch-all は 200 を返す）" };
  }
  const files = body.files;
  if (!isFilesShape(files)) {
    return { state: NG, note: "files がオブジェクトでない（実物の形と違う＝実装が変わった）" };
  }
  const count = Object.keys(files).length;
  const synced = typeof body.synced_at === "string" && body.synced_at.length > 0;
  if (count > 0) {
    // 🔴 誰の記憶かを確かめる（レビューで見つけた穴）
    //   中身が返ってきたとき、それが【自分の記憶か】を見ていなかった。
    //   別のBotの記憶が返れば、利用者の記憶が別の利用者に見える＝最悪の事故。
    //   ★空のとき bot_id は返らない（仕様より）ので、
    //     照合は「中身が在るとき」だけ必須にする。
    if (expectedBotId === undefined || expectedBotId === null || expectedBotId === "") {
      return { state: UNKNOWN, note: "🔴 自分の bot_id を渡していない＝別のBotの記憶が返っても気づけない" };
    }
    if (typeof body.bot_id !== "string" || body.bot_id.length === 0) {
      return { state: UNKNOWN, note: "🔴 応答に bot_id が無い＝誰の記憶か分からない" };
    }
    if (body.bot_id !== expectedBotId) {
      return { state: NG, note: `🔴🔴 別のBotの記憶が返っている（応答 ${body.bot_id} / 自分 ${expectedBotId}）` };
    }
    return { state: OK, note: `${count}件 読めた${synced ? `（synced_at ${body.synced_at}）` : "（synced_at 無し）"}` };
  }
  if (synced) {
    return { state: NG, note: "🔴 保存済み（synced_at 有り）なのに中身が空＝記憶が消えている" };
  }
  return {
    state: UNKNOWN,
    note: "空かつ synced_at 無し ＝『本当に0件』と『読めなかった』を区別できない（応答で分ける必要がある）",
  };
}

/* ─────────────────────────────────────────────
 * 契約4 接続できないとき「書けたことにしない」
 * ───────────────────────────────────────────── */
export function judgeFailLoud(result) {
  if (result === null || typeof result !== "object") {
    return { state: UNKNOWN, note: "結果が object でない" };
  }
  if (!Object.hasOwn(result, "serverUp")) return { state: UNKNOWN, note: "接続の状態が分からない" };
  if (!Object.hasOwn(result, "reportedSuccess")) return { state: UNKNOWN, note: "成功を報告したかが分からない" };
  if (result.serverUp === true) {
    return { state: OK, note: "接続できている（この契約の対象外）" };
  }
  return result.reportedSuccess === false
    ? { state: OK, note: "落ちているときに失敗を返している" }
    : { state: NG, note: "🔴 落ちているのに成功を返した（記憶が黙って消える）" };
}

/* ─────────────────────────────────────────────
 * 契約5 sync で既にある記憶を黙って消さないこと（新設）
 *
 *   仕様の引用: 「丸ごと上書き（差分ではない）
 *                  → files に入れなかったものは消えます」
 *
 *   これは私の契約に無かった危険です。
 *   「1ファイルだけ直して sync」を素直に書くと、残り全部が消えます。
 *   ★決まり「利用者のデータを上書きで消さない」に直接あたります。
 * ───────────────────────────────────────────── */
export function judgeNoSilentDelete(before, sending) {
  if (!isFilesShape(before)) {
    return { state: UNKNOWN, note: "いま在るものが files の形（オブジェクト）でない＝先に取得できていない" };
  }
  if (!isFilesShape(sending)) {
    return { state: UNKNOWN, note: "送るものが files の形（オブジェクト）でない" };
  }
  const lost = Object.keys(before).filter((k) => !Object.hasOwn(sending, k));
  if (lost.length > 0) {
    return {
      state: NG,
      note: `🔴 ${lost.length}件が黙って消える（例: ${lost[0]}）＝sync は丸ごと上書き。送る files に全部入れる必要がある`,
    };
  }
  return {
    state: OK,
    note: `消える記憶なし（いま ${Object.keys(before).length}件 → 送る ${Object.keys(sending).length}件）`,
  };
}

/* ─────────────────────────────────────────────
 * 契約5-2 追記専用の口は「消える経路」を持たないこと（追加）
 *
 *   案B（save_memory から保存先へも送る）を選んだ場合の契約。
 *   どの口に送るかで危険度がまったく違う:
 *
 *     ❌ syncPath   { files: {全部} }  ← 丸ごと上書き
 *        → save_memory は1ファイルずつ書く道具。1件送るたびに他が全部消える
 *     ✅ appendPath { path, content }  ← 1ファイルだけ足す
 *        → 消える経路が原理的に無い
 *
 *   🔴 契約5（judgeNoSilentDelete）は sync を使う場合の守り。
 *      この契約は「そもそも sync を使わない」ことを確かめる。
 * ───────────────────────────────────────────── */
export function judgeAppendOnly(call) {
  if (call === null || typeof call !== "object") {
    return { state: UNKNOWN, note: "呼び出しの中身が分からない" };
  }
  if (typeof call.endpoint !== "string" || call.endpoint.length === 0) {
    return { state: UNKNOWN, note: "どの口に送るか分からない" };
  }
  if (call.endpoint === API_SHAPE.syncPath) {
    return { state: NG, note: `🔴 ${API_SHAPE.syncPath} は丸ごと上書き（1ファイル送ると他が全部消える）` };
  }
  if (call.endpoint !== API_SHAPE.appendPath) {
    return { state: UNKNOWN, note: `知らない口（${call.endpoint}）＝何をするか分からない` };
  }
  // append の口でも、files をまるごと渡していたら同じ危険
  if (call.body !== null && typeof call.body === "object" && Object.hasOwn(call.body, "files")) {
    return { state: NG, note: "🔴 append の口に files をまるごと渡している＝上書きと同じ形" };
  }
  if (call.body === null || typeof call.body !== "object") {
    return { state: UNKNOWN, note: "送る中身が object でない" };
  }
  const hasPath = typeof call.body.path === "string" && call.body.path.length > 0;
  const hasContent = typeof call.body.content === "string";
  if (!hasPath) return { state: NG, note: "path が無い（どこに足すか決まっていない）" };
  if (!hasContent) return { state: NG, note: "content が無い（何を足すか決まっていない）" };
  return { state: OK, note: `1ファイルだけ足す（${call.body.path}）＝消える経路なし` };
}

/* ─────────────────────────────────────────────
 * 契約6 オフラインで書いた分の行き先が決まっていること
 *
 * 🔴 既定が確定している
 *   「ネットが切れたら Claude Code 自体が動かない → オフライン対応は不要」
 *   → 既定は "block"（オフラインでは書かせない）
 *   → 🟢 ただし契約そのものは残す。「起こらないはず」を無言で通すと、
 *      起きたときに誰も気づかない。
 * ───────────────────────────────────────────── */
export const OFFLINE_POLICIES = ["discard", "queue", "block"];
export const OFFLINE_DEFAULT = "block";
export function judgeOfflinePolicy(policy) {
  if (policy === undefined || policy === null) {
    return { state: OK, note: `既定を適用: ${OFFLINE_DEFAULT}` };
  }
  return OFFLINE_POLICIES.includes(policy)
    ? { state: OK, note: `方針: ${policy}` }
    : { state: NG, note: `知らない方針（${policy}）＝実装が何をするか分からない` };
}

// ─────────────────────────────────────────────
/* ============================================================
 * 契約8 写しが最新か（追加）
 *
 * 🔴 前提が変わった: 新しい方針（正本は保存先・手元は写し）で
 *    契約5-1「ローカルに記憶が残っていたら不合格」は成立しなくなった。
 *    写しは【残っていて正常】。判定すべきは「正本と一致しているか」。
 *
 * 🔴 実測を骨にする:
 *    「時刻は【いつ触ったか】。【中身が同じか】は答えない」
 *    （実測: touch すると時刻は変わるが md5 は同じ）
 *    → 合否は【印】で決める。時刻は【向き】を決めるためだけに使う。
 *
 * 🔴 印が違うときの意味は2つある（まとめると片方を壊す）
 *    ① 写しが古い（正本が新しい）→ 戻せばよい
 *    ② 利用者が手で直した（ローカルが新しい）→ 上書きしてはいけない
 * ============================================================ */
export function judgeCopyFreshness(entry) {
  if (entry === null || typeof entry !== "object") {
    return { state: UNKNOWN, note: "🔴 判定の材料が無い" };
  }
  const str = (k) => Object.hasOwn(entry, k) && typeof entry[k] === "string" && entry[k] !== "";
  const hasLocal = str("localHash");
  const hasServer = str("serverHash");

  if (!hasServer && !hasLocal) {
    return { state: UNKNOWN, note: "🔴 両方に印が無い（読めなかったのか存在しないのか区別できない）" };
  }
  if (!hasServer) {
    return { state: UNKNOWN, note: "🔴 印が無い（理由は分かりません）" };
  }
  if (!hasLocal) {
    return { state: OK, action: "restore", note: "ローカルに写しが無い＝戻す対象（不合格ではない）" };
  }
  if (entry.localHash === entry.serverHash) {
    return { state: OK, action: "none", note: "写しは正本と一致している" };
  }

  // 🔴 型も見る（実測: 数値で渡すと 365日前と計算されて blank になっていた）
  const bad = (v) => typeof v !== "string" || v === "" || !Number.isFinite(new Date(v).getTime());
  const lt = Object.hasOwn(entry, "localMtime") ? entry.localMtime : undefined;
  const st = Object.hasOwn(entry, "serverSyncedAt") ? entry.serverSyncedAt : undefined;
  if (bad(lt) || bad(st)) {
    return { state: UNKNOWN, action: "ask", note: "🔴 印が違うが【どちらが新しいか】が分からない（時刻が無い・読めない）" };
  }
  const l = new Date(lt).getTime(), sv = new Date(st).getTime();
  if (l === sv) {
    return { state: UNKNOWN, action: "ask", note: "🔴 印が違うのに時刻が同じ＝向きを決められない" };
  }
  if (sv > l) return { state: OK, action: "restore", note: "写しが古い（正本が新しい）" };
  return { state: OK, action: "keep", note: "🔴 ローカルの方が新しい＝利用者が手で直した可能性。上書きしてはいけない" };
}

/* 🔴 契約5-1 の位置づけを変える（消さずに適用範囲を明記する） */
export const CONTRACT_5_1_SCOPE =
  "切り替えの途中で『まだ送っていない分が残っていないか』を見る用途に限る。" +
  "運用開始後は写しが残るのが正常なので、合否の判定には使わない（契約8を使う）。";


/* ============================================================
 * 契約9 動いてよいか
 *
 * 🔴🔴 猶予（grace）は決まりとして取り下げました。★戻さないこと。
 *    方針: 判断は保存先が持つので、猶予期間は置かない
 *
 *    ★なぜ戻してはいけないか（後の人が「利用者に優しい」と思って戻しがちなので書く）:
 *      ① 猶予は【手元に動くものが残る】前提の設計だった。
 *         判断が手元に無いなら、繋がらない＝動かない。それだけで筋が通る。
 *      ② 猶予は【守りではない】（レビューの指摘）。
 *         最後に許可が取れた時刻は利用者の手元にあるので書き換えられる＝ずっと猶予内にできる。
 *      ③ レビューで見つかった穴は【全部】猶予から出ていた:
 *         時刻の置き場／手元がいまどうなっているか／初回／入れ直し／
 *         機械替え／更新／新しい機械／別の機械の値が戻ってきて猶予が伸びる
 *         → 猶予を外すと全部消える。守る力は無く、複雑さだけが残っていた。
 *
 * ✅ 判定は3本（迷う余地を残さない）:
 *      繋がって 許可あり → 動かす
 *      繋がって 不許可  → 空にする
 *      繋がらない      → 動かさない。ただし【空にはしない】
 *
 * 🔴 「動かさない」と「空にする」は別の操作（レビューの指摘）
 *    空にするのは【はっきり不許可と言われた】ときだけ。
 *    繋がらないのは利用者の落ち度ではないので、手元を1文字も変えない。
 *    通信が戻れば そのまま動く。
 *
 * 🔴 4本目だけ残す（レビューの指摘・これは猶予とは別の話）
 *    「繋がらなかった」と「呼び出し側が材料を渡し忘れた」は別物。
 *    材料を渡すのは呼び出し側なので、渡し忘れで利用者の手元を空にしてはいけない。
 *    しかも渡し忘れは1人ではなく全員に同時に効く。
 *    区別する材料は【問い合わせたという事実】:
 *      reachable === false → 問い合わせた・繋がらなかった → 空にする（利用者の状況）
 *      reachable === true かつ 答えが無い → 応答が壊れている → 何もしない
 *      reachable が無い    → 問い合わせたのかも分からない → 何もしない（呼び出し側の不備）
 * ============================================================ */
export const RUN = {
  ALLOW: "allow",  // 許可あり → 動かす
  BLANK: "blank",  // 【はっきり不許可】のときだけ → 中身を空にする（消すのではなく書き直す）
  // 🔴 この4つのうち、BLANK だけ実際に通したことがない。
  //    許可なしの状態を作るには、実際に解約された状態が要るため。
  //    ALLOW / HOLD / SKIP は起動して通せる。BLANK は通せない。
  //    ＝ 手元のものを空にする唯一の経路が、いちばん試しにくい。
  //    ここを合格と書かない。「まだ通していない」と書く。
  // 🔴 HOLD（レビューの指摘で新設）
  //    「動かさない」と「空にする」は別の操作。繋がらないだけで中身を消してはいけない。
  //    通信が戻れば そのまま動く。利用者の手元は1文字も変えない。
  HOLD: "hold",    // 動かさない・中身はそのまま（通信断）
  // 🔴 SKIP（レビューの指摘で新設）
  //    材料が足りない＝【呼び出し側の渡し忘れ】。利用者は何もしていない。
  //    「材料が無い→空にする」は 利用者を疑う方向の安全だった。逆に倒す。
  SKIP: "skip",    // 判定できない（呼び出し側の不備）→ 何もしない＋記録に残す
  // 🔴 GRACE（猶予内なので動かす）は決まりとして取り下げ。上の理由を読むこと。
};

export function judgeRunPermission(probe) {
  if (probe === null || typeof probe !== "object") {
    return { state: UNKNOWN, run: RUN.SKIP, note: "🔴 材料が渡されていない＝呼び出し側の不備。何もしない（記録に残す）" };
  }
  // ① 明示的な答えがある場合だけ、その答えに従う
  if (Object.hasOwn(probe, "allowed") && typeof probe.allowed === "boolean") {
    return probe.allowed
      ? { state: OK, run: RUN.ALLOW, note: "許可あり＝動かす" }
      : { state: OK, run: RUN.BLANK, note: "許可なし＝中身を空にする（消すのではなく書き直す）" };
  }
  // ② 答えが無い。ここで【問い合わせたのか】を見る。見ないと 利用者の通信断と
  //    呼び出し側の渡し忘れが 同じ「答えが無い」に潰れる。
  const asked = Object.hasOwn(probe, "reachable") ? probe.reachable : undefined;
  if (asked === false) {
    return { state: OK, run: RUN.HOLD, note: "問い合わせたが繋がらなかった＝動かさない。ただし中身は空にしない（空にするのは はっきり不許可のときだけ）" };
  }
  if (asked === true) {
    return { state: UNKNOWN, run: RUN.SKIP, note: "🔴 繋がったのに許可の答えが無い＝応答が壊れている。何もしない（記録に残す）" };
  }
  return { state: UNKNOWN, run: RUN.SKIP, note: "🔴 問い合わせたかどうかが渡されていない＝呼び出し側の不備。何もしない（記録に残す）" };
}

/* ─────────────────────────────────────────────
 * 契約10: メンションに反応できる状態か
 *
 * 決まり: どのサーバーでも「メンションされたら反応する／されなければ反応しない」。
 *   コードが正しくても、本文を読む権限が OFF だと本文が空になり
 *   メンション判定そのものが通らない。そして誰にも見えない。
 *
 * 🔴 判定の分かれ目は「値」ではなく【確認したか】:
 *     確認して OFF …… 満たさない（直せる・画面に出せる）
 *     確認していない … 判定不能（推測しない）
 *
 * 🔴 なぜ「OFF なら判定不能」にしないか:
 *   判定不能は「分からない」を表す。OFF と分かっているなら【分かっている】＝満たさない。
 *   ここを判定不能にすると、直せる不具合が「様子見」の山に混ざって誰も直さない。
 *
 *   読む順序は judgeNoLocalMemory と同じ（この契約の共通の形）。
 * ───────────────────────────────────────────── */
export const REACHABLE_FIELDS = ["messageContentIntent", "guildMessagesIntent"];

export function judgeReachable(check) {
  if (check === null || typeof check !== "object") {
    return { state: UNKNOWN, note: "確認の結果そのものが無い" };
  }
  if (!Object.hasOwn(check, "checked")) {
    return { state: UNKNOWN, note: "確認したかどうかが分からない" };
  }
  if (check.checked !== true) {
    return { state: UNKNOWN, note: `確認していない（${check.reason || "理由なし"}）` };
  }
  // 🔴 「確認済み」と言うなら、判定に使う欄が全部あること。
  //    欄が無いまま満たすと返すと「見ていないもの」を合格にする。
  for (const k of REACHABLE_FIELDS) {
    if (!Object.hasOwn(check, k)) {
      return { state: UNKNOWN, note: `${k} の欄が無い＝確認済みとは言えない` };
    }
  }
  const missing = [];
  if (check.messageContentIntent !== true) missing.push("本文を読む設定が OFF");
  if (check.guildMessagesIntent !== true) missing.push("サーバーの発言を受け取る設定が OFF");
  if (Array.isArray(check.blindGuilds) && check.blindGuilds.length > 0) {
    missing.push(`見えていないサーバー ${check.blindGuilds.length}件`);
  }
  return missing.length === 0
    ? { state: OK, note: "メンションに反応できる（確認済み）" }
    : { state: NG, note: `反応できない: ${missing.join(" / ")}` };
}


/* ============================================================
 * 呼ぶ側が渡す欄の名前（新設）
 *
 * 🔴 なぜ要るか（実測でこの日1回踏んだ）
 *    serverSyncedAt を serverMtime と書いて渡したら、判定は「ask（判定できない）」
 *    になった。止まるのは設計どおりだが、【なぜ止まったか】が呼ぶ側から分からない。
 *    欄の名前は判定器の中にしか無く、呼ぶ側は当てるしかなかった。
 *
 * ✅ 名前をここに出して、実装が読む名前と一致していることを自己テストで縛る。
 *    実装だけ変えて定数を直し忘れたら落ちる（実装から名前を抜き出して突き合わせる）。
 * ============================================================ */
export const CONTRACT_FIELDS = {
  // 契約9 動いてよいか（両方とも「無ければ無い」でよい＝欄ごと省ける）
  runPermission: ["allowed", "reachable"],
  // 契約8 写しが最新か（印は必須・時刻は印が食い違ったときだけ要る）
  copyFreshness: ["localHash", "serverHash", "localMtime", "serverSyncedAt"],
};


const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain && process.argv.includes("--selftest")) {
  const PLANNED = 139;
  let ok = 0;
  const failed = [];
  const t = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { ok++; console.log(`  OK ${label}`); }
    else { failed.push(label); console.log(`  NG ${label}\n     期待: ${JSON.stringify(want)}\n     実際: ${JSON.stringify(got)}`); }
  };
  const safe = (fn) => { try { return fn(); } catch (e) { return `例外: ${e.message}`; } };

  // 🔴 実物そのものを読む（記憶 selftest-must-read-the-constant-it-guards）
  //    「取り下げた理由が書いてあるか」は自分のソースを読まないと確かめられない。
  //    🔴 ただし【自己テストのコード自身】を読ませない。
  //       判定に使う語を検査の中に書くと、その行自身がマッチして「書いてある」になる
  //       ＝理由を消しても合格する（実測・記憶 self-check-must-exclude-itself）。
  const SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8").split("const isMain =")[0];

  console.log("自己テスト（合格させる側と落とす側の両方）");

  // ── 実物の形そのものを読む（記憶 selftest-must-read-the-constant-it-guards）
  console.log("\n[実物の形の定数]");
  t("🔴 files はオブジェクト（配列ではない）", safe(() => API_SHAPE.filesIsObject), true);
  t("🔴 中身が無くても 200 が返る", safe(() => API_SHAPE.emptyReturnsHttp200), true);
  t("🔴 sync は丸ごと上書き（差分ではない）", safe(() => API_SHAPE.syncOverwritesAll), true);
  t("🔴 403 は2つの意味を持つ", safe(() => API_SHAPE.forbiddenIsAmbiguous), true);
  t("🔴 catch-all がある（200 で口の実在を判定しない）", safe(() => API_SHAPE.hasCatchAll), true);
  t("口の名前（get）", safe(() => API_SHAPE.getPath), "/api/memory/get");
  t("口の名前（sync）", safe(() => API_SHAPE.syncPath), "/api/memory/sync");

  // ── 契約1
  console.log("\n[契約1 ローカルに記憶が残っていない]");
  t("走査して0件なら満たす", safe(() => judgeNoLocalMemory({ scanned: true, files: [] }).state), OK);
  t("🔴 1件でも残っていれば満たさない", safe(() => judgeNoLocalMemory({ scanned: true, files: ["memory/today.md"] }).state), NG);
  t("🔴 走査していなければ判定不能", safe(() => judgeNoLocalMemory({ scanned: false, reason: "権限なし" }).state), UNKNOWN);
  t("🔴 走査したかが無ければ判定不能", safe(() => judgeNoLocalMemory({ files: [] }).state), UNKNOWN);
  t("🔴 一覧が配列でなければ判定不能", safe(() => judgeNoLocalMemory({ scanned: true, files: 0 }).state), UNKNOWN);
  t("見る場所は memory/ だけ（定数そのものを読む）", safe(() => MEMORY_PATHS), ["memory/"]);
  t("memory/ の中は範囲内", safe(() => isInMemoryScope("memory/today.md")), true);
  t("🔴 CLAUDE.md は範囲外（除外ではなく 最初から見ない）", safe(() => isInMemoryScope("CLAUDE.md")), false);
  t("🔴 鍵も範囲外", safe(() => isInMemoryScope(".env")), false);
  t("🔴 範囲外が混ざった走査は 判定不能", safe(() => judgeNoLocalMemory({ scanned: true, files: ["CLAUDE.md"] }).state), UNKNOWN);
  t("🔴 範囲外が混ざれば 0件でなくても 判定不能", safe(() => judgeNoLocalMemory({ scanned: true, files: ["memory/a.md", ".env"] }).state), UNKNOWN);

  // ── 契約2（実物の形＝オブジェクト）
  console.log("\n[契約2 書いたものが読み戻せる]");
  t("1ファイル: 同じなら満たす", safe(() => judgeRoundTrip("abc", "abc").state), OK);
  t("🔴 1ファイル: 値が違えば満たさない", safe(() => judgeRoundTrip("abc", "xyz").state), NG);
  t("🔴 読み戻せなければ満たさない（null）", safe(() => judgeRoundTrip("abc", null).state), NG);
  t("🔴 読み戻していなければ判定不能", safe(() => judgeRoundTrip("abc", undefined).state), UNKNOWN);
  t("空文字を書いて空文字が返れば満たす", safe(() => judgeRoundTrip("", "").state), OK);
  t("🔴 空文字を書いたのに別の値が返れば満たさない", safe(() => judgeRoundTrip("", "x").state), NG);
  t("files: 全部一致なら満たす",
    safe(() => judgeRoundTrip({ "memory/a.md": "A", "memory/b.md": "B" }, { "memory/a.md": "A", "memory/b.md": "B" }).state), OK);
  t("🔴 files: 1件 欠けたら満たさない",
    safe(() => judgeRoundTrip({ "memory/a.md": "A", "memory/b.md": "B" }, { "memory/a.md": "A" }).state), NG);
  t("🔴 files: 中身が違えば満たさない",
    safe(() => judgeRoundTrip({ "memory/a.md": "A" }, { "memory/a.md": "ちがう" }).state), NG);
  t("🔴 files: 書いていないものが返れば満たさない（別のBotの記憶が混ざる形）",
    safe(() => judgeRoundTrip({ "memory/a.md": "A" }, { "memory/a.md": "A", "memory/他人.md": "X" }).state), NG);
  t("🔴 files: 配列で返ったら判定不能（実物の形と違う）",
    safe(() => judgeRoundTrip({ "memory/a.md": "A" }, ["memory/a.md"]).state), UNKNOWN);
  t("🔴 files: 片方だけ文字列なら満たさない",
    safe(() => judgeRoundTrip({ "memory/a.md": "A" }, "A").state), NG);
  t("files: 両方 空オブジェクトなら満たす", safe(() => judgeRoundTrip({}, {}).state), OK);

  // ── 契約3（🔴 実物の応答の形）
  console.log("\n[契約3 取得の応答を実物の形で判定]");
  t("🔴 HTTP を見ていなければ判定不能（実際に踏んだ形）",
    safe(() => judgeGetResponse({ body: { files: {} } }).state), UNKNOWN);
  t("🔴 その理由が note に出る",
    safe(() => judgeGetResponse({ body: { files: {} } }).note.includes("HTTP status を見ていない")), true);
  t("401 は満たさない（鍵の渡し方が誤り）",
    safe(() => judgeGetResponse({ httpStatus: 401, body: { error: "Auth required" } }).state), NG);
  t("🔴 403 は判定不能（解約と鍵の誤りを分けられない）",
    safe(() => judgeGetResponse({ httpStatus: 403, body: { error: "Unauthorized" } }).state), UNKNOWN);
  // 🔴 文言そのものを照合しない（実測でコメントを直したとき、ここだけ落ちて中身は無傷だった）。
  //    見たいのは「403 を黙って通さず、決められない理由を note に残しているか」。
  t("🔴 403 の note に『決められない理由』が残る",
    safe(() => { const n = judgeGetResponse({ httpStatus: 403, body: {} }).note;
      return n.includes("403") && n.includes("決められない"); }), true);
  t("🔴 500 は判定不能", safe(() => judgeGetResponse({ httpStatus: 500, body: {} }).state), UNKNOWN);
  t("🔴 200 で本文が文字列なら判定不能（catch-all）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: "Server v0.0.0" }).state), UNKNOWN);
  t("🔴 200 で files が無ければ判定不能（口が存在しない可能性）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { ok: true } }).state), UNKNOWN);
  t("🔴 その理由に catch-all が出る",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { ok: true } }).note.includes("catch-all")), true);
  t("🔴 files が配列なら満たさない（実装が形を変えた）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { files: [] } }).state), NG);
  t("中身が読めて bot_id が自分なら満たす",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { bot_id: "B1", files: { "memory/a.md": "A" }, synced_at: "1970-01-01T10:00:00Z" } }, "B1").state), OK);
  t("synced_at が無くても 中身と bot_id が揃えば満たす",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { bot_id: "B1", files: { "memory/a.md": "A" } } }, "B1").state), OK);
  // 🔴 レビューの指摘から見つけた穴（検体が「まっさら」の形しかなかった）
  t("🔴🔴 別のBotの記憶が返れば満たさない（利用者の記憶が混ざる事故）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { bot_id: "B2", files: { "memory/a.md": "A" } } }, "B1").state), NG);
  t("🔴 その理由に相手と自分の id が出る",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { bot_id: "B2", files: { "memory/a.md": "A" } } }, "B1").note.includes("B2")), true);
  t("🔴 自分の bot_id を渡していなければ判定不能",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { bot_id: "B1", files: { "memory/a.md": "A" } } }).state), UNKNOWN);
  t("🔴 空文字の bot_id を渡しても判定不能（渡し忘れと同じ）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { bot_id: "B1", files: { "memory/a.md": "A" } } }, "").state), UNKNOWN);
  t("🔴 応答に bot_id が無ければ判定不能（誰の記憶か分からない）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { files: { "memory/a.md": "A" } } }, "B1").state), UNKNOWN);
  t("空のときは bot_id を照合しない（返らないため）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { files: {}, synced_at: "1970-01-01T10:00:00Z" } }, "B1").state), NG);
  t("🔴 保存済みなのに空＝満たさない（記憶が消えている）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { files: {}, synced_at: "1970-01-01T10:00:00Z" } }).state), NG);
  t("🔴🔴 空かつ synced_at 無しは 判定不能（本当に0件 と 読めなかった を分けられない）",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { files: {} } }).state), UNKNOWN);
  t("🔴 その理由が note に出る",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { files: {} } }).note.includes("区別できない")), true);
  t("🔴 synced_at が空文字なら『無い』と同じ扱い",
    safe(() => judgeGetResponse({ httpStatus: 200, body: { files: {}, synced_at: "" } }).state), UNKNOWN);
  t("🔴 本文を読んでいなければ判定不能",
    safe(() => judgeGetResponse({ httpStatus: 200 }).state), UNKNOWN);
  t("🔴 応答そのものが無ければ判定不能", safe(() => judgeGetResponse(null).state), UNKNOWN);

  // ── 契約4
  console.log("\n[契約4 落ちているとき書けたことにしない]");
  t("落ちているとき失敗を返せば満たす",
    safe(() => judgeFailLoud({ serverUp: false, reportedSuccess: false }).state), OK);
  t("🔴 落ちているのに成功を返せば満たさない",
    safe(() => judgeFailLoud({ serverUp: false, reportedSuccess: true }).state), NG);
  t("接続できていればこの契約の対象外",
    safe(() => judgeFailLoud({ serverUp: true, reportedSuccess: true }).state), OK);
  t("🔴 生死が分からなければ判定不能", safe(() => judgeFailLoud({ reportedSuccess: false }).state), UNKNOWN);
  t("🔴 成功report が無ければ判定不能", safe(() => judgeFailLoud({ serverUp: false }).state), UNKNOWN);

  // ── 契約5（🔴 新設・丸ごと上書き）
  console.log("\n[契約5 sync で既にある記憶を黙って消さない]");
  t("全部入れて送れば満たす",
    safe(() => judgeNoSilentDelete({ "memory/a.md": "A", "memory/b.md": "B" }, { "memory/a.md": "A2", "memory/b.md": "B" }).state), OK);
  t("🔴🔴 1件だけ送ると 残りが消える＝満たさない",
    safe(() => judgeNoSilentDelete({ "memory/a.md": "A", "memory/b.md": "B" }, { "memory/a.md": "A2" }).state), NG);
  t("🔴 消える件数と例が note に出る",
    safe(() => judgeNoSilentDelete({ "memory/a.md": "A", "memory/b.md": "B" }, { "memory/a.md": "A" }).note.includes("memory/b.md")), true);
  t("新しく足すのは満たす（既存を消していない）",
    safe(() => judgeNoSilentDelete({ "memory/a.md": "A" }, { "memory/a.md": "A", "memory/c.md": "C" }).state), OK);
  t("向こうが空なら何でも満たす",
    safe(() => judgeNoSilentDelete({}, { "memory/a.md": "A" }).state), OK);
  t("🔴🔴 空を送ると 全部消える＝満たさない",
    safe(() => judgeNoSilentDelete({ "memory/a.md": "A" }, {}).state), NG);
  t("🔴 先に取得できていなければ判定不能（before が無い）",
    safe(() => judgeNoSilentDelete(null, { "memory/a.md": "A" }).state), UNKNOWN);
  t("🔴 before が配列なら判定不能（実物の形と違う）",
    safe(() => judgeNoSilentDelete(["memory/a.md"], { "memory/a.md": "A" }).state), UNKNOWN);
  t("🔴 送るものが files の形でなければ判定不能",
    safe(() => judgeNoSilentDelete({ "memory/a.md": "A" }, null).state), UNKNOWN);

  // ── 契約6
  console.log("\n[契約5-2 追記専用の口]");
  t("口の名前（append）", safe(() => API_SHAPE.appendPath), "/api/memory/append");
  t("append に1ファイル足すのは満たす",
    safe(() => judgeAppendOnly({ endpoint: API_SHAPE.appendPath, body: { path: "memory/a.md", content: "A" } }).state), OK);
  t("🔴🔴 sync に送るのは満たさない（1件で他が全部消える）",
    safe(() => judgeAppendOnly({ endpoint: API_SHAPE.syncPath, body: { files: { "memory/a.md": "A" } } }).state), NG);
  t("🔴 その理由が note に出る",
    safe(() => judgeAppendOnly({ endpoint: API_SHAPE.syncPath, body: {} }).note.includes("丸ごと上書き")), true);
  t("🔴 append の口でも files をまるごと渡せば満たさない",
    safe(() => judgeAppendOnly({ endpoint: API_SHAPE.appendPath, body: { files: { "memory/a.md": "A" } } }).state), NG);
  t("🔴 path が無ければ満たさない",
    safe(() => judgeAppendOnly({ endpoint: API_SHAPE.appendPath, body: { content: "A" } }).state), NG);
  t("🔴 content が無ければ満たさない",
    safe(() => judgeAppendOnly({ endpoint: API_SHAPE.appendPath, body: { path: "memory/a.md" } }).state), NG);
  t("空文字の content は満たす（空を足すのは正しい操作）",
    safe(() => judgeAppendOnly({ endpoint: API_SHAPE.appendPath, body: { path: "memory/a.md", content: "" } }).state), OK);
  t("🔴 知らない口は判定不能",
    safe(() => judgeAppendOnly({ endpoint: "(知らない口)", body: {} }).state), UNKNOWN);
  t("🔴 どの口か分からなければ判定不能",
    safe(() => judgeAppendOnly({ body: {} }).state), UNKNOWN);

  console.log("\n[契約6 オフラインの行き先]");
  t("discard は決まった方針", safe(() => judgeOfflinePolicy("discard").state), OK);
  t("queue は決まった方針", safe(() => judgeOfflinePolicy("queue").state), OK);
  t("block は決まった方針", safe(() => judgeOfflinePolicy("block").state), OK);
  t("🔴 既定は block（決まり）＝定数そのものを読む", safe(() => OFFLINE_DEFAULT), "block");
  t("🔴 既定は 知っている3つのどれかである", safe(() => OFFLINE_POLICIES.includes(OFFLINE_DEFAULT)), true);
  t("未指定は 既定 block を適用して満たす", safe(() => judgeOfflinePolicy(null).state), OK);
  t("🔴 ただし既定を使ったことは note に出す", safe(() => judgeOfflinePolicy(null).note.includes("既定を適用")), true);
  t("🔴 undefined も同じ（黙って落とさない）", safe(() => judgeOfflinePolicy(undefined).state), OK);
  t("🔴 知らない語は満たさない", safe(() => judgeOfflinePolicy("たぶん保存").state), NG);

  // ── 契約8 写しが最新か（レビューの型: 合否は印・向きは時刻） ──
  t("印が同じ → 一致（何もしない）", safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "a" }).action), "none");
  t("ローカルに無い → 戻す対象", safe(() => judgeCopyFreshness({ serverHash: "a" }).action), "restore");
  t("ローカルに無いのは不合格ではない", safe(() => judgeCopyFreshness({ serverHash: "a" }).state), OK);
  t("🔴 印が無い → 判定不能", safe(() => judgeCopyFreshness({ localHash: "a" }).state), UNKNOWN);
  t("🔴 両方に印が無い → 判定不能", safe(() => judgeCopyFreshness({}).state), UNKNOWN);
  t("🔴 材料が object でない → 判定不能", safe(() => judgeCopyFreshness("a").state), UNKNOWN);
  t("🔴 空文字の印は「無い」と同じ", safe(() => judgeCopyFreshness({ localHash: "", serverHash: "a" }).action), "restore");
  t("印が違い 正本が新しい → 戻す", safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "b", localMtime: "1970-01-01T01:00:00Z", serverSyncedAt: "1970-01-01T02:00:00Z" }).action), "restore");
  t("🔴 印が違い ローカルが新しい → 上書きしない", safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "b", localMtime: "1970-01-01T03:00:00Z", serverSyncedAt: "1970-01-01T02:00:00Z" }).action), "keep");
  t("🔴 印が違い 時刻が無い → 判定不能", safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "b" }).state), UNKNOWN);
  t("🔴 印が違い 時刻が壊れている → 判定不能", safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "b", localMtime: "いつか", serverSyncedAt: "1970-01-01T02:00:00Z" }).state), UNKNOWN);
  t("🔴 印が違い 時刻が同じ → 向きを決められない", safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "b", localMtime: "1970-01-01T02:00:00Z", serverSyncedAt: "1970-01-01T02:00:00Z" }).state), UNKNOWN);
  t("🔴 時刻だけ違い印は同じ → 一致（touch で誤判定しない）", safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "a", localMtime: "1970-01-01T09:00:00Z", serverSyncedAt: "1970-01-01T01:00:00Z" }).action), "none");
  t("契約5-1 の適用範囲が明記されている", safe(() => CONTRACT_5_1_SCOPE.includes("合否の判定には使わない")), true);

  // ── 呼ぶ側が渡す欄の名前（実装から抜き出して定数と突き合わせる）
  console.log("\n[呼ぶ側が渡す欄の名前]");
  {
    const pick = (fnName) => {
      const body = SOURCE.slice(SOURCE.indexOf(`export function ${fnName}`));
      const end = body.indexOf("\n}\n");
      const seg = end === -1 ? body : body.slice(0, end);
      return [...seg.matchAll(/Object\.hasOwn\(\s*\w+\s*,\s*"([^"]+)"\)/g)].map((m) => m[1]);
    };
    const cmp = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
    t("🔴 契約9の欄名が実装と一致（定数だけ古くならない）",
      safe(() => cmp(pick("judgeRunPermission"), CONTRACT_FIELDS.runPermission)), true);
    // 🔴 契約8の印（localHash/serverHash）はヘルパ経由で読むので名前を抜き出せない。
    //    抜き出せた分は「定数に入っていること」で見て、
    //    抜き出せない分は【渡さないと判定不能になる】ことを実際に呼んで確かめる。
    t("🔴 契約8の抜き出せた欄名が全部 定数に入っている",
      safe(() => pick("judgeCopyFreshness").every((k) => CONTRACT_FIELDS.copyFreshness.includes(k))), true);
    t("🔴 localHash を渡さないと判定不能（ヘルパ経由の欄も効いている）",
      safe(() => judgeCopyFreshness({ serverHash: "b", localMtime: "1970-01-01T03:00:00Z", serverSyncedAt: "1970-01-01T02:00:00Z" }).action), "restore");
    t("🔴 serverHash を渡さないと判定不能",
      safe(() => judgeCopyFreshness({ localHash: "a", localMtime: "1970-01-01T03:00:00Z", serverSyncedAt: "1970-01-01T02:00:00Z" }).state), UNKNOWN);
    t("🔴 serverMtime は受け取らない（この日 実際に間違えた名前）",
      safe(() => CONTRACT_FIELDS.copyFreshness.includes("serverMtime")), false);
    t("🔴 名前を間違えて渡すと合格させず判定不能にする",
      safe(() => judgeCopyFreshness({ localHash: "a", serverHash: "b", localMtime: "1970-01-01T03:00:00Z", serverMtime: "1970-01-01T02:00:00Z" }).state), UNKNOWN);
  }

  // ── 契約9 動いてよいか（猶予は決まりとして取り下げ） ──
  console.log("\n[契約9 動いてよいか]");
  t("許可あり → 動かす", safe(() => judgeRunPermission({ allowed: true }).run), RUN.ALLOW);
  t("許可なし → 空にする", safe(() => judgeRunPermission({ allowed: false }).run), RUN.BLANK);
  t("🔴 許可なしは【消す】ではなく【空にする】", safe(() => judgeRunPermission({ allowed: false }).note.includes("消すのではなく")), true);
  t("繋がらなかった → 動かさない（hold）", safe(() => judgeRunPermission({ reachable: false }).run), RUN.HOLD);
  t("🔴 繋がらないだけでは空にしない（レビュー③・レビューの整理）", safe(() => judgeRunPermission({ reachable: false }).run !== RUN.BLANK), true);
  t("🔴 空にするのは【はっきり不許可】のときだけ", safe(() => Object.entries({ 不許可: { allowed: false }, 通信断: { reachable: false }, 渡し忘れ: {} }).filter(([, v]) => judgeRunPermission(v).run === RUN.BLANK).map(([k]) => k)), ["不許可"]);
  t("🔴 繋がらないの hold は合格として扱う（判定できている）", safe(() => judgeRunPermission({ reachable: false }).state), OK);
  t("🔴 繋がったのに答えが無い → 何もしない", safe(() => judgeRunPermission({ reachable: true }).run), RUN.SKIP);
  t("🔴 問い合わせたかが渡されていない → 何もしない（レビュー指摘③）", safe(() => judgeRunPermission({}).run), RUN.SKIP);
  t("🔴 材料が無い → 何もしない（利用者を空にしない）", safe(() => judgeRunPermission(null).run), RUN.SKIP);
  t("🔴 材料が配列 → 何もしない", safe(() => judgeRunPermission([]).run), RUN.SKIP);
  t("🔴 allowed が文字列 → 答えと見なさない", safe(() => judgeRunPermission({ allowed: "true" }).run), RUN.SKIP);
  t("🔴 allowed が数値 → 答えと見なさない", safe(() => judgeRunPermission({ allowed: 1 }).run), RUN.SKIP);
  t("🔴 reachable が文字列 → 問い合わせた事実と見なさない", safe(() => judgeRunPermission({ reachable: "false" }).run), RUN.SKIP);
  t("🔴 reachable が 0 → 問い合わせた事実と見なさない", safe(() => judgeRunPermission({ reachable: 0 }).run), RUN.SKIP);
  t("🔴 許可の答えは reachable より優先（false でも許可なら動かす）", safe(() => judgeRunPermission({ allowed: true, reachable: false }).run), RUN.ALLOW);
  t("🔴 猶予日数を渡しても無視される（引数が消えている）", safe(() => judgeRunPermission({ reachable: false }, 14).run), RUN.HOLD);
  t("🔴 昔の時刻の欄を渡しても猶予にならない", safe(() => judgeRunPermission({ lastAllowedAt: "1970-01-01T00:00:00Z", now: "1970-01-01T00:00:00Z" }).run), RUN.SKIP);
  t("🔴 GRACE は語彙から消えている（戻していない）", safe(() => Object.values(RUN).includes("grace")), false);
  t("🔴 取り下げた理由が実物に書いてある（後の人が戻さないため）", safe(() => /猶予期間は置かない/.test(SOURCE)), true);
  t("🔴 SKIP は「空にする」ではない（利用者は無傷）", safe(() => judgeRunPermission({}).run !== RUN.BLANK), true);
  t("✅ 3本の判定が全部そろう（許可・不許可・通信断）", safe(() => [judgeRunPermission({ allowed: true }).run, judgeRunPermission({ allowed: false }).run, judgeRunPermission({ reachable: false }).run]), [RUN.ALLOW, RUN.BLANK, RUN.HOLD]);

  // ── 契約10 メンションに反応できる状態か ──
  console.log("\n[契約10 メンションに反応できる状態か]");
  t("確認済みで両方ON → 満たす", safe(() => judgeReachable({ checked: true, messageContentIntent: true, guildMessagesIntent: true }).state), OK);
  t("🔴 本文を読む設定がOFF → 満たさない（判定不能にしない）", safe(() => judgeReachable({ checked: true, messageContentIntent: false, guildMessagesIntent: true }).state), NG);
  t("🔴 発言を受け取る設定がOFF → 満たさない", safe(() => judgeReachable({ checked: true, messageContentIntent: true, guildMessagesIntent: false }).state), NG);
  t("🔴 見えていないサーバーがあれば満たさない", safe(() => judgeReachable({ checked: true, messageContentIntent: true, guildMessagesIntent: true, blindGuilds: ["x"] }).state), NG);
  t("🔴 確認していなければ判定不能（推測しない）", safe(() => judgeReachable({ checked: false, reason: "起動直後" }).state), UNKNOWN);
  t("🔴 確認したかが無ければ判定不能", safe(() => judgeReachable({ messageContentIntent: true, guildMessagesIntent: true }).state), UNKNOWN);
  t("🔴🔴 欄が無いまま確認済みと言われても判定不能（見ていないものを合格にしない）", safe(() => judgeReachable({ checked: true, messageContentIntent: true }).state), UNKNOWN);
  t("🔴 材料が無ければ判定不能", safe(() => judgeReachable(null).state), UNKNOWN);
  t("判定に使う欄は2つ（定数そのものを読む）", safe(() => REACHABLE_FIELDS), ["messageContentIntent", "guildMessagesIntent"]);

  console.log("");
  const ran = ok + failed.length;
  if (ran !== PLANNED) {
    console.log(`自己テスト: 判定不能（${PLANNED}件の予定に対し ${ran}件しか走っていません）`);
    process.exit(2);
  }
  if (failed.length > 0) {
    console.log(`自己テスト: 不合格（${failed.length}件）`);
    failed.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log(`自己テスト: 合格（${ok}件・合格させる側と落とす側の両方）`);
  console.log("");
  console.log("  ⚠️ この合格が意味しないこと:");
  console.log("     ・実際の接続では試していません（契約の判定だけ）");
  console.log("     ・API の形はソースから引いたもので、叩いた実測ではありません");
  console.log("     ・通しテストで形が違ったら、この契約を直す必要があります");
  process.exit(0);
}
