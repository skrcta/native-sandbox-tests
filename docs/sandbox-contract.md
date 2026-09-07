# Sandbox contract

**Contract revision:** `0.1`

This document defines the observable behavior that Mustercraft may expect from
a native sandbox backend. It describes the tested contract for this repository;
it is not a security certification or a promise that every host configuration
has identical behavior.

## Invocation

A backend accepts a command, working directory, environment, and filesystem and
network policy. It must:

- start the command inside the selected native isolation mechanism;
- return the command's exit status or terminating signal;
- apply the policy to descendants of the command; and
- release temporary policy state and fixture resources after the run.

If the configuration or backend cannot be applied, the run is a failure. The
controller must not silently continue as if an unrestricted command had run.

## Filesystem behavior

The contract is expressed with synthetic files and directories:

- an allowed read target can be read;
- an allowed write root permits creation and modification;
- a `denyRead` target cannot be read;
- a `denyWrite` target cannot be modified; and
- denied targets remain unchanged after the run.

Read and write assertions use separate targets. On Windows with
`@anthropic-ai/sandbox-runtime@0.0.75`, a path present in both deny lists can
receive only one deny mask. The resulting read behavior is recorded as a known
limitation by `tests/windows-acl-probe.mjs` and is not part of the supported
contract.

The contract does not claim that a Windows sandbox has default-deny access to
every path on a host. Ambient NTFS permissions and the selected runner volume
remain relevant. Any stronger guarantee must be stated as a backend-specific
capability and tested separately.

## Process behavior

The test command starts a child process. The child must observe the same
filesystem and network restrictions, and it must be able to use an explicitly
allowed workspace. A passing parent process with an unrestricted child is a
failed run.

## Network behavior

With an empty network allowlist, a direct request to the test destination must
not succeed. A DNS lookup alone is not treated as network access; the
connection attempt must be refused, blocked, or otherwise fail closed.

The test does not use credentials or depend on an external service being
available.

## Native toolchain behavior

Each platform invokes its available native compiler and runs the resulting
program inside the sandbox. Toolchain environment is part of the invocation
input. On Windows this includes `INCLUDE`, `LIB`, and `LIBPATH` when supplied by
the developer environment; `PATH` alone is insufficient for MSVC.

## Evidence

Every run should retain a small machine-readable record containing:

- contract revision and repository commit;
- runtime package and lockfile version;
- runner image, operating system, architecture, and toolchain versions;
- the applied policy, with secrets and host-specific identifiers removed;
- one status per assertion;
- overall status, exit status, and timestamps; and
- limitations or skipped checks.

The record belongs under `artifacts/`. Passing output and useful failure output
may be published through bounded, redacted CI annotations. The repository must
not contain credentials, tokens, private account data, or unredacted machine
paths.

A minimal record has this shape:

```json
{
  "contract": "sandbox-v0.1",
  "commit": "<revision>",
  "runtime": "<package>@<version>",
  "platform": "<os>/<arch>",
  "policy": { "allowedDomains": [], "writableRoots": ["workspace"] },
  "checks": [
    { "id": "filesystem.read-deny", "status": "passed" },
    { "id": "process.child-inherits-policy", "status": "passed" }
  ],
  "status": "passed",
  "limitations": []
}
```

## Backend capability reporting

Mustercraft should treat the common contract as a set of capabilities rather
than assuming complete parity:

| Backend | Native mechanism | Current tested status |
| --- | --- | --- |
| Linux | bubblewrap plus proxy isolation | contract passes |
| macOS | Seatbelt plus proxy isolation | contract passes |
| Windows | dedicated account, ACLs, and WFP | contract passes with the documented overlapping-deny limitation |

When a backend skips or weakens a capability, its evidence record must say so.
The controller can then decide whether that capability is acceptable for the
requested task.

## Current validation

The contract is exercised by `tests/sandbox-smoke.mjs` and the Windows-specific
compatibility evidence is collected by `tests/windows-acl-probe.mjs`. The
workflow currently validates all three backends on GitHub-hosted runners.
