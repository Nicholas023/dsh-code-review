# codecheck — dsh-code-review review engine (open-code-review fork)

`codecheck` is the code review engine used by the **dsh-code-review** DSH plugin.
It is a **fork** of [alibaba/open-code-review](https://github.com/alibaba/open-code-review)
(Apache-2.0). The upstream command name `ocr` was renamed to `codecheck` to avoid
colliding with "optical character recognition"; the review pipeline itself is
upstream code, reused unchanged except for the fork changes summarized below.

This subtree is the engine only. The plugin (the DSH-facing part: tools, slash
commands, task book, model resolution) lives in the repository root.

- Upstream project: <https://github.com/alibaba/open-code-review>
- This fork: <https://github.com/Nicholas023/dsh-code-review>
- License: Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)
- Fork decision log: [`FORK_NOTES.md`](FORK_NOTES.md)

## What it does

`codecheck` reads a git diff (or whole files, for `scan`), selects the files that
need review, resolves the matching rules, sends each review unit to an LLM
endpoint you configure, and emits structured, line-anchored review comments. It
supports several CLI subcommands — `review`, `scan`, `delegate`, `session`,
`config`, `llm`, `rules`, `viewer`, `completion` — and can write results as text,
JSON, or SARIF.

On top of the upstream pipeline this fork pins **three fixed review rules**, so
the plugin's promise ("security, bugs, dead/irrelevant code") holds regardless of
how the host is configured:

1. **Security & secrets** — hardcoded credentials/keys/tokens, secrets leaked in
   logs or errors, insecure defaults, injection and other security bugs; plus
   desensitization checks for PII (phone numbers, ID numbers, emails, internal
   IPs/domains) that must not end up in a public repository.
2. **Bugs** — logic errors, off-by-one and boundary mistakes, nil/undefined
   handling, error paths that swallow failures, resource leaks, race conditions.
3. **Redundant and unrelated code** — dead code, duplicated logic, leftovers from
   refactors, and scope creep unrelated to the change under review.

## Contract with the DSH plugin

The plugin does **not** write an engine config file. It resolves the review model
from the DSH model configuration, then launches `codecheck` as a child process
with the endpoint injected through the environment:

| Variable | Meaning |
|---|---|
| `OCR_LLM_URL` | OpenAI-compatible (or Anthropic) endpoint URL |
| `OCR_LLM_TOKEN` | API key / bearer token for that endpoint |
| `OCR_LLM_MODEL` | Model id to review with |
| `OCR_LLM_PROTOCOL` | `openai` (chat completions) or `anthropic` |
| `OCR_LLM_TIMEOUT` | Per-request LLM timeout, in **seconds** |
| `OCR_LLM_EXTRA_BODY` | JSON merged into the request body (e.g. provider-specific knobs) |

When any of `OCR_LLM_URL` / `OCR_LLM_TOKEN` / `OCR_LLM_MODEL` is set from the
environment, it takes precedence over a config file. If no endpoint can be
resolved at all, `codecheck` **fails loudly** with a message telling you to
configure one — it never silently falls back to a vendor's paid API.

The plugin additionally relies on two fork behaviours while spawning the engine:

- on Windows the engine's subprocesses are hidden (no console windows);
- process trees are terminated cross-platform, so a cancelled review does not
  leave orphaned git/LLM processes behind.

## Build

**`scripts/build-fork.sh` is the only supported build path.** It is the single
source of truth: it reads the plugin version from the repository root
`package.json`, computes the engine fork counter, and stamps the binary — nothing
about the version is hand-typed into the Go source.

```bash
# from the repository root
bash engine/scripts/build-fork.sh
./bin/codecheck --version
```

The stamped version is `<plugin version>+fork.<N>`, where `N` is
`git rev-list --no-merges --count HEAD -- engine/` (the Nth commit touching the
engine subtree). See [`FORK_NOTES.md`](FORK_NOTES.md) for the exact definition.

Requirements: **Go 1.26+** and **git >= 2.41**.

### Other platforms

`build-fork.sh` honours `GOOS` / `GOARCH` and appends a `.exe` suffix only when
the target OS is Windows:

```bash
GOOS=linux   GOARCH=amd64 bash engine/scripts/build-fork.sh   # -> bin/codecheck
GOOS=darwin  GOARCH=arm64 bash engine/scripts/build-fork.sh   # -> bin/codecheck
GOOS=windows GOARCH=amd64 bash engine/scripts/build-fork.sh   # -> bin/codecheck.exe
OUTPUT=/tmp/codecheck bash engine/scripts/build-fork.sh       # explicit path
```

The build uses `CGO_ENABLED` from the environment as-is; set `CGO_ENABLED=0` if
you need a fully static binary.

## Attribution and license

This subtree contains software developed at Alibaba Group. The upstream project,
its copyright, and the Apache-2.0 license are preserved here:

- [`LICENSE`](LICENSE) — the full upstream Apache-2.0 text, kept as-is.
- [`NOTICE`](NOTICE) — fork name, upstream project, copyright, and the summary of
  changes required by Apache-2.0 §4(b).
- Every source file keeps its upstream `SPDX-License-Identifier: Apache-2.0` and
  copyright header.

If you redistribute this engine on its own, ship `LICENSE` and `NOTICE` with it.
The changes made by this fork are listed in [`NOTICE`](NOTICE) and
[`FORK_NOTES.md`](FORK_NOTES.md); the module path is intentionally **not**
changed from `github.com/alibaba/open-code-review`.
