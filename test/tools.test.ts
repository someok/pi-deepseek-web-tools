import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DeepSeekWebClient, SearchResultItem } from "../src/client";
import type { ResolvedConfig } from "../src/config";
import type { ExtensionState } from "../src/state";
import { createFetchTool, createSearchTool, validateFetchUrl } from "../src/tools";

const extractGitHubUrlMock = vi.hoisted(() => vi.fn());
vi.mock("../src/github", () => ({ extractGitHubUrl: extractGitHubUrlMock }));

type AnyTool = { execute: (...args: unknown[]) => Promise<any> };

function run(tool: unknown, params: unknown): Promise<any> {
	return (tool as AnyTool).execute("call-1", params, undefined, undefined, undefined);
}

function makeConfig(overrides: { search?: Partial<ResolvedConfig["search"]>; fetch?: Partial<ResolvedConfig["fetch"]> } = {}): ResolvedConfig {
	return {
		enabled: true,
		reason: "ok",
		exposure: { search: "direct", fetch: "direct" },
		apiKey: "sk-test",
		apiKeySource: "env",
		baseUrl: "https://api.deepseek.com",
		search: { timeoutMs: 30_000, needContent: false, ...overrides.search },
		fetch: { timeoutMs: 90_000, ...overrides.fetch },
		github: {
			enabled: false,
			maxRepoSizeMB: 350,
			cloneTimeoutSeconds: 30,
			clonePath: "/tmp/pi-github-repos",
			prIssue: true,
		},
		projectFile: { path: "/tmp/project.json", status: "missing" },
		userFile: { path: "/tmp/user.json", status: "missing" },
		warnings: [],
	};
}

function makeItem(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
	return {
		title: "DeepSeek V4 模型发布",
		url: "https://example.com/v4",
		snippet: "短摘要",
		summary: "长摘要内容",
		content: "",
		siteName: "Example News",
		siteIcon: null,
		date: "2026-06-01T00:00:00+00:00",
		authority: 3,
		rerankScore: 2.4,
		...overrides,
	};
}

function stateWith(client: Record<string, unknown>, config: ResolvedConfig = makeConfig()): ExtensionState {
	return { config, client: client as unknown as DeepSeekWebClient };
}

function errorOf(promise: Promise<unknown>): Promise<Error> {
	return promise.then(
		() => {
			throw new Error("预期抛错，但调用成功了");
		},
		(error: unknown) => error as Error,
	);
}

