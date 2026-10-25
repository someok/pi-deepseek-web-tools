import { defineTool, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SearchResultItem } from "./client";
import type { ToolExposureMode } from "./config";
import { formatFetchedPage, formatSearchResults, unescapeMarkdown } from "./format";
import { extractGitHubUrl } from "./github";
import { markdownThemeFrom } from "./markdown-theme";
import { notEnabledMessage, requireClient, type ExtensionState } from "./state";
import { truncateWithTempFile } from "./truncate";

const MAX_URL_LENGTH = 8192;

const searchResultSchema = Type.Object({
	title: Type.String(),
	url: Type.String(),
	snippet: Type.String(),
	summary: Type.String(),
	siteName: Type.Union([Type.String(), Type.Null()]),
	siteIcon: Type.Union([Type.String(), Type.Null()]),
	date: Type.Union([Type.String(), Type.Null()]),
	authority: Type.Union([Type.Number(), Type.Null()]),
	rerankScore: Type.Union([Type.Number(), Type.Null()]),
	content: Type.Optional(Type.String()),
});

const searchOutputSchema = Type.Object({
	query: Type.String(),
	count: Type.Integer(),
	resultCount: Type.Integer(),
	results: Type.Array(searchResultSchema),
});

const fetchOutputSchema = Type.Object({
	url: Type.String(),
	title: Type.String(),
	content: Type.String(),
	contentLength: Type.Integer(),
	truncated: Type.Boolean(),
	fullOutputPath: Type.Optional(Type.String()),
});

const searchParameters = Type.Object({
	query: Type.String({
		description: "搜索词，1～128 个字符；支持 site:、-site:、引号、lang:、after:、before: 等搜索语法",
		minLength: 1,
		maxLength: 128,
	}),
	count: Type.Optional(
		Type.Integer({
			description: "返回条数，1～50；不传时用配置 search.count，仍未配置则用 DeepSeek 默认的 10",
			minimum: 1,
			maximum: 50,
		}),
	),
	needContent: Type.Optional(
		Type.Boolean({
			description: "是否在结果里返回网页正文（体积明显变大，通常不需要），默认取配置 search.needContent",
		}),
	),
});

const fetchParameters = Type.Object({
	url: Type.String({
		description: "要抓取的网页地址，必须是带 host 的 HTTP/HTTPS URL，不能带用户名或密码，长度不超过 8192",
		minLength: 1,
		maxLength: MAX_URL_LENGTH,
	}),
});

