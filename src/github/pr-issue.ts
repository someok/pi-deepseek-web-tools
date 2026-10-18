import { execFile } from "node:child_process";
import { checkGhAvailable, showGhHint } from "./api";
import type { GitHubConfig, GitHubIssuePrInfo, GitHubResult } from "./types";

const GH_TIMEOUT_MS = 10_000;
const GH_TOTAL_TIMEOUT_MS = 20_000;
const MAX_DOC_CHARS = 150_000;
const BODY_INLINE_CHARS = 4_000;
const COMMENT_INLINE_CHARS = 700;
const MAX_INLINE_COMMENTS = 15;
const MAX_INLINE_REVIEWS = 10;
const MAX_INLINE_CHECKS = 15;
const MAX_INLINE_FILES = 50;
const MAX_INLINE_COMMITS = 20;
const MAX_INLINE_REVIEW_THREADS = 30;

/** PR 页面的子路由，其余子路径视为普通链接 */
const PR_SUBPATHS = new Set(["files", "commits", "checks", "conversation"]);

const PR_FIELDS = [
	"title", "number", "state", "isDraft", "author", "baseRefName", "headRefName", "headRepositoryOwner",
	"createdAt", "mergedAt", "closedAt", "labels", "milestone", "additions", "deletions", "changedFiles",
	"files", "commits", "reviews", "statusCheckRollup", "comments", "body", "closingIssuesReferences", "url",
];
/** 老版本 gh 不认识部分字段时退回的精简字段集 */
const PR_CORE_FIELDS = [
	"title", "number", "state", "isDraft", "author", "baseRefName", "headRefName", "headRepositoryOwner",
	"createdAt", "mergedAt", "closedAt", "labels", "milestone", "additions", "deletions", "changedFiles",
	"files", "commits", "reviews", "comments", "body", "url",
];
const ISSUE_FIELDS = [
	"title", "number", "state", "stateReason", "author", "createdAt", "closedAt", "labels", "assignees", "milestone",
	"comments", "body", "closedByPullRequestsReferences", "url",
];
const ISSUE_CORE_FIELDS = [
	"title", "number", "state", "author", "createdAt", "closedAt", "labels", "assignees", "milestone",
	"comments", "body", "url",
];

type Kind = "pull" | "issue";

interface GhResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
	error?: string;
}

interface RenderData {
	url: string;
	owner: string;
	repo: string;
	kind: Kind;
	number: number;
	anchor?: string;
	view: Record<string, unknown>;
	reviewThreads: Record<string, unknown>[];
	reviewThreadsBounded?: boolean;
	reviewThreadsUnavailable?: boolean;
	fallbackNotes: string[];
}

function validOwner(owner: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && !owner.includes("--");
}

function validRepo(repo: string): boolean {
	return /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== "." && repo !== "..";
}

/** 解析 PR / Issue URL，包括 #issuecomment- 与 #discussion_r 锚点 */
export function parseGitHubIssuePrUrl(url: string): GitHubIssuePrInfo | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const host = parsed.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;

	const segments: string[] = [];
	for (const segment of parsed.pathname.split("/").filter(Boolean)) {
		try {
			segments.push(decodeURIComponent(segment));
		} catch {
			return null;
		}
	}
	if (segments.length < 4) return null;

	const owner = segments[0];
	const repo = segments[1]?.replace(/\.git$/, "");
	const route = segments[2]?.toLowerCase();
	const numberSegment = segments[3];
	if (!owner || !repo || !route || !numberSegment) return null;
	if (!validOwner(owner) || !validRepo(repo)) return null;
	if (route !== "pull" && route !== "issues") return null;
	if (!/^\d+$/.test(numberSegment)) return null;

	const subpath = segments[4]?.toLowerCase();
	if (route === "pull" && subpath && !PR_SUBPATHS.has(subpath)) return null;
	if (route === "issues" && subpath) return null;

	const number = Number.parseInt(numberSegment, 10);
	if (!Number.isSafeInteger(number) || number <= 0) return null;

	const fragment = parsed.hash.slice(1);
	const anchorPattern = route === "pull" ? /^(?:issuecomment-\d+|discussion_r\d+)$/i : /^issuecomment-\d+$/i;
	const anchor = anchorPattern.test(fragment) ? fragment : undefined;

	return { owner, repo, kind: route === "pull" ? "pull" : "issue", number, ...(anchor ? { anchor } : {}) };
}

