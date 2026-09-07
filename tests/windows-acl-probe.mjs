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
  // icacls echoes one "processed file" line per object. Keep only what
  // signals a problem so the setup summary stays inside the annotation.
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^processed file:/i.test(line) && !/^Successfully processed/i.test(line))
    .join(" ");
  return { status: r.status, output };
};

async function probe(scenario) {
  const root = await mkdtemp(join(fixtureBase, `sandbox-acl-${scenario}-`));
  const workspace = join(root, "workspace");
  const context = join(root, "context");
  const guarded = join(root, "guarded");
  const home = join(root, "home");
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
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
      mkdir(appData, { recursive: true }),
      mkdir(localAppData, { recursive: true }),
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

    // cmd.exe built-ins plus System32 tools only, chained with `&` so every
    // step runs regardless of the one before it. `if errorlevel` classifies
    // the redirection failures that `&&`/`||` would swallow. PROBE_ALIVE
    // distinguishes "the shell never started" from "the shell ran and the
    // probes were inconclusive". The trailing `ver` resets the exit status
    // so a blocked write does not read as a launch failure.
    const command = [
      "echo PROBE_ALIVE",
      "whoami",
      `icacls "${secretFile}"`,
      `type "${secretFile}" >nul 2>nul`,
      "if errorlevel 1 (echo PROBE_READ_BLOCKED) else (echo PROBE_READ_ALLOWED)",
      `(echo probe)>>"${contextFile}" 2>nul`,
      "if errorlevel 1 (echo PROBE_WRITE_BLOCKED) else (echo PROBE_WRITE_ALLOWED)",
      "ver >nul",
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
        // srt-win resolves its machine state DB through LOCALAPPDATA and
        // refuses to grant without it.
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
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

// Raw job logs and artifact downloads need repository permissions; check
// annotations do not. Route the evidence through annotations so the probe
// is readable from the public run, and collapse it to one line each because
// an annotation carries no line structure.
for (const r of results) {
  const setup = (r.setup ?? [])
    .map((entry) => `${entry.step}=${entry.status}${entry.output ? ` (${entry.output})` : ""}`)
    .join("; ");
  const body = `${r.error ?? ""}\n${r.output ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 3000);
  process.stdout.write(
    `::notice title=Windows ACL probe (${r.scenario})::` +
      `${r.scenario}: exit=${r.exit ?? "error"} read=${r.read ?? "n/a"} write=${r.write ?? "n/a"} ` +
      `secretUnchanged=${r.secretUnchanged ?? "n/a"} contextUnchanged=${r.contextUnchanged ?? "n/a"} ` +
      `setup[${setup}] ${body}\n`,
  );
  process.stdout.write(`\n===== ${r.scenario} =====\n${r.error ?? r.output ?? ""}\n`);
}
