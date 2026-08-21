import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { addMCPServer, readMCPConfigFile } from "../mcp/config-writer";
import type { MCPServerConfig } from "../mcp/types";

export type LinearMcpConfigScope = "user" | "project";

const LINEAR_SERVER_NAME = "linear";
const LINEAR_SERVER_CONFIG = {
	type: "http",
	url: "https://mcp.linear.app/mcp",
} as const satisfies MCPServerConfig;

function isExactLinearConfig(config: MCPServerConfig | undefined): boolean {
	return (
		config?.type === LINEAR_SERVER_CONFIG.type &&
		config.url === LINEAR_SERVER_CONFIG.url &&
		Object.keys(config).length === Object.keys(LINEAR_SERVER_CONFIG).length
	);
}

/**
 * Ensure the official Linear MCP server is configured without replacing an
 * existing server or any credentials attached to it.
 *
 * @returns `true` when this call added the server, `false` when it was already
 * configured exactly as required.
 */
export async function ensureLinearMcpConfig(cwd: string, scope: LinearMcpConfigScope = "user"): Promise<boolean> {
	const filePath = getMCPConfigPath(scope, cwd);
	const existing = await readMCPConfigFile(filePath);
	const configured = existing.mcpServers?.[LINEAR_SERVER_NAME];
	if (configured) {
		if (isExactLinearConfig(configured)) return false;
		throw new Error(
			`Linear MCP server is already configured differently in ${filePath}; remove or update it before running /linear add.`,
		);
	}

	try {
		await addMCPServer(filePath, LINEAR_SERVER_NAME, LINEAR_SERVER_CONFIG);
		return true;
	} catch (error) {
		// A concurrent writer may have added the exact server between our read and
		// add. Re-read before surfacing a conflict so the operation remains idempotent.
		const after = await readMCPConfigFile(filePath);
		const concurrent = after.mcpServers?.[LINEAR_SERVER_NAME];
		if (concurrent && isExactLinearConfig(concurrent)) return false;
		if (concurrent) {
			throw new Error(
				`Linear MCP server is already configured differently in ${filePath}; remove or update it before running /linear add.`,
			);
		}
		throw error;
	}
}

export { LINEAR_SERVER_CONFIG, LINEAR_SERVER_NAME };