function runGh(args: string[], timeoutMs = GH_TIMEOUT_MS, signal?: AbortSignal): Promise<GhResult> {
	return new Promise((resolve) => {
		execFile(
			"gh",
			args,
			{
				timeout: timeoutMs,
				maxBuffer: 10 * 1024 * 1024,
				...(signal ? { signal } : {}),
				env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
			},
			(err, stdout, stderr) => {
				const nodeErr = err as NodeJS.ErrnoException | null;
				resolve({
					ok: !err,
					stdout,
					stderr,
					code: typeof nodeErr?.code === "number" ? nodeErr.code : null,
					...(err ? { error: nodeErr?.message ?? String(err) } : {}),
				});
			},
		);
	});
}

function remainingGhTimeout(deadlineMs: number): number {
	return Math.max(1, Math.min(GH_TIMEOUT_MS, deadlineMs - Date.now()));
}

function unknownJsonField(result: GhResult): boolean {
	return /unknown (?:json )?field|UnknownField|Unknown JSON field/i.test(`${result.stderr}\n${result.error ?? ""}`);
}

async function ghView(
	info: GitHubIssuePrInfo,
	deadlineMs: number,
	signal?: AbortSignal,
): Promise<{ view: Record<string, unknown>; notes: string[] } | null> {
	const repoArg = `${info.owner}/${info.repo}`;
	const command = info.kind === "pull" ? "pr" : "issue";
	const fields = info.kind === "pull" ? PR_FIELDS : ISSUE_FIELDS;
	const coreFields = info.kind === "pull" ? PR_CORE_FIELDS : ISSUE_CORE_FIELDS;

	let result = await runGh(
		[command, "view", String(info.number), "--repo", repoArg, "--json", fields.join(",")],
		remainingGhTimeout(deadlineMs),
		signal,
	);
	const notes: string[] = [];
	let linkedReferencesUnavailable = false;

	if (!result.ok && unknownJsonField(result)) {
		result = await runGh(
			[command, "view", String(info.number), "--repo", repoArg, "--json", coreFields.join(",")],
			remainingGhTimeout(deadlineMs),
			signal,
		);
		notes.push("Some GitHub fields were unavailable from this gh version; retried with the core field set.");
		linkedReferencesUnavailable = true;
	}
	if (!result.ok) return null;

	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const view = parsed as Record<string, unknown>;
		if (linkedReferencesUnavailable) view.linkedReferencesUnavailable = true;
		return { view, notes };
	} catch {
		return null;
	}
}

async function ghReviewThreads(
	info: GitHubIssuePrInfo,
	deadlineMs: number,
	signal?: AbortSignal,
): Promise<{
	comments: Record<string, unknown>[];
	note?: string;
	bounded?: boolean;
	unavailable?: boolean;
	anchorUnavailable?: boolean;
}> {
	if (info.kind !== "pull") return { comments: [] };

	const comments: Record<string, unknown>[] = [];
	let bounded = false;
	let pageFailed = false;

	for (let page = 1; page <= 3; page++) {
		const result = await runGh(
			["api", `repos/${info.owner}/${info.repo}/pulls/${info.number}/comments?per_page=100&page=${page}`],
			remainingGhTimeout(deadlineMs),
			signal,
		);
		if (!result.ok) {
			pageFailed = true;
			break;
		}
		let pageItems: unknown;
		try {
			pageItems = JSON.parse(result.stdout);
		} catch {
			pageFailed = true;
			break;
		}
		if (!Array.isArray(pageItems) || pageItems.length === 0) break;
		comments.push(
			...pageItems.filter(
				(item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item),
			),
		);
		if (pageItems.length < 100) break;
		if (page === 3) bounded = true;
	}

	const discussionId = anchorId(info.anchor, "discussion_r");
	if (discussionId && !hasCommentId(comments, discussionId)) {
		const result = await runGh(
			["api", `repos/${info.owner}/${info.repo}/pulls/comments/${discussionId}`],
			remainingGhTimeout(deadlineMs),
			signal,
		);
		if (result.ok) {
			try {
				const comment = JSON.parse(result.stdout) as unknown;
				if (
					comment &&
					typeof comment === "object" &&
					!Array.isArray(comment) &&
					belongsToPull(comment as Record<string, unknown>, discussionId, info)
				) {
					comments.push(comment as Record<string, unknown>);
				} else {
					return { comments, bounded: bounded || (pageFailed && comments.length > 0), unavailable: pageFailed && comments.length === 0, anchorUnavailable: true };
				}
			} catch {
				return {
					comments,
					bounded: bounded || (pageFailed && comments.length > 0),
					unavailable: pageFailed && comments.length === 0,
					note: "Anchored review thread comment unavailable from gh.",
				};
			}
		} else {
			return { comments, bounded: bounded || (pageFailed && comments.length > 0), unavailable: pageFailed && comments.length === 0, anchorUnavailable: true };
		}
	}

	return { comments, bounded: bounded || (pageFailed && comments.length > 0), unavailable: pageFailed && comments.length === 0 };
}

