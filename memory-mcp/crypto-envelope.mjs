/**
 * 封筒暗号化
 *
 * 何をするか:
 *   ① データごとに使い捨ての DEK を作り、AES-GCM で暗号化する
 *   ② その DEK を KEK で包む（AES-KW）
 *   ③ 置き場には「暗号文」と「包んだDEK」だけを置く
 *
 * 🔴 約束の範囲
 *   ここが守るのは「置き場を触るコードだけでは中身が読めない」ことまで。
 *   KEK を読める側は復号できる。全管理権限を持つ1人には対抗しない。
 *
 * 🔴 なぜ自前か
 *   実行環境に「呼べる暗号化API」が無い（一次資料で確認）。
 *   Secrets Store は保管と取り出しだけで、Encrypt/Decrypt に相当する操作を持たない。
 *   出典 実行環境の公式ドキュメント
 *
 * 使えるアルゴリズム（公式の対応表で確認）
 *   AES-GCM  encrypt/decrypt/generateKey/wrapKey/unwrapKey/importKey  ✓
 *   AES-KW   generateKey/wrapKey/unwrapKey/importKey                  ✓（encrypt不可）
 *   出典 実行環境の暗号APIの対応表
 */

const subtle = globalThis.crypto.subtle;

/** AES-GCM の IV は 96bit が推奨（NIST SP 800-38D） */
const IV_BYTES = 12;
/** この形式の版。lib/seal-stream.mjs と共有する。
 *  骨（DEKでデータ・KEKでDEK）が同じなので番号は分けない。 */
const FORMAT_VERSION = 1;

/** 本体をどこに置くか。v が同じでも読み方が違うので必ず見る。
 *  inline   … 暗号文を封筒の中に base64 で入れる（この実装）
 *  detached … 暗号文はファイルのまま・封筒には置き場だけ（seal-stream）
 *
 *  🔴 この実装で扱える大きさ
 *    大きいものは途中で heap out of memory で落ちる。
 *    plaintext ＋ 暗号文 ＋ base64文字列 が全部メモリに乗るため。
 *    上限は実行環境で変わるので、大きいものは detached を使う。
 *    → 大きな控えは detached を使う。 */
export const MODE_INLINE = "inline";

/**
 * KEK を Secrets Store から取り出した文字列（base64）から鍵にする。
 * 🔴 値そのものは絶対に返さない・ログにも出さない（記憶 never-print-secret-values）
 */
/**
 * 拒否を作る。
 * 🔴 外へ出す文言に「どこへ何を渡しているか」を書かない。
 *    区別が要る場面は message ではなく **err.code** を見る（Node.js の error.code と同じ形）。
 * @param {string} code 機械が見る識別子（外には出ない）
 * @param {string} message 外へ出る文言（短く・仕組みを語らない）
 */
function reject(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 拒否の識別子。自己テストと呼び出し側はこれで見分ける（文言では見分けない） */
export const CODES = Object.freeze({
  NO_KEK: "E_NO_KEK",
  BAD_KEK_LENGTH: "E_BAD_KEK_LENGTH",
  NO_AUDIT: "E_NO_AUDIT",
  BAD_FORMAT: "E_BAD_FORMAT",
  BAD_MODE: "E_BAD_MODE",
  BAD_PURPOSE: "E_BAD_PURPOSE",
  MISSING_ACTOR: "E_MISSING_ACTOR",
  MISSING_AAD: "E_MISSING_AAD",
});

export async function importKek(base64Kek) {
  if (typeof base64Kek !== "string" || base64Kek.length === 0) {
    throw reject(CODES.NO_KEK, "設定を読めません");
  }
  const raw = base64ToBytes(base64Kek);
  if (raw.byteLength !== 32) {
    // 長さだけ言う。値は言わない
    throw reject(CODES.BAD_KEK_LENGTH, "設定の形式が違います");
  }
  return subtle.importKey("raw", raw, { name: "AES-KW" }, false, ["wrapKey", "unwrapKey"]);
}

/**
 * 封筒に入れる。
 * @param {CryptoKey} kek importKek() が返した鍵
 * @param {Uint8Array} plaintext 中身
 * @param {object} aad 暗号化時から変わらない情報（用途・保管物ID・版）
 *   🔴 AAD は暗号文に結び付き、復号時に同じ値が必要。機密は入れない
 *      （AWS の Encryption Context と同じ考え方・CloudTrail に平文で載るのと同じ理由）
 * @returns {{v:number, iv:string, ct:string, wrappedDek:string, aad:object}}
 */
export async function seal(kek, plaintext, aad) {
  assertAad(aad);
  const dek = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encodeAad(aad) },
    dek,
    plaintext,
  );
  // DEK を KEK で包む。包んだものだけを置き場へ渡す
  const wrappedDek = await subtle.wrapKey("raw", dek, kek, { name: "AES-KW" });
  return {
    v: FORMAT_VERSION,
    mode: MODE_INLINE,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ct)),
    wrappedDek: bytesToBase64(new Uint8Array(wrappedDek)),
    aad,
  };
}

