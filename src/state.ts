import type { DeepSeekWebClient } from "./client";
import type { ResolvedConfig } from "./config";

/** 扩展运行期共享状态：session_start 时填充 */
export interface ExtensionState {
	config?: ResolvedConfig;
	client?: DeepSeekWebClient;
}

export const MISSING_KEY_MESSAGE =
	"DeepSeek 网络工具未启用：缺少 API key。\n" +
	"• 在项目 .pi/deepseek-web-tools.json 或用户级 ~/.pi/agent/deepseek-web-tools.json 写入 {\"apiKey\": \"sk-...\"}\n" +
	"• 或设置环境变量 DEEPSEEK_API_KEY\n" +
	"配置后执行 /reload 生效。";

export function notEnabledMessage(config?: ResolvedConfig): string {
	if (config?.reason === "explicitly-disabled") {
		return "DeepSeek 网络工具已被配置禁用（enabled: false）。改回 true 后执行 /reload。";
	}
	return MISSING_KEY_MESSAGE;
}

/** 取当前可用的 client；未启用时抛出可读错误 */
export function requireClient(state: ExtensionState): { client: DeepSeekWebClient; config: ResolvedConfig } {
	if (!state.client || !state.config?.enabled) {
		throw new Error(notEnabledMessage(state.config));
	}
	return { client: state.client, config: state.config };
}
