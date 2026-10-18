import { extractGitHubIssuePr, parseGitHubIssuePrUrl } from "./pr-issue";
import { extractGitHub, parseGitHubUrl } from "./repo";
import type { GitHubConfig, GitHubResult } from "./types";

export type { GitHubConfig, GitHubIssuePrInfo, GitHubRepoInfo, GitHubResult } from "./types";
export { parseGitHubIssuePrUrl } from "./pr-issue";
export { extractGitHub, parseGitHubUrl, removeClone, resetGitHubState } from "./repo";

/** GitHub URL 的大致类型，用于决定要不要绕过 DeepSeek 抓取 */
export type GitHubUrlKind = "repo" | "pr-issue" | null;

export function classifyGitHubUrl(url: string): GitHubUrlKind {
	if (parseGitHubIssuePrUrl(url)) return "pr-issue";
	if (parseGitHubUrl(url)) return "repo";
	return null;
}

/**
 * ds_fetch 的 GitHub 分支入口。
 * 返回 null 表示「不是 GitHub URL，或专用路径没拿到内容」，调用方应回落到普通网页抓取。
 */
export async function extractGitHubUrl(
	url: string,
	config: GitHubConfig,
	signal?: AbortSignal,
): Promise<GitHubResult | null> {
	if (!config.enabled) return null;

	// PR / Issue 优先：这两个路径不会命中仓库解析
	const prIssue = await extractGitHubIssuePr(url, config, signal);
	if (prIssue) return prIssue;
	if (signal?.aborted) return null;

	return extractGitHub(url, config, signal);
}
