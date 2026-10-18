# pi-deepseek-web-tools 实现计划

日期：2026-10-18
状态：已实现并验证

## 1. 目标

给 pi 加两个模型可调用的工具，走 DeepSeek 官方 Search / Fetch 接口：

- `ds_search`：网页搜索，返回结构化结果列表。
- `ds_fetch`：抓取单个网页，返回 Markdown 正文。

外加：配置文件按「项目级 > 用户级 > 环境变量」判定是否启用；没配好时启动弹一次说明文字。

不在范围内：自动重试、结果缓存、MCP 封装、多页递归爬取、PDF/图片解析、搜索语法助手、内嵌到其他扩展。

## 2. DeepSeek 接口事实（已核对官方文档）

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.deepseek.com` |
| 搜索 | `POST /v1/tools/search` |
| 抓取 | `POST /v1/tools/fetch` |
| 鉴权 | `Authorization: Bearer <key>` + `Content-Type: application/json` |
| 限速 | Search 5 QPS、Fetch 5 QPS（账号级，Fetch 另有域名级限制） |
| 计费 | 每 1000 次成功请求 5 元；仅 HTTP 200 且有结果才计费；2026-11-01 起对第三方工具调用计费 |

### 2.1 搜索请求

```json
{ "query": "DeepSeek 模型 发布", "count": 5, "need_content": false }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 1～128 字符，不能全空白；支持 `site:` `-site:` `-` `-"..."` `"..."` `lang:` `after:` `before:` |
| `count` | integer | 否 | 1～50，默认 10 |
| `ori_question` | string\|null | 否 | 原始问题，1～128 字符，帮助理解意图 |
| `localization` | string | 否 | 本地化优先的 IP，默认空 |
| `need_content` | boolean | 否 | 是否在 `content` 返回正文，默认 false |

未知字段被忽略。响应 `{ "results": [...] }`，无结果时为 `[]`。每项字段：`rerank_score`（0～3，≥1.5 优质）、`title`、`url`、`snippet`（100～200 字符）、`summary`（600～800 字符，给模型读）、`content`（正文，`need_content=false` 时为空串）、`site_name`（可 null）、`site_icon`（可 null）、`date`（RFC 3339 UTC 可 null）、`authority`（0～4，-1 未知，≥3 极权威）。

### 2.2 抓取请求

```json
{ "url": "https://example.com/article" }
```

`url` 必填，≤8192 字符，必须是带 host 的 HTTP/HTTPS URL，不能带用户名或密码。响应 `{ "title": string, "content": string }`，`content` 为 Markdown 正文，`title` 缺失时为空串。

注意：Fetch 返回的 `content` 会把正文里的 ASCII 标点全部转义（`\#`、`\-`、`\,`、`\/`、`\(`），展示前用 `unescapeMarkdown()` 还原；Search 结果的 `content` 不转义。

### 2.3 错误格式

```json
{ "error": { "message": "'count' must be between 1 and 50", "type": "invalid_request_error", "param": null, "code": "invalid_request_error" } }
```

| 状态码 | 含义 |
| --- | --- |
| 400 | 请求头/体不合法（JSON 格式、字段值） |
| 401 | API Key 缺失或无效 |
| 402 | 余额不足 |
| 403 | Fetch 被安全策略拒绝 |
| 404 | Fetch 拿不到可用正文（URL 不可用、被站点拦截、内容类型不支持、无可提取正文） |
| 408 | 读取请求体超时 |
| 413 | 请求体过大 |
| 429 | QPS 超限 |
| 500 / 504 | 服务端错误 / 下游超时 |

## 3. 配置解析

### 3.1 文件位置

| 级别 | 路径 | 生效条件 |
| --- | --- | --- |
| 项目级 | `<cwd>/.pi/deepseek-web-tools.json` | 仅当 `ctx.isProjectTrusted()` 为 true；否则标为 `untrusted` 并跳过 |
| 用户级 | `<agentDir>/deepseek-web-tools.json` | 一直读取；`agentDir = $PI_CODING_AGENT_DIR` 或 `~/.pi/agent` |
| 环境变量 | `DEEPSEEK_API_KEY` | 前两级都没给出 apiKey 时使用 |

### 3.2 结构：全局字段 + `search` / `fetch` 分组

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

