import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeCli = join(repoRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js");
const childScript = join(repoRoot, "tests", "sandbox-child.mjs");
const fixtureBase = process.env.RUNNER_TEMP || tmpdir();
const fixtureRoot = await mkdtemp(join(fixtureBase, "native-sandbox-tests-"));
const workspace = join(fixtureRoot, "workspace");
const context = join(fixtureRoot, "context");
const outside = join(fixtureRoot, "outside");
const home = join(fixtureRoot, "home");
const sandboxTemp = join(home, "tmp");
const appData = join(home, "AppData", "Roaming");
const localAppData = join(home, "AppData", "Local");
const workspaceResult = join(workspace, "result.txt");
const childResult = join(workspace, "child-result.txt");
const contextFile = join(context, "requirements.txt");
const outsideFile = join(outside, "secret.txt");
const sourceFile = join(workspace, "toolchain.c");
const settingsFile = join(fixtureRoot, "settings.json");
const artifactDir = join(repoRoot, "artifacts");
const childScriptFixture = join(workspace, "sandbox-child.mjs");

const started = new Date().toISOString();
let result;

try {
  await Promise.all([
    mkdir(workspace),
    mkdir(context),
    mkdir(outside),
    mkdir(home),
    mkdir(sandboxTemp, { recursive: true }),
    mkdir(appData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(contextFile, "context fixture\n"),
    writeFile(outsideFile, "private fixture\n"),
    writeFile(childScriptFixture, await readFile(childScript, "utf8")),
    writeFile(
      sourceFile,
      '#include <stdio.h>\nint main(void) { puts("sandbox-toolchain"); return 0; }\n',
    ),
    writeFile(
      settingsFile,
      JSON.stringify(
        {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: {
            // The two deny rules address separate fixtures on purpose. The
            // Windows backend keys one deny ACE per path, so listing a file
            // under both denyRead and denyWrite leaves it with whichever
            // mask is applied last -- a write-only mask that permits the
            // read. Reads are asserted against the outside fixture, writes
            // against the context fixture. See tests/windows-acl-probe.mjs.
            denyRead: [outsideFile],
            allowRead: [workspace, context],
            allowWrite: [workspace, home],
            denyWrite: [contextFile],
          },
        },
        null,
        2,
      ),
    ),
  ]);

  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    CLAUDE_CODE_TMPDIR: sandboxTemp,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SRT_DEBUG: "true",
    SANDBOX_WORKSPACE: workspace,
    SANDBOX_CONTEXT: contextFile,
    SANDBOX_OUTSIDE: outsideFile,
    SANDBOX_SOURCE: sourceFile,
  };

  const runtimeArgs = [runtimeCli, "--settings", settingsFile];
  if (process.platform === "win32") {
    const quoteForCmd = (value) => `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
    // The Windows backend starts the child from a fresh profile and overlays
    // only PATH, PATHEXT, and its own proxy variables, so anything else the
    // command needs has to be set inside the command string. PATH already
    // carries the compiler; INCLUDE, LIB, and LIBPATH are what the developer
    // environment adds around it, and without them cl.exe resolves no
    // headers. Absent variables are dropped so a host without the developer
    // environment fails on the compiler itself rather than on empty settings.
    const toolchainEnv = ["INCLUDE", "LIB", "LIBPATH"]
      .map((key) => [key, process.env[key]])
      .filter(([, value]) => value);
    const fixtureEnv = [
      ["SANDBOX_WORKSPACE", workspace],
      ["SANDBOX_CONTEXT", contextFile],
      ["SANDBOX_OUTSIDE", outsideFile],
      ["SANDBOX_SOURCE", sourceFile],
      ...toolchainEnv,
    ]
      .map(([key, value]) => `set "${key}=${value.replaceAll("\\", "/")}"`)
      .join(" && ");
    runtimeArgs.push(
      "-c",
      `${fixtureEnv} && ${quoteForCmd(process.execPath)} ${quoteForCmd(childScriptFixture)}`,
    );
  } else {
    runtimeArgs.push(process.execPath, childScriptFixture);
  }
  const child = spawn(process.execPath, runtimeArgs, {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });

  const output = `${stdout}${stderr}`;
  if (exitCode.code !== 0) {
    throw new Error(`sandbox command exited with ${exitCode.code ?? `signal ${exitCode.signal}`}\n${output}`);
  }
  for (const marker of ["OUTSIDE_READ_BLOCKED", "CONTEXT_WRITE_BLOCKED", "CHILD_PROCESS_PASS", "NETWORK_BLOCKED:", "FILESYSTEM_PASS", "TOOLCHAIN_PASS"]) {
    if (!output.includes(marker)) throw new Error(`missing check marker: ${marker}\n${output}`);
  }

  if ((await readFile(workspaceResult, "utf8")) !== "sandbox result\n") throw new Error("workspace write failed");
  if ((await readFile(childResult, "utf8")) !== "child result\n") throw new Error("child workspace write failed");
  if ((await readFile(contextFile, "utf8")) !== "context fixture\n") throw new Error("protected file changed");
  if ((await readFile(outsideFile, "utf8")) !== "private fixture\n") throw new Error("outside fixture changed");

  result = {
    status: "passed",
    started,
    finished: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    runtime: "@anthropic-ai/sandbox-runtime@0.0.75",
    checks: ["filesystem policy", "child process inheritance", "network policy", "native toolchain"],
    policy: {
      allowedDomains: [],
      protectedReadFixture: "outside/secret.txt",
      writableRoots: ["workspace", "home"],
    },
    output: output.slice(-12000),
  };
} catch (error) {
  result = {
    status: "failed",
    started,
    finished: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    runtime: "@anthropic-ai/sandbox-runtime@0.0.75",
    error: error instanceof Error ? error.stack : String(error),
  };
} finally {
  await mkdir(artifactDir, { recursive: true });
  const artifactName = `sandbox-${process.platform}.json`;
  await writeFile(join(artifactDir, artifactName), `${JSON.stringify(result, null, 2)}\n`);
  await rm(fixtureRoot, { recursive: true, force: true });
}

if (result.status !== "passed") {
  const errorText = String(result.error);
  const markerNames = [
    "OUTSIDE_READ_BLOCKED",
    "CONTEXT_WRITE_BLOCKED",
    "CHILD_PROCESS_PASS",
    "NETWORK_BLOCKED:",
    "TOOLCHAIN_START",
    "COMPILER_PASS",
    "TOOLCHAIN_RUN_PASS",
  ];
  const markers = markerNames.filter((marker) => errorText.includes(marker));
  const diagnostic = errorText
    .split(/\r?\n/)
    .filter((line) =>
      markers.length === 0 || /error|err_|eacces|eperm|enoent|invalid|denied|failed|cannot|sandboxdebug/i.test(line),
    )
    .join(" ")
    .replace(/file:\/\/\/?[A-Za-z]:[^\s]*/g, "<file>")
    .replace(/[A-Za-z]:[\\/](?:[^\s\\/]+[\\/])+[^\s]*/g, "<path>")
    .replace(/\/(?:Users|home|runner|private|var|tmp)\/[^\s]*/g, "<path>")
    .slice(0, 3000);
  process.stdout.write(`::error title=Sandbox smoke failure::markers=${markers.join(",") || "none"} ${diagnostic}\n`);
  process.stderr.write(`${result.error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`sandbox smoke passed on ${process.platform}/${process.arch}\n`);
}