describe("ds_search", () => {
	it("把结果格式化成编号列表", async () => {
		const client = { search: vi.fn(async () => ({ results: [makeItem()] })) };

		const result = await run(createSearchTool(stateWith(client)), { query: "DeepSeek" });

		const text = result.content[0].text as string;
		expect(text).toContain("找到 1 条结果：query=\"DeepSeek\"");
		expect(text).toContain("1. DeepSeek V4 模型发布");
		expect(text).toContain("https://example.com/v4");
		expect(text).toContain("站点：Example News ｜ 发布：2026-06-01");
		expect(text).toContain("长摘要内容");

		expect(result.structuredContent.resultCount).toBe(1);
		expect(result.structuredContent.results[0]).toMatchObject({
			title: "DeepSeek V4 模型发布",
			url: "https://example.com/v4",
			siteName: "Example News",
		});
		expect(result.details.resultCount).toBe(1);
		expect(result.details.endpoint).toContain("/v1/tools/search");
	});

	it("没有结果时给出换关键词的提示", async () => {
		const client = { search: vi.fn(async () => ({ results: [] })) };

		const result = await run(createSearchTool(stateWith(client)), { query: "查不到的东西" });

		expect(result.content[0].text).toContain("没有搜索到结果");
		expect(result.details.resultCount).toBe(0);
	});

	it("把配置里的 count 与 needContent 传给 client", async () => {
		const client = { search: vi.fn(async () => ({ results: [] })) };
		const config = makeConfig({ search: { count: 7, needContent: true } });

		await run(createSearchTool(stateWith(client, config)), { query: "DeepSeek" });

		expect(client.search).toHaveBeenCalledWith(
			{ query: "DeepSeek", count: 7, needContent: true },
			{ signal: undefined, timeoutMs: 30_000 },
		);
	});

	it("参数优先于配置", async () => {
		const client = { search: vi.fn(async () => ({ results: [] })) };
		const config = makeConfig({ search: { count: 7, needContent: true } });

		await run(createSearchTool(stateWith(client, config)), { query: "DeepSeek", count: 2, needContent: false });

		expect(client.search).toHaveBeenCalledWith(
			{ query: "DeepSeek", count: 2, needContent: false },
			{ signal: undefined, timeoutMs: 30_000 },
		);
	});

	it("needContent 为 true 时正文进入文本与 structuredContent", async () => {
		const client = { search: vi.fn(async () => ({ results: [makeItem({ content: "网页正文" })] })) };

		const result = await run(createSearchTool(stateWith(client)), { query: "DeepSeek", needContent: true });

		expect(result.content[0].text).toContain("正文：网页正文");
		expect(result.structuredContent.results[0].content).toBe("网页正文");
	});

	it("结果过大时截断并写入临时文件", async () => {
		const longSummary = "这是一段很长的摘要。".repeat(40);
		const results = Array.from({ length: 200 }, (_value, index) =>
			makeItem({ title: `结果 ${index}`, url: `https://example.com/${index}`, summary: longSummary }),
		);
		const client = { search: vi.fn(async () => ({ results })) };

		const result = await run(createSearchTool(stateWith(client)), { query: "DeepSeek" });

		expect(result.content[0].text).toContain("输出已截断");
		expect(result.details.truncation.truncated).toBe(true);
		expect(result.details.fullOutputPath).toBeTruthy();

		const full = readFileSync(result.details.fullOutputPath, "utf8");
		expect(full).toContain("\"results\"");
		expect(JSON.parse(full).results).toHaveLength(200);
	});

	it("未启用时抛出可读错误", async () => {
		const state: ExtensionState = { config: makeConfig({ search: {} }) };
		state.config = { ...state.config!, enabled: false, reason: "missing-key" };

		const error = await errorOf(run(createSearchTool(state), { query: "x" }));

		expect(error.message).toContain("未启用");
	});
});

describe("ds_fetch", () => {
	it("返回标题、URL 与正文", async () => {
		const client = { fetchPage: vi.fn(async () => ({ title: "Example", content: "# Hello\n\n正文" })) };

		const result = await run(createFetchTool(stateWith(client)), { url: "https://example.com/a" });

		const text = result.content[0].text as string;
		expect(text).toContain("# Example");
		expect(text).toContain("https://example.com/a");
		expect(text).toContain("# Hello");
		expect(result.structuredContent).toMatchObject({
			url: "https://example.com/a",
			title: "Example",
			truncated: false,
		});
		expect(result.details.contentLength).toBe("# Hello\n\n正文".length);
	});

	it.each([
		["ftp://example.com/a", "只支持 HTTP/HTTPS"],
		["https://user:pass@example.com/a", "不能携带用户名或密码"],
		[`https://example.com/${"a".repeat(9000)}`, "网址过长"],
		["not a url", "不是合法的网址"],
	])('拒绝非法 URL：%s', async (url, message) => {
		const client = { fetchPage: vi.fn() };

		const error = await errorOf(run(createFetchTool(stateWith(client)), { url }));

		expect(error.message).toContain(message);
		expect(client.fetchPage).not.toHaveBeenCalled();
	});

	it("把接口返回的转义标点还原后再展示", async () => {
		const client = {
			fetchPage: vi.fn(async () => ({ title: "T", content: "\\# 标题\n\n\\- 列表" })),
		};

		const result = await run(createFetchTool(stateWith(client)), { url: "https://example.com/a" });

		expect(result.structuredContent.content).toBe("# 标题\n\n- 列表");
		expect(result.content[0].text).toContain("# 标题");
		expect(result.content[0].text).not.toContain("\\#");
	});

	it("正文为空时抛错", async () => {
		const client = { fetchPage: vi.fn(async () => ({ title: "", content: "   " })) };

		const error = await errorOf(run(createFetchTool(stateWith(client)), { url: "https://example.com/a" }));

		expect(error.message).toContain("抓取成功但没有正文");
	});

	it("正文过大时截断并写入临时文件", async () => {
		const client = { fetchPage: vi.fn(async () => ({ title: "Big", content: "段落内容。".repeat(20_000) })) };

		const result = await run(createFetchTool(stateWith(client)), { url: "https://example.com/big" });

		expect(result.content[0].text).toContain("输出已截断");
		expect(result.structuredContent.truncated).toBe(true);
		expect(readFileSync(result.structuredContent.fullOutputPath, "utf8")).toContain("段落内容");
	});

	it("把 fetch.timeoutMs 传给 client", async () => {
		const client = { fetchPage: vi.fn(async () => ({ title: "T", content: "body" })) };
		const config = makeConfig({ fetch: { timeoutMs: 12345 } });

		await run(createFetchTool(stateWith(client, config)), { url: "https://example.com/a" });

		expect(client.fetchPage).toHaveBeenCalledWith(
			{ url: "https://example.com/a" },
			{ signal: undefined, timeoutMs: 12345 },
		);
	});
});

