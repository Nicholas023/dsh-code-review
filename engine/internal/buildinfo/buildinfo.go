// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Package buildinfo exposes build-wide facts that user-facing text in more than
// one package has to agree on.
package buildinfo

// CommandName is the executable name this build is installed as.
//
// It is the single source of truth for the CLI name: every user-facing string
// that names the command — help examples, error hints, runtime notices — must
// derive from it so that what the tool prints is runnable as printed. It lives
// in this leaf package because packages that emit such text but cannot import
// package main (internal/llm, internal/session) share it with the command
// package, which aliases it as commandName.
const CommandName = "codecheck"
