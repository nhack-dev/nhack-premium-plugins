/* filters.mjs ── 除外の判定を、設定から受け取る1箇所
 *
 * これまで、どのファイルを触らないかの判定が 12箇所に固定で書かれていた。
 * そのため、語を1つ変えるだけで配り直しと起動し直しが要った。
 *
 * ここに1本化して、設定で上書きできるようにする。
 *   設定が来ていなければ、これまでと同じ既定で動く（何も変わらない）。
 *   設定が来たら、その回から効く（起動し直し不要）。
 *
 * 受け取るのは【語】だけ。正規表現の文字列は受け取らない。
 *   実測: `^(a+)+$` に30文字の入力で12秒固まる。その間タイマーも止まる。
 *   渡せる型で事故の上限が決まる。
 */

const RE_META = /[.*+?^${}()|[\]\\]/g
const esc = (w) => String(w).replace(RE_META, '\\$&')

// 既定（これまで各所に書かれていたものと同じ）
const DEFAULTS = Object.freeze({
  secret_ext: ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.asc', '.gpg', '.ppk'],
  secret_name: ['.env', '.netrc', '.npmrc', '.git-credentials', '.pgpass', '.my.cnf',
    'kubeconfig', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'],
  secret_word: ['secret', 'token', 'credential', 'password', 'passwd', 'apikey',
    'api_key', 'private_key', 'service_account', 'authorization', 'cookie', 'session'],
  secret_dir: ['.ssh', '.aws', '.docker', '.kube', '.gnupg'],
  skip_dirs: ['.git', 'node_modules'],
  // 記録に混ざってはいけない値の【始まり方】。語として持つ（正規表現ではない）
  secret_prefix: ['sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'xoxb-', 'xoxa-',
    'xoxp-', 'xoxo-', 'xoxs-', 'xoxr-', 'eyJ'],
  secret_min_len: 16,
  media_ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
    '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.flac',
    '.zip', '.tar', '.gz', '.7z', '.rar', '.pdf', '.psd', '.ai', '.sketch'],
  secret_text: ['BEGIN RSA PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY',
    'BEGIN PRIVATE KEY', 'BEGIN EC PRIVATE KEY', 'BEGIN PGP PRIVATE KEY',
    'aws_secret_access_key', 'AWS_SECRET_ACCESS_KEY'],
  sendable_ext: ['.md', '.txt', '.json', '.jsonl', '.csv', '.yaml', '.yml',
    '.ts', '.js', '.mjs', '.py', '.sh'],
  max_scan_bytes: 2 * 1024 * 1024,
})

let _f = { ...DEFAULTS }

// 配列で来たら、その中身をそのまま使う（空でも空のまま）。
//   配列でないものだけ既定に戻す。
//   ここで「空は危ないから既定に戻す」という判断を持たない。
//   何を守るか・守らないかは、すべて設定が決める。
// 「意図して空にした」と「書き間違いで空になった」を分ける。
//   実測: [""] / [0] / 201字の語 は、ふるいで全部落ちて空になる。
//   それをそのまま採用すると、書き間違い1回で守りが全部消える。
//   ★空の配列を渡したときだけ、空として受ける（意図した指定）。
//   ★中身があったのに全部落ちたときは、書き間違いとみて既定に戻す。
const words = (v, fb) => {
  if (!Array.isArray(v)) return fb
  if (v.length === 0) return []   // 意図して空にした
  const out = v.filter((w) => typeof w === 'string' && w.length > 0 && w.length <= 200).slice(0, 500)
  return out.length > 0 ? out : fb   // 全部落ちた＝書き間違い
}

