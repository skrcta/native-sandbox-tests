# Windows sandbox test handoff

## Objective

Validate the same smoke contract on Linux, macOS, and Windows using
`@anthropic-ai/sandbox-runtime@0.0.75`:

- read an explicitly allowed fixture;
- deny reads from a protected fixture;
- deny writes to protected fixtures;
- allow writes in the workspace;
- preserve restrictions for a child process;
- block a direct network request; and
- compile and run a small native program.

The Linux and macOS legs pass. The Windows leg is still unresolved.

## Current state

- Repository: `skrcta/native-sandbox-tests`
- Branch: `main`
- Latest commit: `6029e57` (`Use runner temp volume for Windows fixtures`)
- Local Linux smoke test: passes
- Latest Actions run: [34099345302](https://github.com/skrcta/native-sandbox-tests/actions/runs/34099345302)
- Latest run result: Linux and macOS passed; Windows failed
- Windows setup uses the package's `windows-install` command and the bundled
  `srt-win` helper. The workflow also installs the MSVC developer environment.

The test now allocates its fixture under `RUNNER_TEMP` when that variable is
available. This avoids the runner profile path that prevented the sandboxed
Node process from resolving its entry point.

## Investigation history

The original run [34080509207](https://github.com/skrcta/native-sandbox-tests/actions/runs/34080509207)
failed before the smoke test because the workflow used Node 20 while pnpm 11
requires a newer Node release. The workflow was moved to Node 24.

Subsequent failures were narrowed as follows:

1. macOS needed a writable temporary directory and a usable compiler temp
   location. Those issues are fixed; macOS is green.
2. Windows initially failed during sandbox setup because required environment
   variables and executable/read paths were missing.
3. Windows then failed before the child script started with
   `EPERM: operation not permitted, lstat ...\\Users\\RUNNER~1\\AppData`.
   Moving fixtures from the profile temp directory to `RUNNER_TEMP` fixed that
   startup failure.
4. In the latest run, Windows reaches the child process. The child reports
   `OUTSIDE_READ was allowed`, so the explicit `denyRead` rule is not being
   enforced for the protected file.

The latest public check annotation shows that ACL setup itself reports success:

- `acl grant exit=0`
- `acl stamp exit=0`
- one `denyRead` target and two `denyWrite` targets were applied
- the network infrastructure initialized
- the command then started under the sandbox

The failure occurs after that point, before the first smoke marker. This makes
the remaining problem a Windows filesystem-policy question rather than a
workflow provisioning or command-quoting problem.

## Important constraints

- Do not add credentials, runner-specific absolute paths, or account names to
  committed diagnostics.
- Keep the public repository vendor-neutral and keep evidence bounded and
  redacted.
- The Windows implementation in the dependency is alpha. Do not claim that a
  successful ACL command means the policy was enforced; the child read/write
  probes are the authoritative checks.
- GitHub exposes run metadata, jobs, annotations, and artifact metadata without
  authentication, but raw job logs and artifact ZIP downloads require suitable
  repository permissions.

## Recommended next investigation

1. Reproduce the latest test on a Windows machine and print the effective
   identity (`whoami`) from inside the sandbox. Confirm that the child is the
   dedicated sandbox account.
2. Immediately after `acl stamp`, inspect the protected file's DACL with
   `icacls` or PowerShell `Get-Acl`. Verify that an explicit deny ACE exists for
   the sandbox SID and that it includes read access, not only write/delete
   rights.
3. Run a minimal direct probe through `srt-win exec` against one stamped file.
   Keep this separate from Node, child-process inheritance, compiler, and
   network checks so the result identifies the helper behavior.
4. Compare a file under `RUNNER_TEMP` with a file under a newly created ordinary
   directory on another volume, if available. Record the inherited ACEs and
   whether the explicit deny behaves differently.
5. Check the exact vendored helper version and compare its deny-mask behavior
   with the upstream Windows ACL implementation. Relevant upstream context:
   [Windows ACL behavior issue](https://github.com/anthropics/sandbox-runtime/issues/402)
   and [Windows ACL stamping issue](https://github.com/anthropics/sandbox-runtime/issues/457).
6. Once the cause is known, either fix the test configuration/helper and retain
   the Windows leg, or mark only the unsupported assertion as a documented
   limitation. Do not weaken the assertion silently.

## Useful commands

```sh
# Latest run and per-platform jobs
curl -fsSL -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/skrcta/native-sandbox-tests/actions/runs/34099345302' \
  | jq '{id,head_sha,status,conclusion,html_url}'

curl -fsSL -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/skrcta/native-sandbox-tests/actions/runs/34099345302/jobs?per_page=100' \
  | jq -r '.jobs[] | [.id,.name,.status,.conclusion] | @tsv'

# Public check annotations (replace JOB_ID with the Windows job id)
curl -fsSL -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/skrcta/native-sandbox-tests/check-runs/JOB_ID/annotations' \
  | jq -r '.[] | [.annotation_level,.message,.raw_details] | @tsv'

# Local regression on Linux
pnpm test:sandbox
```

## Files to inspect first

- `.github/workflows/sandbox.yml` — matrix and Windows provisioning
- `tests/sandbox-smoke.mjs` — fixture, runtime invocation, and evidence
- `tests/sandbox-child.mjs` — filesystem, child-process, network, and compiler probes
- `README.md` — public scope and limitations