全局字段（决定是否启用、调哪个地址）：

| 字段 | 优先顺序 | 默认 | 校验 |
| --- | --- | --- | --- |
| `enabled` | 项目 → 用户 | 有 apiKey 即启用，没有就不启用 | boolean |
| `apiKey` | 项目 → 用户 → `DEEPSEEK_API_KEY` | 无 | trim 后非空才算有值 |
| `baseUrl` | 项目 → 用户 | `https://api.deepseek.com` | 去掉尾部 `/` |

`search` 分组：

| 字段 | 优先顺序 | 默认 | 校验 |
| --- | --- | --- | --- |
| `search.timeoutMs` | 项目 → 用户 | `30000` | 整数 1000～300000 |
| `search.count` | 项目 → 用户 | 不发送（API 默认 10） | 整数 1～50 |
| `search.needContent` | 项目 → 用户 | `false` | boolean |

`fetch` 分组：

| 字段 | 优先顺序 | 默认 | 校验 |
| --- | --- | --- | --- |
| `fetch.timeoutMs` | 项目 → 用户 | `90000` | 整数 1000～300000 |

规则细节：

1. 「有值」= 不是 `undefined`/`null`；字符串再要求 trim 后非空。空串等同于没写。
2. 项目文件 JSON 解析失败或顶层不是对象 → 该文件整体忽略，记一条 warning，继续用用户级。
3. 项目文件在未信任项目里 **完全不读**，避免陌生仓库塞 key 或改 baseUrl。
4. `enabled` 显式为 `false` → 一定不启用，即使有 key。显式为 `true` 但最终没有 apiKey → 不启用，原因 `missing-key`。
5. `enabled` 未写时：有 apiKey 就启用，没有就不启用（等价于用户给的两条规则）。
6. 非法字段值（如 `search.timeoutMs: "abc"`）→ 用默认值并记 warning，不整体失败。
7. `search` 与 `fetch` 分组各自独立逐字段合并，互不影响：项目只写 `search.count`、用户只写 `search.needContent`，两个字段都生效；`fetch` 未配置就全用默认值。
8. 分组值不是对象（如 `"search": 5`）→ 整个分组按空处理并记 warning。
9. 未知键（顶层或分组内，如 `serach`、`search.cout`）→ 忽略并记 warning，帮用户发现拼写错误。
10. `enabled` / `apiKey` / `baseUrl` 只认顶层，出现在 `search` / `fetch` 里按未知键处理。

### 3.3 解析结果类型

```ts
type FileStatus = "missing" | "ok" | "invalid" | "untrusted";

interface SearchConfig {
  timeoutMs: number;      // 默认 30000
  count?: number;         // 未配置则不发 count
  needContent: boolean;   // 默认 false
}

interface FetchConfig {
  timeoutMs: number;      // 默认 90000
}

interface ResolvedConfig {
  enabled: boolean;
  reason: "ok" | "missing-key" | "explicitly-disabled";
  apiKey?: string;
  apiKeySource?: "project" | "user" | "env";
  baseUrl: string;
  search: SearchConfig;
  fetch: FetchConfig;
  projectFile: { path: string; status: FileStatus };
  userFile: { path: string; status: FileStatus };
  warnings: string[];
}

function resolveConfig(input: {
  cwd: string;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  projectTrusted: boolean;
}): ResolvedConfig;
```

`resolveConfig` 是纯函数（自己读文件，不依赖全局状态），方便测试。

## 4. 工具契约

两个工具都用 `defineTool` 注册，`exposure: "direct"`，`annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }`。

### 4.1 `ds_search`

参数（TypeBox）：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 搜索词，1～128 字符 |
| `count` | integer | 否 | 1～50；不传时用 `search.count`，仍未设置就不发给 API |
| `needContent` | boolean | 否 | 是否返回网页正文，默认取 `search.needContent`（默认 false） |

请求体映射：`query` → `query`，`count` → `count`，`needContent` → `need_content`。`ori_question`、`localization` 不暴露。

模型可见文本（`content`）：

```
找到 3 条结果：query="DeepSeek 模型 发布"

1. DeepSeek V4 模型发布
   https://example.com/deepseek-v4
   站点：Example News ｜ 发布：2026-06-01
   <summary>

2. ...
```

