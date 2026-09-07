// Windows-only diagnostic for the unresolved `denyRead` failure.
//
// The Windows backend has no inherent rights on the caller's files: it runs
// the command as a dedicated account and adds explicit ACEs for that
// account's SID. That model assumes the protected file is not already
// readable by every local user. A runner temp volume does not hold that
// assumption, so the probe runs the same policy twice and differs only in
// the fixture's ambient ACL:
//
//   inherited - the fixture keeps whatever the temp volume grants
//   isolated  - inheritance is materialized, then the world-readable
//               groups are removed
//
// Each scenario reports the identity the command ran as, the deny target's
// DACL as the command itself sees it, and whether the read and the write
// were refused. Only cmd.exe built-ins and System32 tools are used: the
// isolated scenario deliberately removes the rights that a scripting host
// would need to resolve an entry point through the fixture's parents.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeCli = join(repoRoot, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "cli.js");
const artifactDir = join(repoRoot, "artifacts");
const fixtureBase = process.env.RUNNER_TEMP || tmpdir();

// Well-known SIDs whose membership makes a file readable by any local
// account, including the sandbox account. Named by SID so no machine or
// account name is written into the repository or into a public log.
const AMBIENT_SIDS = [
  "*S-1-1-0", // Everyone
  "*S-1-5-11", // Authenticated Users
  "*S-1-5-32-545", // BUILTIN\Users
];

const forward = (value) => value.replaceAll("\\", "/");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redact = (text) => {
  const host = hostname();
  const account = process.env.USERNAME;
  let out = String(text);
  if (host) out = out.replaceAll(new RegExp(escapeRegExp(host), "gi"), "<host>");
  if (account) out = out.replaceAll(new RegExp(escapeRegExp(account), "gi"), "<account>");
  return out
    .replace(/[A-Za-z]:[\\/](?:[^\s\\/"]+[\\/])+[^\s"]*/g, "<path>")
    .replace(/S-1-5-21-[\d-]+/g, "<sid>");
};

const runIcacls = (args) => {
  const r = spawnSync("icacls", args, { encoding: "utf8", windowsHide: true });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

async function probe(scenario) {
  const root = await mkdtemp(join(fixtureBase, `sandbox-acl-${scenario}-`));
  const workspace = join(root, "workspace");
  const context = join(root, "context");
  const guarded = join(root, "guarded");
  const home = join(root, "home");
  const contextFile = join(context, "requirements.txt");
  const secretFile = join(guarded, "secret.txt");
  const settingsFile = join(root, "settings.json");
  const setup = [];

  try {
    await Promise.all([
      mkdir(workspace),
      mkdir(context),
      mkdir(guarded),
      mkdir(join(home, "tmp"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(contextFile, "context fixture\n"),
      writeFile(secretFile, "private fixture\n"),
    ]);

    if (scenario === "isolated") {
      // Materialize the inherited ACEs so they can be removed individually,
      // then drop the ones that hand read access to every local account.
      // The owner and the administrative entries survive, so cleanup and
      // artifact collection still work.
      setup.push({ step: "inheritance", ...runIcacls([root, "/inheritance:d"]) });
      for (const sid of AMBIENT_SIDS) {
        setup.push({ step: `remove ${sid}`, ...runIcacls([root, "/remove:g", sid, "/t", "/c"]) });
      }
    }

    await writeFile(
      settingsFile,
      JSON.stringify(
        {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: {
            denyRead: [secretFile],
            allowRead: [workspace, context],
            allowWrite: [workspace, home],
            denyWrite: [contextFile, secretFile],
          },
        },
        null,
        2,
      ),
    );

    // cmd.exe built-ins plus System32 tools only. `if errorlevel` is used
    // instead of `&&`/`||` so redirection failures are classified reliably.
    const command = [
      "whoami",
      `icacls "${forward(secretFile)}"`,
      `type "${forward(secretFile)}" >nul 2>nul`,
      "if errorlevel 1 (echo PROBE_READ_BLOCKED) else (echo PROBE_READ_ALLOWED)",
      `(echo probe)>>"${forward(contextFile)}" 2>nul`,
      "if errorlevel 1 (echo PROBE_WRITE_BLOCKED) else (echo PROBE_WRITE_ALLOWED)",
    ].join(" & ");

    const child = spawn(process.execPath, [runtimeCli, "--settings", settingsFile, "-c", command], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CODE_TMPDIR: join(home, "tmp"),
        SRT_DEBUG: "true",
      },
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
    const exit = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done({ code, signal }));
    });

    const output = `${stdout}${stderr}`;
    return {
      scenario,
      exit: exit.code ?? `signal ${exit.signal}`,
      read: output.includes("PROBE_READ_BLOCKED")
        ? "blocked"
        : output.includes("PROBE_READ_ALLOWED")
          ? "allowed"
          : "unknown",
      write: output.includes("PROBE_WRITE_BLOCKED")
        ? "blocked"
        : output.includes("PROBE_WRITE_ALLOWED")
          ? "allowed"
          : "unknown",
      secretUnchanged: (await readFile(secretFile, "utf8")) === "private fixture\n",
      contextUnchanged: (await readFile(contextFile, "utf8")) === "context fixture\n",
      setup: setup.map((entry) => ({ ...entry, output: redact(entry.output) })),
      output: redact(output).slice(-8000),
    };
  } catch (error) {
    return {
      scenario,
      error: redact(error instanceof Error ? error.stack : String(error)),
      setup: setup.map((entry) => ({ ...entry, output: redact(entry.output) })),
    };
  } finally {
    if (scenario === "isolated") {
      // Restore inheritance before removal so the tree is deletable even if
      // the ACE edits above changed the owner's effective rights.
      runIcacls([root, "/reset", "/t", "/c", "/q"]);
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  process.stdout.write("windows acl probe skipped: not win32\n");
  process.exit(0);
}

const results = [];
for (const scenario of ["inherited", "isolated"]) {
  results.push(await probe(scenario));
}

await mkdir(artifactDir, { recursive: true });
await writeFile(
  join(artifactDir, "windows-acl-probe.json"),
  `${JSON.stringify({ generated: new Date().toISOString(), node: process.version, results }, null, 2)}\n`,
);

const summary = results
  .map((r) => `${r.scenario}: exit=${r.exit ?? "error"} read=${r.read ?? "n/a"} write=${r.write ?? "n/a"}`)
  .join(" | ");
process.stdout.write(`::notice title=Windows ACL probe::${summary}\n`);
for (const r of results) {
  process.stdout.write(`\n===== ${r.scenario} =====\n${r.error ?? r.output ?? ""}\n`);
  for (const entry of r.setup ?? []) {
    process.stdout.write(`setup ${entry.step}: exit=${entry.status} ${entry.output}\n`);
  }
}
