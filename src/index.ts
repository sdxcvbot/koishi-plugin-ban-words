import { Context, Schema, Logger, Session, h } from 'koishi'
import fs from 'fs'
import path from 'path'

const logger = new Logger('ban-words')

export interface Config {
  dictFile: string
  replyHints: string[]
  whitelistQQ: string[]
  maxLogMatches: number
}

export const name = 'ban-words'

export const Config: Schema<Config> = Schema.object({
  dictFile: Schema.string()
    .default('/koishi/ceshi.txt')
    .description('敏感词词典文件路径。**必须 UTF-8**，每行一个；正则用 `/.../flags`。'),
  replyHints: Schema.array(Schema.string())
    .role('table')
    .description('命中后回复提示，支持占位符：{at} {name} {id} {minutes}')
    .default(['{at} 你的发言包含违禁词，已被撤回。']),
  whitelistQQ: Schema.array(Schema.string())
    .description('白名单 QQ 号（字符串）。在此列表内将跳过敏感词检查。')
    .default([]),
  maxLogMatches: Schema.number()
    .description('日志中最多展示的命中词条数量。')
    .default(50),
})

let plainTerms: string[] = []
let regexTerms: RegExp[] = []
let regexBatches: RegExp[] = []

function escapeRegExp(s: string) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}

function loadDict(dictFile: string) {
  const t0 = Date.now()
  const content = fs.readFileSync(dictFile, 'utf8')
  const lines = content.split(/\r?\n/)

  const _plain: string[] = []
  const _regex: RegExp[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('/') && line.lastIndexOf('/') > 0) {
      const last = line.lastIndexOf('/')
      const body = line.slice(1, last)
      const flags = line.slice(last + 1) || 'i'
      try {
        _regex.push(new RegExp(body, flags))
      } catch (e) {
        logger.warn('invalid regex in dict: %s  -> %s', line, e)
      }
    } else {
      _plain.push(line)
    }
  }

  const batchSize = 400
  const batches: RegExp[] = []
  for (let i = 0; i < _plain.length; i += batchSize) {
    const slice = _plain.slice(i, i + batchSize)
    if (slice.length === 0) continue
    const pattern = slice.map(escapeRegExp).join('|')
    batches.push(new RegExp(`(${pattern})`, 'i'))
  }

  plainTerms = _plain
  regexTerms = _regex
  regexBatches = batches

  logger.info(
    'ban-words dictionary reloaded: %d terms, %d regex batches. (%s) in %dms',
    _plain.length, batches.length, dictFile, Date.now() - t0,
  )
}

function collectMatches(text: string): string[] {
  const matched: string[] = []
  for (const w of plainTerms) {
    if (w && text.includes(w)) matched.push(w)
  }
  for (const r of regexTerms) {
    if (r.test(text)) matched.push(`/${r.source}/${r.flags}`)
  }
  return matched
}

function isHit(text: string): boolean {
  for (const re of regexBatches) if (re.test(text)) return true
  for (const r of regexTerms) if (r.test(text)) return true
  return false
}

function renderReply(tpl: string, session: Session, minutes = 20) {
  const name = session?.username || session?.author?.name || ''
  const id = session?.userId || ''
  // 通用 @ 片段（Koishi 的 segment）：大多数平台可正确渲染；没有 id 时退回纯文本
  const atSeg = id ? String(h.at(id)) : (name ? `@${name}` : '')

  // 用正则全局替换，避免 String.replaceAll 的 ES2021 依赖
  return tpl
    .replace(/\{at\}/g, atSeg)
    .replace(/\{name\}/g, name)
    .replace(/\{id\}/g, id)
    .replace(/\{minutes\}/g, String(minutes))
}

export function apply(ctx: Context, config: Config) {
  if (fs.existsSync(config.dictFile)) {
    loadDict(config.dictFile)
  } else {
    logger.warn('dict file not found: %s', config.dictFile)
  }

  try {
    fs.watchFile(config.dictFile, { interval: 800 }, () => {
      logger.info('ban-words dict file changed, reloading...')
      try {
        loadDict(config.dictFile)
      } catch (e) {
        logger.warn('reload failed: %s', e)
      }
    })
  } catch {}

  ctx.middleware(async (session, next) => {
    const text = (session.elements?.length
      ? session.elements.map(e => (e.type === 'text' ? (e.attrs?.content ?? '') : '')).join('')
      : (session.content || '')
    ).trim()

    if (!text) return next()

    const uid = session.userId || ''
    if (uid && config.whitelistQQ.includes(uid)) {
      logger.debug('whitelist pass: user=%s text=%j', uid, text)
      return next()
    }

    if (!isHit(text)) return next()

    const matched = collectMatches(text)
    const shown = matched.slice(0, Math.max(1, config.maxLogMatches || 50))
    const more = matched.length > shown.length ? ` (+${matched.length - shown.length} more)` : ''
    logger.info('ban-words check: text=%j -> HIT(%d): [%s]%s',
      text, matched.length, shown.join(', '), more)

    if (config.replyHints?.length) {
      try {
        await session.send(renderReply(config.replyHints[0], session, 20))
      } catch (e) {
        logger.warn('send hint failed: %s', e)
      }
    }
    return
  })
}
