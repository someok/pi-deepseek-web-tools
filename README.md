# pi-deepseek-web-tools

给 [pi](https://pi.dev) 加两个工具：`ds_search`（DeepSeek 网页搜索）和 `ds_fetch`（DeepSeek 网页抓取），底层走 DeepSeek 官方 [Search / Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search)。

配置齐全时工具自动可用；没配 key 时启动会提示一次，工具对模型不可见。

## 安装

```bash
# 让 pi 从本地目录加载（不写入设置）
pi -e ./

# 或者安装成包，之后每次启动都加载
pi install ./
```

## 配置

两个配置文件结构相同，项目级优先：

| 层级 | 路径 |
| --- | --- |
| 项目级 | `<项目>/.pi/deepseek-web-tools.json` |
| 用户级 | `~/.pi/agent/deepseek-web-tools.json`（`$PI_CODING_AGENT_DIR` 覆盖时按该目录） |
| 环境变量 | `DEEPSEEK_API_KEY` |

项目级配置只在项目已受信任时读取，和 pi 处理 `.pi/` 的规则一致。

完整示例（也见仓库里的 `deepseek-web-tools.example.json`）：

```json
{
  "enabled": true,
  "apiKey": "sk-...",
  "baseUrl": "https://api.deepseek.com",
  "search": {
    "timeoutMs": 30000,
    "count": 10,
    "needContent": false
  },
  "fetch": {
    "timeoutMs": 90000
  }
}
```

合并规则：逐字段取「项目级 → 用户级 → 默认值」；`apiKey` 再回退到 `DEEPSEEK_API_KEY`。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | 有 apiKey 即启用 | `false` 强制关闭，即使环境变量有 key |
| `apiKey` | 无 | 空白字符串视为没写 |
| `baseUrl` | `https://api.deepseek.com` | 尾部斜杠会被去掉 |
| `search.timeoutMs` | `30000` | 1000～300000 |
| `search.count` | 不发送（API 默认 10） | 1～50 |
| `search.needContent` | `false` | 是否在搜索结果里带网页正文 |
| `fetch.timeoutMs` | `90000` | 1000～300000 |

配置写错（坏 JSON、字段类型不对、拼错键名）不会让扩展崩掉：出问题的字段被忽略并记一条告警，启动时和 `/ds-web` 里能看到。改完配置执行 `/reload` 生效。

## 工具

### `ds_search`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `query` | 是 | 1～128 字符，支持 `site:`、`-site:`、`"短语"`、`lang:`、`after:`、`before:` |
| `count` | 否 | 1～50，不传时用 `search.count` |
| `needContent` | 否 | 是否返回正文，默认用 `search.needContent` |

返回带编号的结果列表（标题 / URL / 站点与发布时间 / 摘要）。结果超过 2000 行或 50KB 时会截断，完整 JSON 落到临时文件，路径写在结尾。

### `ds_fetch`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 必须是带 host 的 HTTP/HTTPS 地址，不带用户名密码，长度 ≤8192 |

返回页面标题加 Markdown 正文。正文同样按 2000 行 / 50KB 截断，完整内容落临时文件。

### 界面上的显示

- 工具行默认折叠，只显示结果条数或字符数；展开后显示工具返回的全部文本，不再按行数二次截断。
- `/search`、`/fetch` 的结果同样默认折叠，**展开方式：`Ctrl+O` 或鼠标点击**；抓取结果按 Markdown 渲染（标题、列表、代码块、链接）。
- 唯一的上限是 2000 行 / 50KB（pi 对模型可见内容的约定）：超过时正文末尾会写一行 `[输出已截断：… 完整内容：/tmp/…]`，需要全文时让模型 `read` 那个临时文件。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/search <搜索词>` | 手动跑一次搜索 |
| `/fetch <网址>` | 手动抓一个网页，支持 `/fetch <https://...>` 这种粘贴形式 |
| `/ds-search`、`/ds-fetch` | 上面两个命令的稳定别名（其他扩展占用了 `/search` 时用它们） |
| `/ds-web` | 查看当前生效的配置：启用状态、key 来源（脱敏）、超时、两个配置文件是否读到 |

命令结果写成 custom entry：**只在界面上展示，不进模型上下文**，模型看不到你手动抓的内容。它们会存进当前会话，恢复会话后仍能翻看。

## 错误提示

| 状态码 | 含义 | 提示 |
| --- | --- | --- |
| 400 | 参数不合法 | 检查 query 长度、count 范围、URL 格式 |
| 401 | key 缺失或无效 | 检查配置文件或 `DEEPSEEK_API_KEY` |
| 402 | 余额不足 | 先充值 |
| 403 | Fetch 被安全策略拒绝 | 换站点或跳过 |
| 404 | Search 路径不存在 / Fetch 拿不到正文 | 检查 `baseUrl`；或目标页不可抓 |
| 408 / 504 | 超时 | 稍后重试 |
| 413 | 请求体过大 | URL 过长 |
| 429 | 触发 QPS 限制 | 稍后重试 |
| 5xx | 服务端错误 | 稍后重试 |

超时由 `search.timeoutMs` / `fetch.timeoutMs` 控制，按本地计时中断请求。

## 限额与计费

- Search 与 Fetch 各自限速 5 QPS（账号级），Fetch 另有目标域名级限制。
- 按成功请求计费：每 1000 次 5 元；Search 无结果、Fetch 没拿到正文、请求失败都不计费。
- DeepSeek 说明：第三方工具直接调用 Search / Fetch 会从 2026-11-01 起按次计费。

## 开发

```bash
npm install
npm run check   # tsc --noEmit + vitest
```

- 运行时不依赖任何 npm 包，用 Node 内置 `fetch`。
- 测试全部走注入的 `fetchImpl`，不联网。
- `src/config.ts` 是纯函数，方便单独测配置合并。

## 安全

`apiKey` 只出现在发给 DeepSeek 的请求头里，不会写进工具输出、`details`、`structuredContent` 或日志。`/ds-web` 只显示掩码（如 `sk-****abcd`）。项目级配置含 key 时建议加入 `.gitignore`（本仓库已忽略 `.pi/deepseek-web-tools.json`）。
