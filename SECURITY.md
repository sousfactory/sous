# Security

sous runs coding agents on your machine with your credentials: the agent
CLI, `gh`, git. A bug that lets an agent act outside its worktree, lets a
step run with inputs it should not see, or exposes a token through the run
record or the UI is a security problem, and we want to hear about it
privately first.

**Report it** through a
[private security advisory](https://github.com/sousfactory/sous/security/advisories/new)
on GitHub. Only the maintainers see it. Please do not open a public issue
or discussion for it.

**What to include:** the `sous-factory` version, what an attacker needs
(a crafted issue body, a step in the repository, access to the machine),
what they get, and how to reproduce it. A flow and step that show it are
ideal.

**What to expect:** an acknowledgement within a few days, a fix or a
mitigation in the next release, and credit in the advisory if you want it.

**Supported versions:** the latest release on npm. sous is pre-1.0; fixes
ship forward, not as patches to older minors.

**Out of scope:** what the agents themselves do with the tools you give
them. sous confines an agent to a worktree and judges its output, but the
agent CLI runs with your user's permissions, and a prompt or skill you
wrote is yours. The [manual's execution chapter](docs/manual.md#8-execution)
describes the sandbox and its limits.