- `site_name` 为空时用 URL 的 host；`date` 为空则不显示「发布」段，`summary` 为空回退 `snippet`。
- `needContent: true` 且该项有 `content` 时，在 summary 后加一段 `   正文：<content>`，再统一截断。
- 无结果：`没有搜索到结果。可以换关键词，或去掉 site: / after: 之类的限定语法。`
- 截断：`truncateHead` 到 `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`；被截断时把完整 JSON 写入临时文件，文本末尾追加截断说明和文件路径。

`details` / `structuredContent`：

```ts
{
  query: string;
  count: number;              // 实际发给 API 的条数，未设置时为 0 表示用 API 默认
  resultCount: number;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    summary: string;
    siteName: string | null;
    date: string | null;
    authority: number | null;
    rerankScore: number | null;
    content?: string;         // 仅 needContent 且非空
  }>;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}
```

声明 `outputSchema` 与之匹配，codemode 脚本拿 `structuredContent`。

渲染：`renderCall` 显示 `🔍 "<query>"`；`renderResult` 默认显示 `N 条结果`，展开显示前 5 条标题 + URL。

### 4.2 `ds_fetch`

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 要抓取的网页地址 |

本地校验（不发请求）：必须是 http/https、有 host、不带用户名密码、长度 ≤8192。不满足直接抛错，错误信息说明原因。

模型可见文本：

```
# <title>

<url>

<content>
```

- `title` 为空时省掉标题行。
- `content` 为空串 → 抛错：`抓取成功但没有正文（可能页面无可提取内容或内容类型不支持）`。
- 截断同 `ds_search`，完整正文写临时文件。

`details` / `structuredContent`：`{ url, title, contentLength, truncation?, fullOutputPath?, content }`。`content` 放 `structuredContent` 里供脚本使用，模型文本按截断规则给。

渲染：`renderCall` 显示 `🌐 <url>`；`renderResult` 显示 `N 字符`（截断时加 `(已截断)`），展开显示正文前 20 行。

## 5. 扩展生命周期

`src/index.ts` 默认导出工厂函数：

1. 工厂内创建共享状态 `{ config?: ResolvedConfig; client?: DeepSeekWebClient }`。
2. 注册 `ds_search`、`ds_fetch`（`direct` 注册即激活）。
3. 注册 `/search`、`/fetch`、`/ds-tool-config` 等命令，以及 entry 渲染器。
4. 在 `session_start` 里：
   - `resolveConfig({ cwd: ctx.cwd, agentDir, env: process.env, projectTrusted: ctx.isProjectTrusted() })`；
   - 启用就把两个工具名并入 `pi.getActiveTools()`，禁用就把它们从活跃集合里删掉，再 `pi.setActiveTools(...)`（只动自己这两个名字，不碰别的扩展）。
   - 禁用原因 `missing-key` 时弹一次通知（每次 session_start 一次，含 reload）：

     ```
     DeepSeek 网络工具未启用：没有找到 API Key。
     • 写进 <cwd>/.pi/deepseek-web-tools.json 或 <agentDir>/deepseek-web-tools.json：{"apiKey": "sk-..."}
     • 或设置环境变量 DEEPSEEK_API_KEY
     配置后执行 /reload 生效。
     ```

   - `explicitly-disabled`（`enabled: false`）不弹通知，尊重用户意图。
   - `warnings` 非空时并进同一条通知（或单独一条 warning），例如配置文件解析失败。
   - `ctx.hasUI` 为 false 时用 `console.warn` 代替 `notify`。
5. 不注册 footer 状态、不启定时器、不开长连接，`session_shutdown` 无需清理。

`/reload` 会重跑工厂和 `session_start`，配置自动重新解析。

## 6. 命令

命令都注册在工厂里，共用同一份 `client` 和 `config`；未启用时一律先用 `ctx.ui.notify` 提示如何配置，不发请求。

结果用 `pi.appendEntry` 写成 custom entry，**不进模型上下文**（`sessionEntryToContextMessages` 对 custom 返回空），只渲染在界面上，并随会话持久化。

### 6.1 `/search <query>`（别名 `/ds-search`）

