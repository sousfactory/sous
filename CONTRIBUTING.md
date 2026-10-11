# Contributing

## Build & verify

Node 22 or newer. The repository is an npm workspace:

- `packages/core`: the engine, published as `sous-factory` (CLI, executor, trackers, `sous-factory/testing`).
- `packages/ui`: the run viewer, private; its build is bundled into the core package.
- `starters/github`: what `sous init` copies into a project; not a workspace, it depends on the published package.

```
npm install
npm run build        # core to dist/, the UI client and server, then the bundle (starter + UI into packages/core)
npm run typecheck    # core and UI
npm test             # core and UI tests, from source
npm run starter:install && npm run starter:test   # the starter against the core just built
```

All five pass before a commit. CI runs the same sequence.

## Verification is unit tests

Every change comes with the test that would have caught its absence, next to
the code it exercises (`packages/*/test`, `starters/github/test`). The starter
is tested as a project: `starter:install` links the built core into it, then
its own `typecheck` and `vitest` run, so a change in the core that breaks a
step shows up there. Steps are tested through the fakes in
`sous-factory/testing` (`ctxOf`, `walk`, `fakeTracker`, `fakeGit`,
`fakeSandbox`); nothing in a test touches git, a tracker or an agent.

Code conventions, as the code shows them:

- Comments say what a thing is for and why it is shaped that way, never how
  it works line by line. No README references in TypeScript.
- The public surface (`sous-factory`, `sous-factory/testing`, step
  authoring types) is documented for the people who write steps.
- READMEs stay short: a step's README is one table and a paragraph.
- One commit per change, on `main`.

## Commit messages

Write commit messages for the maintainer who reads the history after the tracker issue is gone.

- Use a conventional subject: `feat(scope):`, `fix(scope):`, `test(scope):`, `docs(scope):`,
  `refactor(scope):`, or `chore(scope):`.
- Keep the subject imperative, specific, and behavior-focused.
- Start the body with the behavior or problem the change addresses, then explain why the chosen
  shape is correct.
- Record important edge cases, contract boundaries, migrations, compatibility decisions, and
  deliberate tradeoffs.
- No `Co-Authored-By` or other trailers.

## Releasing

Releases go out from GitHub Actions (`.github/workflows/release.yml`), not
from a laptop.

1. Bump `version` in `packages/core/package.json` (semver; the starter's
   `package.json` pins `^` on the major) and push it to `main`.
2. Tag that commit and push the tag: `git tag v<version> && git push origin v<version>`.
   The tag must match the version, or the workflow stops.
3. The workflow builds and tests, then its `publish` job waits for approval
   in the `npm` environment. Approve it on GitHub (the run page, Review
   deployments). It publishes with npm trusted publishing: no token, no
   browser login. `prepublishOnly` runs the full build, so `dist/`, the UI
   and the bundled `starter/` are what ships. A prerelease version
   (`1.2.0-rc.1`) is published under the `next` dist-tag.
4. Check `npm view sous-factory version`.

If npm stages the publish instead of releasing it (the registry then holds a
`0.0.0-stage` placeholder and refuses the version a second time), finish it
with `npx npm@latest stage approve sous-factory@<version>`.
