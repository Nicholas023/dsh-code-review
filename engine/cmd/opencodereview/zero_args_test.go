// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestZeroArgumentCommands_RejectUnexpectedArgs(t *testing.T) {
	tests := []struct {
		name    string
		command *cobra.Command
		// path is the subcommand path below the root command; the executable
		// name is prepended from rootCmd.Name() so this test cannot pin a
		// stale binary name.
		path string
	}{
		{name: "version", command: versionCmd, path: "version"},
		{name: "llm test", command: llmTestCmd, path: "llm test"},
		{name: "llm providers", command: llmProvidersCmd, path: "llm providers"},
		{name: "session list", command: sessionListCmd, path: "session list"},
		{name: "delegate preview", command: delegatePreviewCmd, path: "delegate preview"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := rootCmd.Name() + " " + tt.path
			if tt.command.Args == nil {
				t.Fatalf("%s does not define positional argument validation", path)
			}

			err := tt.command.Args(tt.command, []string{"unexpected"})
			if err == nil {
				t.Fatalf("expected an error for unexpected positional argument")
			}

			want := `unknown command "unexpected" for "` + path + `"`
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("error = %q, want it to contain %q", err, want)
			}
		})
	}
}