function anchorId(anchor: string | undefined, prefix: "issuecomment" | "discussion_r"): string | null {
	const match = anchor?.match(prefix === "issuecomment" ? /^issuecomment-(\d+)$/i : /^discussion_r(\d+)$/i);
	return match?.[1] ?? null;
}

function hasCommentId(comments: Record<string, unknown>[], id: string): boolean {
	return comments.some((comment) => commentId(comment) === id);
}

function belongsToPull(comment: Record<string, unknown>, id: string, info: GitHubIssuePrInfo): boolean {
	return commentId(comment) === id && associationMatches(comment.pull_request_url, info, "pulls");
}

function associationMatches(value: unknown, info: GitHubIssuePrInfo, route: "issues" | "pulls"): boolean {
	if (typeof value !== "string") return false;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.github.com") return false;
		return (
			parsed.pathname.toLowerCase() ===
			`/repos/${info.owner}/${info.repo}/${route}/${info.number}`.toLowerCase()
		);
	} catch {
		return false;
	}
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function authorLogin(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
	const login = (value as Record<string, unknown>).login;
	return typeof login === "string" && login ? login : "unknown";
}

function listNames(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) return "none";
	const names = value
		.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return "";
			const record = item as Record<string, unknown>;
			return stringValue(record.name) || stringValue(record.login) || stringValue(record.title);
		})
		.filter(Boolean);
	return names.length > 0 ? names.join(", ") : "none";
}

function milestoneTitle(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "none";
	return stringValue((value as Record<string, unknown>).title) || "none";
}

/** 附录保存被内联截断的全文，所以每段文本只出现一次 */
function truncateText(text: string, limit: number, label: string, appendix: string[], tool: string | null): string {
	if (text.length <= limit) return text;
	// 在极限附近找词边界，保证按词搜索仍能命中
	const lastSpace = text.slice(0, limit + 1).search(/\s\S*$/);
	const cut = lastSpace > limit * 0.8 ? lastSpace : limit;
	appendix.push(`## ${label} (continued)\n\n${text.slice(cut)}`);
	return `${text.slice(0, cut)}\n\n[${label} truncated; ${tool ? `the rest is stored under "${label} (continued)": use ${tool} findText or offset` : "use the gh escalation commands below for the rest"}]`;
}

function storeOmitted(appendix: string[], section: string, items: string[]): void {
	if (items.length > 0) appendix.push(`## ${section} (continued)\n\n${items.join("\n")}`);
}

/** `atLeast` 表示真实数量比已取到的更多，只有 gh 能拿到剩下的 */
function omissionMarker(
	section: string,
	noun: string,
	shown: number,
	fetched: number,
	atLeast: number | null,
	tool: string | null,
	gh = "the gh command below",
): string | null {
	const stored =
		fetched > shown && tool ? `${fetched - shown} more stored under "${section} (continued)": use ${tool} findText or offset` : "";
	if (atLeast !== null) return `[${shown} ${noun} shown from at least ${atLeast}; ${stored ? `${stored}; for the rest ` : ""}use ${gh}]`;
	if (fetched <= shown) return null;
	return `[${shown} of ${fetched} ${noun} shown; ${stored ? `${stored}, or ${gh}` : `use ${gh}`}]`;
}

function appendLimitedSection(
	lines: string[],
	title: string,
	items: string[],
	max: number,
	marker: string,
	appendix: string[],
	tool: string | null,
): void {
	lines.push(`## ${title}`);
	if (items.length === 0) {
		lines.push("none", "");
		return;
	}
	lines.push(...items.slice(0, max));
	storeOmitted(appendix, title, items.slice(max));
	const omitted = omissionMarker(title, marker, max, items.length, null, tool);
	if (omitted) lines.push(omitted);
	lines.push("");
}

function objectArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

function commentId(comment: Record<string, unknown>): string {
	return String(comment.id ?? comment.databaseId ?? "");
}

function anchorMatches(anchor: string | undefined, comment: Record<string, unknown>): boolean {
	if (!anchor) return false;
	const id = commentId(comment);
	return anchor === `issuecomment-${id}` || anchor === `discussion_r${id}`;
}

function renderComments(
	comments: Record<string, unknown>[],
	anchor: string | undefined,
	appendix: string[],
	tool: string | null,
): string[] {
	const forced = anchor ? comments.find((comment) => anchorMatches(anchor, comment)) : undefined;
	const selected = comments.slice(0, MAX_INLINE_COMMENTS);
	if (forced && !selected.includes(forced)) selected.push(forced);

	const render = (comment: Record<string, unknown>, inline: boolean) => {
		const body = stringValue(comment.body);
		const label = `comment ${commentId(comment) || comments.indexOf(comment) + 1}`;
		const text = inline ? truncateText(body, COMMENT_INLINE_CHARS, label, appendix, tool) : body;
		return `- ${authorLogin(comment.author ?? comment.user)} at ${stringValue(comment.createdAt) || stringValue(comment.created_at)}${forced === comment ? " [anchored]" : ""}:\n  ${text.replace(/\n/g, "\n  ")}`;
	};

	const lines = selected.map((comment) => render(comment, true));
	storeOmitted(
		appendix,
		"Conversation comments",
		comments
			.slice(MAX_INLINE_COMMENTS)
			.filter((comment) => comment !== forced)
			.map((comment) => render(comment, false)),
	);
	return lines;
}

function commentCountText(view: Record<string, unknown>): string {
	const comments = objectArray(view.comments).length;
	const total = numberValue(view.commentsCount);
	if (total !== null && total > comments) return `at least ${total}`;
	return String(comments || total || 0);
}

function reviewThreadCountText(
	comments: Record<string, unknown>[],
	total: unknown,
	bounded?: boolean,
	unavailable?: boolean,
): string {
	if (unavailable) return "unavailable";
	const knownTotal = numberValue(total);
	if (bounded) return `at least ${comments.length}`;
	if (knownTotal !== null && knownTotal > comments.length) return `at least ${knownTotal}`;
	return String(comments.length || knownTotal || 0);
}

function renderChecks(value: unknown, appendix: string[], tool: string | null): string[] {
	const checks = objectArray(value);
	if (checks.length === 0) return ["No check rollup data available."];
	const rows = checks.map((check) => {
		const name = stringValue(check.name) || stringValue(check.context) || stringValue(check.workflowName) || "check";
		const state = stringValue(check.conclusion) || stringValue(check.status) || stringValue(check.state) || "unknown";
		return `- ${name}: ${state}`;
	});
	const failing = rows.filter((row) => !/(success|neutral|skipped|completed)$/i.test(row));
	storeOmitted(appendix, "Checks", rows.slice(MAX_INLINE_CHECKS));
	const omitted = omissionMarker("Checks", "checks", MAX_INLINE_CHECKS, rows.length, null, tool);
	return [
		`Rollup: ${failing.length === 0 ? "no failing checks in shown data" : `${failing.length} non-passing checks in shown data`}`,
		...rows.slice(0, MAX_INLINE_CHECKS),
		...(omitted ? [omitted] : []),
	];
}

function renderReviewVerdicts(value: unknown, appendix: string[], tool: string | null): string[] {
	const latest = new Map<string, Record<string, unknown>>();
	for (const review of objectArray(value)) latest.set(authorLogin(review.author ?? review.user), review);
	return [...latest.entries()].map(([author, review]) => {
		const state = stringValue(review.state) || "COMMENTED";
		const body = truncateText(stringValue(review.body), 300, `review by ${author}`, appendix, tool);
		return `- ${author}: ${state}${body ? ` — ${body.replace(/\n/g, " ")}` : ""}`;
	});
}

