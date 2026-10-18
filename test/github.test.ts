import { describe, expect, it } from "vitest";
import { classifyGitHubUrl } from "../src/github";
import { parseGitHubIssuePrUrl, renderGitHubPrIssue } from "../src/github/pr-issue";
import { parseGitHubUrl } from "../src/github/repo";

describe("parseGitHubUrl", () => {
	it("解析仓库根路径", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo")).toEqual({
			owner: "owner",
			repo: "repo",
			refIsFullSha: false,
			type: "root",
		});
	});

	it("去掉 .git 后缀", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo.git")?.repo).toBe("repo");
	});

	it("解析目录与文件路径", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/tree/main/src/lib")).toMatchObject({
			ref: "main",
			path: "src/lib",
			type: "tree",
		});
		expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/src/index.ts")).toMatchObject({
			ref: "main",
			path: "src/index.ts",
			type: "blob",
		});
	});

	it("识别 40 位完整 SHA", () => {
		const sha = "a".repeat(40);
		expect(parseGitHubUrl(`https://github.com/owner/repo/blob/${sha}/README.md`)).toMatchObject({
			refIsFullSha: true,
			ref: sha,
		});
	});

	it("解码 URL 编码的路径", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/docs/%E4%B8%AD%E6%96%87.md")?.path).toBe(
			"docs/中文.md",
		);
	});

	it("拒绝非代码路由与非 GitHub 站点", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/issues/1")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner/repo/pull/1")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner/repo/commits/main")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner/repo/releases")).toBeNull();
		expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner/repo/blob")).toBeNull();
	});

	it("拒绝非法 owner / repo 标识", () => {
		expect(parseGitHubUrl("https://github.com/own--er/repo")).toBeNull();
		expect(parseGitHubUrl("https://github.com/-owner/repo")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner/..")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner/re po")).toBeNull();
	});
});

describe("parseGitHubIssuePrUrl", () => {
	it("解析 PR 与 Issue", () => {
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/pull/123")).toEqual({
			owner: "owner",
			repo: "repo",
			kind: "pull",
			number: 123,
		});
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/issues/7")?.kind).toBe("issue");
	});

	it("接受 PR 的子路由", () => {
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/pull/123/files")?.number).toBe(123);
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/pull/123/commits")?.number).toBe(123);
	});

	it("解析锚点", () => {
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/issues/7#issuecomment-999")?.anchor).toBe(
			"issuecomment-999",
		);
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/pull/9#discussion_r456")?.anchor).toBe(
			"discussion_r456",
		);
		// Issue 不接受 review thread 锚点
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/issues/7#discussion_r1")?.anchor).toBeUndefined();
	});

	it("拒绝非法路径", () => {
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/issues/7/comments")).toBeNull();
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
		expect(parseGitHubIssuePrUrl("https://github.com/owner/repo")).toBeNull();
		expect(parseGitHubIssuePrUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull();
	});
});

describe("classifyGitHubUrl", () => {
	it("按 URL 类型分流", () => {
		expect(classifyGitHubUrl("https://github.com/o/r")).toBe("repo");
		expect(classifyGitHubUrl("https://github.com/o/r/pull/1")).toBe("pr-issue");
		expect(classifyGitHubUrl("https://example.com/o/r")).toBeNull();
	});
});

