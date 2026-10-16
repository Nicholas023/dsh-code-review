//go:build !windows

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package sysproc

import "os/exec"

// Hide is a no-op on platforms that have no console-window concept.
func Hide(cmd *exec.Cmd) {}
