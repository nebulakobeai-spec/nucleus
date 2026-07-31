import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 加载 .env。
 *
 * 不引 dotenv 依赖 —— 需要的只是「读文件、解析 KEY=VALUE、不覆盖已有环境变量」，
 * 三十行的事，不值得为它增加一个供应链入口（这个文件里装的全是密钥）。
 *
 * **已存在的环境变量优先**：容器/CI 注入的值不该被文件里的旧值覆盖，
 * 这也与凭据存储的优先级一致（env > keychain > 文件）。
 */
export interface LoadEnvResult {
  path: string | null
  /** 实际写入的变量名（不含值） */
  loaded: string[]
  /** 因已存在而跳过的变量名 */
  skipped: string[]
}

export function loadEnvFile(path?: string, env: NodeJS.ProcessEnv = process.env): LoadEnvResult {
  const target = resolve(path ?? process.env['NUCLEUS_ENV_FILE'] ?? '.env')

  let raw: string
  try {
    raw = readFileSync(target, 'utf8')
  } catch {
    return { path: null, loaded: [], skipped: [] }
  }

  const loaded: string[] = []
  const skipped: string[] = []

  for (const [key, value] of parseEnv(raw)) {
    if (env[key] !== undefined) {
      skipped.push(key)
      continue
    }
    env[key] = value
    loaded.push(key)
  }

  return { path: target, loaded, skipped }
}

/**
 * 解析 .env 内容。
 *
 * 支持：`KEY=value` · `export KEY=value` · 单双引号 · `#` 注释 ·
 * 双引号内的 `\n` `\t` 转义。不支持变量插值（`${OTHER}`）——
 * 那会引入求值顺序问题，而配置里用不到。
 */
export function parseEnv(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = withoutExport.slice(eq + 1).trim()

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // 单引号内不做转义，与 shell 一致
      value = value.slice(1, -1)
    } else {
      // 未加引号时，行尾注释要剥掉：`KEY=value  # 说明`
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }

    out.push([key, value])
  }

  return out
}
