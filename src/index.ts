import { Context, Schema, Logger, Session, h } from 'koishi'
import fs from 'fs'
import path from 'path'

const logger = new Logger('ban-words')

export const name = 'ban-words'

/** 配置类型（兼容你旧版的字段 + 新增项） */
export interface Config {
  dictPath: string           // 词库路径（相对/绝对）
  useRegex: boolean          // 每行按正则
  ignoreCase: boolean        // 忽略大小写
  recallOnHit: boolean       // 命中后撤回
  blockOnHit: boolean        // 命中后阻断
  replyHints: string[]       // 命中提示
  watch: boolean             // 监听热重载
  batchSize: number          // 纯文本词合并批大小
  onlyGroup: boolean         // 仅群聊生效
  muteOnHit: boolean         // 命中后禁言（OneBot）
  muteSeconds: number        // 禁言秒数（0 不禁言）
  logHits: boolean           // 打印命中日志（基础）

  // 新增
  whitelistQQ: string[]      // 白名单 QQ（字符串）
  logHitDetails: boolean     // 是否打印命中词清单
  maxLogMatches: number      // 清单最大展示条数
}

export const Config: Schema<Config> = Schema.object({
  dictPath: Schema.string()
    .default('ceshi.txt')
    .description('词库 TXT 路径（相对 Koishi 工作目录或绝对路径）。**必须 UTF-8**，每行一个；正则可用 `/.../flags`。'),
  useRegex: Schema.boolean().default(true).description('将每一行视为正则（未写 /.../flags 时用默认 flags）。'),
  ignoreCase: Schema.boolean().default(true).description('忽略大小写匹配。'),
  recallOnHit: Schema.boolean().default(true).description('命中后撤回原消息。'),
  blockOnHit: Schema.boolean().default(true).description('命中后阻断后续中间件。'),
  replyHints: Schema.array(Schema.string())
    .role('table')
    .description('命中后回复，支持占位符：{at} {name} {id} {minutes}。')
    .default(['{at} 你的发言包含违禁词，已撤回并禁言 {minutes} 分钟。']),
  watch: Schema.boolean().default(true).description('监听词库变更并热重载。'),
  batchSize: Schema.number().default(400).min(50).max(2000).step(50).description('纯文本词合并批大小。'),
  onlyGroup: Schema.boolean().default(true).description('仅在群聊生效。'),
  muteOnHit: Schema.boolean().default(true).description('命中后禁言（仅 OneBot/QQ 有效）。'),
  muteSeconds: Schema.number().default(1200).min(0).step(60).description('禁言秒数（0 表示不禁言）。'),
  logHits: Schema.boolean().default(true).description('命中时打印一条基础 info 日志。'),

  whitelistQQ: Schema.array(Schema.string()).default([]).description('白名单 QQ 号（字符串），列表内用户跳过敏感词检查。'),
  logHitDetails: Schema.boolean().default(true).description('命中时在日志输出命中词清单。'),
  maxLogMatches: Schema.number().default(50).min(1).max(500).description('日志中命中词清单最多展示的条数。'),
})

/* ---------------- 内部状态 ---------------- */

let plainTerms: string[] = []   // 纯文本词（已按 ignoreCase 预处理）
let regexTerms: RegExp[] = []   // 正则词
let regexBatches: RegExp[] = [] // 合并大正则，用于快速判断

/* ---------------- 工具函数 ---------------- */

function resolveDictPath(file: string, ctx: Context): string {
  if (!file) return ''
  if (path.isAbsolute(file)) return file
  const cwd = ctx.baseDir || process.cwd()
  return path.join(cwd, file)
}

function escapeRegExp(s: string) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}

/** 读取并编译词库 */
function loadDict(absFile: string, cfg: Config) {
  const t0 = Date.now()
  const content = fs.readFileSync(absFile, 'utf8')
  const lines = content.split(/\r?\n/)

  const _plain: string[] = []
  const _regex: RegExp[] = []

  const defaultFlags = cfg.ignoreCase ? 'i' : ''

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    // 三种进入正则的路径：
    // 1) useRegex=true（整行即正则 body）
    // 2) /.../flags 形式
    // 3) 否则进入纯文本列表
    if (cfg.useRegex && !(line.startsWith('/') && line.lastIndexOf('/') > 0)) {
      try {
        _regex.push(new RegExp(line, defaultFlags))
      } catch (e) {
        logger.warn('invalid regex (useRegex): %s -> %s', line, e)
      }
      continue
    }

    if (line.startsWith('/') && line.lastIndexOf('/') > 0) {
      const last = line.lastIndexOf('/')
      const body = line.slice(1, last)
      const flags = (line.slice(last + 1) || defaultFlags)
      try {
        _regex.push(new RegExp(body, flags))
      } catch (e) {
        logger.warn('invalid regex: %s -> %s', line, e)
      }
    } else {
      _plain.push(cfg.ignoreCase ? line.toLowerCase() : line)
    }
  }

  // 构建快速命中判断的合并正则（纯文本词）
  const batches: RegExp[] = []
  const sz = Math.max(50, Math.min(2000, cfg.batchSize || 400))
  for (let i = 0; i < _plain.length; i += sz) {
    const seg = _plain.slice(i, i + sz)
    if (!seg.length) continue
    const pattern = seg.map(escapeRegExp).join('|')
    const flags = cfg.ignoreCase ? 'i' : ''
    batches.push(new RegExp(`(${pattern})`, flags))
  }

  plainTerms = _plain
  regexTerms = _regex
  regexBatches = batches

  logger.info(
    'ban-words dictionary reloaded: %d plain, %d regex, %d batches. (%s) in %dms',
    _plain.length, _regex.length, batches.length, absFile, Date.now() - t0,
  )
}

