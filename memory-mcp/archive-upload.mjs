// 控えを預ける（送る側 ── 受け口の対）
//
// 数GB規模になるため1リクエストでは送れない。分けて送る。
// 送りながら数えない。送る前に全部数え、送ったあとに印と突き合わせる。
//
//   makeBackup() → sealFile() → uploadArchive() → 受け口の印 → 突き合わせ
//
// 印が合わなければ verified を立てない。ここが立たない限り、
// safeguard.assertAllowed は 1手も消させない。

import fs from 'node:fs'
import path from 'node:path'
import { Refused } from './archive-safeguard.mjs'

const PART = 16 * 1024 * 1024      // 受け口が返す partSizeHint の既定値

/**
 * @param {object} a
 * @param {string} a.baseUrl    宛先
 * @param {string} a.token      Bot トークン
 * @param {string} a.clientId
 * @param {string} a.archiveId  同じ鍵が二度と来ない値（時刻を含む）
 * @param {object} a.backup     makeBackup() の戻り
 * @param {object=} a.envelope  sealFile() の戻り（暗号化した場合）
 * @param {string=} a.file      実際に送るファイル（既定は backup.archive）
 * @param {Function=} a.fetchImpl テスト用
 */
export async function uploadArchive(a) {
  const { baseUrl, token, clientId, archiveId, backup, envelope } = a ?? {}
  const fetchImpl = a?.fetchImpl ?? globalThis.fetch
  if (!baseUrl) throw new Refused('UP_URL', '設定が足りません')
  if (!token) throw new Refused('UP_TOKEN', '設定が足りません')
  if (!clientId || !archiveId) throw new Refused('UP_ID', '引数が足りません')
  if (!backup || backup.verified !== true) {
    throw new Refused('UP_NOT_VERIFIED', '控えが揃っていません')
  }

  const file = a.file ?? backup.archive
  if (!fs.existsSync(file)) throw new Refused('UP_NO_FILE', '控えが見つかりません')

  // ① 送る前に数える（★送りながら数えない）
  const bytes = fs.statSync(file).size
  if (bytes < 1) throw new Refused('UP_EMPTY', '控えが空です')

  const H = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }
  const call = async (p, init) => {
    const res = await fetchImpl(`${baseUrl}${p}`, init)
    let body = null
    try { body = await res.json() } catch { /* 本文が JSON でないことがある */ }
    return { status: res.status, body }
  }

  // ② 始める
  const beg = await call('/api/archive/begin', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      clientId, archiveId,
      expected: { files: backup.files, bytes },
      envelope: envelope ? stripSecrets(envelope) : undefined,
    }),
  })
  if (beg.status === 409) throw new Refused('UP_DUPLICATE', 'この識別子はすでに使われています')
  if (beg.status !== 200) throw new Refused('UP_BEGIN', 'いま実行できません')
  const { key, uploadId } = beg.body
  const partSize = Number(beg.body.partSizeHint) || PART

  // ③ 塊にして送る（★メモリに載せない）
  const parts = []
  const fd = fs.openSync(file, 'r')
  try {
    let off = 0, n = 1
    while (off < bytes) {
      const len = Math.min(partSize, bytes - off)
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, off)
      const r = await fetchImpl(
        `${baseUrl}/api/archive/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${n}`,
        { method: 'PUT', headers: { Authorization: `Bot ${token}` }, body: buf },
      )
      if (r.status !== 200) throw new Refused('UP_PART', '途中で止まりました')
      const rb = await r.json()
      parts.push({ partNumber: rb.partNumber, etag: rb.etag })
      off += len; n++
    }
  } finally { fs.closeSync(fd) }

  // ④ 完了 → 印を受け取る
  const fin = await call('/api/archive/complete', {
    method: 'POST', headers: H, body: JSON.stringify({ key, uploadId, parts }),
  })
  if (fin.status !== 200) {
    throw new Refused('UP_COMPLETE', '完了できませんでした')
  }

  // ⑤ 印を突き合わせる（★受け取った側が出した数と、送る前に数えた数）
  const receipt = fin.body?.receipt
  if (!receipt) throw new Refused('UP_NO_RECEIPT', '確認できませんでした')
  if (receipt.bytes !== bytes) {
    throw new Refused('UP_BYTES_MISMATCH', '確認できませんでした')
  }
  if (receipt.files !== backup.files) {
    throw new Refused('UP_FILES_MISMATCH', '確認できませんでした')
  }

  return { ...receipt, parts: parts.length, verified: true }
}

/** 封筒から、外に出してはいけないものを取り除く（鍵そのものは送らない） */
function stripSecrets(env) {
  const { ctFile, ...rest } = env      // 手元の置き場は送らない
  return rest
}
