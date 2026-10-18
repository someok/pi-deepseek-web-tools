import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

/** 用渲染器拿到的 Theme 构造 Markdown 主题，和 pi 内置消息的观感保持一致 */
export function markdownThemeFrom(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
	};
}
