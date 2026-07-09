import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const releaseScript = path.join(repoRoot, "scripts", "release.ts");
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "release-watch-"));
	tempDirs.push(dir);
	return dir;
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
	await fs.chmod(filePath, 0o755);
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("release watch CI repository selection", () => {
	it("scopes gh run list to the GitHub repository parsed from an SSH origin remote", async () => {
		const root = await makeTempDir();
		const binDir = path.join(root, "bin");
		const ghInvocations = path.join(root, "gh-invocations.log");

		await writeExecutable(
			path.join(binDir, "git"),
			`#!/bin/sh
set -eu
case " $* " in
  *" rev-parse HEAD"*)
    printf '%s\n' '0123456789abcdef0123456789abcdef01234567'
    ;;
  *" remote get-url origin"*|*" config --get remote.origin.url"*)
    printf '%s\n' "$GIT_ORIGIN_URL"
    ;;
  *)
    echo "unexpected git args: $*" >&2
    exit 64
    ;;
esac
`,
		);

		await writeExecutable(
			path.join(binDir, "gh"),
			`#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$GH_INVOCATIONS"

repo=''
previous=''
for arg in "$@"; do
  if [ "$previous" = '--repo' ] || [ "$previous" = '-R' ]; then
    repo="$arg"
  fi
  case "$arg" in
    --repo=*) repo="\${arg#--repo=}" ;;
    -R=*) repo="\${arg#-R=}" ;;
  esac
  previous="$arg"
done

if [ "$repo" != 'qtnx/omppp' ]; then
  echo "expected gh repo scope qtnx/omppp; got: \${repo:-<missing>}" >&2
  exit 42
fi

case " $* " in
  *" run list "*)
    printf '%s\n' '[{"databaseId":1234,"status":"completed","conclusion":"success","name":"CI"}]'
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 64
    ;;
esac
`,
		);

		const proc = Bun.spawn([process.execPath, releaseScript, "watch"], {
			cwd: root,
			env: {
				...process.env,
				GIT_ORIGIN_URL: "git@github.com:qtnx/omppp.git",
				GH_INVOCATIONS: ghInvocations,
				HOME: path.join(root, "home"),
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		if (exitCode !== 0) {
			throw new Error(`release watch exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		}

		const invocations = (await fs.readFile(ghInvocations, "utf8")).trim().split("\n");
		const listInvocation = invocations.find(invocation => /(^| )run list( |$)/.test(invocation));
		expect(listInvocation).toBeDefined();
		expect(listInvocation).toMatch(/(^| )(--repo|-R) qtnx\/omppp( |$)|(^| )(--repo|-R)=qtnx\/omppp( |$)/);
		expect(listInvocation).not.toContain("can1357/oh-my-pi");
	});
});
