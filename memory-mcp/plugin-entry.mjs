// 控えの取得から保存までを、順に呼ぶための入口。
//
// ここでは判断をしません。順に呼んで、控えの印を突き合わせるだけです。
// 控えが取れたことを確かめる前には、1手も消しません。

import fs from 'node:fs'
import path from 'node:path'

// 隣のファイルは、置き場によって名前が違うことがあります。
//   名前を決め打ちすると、片方でしか動きません。
//   どちらの名前でも読める形にし、見つからなければその場で止めます。
//
// 名前だけで選ぶと、同じ名前の別物を掴むことがあります。
//   読めた ＝ 欲しいものが在る ではありません。
//   欲しい名前が実際に在るかまで見ます。
async function load(want, ...names) {
  const tried = []
  for (const n of names) {
    try {
      const m = await import(n)
      if (m[want]) return m
      tried.push(`${n}: 読めたが ${want} が無い`)
    } catch (e) { tried.push(`${n}: ${e.code ?? e.message}`) }
  }
  // ★「無い」ではなく「★見た先には 無い」と 書く
  throw new Error(`${want} が 見つかりません … 見た ${tried.length}箇所: ${tried.join(' / ')}`)
}

const _bk = await load('makeBackup', './backup.mjs', './archive-backup.mjs')
const _sl = await load('sealFile', './seal-stream.mjs', './archive-seal.mjs')
const _up = await load('uploadArchive', './upload.mjs', './archive-upload.mjs')
const _rs = await load('restore', './restore.mjs', './archive-restore.mjs')
const _sg = await load('Refused', './safeguard.mjs', './archive-safeguard.mjs')

const makeBackup = _bk.makeBackup
const sealFile = _sl.sealFile
const uploadArchive = _up.uploadArchive
const restore = _rs.restore
const Refused = _sg.Refused

/** どの名前で 読めたか（★テストと 診断で 使う） */
export const LOADED = {
  backup: _bk.makeBackup ? 'ok' : 'missing',
  seal: _sl.sealFile ? 'ok' : 'missing',
  upload: _up.uploadArchive ? 'ok' : 'missing',
  restore: _rs.restore ? 'ok' : 'missing',
  safeguard: _sg.Refused ? 'ok' : 'missing',
}

/**
 * 控えを取って、保存先へ送るまで。
 *
 * @param {object} a
 * @param {string} a.baseUrl   送り先
 * @param {string} a.token     トークン
 * @param {string} a.clientId  お客様の識別子
 * @param {string} a.root      控えを取る大元（絶対パス）
 * @param {string} a.workDir   作業に使う置き場（★大元の外・絶対パス）
 * @param {Buffer=} a.kekRaw   鍵（32バイト）。無ければ 封をしない
 * @param {Function=} a.fetchImpl テスト用
 * @param {Function=} a.onStep 進み具合を受け取る（省略可）
 */
export async function archiveForClient(a) {
  const { baseUrl, token, clientId, root, workDir, kekRaw } = a ?? {}
  const step = a?.onStep ?? (() => {})
  if (!clientId) throw new Refused('PE_CLIENT', 'お客様の識別子がありません')
  if (!root || !path.isAbsolute(root)) throw new Refused('PE_ROOT', '大元が絶対パスではありません')
  if (!workDir || !path.isAbsolute(workDir)) throw new Refused('PE_WORK', '作業の置き場が絶対パスではありません')

  // ★同じ鍵が二度と来ない値（時刻を含む）
  const archiveId = `${clientId}-${new Date().toISOString().replace(/[:.]/g, '-')}`

  // ① 控えを取る（★取れたことを確かめてから verified が立つ）
  step({ at: 'backup', archiveId })
  const backup = makeBackup({ root, destDir: workDir, clientId })
  if (backup.verified !== true) throw new Refused('PE_NOT_VERIFIED', '控えが揃いませんでした')

  // ② 封をする（★鍵があるときだけ）
  let envelope, file = backup.archive
  if (kekRaw) {
    step({ at: 'seal', archiveId })
    const out = path.join(workDir, `${archiveId}.enc`)
    envelope = await sealFile({ file: backup.archive, out, kekRaw, aad: { archiveId, kind: 'archive' } })
    file = envelope.ctFile ?? out
  }

  // ③ 送る（★印を突き合わせるところまで uploadArchive が見る）
  step({ at: 'upload', archiveId })
  const receipt = await uploadArchive({
    baseUrl, token, clientId, archiveId, backup, envelope, file,
    fetchImpl: a?.fetchImpl,
  })

  step({ at: 'done', archiveId })
  return { archiveId, files: backup.files, bytes: backup.bytes, sealed: !!kekRaw, receipt }
}

/**
 * 控えから戻す。
 *
 * ★戻す先が 空でないと restore が止める（今あるものの上に書かない）。
 * ★★控えの中身が 戻す先の外を指していても restore が止める（RS_ESCAPES）。
 *
 * @param {object} a
 * @param {object} a.backup  makeBackup が返したもの
 * @param {string} a.into    戻す先（絶対パス）
 * @param {boolean=} a.dryRun
 */
export function restoreForClient(a) {
  const { backup, into, dryRun = false } = a ?? {}
  if (!backup) throw new Refused('PE_NO_BACKUP', '控えの情報がありません')
  return restore({ backup, into, dryRun })
}

/**
 * いま送れる状態か（★送らずに 確かめるだけ）
 *
 * 🔴 「送ってみて 失敗したら分かる」では お客様の手元で 初めて分かる。
 *    ★先に 確かめられるものは 先に 確かめる。
 */
export function preflight(a) {
  const { baseUrl, token, clientId, root, workDir } = a ?? {}
  const ng = []
  if (!baseUrl) ng.push('設定が足りません')
  if (!token) ng.push('設定が足りません')
  if (!clientId) ng.push('お客様の識別子がありません')
  if (!root || !path.isAbsolute(root)) ng.push('大元が絶対パスではありません')
  else if (!fs.existsSync(root)) ng.push('大元が見つかりません')
  if (!workDir || !path.isAbsolute(workDir)) ng.push('作業の置き場が絶対パスではありません')
  else if (path.resolve(workDir).startsWith(path.resolve(root) + path.sep)) {
    ng.push('作業の置き場が 大元の中にあります（控えが 控えの対象に入ります）')
  }
  return { ok: ng.length === 0, reasons: ng }
}
