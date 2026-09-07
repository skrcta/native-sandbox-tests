import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const workspace = process.env.SANDBOX_WORKSPACE;
const contextFile = process.env.SANDBOX_CONTEXT;
const outsideFile = process.env.SANDBOX_OUTSIDE;
const sourceFile = process.env.SANDBOX_SOURCE;
const childMode = process.argv.includes("--child");

if (!workspace || !contextFile || !outsideFile || !sourceFile) {
  throw new Error("sandbox fixture paths are missing");
}

const expectBlocked = (operation, callback) => {
  try {
    callback();
  } catch {
    process.stdout.write(`${operation}_BLOCKED\n`);
    return;
  }
  throw new Error(`${operation} was allowed`);
};

if (readFileSync(contextFile, "utf8") !== "context fixture\n") {
  throw new Error("allowed fixture could not be read");
}

writeFileSync(join(workspace, "result.txt"), "sandbox result\n");
expectBlocked("OUTSIDE_READ", () => readFileSync(outsideFile, "utf8"));
expectBlocked("CONTEXT_WRITE", () => appendFileSync(contextFile, "should be denied\n"));

if (childMode) {
  writeFileSync(join(workspace, "child-result.txt"), "child result\n");
  expectBlocked("CHILD_OUTSIDE_READ", () => readFileSync(outsideFile, "utf8"));
  expectBlocked("CHILD_CONTEXT_WRITE", () => appendFileSync(contextFile, "should be denied\n"));
  process.stdout.write("CHILD_PROCESS_PASS\n");
  process.exit(0);
}

const child = spawnSync(process.execPath, [process.argv[1], "--child"], {
  cwd: workspace,
  env: process.env,
  encoding: "utf8",
});
process.stdout.write(child.stdout ?? "");
process.stderr.write(child.stderr ?? "");
if (child.error) throw child.error;
if (child.status !== 0) {
  throw new Error(`child process exited with ${child.status}`);
}

if (!child.stdout.includes("CHILD_PROCESS_PASS")) {
  throw new Error("child process did not complete its checks");
}

let networkResponse;
try {
  networkResponse = await fetch("http://198.51.100.1/", {
    redirect: "manual",
    signal: AbortSignal.timeout(3000),
  });
} catch (error) {
  process.stdout.write(`NETWORK_BLOCKED:${error.code ?? error.name}\n`);
}
if (networkResponse) {
  if (networkResponse.ok) {
    throw new Error(`network probe unexpectedly succeeded with HTTP ${networkResponse.status}`);
  }
  process.stdout.write(`NETWORK_BLOCKED:HTTP_${networkResponse.status}\n`);
}

const source = readFileSync(sourceFile, "utf8");
if (!source.includes("sandbox-toolchain")) {
  throw new Error("native source fixture is missing");
}

process.stdout.write("TOOLCHAIN_START\n");
const isWindows = process.platform === "win32";
let compiler;
let compilerArgs;
let executable;
if (isWindows) {
  compiler = "cl.exe";
  compilerArgs = ["/nologo", sourceFile, "/Fe:sandbox-toolchain.exe"];
  executable = join(workspace, "sandbox-toolchain.exe");
} else {
  compiler = "cc";
  compilerArgs = [sourceFile, "-o", join(workspace, "sandbox-toolchain")];
  executable = join(workspace, "sandbox-toolchain");
}

const compile = spawnSync(compiler, compilerArgs, {
  cwd: workspace,
  env: process.env,
  encoding: "utf8",
});
process.stdout.write(compile.stdout ?? "");
process.stderr.write(compile.stderr ?? "");
if (compile.error) {
  throw new Error(`native compiler could not be started: ${compile.error.message}`);
}
if (compile.status !== 0) {
  throw new Error(`native compiler exited with ${compile.status}`);
}
process.stdout.write("COMPILER_PASS\n");

const run = spawnSync(executable, [], {
  cwd: workspace,
  env: process.env,
  encoding: "utf8",
});
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
if (run.error) throw run.error;
if (run.status !== 0 || run.stdout.trim() !== "sandbox-toolchain") {
  throw new Error("native toolchain output was unexpected");
}

process.stdout.write("TOOLCHAIN_RUN_PASS\n");
process.stdout.write("FILESYSTEM_PASS\nTOOLCHAIN_PASS\n");
