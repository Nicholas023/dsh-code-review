# FORK_NOTES — codecheck engine

This directory (`engine/`) is a **fork** of
[alibaba/open-code-review](https://github.com/alibaba/open-code-review). These
notes record what this fork is, what it changed, and the decisions a future
maintainer must not silently undo.

## Fork origin

The upstream source (open-code-review, Apache-2.0) was imported into this
repository under `engine/` in commit `635b111`
("feat(engine): fork open-code-review 为 codecheck 引擎并焊入三条固定评审规则"),
a snapshot of the upstream tree at the v1.12.13-era HEAD. The upstream `.git`,
`.github/`, assistant-config directories, and the frontend extensions were not
imported.

## What this fork changes

1. **Renamed the command** `ocr` → `codecheck` (and the `[ocr]` log prefix →
   `[codecheck]`), so it no longer collides with "optical character
   recognition". Attribution to the upstream project is preserved everywhere
   (see `NOTICE`, `LICENSE`, and the `--version` output).
2. **Three fixed review rules are hard-wired ahead of `LoadDefault`**, so they
   apply with zero configuration: security & desensitization, bug finding, and
   redundant / out-of-scope code.
3. **Windows ergonomics**: the engine spawns its subprocesses hidden (no console
   windows), and terminates child **process trees** cross-platform so a
   cancelled review leaves no orphaned `git`/LLM processes.
4. **Removed the ChatGPT account (OAuth) channel** that upstream ships
   (`internal/chatgptauth/`, `cmd/opencodereview/chatgpt_auth.go`,
   `internal/llm/chatgpt.go`).

Retained from upstream unchanged: the sensitive-path exclusion (files matching
`.ssh`, private keys, `.env`, etc. are never sent to the model), and the
deterministic file selection / rule matching pipeline.

## Decision: the Go module path is NOT renamed

The module stays `github.com/alibaba/open-code-review` on purpose. Renaming it
would touch every import in the tree (hundreds of files) for **zero functional
benefit**, and a mechanical rewrite of that size is pure regression risk. The
fork identity is carried by the command name, the version string, and `NOTICE` —
not by the import path.

## Version and build scheme

The binary is stamped with a version of the form:

```
<plugin version>+fork.<N>
```

- `<plugin version>` is read from the **repository root `package.json`**
  (`version` field) — the single source of truth for the version number.
- `<N>` = `git rev-list --no-merges --count HEAD -- engine/`, i.e. how many
  commits in this repository have touched the `engine/` subtree. So
  `0.1.1+fork.3` means "plugin version 0.1.1, engine subtree at its 3rd commit".
- The build also stamps `g<short-sha>` (`git rev-parse --short HEAD`) and the UTC
  build time (`date -u +%Y-%m-%dT%H:%M:%SZ`).

**`engine/scripts/build-fork.sh` is the only supported build path** and the only
place these values are assembled. Nothing about the version is hand-typed into
the Go source; `main.Version` / `main.GitCommit` / `main.BuildDate` come only
from `-ldflags` set by that script. `codecheck --version` prints:

```
codecheck <plugin version>+fork.<N> (g<short-sha>) <os>/<arch>
built at <UTC timestamp>
fork of open-code-review (Apache-2.0) — https://github.com/alibaba/open-code-review
```

## This fork does not track upstream

This fork has **diverged and evolves independently**. There is no rebase-on-
upstream or upstream-snapshot-tracking step: upstream changes are not merged in
wholesale. If an upstream fix is wanted, port it deliberately and re-run
`engine/scripts/build-fork.sh`; do not reintroduce a tracking workflow.

The User-Agent sent to LLM endpoints is `open-code-review-fork/<version>`, so
requests are attributable to this fork rather than upstream.
