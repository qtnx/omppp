import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";

export type ParentContextSnapshot = {
	path: string;
};

/** Write one bounded parent-history snapshot outside repository-rule context files. */
export async function writeParentContextSnapshot(
	session: Pick<ToolSession, "getCompactContext">,
	artifactsDir: string,
	compactContext?: string,
): Promise<ParentContextSnapshot | undefined> {
	const snapshotText = compactContext === undefined ? session.getCompactContext?.() : compactContext;
	if (!snapshotText) return undefined;
	const contextFilePath = path.join(artifactsDir, `context-${Snowflake.next()}.md`);
	await Bun.write(contextFilePath, snapshotText);
	return { path: contextFilePath };
}