function renderReviewVerdictsOrUnavailable(
	view: Record<string, unknown>,
	appendix: string[],
	tool: string | null,
): string[] {
	const rendered = renderReviewVerdicts(view.reviews, appendix, tool);
	if (rendered.length > 0) return rendered;
	return view.reviewsUnavailable === true ? ["Unavailable in this GitHub fetch path; use gh for review verdicts."] : [];
}

function renderFiles(value: unknown): string[] {
	return objectArray(value).map((file) => {
		const path = stringValue(file.path) || stringValue(file.filename) || "file";
		const additions = numberValue(file.additions) ?? 0;
		const deletions = numberValue(file.deletions) ?? 0;
		return `- ${path} (+${additions}/−${deletions})`;
	});
}

function appendFilesSection(
	lines: string[],
	view: Record<string, unknown>,
	appendix: string[],
	tool: string | null,
): void {
	lines.push("## Files");
	const files = renderFiles(view.files);
	const total = numberValue(view.changedFiles);
	const omitted = omissionMarker(
		"Files",
		"files",
		Math.min(files.length, MAX_INLINE_FILES),
		files.length,
		total !== null && total > files.length ? total : null,
		tool,
	);
	if (files.length === 0 && !omitted) lines.push("none");
	lines.push(...files.slice(0, MAX_INLINE_FILES));
	storeOmitted(appendix, "Files", files.slice(MAX_INLINE_FILES));
	if (omitted) lines.push(omitted);
	lines.push("");
}

function renderCommits(value: unknown): string[] {
	return objectArray(value).map((commit) => {
		const oid = stringValue(commit.oid) || stringValue(commit.sha);
		const message =
			stringValue(commit.messageHeadline) ||
			(commit.commit && typeof commit.commit === "object"
				? stringValue((commit.commit as Record<string, unknown>).message).split("\n")[0] ?? ""
				: "");
		return `- ${oid.slice(0, 7)} ${message}`.trim();
	});
}

function renderCommitsOrUnavailable(view: Record<string, unknown>): string[] {
	const rendered = renderCommits(view.commits);
	if (rendered.length > 0) return rendered;
	return view.commitsUnavailable === true ? ["Unavailable in this GitHub fetch path; use gh for commits."] : [];
}

function renderLinked(value: unknown, kind: "closing" | "closedBy"): string[] {
	return objectArray(value).map(
		(item) =>
			`- #${numberValue(item.number) ?? "?"} ${stringValue(item.title)}${kind === "closedBy" ? ` (${stringValue(item.url)})` : ""}`,
	);
}

function renderLinkedOrUnavailable(
	view: Record<string, unknown>,
	field: "closingIssuesReferences" | "closedByPullRequestsReferences",
	kind: "closing" | "closedBy",
): string[] {
	const linked = renderLinked(view[field], kind);
	if (linked.length > 0) return linked;
	return view.linkedReferencesUnavailable === true
		? ["Unavailable in this GitHub fetch path; use gh for linked references."]
		: [];
}

function renderReviewThreads(
	comments: Record<string, unknown>[],
	anchor: string | undefined,
	appendix: string[],
	tool: string | null,
	total?: unknown,
	bounded?: boolean,
	unavailable?: boolean,
): string[] {
	if (unavailable) return ["Unavailable in this GitHub fetch path; use gh for review thread comments."];

	const forced = anchor ? comments.find((comment) => anchorMatches(anchor, comment)) : undefined;
	const selected = comments.slice(0, MAX_INLINE_REVIEW_THREADS);
	if (forced && !selected.includes(forced)) selected.push(forced);

	const render = (comment: Record<string, unknown>, inline: boolean) => {
		const path = stringValue(comment.path) || "unknown path";
		const line = numberValue(comment.line) ?? numberValue(comment.original_line) ?? numberValue(comment.position) ?? "?";
		const text = stringValue(comment.body);
		const body = inline
			? truncateText(text, COMMENT_INLINE_CHARS, `review thread comment ${commentId(comment) || comments.indexOf(comment) + 1}`, appendix, tool)
			: text;
		return `- ${path}:${line} — ${authorLogin(comment.user ?? comment.author)}${forced === comment ? " [anchored]" : ""} (resolution state unknown):\n  ${body.replace(/\n/g, "\n  ")}`;
	};

	const lines = selected.map((comment) => render(comment, true));
	storeOmitted(
		appendix,
		"Review thread comments",
		comments
			.slice(MAX_INLINE_REVIEW_THREADS)
			.filter((comment) => comment !== forced)
			.map((comment) => render(comment, false)),
	);

	const knownTotal = numberValue(total);
	const atLeast = bounded ? comments.length : knownTotal !== null && knownTotal > comments.length ? knownTotal : null;
	const omitted = omissionMarker(
		"Review thread comments",
		"review thread comments",
		selected.length,
		comments.length,
		atLeast,
		tool,
		"gh api repos/<owner>/<repo>/pulls/<number>/comments",
	);
	if (omitted) lines.push(omitted);
	return lines;
}

