import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DeepSeekWebClient, SearchResultItem } from "../src/client";
import { registerCommands } from "../src/commands";
import type { ResolvedConfig } from "../src/config";
import type { ExtensionState } from "../src/state";

type CommandHandler = (args: string, ctx: any) => Promise<void>;

interface FakeHarness {
	commands: Map<string, { description?: string; handler: CommandHandler }>;
	entryRenderers: Map<string, (...args: any[]) => any>;
	entries: Array<{ customType: string; data: any }>;
	sendMessage: ReturnType<typeof vi.fn>;
}

function createFakePi(): { pi: any; fake: FakeHarness } {
	const fake: FakeHarness = {
		commands: new Map(),
		entryRenderers: new Map(),
		entries: [],
		sendMessage: vi.fn(),
	};
	const pi = {
		registerCommand: (name: string, options: { description?: string; handler: CommandHandler }) => {
			fake.commands.set(name, options);
		},
		registerEntryRenderer: (customType: string, renderer: (...args: any[]) => any) => {
			fake.entryRenderers.set(customType, renderer);
		},
		appendEntry: (customType: string, data: unknown) => {
			fake.entries.push({ customType, data });
		},
		sendMessage: fake.sendMessage,
	};
	return { pi, fake };
}

function createCtx(): { ctx: any; notify: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	return { ctx: { ui: { notify }, hasUI: true, signal: undefined }, notify };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		enabled: true,
		reason: "ok",
		apiKey: "sk-test-1234abcd",
		apiKeySource: "project",
		baseUrl: "https://api.deepseek.com",
		search: { timeoutMs: 30_000, count: 10, needContent: false },
		fetch: { timeoutMs: 90_000 },
		projectFile: { path: "/tmp/project.json", status: "ok" },
		userFile: { path: "/tmp/user.json", status: "missing" },
		warnings: [],
		...overrides,
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

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
};

function setup(
	state: ExtensionState,
	deps: Parameters<typeof registerCommands>[2] = {},
): { fake: FakeHarness; handler: (name: string) => CommandHandler; renderer: (type: string) => (...args: any[]) => any } {
	const { pi, fake } = createFakePi();
	registerCommands(pi, state, deps);
	return {
		fake,
		handler: (name: string) => {
			const command = fake.commands.get(name);
			if (!command) throw new Error(`未注册命令 /${name}`);
			return command.handler;
		},
		renderer: (type: string) => {
			const found = fake.entryRenderers.get(type);
			if (!found) throw new Error(`未注册 entry renderer ${type}`);
			return found;
		},
	};
}

describe("/search", () => {
	it("没有参数时提示用法", async () => {
		const { fake, handler } = setup({ config: makeConfig() });
		const { ctx, notify } = createCtx();

		await handler("search")("   ", ctx);

		expect(notify).toHaveBeenCalledWith("用法：/search <搜索词>", "warning");
		expect(fake.entries).toHaveLength(0);
	});

	it("未启用时提示如何配置", async () => {
		const { fake, handler } = setup({ config: makeConfig({ enabled: false, reason: "missing-key", apiKey: undefined }) });
		const { ctx, notify } = createCtx();

		await handler("search")("DeepSeek", ctx);

		expect(String(notify.mock.calls[0]?.[0])).toContain("缺少 API key");
		expect(fake.entries).toHaveLength(0);
	});

	it("正常搜索时写入 custom entry 而不是消息上下文", async () => {
		const client = { search: vi.fn(async () => ({ results: [makeItem()] })) };
		const { fake, handler } = setup({
			config: makeConfig(),
			client: client as unknown as DeepSeekWebClient,
		});
		const { ctx, notify } = createCtx();

		await handler("search")("DeepSeek", ctx);

		expect(client.search).toHaveBeenCalledWith(
			{ query: "DeepSeek", count: 10, needContent: false },
			{ signal: undefined, timeoutMs: 30_000 },
		);
		expect(notify).not.toHaveBeenCalled();
		expect(fake.sendMessage).not.toHaveBeenCalled();
		expect(fake.entries).toHaveLength(1);
		expect(fake.entries[0]?.customType).toBe("ds-search");
		expect(fake.entries[0]?.data.text).toContain("DeepSeek V4 模型发布");
		expect(fake.entries[0]?.data.resultCount).toBe(1);
	});

	it("API 报错时通知错误且不抛出", async () => {
		const client = { search: vi.fn(async () => Promise.reject(new Error("DeepSeek 搜索失败（HTTP 401）"))) };
		const { fake, handler } = setup({
			config: makeConfig(),
			client: client as unknown as DeepSeekWebClient,
		});
		const { ctx, notify } = createCtx();

		await expect(handler("search")("DeepSeek", ctx)).resolves.toBeUndefined();

		expect(notify).toHaveBeenCalledWith("DeepSeek 搜索失败（HTTP 401）", "error");
		expect(fake.entries).toHaveLength(0);
	});

	it("空结果也写入 entry", async () => {
		const client = { search: vi.fn(async () => ({ results: [] })) };
		const { fake, handler } = setup({
			config: makeConfig(),
			client: client as unknown as DeepSeekWebClient,
		});
		const { ctx } = createCtx();

		await handler("search")("查不到", ctx);

		expect(fake.entries[0]?.data.text).toContain("没有搜索到结果");
	});
});

