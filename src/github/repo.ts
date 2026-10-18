import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, extname, join, resolve as resolvePath, sep as pathSep } from "node:path";
import { checkGhAvailable, checkRepoSize, fetchViaApi, showGhHint } from "./api";
import type { GitHubConfig, GitHubRepoInfo, GitHubResult } from "./types";

const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".tiff", ".tif",
	".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".wav", ".ogg", ".webm", ".flac", ".aac",
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst",
	".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".lib",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
	".sqlite", ".db", ".sqlite3",
	".pyc", ".pyo", ".class", ".jar", ".war",
	".iso", ".img", ".dmg",
]);

/** 列目录时跳过的噪声目录 */
const NOISE_DIRS = new Set([
	"node_modules", "vendor", ".next", "dist", "build", "__pycache__",
	".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
	"target", ".gradle", ".idea", ".vscode",
]);

const MAX_INLINE_FILE_CHARS = 100_000;
const MAX_TREE_ENTRIES = 200;
const PROCESS_KILL_GRACE_MS = 3000;

/** GitHub 上不当作代码路径的二级路由 */
const NON_CODE_SEGMENTS = new Set([
	"issues", "pull", "pulls", "discussions", "releases", "wiki",
	"actions", "settings", "security", "projects", "graphs",
	"compare", "commits", "tags", "branches", "stargazers",
	"watchers", "network", "forks", "milestone", "labels",
	"packages", "codespaces", "contribute", "community",
	"sponsors", "invitations", "notifications", "insights",
]);

/** 进行中的 clone，避免同一仓库并发重复克隆 */
const inFlightClones = new Map<string, Promise<string | null>>();

/**
 * 解析 GitHub 仓库 URL。
 * 只认仓库根、/tree/、/blob/ 三种；PR、Issue 等交给 pr-issue.ts。
 */
export function parseGitHubUrl(url: string): GitHubRepoInfo | null {
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
	if (segments.length < 2) return null;

	const owner = segments[0];
	const repo = segments[1]?.replace(/\.git$/, "");
	if (!owner || !repo) return null;
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return null;
	if (owner.includes("--")) return null;
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return null;

	if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase() ?? "")) return null;

	if (segments.length === 2) {
		return { owner, repo, refIsFullSha: false, type: "root" };
	}

	const action = segments[2];
	if (action !== "blob" && action !== "tree") return null;
	if (segments.length < 4) return null;

	const ref = segments[3];
	if (!ref || ref.length > 1024 || /[\0-\x1f\x7f]/.test(ref)) return null;
	const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
	const pathParts = segments.slice(4);
	const path = pathParts.length > 0 ? pathParts.join("/") : "";

	return {
		owner,
		repo,
		ref,
		refIsFullSha,
		path,
		type: action,
	};
}

/** clone 目录名：owner-repo 的可读前缀 + 内容哈希，保证唯一且不超长 */
function cloneDirName(owner: string, repo: string, ref?: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([owner, repo, ref ?? null]))
		.digest("hex")
		.slice(0, 16);
	const label = `${owner}-${repo}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
	return `${label}-${digest}`;
}

function isCloneComplete(destination: string): boolean {
	try {
		if (!statSync(destination).isDirectory()) return false;
		return statSync(join(destination, ".git")).isDirectory();
	} catch {
		return false;
	}
}

function terminateProcessTree(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;

	if (process.platform === "win32") {
		const killer = execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
			if (err) child.kill();
		});
		killer.unref();
		return;
	}

	try {
		// clone 放在独立进程组，超时或取消时能连 git/gh 的子进程一起干掉
		process.kill(-pid, "SIGTERM");
	} catch {
		child.kill();
	}

	// 凭据助手可能忽略 SIGTERM，3 秒后补刀
	const forceKill = setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, PROCESS_KILL_GRACE_MS);
	forceKill.unref();
}

function execClone(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;

		const finish = (success: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			resolve(success);
		};

		const child = spawn(args[0] ?? "", args.slice(1), {
			detached: process.platform !== "win32",
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GCM_INTERACTIVE: "Never",
				GH_PROMPT_DISABLED: "1",
			},
			stdio: "ignore",
			windowsHide: true,
		});

		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));

		timeout = setTimeout(() => terminateProcessTree(child), timeoutMs);
		timeout.unref();

		if (signal) {
			onAbort = () => {
				if (timeout) clearTimeout(timeout);
				terminateProcessTree(child);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/**
 * 克隆仓库到目标目录。
 * 先克隆到同级的 .partial-* 目录，成功后再 rename 落位，
 * 这样中断不会留下半截目录，跨进程并发也只会有一个赢家。
 */
async function cloneRepo(
	owner: string,
	repo: string,
	ref: string | undefined,
	config: GitHubConfig,
	destination: string,
	signal?: AbortSignal,
): Promise<string | null> {
	if (isCloneComplete(destination)) return destination;

	const partial = `${destination}.partial-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
	await rm(partial, { recursive: true, force: true }).catch(() => {});
	await mkdir(dirname(destination), { recursive: true }).catch(() => {});

	const timeoutMs = config.cloneTimeoutSeconds * 1000;
	const hasGh = await checkGhAvailable(signal);
	if (signal?.aborted) return null;

	let ok: boolean;
	if (hasGh) {
		const args = [
			"gh", "repo", "clone", `${owner}/${repo}`, partial, "--",
			"--depth", "1", "--single-branch",
		];
		if (ref) args.push("--branch", ref);
		ok = await execClone(args, timeoutMs, signal);
	} else {
		showGhHint();
		const args = ["git", "clone", "--depth", "1", "--single-branch"];
		if (ref) args.push("--branch", ref);
		args.push(`https://github.com/${owner}/${repo}.git`, partial);
		ok = await execClone(args, timeoutMs, signal);
	}

	if (!ok) {
		await rm(partial, { recursive: true, force: true }).catch(() => {});
		return null;
	}

	try {
		await rename(partial, destination);
		return destination;
	} catch {
		// 另一个进程/调用先落位了，用它的结果
		await rm(partial, { recursive: true, force: true }).catch(() => {});
		return isCloneComplete(destination) ? destination : null;
	}
}

