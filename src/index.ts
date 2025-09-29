import { Context, Schema, Session, Random } from 'koishi'
import fs from 'fs'
import path from 'path'

export const name = 'ban-words'

export interface Config {
  dictPath: string
  useRegex?: boolean
  ignoreCase?: boolean
  recallOnHit?: boolean
  blockOnHit?: boolean
  replyHints?: string[]
  watch?: boolean
}

export const Config: Schema<Config> = Schema.object({
  dictPath: Schema.string().description('词库 TXT 路径（可相对 Koishi 工作目录）。').required(),
  useRegex: Schema.boolean().default(false).description('将每一行视为正则表达式。'),
  ignoreCase: Schema.boolean().default(true).description('忽略大小写匹配。'),
  recallOnHit: Schema.boolean().default(false).description('命中后尝试撤回该消息。'),
  blockOnHit: Schema.boolean().default(true).description('命中后阻断后续中间件。'),
  replyHints: Schema.array(String).role('table').description('命中后随机回复的提示语。').default([]),
  watch: Schema.boolean().default(true).description('监听词库文件变更并热重载。'),
})

type Matcher = {
  regex?: RegExp
  literal?: string
}

function stripInlineComment(line: string, useRegex: boolean): string {
  // 移除 # 及其右侧（但在 useRegex 时，允许转义 \#
  let result = line
  if (useRegex) {
    // 将未转义的 # 作为注释起点
    let escaped = false
    let out = ''
    for (let i = 0; i < result.length; i++) {
      const ch = result[i]
      if (ch === '\\') { escaped = !escaped; out += ch; continue }
      if (ch === '#' && !escaped) break
      escaped = false
      out += ch
    }
    result = out
  } else {
    const idx = result.indexOf('#')
    if (idx >= 0) result = result.slice(0, idx)
  }
  return result.trim()
}

function compileMatchers(lines: string[], cfg: Config): { matchers: Matcher[], union: RegExp[] } {
  const flags = cfg.ignoreCase ? 'i' : ''
  const literals: string[] = []
  const regexes: RegExp[] = []
  const matchers: Matcher[] = []

  for (let raw of lines) {
    let line = stripInlineComment(raw, !!cfg.useRegex)
    if (!line) continue
    if (cfg.useRegex) {
      try {
        regexes.push(new RegExp(line, flags))
      } catch (e) {
        // 忽略非法正则
      }
    } else {
      literals.push(line)
    }
  }

  // 将 literals 批量拼成多个正则，避免过长
  const batchSize = 400
  for (let i = 0; i < literals.length; i += batchSize) {
    const batch = literals.slice(i, i + batchSize).map(s => escapeRegExp(s))
    // 直接子串匹配，不加 \b
    const source = batch.join('|')
    if (source) {
      regexes.push(new RegExp(source, flags))
    }
  }

  return { matchers, union: regexes }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function tryRecall(session: Session) {
  try {
    if (session.bot && session.channelId && session.messageId) {
      // @ts-ignore - not all adapters have the same method signature
      await session.bot.deleteMessage(session.channelId, session.messageId)
    }
  } catch {}
}

function readLines(file: string): string[] {
  try {
    const text = fs.readFileSync(file, 'utf8')
    // 兼容 Windows 换行
    return text.split(/\r?\n/)
  } catch {
    return []
  }
}

export function apply(ctx: Context, config: Config) {
  const dictAbs = path.isAbsolute(config.dictPath) ? config.dictPath : path.join(ctx.baseDir, config.dictPath)

  let compiled = compileMatchers(readLines(dictAbs), config)

  const reload = () => {
    compiled = compileMatchers(readLines(dictAbs), config)
    ctx.logger(name).info(`ban-words: dictionary reloaded (${compiled.union.length} regex batches).`)
  }

  if (config.watch) {
    try {
      fs.watch(dictAbs, { persistent: false }, () => reload())
    } catch {}
  }

  ctx.command('banwords.reload', '重载屏蔽词词库').action(async ({ session }) => {
    reload()
    return '已重载屏蔽词词库。'
  })

  ctx.middleware(async (session, next) => {
    const text = session.elements?.join('') || session.content || ''
    if (!text) return next()

    // 匹配
    let hit = false
    for (const re of compiled.union) {
      if (re.test(text)) { hit = true; break }
    }
    if (!hit) return next()

    if (config.recallOnHit) await tryRecall(session)

    // 回复提示
    if (config.replyHints && config.replyHints.length) {
      const msg = Random.pick(config.replyHints)
      if (msg) await session.send(msg)
    }

    if (config.blockOnHit) return // 阻断
    return next()
  })
}