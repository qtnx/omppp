import type { SettingValue } from "../config/settings-schema";

export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;
export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

export function countToolsForAutoDiscovery(toolNames: Iterable<string>): number {
	let count = 0;
	for (const name of toolNames) {
		if (name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME) count++;
	}
	return count;
}