- 无参数（或空白）→ `用法：/search <搜索词>`，warning。
- 参数为整行剩余内容（trim），不拆词，支持 `site:` 等搜索语法。
- `count` 用 `config.search.count`（未配置则不传，API 默认 10），`need_content` 用 `config.search.needContent`。
- 结果用 `pi.appendEntry("ds-search", { query, resultCount, text, truncated, fullOutputPath? })` 写入会话。
- 发送前用 `truncateHead` 截断，完整 JSON 落临时文件，文本末尾追加文件路径。
- 空结果也写 entry，正文为「没有搜索到结果」。
- 出错时 `ctx.ui.notify(err.message, "error")`，不让异常冒到 runtime。

`ds-search` 渲染：折叠时 `🔍 <query> · N 条结果` + 前 14 行，末尾提示「Ctrl+O 或点击展开」；展开时显示全部。

### 6.2 `/fetch <url>`（别名 `/ds-fetch`）

- 无参数 → `用法：/fetch <网址>`，warning。
- 参数去掉尖括号和空白（`/fetch <https://x>` 也能用），再做与 `ds_fetch` 相同的本地 URL 校验。
- 正文同样截断 + 完整内容落临时文件，用 `pi.appendEntry("ds-fetch", { url, title, contentLength, text, truncated, fullOutputPath? })` 写入会话。
- 标头格式：`# <title>` + 原 URL + 正文；`title` 为空时省标题行。
- 出错（含 403/404）→ `ctx.ui.notify(err.message, "error")`。

`ds-fetch` 渲染：标题行 `🌐 <title 或 url> · N 字符`，正文用 pi-tui 的 `Markdown` 组件渲染（还原 `\#`、`\/` 这类转义）；折叠时截前 18 行，末尾提示展开；展开时显示全部。

### 6.3 展开与点击

- `Ctrl+O` 走 pi 的全局 `toolOutputExpanded`，entry 和工具行一起展开/收起。
- 组件外面包一层 `MouseRegion`，左键点击调用 `ctx.ui.setToolsExpanded(!getToolsExpanded())`，与 `Ctrl+O` 同一语义。
- 全屏 TUI 模式才路由鼠标事件；regular 模式只能靠 `Ctrl+O`。

### 6.4 与其他扩展重名

pi 对重名命令自动加 `:1` / `:2` 后缀（实测 pi-web-access 的 `search` 占用了 `/search`，我们的变成 `/search:2`）。因此同时注册 `/ds-search`、`/ds-fetch` 作为稳定名字。

### 6.5 `/ds-tool-config`

配置自查（用户原始需求只有两个工具 + 启动提示，命令部分是实现补充）：

- 输出启用状态、apiKey 来源（`project`/`user`/`env`）+ 掩码（`sk-****abcd`，只留后 4 位）、`baseUrl`、`search.timeoutMs`、`search.count`、`search.needContent`、`fetch.timeoutMs`、两个配置文件路径与状态、warnings。
- 不再提供 `/ds-tool-config test`，连通性验证由 `/search` 代替。

apiKey 任何情况下都不完整打印，也不进 entry 数据、不进错误信息、不进命令输出。

## 7. 错误处理

`src/client.ts` 里的 `DeepSeekApiError`（带 `status`、`apiCode`、`hint`），消息格式：`DeepSeek <操作> 失败（HTTP <status>）：<API message>。<hint>`

| 情况 | 提示 |
| --- | --- |
| 400 | 检查参数：query 1～128 字符、count 1～50、url 必须是合法 HTTP/HTTPS |
| 401 | API Key 无效或缺失，检查配置文件或 `DEEPSEEK_API_KEY` |
| 402 | 账号余额不足，先充值再重试 |
| 403 | Fetch 被 DeepSeek 安全策略拒绝，换目标站点或跳过 |
| 404（fetch） | 无法获取可用正文：URL 不可用、被站点拦截或没有可提取正文 |
| 404（search） | 接口路径不存在，检查 `baseUrl` 配置 |
| 408 / 504 | 超时，可稍后重试 |
| 413 | 请求体过大，URL 可能过长 |
| 429 | 超过 QPS 限制（Search/Fetch 各 5 QPS，Fetch 另有域名级限制），稍后重试 |
| 5xx | DeepSeek 服务端错误，稍后重试 |
| 响应非 JSON / 结构不符 | `响应结构不符合预期` + 原始响应前 500 字符 |
| 超时（本地 `AbortSignal.timeout`） | `请求超时（timeoutMs=30000）`，search 用 `search.timeoutMs`、fetch 用 `fetch.timeoutMs` |
| 用户取消（`ctx.signal`） | `调用已取消` |
| 工具已注册但配置被关掉 | `DeepSeek 网络工具未启用：<原因>` |

