import { Context, Schema, Logger, Session, Element } from 'koishi'
import fs from 'fs'
import path from 'path'

const logger = new Logger('ban-words')

export interface Config {
  dictPath: string
  useRegex?: boolean
  ignoreCase?: boolean
  recallOnHit?: boolean
  blockOnHit?: boolean
  replyHints?: string[]
  watch?: boolean
  batchSize?: number
  // 新增
  onlyGroup?: boolean
  muteOnHit?: boolean
  muteSeconds?: number
  logHits?: boolean
}

export const name = 'ban-words'

export const Config: Schema<Config> = Schema.object({
  dictPath: Schema.string().required().description('词库 TXT 路径（可相对 Koishi 工作目录）。'),
  useRegex: Schema.boolean().default(false).description('将每一行视为正则式。'),
  ignoreCase: Schema.boolean().default(true).description('忽略大小写匹配。'),
  recallOnHit: Schema.boolean().default(false).description('命中后尝试撤回原消息。'),
  blockOnHit: Schema.boolean().default(false).description('命中后阻断后续中间件。'),
  replyHints: Schema.array(Schema.string()).default(['⚠️ 该消息包含违规内容，请注意用语。']).description('命中后回复提示。'),
  watch: Schema.boolean().default(true).description('监听词库文件变更并热重载。'),
  batchSize: Schema.number().default(400).description('合并正则的批大小。'),
  // 新增
  onlyGroup: Schema.boolean().default(true).description('仅在群聊生效。'),
  muteOnHit: Schema.boolean().default(false).description('命中后禁言（仅 OneBot/QQ 有效）。'),
  muteSeconds: Schema.number().default(0).description('禁言秒数（0 表示不禁言）。'),
  logHits: Schema.boolean().default(true).description('命中时打印一条 info 日志。'),
})

function normalizeLine(line: string) {
  line = line.replace(/^\uFEFF/, '').trim()
  if (!line) return ''
  // 去掉未转义的行尾 # 注释
  let out = ''
  let escaped = false
  for (const ch of line) {
    if (escaped) { out += ch; escaped = false; continue }
    if (ch === '\\') { escaped = true; out += ch; continue }
    if (ch === '#') break
    out += ch
  }
  return out.trim()
}

function escapeReg(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildMatchers(lines: string[], asRegex: boolean, ignoreCase: boolean, batchSize: number): RegExp[] {
  const flags = ignoreCase ? 'i' : ''
  const regs: RegExp[] = []
  for (let i = 0; i < lines.length; i += batchSize) {
    const chunk = lines.slice(i, i + batchSize)
    const parts = chunk
      .filter(Boolean)
      .map(s => asRegex ? `(${s})` : `(${escapeReg(s)})`)
    if (!parts.length) continue
    regs.push(new RegExp(parts.join('|'), flags))
  }
  return regs
}

function textFromElements(session: Session): string {
  // 可靠抽取：只拼接纯文本节点，忽略 at / emoji / image 等
  const els = session.elements as Element[] || []
  const texts: string[] = []
  for (const el of els) {
    if (typeof el === 'string') { texts.push(el); continue }
    if (el.type === 'text') texts.push(el.attrs?.content || el.children?.join('') || '')
  }
  // 兜底：没有 elements 时，回退 content
  const t = texts.join('').trim()
  return t || (session.content || '').trim()
}

function testHit(text: string, regs: RegExp[]): boolean {
  if (!text) return false
  for (const r of regs) if (r.test(text)) return true
  return false
}

async function safeRecall(session: Session) {
  try {
    if (session.bot?.deleteMessage && session.channelId && session.messageId) {
      await session.bot.deleteMessage(session.channelId, session.messageId)
    }
  } catch (e) {
    logger.debug('recall failed: %o', e)
  }
}

async function safeMuteIfOneBot(session: Session, seconds: number) {
  if (!seconds || seconds <= 0) return
  try {
    // 仅 OneBot/QQ 有禁言 API
    if (session.platform?.startsWith('onebot')) {
      const bot: any = session.bot
      const groupId = Number(session.guildId || session.channelId)
      const userId = Number(session.userId)
      // v11 适配：internal.setGroupBan
      if (bot?.internal?.setGroupBan && groupId && userId) {
        await bot.internal.setGroupBan(groupId, userId, seconds)
      }
    }
  } catch (e) {
    logger.debug('mute failed: %o', e)
  }
}

export function apply(ctx: Context, config: Config) {
  let regs: RegExp[] = []
  let loadedCount = 0
  let dictAbs = ''

  async function loadDict() {
    try {
      dictAbs = path.isAbsolute(config.dictPath) ? config.dictPath : path.resolve(process.cwd(), config.dictPath)
      if (!fs.existsSync(dictAbs)) {
        logger.warn('dict file not found: %s', dictAbs)
        regs = []
        loadedCount = 0
        return
      }
      const raw = fs.readFileSync(dictAbs, 'utf8')
      const lines = raw.split(/\r?\n/).map(normalizeLine).filter(Boolean)
      loadedCount = lines.length
      regs = buildMatchers(lines, !!config.useRegex, !!config.ignoreCase, config.batchSize!)
      logger.info('dictionary reloaded: %d terms, %d regex batches. (%s)', loadedCount, regs.length, dictAbs)
    } catch (e) {
      logger.error('load dict failed: %o', e)
      regs = []
      loadedCount = 0
    }
  }

  // 初始化加载
  loadDict()

  // 重载命令
  ctx.command('banwords.reload', '重载敏感词字典').action(async () => {
    await loadDict()
    return `已重载。当前 ${loadedCount} 条，来源：${dictAbs}`
  })

  // 自测命令
  ctx.command('banwords.test <text:text>', '测试文本是否命中敏感词').action(async ({}, text) => {
    if (!text) return '用法：banwords.test 需要测试的文本'
    return testHit(text, regs) ? '✅ 命中' : '❌ 未命中'
  })

  // 监听文件变化（失败则轮询）
  if (config.watch) {
    try {
      const watcher = fs.watch(dictAbs, { persistent: false }, async (ev) => {
        if (ev === 'change' || ev === 'rename') {
          logger.info('dict file changed, reloading...')
          await loadDict()
        }
      })
      ctx.on('dispose', () => watcher.close())
    } catch {
      let last = 0
      const timer = setInterval(() => {
        try {
          const mt = fs.statSync(dictAbs).mtimeMs
          if (mt !== last) { last = mt; logger.info('dict file changed (polling), reloading...'); loadDict() }
        } catch {}
      }, 5000)
      ctx.on('dispose', () => clearInterval(timer))
    }
  }

  // 高优先级中间件（prepend=true）
  ctx.middleware(async (session, next) => {
    if (config.onlyGroup && !session.guildId) return next()

    const text = textFromElements(session)
    if (!text || regs.length === 0) return next()

    const hit = testHit(text, regs)

    // 命中/未命中都打 info（若你嫌多，可把这里改成 debug）
    if (config.logHits) logger.info('check: text="%s" -> %s', text, hit ? 'HIT' : 'PASS')

    if (!hit) return next()

    if (config.recallOnHit) await safeRecall(session)

    if (config.muteOnHit && (config.muteSeconds || 0) > 0) {
      await safeMuteIfOneBot(session, Math.max(0, config.muteSeconds! | 0))
    }

    if (config.replyHints?.length) {
      const hint = config.replyHints[Math.floor(Math.random() * config.replyHints.length)]
      await session.send(hint)
    }

    if (config.blockOnHit) return
    return next()
  }, true)
}