/** 把 gh 返回的结构化数据渲染成一份模型能一次读完的 Markdown */
export function renderGitHubPrIssue(data: RenderData): GitHubResult {
	const { view } = data;
	const appendix: string[] = [];
	// 本扩展没有 get_search_content 之类的检索工具，附录提示统一指向 gh 命令
	const tool: string | null = null;
	const title = stringValue(view.title) || `${data.owner}/${data.repo}#${data.number}`;
	const number = numberValue(view.number) ?? data.number;
	const stateParts = [stringValue(view.state) || "unknown"];
	if (view.isDraft === true) stateParts.push("draft");

	const lines: string[] = [`#${number} ${title}`, ""];
	lines.push(`- type: ${data.kind}`);
	lines.push(`- state: ${stateParts.join(" ")}${stringValue(view.stateReason) ? ` (${stringValue(view.stateReason)})` : ""}`);
	lines.push(`- author: ${authorLogin(view.author)}`);
	if (data.kind === "pull") {
		const headOwner = authorLogin(view.headRepositoryOwner);
		const headRef = stringValue(view.headRefName);
		const head = headOwner !== "unknown" && headOwner !== data.owner ? `${headOwner}:${headRef}` : headRef;
		lines.push(`- branch: ${stringValue(view.baseRefName)} ← ${head}`);
		const commitSummary = view.commitsUnavailable === true ? "commits unavailable" : `${objectArray(view.commits).length} commits`;
		lines.push(
			`- changes: +${numberValue(view.additions) ?? 0} −${numberValue(view.deletions) ?? 0}, ${numberValue(view.changedFiles) ?? objectArray(view.files).length} files, ${commitSummary}`,
		);
	} else {
		lines.push(`- assignees: ${listNames(view.assignees)}`);
	}
	lines.push(`- created: ${stringValue(view.createdAt) || "unknown"}`);
	if (stringValue(view.mergedAt)) lines.push(`- merged: ${stringValue(view.mergedAt)}`);
	if (stringValue(view.closedAt)) lines.push(`- closed: ${stringValue(view.closedAt)}`);
	lines.push(`- labels: ${listNames(view.labels)}`);
	lines.push(`- milestone: ${milestoneTitle(view.milestone)}`);
	lines.push(
		`- comments: ${commentCountText(view)}; review threads: ${reviewThreadCountText(data.reviewThreads, view.reviewCommentsCount, data.reviewThreadsBounded, data.reviewThreadsUnavailable)}`,
	);
	if (data.anchor) lines.push(`- requested anchor: #${data.anchor}`);
	lines.push("");

	lines.push("## Body");
	lines.push(truncateText(stringValue(view.body) || "(empty)", BODY_INLINE_CHARS, "body", appendix, tool), "");

	if (data.kind === "pull") {
		lines.push("## Checks");
		lines.push(...renderChecks(view.statusCheckRollup, appendix, tool), "");
		appendLimitedSection(lines, "Review verdicts", renderReviewVerdictsOrUnavailable(view, appendix, tool), MAX_INLINE_REVIEWS, "review verdicts", appendix, tool);
		appendLimitedSection(lines, "Linked references", renderLinkedOrUnavailable(view, "closingIssuesReferences", "closing"), 20, "linked references", appendix, tool);
		appendFilesSection(lines, view, appendix, tool);
		appendLimitedSection(lines, "Commits", renderCommitsOrUnavailable(view), MAX_INLINE_COMMITS, "commits", appendix, tool);
	} else {
		appendLimitedSection(lines, "Closed by pull requests", renderLinkedOrUnavailable(view, "closedByPullRequestsReferences", "closedBy"), 20, "pull requests", appendix, tool);
	}

	lines.push("## Conversation comments");
	const comments = objectArray(view.comments);
	const commentLines = renderComments(comments, data.anchor, appendix, tool);
	const knownCommentTotal = numberValue(view.commentsCount);
	const commentMarker = omissionMarker(
		"Conversation comments",
		"comments",
		commentLines.length,
		comments.length,
		knownCommentTotal !== null && knownCommentTotal > comments.length ? knownCommentTotal : null,
		tool,
		"gh issue view -c",
	);
	if (commentMarker) commentLines.push(commentMarker);
	if (view.anchorUnavailable === true && data.anchor?.startsWith("issuecomment-")) {
		commentLines.push("[anchored comment unavailable for this issue or pull request]");
	}
	lines.push(...(commentLines.length > 0 ? commentLines : ["none"]), "");

	if (data.kind === "pull") {
		lines.push("## Review thread comments");
		const threadLines = renderReviewThreads(
			data.reviewThreads,
			data.anchor,
			appendix,
			tool,
			view.reviewCommentsCount,
			data.reviewThreadsBounded,
			data.reviewThreadsUnavailable,
		);
		if (view.anchorUnavailable === true && data.anchor?.startsWith("discussion_r")) {
			threadLines.push("[anchored review thread comment unavailable for this pull request]");
		}
		lines.push(...(threadLines.length > 0 ? threadLines : ["none"]), "");
	}

	if (data.fallbackNotes.length > 0) {
		lines.push("## Availability notes", ...data.fallbackNotes.map((note) => `- ${note}`), "");
	}

	const viewCommand =
		data.kind === "pull"
			? `gh pr view ${data.number} --repo ${data.owner}/${data.repo}`
			: `gh issue view ${data.number} --repo ${data.owner}/${data.repo} -c`;
	const diffCommand = data.kind === "pull" ? `gh pr diff ${data.number} --repo ${data.owner}/${data.repo}` : "";
	lines.push("## Escalation commands");
	lines.push(`- Full view: \`${viewCommand}\``);
	if (diffCommand) lines.push(`- Complete diff: \`${diffCommand}\``);

	// 附录放最后，这样文档被 MAX_DOC_CHARS 截断时前面内容还在
	if (appendix.length > 0) lines.push("", "## Appendix", "", appendix.join("\n\n"));

	const content = lines.join("\n");
	return {
		url: data.url,
		title: `${data.owner}/${data.repo} ${data.kind} #${data.number}: ${title}`,
		content:
			content.length > MAX_DOC_CHARS
				? `${content.slice(0, MAX_DOC_CHARS)}\n\n[GitHub document truncated at ${MAX_DOC_CHARS} chars; use \`${viewCommand}\`${diffCommand ? ` or \`${diffCommand}\`` : ""} for complete data]`
				: content,
		error: null,
		source: "gh",
	};
}

/**
 * 用 gh CLI 抓取 PR / Issue 并渲染成 Markdown。
 * gh 不可用或取数失败时返回 null，让调用方回落到普通网页抓取。
 */
export async function extractGitHubIssuePr(
	url: string,
	config: GitHubConfig,
	signal?: AbortSignal,
): Promise<GitHubResult | null> {
	if (!config.enabled || !config.prIssue) return null;

	const info = parseGitHubIssuePrUrl(url);
	if (!info) return null;
	if (signal?.aborted) return null;

	if (!(await checkGhAvailable(signal))) {
		showGhHint();
		return null;
	}
	if (signal?.aborted) return null;

	const deadlineMs = Date.now() + GH_TOTAL_TIMEOUT_MS;
	const viewed = await ghView(info, deadlineMs, signal);
	if (signal?.aborted) return null;
	if (!viewed) return null;

	const threads = await ghReviewThreads(info, deadlineMs, signal);
	if (signal?.aborted) return null;
	if (threads.anchorUnavailable) viewed.view.anchorUnavailable = true;

	const notes = [...viewed.notes, ...(threads.note ? [threads.note] : [])];
	return renderGitHubPrIssue({
		url,
		owner: info.owner,
		repo: info.repo,
		kind: info.kind,
		number: info.number,
		anchor: info.anchor,
		view: viewed.view,
		reviewThreads: threads.comments,
		reviewThreadsBounded: threads.bounded,
		reviewThreadsUnavailable: threads.unavailable,
		fallbackNotes: notes,
	});
}
