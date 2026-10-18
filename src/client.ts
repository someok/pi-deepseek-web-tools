/** DeepSeek 官方 Search / Fetch 接口路径（见 https://api-docs.deepseek.com/zh-cn/guides/search） */
export const SEARCH_PATH = "/v1/tools/search";
export const FETCH_PATH = "/v1/tools/fetch";

const USER_AGENT = "pi-deepseek-web-tools/0.1.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_BODY_LIMIT = 500;

export type Operation = "搜索" | "抓取";

export interface SearchResultItem {
	title: string;
	url: string;
	snippet: string;
	summary: string;
	content: string;
	siteName: string | null;
	siteIcon: string | null;
	date: string | null;
	authority: number | null;
	rerankScore: number | null;
}

export interface SearchResponse {
	results: SearchResultItem[];
}

export interface FetchResponse {
	title: string;
	content: string;
	url?: string;
}

export interface SearchParams {
	query: string;
	count?: number;
	needContent?: boolean;
}

export interface FetchParams {
	url: string;
}

export interface RequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface DeepSeekWebClientOptions {
	apiKey: string;
	baseUrl: string;
	fetchImpl?: typeof fetch;
}

export class DeepSeekApiError extends Error {
	readonly status?: number;
	readonly hint?: string;

	constructor(message: string, options: { status?: number; hint?: string; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "DeepSeekApiError";
		this.status = options.status;
		this.hint = options.hint;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function snippet(text: string, limit = ERROR_BODY_LIMIT): string {
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit)}…`;
}

function extractApiMessage(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const error = payload.error;
	if (isRecord(error)) {
		const message = asString(error.message);
		if (message) return message;
		const code = asString(error.code);
		if (code) return code;
	}
	return asString(payload.message);
}

function hintForStatus(status: number, operation: Operation): string {
	switch (status) {
		case 400:
			return "检查参数：query 为 1～128 字符，count 为 1～50，url 必须是合法的 HTTP/HTTPS 地址。";
		case 401:
			return "API Key 无效或缺失，检查配置文件或 DEEPSEEK_API_KEY。";
		case 402:
			return "账号余额不足，请先充值后重试。";
		case 403:
			return "Fetch 请求被 DeepSeek 安全策略拒绝，换目标站点或跳过。";
		case 404:
			return operation === "抓取"
				? "无法获取可用正文：URL 不可用、被站点拦截或没有可提取的正文。"
				: "接口路径不存在，检查 baseUrl 配置。";
		case 408:
			return "读取请求超时，可稍后重试。";
		case 413:
			return "请求体过大，URL 可能过长。";
		case 429:
			return "超过 QPS 限制（Search / Fetch 各 5 QPS，Fetch 另有域名级限制），稍后重试。";
		case 500:
			return "DeepSeek 服务端错误，稍后重试。";
		case 504:
			return "DeepSeek 下游请求超时，稍后重试。";
		default:
			return "可稍后重试。";
	}
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class DeepSeekWebClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: DeepSeekWebClientOptions) {
		this.apiKey = options.apiKey;
		this.baseUrl = options.baseUrl;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async search(params: SearchParams, options: RequestOptions = {}): Promise<SearchResponse> {
		const body: Record<string, unknown> = { query: params.query };
		if (params.count !== undefined) body.count = params.count;
		if (params.needContent !== undefined) body.need_content = params.needContent;

		const { json, text } = await this.post(SEARCH_PATH, body, "搜索", options);
		const rawResults = Array.isArray(json)
			? json
			: isRecord(json) && Array.isArray(json.results)
				? json.results
				: undefined;

		if (!rawResults) {
			throw new DeepSeekApiError(`DeepSeek 搜索响应结构不符合预期：${snippet(text)}`);
		}

		return { results: rawResults.filter(isRecord).map(mapSearchItem) };
	}

	async fetchPage(params: FetchParams, options: RequestOptions = {}): Promise<FetchResponse> {
		const { json, text } = await this.post(FETCH_PATH, { url: params.url }, "抓取", options);
		const record = isRecord(json) ? json : undefined;

		if (!record) {
			return { title: "", content: text };
		}

		const nested = isRecord(record.data) ? record.data : undefined;
		const content =
			asString(record.content) ??
			asString(record.markdown) ??
			asString(record.text) ??
			asString(nested?.content) ??
			"";
		const title = asString(record.title) ?? "";
		const finalUrl = asString(record.final_url) ?? asString(record.url);

		return { title, content, ...(finalUrl ? { url: finalUrl } : {}) };
	}

	private async post(
		path: string,
		body: unknown,
		operation: Operation,
		options: RequestOptions,
	): Promise<{ json?: unknown; text: string }> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (options.signal) signals.unshift(options.signal);

		let response: Response;
		try {
			response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.any(signals),
			});
		} catch (error) {
			throw this.networkError(error, operation, timeoutMs);
		}

		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw this.networkError(error, operation, timeoutMs);
		}

		let parsed: unknown;
		let isJson = false;
		try {
			parsed = JSON.parse(text);
			isJson = true;
		} catch {
			isJson = false;
		}

		if (!response.ok) {
			throw this.httpError(response.status, operation, text, isJson ? parsed : undefined);
		}

		return isJson ? { json: parsed, text } : { text };
	}

	private httpError(status: number, operation: Operation, text: string, payload: unknown): DeepSeekApiError {
		const hint = hintForStatus(status, operation);
		const detail = extractApiMessage(payload) ?? snippet(text);
		const message = detail
			? `DeepSeek ${operation}失败（HTTP ${status}）：${detail} ${hint}`
			: `DeepSeek ${operation}失败（HTTP ${status}）。${hint}`;
		return new DeepSeekApiError(message, { status, hint });
	}

	private networkError(error: unknown, operation: Operation, timeoutMs: number): DeepSeekApiError {
		const name = isRecord(error) ? asString(error.name) : undefined;
		if (name === "TimeoutError") {
			return new DeepSeekApiError(`DeepSeek ${operation}请求超时（timeoutMs=${timeoutMs}）`, { cause: error });
		}
		if (name === "AbortError") {
			return new DeepSeekApiError(`DeepSeek ${operation}已取消`, { cause: error });
		}
		const message = error instanceof Error ? error.message : String(error);
		return new DeepSeekApiError(`DeepSeek ${operation}请求失败：${message}`, { cause: error });
	}
}

function mapSearchItem(item: Record<string, unknown>): SearchResultItem {
	return {
		title: asString(item.title) ?? "",
		url: asString(item.url) ?? "",
		snippet: asString(item.snippet) ?? "",
		summary: asString(item.summary) ?? "",
		content: asString(item.content) ?? "",
		siteName: asNullableString(item.site_name),
		siteIcon: asNullableString(item.site_icon),
		date: asNullableString(item.date),
		authority: asNumber(item.authority) ?? null,
		rerankScore: asNumber(item.rerank_score) ?? null,
	};
}