实现要点：

- 超时用 `AbortSignal.timeout(timeoutMs)`：search 传 `config.search.timeoutMs`，fetch 传 `config.fetch.timeoutMs`，与 `ctx.signal` 用 `AbortSignal.any([...])` 合并。
- 先 `await res.text()` 再 `JSON.parse`，解析失败保留原文片段。
- 不自动重试，也不吞错；抛异常让 pi 生成 failed tool result。
- 请求头：`Authorization`、`Content-Type: application/json`、`Accept: application/json`、`User-Agent: pi-deepseek-web-tools/0.1.0`。

## 8. 文件结构

```
package.json                     pi 包清单（pi.extensions 指向 src/index.ts）
tsconfig.json                    strict + noEmit，给 tsc --noEmit 和编辑器用
deepseek-web-tools.example.json  配置示例
src/index.ts                     工厂：注册工具与命令、session_start 解析配置与激活
src/config.ts                    resolveConfig（纯函数）+ 类型
src/client.ts                    DeepSeekWebClient（search / fetchPage / post，每次调用传 timeoutMs）+ DeepSeekApiError
src/tools.ts                     createSearchTool / createFetchTool
src/format.ts                    formatSearchResults / formatFetchContent（工具和命令共用）
src/commands.ts                  registerCommands：/search、/ds-search、/fetch、/ds-fetch、/ds-tool-config + entry 渲染器
src/truncate.ts                  truncateWithTempFile 共享截断 + 临时文件
test/config.test.ts
test/client.test.ts
test/tools.test.ts
test/commands.test.ts
README.md                        用法、配置、工具参数、错误码、计费与限速说明
docs/plan/2026-10-18-deepseek-web-tools.md   本计划
```

依赖策略：

