import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_BASE_URL,
	DEFAULT_FETCH_TIMEOUT_MS,
	DEFAULT_SEARCH_TIMEOUT_MS,
	maskApiKey,
	resolveConfig,
	type ResolveConfigInput,
} from "../src/config";

interface SetupOptions {
	project?: unknown;
	user?: unknown;
	projectRaw?: string;
	userRaw?: string;
	env?: Record<string, string | undefined>;
	trusted?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<ResolveConfigInput> {
	const root = await mkdtemp(join(tmpdir(), "pi-ds-config-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });

	const projectPath = join(cwd, ".pi", "deepseek-web-tools.json");
	const userPath = join(agentDir, "deepseek-web-tools.json");

	if (options.projectRaw !== undefined) await writeFile(projectPath, options.projectRaw, "utf8");
	else if (options.project !== undefined) await writeFile(projectPath, JSON.stringify(options.project), "utf8");

	if (options.userRaw !== undefined) await writeFile(userPath, options.userRaw, "utf8");
	else if (options.user !== undefined) await writeFile(userPath, JSON.stringify(options.user), "utf8");

	return {
		cwd,
		agentDir,
		env: options.env ?? {},
		projectTrusted: options.trusted ?? true,
	};
}

describe("resolveConfig", () => {
	it("没有配置也没有环境变量时未启用", async () => {
		const config = resolveConfig(await setup());

		expect(config.enabled).toBe(false);
		expect(config.reason).toBe("missing-key");
		expect(config.apiKey).toBeUndefined();
		expect(config.apiKeySource).toBeUndefined();
		expect(config.projectFile.status).toBe("missing");
		expect(config.userFile.status).toBe("missing");
		expect(config.warnings).toEqual([]);
	});

	it("只有环境变量 key 时启用，来源 env", async () => {
		const config = resolveConfig(await setup({ env: { DEEPSEEK_API_KEY: "sk-env" } }));

		expect(config.enabled).toBe(true);
		expect(config.reason).toBe("ok");
		expect(config.apiKey).toBe("sk-env");
		expect(config.apiKeySource).toBe("env");
	});

	it("用户级 key 优先于环境变量", async () => {
		const config = resolveConfig(
			await setup({ user: { apiKey: "sk-user" }, env: { DEEPSEEK_API_KEY: "sk-env" } }),
		);

		expect(config.apiKey).toBe("sk-user");
		expect(config.apiKeySource).toBe("user");
	});

	it("项目级 key 优先于用户级与环境变量", async () => {
		const config = resolveConfig(
			await setup({
				project: { apiKey: "sk-project" },
				user: { apiKey: "sk-user" },
				env: { DEEPSEEK_API_KEY: "sk-env" },
			}),
		);

		expect(config.apiKey).toBe("sk-project");
		expect(config.apiKeySource).toBe("project");
		expect(config.enabled).toBe(true);
	});

	it("项目级 enabled: false 压过环境变量 key", async () => {
		const config = resolveConfig(
			await setup({ project: { enabled: false }, env: { DEEPSEEK_API_KEY: "sk-env" } }),
		);

		expect(config.enabled).toBe(false);
		expect(config.reason).toBe("explicitly-disabled");
	});

	it("enabled: true 但没有 key 视为未配置", async () => {
		const config = resolveConfig(await setup({ project: { enabled: true } }));

		expect(config.enabled).toBe(false);
		expect(config.reason).toBe("missing-key");
	});

	it("项目有 key、用户级 enabled: false 时停用", async () => {
		const config = resolveConfig(await setup({ project: { apiKey: "sk-project" }, user: { enabled: false } }));

		expect(config.enabled).toBe(false);
		expect(config.reason).toBe("explicitly-disabled");
	});

	it("项目未受信任时跳过项目级配置", async () => {
		const config = resolveConfig(
			await setup({
				project: { apiKey: "sk-project" },
				user: { apiKey: "sk-user" },
				trusted: false,
			}),
		);

		expect(config.projectFile.status).toBe("untrusted");
		expect(config.apiKey).toBe("sk-user");
		expect(config.apiKeySource).toBe("user");
	});

	it("项目配置坏 JSON 时忽略该层并继续回退", async () => {
		const config = resolveConfig(
			await setup({
				projectRaw: "{ not json",
				user: { apiKey: "sk-user" },
			}),
		);

		expect(config.projectFile.status).toBe("invalid");
		expect(config.warnings.some((warning) => warning.includes("不是合法 JSON"))).toBe(true);
		expect(config.apiKey).toBe("sk-user");
		expect(config.enabled).toBe(true);
	});

	it("空白 apiKey 视为缺失", async () => {
		const config = resolveConfig(await setup({ project: { apiKey: "   " } }));

		expect(config.apiKey).toBeUndefined();
		expect(config.enabled).toBe(false);
		expect(config.reason).toBe("missing-key");
	});

	it("baseUrl 去掉尾部斜杠", async () => {
		const config = resolveConfig(await setup({ user: { apiKey: "sk-user", baseUrl: "https://proxy.local/" } }));

		expect(config.baseUrl).toBe("https://proxy.local");
	});

	it("非法 timeoutMs / count 回退默认值并记警告", async () => {
		const config = resolveConfig(
			await setup({
				user: {
					apiKey: "sk-user",
					search: { timeoutMs: "abc", count: 999 },
					fetch: { timeoutMs: -5 },
				},
			}),
		);

		expect(config.search.timeoutMs).toBe(DEFAULT_SEARCH_TIMEOUT_MS);
		expect(config.search.count).toBeUndefined();
		expect(config.fetch.timeoutMs).toBe(DEFAULT_FETCH_TIMEOUT_MS);
		expect(config.warnings.some((warning) => warning.includes("search.timeoutMs"))).toBe(true);
		expect(config.warnings.some((warning) => warning.includes("search.count"))).toBe(true);
		expect(config.warnings.some((warning) => warning.includes("fetch.timeoutMs"))).toBe(true);
	});

	it("配置文件路径来自 cwd 与 agentDir", async () => {
		const input = await setup();
		const config = resolveConfig(input);

		expect(config.projectFile.path).toBe(join(input.cwd, ".pi", "deepseek-web-tools.json"));
		expect(config.userFile.path).toBe(join(input.agentDir, "deepseek-web-tools.json"));
	});

	it("search 分组逐字段合并：项目写 count，用户写 needContent", async () => {
		const config = resolveConfig(
			await setup({
				project: { apiKey: "sk-project", search: { count: 3 } },
				user: { search: { needContent: true, timeoutMs: 45000 } },
			}),
		);

		expect(config.search.count).toBe(3);
		expect(config.search.needContent).toBe(true);
		expect(config.search.timeoutMs).toBe(45000);
	});

	it("同一字段项目优先，未写的字段回退用户级", async () => {
		const config = resolveConfig(
			await setup({
				project: { apiKey: "sk-project", fetch: { timeoutMs: 100_000 } },
				user: { search: { timeoutMs: 20000 }, fetch: { timeoutMs: 50000 } },
			}),
		);

		expect(config.fetch.timeoutMs).toBe(100_000);
		expect(config.search.timeoutMs).toBe(20000);
	});

	it("只配 search 时 fetch 全用默认值", async () => {
		const config = resolveConfig(
			await setup({ project: { apiKey: "sk-project", search: { count: 5, needContent: true } } }),
		);

		expect(config.search).toEqual({ timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS, count: 5, needContent: true });
		expect(config.fetch).toEqual({ timeoutMs: DEFAULT_FETCH_TIMEOUT_MS });
	});

	it("分组不是对象时按空处理并记警告", async () => {
		const config = resolveConfig(
			await setup({ user: { apiKey: "sk-user", search: 5 } }),
		);

		expect(config.search.count).toBeUndefined();
		expect(config.search.needContent).toBe(false);
		expect(config.warnings.some((warning) => warning.includes("search 必须是对象"))).toBe(true);
	});

	it("未知键被忽略并记警告", async () => {
		const config = resolveConfig(
			await setup({
				user: { apiKey: "sk-user", serach: { count: 1 }, search: { cout: 2 } },
			}),
		);

		expect(config.warnings.some((warning) => warning.includes("serach"))).toBe(true);
		expect(config.warnings.some((warning) => warning.includes("search.cout"))).toBe(true);
		expect(config.search.count).toBeUndefined();
	});

	it("enabled / apiKey 出现在 search 分组里按未知键处理", async () => {
		const config = resolveConfig(
			await setup({
				user: { search: { enabled: true, apiKey: "sk-inside" } },
			}),
		);

		expect(config.enabled).toBe(false);
		expect(config.apiKey).toBeUndefined();
		expect(config.warnings.some((warning) => warning.includes("search.enabled"))).toBe(true);
		expect(config.warnings.some((warning) => warning.includes("search.apiKey"))).toBe(true);
	});

	it("默认 baseUrl 使用官方地址", async () => {
		const config = resolveConfig(await setup({ user: { apiKey: "sk-user" } }));

		expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
	});

	it("未写 exposure 时搜索走 codemode、读取走 direct", async () => {
		const config = resolveConfig(await setup({ user: { apiKey: "sk-user" } }));

		expect(config.exposure).toEqual({ search: "codemode", fetch: "direct" });
	});

	it("exposure 写字符串时两个工具都用同一个值", async () => {
		const config = resolveConfig(await setup({ user: { apiKey: "sk-user", exposure: "direct" } }));

		expect(config.exposure).toEqual({ search: "direct", fetch: "direct" });
	});

	it("exposure 写对象时按工具单独配，项目级逐项压过用户级", async () => {
		const fromUser = resolveConfig(
			await setup({ user: { apiKey: "sk-user", exposure: { search: "direct", fetch: "codemode" } } }),
		);
		expect(fromUser.exposure).toEqual({ search: "direct", fetch: "codemode" });

		// 项目级只写 search，fetch 仍然用用户级的 codemode
		const mixed = resolveConfig(
			await setup({
				user: { apiKey: "sk-user", exposure: { search: "direct", fetch: "codemode" } },
				project: { exposure: { search: "codemode" } },
			}),
		);
		expect(mixed.exposure).toEqual({ search: "codemode", fetch: "codemode" });

		// 项目级没写的那个工具回退到默认值
		const partial = resolveConfig(
			await setup({ user: { apiKey: "sk-user", exposure: { search: "direct" } } }),
		);
		expect(partial.exposure).toEqual({ search: "direct", fetch: "direct" });
	});

	it("非法 exposure 回退默认值并记警告", async () => {
		const config = resolveConfig(await setup({ user: { apiKey: "sk-user", exposure: "deferred" } }));

		expect(config.exposure).toEqual({ search: "codemode", fetch: "direct" });
		expect(config.warnings.join("\n")).toContain("exposure");
	});

	it("exposure 对象里的非法值单独回退", async () => {
		const config = resolveConfig(
			await setup({ user: { apiKey: "sk-user", exposure: { search: "deferred", fetch: "codemode" } } }),
		);

		expect(config.exposure).toEqual({ search: "codemode", fetch: "codemode" });
		expect(config.warnings.join("\n")).toContain("exposure.search");
	});
});

describe("maskApiKey", () => {
	it("保留前缀与后 4 位", () => {
		expect(maskApiKey("sk-1234567890abcd")).toBe("sk-****abcd");
	});

	it("短 key 全部打码", () => {
		expect(maskApiKey("short")).toBe("****");
	});
});
