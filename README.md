
# pi-deepseek-web-tools


**English** | [简体中文](README.zh-CN.md)

---

Two tools for [pi](https://pi.dev): `ds_search` (web search) and `ds_fetch` (fetching). Ordinary pages go through the official DeepSeek [Search / Fetch API](https://api-docs.deepseek.com/guides/search). GitHub URLs take a different path: repositories are cloned locally so the model can read real source files, and PRs/issues are rendered into a structured document with the local `gh` CLI.

With a complete configuration both tools are available. Without a DeepSeek key, `ds_search` and ordinary page fetching are unavailable, but the GitHub half of `ds_fetch` keeps working.

## Install

```bash
# Install from npm (recommended); loads on every start
pi install npm:@someok/pi-deepseek-web-tools

# Try once without writing settings
pi -e npm:@someok/pi-deepseek-web-tools

# Load from a local checkout while developing
pi -e ./
```

If you previously installed a local path with `pi install ./`, find that entry with `pi list` and remove it (`pi remove <local path>`) before installing the npm package. Two entry points load the same extension twice and pi fails with a tool name conflict.

## Configuration

Both config files share the same structure; project level wins.

| Level | Path |
| --- | --- |
| Project | `<project>/.pi/deepseek-web-tools.json` |
| User | `~/.pi/agent/deepseek-web-tools.json` (follows `$PI_CODING_AGENT_DIR` when set) |
| Environment | `DEEPSEEK_API_KEY` |

Project config is read only when the project is trusted, matching how pi handles `.pi/`.

Full example (also in `deepseek-web-tools.example.json`):

```json
{
  "enabled": true,
  "apiKey": "sk-...",
  "baseUrl": "https://api.deepseek.com",
  "exposure": {
    "search": "codemode",
    "fetch": "direct"
  },
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

Merge rules: each field resolves project → user → default; `apiKey` additionally falls back to `DEEPSEEK_API_KEY`.

| Field | Default | Notes |
| --- | --- | --- |
| `enabled` | enabled when an apiKey resolves | `false` forces the tools off, even if the env var has a key |
| `apiKey` | none | a blank string counts as missing |
| `baseUrl` | `https://api.deepseek.com` | trailing slashes are stripped |
| `exposure` | `{ "search": "codemode", "fetch": "direct" }` | per-tool declaration mode; `codemode` hides the tool so only scripts can call it, `direct` declares it to the model. A bare string (`"direct"` / `"codemode"`) applies to both tools |
| `search.timeoutMs` | `30000` | 1000–300000 |
| `search.count` | not sent (API default 10) | 1–50 |
| `search.needContent` | `false` | include page body in search results |
| `fetch.timeoutMs` | `90000` | 1000–300000 |
| `github.enabled` | `true` | when false, `ds_fetch` stops using the GitHub-specific paths |
| `github.prIssue` | `true` | render PRs/issues into a structured document with `gh` |
| `github.maxRepoSizeMB` | `350` | larger repos use the lightweight GitHub API view instead of a clone |
| `github.cloneTimeoutSeconds` | `30` | 1–600; on timeout the whole git process group is killed |
| `github.clonePath` | `pi-github-repos` under the system temp dir | `~` and `$HOME` style paths are expanded |

A broken config (invalid JSON, wrong type, typo) never crashes the extension: the offending field is ignored with a warning shown at startup and in `/ds-tool-config`. Run `/reload` after editing.

## Tools

### `ds_search`

| Parameter | Required | Notes |
| --- | --- | --- |
| `query` | yes | 1–128 characters; supports `site:`, `-site:`, `"exact phrase"`, `lang:`, `after:`, `before:` |
| `count` | no | 1–50; falls back to `search.count` |
| `needContent` | no | include page body; falls back to `search.needContent` |

Returns a numbered result list (title / URL / site and publish date / summary). Results over 2000 lines or 50KB are truncated, the full JSON is written to a temp file, and its path is appended to the text.

### `ds_fetch`

| Parameter | Required | Notes |
| --- | --- | --- |
| `url` | yes | HTTP/HTTPS URL with a host, no credentials, at most 8192 characters |

Returns the page title plus Markdown body. The body is truncated the same way (2000 lines / 50KB), with the full content written to a temp file.

`github.com` URLs are routed to the dedicated paths described below.

## GitHub URLs

When `ds_fetch` receives a `github.com` URL it stops using DeepSeek and dispatches on the URL shape:

| URL | What happens |
| --- | --- |
| `github.com/owner/repo` | cloned locally; returns the tree, README, and the local path |
| `.../tree/main/src` | returns that directory's listing with file sizes |
| `.../blob/main/src/index.ts` | returns the file contents; binary files only report type and size |
| `.../pull/123`, `.../issues/7` | fetched with `gh` and rendered with state, branch, checks, reviews, files, commits, and comments |
| repos over `maxRepoSizeMB` | fall back to the lightweight GitHub API view (tree + README) |
| `.../commit/<sha>` | goes straight to the API instead of cloning for one commit |

Clones are shallow and single-branch (`--depth 1 --single-branch`), and repeat fetches of the same repo reuse the local directory.

**Dependencies**: `git` is required; `gh` is optional. Install it for full PR/issue views and private repositories. Without `gh`, PRs and issues fall back to ordinary page fetching. This path never spends DeepSeek credits.

### How output is displayed

- Tool rows are collapsed by default and show only the result count or character count. Expanding them shows the full text the tool returned — no second truncation by line count.
- `/ds-search` and `/ds-fetch` entries are collapsed too. Expand with **`Ctrl+O` or a mouse click**; fetched pages render as Markdown (headings, lists, code blocks, links).
- The DeepSeek Fetch API escapes every punctuation character in the body (`\#`, `\-`, `\,`, `\/`). The extension unescapes it before rendering or handing it to the model, so no backslashes show up. LaTeX parsing is disabled, so `(a 100K context is enough)` is not treated as a formula.
- The only hard limit is 2000 lines / 50KB (pi's convention for model-facing content). When exceeded, the body ends with `[output truncated: … full content: /tmp/…]`; ask the model to `read` that file for the rest.

## Commands

| Command | Purpose |
| --- | --- |
| `/ds-search <query>` | Run one search manually |
| `/ds-fetch <url>` | Fetch one page; the `<https://...>` paste form works |
| `/ds-tool-config` | Show the effective config: enabled state, key source (masked), timeouts, and whether each config file was read |

Only `ds-` prefixed commands are registered. Bare `/search` and `/fetch` are avoided because other extensions (such as pi-web-access) already use them, and pi renames duplicates with `:1` / `:2` suffixes, so you cannot tell which one you get.

Command results are written as custom entries: they render in the UI but **never enter the model context**, so the model cannot see what you fetched manually. They are stored in the session and remain visible after resuming.

## Errors

| Status | Meaning | Hint |
| --- | --- | --- |
| 400 | Invalid parameters | Check query length, count range, URL format |
| 401 | Missing or invalid key | Check the config files or `DEEPSEEK_API_KEY` |
| 402 | Insufficient balance | Top up first |
| 403 | Fetch blocked by safety policy | Try another site or skip it |
| 404 | Search path missing / Fetch got no body | Check `baseUrl`; or the page is not extractable |
| 408 / 504 | Timeout | Retry later |
| 413 | Request body too large | URL is too long |
| 429 | QPS limit hit | Retry later |
| 5xx | Server error | Retry later |

Timeouts come from `search.timeoutMs` / `fetch.timeoutMs` and abort the request locally. Commands report failures with an error notification; tool calls surface them as failed tool results.

## Limits and billing

- Search and Fetch are each limited to 5 QPS per account; Fetch also has per-domain limits.
- Billing is per successful request: 5 CNY per 1000 requests. Searches with no results, fetches without body text, and failed requests are not billed.
- Per DeepSeek, direct third-party calls to Search / Fetch become metered on 2026-11-01.

## Development

```bash
npm install
npm run check   # tsc --noEmit + vitest
```

- No runtime npm dependencies: ordinary pages use Node's built-in `fetch`, GitHub uses built-in `child_process` to call `git` / `gh`.
- Tests inject a fake `fetchImpl` or exercise pure functions and never touch the network.
- `src/config.ts` is a pure function, so config merging is easy to test on its own.

## Publishing to npm

```bash
npm login
npm version patch   # optional: bump version, commit, tag
npm publish         # or click "release" in VS Code's NPM Scripts panel
```

- The script is named `release`, not `publish`: npm treats `publish` as a post-publish lifecycle hook, so `"publish": "npm publish"` would publish once and then again from the hook, and the second run fails because the version already exists.
- `prepublishOnly` runs `npm run check` first; a typecheck or test failure blocks the publish.
- Rehearse with `npm run release -- --dry-run`; nothing is uploaded.
- `publishConfig.access` is `public` (scoped packages default to private, which makes the publish fail).
- Inspect the tarball with `npm pack --dry-run`: currently 14 files — `src/`, both READMEs, LICENSE, and the example config; no tests or plan docs.

## Security

`apiKey` only appears in the request header sent to DeepSeek. It is never written to tool output, `details`, `structuredContent`, or logs. `/ds-tool-config` shows a mask only (`sk-****abcd`). If a project config contains a key, add it to `.gitignore` (this repo already ignores `.pi/deepseek-web-tools.json`).