describe("/fetch", () => {
	it("没有参数时提示用法", async () => {
		const { fake, handler } = setup({ config: makeConfig() });
		const { ctx, notify } = createCtx();

		await handler("fetch")("", ctx);

		expect(notify).toHaveBeenCalledWith("用法：/fetch <网址>", "warning");
		expect(fake.entries).toHaveLength(0);
	});

	it("去掉尖括号后抓取，写入 custom entry", async () => {
		const client = { fetchPage: vi.fn(async () => ({ title: "Example", content: "# Hello" })) };
		const { fake, handler } = setup({
			config: makeConfig(),
			client: client as unknown as DeepSeekWebClient,
		});
		const { ctx } = createCtx();

		await handler("fetch")("<https://example.com/a>", ctx);

		expect(client.fetchPage).toHaveBeenCalledWith(
			{ url: "https://example.com/a" },
			{ signal: undefined, timeoutMs: 90_000 },
		);
		expect(fake.sendMessage).not.toHaveBeenCalled();
		expect(fake.entries[0]?.customType).toBe("ds-fetch");
		expect(fake.entries[0]?.data.text).toContain("# Hello");
	});

	it("超长正文截断并落临时文件", async () => {
		const client = { fetchPage: vi.fn(async () => ({ title: "Big", content: "段落。".repeat(30_000) })) };
		const { fake, handler } = setup({
			config: makeConfig(),
			client: client as unknown as DeepSeekWebClient,
		});
		const { ctx } = createCtx();

		await handler("fetch")("https://example.com/big", ctx);

		const data = fake.entries[0]?.data;
		expect(data.truncated).toBe(true);
		expect(data.fullOutputPath).toBeTruthy();
		expect(existsSync(data.fullOutputPath)).toBe(true);
		expect(readFileSync(data.fullOutputPath, "utf8")).toContain("段落。");
	});

	it("非法 URL 只通知错误", async () => {
		const client = { fetchPage: vi.fn() };
		const { fake, handler } = setup({
			config: makeConfig(),
			client: client as unknown as DeepSeekWebClient,
		});
		const { ctx, notify } = createCtx();

		await handler("fetch")("ftp://example.com/a", ctx);

		expect(String(notify.mock.calls[0]?.[0])).toContain("只支持 HTTP/HTTPS");
		expect(client.fetchPage).not.toHaveBeenCalled();
		expect(fake.entries).toHaveLength(0);
	});
});

describe("/ds-tool-config", () => {
	it("展示启用状态、来源与脱敏 key", async () => {
		const { handler } = setup({ config: makeConfig({ warnings: ["用户配置存在未知配置项 serach，已忽略"] }) });
		const { ctx, notify } = createCtx();

		await handler("ds-tool-config")("", ctx);

		const text = String(notify.mock.calls[0]?.[0]);
		expect(text).toContain("DeepSeek 网络工具：已启用");
		expect(text).toContain("来源：project");
		expect(text).toContain("sk-****abcd");
		expect(text).not.toContain("sk-test-1234abcd");
		expect(text).toContain("serach");
	});

	it("未初始化时提示 reload", async () => {
		const { handler } = setup({});
		const { ctx, notify } = createCtx();

		await handler("ds-tool-config")("", ctx);

		expect(String(notify.mock.calls[0]?.[0])).toContain("/reload");
	});
});

describe("entry 渲染器", () => {
	function searchEntry(text: string) {
		return {
			type: "custom",
			customType: "ds-search",
			data: { query: "DeepSeek", resultCount: 2, text, truncated: false },
		};
	}

	function fetchEntry(text: string) {
		return {
			type: "custom",
			customType: "ds-fetch",
			data: { url: "https://example.com/a", title: "标题", contentLength: 100, text, truncated: false },
		};
	}

	it("ds-search 折叠显示前几行，展开显示完整内容", () => {
		const { renderer } = setup({ config: makeConfig() });
		const render = renderer("ds-search");
		const text = Array.from({ length: 60 }, (_value, index) => `第 ${index} 行`).join("\n");

		const collapsed = render(searchEntry(text), { expanded: false }, theme).render(200).join("\n");
		expect(collapsed).toContain("还有");
		expect(collapsed).not.toContain("第 59 行");

		const expanded = render(searchEntry(text), { expanded: true }, theme).render(200).join("\n");
		expect(expanded).toContain("第 59 行");
	});

	it("ds-fetch 按 Markdown 渲染并支持展开", () => {
		const { renderer } = setup({ config: makeConfig() });
		const render = renderer("ds-fetch");
		const text = `# 标题\n\nhttps://example.com/a\n\n${Array.from({ length: 40 }, (_value, index) => `段落 ${index}`).join("\n\n")}`;

		const collapsed = render(fetchEntry(text), { expanded: false }, theme).render(200).join("\n");
		expect(collapsed).toContain("还有");
		expect(collapsed).not.toContain("段落 39");

		const expanded = render(fetchEntry(text), { expanded: true }, theme).render(200).join("\n");
		expect(expanded).toContain("段落 39");
	});

	it("点击消息切换展开状态", () => {
		const setToolsExpanded = vi.fn();
		const ui = { getToolsExpanded: () => false, setToolsExpanded };
		const { renderer } = setup({ config: makeConfig() }, { getUi: () => ui as any });
		const component = renderer("ds-search")(searchEntry("第 0 行\n第 1 行"), { expanded: false }, theme);

		const result = component.handleMouse({
			type: "click",
			button: "left",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 80,
			height: 10,
			shift: false,
			alt: false,
			ctrl: false,
		});

		expect(result?.handled).toBe(true);
		expect(setToolsExpanded).toHaveBeenCalledWith(true);
	});

	it("没有 UI 上下文时点击安全跳过", () => {
		const { renderer } = setup({ config: makeConfig() });
		const component = renderer("ds-search")(searchEntry("内容"), { expanded: false }, theme);

		const result = component.handleMouse({
			type: "click",
			button: "left",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 80,
			height: 10,
			shift: false,
			alt: false,
			ctrl: false,
		});

		expect(result).toBeUndefined();
	});
});
