import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import { formatFetchedPage, formatSearchResults, unescapeMarkdown } from "./format";
import { maskApiKey, type FileStatus, type ResolvedConfig } from "./config";
import { markdownThemeFrom } from "./markdown-theme";
import { notEnabledMessage, requireClient, type ExtensionState } from "./state";
import { truncateWithTempFile } from "./truncate";
import { validateFetchUrl } from "./tools";

/** /search 结果写入会话的 custom entry 数据（不进模型上下文） */
interface SearchEntryData {
	query: string;
	resultCount: number;
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}

/** /fetch 结果写入会话的 custom entry 数据（不进模型上下文） */
interface FetchEntryData {
	url: string;
	title: string;
	contentLength: number;
	text: string;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface CommandDeps {
	/** 取当前 UI 上下文，用于点击展开 */
	getUi?: () => ExtensionUIContext | undefined;
}

const SEARCH_ENTRY = "ds-search";
const FETCH_ENTRY = "ds-fetch";

const FILE_STATUS_LABEL: Record<FileStatus, string> = {
	missing: "未找到",
	ok: "已读取",
	invalid: "解析失败",
	untrusted: "项目未信任，已跳过",
};

function clampLines(text: string, maxLines: number): { body: string; omitted: number } {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return { body: text, omitted: 0 };
	return { body: lines.slice(0, maxLines).join("\n"), omitted: lines.length - maxLines };
}

function configSummary(config: ResolvedConfig): string {
	const state = config.enabled
		? "已启用"
		: config.reason === "explicitly-disabled"
			? "已禁用（enabled: false）"
			: "未启用（缺少 API key）";

	const lines = [`DeepSeek 网络工具：${state}`];
	lines.push(
		config.apiKey
			? `API key：${maskApiKey(config.apiKey)}（来源：${config.apiKeySource}）`
			: "API key：未配置",
	);
	lines.push(`baseUrl：${config.baseUrl}`);
	lines.push(
		`search：timeoutMs=${config.search.timeoutMs}, count=${config.search.count ?? "未设置（API 默认 10）"}, needContent=${config.search.needContent}`,
	);
	lines.push(`fetch：timeoutMs=${config.fetch.timeoutMs}`);
	lines.push(`项目配置：${config.projectFile.path}（${FILE_STATUS_LABEL[config.projectFile.status]}）`);
	lines.push(`用户配置：${config.userFile.path}（${FILE_STATUS_LABEL[config.userFile.status]}）`);

	if (config.warnings.length > 0) {
		lines.push("", "配置警告：");
		for (const warning of config.warnings) lines.push(`• ${warning}`);
	}

	return lines.join("\n");
}

/** `/fetch <https://x>` 这种粘贴习惯：去掉包裹的尖括号 */
function stripBrackets(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1).trim();
	if (trimmed.startsWith("<")) return trimmed.slice(1).trim();
	return trimmed;
}

function wrapClickable(component: Component, toggle: () => boolean): Component {
	return new MouseRegion(component, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		return toggle() ? { handled: true } : undefined;
	});
}

