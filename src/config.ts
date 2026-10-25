import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 配置文件读取状态 */
export type FileStatus = "missing" | "ok" | "invalid" | "untrusted";

/** apiKey 来源 */
export type ApiKeySource = "project" | "user" | "env";

/**
 * 单个工具的暴露方式。
 * codemode：不声明给模型，只能从 codemode 脚本里通过 tools.ds_search / tools.ds_fetch 调用，
 * 原始返回不进 context，只留下脚本 return 的内容。
 * direct：工具直接声明给模型，模型可以自己调。
 */
export type ToolExposureMode = "direct" | "codemode";

/**
 * 每个工具各自的暴露方式。
 * 搜索默认 codemode：结果列表体积大（10 条约 10k tokens），模型通常只要几个链接。
 * 读取默认 direct：网页正文和图谱分支需要完整进 context，套一层脚本只会多一跳。
 */
export interface ToolExposureConfig {
	search: ToolExposureMode;
	fetch: ToolExposureMode;
}

export interface SearchConfig {
	/** 单次搜索请求超时，默认 30000 */
	timeoutMs: number;
	/** 默认返回条数；未配置时不下发 count，用 DeepSeek 默认的 10 */
	count?: number;
	/** 默认是否请求网页正文，默认 false */
	needContent: boolean;
}

export interface FetchConfig {
	/** 单次抓取请求超时，默认 90000 */
	timeoutMs: number;
}

export interface GitHubConfig {
	/** 是否让 ds_fetch 处理 GitHub 链接，默认 true */
	enabled: boolean;
	/** 超过该体积的仓库改用 GitHub API 轻量视图，默认 350 */
	maxRepoSizeMB: number;
	/** 单次 clone 超时，默认 30 秒 */
	cloneTimeoutSeconds: number;
	/** clone 落地目录，默认系统临时目录下的 pi-github-repos */
	clonePath: string;
	/** 是否用 gh CLI 渲染 PR / Issue，默认 true */
	prIssue: boolean;
}

export interface ResolvedConfig {
	enabled: boolean;
	/** 工具暴露方式，按工具分开配 */
	exposure: ToolExposureConfig;
	/** 未启用的原因：ok 正常启用；missing-key 缺 key；explicitly-disabled 配置里关掉了 */
	reason: "ok" | "missing-key" | "explicitly-disabled";
	apiKey?: string;
	apiKeySource?: ApiKeySource;
	baseUrl: string;
	search: SearchConfig;
	fetch: FetchConfig;
	github: GitHubConfig;
	projectFile: { path: string; status: FileStatus };
	userFile: { path: string; status: FileStatus };
	/** 配置里的无效值和未知键 */
	warnings: string[];
}

export interface ResolveConfigInput {
	cwd: string;
	agentDir: string;
	env: Record<string, string | undefined>;
	/** 项目未受信任时跳过项目级配置 */
	projectTrusted: boolean;
}

export const DEFAULT_EXPOSURE: ToolExposureConfig = { search: "codemode", fetch: "direct" };
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 90_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MIN_COUNT = 1;
export const MAX_COUNT = 50;
export const DEFAULT_MAX_REPO_SIZE_MB = 350;
export const DEFAULT_CLONE_TIMEOUT_SECONDS = 30;
export const MIN_CLONE_TIMEOUT_SECONDS = 1;
export const MAX_CLONE_TIMEOUT_SECONDS = 600;
export const MIN_REPO_SIZE_MB = 1;
export const MAX_REPO_SIZE_MB = 100_000;

const GLOBAL_KEYS = new Set(["enabled", "apiKey", "baseUrl", "exposure", "search", "fetch", "github"]);
const SEARCH_KEYS = new Set(["timeoutMs", "count", "needContent"]);
const FETCH_KEYS = new Set(["timeoutMs"]);
const GITHUB_KEYS = new Set(["enabled", "maxRepoSizeMB", "cloneTimeoutSeconds", "clonePath", "prIssue"]);

