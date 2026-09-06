/**
 * 控えを取って預ける ── 呼び出し側から使う唯一の入口
 *
 * 呼び出し側が扱うのは { ok, why } だけ。件数・大きさ・宛先は返さない。
 *   → 数量は上位が保持するため、ここで重ねて持たない。
 *
 * 控えが検算を通らなければ、次の手に進まない。
 *   → 途中で止まったときに、元が欠けた状態にしないため。
 *
 *   server.ts からは1行:
 *     const r = await archiveNow({ root, clientId, archiveId, token, baseUrl, kekB64 })
 *     if (!r.ok) { … r.why … }
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeBackup } from './archive-backup.mjs'
import { sealFile } from './archive-seal.mjs'
import { uploadArchive } from './archive-upload.mjs'

/**
 * @param {object} a
 * @param {string} a.root      控えを取る大元（絶対パス）
 * @param {string} a.clientId
 * @param {string} a.archiveId 同じ値が二度と来ないもの（時刻を含む）
 * @param {string} a.token     Bot トークン
 * @param {string} a.baseUrl
 * @param {string=} a.kekB64   鍵（base64・32バイト）。無ければ暗号化しない
 * @param {string=} a.workDir  作業場所（既定は OS の一時領域）
 * @param {Function=} a.fetchImpl
 * @returns {Promise<{ok: boolean, why?: string}>}   ★件数・大きさ・送り先は返さない
 */
export async function archiveNow(a) {
  const { root, clientId, archiveId, token, baseUrl, kekB64 } = a ?? {}
  if (!root || !clientId || !archiveId || !token || !baseUrl) {
    return { ok: false, why: '引数が足りません' }
  }

  // 作業場所は毎回作って毎回消す（★大元の中には作らない）
  let work = null
  try {
    work = fs.mkdtempSync(path.join(a.workDir ?? os.tmpdir(), 'na-'))

    // ① 控えを取る（リンクを辿らない・大元の外を入れない・件数を検算する）
    let bk
    try {
      bk = makeBackup({ root, destDir: path.join(work, 'bk'), clientId })
    } catch (e) {
      return { ok: false, why: reason(e, '控えを作れませんでした') }
    }
    if (bk.verified !== true) return { ok: false, why: '控えが揃いませんでした' }

    // ② 封をする（鍵が渡されたときだけ）
    let sendFile = bk.archive
    let envelope
    if (kekB64) {
      let kek
      try {
        kek = Buffer.from(String(kekB64), 'base64')
      } catch { return { ok: false, why: '鍵の形が正しくありません' } }
      if (kek.length !== 32) return { ok: false, why: '鍵の形が正しくありません' }
      try {
        envelope = await sealFile({
          file: bk.archive, out: path.join(work, 'sealed.bin'),
          kekRaw: kek, aad: { archiveId, kind: 'archive' },
        })
        sendFile = envelope.ctFile
      } catch (e) {
        return { ok: false, why: reason(e, '封をできませんでした') }
      } finally {
        kek.fill(0)                                   // ★鍵をメモリから消す
      }
    }

    // ③ 送って、印を突き合わせる
    try {
      await uploadArchive({
        baseUrl, token, clientId, archiveId,
        backup: { ...bk, archive: sendFile }, file: sendFile,
        envelope, fetchImpl: a.fetchImpl,
      })
    } catch (e) {
      return { ok: false, why: reason(e, '完了できませんでした') }
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, why: reason(e, 'いま実行できません') }
  } finally {
    // ④ 作業場所は必ず消す（★控えも封筒も手元に残さない）
    if (work) { try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* 消せなくても続ける */ } }
  }
}

/**
 * 外へ出す理由を1行にする。
 * 🔴 ここで内部の値（件数・大きさ・置き場・HTTP コード）を外へ出さない。
 *    下位が返す message は既に整えてあるが、想定外の例外は文言を捨てる。
 */
function reason(e, fallback) {
  const m = String(e?.message ?? '')
  // 想定した拒否（Refused）だけ、そのまま通す
  if (e?.name === 'Refused' && m.length > 0 && m.length <= 40) return m
  return fallback
}
