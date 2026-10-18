// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import "github.com/alibaba/open-code-review/internal/buildinfo"

// commandName is the single source of truth for this CLI's executable name, as
// seen by this package.
//
// Every user-facing string that tells a user what to type — help examples,
// error hints, runtime notices, shell-completion snippets — must be built from
// this value so that what the tool prints is always runnable as printed. Do not
// write the name as a literal anywhere a user could read it; derive it from
// this constant instead.
//
// The value is defined once in internal/buildinfo so that packages emitting
// user-facing text but unable to import package main (internal/llm,
// internal/session) can share the same single source of truth. The cobra root
// command in root.go must stay in step with it; TestCommandNameSourcesAgree
// and TestNoStaleCommandNameInUserFacingText fail the build if any of the three
// drifts apart or a stale literal reappears in user-facing text.
const commandName = buildinfo.CommandName