/**
 * 封筒から出す。
 * 🔴 独自④: 呼び出し側の規律に頼らず、監査を先に書いてから復号する。
 *    writeAudit が投げたら復号しない（＝記録の無い復号を起こさない）
 * @param {CryptoKey} kek
 * @param {object} envelope seal() の戻り値
 * @param {object} ctx 監査に残す情報（誰が・なぜ・どの用途か）
 * @param {(entry:object)=>Promise<void>} writeAudit 監査ログを永続化する関数
 */
/** 監査なしの復号を断るときの文言。自己テストがこの文言まで確かめる */
export const REJECT_NO_AUDIT = "この操作は許可されていません";

export async function open(kek, envelope, ctx, writeAudit) {
  if (typeof writeAudit !== "function") {
    throw reject(CODES.NO_AUDIT, REJECT_NO_AUDIT);
  }
  assertCtx(ctx);
  if (!envelope || envelope.v !== FORMAT_VERSION) {
    throw reject(CODES.BAD_FORMAT, "形式が違います");
  }
  // 🔴 v が同じでも読み方が違う。detached を inline として読むと壊れる
  if (envelope.mode !== MODE_INLINE) {
    // 🔴 外へは形式の違いだけを伝える。detached は lib/seal-stream.mjs で扱う（err.code で見分ける）
    throw reject(CODES.BAD_MODE, "形式が違います");
  }

  // 🔴 先に永続化する。ここで投げたら以降へ進まない
  await writeAudit({
    at: new Date().toISOString(),
    purpose: ctx.purpose, // consult / restore
    actor: ctx.actor,
    archiveId: envelope.aad?.archiveId,
    reason: ctx.reason,
    formatVersion: envelope.v,
  });

  const dek = await subtle.unwrapKey(
    "raw",
    base64ToBytes(envelope.wrappedDek),
    kek,
    { name: "AES-KW" },
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.iv),
      additionalData: encodeAad(envelope.aad),
    },
    dek,
    base64ToBytes(envelope.ct),
  );
  return new Uint8Array(pt);
}

/** purpose は consult / restore の2つだけ */
const PURPOSES = new Set(["consult", "restore"]);

function assertCtx(ctx) {
  if (!ctx || !PURPOSES.has(ctx.purpose)) {
    throw reject(CODES.BAD_PURPOSE, "設定の値が違います");
  }
  if (!ctx.actor) throw reject(CODES.MISSING_ACTOR, "設定が足りません");
}

function assertAad(aad) {
  if (!aad || !aad.archiveId) throw reject(CODES.MISSING_AAD, "設定が足りません");
}

function encodeAad(aad) {
  // キーの順序で結果が変わらないように並べ替える
  const sorted = Object.keys(aad)
    .sort()
    .reduce((o, k) => ((o[k] = aad[k]), o), {});
  return new TextEncoder().encode(JSON.stringify(sorted));
}

function bytesToBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ────────────────────────────────────────────────────────────
// 自己テスト（node crypto-envelope.mjs --selftest で走る）
// 🔴 exit の前に置く（記憶 appended-code-may-never-run）
// ────────────────────────────────────────────────────────────

