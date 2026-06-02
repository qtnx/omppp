import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";

export type DumpTarget = "clipboard" | "file";

export async function writeSessionTranscriptDump(text: string): Promise<string> {
	const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dump-"));
	await fs.chmod(dirPath, 0o700);
	const filePath = path.join(dirPath, `${Snowflake.next()}-session.txt`);
	const file = await fs.open(filePath, "wx", 0o600);
	try {
		await file.writeFile(`${text}\n`, { encoding: "utf8" });
	} finally {
		await file.close();
	}
	return filePath;
}
