// 控えから戻す（工程6）
//
//
// 戻す側は、消す側とは別の危なさがある。
//   消す側 … 間違えると 消える（人が気づく）
//   戻す側 … 間違えると 今あるものの 上に 書く（★静かに 壊れる）
// なので「戻す先が空である」ことを 先に 確かめる。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Refused, resolveDeep } from './archive-safeguard.mjs'

/**
 * @param {object} a
 * @param {object} a.backup   makeBackup が返したもの（md5・files を使う）
 * @param {string} a.into     戻す先（絶対パス）
 * @param {boolean=} a.dryRun 動かさず、何が起きるかだけ返す
 */
export function restore(a) {
  const { backup, into, dryRun = false } = a ?? {}
  if (!backup || typeof backup !== 'object') throw new Refused('RS_NO_BACKUP', '控えの情報がありません')
  if (backup.verified !== true) throw new Refused('RS_NOT_VERIFIED', '控えが揃っていません')
  if (!into || !path.isAbsolute(into)) throw new Refused('RS_INTO', '戻す先が絶対パスではありません')
  if (!backup.archive || !fs.existsSync(backup.archive)) {
    throw new Refused('RS_ARCHIVE_MISSING', '控えが見つかりません')
  }

  // ① 控えが 取ったときのまま か（★壊れた控えから戻さない）
  const st = fs.statSync(backup.archive)
  if (Number.isInteger(backup.bytes) && st.size !== backup.bytes) {
    throw new Refused('RS_SIZE_MISMATCH', '控えが揃いませんでした')
  }
  if (backup.md5) {
    const now = crypto.createHash('md5').update(fs.readFileSync(backup.archive)).digest('hex')
    if (now !== backup.md5) throw new Refused('RS_MD5_MISMATCH', '控えが書き換わっています')
  }

  // ② 戻す先が空か（★今あるものの上に書かない）
  const realInto = resolveDeep(into)
  if (fs.existsSync(realInto)) {
    const inside = fs.readdirSync(realInto)
    if (inside.length > 0) {
      throw new Refused('RS_NOT_EMPTY', '戻す先が空ではありません')
    }
  }

  // ③ 何が戻るかを先に数える
  //   控えの中身が「戻す先の外」を指す形は、以前は tar 側が止めていた
  //   （Path contains '..'）。だがそれは tar が出したもので、ここでは何も見ていなかった。
  //   環境によって tar が違えば その守りは消えるため、自分で止める形にする。
  //   数えるだけでなく【名前を出して1本ずつ見る】。
  let names
  try {
    names = execFileSync('sh', ['-c',
      `zstd -d -q -c ${shq(backup.archive)} | tar -tf -`
    ], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter(Boolean)
  } catch (e) {
    throw new Refused('RS_UNREADABLE', '控えを確認できませんでした')
  }
  for (const n of names) {
    // 絶対パス（先頭 /）／ 上に登る（..）／ Windows のドライブ指定
    if (n.startsWith('/') || n.split('/').includes('..') || /^[A-Za-z]:/.test(n)) {
      throw new Refused('RS_ESCAPES', '控えの中身が 戻す先の外を指しています')
    }
  }
  const willBe = names.filter(n => !n.endsWith('/')).length
  if (Number.isInteger(backup.files) && willBe !== backup.files) {
    throw new Refused('RS_COUNT_MISMATCH', '控えが揃いませんでした')
  }

  if (dryRun) return { dryRun: true, wouldRestore: willBe, into: realInto, archive: backup.archive }

  // ④ 戻す
  fs.mkdirSync(realInto, { recursive: true })
  try {
    execFileSync('sh', ['-c',
      `zstd -d -q -c ${shq(backup.archive)} | tar -xf - -C ${shq(realInto)}`
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    throw new Refused('RS_EXTRACT_FAILED', `戻せませんでした: ${String(e.stderr ?? (e.code || 'failed')).slice(0, 300)}`)
  }

  // ⑤ 戻ったものを 数え直す（★実物を見る。tar の終了コードだけでは足りない）
  const got = Number(execFileSync('sh', ['-c', `find ${shq(realInto)} -type f | wc -l`], { maxBuffer: 1024 }).toString().trim())
  if (got !== willBe) {
    throw new Refused('RS_VERIFY_FAILED', '戻しきれませんでした')
  }
  return { restored: got, into: realInto, at: new Date().toISOString() }
}

function shq(s) { return `'${s.replace(/'/g, `'\\''`)}'` }
