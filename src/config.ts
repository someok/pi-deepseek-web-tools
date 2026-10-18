import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 配置文件读取状态 */
export type FileStatus = "missing" | "ok" | "invalid" | "untrusted";

/** apiKey 来源 */
export type ApiKeySource = "project" | "user" | "env";

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

export interface ResolvedConfig {
	enabled: boolean;
	/** 未启用的原因：ok 正常启用；missing-key 缺 key；explicitly-disabled 配置里关掉了 */
	reason: "ok" | "missing-key" | "explicitly-disabled";
	apiKey?: string;
	apiKeySource?: ApiKeySource;
	baseUrl: string;
	search: SearchConfig;
	fetch: FetchConfig;
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

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 90_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MIN_COUNT = 1;
export const MAX_COUNT = 50;

const GLOBAL_KEYS = new Set(["enabled", "apiKey", "baseUrl", "search", "fetch"]);
const SEARCH_KEYS = new Set(["timeoutMs", "count", "needContent"]);
const FETCH_KEYS = new Set(["timeoutMs"]);

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
	key: "search" | "fetch",
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

	return {
		enabled,
		reason,
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