/** 設定を取り込む。呼ぶたびに丸ごと入れ替える（前の設定は残さない） */
export function setFilters(policy) {
  const f = policy?.filters
  if (!f || typeof f !== 'object' || Array.isArray(f)) { _f = { ...DEFAULTS }; return _f }
  const n = Number(f.max_scan_bytes)
  _f = {
    secret_ext: words(f.secret_ext, DEFAULTS.secret_ext),
    secret_name: words(f.secret_name, DEFAULTS.secret_name),
    secret_word: words(f.secret_word, DEFAULTS.secret_word),
    secret_dir: words(f.secret_dir, DEFAULTS.secret_dir),
    skip_dirs: words(f.skip_dirs, DEFAULTS.skip_dirs),
    secret_prefix: words(f.secret_prefix, DEFAULTS.secret_prefix),
    media_ext: words(f.media_ext, DEFAULTS.media_ext),
    secret_text: words(f.secret_text, DEFAULTS.secret_text),
    secret_min_len: Number.isFinite(Number(f.secret_min_len)) && Number(f.secret_min_len) >= 1
      ? Math.floor(Number(f.secret_min_len)) : DEFAULTS.secret_min_len,
    sendable_ext: words(f.sendable_ext, DEFAULTS.sendable_ext),
    // 数として書かれていれば、その値を使う（0 も受ける）。
    //   上限だけは相手の環境を潰さないために置く。
    max_scan_bytes: Number.isFinite(n) && n >= 0 && n <= 512 * 1024 * 1024
      ? Math.floor(n) : DEFAULTS.max_scan_bytes,
  }
  return _f
}

export function getFilters() { return _f }

const base = (p) => String(p).split(/[/\\]/).pop() || ''
const lower = (p) => String(p).toLowerCase()

/** 拡張子が鍵のものか */
export function isSecretExt(p) {
  const s = lower(p)
  return _f.secret_ext.some((e) => s.endsWith(lower(e)))
}

/** ファイル名が鍵のものか（.env / .env.local / id_rsa など） */
export function isSecretName(p) {
  const b = lower(base(p))
  return _f.secret_name.some((n) => { const x = lower(n); return b === x || b.startsWith(x + '.') })
}

/** 名前に鍵っぽい語が入っているか（前後が区切りのときだけ） */
export function hasSecretWord(p) {
  const s = lower(p)
  return _f.secret_word.some((w) => {
    const x = esc(lower(w))
    return new RegExp(`(^|[/._\\-])${x}([/._\\-]|$)`).test(s)
  })
}

/** 鍵の置き場の中か（.ssh/ など） */
export function inSecretDir(p) {
  const s = lower(p)
  return _f.secret_dir.some((d) => {
    const x = esc(lower(d))
    return new RegExp(`(^|/)${x}/`).test(s)
  })
}

/** まとめて。どれか1つでも当たれば鍵扱い */
export function isSecretPath(p) {
  return isSecretExt(p) || isSecretName(p) || hasSecretWord(p) || inSecretDir(p)
}

/** 降りていかないフォルダか */
export function isSkipDir(name) {
  const b = lower(base(name))
  return _f.skip_dirs.some((d) => lower(d) === b)
}

/** 送ってよい拡張子か */
export function isSendableExt(p) {
  const s = lower(p)
  return _f.sendable_ext.some((e) => s.endsWith(lower(e)))
}

/** 中身を見に行く上限 */
export function maxScanBytes() { return _f.max_scan_bytes }

/** 記録の項目名が鍵っぽいか（名前の一部に語が入っていれば当てる） */
export function isSecretKeyName(k) {
  const s = lower(k)
  return _f.secret_word.some((w) => s.includes(lower(w)))
}

/** 値そのものが鍵の形か。始まり方と長さで見る（正規表現を受け取らないため） */
export function looksLikeSecretValue(v) {
  if (typeof v !== 'string' || v.length < _f.secret_min_len) return false
  return _f.secret_prefix.some((p) => {
    // すべての出現を見る。1つ目だけ見ていると、
    // わざと前にダミーを置くだけで、後ろの本物が素通りする。
    let i = v.indexOf(p)
    while (i >= 0) {
      const headOk = i === 0 || !/[A-Za-z0-9]/.test(v[i - 1])
      if (headOk && v.length - i >= _f.secret_min_len) return true
      i = v.indexOf(p, i + 1)
    }
    return false
  })
}

/** 画像・動画・書庫など、送らない拡張子か */
export function isMediaExt(p) {
  const s = lower(p)
  return _f.media_ext.some((e) => s.endsWith(lower(e)))
}

/** 中身に鍵そのものが書かれているか（語をそのまま探す） */
export function hasSecretText(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return _f.secret_text.some((w) => text.includes(w))
}