export function registerCommands(pi: ExtensionAPI, state: ExtensionState, deps: CommandDeps = {}): void {
	/** 点击展开/收起：复用 pi 的全局「工具输出展开」开关，和 Ctrl+O 保持同步 */
	const toggleExpanded = (): boolean => {
		const ui = deps.getUi?.();
		if (!ui) return false;
		ui.setToolsExpanded(!ui.getToolsExpanded());
		return true;
	};

	pi.registerEntryRenderer<SearchEntryData>(SEARCH_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;

		const header =
			`🔍 ${data.query} · ${data.resultCount} 条结果` + (data.truncated ? "（已截断）" : "");
		const { body, omitted } = expanded
			? { body: data.text, omitted: 0 }
			: clampLines(data.text, 14);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("toolTitle", theme.bold(header)), 0, 0));
		box.addChild(new Text(theme.fg("customMessageText", body), 0, 0));
		if (omitted > 0) {
			box.addChild(new Text(theme.fg("dim", `… 还有 ${omitted} 行，Ctrl+O 或点击展开`), 0, 0));
		}

		return wrapClickable(box, toggleExpanded);
	});

	pi.registerEntryRenderer<FetchEntryData>(FETCH_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;

		const header =
			`🌐 ${data.title || data.url} · ${data.contentLength} 字符` +
			(data.truncated ? "（已截断）" : "");
		const { body, omitted } = expanded
			? { body: data.text, omitted: 0 }
			: clampLines(data.text, 18);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("toolTitle", theme.bold(header)), 0, 0));
		// 抓取结果是 Markdown，按 Markdown 渲染（反斜杠转义也会被还原）
		box.addChild(
			new Markdown(body, 0, 0, markdownThemeFrom(theme), { color: (text) => theme.fg("customMessageText", text) }, {
				// 网页正文里的 $...$、\(...\) 不应被当成公式
				renderLatex: false,
			}),
		);
		if (omitted > 0) {
			box.addChild(new Text(theme.fg("dim", `… 还有 ${omitted} 行，Ctrl+O 或点击展开`), 0, 0));
		}

		return wrapClickable(box, toggleExpanded);
	});

	const searchHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const query = args.trim();
		if (!query) {
			ctx.ui.notify("用法：/search <搜索词>", "warning");
			return;
		}
		if (!state.client || !state.config?.enabled) {
			ctx.ui.notify(notEnabledMessage(state.config), "warning");
			return;
		}

		try {
			const { client, config } = requireClient(state);
			const response = await client.search(
				{ query, count: config.search.count, needContent: config.search.needContent },
				{ signal: ctx.signal, timeoutMs: config.search.timeoutMs },
			);
			const text = formatSearchResults({
				query,
				results: response.results,
				includeContent: config.search.needContent,
			});
			const fullText = JSON.stringify(
				{ query, count: config.search.count ?? 0, results: response.results },
				null,
				2,
			);
			const truncated = await truncateWithTempFile(text, {
				prefix: "pi-ds-search-",
				fileName: "results.json",
				fullText,
			});

			const data: SearchEntryData = {
				query,
				resultCount: response.results.length,
				text: truncated.content,
				truncated: truncated.truncated,
				...(truncated.fullOutputPath ? { fullOutputPath: truncated.fullOutputPath } : {}),
			};
			// appendEntry：只进会话和界面，不进模型上下文
			pi.appendEntry(SEARCH_ENTRY, data);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const fetchHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const raw = args.trim();
		if (!raw) {
			ctx.ui.notify("用法：/fetch <网址>", "warning");
			return;
		}
		if (!state.client || !state.config?.enabled) {
			ctx.ui.notify(notEnabledMessage(state.config), "warning");
			return;
		}

		try {
			const url = validateFetchUrl(stripBrackets(raw)).toString();
			const { client, config } = requireClient(state);
			const page = await client.fetchPage({ url }, { signal: ctx.signal, timeoutMs: config.fetch.timeoutMs });
			// DeepSeek Fetch 返回的是「标点全转义」的 Markdown，先去转义再用
			const content = unescapeMarkdown(page.content);
			if (!content.trim()) {
				throw new Error("抓取成功但没有正文：目标页面可能没有可提取的 Markdown 内容，或被站点策略拦截。");
			}

			const text = formatFetchedPage({ title: page.title, url, content });
			const truncated = await truncateWithTempFile(text, {
				prefix: "pi-ds-fetch-",
				fileName: "content.md",
			});

			const data: FetchEntryData = {
				url,
				title: page.title,
				contentLength: content.length,
				text: truncated.content,
				truncated: truncated.truncated,
				...(truncated.fullOutputPath ? { fullOutputPath: truncated.fullOutputPath } : {}),
			};
			pi.appendEntry(FETCH_ENTRY, data);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	pi.registerCommand("search", {
		description: "用 DeepSeek 搜索网页（用法：/search <搜索词>）",
		handler: searchHandler,
	});
	// 其他扩展可能也注册了 /search，pi 会给重名命令加 :1 / :2 后缀，用别名保证能调到自己这个
	pi.registerCommand("ds-search", {
		description: "用 DeepSeek 搜索网页（/search 的稳定别名）",
		handler: searchHandler,
	});

	pi.registerCommand("fetch", {
		description: "用 DeepSeek 抓取网页正文（用法：/fetch <网址>）",
		handler: fetchHandler,
	});
	pi.registerCommand("ds-fetch", {
		description: "用 DeepSeek 抓取网页正文（/fetch 的稳定别名）",
		handler: fetchHandler,
	});

	pi.registerCommand("ds-tool-config", {
		description: "查看 DeepSeek 网络工具的配置状态",
		handler: async (_args, ctx) => {
			if (!state.config) {
				ctx.ui.notify("DeepSeek 网络工具尚未初始化，执行 /reload 后重试。", "warning");
				return;
			}
			ctx.ui.notify(configSummary(state.config), "info");
		},
	});
}
