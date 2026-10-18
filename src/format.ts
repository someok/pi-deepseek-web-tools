import type { SearchResultItem } from "./client";

export const EMPTY_SEARCH_MESSAGE =
	"没有搜索到结果。可以换关键词，或去掉 site: / after: 之类的限定语法。";

function hostOf(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return parsed.hostname || undefined;
	} catch {
		return undefined;
	}
}

function formatDate(value: string | null): string | undefined {
	if (!value) return undefined;
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	return match?.[1] ?? value.trim();
}

function formatSummary(item: SearchResultItem): string {
	return item.summary.trim() || item.snippet.trim();
}

function formatMeta(item: SearchResultItem): string | undefined {
	const site = item.siteName?.trim() || hostOf(item.url);
	const date = formatDate(item.date);
	const parts: string[] = [];
	if (site) parts.push(`站点：${site}`);
	if (date) parts.push(`发布：${date}`);
	return parts.length > 0 ? parts.join(" ｜ ") : undefined;
}

export interface FormatSearchInput {
	query: string;
	results: SearchResultItem[];
	/** 是否把正文也放进模型可见文本 */
	includeContent: boolean;
}

/** ds_search 工具与 /search 命令共用的文本格式 */
export function formatSearchResults(input: FormatSearchInput): string {
	const { query, results, includeContent } = input;

	if (results.length === 0) {
		return `${EMPTY_SEARCH_MESSAGE}\nquery="${query}"`;
	}

	const lines: string[] = [`找到 ${results.length} 条结果：query="${query}"`];

	results.forEach((item, index) => {
		lines.push("");
		lines.push(`${index + 1}. ${item.title.trim() || item.url || "(无标题)"}`);
		if (item.url) lines.push(`   ${item.url}`);

		const meta = formatMeta(item);
		if (meta) lines.push(`   ${meta}`);

		const summary = formatSummary(item);
		if (summary) lines.push(`   ${summary}`);

		if (includeContent && item.content.trim()) {
			lines.push(`   正文：${item.content.trim()}`);
		}
	});

	return lines.join("\n");
}

/**
 * DeepSeek 的 Fetch 接口会把正文里的标点全部转义（`\#`、`\-`、`\,`、`\/`…）。
 * 这里把「反斜杠 + ASCII 标点」还原成原字符，恢复页面的标题、列表、链接等 Markdown 结构。
 * 字母串（如 `\n`、Windows 路径 `C:\Users`）不受影响。
 */
export function unescapeMarkdown(text: string): string {
	return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

export interface FormatFetchInput {
	title: string;
	url: string;
	content: string;
}

/** ds_fetch 工具与 /fetch 命令共用的文本格式 */
export function formatFetchedPage(input: FormatFetchInput): string {
	const title = input.title.trim();
	const parts: string[] = [];
	if (title) parts.push(`# ${title}`);
	if (input.url) parts.push(input.url);
	parts.push(input.content);
	return parts.join("\n\n");
}