interface LoadedFile {
	path: string;
	status: FileStatus;
	data?: Record<string, unknown>;
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readConfigFile(path: string, trusted: boolean): LoadedFile {
	if (!trusted) {
		return { path, status: "untrusted", warnings: [] };
	}

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path, status: "missing", warnings: [] };
		}
		return {
			path,
			status: "invalid",
			warnings: [`读取配置失败：${path}（${errorMessage(error)}），已忽略`],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			path,
			status: "invalid",
			warnings: [`配置文件不是合法 JSON：${path}（${errorMessage(error)}），已忽略`],
		};
	}

	if (!isRecord(parsed)) {
		return { path, status: "invalid", warnings: [`配置文件顶层必须是 JSON 对象：${path}，已忽略`] };
	}

	return { path, status: "ok", data: parsed, warnings: [] };
}

function readBoolean(
	data: Record<string, unknown> | undefined,
	key: string,
	label: string,
	warnings: string[],
): boolean | undefined {
	const value = data?.[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		warnings.push(`${label} 必须是 true 或 false，已忽略`);
		return undefined;
	}
	return value;
}

function readExposureMode(
	value: unknown,
	label: string,
	warnings: string[],
): ToolExposureMode | undefined {
	if (value === undefined || value === null) return undefined;
	if (value === "direct" || value === "codemode") return value;
	warnings.push(`${label} 只能是 "direct" 或 "codemode"，已忽略`);
	return undefined;
}

/**
 * 读 exposure。支持两种写法：
 * - 字符串：两个工具都用这个值，例如 "direct"
 * - 对象：按工具分别配，例如 { "search": "codemode", "fetch": "direct" }，可以只写其中一个
 */