/** 收集命中词（用于详细日志） */
function collectMatches(text: string, cfg: Config): string[] {
  const out: string[] = []
  const src = cfg.ignoreCase ? text.toLowerCase() : text

  for (const w of plainTerms) {
    if (w && src.includes(w)) out.push(w)
  }
  for (const r of regexTerms) {
    try {
      if (r.test(text)) out.push(`/${r.source}/${r.flags}`)
    } catch {}
  }
  return out
}

/** 快速命中判断 */
function isHit(text: string): boolean {
  for (const re of regexBatches) if (re.test(text)) return true
  for (const r of regexTerms) if (r.test(text)) return true
  return false
}

/** 渲染占位符 */
function renderReply(tpl: string, session: Session, minutes: number) {
  const name = String(session?.username || (session as any)?.author?.name || '')
  const id = String(session?.userId || '')
  const atSeg = id ? String(h.at(id)) : (name ? `@${name}` : '')
  return tpl
    .replace(/\{at\}/g, atSeg)
    .replace(/\{name\}/g, name)
    .replace(/\{id\}/g, id)
    .replace(/\{minutes\}/g, String(minutes))
}

/** 撤回（尽可能兼容不同适配器） */
async function tryRecall(session: Session) {
  try {
    // 标准 delete（若适配器实现）
    // @ts-ignore
    if (typeof session.delete === 'function') {
      // @ts-ignore
      await session.delete()
      return
    }
  } catch {}

  try {
    if (session?.bot && session?.messageId && session?.channelId) {
      await (session.bot as any).deleteMessage(String(session.channelId), String(session.messageId))
    }
  } catch (e) {
    logger.warn('recall failed: %s', e)
  }
}

/** OneBot 禁言（其余平台自动跳过） */
async function tryMuteOneBot(session: Session, seconds: number) {
  if (seconds <= 0) return
  try {
    if (session.platform !== 'onebot') return
    const bot: any = session.bot as any
    const groupId = Number(session.channelId)
    const userId = Number(session.userId)
    if (!groupId || !userId) return

    if (bot?.internal?.setGroupBan) {
      await bot.internal.setGroupBan(groupId, userId, seconds)
      return
    }
    if (typeof bot.setGroupBan === 'function') {
      await bot.setGroupBan(groupId, userId, seconds)
      return
    }
    if (typeof bot.callApi === 'function') {
      await bot.callApi('set_group_ban', { group_id: groupId, user_id: userId, duration: seconds })
    }
  } catch (e) {
    logger.warn('mute failed: %s', e)
  }
}

function isGroupSession(session: Session): boolean {
  if ((session as any).guildId) return true
  if (session.platform === 'onebot') {
    return !!session.channelId && session.channelId !== session.userId
  }
  // @ts-ignore
  if ((session as any).subtype === 'group') return true
  return false
}

/* ---------------- 主体 ---------------- */

export function apply(ctx: Context, cfg: Config) {
  const absDict = resolveDictPath(cfg.dictPath, ctx)
  if (!absDict || !fs.existsSync(absDict)) {
    logger.warn('dict file not found: %s', absDict || cfg.dictPath)
  } else {
    try {
      loadDict(absDict, cfg)
    } catch (e) {
      logger.warn('load dict failed: %s', e)
    }
  }

  if (cfg.watch && absDict && fs.existsSync(absDict)) {
    try {
      fs.watchFile(absDict, { interval: 800 }, () => {
        logger.info('ban-words dict file changed, reloading...')
        try {
          loadDict(absDict, cfg)
        } catch (e) {
          logger.warn('reload failed: %s', e)
        }
      })
    } catch {}
  }

  ctx.middleware(async (session, next) => {
    // 仅群聊
    if (cfg.onlyGroup && !isGroupSession(session)) return next()

    // 提取文本
    const text = (session.elements?.length
      ? session.elements.map(e => (e.type === 'text' ? String(e.attrs?.content ?? '') : '')).join('')
      : String(session.content || '')
    ).trim()
    if (!text) return next()

    // 白名单（OneBot/QQ 的 userId 即 QQ 号）
    const uid = String(session.userId || '')
    if (uid && cfg.whitelistQQ.includes(uid)) {
      if (cfg.logHits) logger.debug('whitelist pass: user=%s text=%j', uid, text)
      return next()
    }

    // 命中判断
    if (!isHit(text)) return next()

    // 日志
    if (cfg.logHits) {
      if (cfg.logHitDetails) {
        const matched = collectMatches(text, cfg)
        const shown = matched.slice(0, Math.max(1, cfg.maxLogMatches || 50))
        const more = matched.length > shown.length ? ` (+${matched.length - shown.length} more)` : ''
        logger.info('ban-words check: text=%j -> HIT(%d): [%s]%s',
          text, matched.length, shown.join(', '), more)
      } else {
        logger.info('ban-words check: text=%j -> HIT', text)
      }
    }

    // 动作：撤回、禁言、提示
    if (cfg.recallOnHit) await tryRecall(session)
    if (cfg.muteOnHit && cfg.muteSeconds > 0) await tryMuteOneBot(session, cfg.muteSeconds)

    if (cfg.replyHints?.length) {
      const minutes = Math.floor((cfg.muteSeconds || 0) / 60)
      try {
        await session.send(renderReply(cfg.replyHints[0], session, minutes))
      } catch (e) {
        logger.warn('send hint failed: %s', e)
      }
    }

    if (cfg.blockOnHit) return
    return next()
  })
}
