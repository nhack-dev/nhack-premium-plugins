// 大きな控えを、メモリに載せずに封筒に入れる
//
// 一括方式（本体を base64 にして封筒へ入れる形）は、数百MBでメモリ不足になる。
//
//   理由 … plaintext ＋ ct（ArrayBuffer）＋ base64 文字列 が全部メモリに乗る。
//          文字列の長さに上限があるため、base64 にする時点で扱える大きさが決まる。
//
//   こちらが扱う控えは、その上限を大きく超える。
//
// 封筒の考え方（DEK でデータ・KEK で DEK）はそのまま使う。
// 変えるのは「本体をどこに置くか」だけ。
//   一括方式  ct を base64 にして封筒の中へ  … 小さいものに向く
//   こちら    ct はファイルのまま、封筒には置き場だけ … 大きな控えに向く

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Refused } from './archive-safeguard.mjs'

// 形式の版。番号は封筒の種類ごとに分ける
//   v: 1 = inline   … 本体を base64 で封筒の中へ（一括方式）
//   v: 2 = detached … 本体はファイルのまま、封筒には置き場だけ（こちら）
// 同じ v で包み方が違うと、版が版として働かない。
export const STREAM_FORMAT_VERSION = 2
// 一括方式（inline）と取り違えないための札。
//   inline   … 本体を base64 にして封筒の中へ（小さいもの向け）
//   detached … 本体はファイルのまま、封筒には置き場だけ（大きいもの向け）
export const STREAM_MODE = "detached"

/**
 * ファイルを、鍵を使ってその場で暗号化する（メモリに載せない）。
 * @param {object} a
 * @param {string} a.file      暗号化するファイル（控え）
 * @param {string} a.out       出力先
 * @param {Buffer} a.kekRaw    KEK の生バイト（32バイト）
 * @param {object} a.aad       archiveId / kind
 */
export async function sealFile(a) {
  const { file, out, kekRaw, aad } = a ?? {}
  if (!file || !fs.existsSync(file)) throw new Refused('SF_NO_FILE', `元のファイルが在りません: ${file}`)
  if (!out || !path.isAbsolute(out)) throw new Refused('SF_OUT', '出力先が絶対パスではありません')
  if (!Buffer.isBuffer(kekRaw) || kekRaw.length !== 32) throw new Refused('SF_KEK', 'KEK が32バイトではありません')
  if (!aad || !aad.archiveId || !aad.kind) throw new Refused('SF_AAD', '引数が足りません')

  // ① DEK を作る（1回きり・この控え専用）
  const dek = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)

  // ② 本体を DEK で暗号化しながら流す（★メモリに載らない）
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv)
  cipher.setAAD(aadBytes(aad))
  await pipeline(fs.createReadStream(file), cipher, fs.createWriteStream(out))
  const authTag = cipher.getAuthTag()

  // ③ DEK を KEK で包む（★包んだものだけを外へ）
  const wIv = crypto.randomBytes(12)
  const wrap = crypto.createCipheriv('aes-256-gcm', kekRaw, wIv)
  const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()])
  const wrapTag = wrap.getAuthTag()
  dek.fill(0)                                   // ★平文の DEK をメモリから消す

  return {
    v: STREAM_FORMAT_VERSION,
    mode: STREAM_MODE,
    ctFile: out,
    ctBytes: fs.statSync(out).size,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    wrappedDek: wrappedDek.toString('base64'),
    wrapIv: wIv.toString('base64'),
    wrapTag: wrapTag.toString('base64'),
    aad,
  }
}

/**
 * 封筒から本体を戻す。
 * 監査を先に書く。書けなければ復号しない。
 */
export async function openFile(a) {
  const { envelope, out, kekRaw, ctx, writeAudit } = a ?? {}
  if (!envelope || envelope.v !== STREAM_FORMAT_VERSION) {
    throw new Refused('OF_VERSION', 'この形式は扱えません')
  }
  // 一括方式の封筒（inline）をこちらに入れない
  if (envelope.mode !== STREAM_MODE) {
    throw new Refused('OF_MODE', `この口は ${STREAM_MODE} だけです: ${envelope.mode}`)
  }
  if (!Buffer.isBuffer(kekRaw) || kekRaw.length !== 32) throw new Refused('OF_KEK', 'KEK が32バイトではありません')
  if (!ctx || !['consult', 'restore'].includes(ctx.purpose)) {
    throw new Refused('OF_PURPOSE', `purpose は consult か restore だけです: ${ctx?.purpose}`)
  }
  if (!ctx.actor || !ctx.reason) throw new Refused('OF_CTX', 'actor と reason が要ります')
  if (typeof writeAudit !== 'function') throw new Refused('OF_NO_AUDIT', '監査を書く関数がありません')

  // ★先に監査を書く。書けなければ復号しない
  await writeAudit({ at: new Date().toISOString(), ...ctx, archiveId: envelope.aad?.archiveId, v: envelope.v })

  const wrap = crypto.createDecipheriv('aes-256-gcm', kekRaw, Buffer.from(envelope.wrapIv, 'base64'))
  wrap.setAuthTag(Buffer.from(envelope.wrapTag, 'base64'))
  let dek
  try { dek = Buffer.concat([wrap.update(Buffer.from(envelope.wrappedDek, 'base64')), wrap.final()]) }
  catch { throw new Refused('OF_UNWRAP', '鍵を開けませんでした（KEK が違うか、包みが壊れています）') }

  const dec = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.iv, 'base64'))
  dec.setAAD(aadBytes(envelope.aad))
  dec.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
  try { await pipeline(fs.createReadStream(envelope.ctFile), dec, fs.createWriteStream(out)) }
  catch { dek.fill(0); throw new Refused('OF_TAMPERED', '中身が書き換わっています（認証タグが合いません）') }
  dek.fill(0)
  return { out, bytes: fs.statSync(out).size }
}

/**
 * aad をキーの順に並べ替えてから固定の文字列にする。
 *
 * 実測で確かめた挙動:
 *   JSON.stringify はキーの挿入順をそのまま出す。
 *   同じ経路なら順序が保たれるので通るが、
 *   封筒のメタを DB（PostgreSQL の jsonb など）に入れ直すとキーが並べ替えられる。
 *   キーの順を入れ替えると、認証タグが合わず開けなくなる。
 *   バイト列のまま保存する形なら起きない。構造化して保存し直すと効いてくる。
 */
function aadBytes(aad) {
  const sorted = Object.keys(aad).sort().reduce((o, k) => (o[k] = aad[k], o), {})
  return Buffer.from(JSON.stringify(sorted))
}
