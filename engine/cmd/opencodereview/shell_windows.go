//go:build windows

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"context"
	"os/exec"

	"github.com/alibaba/open-code-review/internal/sysproc"
)

func shellCommand(ctx context.Context, script string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "cmd", "/c", script)
	sysproc.Hide(cmd)
	return cmd
}
