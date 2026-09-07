# Native Sandbox Tests

Small experiments for evaluating native process isolation on Linux, macOS, and Windows.

The tests focus on observable behavior: filesystem access, process boundaries, network policy, cancellation, and native toolchain compatibility. Results apply only to the platform, runtime, and policy that were actually tested.

This repository is experimental. It is not a security certification, a general-purpose sandbox, or a guarantee that an untrusted process cannot compromise a host.

## Scope

- Use synthetic fixtures and deterministic checks.
- Test writable workspaces and protected files separately.
- Exercise child processes and indirect filesystem access where practical.
- Check that a denied network destination is unreachable under an empty allowlist.
- Build and run a small native program on each platform.
- Record cleanup, skipped checks, and failures.

Platform-specific behavior should be implemented and reported separately. A virtualized environment does not establish the behavior of the corresponding native host.

## Evidence

For each run, record the test revision, runtime version, runner image, operating system, architecture, toolchain versions, applied policy, individual assertions, exit status, and limitations. Preserve useful failure output as well as passing output.

Generated output belongs under `artifacts/`. Do not commit credentials, tokens, private account data, or machine-specific secrets. Use synthetic fixtures for tests and review logs before sharing them.

## Known limitations

On Windows the sandbox runs the command as a dedicated account and enforces
filesystem policy with explicit ACEs for that account's SID. One deny ACE is
keyed per path, so a file listed under both `denyRead` and `denyWrite` keeps
only the mask applied last. Observed on `@anthropic-ai/sandbox-runtime@0.0.75`:
the surviving mask was write-only (`DE,WD,AD,WEA,WA`), and the read then
succeeded through an inherited `BUILTIN\Users:(RX)` entry from the volume
root. The two deny rules are therefore asserted against separate fixtures.

This also means a read deny is load-bearing only where the account has no
ambient rights. On a volume whose root grants every local user read access,
removing the world-readable groups from the fixture blocks the read on its
own. `tests/windows-acl-probe.mjs` records all three cases.

## Status

A basic smoke test and continuous-integration workflow are included. Coverage will expand as the evaluation develops.

The workflow runs on GitHub-hosted Linux, macOS, and Windows runners. It uses synthetic fixtures and does not require model credentials.
