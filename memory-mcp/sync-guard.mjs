// 📌 いまの立ち位置: このファイルは【配布物】。配る一式の server.ts が import している。
//   ここを書き換えると、お客様の機械で動くものが変わる。内部の言葉を書かない。
//   🔴 ここには長く「まだどこからも import されていない」と書いてあった。
//      書き場だけを見て判断していた。配る側を見ると呼ぶ側が在った。
//      「配るものかどうか」は自分の意識ではなく import する側で決まる。

/**
 * sync-guard.mjs — 送る前の関所
 *
 *   使い方（送る側のコードから）:
 *     import { guardSync, SEND } from './memory-mcp/sync-guard.mjs'
 *     const g = await guardSync({ endpoint, sending, body, fetchCurrent })
 *       sending … syncPath に送る files（丸ごと）
 *       body    … appendPath に送る { path, content }（1件）
 *     if (g.send !== SEND.OK) { 送らない・g.reason を人の目に出す }
 *
 *   なぜ要るか:
 *     判定そのものは memory-contract.mjs に在ったが、
 *     呼ぶ側が1件も無かった（実測）。
 *     判定器だけでは何も守れない。ここが「呼ぶ側」。
 *
 *   守っていること:
 *     syncPath は丸ごと上書き。送らなかったものは消える。
 *     1ファイルだけ直して送ると、残りが全部消える。
 */
import { judgeNoSilentDelete, judgeAppendOnly, judgeFailLoud, API_SHAPE, OK, NG } from "./memory-contract.mjs";

export const SEND = {
  OK: "send",   // 送ってよい
  STOP: "stop", // 送るな（消えるものがある）
  // 🔴 SKIP は「判定できなかった」。ここを送ってよいに倒さない。
  //    測れていないものを通すのが、いちばん多い壊れ方だった。
  SKIP: "skip",
};

export async function guardSync({ endpoint, sending, body, fetchCurrent } = {}) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return { send: SEND.SKIP, reason: "どの口に送るか渡されていません" };
  }

  // ① 消える経路を持たない口なら、そもそも比べる必要がない
  if (endpoint === API_SHAPE.appendPath) {
    // 🔴 判定器は body（path / content）まで見る。ここで渡さないと
    //    「中身が分からない」で止まる（自己テストで発見）。
    const shape = judgeAppendOnly({ endpoint, body });
    if (shape.state === OK) return { send: SEND.OK, reason: shape.note };
    if (shape.state === NG) return { send: SEND.STOP, reason: shape.note };
    return { send: SEND.SKIP, reason: shape.note };
  }

  // ② 丸ごと上書きの口。向こうに在るものと比べないと送れない
  if (endpoint === API_SHAPE.syncPath) {
    if (typeof fetchCurrent !== "function") {
      return { send: SEND.SKIP, reason: "いま在るものを取る手段が渡されていません（比べられないので送りません）" };
    }
    let before;
    try {
      before = await fetchCurrent();
    } catch (e) {
      return { send: SEND.SKIP, reason: `いま在るものを取れませんでした（${e?.message ?? "理由不明"}）＝送りません` };
    }
    const v = judgeNoSilentDelete(before, sending);
    if (v.state === NG) return { send: SEND.STOP, reason: v.note };
    if (v.state !== OK) return { send: SEND.SKIP, reason: v.note };
    return { send: SEND.OK, reason: v.note };
  }

  // ③ 知らない口。丸ごと上書きかどうか分からない
  return { send: SEND.SKIP, reason: `${endpoint} が上書きの口かどうか分かりません（送りません）` };
}

/**
 * afterSend — 送ったあとの結果を見る（契約4）
 *
 *   送る前（guardSync）と対で使う。
 *   向こうが落ちているのに「成功」を返すと、記憶が黙って消えます。
 *
 *     const v = afterSend({ serverUp, reportedSuccess })
 *     if (!v.trustworthy) { 人の目に v.reason を出す }
 */
export function afterSend(result) {
  const v = judgeFailLoud(result);
  if (v.state === OK) return { trustworthy: true, reason: v.note };
  // 🔴 NG も UNKNOWN も「信用しない」に倒す。
  //    判定できなかったものを成功に倒すのが、いちばん多い壊れ方でした。
  return { trustworthy: false, reason: v.note };
}

