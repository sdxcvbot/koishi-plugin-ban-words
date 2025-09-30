# koishi-plugin-ban-words

基于 **TXT 字典** 的 Koishi 违规关键词过滤插件。  
支持 **撤回、禁言（OneBot/QQ）**、自定义提示语模板（带占位符）、热重载、大词库批量正则等。

> ⚠️ **注意：词库 TXT 必须用 UTF-8（无 BOM）编码！**  
> 如果是 GBK/ANSI，中文会解析失败，导致“看似正常但始终匹配不到”。

---

## 安装

Koishi 控制台 → 插件市场搜索 `ban-words` 安装；或手动：

```bash
npm i koishi-plugin-ban-words

---
插件配置示例：
dictPath: ceshi.txt
recallOnHit: true
muteOnHit: true
muteSeconds: 1200（禁言 20 分钟，仅 OneBot/QQ 有效）
replyHints 示例：

{at} 你的发言包含词，已撤回并禁言 {minutes} 分钟。（ID: {id}，昵称：{name}）
占位符说明
在 replyHints 中可以使用以下占位符：
{at} → 真正的 @ 提及（OneBot/QQ 有效，别的平台为 @昵称 文本）
{name} → 用户昵称（优先取群昵称/平台昵称，兜底为 userId）
{id} → 用户 ID（QQ 号）
{minutes} → 根据 muteSeconds 自动换算出的分钟数

效果
@张三 你的发言包含词，已撤回并禁言 20 分钟。（ID: 123456789, 昵称: 张三）
---
新增白名单功能
新增日志打印出匹配到的关键词前50个

