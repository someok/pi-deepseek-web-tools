import { execFile } from "node:child_process";
import type { GitHubRepoInfo, GitHubResult } from "./types";

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

let ghAvailable: boolean | null = null;
let ghHintShown = false;

/** gh CLI 是否可用；结果在进程内缓存 */
export async function checkGhAvailable(signal?: AbortSignal): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;

	return new Promise((resolve) => {
		execFile("gh", ["--version"], { timeout: 5000, ...(signal ? { signal } : {}) }, (err) => {
			const available = !err;
			if (!signal?.aborted) ghAvailable = available;
			resolve(available);
		});
	});
}

/** 只在第一次缺 gh 时提示，避免刷屏 */
export function showGhHint(): void {
	if (!ghHintShown) {
		ghHintShown = true;
		console.error(
			"[deepseek-web-tools] 安装并登录 gh CLI 后，GitHub 仓库支持私有仓库、PR/Issue 完整视图：brew install gh && gh auth login",
		);
	}
}

/** 仓库体积（KB）；gh 不可用或查询失败时返回 null，调用方直接 clone */
export async function checkRepoSize(owner: string, repo: string): Promise<number | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}`, "--jq", ".size"],
			{ timeout: 10_000 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				const kb = Number.parseInt(stdout.trim(), 10);
				resolve(Number.isNaN(kb) ? null : kb);
			},
		);
	});
}

async function getDefaultBranch(owner: string, repo: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"],
			{ timeout: 10_000 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				const branch = stdout.trim();
				resolve(branch || null);
			},
		);
	});
}

async function fetchTreeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"],
			{ timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				const paths = stdout.trim().split("\n").filter(Boolean);
				if (paths.length === 0) {
					resolve(null);
					return;
				}
				const truncated = paths.length > MAX_TREE_ENTRIES;
				const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
				resolve(truncated ? `${display}\n... (${paths.length} total entries)` : display);
			},
		);
	});
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10_000 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				try {
					const decoded = Buffer.from(stdout.trim(), "base64").toString("utf-8");
					resolve(
						decoded.length > 8192
							? `${decoded.slice(0, 8192)}\n\n[README truncated at 8K chars]`
							: decoded,
					);
				} catch {
					resolve(null);
				}
			},
		);
	});
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				try {
					resolve(Buffer.from(stdout.trim(), "base64").toString("utf-8"));
				} catch {
					resolve(null);
				}
			},
		);
	});
}

/**
 * clone 不可用时的降级视图：用 GitHub API 取 tree + README（或单个文件）。
 * 全部失败返回 null，调用方再考虑回落到 DeepSeek 抓取。
 */
export async function fetchViaApi(
	url: string,
	owner: string,
	repo: string,
	info: GitHubRepoInfo,
	sizeNote?: string,
): Promise<GitHubResult | null> {
	const ref = info.ref || (await getDefaultBranch(owner, repo));
	if (!ref) return null;

	const lines: string[] = [];
	if (sizeNote) {
		lines.push(sizeNote);
		lines.push("");
	}

	if (info.type === "blob" && info.path) {
		const content = await fetchFileViaApi(owner, repo, info.path, ref);
		if (!content) return null;

		lines.push(`## ${info.path}`);
		if (content.length > MAX_INLINE_FILE_CHARS) {
			lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
			lines.push("\n[File truncated at 100K chars]");
		} else {
			lines.push(content);
		}

		return {
			url,
			title: `${owner}/${repo} - ${info.path}`,
			content: lines.join("\n"),
			error: null,
			source: "api",
		};
	}

	const [tree, readme] = await Promise.all([
		fetchTreeViaApi(owner, repo, ref),
		fetchReadmeViaApi(owner, repo, ref),
	]);

	if (!tree && !readme) return null;

	if (tree) {
		lines.push("## Structure");
		lines.push(tree);
		lines.push("");
	}

	if (readme) {
		lines.push("## README.md");
		lines.push(readme);
		lines.push("");
	}

	lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");

	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return {
		url,
		title,
		content: lines.join("\n"),
		error: null,
		source: "api",
	};
}
