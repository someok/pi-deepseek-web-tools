# pi-deepseek-web-tools

**简体中文** | [English](README.md)

---

给 [pi](https://pi.dev) 加两个工具：`ds_search`（DeepSeek 网页搜索）和 `ds_fetch`（网页抓取）。普通网页走 DeepSeek 官方 [Search / Fetch API](https://api-docs.deepseek.com/zh-cn/guides/search)；GitHub 链接自动改走本地 `git` / `gh`，仓库直接克隆到本地让模型翻源码，PR/Issue 渲染成结构化文档。

配置齐全时两个工具都可用；没配 DeepSeek key 时 `ds_search` 和普通网页抓取不可用，但 `ds_fetch` 的 GitHub 部分照常工作。

## 安装

```bash
# 从 npm 安装（推荐），之后每次启动都加载
pi install npm:@someok/pi-deepseek-web-tools

# 只试一次，不写设置
pi -e npm:@someok/pi-deepseek-web-tools

# 开发时从本地目录加载
pi -e ./
```

之前用 `pi install ./` 装过本地路径的，先用 `pi list` 找到那一条并 `pi remove <本地路径>`，再装 npm 包。两个入口同时存在会重复加载同一个扩展，工具名冲突会直接报错。

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
  },
  "github": {
    "enabled": true,
    "prIssue": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "~/pi-github-repos"
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
| `github.enabled` | `true` | 关掉后 `ds_fetch` 不再走 GitHub 专用路径 |
| `github.prIssue` | `true` | 是否用 `gh` 把 PR/Issue 渲染成结构化文档 |
| `github.maxRepoSizeMB` | `350` | 超过这个体积改用 GitHub API 轻量视图，不克隆 |
| `github.cloneTimeoutSeconds` | `30` | 1～600，超时后连 git 子进程一起杀掉 |
| `github.clonePath` | 系统临时目录下 `pi-github-repos` | 支持 `~` 和 `$HOME` 这类写法 |

配置写错（坏 JSON、字段类型不对、拼错键名）不会让扩展崩掉：出问题的字段被忽略并记一条告警，启动时和 `/ds-tool-config` 里能看到。改完配置执行 `/reload` 生效。

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

遇到 `github.com` 链接会自动改走专用路径，详见下一节。

## GitHub 链接

`ds_fetch` 拿到 `github.com` 的 URL 时不再走 DeepSeek，而是按 URL 类型分派：

| URL | 处理方式 |
| --- | --- |
| `github.com/owner/repo` | 克隆到本地，返回目录树 + README + 本地路径 |
| `.../tree/main/src` | 返回该目录的文件列表（带大小） |
| `.../blob/main/src/index.ts` | 返回文件内容；二进制文件只说明类型和大小 |
| `.../pull/123`、`.../issues/7` | 用 `gh` 取数，渲染成一份带状态、分支、CI、review、文件、commits、评论的文档 |
| 超过 `maxRepoSizeMB` 的仓库 | 自动改用 GitHub API 的轻量视图（tree + README） |
| `.../commit/<sha>` | 直接走 API，不为看一个提交克隆整个仓库 |

克隆只拉一个分支的一层历史（`--depth 1 --single-branch`），同一个仓库重复抓取会复用本地目录。

**依赖**：`git` 必需；`gh` 可选，但装了才有完整的 PR/Issue 视图和私有仓库访问，没有 `gh` 时 PR/Issue 会回落到普通网页抓取。GitHub 这条路不消耗 DeepSeek 额度。

### 界面上的显示

- 工具行默认折叠，只显示结果条数或字符数；展开后显示工具返回的全部文本，不再按行数二次截断。
- `/ds-search`、`/ds-fetch` 的结果同样默认折叠，**展开方式：`Ctrl+O` 或鼠标点击**；抓取结果按 Markdown 渲染（标题、列表、代码块、链接）。
- DeepSeek 的 Fetch 接口会把正文里的标点全转义（`\#`、`\-`、`\,`、`\/`），插件进来时先统一去转义，再渲染和给模型，所以界面上看不到反斜杠。Markdown 渲染关掉了 LaTeX 解析，`(a 100K context is enough)` 这类括号不会当成公式。
- 唯一的上限是 2000 行 / 50KB（pi 对模型可见内容的约定）：超过时正文末尾会写一行 `[输出已截断：… 完整内容：/tmp/…]`，需要全文时让模型 `read` 那个临时文件。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/ds-search <搜索词>` | 手动跑一次搜索 |
| `/ds-fetch <网址>` | 手动抓一个网页，支持 `/ds-fetch <https://...>` 这种粘贴形式 |
| `/ds-tool-config` | 查看当前生效的配置：启用状态、key 来源（脱敏）、超时、两个配置文件是否读到 |

只注册 `ds-` 前缀的命令，不用 `/search`、`/fetch` 这种裸名：`/search` 已被别的扩展（如 pi-web-access）占用，pi 会给重名命令加 `:1`、`:2` 后缀，自己都不知道会拿到哪个。

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

超时由 `search.timeoutMs` / `fetch.timeoutMs` 控制，按本地计时中断请求。命令失败会弹 error 提示；工具调用失败表现为失败的工具结果。

## 限额与计费

- Search 与 Fetch 各自限速 5 QPS（账号级），Fetch 另有目标域名级限制。
- 按成功请求计费：每 1000 次 5 元；Search 无结果、Fetch 没拿到正文、请求失败都不计费。
- DeepSeek 说明：第三方工具直接调用 Search / Fetch 会从 2026-11-01 起按次计费。

## 开发

```bash
npm install
npm run check   # tsc --noEmit + vitest
```

- 运行时不依赖任何 npm 包：普通网页用 Node 内置 `fetch`，GitHub 用内置 `child_process` 调 `git` / `gh`。
- 测试全部走注入的 `fetchImpl` 或纯函数，不联网。
- `src/config.ts` 是纯函数，方便单独测配置合并。

## 发布到 npm

```bash
npm login
npm version patch   # 可选：打版本、提交、打 tag
npm publish         # 或在 VS Code 的 NPM Scripts 面板里点 release（就是这条）
```

- 脚本名用 `release` 而不是 `publish`：npm 把 `publish` 当成发布后的生命周期钩子，`"publish": "npm publish"` 会发一次再被钩子发一次，第二次因版本已存在而报错。
- `prepublishOnly` 会先跑 `npm run check`，typecheck 或测试挂了就不发。
- 演练用 `npm run release -- --dry-run`，不会真的上传。
- `publishConfig.access` 已是 `public`（scoped 包不显式声明会默认私有，发布失败）。
- 先 `npm pack --dry-run` 看打包内容：当前 14 个文件，只含 `src/`、中英文 README、LICENSE、示例配置，不含测试和计划文档。

## 安全

`apiKey` 只出现在发给 DeepSeek 的请求头里，不会写进工具输出、`details`、`structuredContent` 或日志。`/ds-tool-config` 只显示掩码（如 `sk-****abcd`）。项目级配置含 key 时建议加入 `.gitignore`（本仓库已忽略 `.pi/deepseek-web-tools.json`）。