- 运行时不引入 npm 包，用 Node 全局 `fetch`（pi 要求 Node ≥22.19）。
- `peerDependencies`：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`，版本 `*`，不打包。
- `devDependencies`：上面三个（本地类型检查用）+ `typescript`、`vitest`、`@types/node`。
- `package.json` 关键字段：`"type": "module"`、`"pi": { "extensions": ["./src/index.ts"] }`、`keywords` 含 `pi-package`、`scripts`: `test`（`vitest --run`）、`typecheck`（`tsc --noEmit`）、`check`（两个都跑）。

`.gitignore` 追加 `.pi/deepseek-web-tools.json`（本地 key 不入库）。

## 9. 测试

vitest，全部走注入依赖，不碰真实网络（`DeepSeekWebClient` 接受 `fetchImpl`，工具接受 client 或 fetch 桩）。

### test/config.test.ts

1. 无任何配置、无环境变量 → `enabled: false`、`reason: "missing-key"`、`apiKeySource` 为空。
2. 只有 `DEEPSEEK_API_KEY` → 启用，`apiKeySource: "env"`。
3. 用户级有 key + 环境变量有 key → 用用户级，`apiKeySource: "user"`。
4. 项目级有 key + 用户级有 key → 用项目级。
5. 项目级只写 `apiKey`、用户级有 `apiKey` → 用项目级（字段级回退）。
6. 项目级 `enabled: false` + 环境变量有 key → 不启用，`reason: "explicitly-disabled"`。
7. 项目级 `enabled: true` 但两级都没 key、环境变量也没有 → 不启用，`reason: "missing-key"`。
8. 项目级有 key、用户级 `enabled: false` → 不启用（`enabled` 取到 `false`）。
9. `projectTrusted: false` → 项目文件状态 `untrusted`，只用用户级/环境变量。
10. 项目文件写成坏 JSON → 状态 `invalid`、记 warning、回退用户级。
11. `apiKey: "   "` → 视为缺失。
12. `baseUrl: "https://proxy.local/"` → 归一化成不带尾部斜杠。
13. `search.timeoutMs: "abc"` / `search.count: 999` → 用默认值并记 warning。
14. 路径解析：`cwd` 与 `agentDir` 分别来自参数和 `PI_CODING_AGENT_DIR`。
15. 项目写 `search.count`、用户写 `search.needContent` → 两个字段都生效（分组内逐字段合并）。
16. 项目与用户都写 `fetch.timeoutMs` → 取项目值；项目没写 `search.timeoutMs` → 回退用户值。
17. 只配 `search` 分组 → `fetch` 全部用默认值，两个分组互不影响。
18. `"search": 5`（非对象）→ 分组按空处理 + warning。
19. 未知键 `serach`、`search.cout` → 忽略 + warning。
20. `enabled` / `apiKey` 出现在 `search` 分组 → 忽略 + warning（只认顶层）。

### test/client.test.ts

1. `search` 发出的 URL、方法、`Authorization`、`Content-Type`、body 字段正确（未指定 `count`/`needContent` 时 body 里不出现 `count`/`need_content`）。
2. 正常响应解析出全部字段（含 null 的 `site_name`/`date`）。
3. `results: []` → 返回空数组，不报错。
4. 401 → 错误消息含「API Key 无效或缺失」，且不含完整 apiKey。
5. 402 / 403 / 429 / 404 → 各自 hint 正确。
6. 400 且响应带 `error.message` → 消息里透出 API 原文。
7. 响应不是 JSON → 报「响应结构不符合预期」并带原文片段。
8. 超时（`AbortSignal.timeout` 触发） → 报超时；外部 signal abort → 报取消。
9. `fetchPage` 发送 `{ url }`，解析 `{ title, content }`。
10. `timeoutMs` 生效（桩不返回，触发 abort）。

### test/tools.test.ts

1. `ds_search` 文本包含编号、标题、URL、summary；`site_name` 为空时回退 host。
2. 空结果 → 提示换成关键词/去掉限定语法，`details.resultCount === 0`。
3. 构造超长结果 → 触发截断，存在 `fullOutputPath` 文件，文本含截断说明。
4. `needContent: true` → 正文进入 `structuredContent` 与文本。
5. `ds_fetch` 正常返回带标题头与正文。
6. `ds_fetch` 非法 URL（`ftp://`、带 `user:pass@`、超过 8192 字符）→ 本地报错且没发请求。
7. `ds_fetch` 空正文 → 抛「抓取成功但没有正文」。
8. 未启用（client 未初始化）时直接调用 → 抛「未启用」错误。

### test/commands.test.ts

用最小假 `ExtensionAPI`（捕获 `registerCommand` / `registerMessageRenderer` / `sendMessage`）和假 `ctx`（`ui.notify` 打点），直接调 handler。

1. `/search` 无参数 → notify 用法提示，不调 API、不发消息。
2. 未启用时 `/search` → notify 配置提示，不调 API。
3. `/search DeepSeek` → 调一次 search（`count` 来自配置）、`sendMessage` 一次且 `customType === "ds-search-result"`，内容含标题与 URL。
4. `/search` 时 API 报 401 → notify error，handler 不抛异常。
5. `/search` 空结果 → 仍然 `sendMessage`，正文含「没有搜索到结果」。
6. `/fetch` 无参数 → notify 用法提示。
7. `/fetch <https://example.com/a>` → 去掉尖括号，`sendMessage` 的 `customType === "ds-fetch-result"`，内容含标题与正文。
8. `/fetch` 超长正文 → 消息截断 + `details.fullOutputPath` 存在。
9. `/fetch ftp://x` → notify error，没发请求。
10. `/ds-tool-config` → notify 内容含 apiKey 来源与掩码，且不含完整 key。

### 手动验收

1. `npm run check`（typecheck + test）全绿。
2. 无 key：`pi -e ./` 启动弹一次 warning，工具列表里没有 `ds_search`/`ds_fetch`。
3. 有 key：`DEEPSEEK_API_KEY=sk-xxx pi -e ./` 启动无提示，`ds_search` 能返回结果，`ds_fetch` 能抓回正文。
4. 项目里放 `.pi/deepseek-web-tools.json` 写 `{"enabled": false}` 覆盖环境变量 → 工具消失且不弹提示。
5. `/ds-tool-config` 显示来源与掩码正确；`/search DeepSeek` 在会话里出结果；`/fetch <url>` 能拉回正文。
6. 改配置后 `/reload` 生效。
7. `pi install ./`（本地包）能被识别并加载。