/** 同一进程内合并并发 clone 请求 */
function cloneOnce(
	key: string,
	factory: () => Promise<string | null>,
): Promise<string | null> {
	const existing = inFlightClones.get(key);
	if (existing) return existing;

	const promise = factory().finally(() => {
		inFlightClones.delete(key);
	});
	inFlightClones.set(key, promise);
	return promise;
}

function isBinaryFile(filePath: string): boolean {
	if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true;

	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return false;
	}
	try {
		const buf = Buffer.alloc(512);
		const bytesRead = readSync(fd, buf, 0, 512, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}

	return false;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 把仓库内相对路径解析成绝对路径，越界（含符号链接逃逸）返回 null */
function resolveWithinRepo(rootPath: string, relativePath: string): string | null {
	const normalizedRoot = resolvePath(rootPath);
	const candidate = resolvePath(normalizedRoot, relativePath);
	if (candidate !== normalizedRoot) {
		const rootPrefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
		if (!candidate.startsWith(rootPrefix)) return null;
	}

	if (!existsSync(candidate)) return candidate;

	try {
		const realRoot = realpathSync(normalizedRoot);
		const realCandidate = realpathSync(candidate);
		if (realCandidate === realRoot) return candidate;
		const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
		return realCandidate.startsWith(realRootPrefix) ? candidate : null;
	} catch {
		return null;
	}
}

function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function buildTree(rootPath: string): string {
	const entries: string[] = [];

	function walk(dir: string, relPath: string): void {
		if (entries.length >= MAX_TREE_ENTRIES) return;

		let items: string[];
		try {
			items = readdirSync(dir).sort();
		} catch {
			return;
		}

		for (const item of items) {
			if (entries.length >= MAX_TREE_ENTRIES) return;
			if (item === ".git") continue;

			const rel = relPath ? `${relPath}/${item}` : item;
			const safePath = resolveWithinRepo(rootPath, rel);
			if (!safePath) {
				entries.push(`${rel}  [outside repo skipped]`);
				continue;
			}

			let stat;
			try {
				stat = statSync(safePath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				if (NOISE_DIRS.has(item)) {
					entries.push(`${rel}/  [skipped]`);
					continue;
				}
				entries.push(`${rel}/`);
				walk(safePath, rel);
			} else {
				entries.push(rel);
			}
		}
	}

	walk(rootPath, "");

	if (entries.length >= MAX_TREE_ENTRIES) {
		entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
	}

	return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
	const targetPath = resolveWithinRepo(rootPath, subPath);
	if (!targetPath) return "(path escapes repository root)";
	const lines: string[] = [];

	let items: string[];
	try {
		items = readdirSync(targetPath).sort();
	} catch {
		return "(directory not readable)";
	}

	for (const item of items) {
		if (item === ".git") continue;
		const rel = subPath ? `${subPath}/${item}` : item;
		const safePath = resolveWithinRepo(rootPath, rel);
		if (!safePath) {
			lines.push(`  ${item}  (outside repo)`);
			continue;
		}
		try {
			const stat = statSync(safePath);
			if (stat.isDirectory()) {
				lines.push(`  ${item}/`);
			} else {
				lines.push(`  ${item}  (${formatFileSize(stat.size)})`);
			}
		} catch {
			lines.push(`  ${item}  (unreadable)`);
		}
	}

	return lines.join("\n");
}

function readReadme(localPath: string): string | null {
	const candidates = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
	for (const name of candidates) {
		const readmePath = join(localPath, name);
		if (!existsSync(readmePath)) continue;
		try {
			const content = readFileSync(readmePath, "utf-8");
			return content.length > 8192 ? `${content.slice(0, 8192)}\n\n[README truncated at 8K chars]` : content;
		} catch {
			continue;
		}
	}
	return null;
}

/** 按 URL 类型生成给模型看的正文：仓库根给 tree+README，目录给列表，文件给内容 */
function generateContent(localPath: string, info: GitHubRepoInfo): string {
	const lines: string[] = [];
	lines.push(`Repository cloned to: ${localPath}`);
	lines.push("");

	if (info.type === "root") {
		lines.push("## Structure");
		lines.push(buildTree(localPath));
		lines.push("");

		const readme = readReadme(localPath);
		if (readme) {
			lines.push("## README.md");
			lines.push(readme);
			lines.push("");
		}

		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (info.type === "tree") {
		const dirPath = info.path || "";
		const fullDirPath = resolveWithinRepo(localPath, dirPath);

		if (!fullDirPath || !existsSync(fullDirPath)) {
			lines.push(`Path \`${dirPath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(buildTree(localPath));
		} else {
			lines.push(`## ${dirPath || "/"}`);
			lines.push(buildDirListing(localPath, dirPath));
		}

		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	const filePath = info.path || "";
	const fullFilePath = resolveWithinRepo(localPath, filePath);

	if (!fullFilePath || !existsSync(fullFilePath)) {
		lines.push(`Path \`${filePath}\` not found in clone. Showing repository root instead.`);
		lines.push("");
		lines.push("## Structure");
		lines.push(buildTree(localPath));
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(fullFilePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		lines.push(`Could not inspect \`${filePath}\`: ${message}`);
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (stat.isDirectory()) {
		lines.push(`## ${filePath || "/"}`);
		lines.push(buildDirListing(localPath, filePath));
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (isBinaryFile(fullFilePath)) {
		const ext = extname(filePath).replace(".", "");
		lines.push(`## ${filePath}`);
		lines.push(
			`Binary file (${ext}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`,
		);
		return lines.join("\n");
	}

	const content = readTextFile(fullFilePath);
	if (content === null) {
		lines.push(`Could not read \`${filePath}\` as UTF-8 text.`);
		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}
	lines.push(`## ${filePath}`);

	if (content.length > MAX_INLINE_FILE_CHARS) {
		lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
		lines.push("");
		lines.push(`[File truncated at 100K chars. Full file: ${fullFilePath}]`);
	} else {
		lines.push(content);
	}

	lines.push("");
	lines.push("Use `read` and `bash` tools at the path above to explore further.");
	return lines.join("\n");
}

/**
 * 把 GitHub 仓库/目录/文件 URL 转成本地 clone 内容。
 * 不是 GitHub 仓库 URL、或 clone 与 API 都失败时返回 null，让调用方回落到普通抓取。
 */
export async function extractGitHub(
	url: string,
	config: GitHubConfig,
	signal?: AbortSignal,
	forceClone?: boolean,
): Promise<GitHubResult | null> {
	if (!config.enabled) return null;

	const info = parseGitHubUrl(url);
	if (!info) return null;
	if (signal?.aborted) return null;

	const { owner, repo } = info;

	// 完整 SHA 的 URL 直接走 API，避免为定位一个提交克隆整个仓库
	if (info.refIsFullSha) {
		const sizeNote = "Note: Commit SHA URLs use the GitHub API instead of cloning.";
		return fetchViaApi(url, owner, repo, info, sizeNote);
	}

	const destination = join(config.clonePath, cloneDirName(owner, repo, info.ref));

	const buildResult = (localPath: string): GitHubResult => ({
		url,
		title: info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`,
		content: generateContent(localPath, info),
		error: null,
		source: "clone",
	});

	// 已有完整 clone 直接复用
	if (isCloneComplete(destination)) return buildResult(destination);

	if (!forceClone) {
		const sizeKB = await checkRepoSize(owner, repo);
		if (signal?.aborted) return null;
		if (sizeKB !== null) {
			const sizeMB = sizeKB / 1024;
			if (sizeMB > config.maxRepoSizeMB) {
				const sizeNote =
					`Note: Repository is ${Math.round(sizeMB)}MB (threshold: ${config.maxRepoSizeMB}MB). ` +
					`Showing API-fetched content instead of full clone.`;
				return await fetchViaApi(url, owner, repo, info, sizeNote);
			}
		}
	}

	if (signal?.aborted) return null;

	const localPath = await cloneOnce(`${owner}/${repo}@${info.ref ?? "default"}:${destination}`, () =>
		cloneRepo(owner, repo, info.ref, config, destination, signal),
	);

	if (signal?.aborted) return null;
	if (localPath) return buildResult(localPath);

	// clone 失败：先试 API 轻量视图，再交给调用方回落普通抓取
	return await fetchViaApi(url, owner, repo, info);
}

/** 清空内存中的并发锁（测试用） */
export function resetGitHubState(): void {
	inFlightClones.clear();
}

/** 删除某个仓库的本地 clone（手动清理用） */
export function removeClone(config: GitHubConfig, owner: string, repo: string, ref?: string): void {
	const destination = join(config.clonePath, cloneDirName(owner, repo, ref));
	try {
		rmSync(destination, { recursive: true, force: true });
	} catch {
		// 已经不存在
	}
}