async function selftest() {
  let pass = 0;
  let fail = 0;
  const t = async (name, fn) => {
    try {
      await fn();
      pass++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      fail++;
      console.log(`  ❌ ${name}\n     ${e.message}`);
    }
  };
  const must = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const mustThrow = async (fn, why) => {
    try {
      await fn();
    } catch {
      return;
    }
    throw new Error(`落ちるはずが通った: ${why}`);
  };

  const kekB64 = bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const kek = await importKek(kekB64);
  const aad = { archiveId: "arch-001", kind: "memory", formatVersion: 1 };
  const secret = new TextEncoder().encode("秘密の中身（これが漏れてはいけない）");
  const audits = [];
  const writeAudit = async (e) => void audits.push(e);

  console.log("\n■ 陽性対照（正しい経路が本当に通るか）");
  await t("包んで開くと元に戻る", async () => {
    const env = await seal(kek, secret, aad);
    const out = await open(kek, env, { purpose: "consult", actor: "nori" }, writeAudit);
    must(new TextDecoder().decode(out) === new TextDecoder().decode(secret), "中身が一致しない");
  });
  await t("保管する形に平文が入っていない", async () => {
    const env = await seal(kek, secret, aad);
    const json = JSON.stringify(env);
    must(!json.includes("秘密の中身"), "平文が封筒に混ざっている");
  });
  await t("IVが毎回変わる", async () => {
    const a = await seal(kek, secret, aad);
    const b = await seal(kek, secret, aad);
    must(a.iv !== b.iv, "IVが同じ");
  });
  await t("DEKがデータごとに作り直される（使い回されていない）", async () => {
    const a = await seal(kek, secret, aad);
    const b = await seal(kek, secret, aad);
    must(a.wrappedDek !== b.wrappedDek, "DEKが使い回されている");
    must(a.ct !== b.ct, "暗号文が同じ");
  });
  await t("他の封筒の包んだDEKにすり替えても開けない", async () => {
    const a = await seal(kek, secret, aad);
    const b = await seal(kek, secret, aad);
    a.wrappedDek = b.wrappedDek;
    await mustThrow(
      () => open(kek, a, { purpose: "consult", actor: "x" }, writeAudit),
      "別の封筒のDEKで開けた",
    );
  });
  await t("監査が実際に書かれている", async () => {
    const before = audits.length;
    const env = await seal(kek, secret, aad);
    await open(kek, env, { purpose: "restore", actor: "system", reason: "再入会" }, writeAudit);
    must(audits.length === before + 1, "監査が増えていない");
    must(audits.at(-1).purpose === "restore", "purpose が残っていない");
    must(audits.at(-1).archiveId === "arch-001", "archiveId が残っていない");
  });

  console.log("\n■ 陰性対照（壊したら本当に落ちるか）");
  await t("別のKEKでは開けない", async () => {
    const env = await seal(kek, secret, aad);
    const other = await importKek(
      bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(32))),
    );
    await mustThrow(
      () => open(other, env, { purpose: "consult", actor: "x" }, writeAudit),
      "別のKEKで開けてしまった",
    );
  });
  await t("暗号文を1バイト変えると開けない", async () => {
    const env = await seal(kek, secret, aad);
    const ct = base64ToBytes(env.ct);
    ct[0] ^= 0xff;
    env.ct = bytesToBase64(ct);
    await mustThrow(
      () => open(kek, env, { purpose: "consult", actor: "x" }, writeAudit),
      "改ざんが素通りした",
    );
  });
  await t("aad を書き換えると開けない（用途のすり替えを止める）", async () => {
    const env = await seal(kek, secret, aad);
    env.aad = { ...env.aad, kind: "credentials" };
    await mustThrow(
      () => open(kek, env, { purpose: "consult", actor: "x" }, writeAudit),
      "aadのすり替えが通った",
    );
  });
  await t("保管物IDが無い封筒は作れない（監査で追えなくなるため）", async () => {
    for (const badAad of [undefined, null, {}, { kind: "memory" }, { archiveId: "" }]) {
      let msg = null;
      let code = null;
      try {
        await seal(kek, secret, badAad);
      } catch (e) {
        msg = e.message;
        code = e.code;
      }
      must(msg !== null, `aad=${JSON.stringify(badAad)} で封筒が作れた`);
      must(code === CODES.MISSING_AAD, `拒否理由が違う（偶然落ちただけの可能性）: ${code} / ${msg}`);
    }
  });
  await t("KEKの長さが違うと受け付けない", async () => {
    await mustThrow(
      () => importKek(bytesToBase64(new Uint8Array(16))),
      "16バイトのKEKが通った",
    );
  });

  console.log("\n■ 🔴 負例（レビューで「実測ではない」と指摘された部分）");
  await t("負例A: 監査の書き込みが失敗したら復号しない", async () => {
    const env = await seal(kek, secret, aad);
    let decrypted = false;
    const brokenAudit = async () => {
      throw new Error("監査ログの書き込みに失敗");
    };
    try {
      await open(kek, env, { purpose: "consult", actor: "x" }, brokenAudit);
      decrypted = true;
    } catch (e) {
      must(e.message.includes("監査ログの書き込みに失敗"), `別の理由で落ちた: ${e.message}`);
    }
    must(decrypted === false, "監査が書けていないのに復号が実行された");
  });
  await t("負例B: 監査を渡さない経路が存在しない", async () => {
    const env = await seal(kek, secret, aad);
    // 🔴 「落ちた」だけでは足りない
    //    型チェックを if(false) に壊しても、undefined() の TypeError で偶然落ちて
    //    12件全部合格した。＝守りたい性質を守れていなかった。
    //    だから拒否の理由まで確かめる（記憶 assert-arrival-not-just-absence）
    for (const bad of [undefined, null, {}, "audit", 123, []]) {
      let msg = null;
      let code = null;
      try {
        await open(kek, env, { purpose: "consult", actor: "x" }, bad);
      } catch (e) {
        msg = e.message;
        code = e.code;
      }
      must(msg !== null, `writeAudit=${JSON.stringify(bad)} で復号できた`);
      must(
        code === CODES.NO_AUDIT,
        `writeAudit=${JSON.stringify(bad)} の拒否理由が違う（偶然落ちただけの可能性）: ${msg}`,
      );
    }
  });
  await t("purpose が consult / restore 以外なら落ちる", async () => {
    const env = await seal(kek, secret, aad);
    await mustThrow(
      () => open(kek, env, { purpose: "debug", actor: "x" }, writeAudit),
      "未定義の purpose が通った",
    );
  });
  await t("知らない形式の版は開かない（将来の形式変更で誤読しない）", async () => {
    const env = await seal(kek, secret, aad);
    for (const v of [0, 2, 99, undefined, "1"]) {
      const bad = { ...env, v };
      let msg = null;
      let code = null;
      try {
        await open(kek, bad, { purpose: "consult", actor: "x" }, writeAudit);
      } catch (e) {
        msg = e.message;
        code = e.code;
      }
      must(msg !== null, `版 ${v} の封筒が開けた`);
      must(
        code === CODES.BAD_FORMAT,
        `版 ${v} の拒否理由が違う（偶然落ちただけの可能性）: ${msg}`,
      );
    }
  });
  await t("🔴 detached の封筒をこの実装で開かない（seal-stream と取り違えない）", async () => {
    const env = await seal(kek, secret, aad);
    must(env.mode === "inline", `mode が入っていない: ${env.mode}`);
    for (const mode of ["detached", undefined, "", "INLINE"]) {
      let msg = null;
      let code = null;
      try {
        await open(kek, { ...env, mode }, { purpose: "consult", actor: "x" }, writeAudit);
      } catch (e) {
        msg = e.message;
        code = e.code;
      }
      must(msg !== null, `mode=${mode} の封筒が開けた`);
      must(code === CODES.BAD_MODE, `拒否理由が違う: ${code} / ${msg}`);
    }
  });
  await t("actor が空なら落ちる（誰が開かれたか分からない復号を許さない）", async () => {
    const env = await seal(kek, secret, aad);
    await mustThrow(
      () => open(kek, env, { purpose: "consult" }, writeAudit),
      "actor 無しで復号できた",
    );
  });

  console.log(`\n合計: ${pass} 件合格 / ${fail} 件失敗`);
  return fail === 0 ? 0 : 1;
}

if (process.argv.includes("--selftest")) {
  process.exit(await selftest());
}
