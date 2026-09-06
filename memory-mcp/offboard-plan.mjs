/* offboard-plan.mjs ── ★何を 外すかを 決める（★判定だけ・★★外す 命令は 1つも ありません）
 *
 * ★線は【一覧に 在るか】だけです。
 *   → ★こちらが 入れさせた もの … ★★外す
 *   → ★★一覧に 無い もの ……… 🔴 ★外さない（★こちらが 入れて いません）
 *
 * ★★入った 日は 見ません（★指示で 外しました）。
 *   → ★★いまは 見ません。★★★一覧に 在れば 外します。
 *
 * ★★★道連れの 数は 返しますが【止めません】。★見せる ためだけです。
 */

/** ★入れた ものの 一覧。★実際の コマンドから 起こした ものだけ */
export const CATALOG = [
  { key: 'homebrew',      label: 'Homebrew',        via: 'curl' },
  { key: 'claude-code',   label: 'Claude Code',     via: 'curl' },
  { key: 'bun',           label: 'Bun',             via: 'curl' },
  { key: 'node',          label: 'Node',            via: 'brew' },
  { key: 'tmux',          label: 'tmux',            via: 'brew' },
  { key: 'nhack-premium', label: 'プラグイン',        via: 'plugin' },
  { key: 'my-agent',      label: '作業の フォルダ',    via: 'mkdir' },
  { key: 'setup-only',    label: '準備用の フォルダ',   via: 'mkdir' },
  { key: 'dot-claude',    label: '設定の 置き場',      via: 'mkdir' },
]

const KNOWN = new Set(CATALOG.map(c => c.key))

/**
 * @param {object} o
 * @param {{key:string, path?:string, deps?:number}[]} o.found お客様の 機械の 実測
 * @returns {{remove:[], unknown:[], note:string|null}}
 */
export function planOffboard({ found }) {
  const out = { remove: [], unknown: [], note: null }
  if (!Array.isArray(found)) return { ...out, note: '一覧の 形が 違います' }
  for (const f of found) {
    const item = { key: f && f.key, path: f && f.path, deps: (f && f.deps) || 0 }
    if (!item.key || !KNOWN.has(item.key)) { out.unknown.push({ ...item, why: '一覧に ありません' }); continue }
    out.remove.push({ ...item, why: 'こちらが 入れさせました' })
  }
  return out
}

/** ★お客様に お見せする 一覧（★3つ 添える: 何を／いつ／道連れ） */
export function renderPlan(plan) {
  const rows = []
  for (const r of plan.remove)  rows.push({ mark: '外す',   ...r })
  for (const u of plan.unknown) rows.push({ mark: '触らない', ...u })
  return rows
}
