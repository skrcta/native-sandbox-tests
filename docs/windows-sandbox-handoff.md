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

All three legs pass.

## Current state

- Repository: `skrcta/native-sandbox-tests`
- Branch: `main`
- Latest commit: `960b209` (`Give the sandboxed compiler its include and library paths`)
- Latest Actions run: [34104440676](https://github.com/skrcta/native-sandbox-tests/actions/runs/34104440676)
- Latest run result: Linux, macOS, and Windows passed

Windows setup uses the package's `windows-install` command and the bundled
`srt-win` helper. The workflow also installs the MSVC developer environment.
`tests/windows-acl-probe.mjs` runs before the smoke test on Windows only and
is advisory: it records filesystem-policy behavior and never fails the job.

## Resolution

Two defects were in play, and the first was masking the second.

### The read deny was replaced by a write deny

The Windows backend runs the command as a dedicated account and enforces
filesystem policy with explicit ACEs for that account's SID. It keys **one
deny ACE per path**, so a file named in both `denyRead` and `denyWrite`
keeps only the mask applied last. The smoke test named its outside fixture
in both lists.

From inside the sandbox the fixture's DACL was:

```
<host>\srt-sandbox:(DENY)(DE,WD,AD,WEA,WA)
<host>\srt-sandbox:(I)(DENY)(DC)
BUILTIN\Administrators:(I)(F)
NT AUTHORITY\SYSTEM:(I)(F)
BUILTIN\Users:(I)(RX)
```

The surviving deny mask carries delete and write rights and no read bits.
The read then succeeded through the inherited `BUILTIN\Users:(RX)` entry that
the runner's volume root grants every local account.

The fix is to assert each deny rule against its own fixture: reads against
the outside fixture, writes against the context fixture. Both assertions are
kept; they no longer share a target.

The probe records three cases, and each run reproduces them:

| scenario | target listed in | ambient rights | read |
| --- | --- | --- | --- |
| `both-lists` | `denyRead` + `denyWrite` | inherited | allowed |
| `read-only` | `denyRead` | inherited | blocked |
| `isolated` | `denyRead` + `denyWrite` | removed | blocked |

`read-only` isolates the collision: the same ambient rights, the same
target, one list instead of two, and the read is refused. `isolated` shows
the second condition — the collision only becomes observable where the
account has ambient rights to fall back on.

### The sandboxed compiler had no include path

With the deny rules separated, the leg reached the toolchain check and
failed with `C1034: stdio.h: no include path set`. The backend starts the
child from a fresh profile and overlays only `PATH`, `PATHEXT`, and its own
proxy variables. `PATH` carried `cl.exe`, but `INCLUDE`, `LIB`, and `LIBPATH`
never arrived. They are now set inside the command string alongside the
fixture variables.

## Earlier investigation

The original run [34080509207](https://github.com/skrcta/native-sandbox-tests/actions/runs/34080509207)
failed before the smoke test because the workflow used Node 20 while pnpm 11
requires a newer Node release. The workflow was moved to Node 24.

1. macOS needed a writable temporary directory and a usable compiler temp
   location.
2. Windows initially failed during sandbox setup because required environment
   variables and executable/read paths were missing.
3. Windows then failed before the child script started with
   `EPERM: operation not permitted, lstat ...\\Users\\RUNNER~1\\AppData`.
   Moving fixtures to `RUNNER_TEMP` fixed that startup failure. This is the
   same mechanism as the `isolated` probe scenario: the sandbox account has
   no rights on the runner profile, and resolving a script entry point walks
   every parent directory. It is worth remembering that the move to
   `RUNNER_TEMP` is what supplied the ambient `BUILTIN\Users:(RX)` rights
   that later let the collapsed deny mask go unnoticed.

## Important constraints

- Do not add credentials, runner-specific absolute paths, or account names to
  committed diagnostics.
- Keep the public repository vendor-neutral and keep evidence bounded and
  redacted.
- The Windows implementation in the dependency is alpha. Do not claim that a
  successful ACL command means the policy was enforced; the child read/write
  probes are the authoritative checks. The deny-mask collision is the
  concrete instance: `acl stamp` reported `exit=0` and `1 denyRead` applied
  on every failing run.
- GitHub exposes run metadata, jobs, annotations, and artifact metadata without
  authentication, but raw job logs and artifact ZIP downloads require suitable
  repository permissions. Diagnostics that need to be readable from a public
  run must go through check annotations, which is why the probe emits its
  evidence there rather than to stdout alone.
- Unauthenticated API calls are limited to 60 per hour, which is easy to
  exhaust while polling a run.

## Open items

- The deny-mask collision is a dependency defect, not a test defect. It is
  recorded in `README.md` and worth reporting upstream; see the related
  [Windows ACL behavior issue](https://github.com/anthropics/sandbox-runtime/issues/402)
  and [Windows ACL stamping issue](https://github.com/anthropics/sandbox-runtime/issues/457).
  If a later release keys read and write denies separately, the probe's
  `both-lists` row will flip to `blocked` and the two deny rules may share a
  fixture again.
- `ilammy/msvc-dev-cmd@v1` still targets the Node 20 action runtime and is
  the remaining deprecation warning on the Windows job. The other actions
  were moved to releases that target Node 24.

## Useful commands

```sh
# Latest run and per-platform jobs
curl -fsSL -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/skrcta/native-sandbox-tests/actions/runs/34104440676' \
  | jq '{id,head_sha,status,conclusion,html_url}'

curl -fsSL -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/skrcta/native-sandbox-tests/actions/runs/34104440676/jobs?per_page=100' \
  | jq -r '.jobs[] | [.id,.name,.status,.conclusion] | @tsv'

# Public check annotations, including the ACL probe (replace JOB_ID)
curl -fsSL -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/skrcta/native-sandbox-tests/check-runs/JOB_ID/annotations' \
  | jq -r '.[] | [.annotation_level,.title,.message] | @tsv'

# Local regression on Linux (needs bubblewrap and ripgrep)
pnpm test:sandbox

# Windows only
pnpm probe:windows-acl
```

## Files to inspect first

- `.github/workflows/sandbox.yml` — matrix and Windows provisioning
- `tests/sandbox-smoke.mjs` — fixture, runtime invocation, and evidence
- `tests/sandbox-child.mjs` — filesystem, child-process, network, and compiler probes
- `tests/windows-acl-probe.mjs` — standing evidence for the deny-mask limitation
- `README.md` — public scope and limitations
