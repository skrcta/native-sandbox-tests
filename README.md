# Native Sandbox Tests

Small experiments for evaluating native process isolation on Linux, macOS, and Windows.

The tests focus on observable behavior: filesystem access, process boundaries, network policy, cancellation, and native toolchain compatibility. Results apply only to the platform, runtime, and policy that were actually tested.

This repository is experimental. It is not a security certification, a general-purpose sandbox, or a guarantee that an untrusted process cannot compromise a host.

## Scope

- Use synthetic fixtures and deterministic checks.
- Test writable workspaces and protected files separately.
- Exercise child processes and indirect filesystem access where practical.
- Check allowed and denied network destinations independently.
- Build and run a small native program on each platform.
- Record cancellation, cleanup, skipped checks, and failures.

Platform-specific behavior should be implemented and reported separately. A virtualized environment does not establish the behavior of the corresponding native host.

## Evidence

For each run, record the test revision, runtime version, runner image, operating system, architecture, toolchain versions, applied policy, individual assertions, exit status, and limitations. Preserve useful failure output as well as passing output.

Generated output belongs under `artifacts/`. Do not commit credentials, tokens, private account data, or machine-specific secrets. Use synthetic fixtures for tests and review logs before sharing them.

## Status

The repository is initialized for experiments. Test code, dependencies, and continuous-integration workflows will be added as the evaluation develops.
