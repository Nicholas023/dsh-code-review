//go:build windows

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Package sysproc centralizes per-platform subprocess attributes.
//
// Why: the engine is launched by GUI hosts that own no console. On Windows,
// starting a console program (git, cmd) makes the OS allocate a new visible
// console window, so a review issuing hundreds of git commands flashes windows
// over the user's screen. Setting HideWindow suppresses that window. The
// non-Windows build is a no-op; see sysproc_unix.go.
package sysproc

import (
	"os/exec"
	"syscall"
)

// Hide marks cmd so the child process it starts creates no visible console
// window. It must be called before cmd.Start/Run.
func Hide(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}