export interface SearchDetails {
	query: string;
	endpoint: string;
	count: number;
	resultCount: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export type FetchSource = "deepseek" | "clone" | "api" | "gh";

export interface FetchDetails {
	url: string;
	title: string;
	contentLength: number;
	/** 正文从哪来：DeepSeek Fetch、本地 clone、GitHub API 或 gh CLI */
	source: FetchSource;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

const SOURCE_LABELS: Record<FetchSource, string> = {
	deepseek: "DeepSeek",
	clone: "GitHub clone",
	api: "GitHub API",
	gh: "gh",
};

interface BuildFetchResultInput {
	url: string;
	title: string;
	content: string;
	source: FetchSource;
}

/** ds_fetch 的两条取数路径共用同一个返回结构 */
async function buildFetchResult(input: BuildFetchResultInput) {
	const { url, title, content, source } = input;
	if (!content.trim()) {
		throw new Error("抓取成功但没有正文：目标页面可能没有可提取的内容，或被站点策略拦截。");
	}

	const text = formatFetchedPage({ title, url, content });
	const truncated = await truncateWithTempFile(text, {
		prefix: "pi-ds-fetch-",
		fileName: "content.md",
	});

	const details: FetchDetails = {
		url,
		title,
		contentLength: content.length,
		source,
		...(truncated.truncated
			? { truncation: truncated.truncation, fullOutputPath: truncated.fullOutputPath }
			: {}),
	};

	return {
		content: [{ type: "text" as const, text: truncated.content }],
		details,
		structuredContent: {
			url,
			title,
			content,
			contentLength: content.length,
			truncated: truncated.truncated,
			...(truncated.fullOutputPath ? { fullOutputPath: truncated.fullOutputPath } : {}),
		},
	};
}

function textOfContent(content: ReadonlyArray<unknown>): string {
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") return record.text;
	}
	return "";
}

/** 校验 /ds-fetch 与 ds_fetch 共用的 URL 规则：http(s)、有 host、不带账号密码、长度上限 */
export function validateFetchUrl(raw: string): URL {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("缺少网址。用法：/ds-fetch <网址>");
	}
	if (trimmed.length > MAX_URL_LENGTH) {
		throw new Error(`网址过长（${trimmed.length} 字符），上限 ${MAX_URL_LENGTH} 字符`);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`不是合法的网址：${trimmed}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`只支持 HTTP/HTTPS 网址，收到的是 ${parsed.protocol.replace(":", "")}`);
	}
	if (!parsed.hostname) {
		throw new Error("网址缺少 host");
	}
	if (parsed.username || parsed.password) {
		throw new Error("网址不能携带用户名或密码");
	}

	return parsed;
}

type StructuredSearchItem = {
	title: string;
	url: string;
	snippet: string;
	summary: string;
	siteName: string | null;
	siteIcon: string | null;
	date: string | null;
	authority: number | null;
	rerankScore: number | null;
	content?: string;
}

function toStructuredItem(item: SearchResultItem, includeContent: boolean): StructuredSearchItem {
	return {
		title: item.title,
		url: item.url,
		snippet: item.snippet,
		summary: item.summary,
		siteName: item.siteName,
		siteIcon: item.siteIcon,
		date: item.date,
		authority: item.authority,
		rerankScore: item.rerankScore,
		...(includeContent && item.content ? { content: item.content } : {}),
	};
}

export function createSearchTool(state: ExtensionState, exposure: ToolExposureMode = "codemode") {
	return defineTool({
		name: "ds_search",
		label: "DeepSeek 搜索",
		exposure,
		description:
			"用 DeepSeek 网页搜索检索最新外部信息，返回标题、URL、摘要与发布时间。需要读整页时对结果 URL 再用 ds_fetch。输出超过 2000 行或 50KB 时会截断，完整结果写入临时文件。",
		promptSnippet: "ds_search: 用 DeepSeek 搜索网页，返回标题、URL 与摘要",
		promptGuidelines: [
			"需要最新外部信息、新闻或文档时用 ds_search，不要靠记忆回答时效性问题。",
			"ds_search 支持 site:、after:、before:、引号等搜索语法，可以把限定条件直接写进 query。",
			"只有确实需要网页全文时才把 needContent 设为 true，否则先用摘要判断，再对目标 URL 调 ds_fetch。",
		],
		parameters: searchParameters,
		outputSchema: searchOutputSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },

		async execute(_toolCallId, params, signal) {
			const { client, config } = requireClient(state);
			const count = params.count ?? config.search.count;
			const needContent = params.needContent ?? config.search.needContent;

			const response = await client.search(
				{ query: params.query, count, needContent },
				{ signal, timeoutMs: config.search.timeoutMs },
			);

			const text = formatSearchResults({
				query: params.query,
				results: response.results,
				includeContent: needContent,
			});
			const fullText = JSON.stringify({ query: params.query, count: count ?? 0, results: response.results }, null, 2);
			const truncated = await truncateWithTempFile(text, {
				prefix: "pi-ds-search-",
				fileName: "results.json",
				fullText,
			});

			const details: SearchDetails = {
				query: params.query,
				endpoint: `${config.baseUrl}/v1/tools/search`,
				count: count ?? 0,
				resultCount: response.results.length,
				...(truncated.truncated
					? { truncation: truncated.truncation, fullOutputPath: truncated.fullOutputPath }
					: {}),
			};

			return {
				content: [{ type: "text" as const, text: truncated.content }],
				details,
				structuredContent: {
					query: params.query,
					count: count ?? 0,
					resultCount: response.results.length,
					results: response.results.map((item) => toStructuredItem(item, needContent)),
				},
			};
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ds_search"))} ${theme.fg("accent", `"${args.query}"`)}` +
					(args.count ? theme.fg("dim", ` count=${args.count}`) : ""),
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "搜索中…"), 0, 0);

			const details = result.details as SearchDetails | undefined;
			if (!details) return new Text(textOfContent(result.content), 0, 0);
			if (details.resultCount === 0) return new Text(theme.fg("dim", "没有搜索结果"), 0, 0);

			let text = theme.fg("success", `${details.resultCount} 条结果`);
			if (details.truncation?.truncated) text += theme.fg("warning", "（已截断）");

			if (expanded) {
				// 展开时显示工具返回的全部文本；超过 2000 行 / 50KB 的那部分已经截断，
				// 正文末尾的说明里带着完整结果的临时文件路径。
				text += `\n${theme.fg("text", textOfContent(result.content))}`;
			}

			return new Text(text, 0, 0);
		},
	});
}

