# koishi-plugin-ban-words

基于 **TXT 字典** 的 Koishi 违规关键词过滤插件。支持 **撤回、禁言（OneBot/QQ）**、提示语模板、热重载、大词库批量正则等。

> ✅ **重点：词库 TXT 必须用 UTF-8（无 BOM）编码！**  
> 使用 GBK/ANSI 会导致中文解析失败，从而“看起来插件正常、但永远匹配不到”。

## 安装

Koishi 控制台 → 插件市场搜索 `ban-words` 安装；或手动：

```bash
npm i koishi-plugin-ban-words