describe("renderGitHubPrIssue", () => {
	const baseView = {
		title: "Add streaming support",
		number: 42,
		state: "OPEN",
		isDraft: false,
		author: { login: "alice" },
		baseRefName: "main",
		headRefName: "feat/stream",
		headRepositoryOwner: { login: "alice" },
		createdAt: "2026-09-01T00:00:00Z",
		labels: [{ name: "enhancement" }],
		milestone: null,
		additions: 120,
		deletions: 8,
		changedFiles: 2,
		files: [
			{ path: "src/stream.ts", additions: 100, deletions: 5 },
			{ path: "test/stream.test.ts", additions: 20, deletions: 3 },
		],
		commits: [{ oid: "abcdef1234567890", messageHeadline: "add streaming" }],
		reviews: [{ author: { login: "bob" }, state: "APPROVED", body: "LGTM" }],
		statusCheckRollup: [{ name: "ci/test", conclusion: "SUCCESS" }],
		comments: [{ id: "1", author: { login: "carol" }, createdAt: "2026-09-02T00:00:00Z", body: "看起来不错" }],
		body: "给响应加上流式输出。",
		url: "https://github.com/owner/repo/pull/42",
	};

	function render(overrides: Record<string, unknown> = {}) {
		return renderGitHubPrIssue({
			url: "https://github.com/owner/repo/pull/42",
			owner: "owner",
			repo: "repo",
			kind: "pull",
			number: 42,
			view: { ...baseView, ...overrides },
			reviewThreads: [],
			fallbackNotes: [],
		});
	}

	it("输出关键字段与升级命令", () => {
		const result = render();
		expect(result.title).toBe("owner/repo pull #42: Add streaming support");
		expect(result.source).toBe("gh");
		expect(result.content).toContain("#42 Add streaming support");
		expect(result.content).toContain("- state: OPEN");
		expect(result.content).toContain("- branch: main ← alice:feat/stream");
		expect(result.content).toContain("- changes: +120 −8, 2 files, 1 commits");
		expect(result.content).toContain("- labels: enhancement");
		expect(result.content).toContain("## Checks");
		expect(result.content).toContain("- ci/test: SUCCESS");
		expect(result.content).toContain("## Review verdicts");
		expect(result.content).toContain("- bob: APPROVED — LGTM");
		expect(result.content).toContain("- src/stream.ts (+100/−5)");
		expect(result.content).toContain("- abcdef1 add streaming");
		expect(result.content).toContain("看起来不错");
		expect(result.content).toContain("gh pr view 42 --repo owner/repo");
		expect(result.content).toContain("gh pr diff 42 --repo owner/repo");
	});

	it("标注 draft 状态与锚点", () => {
		const result = renderGitHubPrIssue({
			url: "https://github.com/owner/repo/pull/42",
			owner: "owner",
			repo: "repo",
			kind: "pull",
			number: 42,
			anchor: "issuecomment-1",
			view: { ...baseView, isDraft: true },
			reviewThreads: [],
			fallbackNotes: ["Some fields were unavailable."],
		});

		expect(result.content).toContain("- state: OPEN draft");
		expect(result.content).toContain("- requested anchor: #issuecomment-1");
		expect(result.content).toContain("[anchored]");
		expect(result.content).toContain("## Availability notes");
	});

	it("Issue 走另一套字段", () => {
		const result = renderGitHubPrIssue({
			url: "https://github.com/owner/repo/issues/7",
			owner: "owner",
			repo: "repo",
			kind: "issue",
			number: 7,
			view: {
				title: "Crash on startup",
				number: 7,
				state: "CLOSED",
				stateReason: "COMPLETED",
				author: { login: "dave" },
				assignees: [{ login: "erin" }],
				createdAt: "2026-09-01T00:00:00Z",
				closedAt: "2026-09-03T00:00:00Z",
				labels: [],
				milestone: null,
				comments: [],
				body: "启动即崩溃",
				closedByPullRequestsReferences: [{ number: 42, title: "Fix crash", url: "https://github.com/owner/repo/pull/42" }],
			},
			reviewThreads: [],
			fallbackNotes: [],
		});

		expect(result.content).toContain("- type: issue");
		expect(result.content).toContain("- state: CLOSED (COMPLETED)");
		expect(result.content).toContain("- assignees: erin");
		expect(result.content).toContain("## Closed by pull requests");
		expect(result.content).toContain("#42 Fix crash");
		expect(result.content).toContain("gh issue view 7 --repo owner/repo -c");
		expect(result.content).not.toContain("## Checks");
	});

	it("超长正文进附录而不是丢掉", () => {
		const longBody = "a".repeat(5000);
		const result = render({ body: longBody });

		expect(result.content).toContain("[body truncated;");
		expect(result.content).toContain("## Appendix");
		expect(result.content).toContain("## body (continued)");
	});
});
