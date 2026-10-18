import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import deepseekWebTools from "../src/index";

type Handler = (event: unknown, ctx: any) => Promise<void> | void;

interface FakeHarness {
	pi: any;
	tools: string[];
	commands: string[];
	handlers: Map<string, Handler>;
	active: () => string[];
	setActiveTools: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
}

function createHarness(): FakeHarness {
	const tools: string[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, Handler>();
	let active: string[] = [];
	const notify = vi.fn();
	const setActiveTools = vi.fn((names: string[]) => {
		active = [...names];
	});

	const pi = {
		registerTool: (tool: { name: string }) => {
			tools.push(tool.name);
			active.push(tool.name);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => {};
		},
		getActiveTools: () => [...active],
		setActiveTools,
	};

	return { pi, tools, commands, handlers, active: () => active, setActiveTools, notify };
}

async function tempDirs(): Promise<{ cwd: string; agentDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-ds-ext-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	return { cwd, agentDir };
}

function sessionCtx(harness: FakeHarness, cwd: string, trusted = true): any {
	return {
		cwd,
		hasUI: true,
		ui: { notify: harness.notify },
		isProjectTrusted: () => trusted,
	};
}

const originalEnv = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in originalEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
});

describe("扩展装配", () => {
	it("注册两个工具与三个命令", async () => {
		const { agentDir, cwd } = await tempDirs();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.DEEPSEEK_API_KEY;
		const harness = createHarness();

		deepseekWebTools(harness.pi);

		expect(harness.tools).toEqual(["ds_search", "ds_fetch"]);
		expect(harness.commands).toEqual(["search", "ds-search", "fetch", "ds-fetch", "ds-web"]);
		expect(harness.handlers.has("session_start")).toBe(true);

		await harness.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, sessionCtx(harness, cwd));
	});

	it("用户级配置有 key 时保持工具激活且不提示", async () => {
		const { agentDir, cwd } = await tempDirs();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.DEEPSEEK_API_KEY;
		await writeFile(join(agentDir, "deepseek-web-tools.json"), JSON.stringify({ apiKey: "sk-user" }), "utf8");
		const harness = createHarness();

		deepseekWebTools(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, sessionCtx(harness, cwd));

		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.active()).toEqual(["ds_search", "ds_fetch"]);
	});

	it("没有 key 时停用工具并提示一次", async () => {
		const { agentDir, cwd } = await tempDirs();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.DEEPSEEK_API_KEY;
		const harness = createHarness();

		deepseekWebTools(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, sessionCtx(harness, cwd));

		expect(harness.active()).toEqual([]);
		expect(harness.setActiveTools).toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(String(harness.notify.mock.calls[0]?.[0])).toContain("缺少 API key");
	});

	it("项目级 enabled: false 覆盖环境变量且不提示", async () => {
		const { agentDir, cwd } = await tempDirs();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.DEEPSEEK_API_KEY = "sk-env";
		await writeFile(
			join(cwd, ".pi", "deepseek-web-tools.json"),
			JSON.stringify({ enabled: false }),
			"utf8",
		);
		const harness = createHarness();

		deepseekWebTools(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, sessionCtx(harness, cwd));

		expect(harness.active()).toEqual([]);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("项目未受信任时忽略项目级 key", async () => {
		const { agentDir, cwd } = await tempDirs();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.DEEPSEEK_API_KEY;
		await writeFile(
			join(cwd, ".pi", "deepseek-web-tools.json"),
			JSON.stringify({ apiKey: "sk-project" }),
			"utf8",
		);
		const harness = createHarness();

		deepseekWebTools(harness.pi);
		await harness.handlers.get("session_start")!(
			{ type: "session_start", reason: "startup" },
			sessionCtx(harness, cwd, false),
		);

		expect(harness.active()).toEqual([]);
		expect(String(harness.notify.mock.calls[0]?.[0])).toContain("缺少 API key");
	});
});
