import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export interface TruncatedText {
	/** 可以直接给模型看的文本；被截断时结尾带说明和临时文件路径 */
	content: string;
	truncated: boolean;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

export interface TruncateOptions {
	/** 临时目录前缀，例如 pi-ds-search- */
	prefix: string;
	/** 临时文件名，例如 results.json */
	fileName: string;
	/** 落盘的完整内容；默认与输入的 text 相同 */
	fullText?: string;
}

/**
 * 按 pi 的默认阈值（2000 行 / 50KB）截断文本。
 * 被截断时把完整内容写到临时文件，并在文本末尾给出路径。
 */
export async function truncateWithTempFile(text: string, options: TruncateOptions): Promise<TruncatedText> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) {
		return { content: text, truncated: false, truncation };
	}

	const directory = await mkdtemp(join(tmpdir(), options.prefix));
	const fullOutputPath = join(directory, options.fileName);
	const fullText = options.fullText ?? text;

	await withFileMutationQueue(fullOutputPath, async () => {
		await writeFile(fullOutputPath, fullText, "utf8");
	});

	const omittedLines = truncation.totalLines - truncation.outputLines;
	const notice =
		`\n\n[输出已截断：显示 ${truncation.outputLines}/${truncation.totalLines} 行` +
		`（${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}），省略 ${omittedLines} 行。` +
		`完整内容：${fullOutputPath}]`;

	return {
		content: `${truncation.content}${notice}`,
		truncated: true,
		truncation,
		fullOutputPath,
	};
}