/* ── 自己テスト（node sync-guard.mjs --selftest） ── */
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && process.argv.includes("--selftest")) {
  const PLANNED = 20;
  let ok = 0; const failed = [];
  const t = async (label, fn, want) => {
    let got; try { got = await fn(); } catch (e) { got = `例外:${e?.message}`; }
    if (got === want) { ok++; console.log(`  OK ${label}`); }
    else { failed.push(`${label} → ${got}（期待 ${want}）`); console.log(`  🔴 ${label} → ${got}（期待 ${want}）`); }
  };
  const now = { "a.md": "1", "b.md": "2" };
  const cur = async () => now;

  await t("全部送るなら送ってよい",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { ...now }, fetchCurrent: cur })).send, SEND.OK);
  await t("🔴 1件落とすと止まる",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { "a.md": "1" }, fetchCurrent: cur })).send, SEND.STOP);
  await t("🔴 止めた理由に件数が出る",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { "a.md": "1" }, fetchCurrent: cur })).reason.includes("1件"), true);
  await t("増やす分には送ってよい",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { ...now, "c.md": "3" }, fetchCurrent: cur })).send, SEND.OK);
  await t("🔴 全部消す（空を送る）は止まる",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: {}, fetchCurrent: cur })).send, SEND.STOP);
  await t("足す口に1件渡せば送ってよい",
    async () => (await guardSync({ endpoint: API_SHAPE.appendPath, body: { path: "c.md", content: "3" } })).send, SEND.OK);
  await t("🔴 足す口に files をまるごと渡したら止まる",
    async () => (await guardSync({ endpoint: API_SHAPE.appendPath, body: { files: now } })).send, SEND.STOP);
  await t("🔴 足す口に何を足すか渡さなければ送らない",
    async () => (await guardSync({ endpoint: API_SHAPE.appendPath })).send, SEND.SKIP);
  await t("🔴 取る手段が無ければ送らない",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { ...now } })).send, SEND.SKIP);
  await t("🔴 取るのに失敗したら送らない",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { ...now }, fetchCurrent: async () => { throw new Error("繋がりません"); } })).send, SEND.SKIP);
  await t("🔴 失敗の理由が出る",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { ...now }, fetchCurrent: async () => { throw new Error("繋がりません"); } })).reason.includes("繋がりません"), true);
  await t("🔴 いま在るものが形違いなら送らない",
    async () => (await guardSync({ endpoint: API_SHAPE.syncPath, sending: { ...now }, fetchCurrent: async () => [] })).send, SEND.SKIP);
  await t("🔴 知らない口には送らない",
    async () => (await guardSync({ endpoint: "(知らない口)", sending: { ...now }, fetchCurrent: cur })).send, SEND.SKIP);
  await t("🔴 口が渡されていなければ送らない",
    async () => (await guardSync({ sending: { ...now } })).send, SEND.SKIP);

  // ── 送ったあと（契約4）
  await t("向こうが生きていれば信用する",
    () => afterSend({ serverUp: true, reportedSuccess: true }).trustworthy, true);
  await t("落ちていて失敗を返していれば信用する",
    () => afterSend({ serverUp: false, reportedSuccess: false }).trustworthy, true);
  await t("🔴 落ちているのに成功を返したら信用しない",
    () => afterSend({ serverUp: false, reportedSuccess: true }).trustworthy, false);
  await t("🔴 その理由が出る",
    () => afterSend({ serverUp: false, reportedSuccess: true }).reason.includes("黙って消える"), true);
  await t("🔴 生死が分からなければ信用しない",
    () => afterSend({ reportedSuccess: true }).trustworthy, false);
  await t("🔴 結果が渡されていなければ信用しない",
    () => afterSend(undefined).trustworthy, false);

  if (ok !== PLANNED || failed.length > 0) {
    console.error(`\n🔴 自己テスト: 不合格（${ok}/${PLANNED}）`);
    failed.forEach((f) => console.error(`   ${f}`));
    process.exit(1);
  }
  console.log(`\n自己テスト: 合格（${PLANNED}件・送る側と止める側の両方）`);
  console.log("  ⚠️ この合格が意味しないこと:");
  console.log("     ・実際には送っていません（判定だけ）");
  console.log("     ・送る側のコードがこの関所を呼ぶかは、呼ぶ側の作りしだいです");
}
