import { describe, expect, it, vi } from "vitest";
import { DeepSeekApiError, DeepSeekWebClient, FETCH_PATH, SEARCH_PATH } from "../src/client";

const API_KEY = "sk-test-1234abcd";
const BASE_URL = "https://api.deepseek.com";

interface RecordedCall {
	url: string;
	init: RequestInit;
}

function clientWith(
	responder: (call: RecordedCall) => Response | Promise<Response>,
): { client: DeepSeekWebClient; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return responder(call);
	}) as typeof fetch;
	const client = new DeepSeekWebClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });
	return { client, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("DeepSeekWebClient.search", () => {
	it("请求 URL、方法、鉴权头与 body 正确", async () => {
		const { client, calls } = clientWith(() => jsonResponse({ results: [] }));

		await client.search({ query: "DeepSeek 模型", count: 5, needContent: true }, { timeoutMs: 5000 });

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(`${BASE_URL}${SEARCH_PATH}`);
		expect(call.init.method).toBe("POST");
		const headers = call.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(headers["Content-Type"]).toBe("application/json");
		expect(bodyOf(call)).toEqual({ query: "DeepSeek 模型", count: 5, need_content: true });
	});

	it("未指定 count 与 needContent 时不下发对应字段", async () => {
		const { client, calls } = clientWith(() => jsonResponse({ results: [] }));

		await client.search({ query: "x" });

		expect(bodyOf(calls[0]!)).toEqual({ query: "x" });
	});

	it("解析完整的结果字段", async () => {
		const { client } = clientWith(() =>
			jsonResponse({
				results: [
					{
						rerank_score: 2.4,
						title: "DeepSeek V4 模型发布",
						url: "https://example.com/v4",
						snippet: "短摘要",
						summary: "长摘要",
						content: "正文内容",
						site_name: "Example News",
						site_icon: "https://example.com/favicon.ico",
						date: "2026-06-01T00:00:00+00:00",
						authority: 3,
					},
					{
						title: "缺字段的条目",
						url: "https://example.com/other",
						snippet: "",
						summary: "",
						content: "",
						site_name: null,
						site_icon: null,
						date: null,
						authority: -1,
					},
				],
			}),
		);

		const response = await client.search({ query: "DeepSeek" });

		expect(response.results).toHaveLength(2);
		expect(response.results[0]).toMatchObject({
			title: "DeepSeek V4 模型发布",
			url: "https://example.com/v4",
			siteName: "Example News",
			date: "2026-06-01T00:00:00+00:00",
			authority: 3,
			rerankScore: 2.4,
		});
		expect(response.results[1]).toMatchObject({
			siteName: null,
			date: null,
			authority: -1,
			rerankScore: null,
		});
	});

	it("空结果返回空数组", async () => {
		const { client } = clientWith(() => jsonResponse({ results: [] }));

		const response = await client.search({ query: "没有结果" });

		expect(response.results).toEqual([]);
	});

	it("401 给出 API key 提示且不泄露 key", async () => {
		const { client } = clientWith(() =>
			jsonResponse({ error: { message: "Authentication Fails", type: "authentication_error" } }, 401),
		);

		const error = await client.search({ query: "x" }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DeepSeekApiError);
		const message = (error as Error).message;
		expect(message).toContain("HTTP 401");
		expect(message).toContain("API Key 无效或缺失");
		expect(message).toContain("Authentication Fails");
		expect(message).not.toContain(API_KEY);
	});

	it.each([
		[402, "余额不足"],
		[403, "安全策略"],
		[429, "QPS"],
		[404, "接口路径不存在"],
		[502, "服务端错误"],
		[503, "服务端错误"],
	])("HTTP %i 给出对应提示", async (status, hint) => {
		const { client } = clientWith(() => jsonResponse({ error: { message: "nope" } }, status));

		const error = await client.search({ query: "x" }).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain(hint);
	});

	it("400 透出 API 返回的 message", async () => {
		const { client } = clientWith(() =>
			jsonResponse({ error: { message: "'count' must be between 1 and 50" } }, 400),
		);

		const error = await client.search({ query: "x" }).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain("'count' must be between 1 and 50");
	});

	it("非 JSON 错误响应带上响应体片段", async () => {
		const { client } = clientWith(() => new Response("upstream exploded", { status: 500 }));

		const error = await client.search({ query: "x" }).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain("HTTP 500");
		expect((error as Error).message).toContain("upstream exploded");
	});

	it("响应结构不符合预期时报错并带原始片段", async () => {
		const { client } = clientWith(() => jsonResponse({ ok: true }));

		const error = await client.search({ query: "x" }).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain("响应结构不符合预期");
		expect((error as Error).message).toContain("\"ok\":true");
	});
});

describe("DeepSeekWebClient.fetchPage", () => {
	it("发送 { url } 并解析标题与正文", async () => {
		const { client, calls } = clientWith(() => jsonResponse({ title: "Example", content: "# Hello" }));

		const page = await client.fetchPage({ url: "https://example.com/a" });

		expect(bodyOf(calls[0]!)).toEqual({ url: "https://example.com/a" });
		expect(calls[0]!.url).toBe(`${BASE_URL}${FETCH_PATH}`);
		expect(page).toMatchObject({ title: "Example", content: "# Hello" });
	});

	it("非 JSON 响应时正文回落为原始文本", async () => {
		const { client } = clientWith(() => new Response("plain markdown", { status: 200 }));

		const page = await client.fetchPage({ url: "https://example.com/a" });

		expect(page.content).toBe("plain markdown");
		expect(page.title).toBe("");
	});

	it("404 提示无法获取正文", async () => {
		const { client } = clientWith(() => jsonResponse({ error: { message: "not found" } }, 404));

		const error = await client.fetchPage({ url: "https://example.com/a" }).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain("无法获取可用正文");
	});
});

describe("超时与取消", () => {
	it("本地超时触发时给出超时错误", async () => {
		const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
			})) as typeof fetch;
		const client = new DeepSeekWebClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });

		const error = await client.search({ query: "x" }, { timeoutMs: 10 }).catch((caught: unknown) => caught);

		expect((error as Error).message).toContain("请求超时");
		expect((error as Error).message).toContain("timeoutMs=10");
	});

	it("外部 signal 取消时给出取消错误", async () => {
		const controller = new AbortController();
		const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				if (signal.aborted) reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason));
			})) as typeof fetch;
		const client = new DeepSeekWebClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetchImpl });

		const promise = client.search({ query: "x" }, { timeoutMs: 30_000, signal: controller.signal });
		controller.abort();

		const error = await promise.catch((caught: unknown) => caught);

		expect((error as Error).message).toContain("已取消");
	});
});
