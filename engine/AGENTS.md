# Agent Guidelines for the codecheck engine

`engine/` is the **fork** of alibaba/open-code-review that powers this plugin; the
command and binary are renamed to `codecheck`. This fork evolves on its own and
**does not track upstream**, so upstream release tooling and community documents
have been stripped — do not add them back.

Conventions for this directory:

- **Keep the SPDX and copyright headers.** Every source file carries
  `SPDX-License-Identifier: Apache-2.0` and the upstream copyright line; these
  are the Apache-2.0 attribution obligation and must never be removed or
  rewritten. `engine/LICENSE` is likewise retained for the same reason.
- **Comments are English.** Comments, identifiers and strings stay in ASCII
  English; `scripts/verify-english-only.go` enforces this (run via
  `make english-check`).
- **`go test` must be green.** Do not land changes that leave a package failing;
  add or adjust tests alongside the code.
