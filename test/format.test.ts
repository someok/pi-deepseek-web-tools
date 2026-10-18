import { describe, expect, it } from "vitest";
import { formatFetchedPage, formatSearchResults, unescapeMarkdown } from "../src/format";
import type { SearchResultItem } from "../src/client";

describe("unescapeMarkdown", () => {
	it("还原 DeepSeek Fetch 转义过的标点", () => {
		expect(unescapeMarkdown("\\# billion\\-context")).toBe("# billion-context");
		expect(unescapeMarkdown("a \\, b \\(c\\) \\/ d \\: e \\$ 5 \\!")).toBe("a , b (c) / d : e $ 5 !");
	});

	it("不动字母转义和 Windows 路径", () => {
		expect(unescapeMarkdown("C:\\Users\\name \\n")).toBe("C:\\Users\\name \\n");
	});

	it("双转义还原成单转义", () => {
		expect(unescapeMarkdown("\\\\*x\\\\*")).toBe("\\*x\\*");
	});
});

describe("formatFetchedPage", () => {
	it("带标题时输出标题、URL、正文", () => {
		expect(formatFetchedPage({ title: "标题", url: "https://example.com/a", content: "正文" })).toBe(
			"# 标题\n\nhttps://example.com/a\n\n正文",
		);
	});

	it("标题为空时省掉标题行", () => {
		expect(formatFetchedPage({ title: "  ", url: "https://example.com/a", content: "正文" })).toBe(
			"https://example.com/a\n\n正文",
		);
	});
});

describe("formatSearchResults", () => {
	function item(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
		return {
			title: "标题",
			url: "https://example.com/a",
			snippet: "短摘要",
			summary: "长摘要",
			content: "",
			siteName: "Example",
			siteIcon: null,
			date: "2026-06-01T00:00:00+00:00",
			authority: 3,
			rerankScore: 2.4,
			...overrides,
		};
	}

	it("站点缺失时回退 host，日期只保留年月日", () => {
		const text = formatSearchResults({
			query: "q",
			results: [item({ siteName: null })],
			includeContent: false,
		});

		expect(text).toContain("站点：example.com ｜ 发布：2026-06-01");
	});

	it("summary 为空时回退 snippet，needContent 时带正文", () => {
		const text = formatSearchResults({
			query: "q",
			results: [item({ summary: " ", snippet: "短摘要", content: "网页正文" })],
			includeContent: true,
		});

		expect(text).toContain("短摘要");
		expect(text).toContain("正文：网页正文");
	});

	it("空结果给出换关键词的提示", () => {
		const text = formatSearchResults({ query: "q", results: [], includeContent: false });

		expect(text).toContain("没有搜索到结果");
		expect(text).toContain('query="q"');
	});
});
