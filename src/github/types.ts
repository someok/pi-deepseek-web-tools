/** GitHub 专用抓取的结果，字段与 ds_fetch 的其他来源保持一致 */
export interface GitHubResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
	/** 内容获取方式：clone（本地克隆）、api（GitHub API）、gh（gh CLI 渲染 PR/Issue） */
	source?: "clone" | "api" | "gh";
}

/** parseGitHubUrl 的解析结果 */
export interface GitHubRepoInfo {
	owner: string;
	repo: string;
	ref?: string;
	refIsFullSha: boolean;
	path?: string;
	type: "root" | "blob" | "tree";
}

/** parseGitHubIssuePrUrl 的解析结果 */
export interface GitHubIssuePrInfo {
	owner: string;
	repo: string;
	kind: "pull" | "issue";
	number: number;
	/** 例如 issuecomment-123、discussion_r456，用于把对应评论内联 */
	anchor?: string;
}

import type { GitHubConfig } from "../config";

/** 配置来源统一在 src/config.ts，这里只做转发供 github 子模块使用 */
export type { GitHubConfig };