export function createFetchTool(state: ExtensionState, exposure: ToolExposureMode = "codemode") {
	return defineTool({
		name: "ds_fetch",
		label: "DeepSeek 抓取",
		exposure,
		description:
			"抓取单个 URL 并返回标题与 Markdown 正文。GitHub 链接会自动走专用路径：仓库克隆到本地并给出路径与目录树，PR/Issue 用 gh 渲染成结构化文档；其余地址走 DeepSeek Fetch。正文超过 2000 行或 50KB 时会截断，完整内容写入临时文件。",
		promptSnippet: "ds_fetch: 抓取网页正文；GitHub 链接自动 clone 或渲染 PR/Issue",
		promptGuidelines: [
			"拿到具体 URL 后需要整页内容时用 ds_fetch，不要用 curl 或 read 去读网页。",
			"ds_fetch 遇到 github.com 链接会克隆仓库或渲染 PR/Issue，返回本地路径供 read/bash 继续翻源码，不需要再手动 git clone。",
			"ds_fetch 只接受 http/https 地址，不能读本地文件；抓取失败时换个来源或改用 ds_search。",
		],
		parameters: fetchParameters,
		outputSchema: fetchOutputSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },

		async execute(_toolCallId, params, signal) {
			const url = validateFetchUrl(params.url).toString();

			// GitHub 链接先走专用路径：clone 仓库或 gh 渲染 PR/Issue，不消耗 DeepSeek 额度。
			// 拿不到内容时（不是仓库 URL、gh 不可用、clone 失败）再回落到 DeepSeek Fetch。
			const activeConfig = state.config;
			// codemode 暴露的工具注册即可调用，active set 只决定“是否声明给模型”，挡不住脚本调用。
			// 所以硬禁用必须在这里挡，否则 codemode 脚本仍能触发 clone/gh。
			if (activeConfig?.reason === "explicitly-disabled") {
				throw new Error(notEnabledMessage(activeConfig));
			}
			if (activeConfig?.github.enabled) {
				const github = await extractGitHubUrl(url, activeConfig.github, signal);
				if (github) {
					return await buildFetchResult({
						url,
						title: github.title,
						content: github.content,
						source: github.source ?? "clone",
					});
				}
			}

			const { client, config } = requireClient(state);

			const page = await client.fetchPage({ url }, { signal, timeoutMs: config.fetch.timeoutMs });
			// DeepSeek Fetch 返回的是「标点全转义」的 Markdown，先去转义再用
			const content = unescapeMarkdown(page.content);

			return await buildFetchResult({ url, title: page.title, content, source: "deepseek" });
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ds_fetch"))} ${theme.fg("accent", args.url)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "抓取中…"), 0, 0);

			const details = result.details as FetchDetails | undefined;
			if (!details) return new Text(textOfContent(result.content), 0, 0);

			let text = theme.fg("success", `${details.contentLength} 字符`);
			if (details.truncation?.truncated) text += theme.fg("warning", "（已截断）");
			if (details.source !== "deepseek") text += theme.fg("dim", ` · ${SOURCE_LABELS[details.source]}`);
			if (details.title) text += theme.fg("muted", ` · ${details.title}`);

			if (!expanded) return new Text(text, 0, 0);

			// 展开时把正文按 Markdown 渲染；超限部分已经在正文末尾给出临时文件路径。
			const container = new Container();
			container.addChild(new Text(text, 0, 0));
			container.addChild(
				new Markdown(
					textOfContent(result.content),
					0,
					0,
					markdownThemeFrom(theme),
					{ color: (part) => theme.fg("toolOutput", part) },
					// 网页正文里的 $...$、\(...\) 不应被当成公式
					{ renderLatex: false },
				),
			);

			return container;
		},
	});
}
