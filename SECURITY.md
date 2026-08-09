# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** rather than opening a
public issue.

Use GitHub's private vulnerability reporting:
[Security tab → "Report a vulnerability"](https://github.com/jvrck/wux-review/security/advisories/new).
This keeps details private until a fix is available.

Please include:

- a description of the issue and its impact;
- the wux-review version (`wux-review --version`) and your platform;
- steps to reproduce, ideally a minimal proof of concept.

You can expect an initial acknowledgement within a few days. There is no bug
bounty program.

## Supported versions

wux-review ships standalone [CalVer](https://calver.org) release binaries. Only
the latest release is supported; fixes ship in a new release rather than as
backports to older tags.

## Dependency scanning

wux-review scans dependencies in CI and at release time. See
[docs/security.md](docs/security.md) for the scanning policy, gate behavior, and
suppression requirements.
