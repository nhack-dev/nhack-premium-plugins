// 控えを取る。取れたことを確かめてから、その事実を返す。
//
// ここが返す backup オブジェクトは safeguard.assertAllowed が受け取る。
// 「取った」ではなく「取れたことを確かめた」だけを verified:true にする。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { collectFiles, assertCollectSafe, Refused, resolveDeep } from './archive-safeguard.mjs'

/**
 * @param {object} a
 * @param {string} a.root      控えを取る大元（絶対パス）
 * @param {string} a.destDir   控えの置き場（★大元の外・絶対パス）
 * @param {string} a.clientId  利用者の識別子
 * @param {number=} a.maxFileBytes
 */
export function makeBackup(a) {
  const { root, destDir, clientId, maxFileBytes } = a ?? {}
  if (!root || !path.isAbsolute(root)) throw new Refused('BK_ROOT', '大元が絶対パスではありません')
  if (!destDir || !path.isAbsolute(destDir)) throw new Refused('BK_DEST', '控えの置き場が絶対パスではありません')
  if (!clientId) throw new Refused('BK_CLIENT', '識別子がありません')

  const realRoot = fs.realpathSync(root)
  // 控えを対象の中に置くと、消すときに一緒に消える
  const realDest = resolveDeep(destDir)   // ★存在しない場所も正しく解く
  if (realDest === realRoot || realDest.startsWith(realRoot + path.sep)) {
    throw new Refused('BK_DEST_INSIDE', '控えの置き場が大元の中にあります')
  }
  fs.mkdirSync(destDir, { recursive: true })

  // ① 集める（リンクを辿らない・外の実体を入れない）
  const found = collectFiles(realRoot, { maxFileBytes })
  assertCollectSafe(found)

  // ② 何を控えるかの一覧を先に固定する（★送りながら数えない）
  const listPath = path.join(destDir, `${clientId}-${stamp()}.list`)
  fs.writeFileSync(listPath, found.files.map(f => path.relative(realRoot, f)).join('\n') + '\n')
  const expected = { files: found.files.length, bytes: found.bytes }

  // ③ 固める
  // 中身をメモリに載せる形にしない。
  //   1ファイルが数GBになることがあり、バッファの上限を超えて落ちる。
  //   tar と zstd を直接つないで、メモリに載せない形にした。
  //   一覧はファイルに書いてから -T で渡す（標準入力を使うと パイプが2本になる）。
  const archive = path.join(destDir, `${clientId}-${stamp()}.tar.zst`)
  try {
    execFileSync('sh', ['-c',
      `tar -C ${shq(realRoot)} --no-recursion -T ${shq(listPath)} -cf - | zstd -3 -q -T0 -o ${shq(archive)} -f`
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    throw new Refused('BK_ARCHIVE_FAILED', '控えを作れませんでした')
  }

  // ④ 検算 … 記録ではなく、できあがった実物を開いて数える
  const st = fs.statSync(archive)
  if (st.size < 1) throw new Refused('BK_EMPTY_ARCHIVE', '控えが空です')

  let inArchive
  try {
    // 件数だけ数える。中身はメモリに載せない（wc に流す）
    const n = execFileSync('sh', ['-c',
      `zstd -d -q -c ${shq(archive)} | tar -tf - | grep -v '/$' | wc -l`
    ], { maxBuffer: 1024 }).toString().trim()
    inArchive = Number(n)
  } catch (e) {
    throw new Refused('BK_UNREADABLE', '控えを確認できませんでした')
  }
  if (inArchive !== expected.files) {
    throw new Refused('BK_COUNT_MISMATCH', '控えが揃いませんでした')
  }

  return {
    verified: true,                       // ★ここまで通って初めて true
    clientId,
    archive,
    list: listPath,
    files: expected.files,
    bytes: st.size,                       // ★控えの実物の大きさ（元の合計ではない）
    sourceBytes: expected.bytes,
    md5: crypto.createHash('md5').update(fs.readFileSync(archive)).digest('hex'),
    skippedLinks: found.links.length,
    skippedOversize: found.oversize.length,
    at: new Date().toISOString(),
  }
}

function stamp() {
  // YYYYMMDDHHMMSS ちょうど 14文字。15 にすると末尾にドットが残る。
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}
function shq(s) { return `'${s.replace(/'/g, `'\\''`)}'` }