## 10. 实现顺序

1. 脚手架：`package.json`、`tsconfig.json`、示例配置、`.gitignore` 追加。
2. `src/config.ts` + `test/config.test.ts`。
3. `src/client.ts` + `test/client.test.ts`。
4. `src/truncate.ts`、`src/format.ts`、`src/tools.ts` + `test/tools.test.ts`。
5. `src/commands.ts` + `test/commands.test.ts`。
6. `src/index.ts`（注册工具与命令、session_start 解析配置与激活、启动通知）。
7. `README.md`。
8. 跑 `npm run check`，按手动验收逐条走。

## 11. 假设与默认值

- 配置是标准 JSON，不支持注释和尾逗号。
- 全局字段只有 `enabled`、`apiKey`、`baseUrl`；`search` / `fetch` 各自独立按项目 → 用户逐字段合并，缺省用默认值。
- 没有发布过旧版，扁平的顶层 `timeoutMs` / `searchCount` / `needContent` 不做兼容，出现时按未知键告警。
- 项目级配置只在项目已信任时读取，与 pi 处理 `.pi/` 的规则一致。
- 用户选择「未配置时只弹一次通知」，不做 footer 状态常驻。
- 搜索默认不发 `need_content`；`search.needContent` 为 true 时改发 `true`，工具参数 `needContent` 优先于配置。
- 不做自动重试、不做并发限流；429/5xx 由模型或用户决定重试。
- 截断阈值沿用 pi 内置常量（50KB / 2000 行），完整内容落临时文件。
- `/ds-tool-config` 命令是实现补充，超出原始需求但便于自查；若不需要可整段删掉，不影响两个工具。
- `/search`、`/fetch` 的结果以 custom message 写入会话（`display: true`），不带 `triggerTurn`，不会自动触发模型；内容受同样截断限制，完整版落临时文件。
- 命令不做参数补全，不解析 `--count` 之类选项，条数只从配置读。
- 计费按「每次成功请求」计（Search 有结果、Fetch 有正文才算成功），README 里提示 2026-11-01 起第三方工具调用开始计费、各 5 QPS 限速。

## 12. 实现与验证结果

代码按本计划落地，额外补了 `test/extension.test.ts` 覆盖工厂装配（注册两个工具、三个命令、`session_start` 激活/停用与启动提示）。

验证记录：

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（strict + noEmit） |
| `npm test` | 5 个测试文件、79 条用例全绿，全部无网络 |
| `pi -e ./ --help` | 扩展加载无报错 |
| 真实 `ds_search` | 返回 “Change Log \| DeepSeek API Docs” 与 URL |
| 真实 `ds_fetch` | 拉回 `https://api.deepseek.com/v1/tools/fetch` 的 Markdown 正文 |
| `/ds-search` | 会话里出现 `🔍 … · 10 条结果` entry，折叠提示「Ctrl+O 或点击展开」 |
| `/fetch` | entry 按 Markdown 渲染（转义还原），`Ctrl+O` 后显示完整正文 |
| `/fetch` 标点转义 | 实测同一页面：去转义前 53548 字符、带 `\#`；去转义后 50104 字符、0 个反斜杠，标题/列表/括号正常 |
| 命令结果不进上下文 | `--mode json` 里只有 `entry_appended`（type=custom），没有 `custom_message`；代码侧 `sessionEntryToContextMessages` 对 custom 返回 `[]` |
| 无 key 启动 | 输出「DeepSeek 网络工具未启用：缺少 API key。」及配置说明，工具不激活 |
| 项目级 `enabled: false` | 单测覆盖：停用且不提示 |

未执行的手工步骤：`pi install ./`（会写入用户 settings，是否安装由使用者决定）。print 模式无 UI，`/ds-tool-config` 的 notify 输出看不到，属预期行为。

补充记录：用户已自行 `pi install ./`。共同安装的 pi-web-access 也注册了 `/search`，pi 将其重命名为 `search:1`、我们的为 `search:2`，因此新增 `/ds-search` / `/ds-fetch` 别名。鼠标点击展开依赖全屏模式的鼠标路由，regular 模式只有 `Ctrl+O`。
