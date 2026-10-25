import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DeepSeekWebClient } from "./client";
import { registerCommands } from "./commands";
import { resolveConfig, type ResolvedConfig, type ToolExposureMode } from "./config";
import { MISSING_KEY_MESSAGE, type ExtensionState } from "./state";
import { createFetchTool, createSearchTool } from "./tools";

function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured && configured.length > 0 ? configured : join(homedir(), ".pi", "agent");
}

/** 每个工具是否该激活，由 config 推导出来 */
interface ToolPlan {
	enabled: boolean;
	exposure: ToolExposureMode;
}

/** 只增删自己的两个工具名，保留其他扩展已激活的工具 */
function syncActiveTools(pi: ExtensionAPI, plan: Record<string, ToolPlan>): void {
	const active = new Set(pi.getActiveTools());
	let changed = false;

	for (const [name, tool] of Object.entries(plan)) {
		// codemode 暴露的工具注册即可调用，放进 active set 反而会把声明塞回模型
		const wantActive = tool.enabled && tool.exposure === "direct";
		if (wantActive) {
			if (!active.has(name)) {
				active.add(name);
				changed = true;
			}
		} else if (active.delete(name)) {
			changed = true;
		}
	}

	if (changed) pi.setActiveTools([...active]);
}

function notifyStartup(ctx: ExtensionContext, config: ResolvedConfig): void {
	const sections: string[] = [];

	if (!config.enabled && config.reason === "missing-key") {
		sections.push(MISSING_KEY_MESSAGE);
	}

	if (config.warnings.length > 0) {
		sections.push(["DeepSeek 网络工具配置提醒：", ...config.warnings.map((warning) => `• ${warning}`)].join("\n"));
	}

	if (sections.length === 0) return;

	const message = sections.join("\n\n");
	if (ctx.hasUI) {
		ctx.ui.notify(message, "warning");
	} else {
		console.warn(message);
	}
}

export default function deepseekWebTools(pi: ExtensionAPI): void {
	const state: ExtensionState = {};
	/** 最新的 UI 上下文，给命令的点击展开用 */
	let currentUi: ExtensionUIContext | undefined;

	pi.registerTool(createSearchTool(state));
	pi.registerTool(createFetchTool(state));
	registerCommands(pi, state, { getUi: () => currentUi });

	pi.on("session_start", async (_event, ctx) => {
		const config = resolveConfig({
			cwd: ctx.cwd,
			agentDir: agentDir(),
			env: process.env,
			projectTrusted: ctx.isProjectTrusted(),
		});

		state.config = config;
		state.client =
			config.enabled && config.apiKey
				? new DeepSeekWebClient({ apiKey: config.apiKey, baseUrl: config.baseUrl })
				: undefined;
		currentUi = ctx.ui;

		try {
			// exposure 只在注册时生效，而配置要等 session_start 才读到；同名重注册是替换，两个方向都幂等。
			// 不能只处理 direct：同一进程里从 direct 会话切到 codemode 会话时，旧定义会留在注册表里。
			pi.registerTool(createSearchTool(state, config.exposure.search));
			pi.registerTool(createFetchTool(state, config.exposure.fetch));

			// enabled: false 是硬关；缺 key 只关 ds_search，ds_fetch 仍能处理 GitHub（clone 和 gh 不花 DeepSeek 额度）
			const hardDisabled = config.reason === "explicitly-disabled";
			syncActiveTools(pi, {
				ds_search: { enabled: config.enabled, exposure: config.exposure.search },
				ds_fetch: {
					enabled: !hardDisabled && (config.enabled || config.github.enabled),
					exposure: config.exposure.fetch,
				},
			});
		} catch (error) {
			console.warn(
				`[deepseek-web-tools] 调整工具可用性失败：${error instanceof Error ? error.message : String(error)}`,
			);
		}

		notifyStartup(ctx, config);
	});
}