function readExposure(
	data: Record<string, unknown> | undefined,
	label: string,
	warnings: string[],
): Partial<ToolExposureConfig> | undefined {
	const value = data?.exposure;
	if (value === undefined || value === null) return undefined;

	if (typeof value === "string") {
		const mode = readExposureMode(value, `${label} exposure`, warnings);
		return mode ? { search: mode, fetch: mode } : undefined;
	}

	if (typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${label} exposure 只能是字符串或 { "search", "fetch" } 对象，已忽略`);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const search = readExposureMode(record.search, `${label} exposure.search`, warnings);
	const fetch = readExposureMode(record.fetch, `${label} exposure.fetch`, warnings);
	if (search === undefined && fetch === undefined) return undefined;
	return { ...(search ? { search } : {}), ...(fetch ? { fetch } : {}) };
}

function readApiKey(
	data: Record<string, unknown> | undefined,
	label: string,
	warnings: string[],
): string | undefined {
	const value = data?.apiKey;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		warnings.push(`${label} apiKey 必须是字符串，已忽略`);
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readBaseUrl(
	data: Record<string, unknown> | undefined,
	label: string,
	warnings: string[],
): string | undefined {
	const value = data?.baseUrl;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		warnings.push(`${label} baseUrl 必须是字符串，已忽略`);
		return undefined;
	}
	const normalized = value.trim().replace(/\/+$/, "");
	if (normalized.length === 0) {
		warnings.push(`${label} baseUrl 为空，已忽略`);
		return undefined;
	}
	return normalized;
}

function readGroup(
	data: Record<string, unknown> | undefined,
	key: "search" | "fetch" | "github",
	allowed: Set<string>,
	label: string,
	warnings: string[],
): Record<string, unknown> | undefined {
	const value = data?.[key];
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		warnings.push(`${label} ${key} 必须是对象，已忽略`);
		return undefined;
	}
	for (const field of Object.keys(value)) {
		if (!allowed.has(field)) {
			warnings.push(`${label}存在未知配置项 ${key}.${field}，已忽略`);
		}
	}
	return value;
}

function readString(
	data: Record<string, unknown> | undefined,
	key: string,
	label: string,
	warnings: string[],
): string | undefined {
	const value = data?.[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		warnings.push(`${label} 必须是字符串，已忽略`);
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 展开 ~ 与 $HOME 这类环境变量，保持与 shell 里写法一致 */
function expandPath(value: string, env: Record<string, string | undefined>): string {
	let expanded = value;
	if (expanded.startsWith("~/") || expanded === "~") {
		expanded = expanded.replace(/^~/, env.HOME || env.USERPROFILE || "");
	}
	return expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => env[name] ?? match);
}

function readInteger(
	data: Record<string, unknown> | undefined,
	key: string,
	label: string,
	bounds: { min: number; max: number },
	warnings: string[],
): number | undefined {
	const value = data?.[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
		warnings.push(`${label} 必须是 ${bounds.min}～${bounds.max} 之间的整数，已忽略`);
		return undefined;
	}
	return value;
}

function warnUnknownGlobalKeys(data: Record<string, unknown> | undefined, label: string, warnings: string[]): void {
	if (!data) return;
	for (const key of Object.keys(data)) {
		if (!GLOBAL_KEYS.has(key)) {
			warnings.push(`${label}存在未知配置项 ${key}，已忽略`);
		}
	}
}

/**
 * 读取项目级与用户级配置，按字段合并后给出最终配置。
 * 优先级：项目级 > 用户级 > DEEPSEEK_API_KEY > 默认值。
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
	const warnings: string[] = [];
	const projectFile = readConfigFile(join(input.cwd, ".pi", "deepseek-web-tools.json"), input.projectTrusted);
	const userFile = readConfigFile(join(input.agentDir, "deepseek-web-tools.json"), true);
	warnings.push(...projectFile.warnings, ...userFile.warnings);

	const project = projectFile.data;
	const user = userFile.data;
	warnUnknownGlobalKeys(project, "项目配置", warnings);
	warnUnknownGlobalKeys(user, "用户配置", warnings);

	const projectSearch = readGroup(project, "search", SEARCH_KEYS, "项目配置", warnings);
	const userSearch = readGroup(user, "search", SEARCH_KEYS, "用户配置", warnings);
	const projectFetch = readGroup(project, "fetch", FETCH_KEYS, "项目配置", warnings);
	const userFetch = readGroup(user, "fetch", FETCH_KEYS, "用户配置", warnings);
	const projectGithub = readGroup(project, "github", GITHUB_KEYS, "项目配置", warnings);
	const userGithub = readGroup(user, "github", GITHUB_KEYS, "用户配置", warnings);

	const projectKey = readApiKey(project, "项目配置", warnings);
	const userKey = readApiKey(user, "用户配置", warnings);
	const envKeyRaw = input.env.DEEPSEEK_API_KEY ?? "";
	const envKey = envKeyRaw.trim().length > 0 ? envKeyRaw.trim() : undefined;

	const apiKey = projectKey ?? userKey ?? envKey;
	const apiKeySource: ApiKeySource | undefined = projectKey
		? "project"
		: userKey
			? "user"
			: envKey
				? "env"
				: undefined;

	const projectEnabled = readBoolean(project, "enabled", "项目配置 enabled", warnings);
	const userEnabled = readBoolean(user, "enabled", "用户配置 enabled", warnings);
	const enabledFlag = projectEnabled ?? userEnabled;
	const hasKey = apiKey !== undefined;
	const enabled = enabledFlag === undefined ? hasKey : enabledFlag && hasKey;
	const reason: ResolvedConfig["reason"] = enabled
		? "ok"
		: enabledFlag === false
			? "explicitly-disabled"
			: "missing-key";

	const baseUrl =
		readBaseUrl(project, "项目配置", warnings) ?? readBaseUrl(user, "用户配置", warnings) ?? DEFAULT_BASE_URL;

	const projectExposure = readExposure(project, "项目配置", warnings);
	const userExposure = readExposure(user, "用户配置", warnings);
	const exposure: ToolExposureConfig = {
		search: projectExposure?.search ?? userExposure?.search ?? DEFAULT_EXPOSURE.search,
		fetch: projectExposure?.fetch ?? userExposure?.fetch ?? DEFAULT_EXPOSURE.fetch,
	};

	const searchTimeoutMs =
		readInteger(projectSearch, "timeoutMs", "项目配置 search.timeoutMs", { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }, warnings) ??
		readInteger(userSearch, "timeoutMs", "用户配置 search.timeoutMs", { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }, warnings) ??
		DEFAULT_SEARCH_TIMEOUT_MS;

	const searchCount =
		readInteger(projectSearch, "count", "项目配置 search.count", { min: MIN_COUNT, max: MAX_COUNT }, warnings) ??
		readInteger(userSearch, "count", "用户配置 search.count", { min: MIN_COUNT, max: MAX_COUNT }, warnings);

	const searchNeedContent =
		readBoolean(projectSearch, "needContent", "项目配置 search.needContent", warnings) ??
		readBoolean(userSearch, "needContent", "用户配置 search.needContent", warnings) ??
		false;

	const fetchTimeoutMs =
		readInteger(projectFetch, "timeoutMs", "项目配置 fetch.timeoutMs", { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }, warnings) ??
		readInteger(userFetch, "timeoutMs", "用户配置 fetch.timeoutMs", { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }, warnings) ??
		DEFAULT_FETCH_TIMEOUT_MS;

	const githubEnabled =
		readBoolean(projectGithub, "enabled", "项目配置 github.enabled", warnings) ??
		readBoolean(userGithub, "enabled", "用户配置 github.enabled", warnings) ??
		true;

	const githubPrIssue =
		readBoolean(projectGithub, "prIssue", "项目配置 github.prIssue", warnings) ??
		readBoolean(userGithub, "prIssue", "用户配置 github.prIssue", warnings) ??
		true;

	const maxRepoSizeMB =
		readInteger(
			projectGithub,
			"maxRepoSizeMB",
			"项目配置 github.maxRepoSizeMB",
			{ min: MIN_REPO_SIZE_MB, max: MAX_REPO_SIZE_MB },
			warnings,
		) ??
		readInteger(
			userGithub,
			"maxRepoSizeMB",
			"用户配置 github.maxRepoSizeMB",
			{ min: MIN_REPO_SIZE_MB, max: MAX_REPO_SIZE_MB },
			warnings,
		) ??
		DEFAULT_MAX_REPO_SIZE_MB;

	const cloneTimeoutSeconds =
		readInteger(
			projectGithub,
			"cloneTimeoutSeconds",
			"项目配置 github.cloneTimeoutSeconds",
			{ min: MIN_CLONE_TIMEOUT_SECONDS, max: MAX_CLONE_TIMEOUT_SECONDS },
			warnings,
		) ??
		readInteger(
			userGithub,
			"cloneTimeoutSeconds",
			"用户配置 github.cloneTimeoutSeconds",
			{ min: MIN_CLONE_TIMEOUT_SECONDS, max: MAX_CLONE_TIMEOUT_SECONDS },
			warnings,
		) ??
		DEFAULT_CLONE_TIMEOUT_SECONDS;

	const clonePathRaw =
		readString(projectGithub, "clonePath", "项目配置 github.clonePath", warnings) ??
		readString(userGithub, "clonePath", "用户配置 github.clonePath", warnings);
	const clonePath = clonePathRaw ? expandPath(clonePathRaw, input.env) : join(tmpdir(), "pi-github-repos");

	return {
		enabled,
		reason,
		exposure,
		...(apiKey !== undefined ? { apiKey } : {}),
		...(apiKeySource !== undefined ? { apiKeySource } : {}),
		baseUrl,
		search: {
			timeoutMs: searchTimeoutMs,
			...(searchCount !== undefined ? { count: searchCount } : {}),
			needContent: searchNeedContent,
		},
		fetch: {
			timeoutMs: fetchTimeoutMs,
		},
		github: {
			enabled: githubEnabled,
			maxRepoSizeMB,
			cloneTimeoutSeconds,
			clonePath,
			prIssue: githubPrIssue,
		},
		projectFile: { path: projectFile.path, status: projectFile.status },
		userFile: { path: userFile.path, status: userFile.status },
		warnings,
	};
}

/** 配置里 apiKey 的脱敏显示 */
export function maskApiKey(apiKey: string): string {
	if (apiKey.length <= 8) return "****";
	const prefix = apiKey.startsWith("sk-") ? "sk-" : apiKey.slice(0, 2);
	return `${prefix}****${apiKey.slice(-4)}`;
}