describe("渲染", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
	};

	it("ds_search 展开时渲染完整文本，不只前几十行", () => {
		const lines = Array.from({ length: 120 }, (_value, index) => `第 ${index} 行`);
		const tool = createSearchTool(stateWith({ search: vi.fn() }));
		const result = {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { query: "q", endpoint: "", count: 0, resultCount: 120 },
		};

		const rendered = (tool as any)
			.renderResult(result, { expanded: true, isPartial: false }, theme)
			.render(200)
			.join("\n");

		expect(rendered).toContain("第 0 行");
		expect(rendered).toContain("第 119 行");
	});

	it("ds_fetch 展开时渲染完整正文", () => {
		const lines = Array.from({ length: 80 }, (_value, index) => `段落 ${index}`);
		const tool = createFetchTool(stateWith({ fetchPage: vi.fn() }));
		const result = {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { url: "https://example.com/a", title: "T", contentLength: 100 },
		};

		const rendered = (tool as any)
			.renderResult(result, { expanded: true, isPartial: false }, theme)
			.render(200)
			.join("\n");

		expect(rendered).toContain("段落 79");
	});

	it("ds_search 折叠时只显示结果数量", () => {
		const tool = createSearchTool(stateWith({ search: vi.fn() }));
		const result = {
			content: [{ type: "text", text: "正文内容" }],
			details: { query: "q", endpoint: "", count: 0, resultCount: 3 },
		};

		const rendered = (tool as any)
			.renderResult(result, { expanded: false, isPartial: false }, theme)
			.render(200)
			.join("\n");

		expect(rendered).toContain("3 条结果");
		expect(rendered).not.toContain("正文内容");
	});
});

describe("ds_fetch 硬禁用", () => {
	it("enabled: false 时连 GitHub 分支也不执行", async () => {
		extractGitHubUrlMock.mockReset();
		extractGitHubUrlMock.mockResolvedValue({ title: "t", content: "c", source: "clone" });
		// codemode 暴露下工具注册即可调用，active set 挡不住脚本；硬禁用必须在 execute 里挡
		const config: ResolvedConfig = { ...makeConfig(), enabled: false, reason: "explicitly-disabled" };
		config.github = { ...config.github, enabled: true };
		const tool = createFetchTool({ config });

		await expect(run(tool, { url: "https://github.com/o/r" })).rejects.toThrow("已被配置禁用");
		expect(extractGitHubUrlMock).not.toHaveBeenCalled();
	});
});

describe("validateFetchUrl", () => {
	it("去掉首尾空白并返回 URL", () => {
		expect(validateFetchUrl(" https://example.com/a ").toString()).toBe("https://example.com/a");
	});

	it("保留查询参数与路径", () => {
		expect(validateFetchUrl("https://example.com/a?b=1#c").search).toBe("?b=1");
	});
});
