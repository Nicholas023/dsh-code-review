// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// TestArgCountErrors_AreActionable verifies that a wrong positional-argument
// count reports what the command expects instead of Cobra's raw
// "accepts 2 arg(s), received 1". Because the root command sets SilenceUsage,
// the guidance has to travel inside the error itself.
//
// See: https://github.com/alibaba/open-code-review/issues/890
func TestArgCountErrors_AreActionable(t *testing.T) {
	name := rootCmd.Name()
	tests := []struct {
		name string
		args []string
		want []string // substrings expected in the error message
	}{
		{
			name: "config set with no args",
			args: []string{"config", "set"},
			want: []string{
				fmt.Sprintf(`"%[1]s config set" requires exactly 2 argument(s) (<key> <value>)`, name),
				fmt.Sprintf("Usage:\n  %s config set <key> <value>", name),
				"Example:",
				fmt.Sprintf("%s config set provider anthropic", name),
				fmt.Sprintf("Run '%s config set --help' for more information.", name),
			},
		},
		{
			name: "config set missing value",
			args: []string{"config", "set", "provider"},
			want: []string{
				`requires exactly 2 argument(s) (<key> <value>)`,
				fmt.Sprintf("Usage:\n  %s config set <key> <value>", name),
			},
		},
		{
			// Too many arguments reports the same expectation as too few: the
			// requirement and how to write it, without echoing the count back.
			name: "config set with too many args",
			args: []string{"config", "set", "provider", "anthropic", "extra"},
			want: []string{
				`requires exactly 2 argument(s) (<key> <value>)`,
				fmt.Sprintf("Usage:\n  %s config set <key> <value>", name),
			},
		},
		{
			// maximumArgs: `session export` takes an optional session id, so
			// only the too-many case is an error.
			name: "session export with too many args",
			args: []string{"session", "export", "one", "two"},
			want: []string{
				fmt.Sprintf(`"%[1]s session export" accepts at most 1 argument(s)`, name),
				fmt.Sprintf("Usage:\n  %s session export [flags] [session-id]", name),
				"Example:",
				fmt.Sprintf("%s session export -o review.html", name),
				fmt.Sprintf("Run '%s session export --help' for more information.", name),
			},
		},
		{
			name: "config unset with no args",
			args: []string{"config", "unset"},
			want: []string{
				fmt.Sprintf(`"%[1]s config unset" requires exactly 1 argument(s) (<key>)`, name),
				"Example:",
			},
		},
		{
			name: "rules check with no args",
			args: []string{"rules", "check"},
			want: []string{
				fmt.Sprintf(`"%[1]s rules check" requires exactly 1 argument(s) (<file-path>)`, name),
				fmt.Sprintf("Usage:\n  %s rules check", name),
				"Example:",
			},
		},
		{
			name: "session show with no args",
			args: []string{"session", "show"},
			want: []string{
				fmt.Sprintf(`"%[1]s session show" requires exactly 1 argument(s) (<session-id>)`, name),
				fmt.Sprintf("Run '%s session show --help' for more information.", name),
			},
		},
		{
			name: "session comments with no args",
			args: []string{"session", "comments"},
			want: []string{fmt.Sprintf(`"%[1]s session comments" requires exactly 1 argument(s) (<session-id>)`, name)},
		},
		{
			name: "delegate rule with no args",
			args: []string{"delegate", "rule"},
			want: []string{
				fmt.Sprintf(`"%[1]s delegate rule" requires at least 1 argument(s) (<path...>)`, name),
				fmt.Sprintf("Usage:\n  %s delegate rule", name),
			},
		},
		{
			// completion enumerates its values inline in Use, so they are reported
			// once from ValidArgs rather than repeated in the signature.
			name: "completion with no args lists valid values",
			args: []string{"completion"},
			want: []string{
				fmt.Sprintf(`"%[1]s completion" requires exactly 1 argument(s)`, name),
				"Valid values: bash, zsh, fish, powershell",
			},
		},
		{
			// Flags do not count as positional arguments, so declaring one does
			// not satisfy the requirement.
			name: "flags do not satisfy the positional requirement",
			args: []string{"rules", "check", "--rule", "custom.json"},
			want: []string{fmt.Sprintf(`"%[1]s rules check" requires exactly 1 argument(s) (<file-path>)`, name)},
		},
		{
			// Reached through an alias, the error names the canonical path. That
			// matches what the delegate rule help prints, so the two stay in step.
			name: "alias reports the canonical command path",
			args: []string{"d", "rule"},
			want: []string{
				fmt.Sprintf(`"%[1]s delegate rule" requires at least 1 argument(s) (<path...>)`, name),
				fmt.Sprintf("Usage:\n  %s delegate rule", name),
			},
		},
		{
			name: "sessions alias reports the canonical command path",
			args: []string{"sessions", "show"},
			want: []string{fmt.Sprintf(`"%[1]s session show" requires exactly 1 argument(s) (<session-id>)`, name)},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rootCmd.SetArgs(tt.args)
			// Execute really parses flags, so a case that declares one leaves it
			// bound to its package-level variable and would leak into later tests.
			t.Cleanup(func() {
				rootCmd.SetArgs(nil)
				rulesCheckRulePath = ""
			})

			err := rootCmd.Execute()
			if err == nil {
				t.Fatalf("expected error for args %v, got nil", tt.args)
			}
			got := err.Error()
			for _, want := range tt.want {
				if !strings.Contains(got, want) {
					t.Errorf("error message missing %q\n--- full message ---\n%s", want, got)
				}
			}
			if strings.Contains(got, "arg(s)") {
				t.Errorf("error still uses Cobra's raw wording: %q", got)
			}
			// The supplied count tells the user nothing they cannot see in the
			// line they just typed; the message should only carry guidance.
			if strings.Contains(got, "received") {
				t.Errorf("error echoes the supplied argument count back: %q", got)
			}
		})
	}
}

// TestArgCountErrors_MatchHelpOutput guards the property that makes this
// approach maintainable: the usage line in the error is the command's own
// UseLine, so it cannot drift away from what --help prints.
func TestArgCountErrors_MatchHelpOutput(t *testing.T) {
	for _, path := range [][]string{
		{"config", "set"},
		{"config", "unset"},
		{"rules", "check"},
		{"session", "show"},
		{"session", "comments"},
		{"delegate", "rule"},
		{"completion"},
	} {
		name := strings.Join(path, " ")
		t.Run(name, func(t *testing.T) {
			cmd, _, err := rootCmd.Find(path)
			if err != nil {
				t.Fatalf("find %q: %v", name, err)
			}
			argErr := argCountError(cmd, "requires exactly 1 argument(s)")
			if !strings.Contains(argErr.Error(), cmd.UseLine()) {
				t.Errorf("error does not carry UseLine %q:\n%s", cmd.UseLine(), argErr)
			}
			if !strings.Contains(argErr.Error(), cmd.CommandPath()) {
				t.Errorf("error does not name the command path %q", cmd.CommandPath())
			}
		})
	}
}

// TestEveryPositionalCommandUsesFriendlyErrors walks the whole command tree and
// fails if a command that declares positional placeholders in Use still reports
// Cobra's raw count message. This is what keeps a newly added command from
// silently regressing: wiring it to cobra.ExactArgs directly trips this test.
func TestEveryPositionalCommandUsesFriendlyErrors(t *testing.T) {
	var walk func(cmd *cobra.Command)
	walk = func(cmd *cobra.Command) {
		for _, sub := range cmd.Commands() {
			walk(sub)
		}
		if cmd.Args == nil || positionalSignature(cmd) == "" {
			return
		}
		// Passing no arguments must trip the requirement for any command that
		// declares a placeholder, and the resulting message must be the friendly
		// one. Commands whose placeholders are all optional legitimately accept
		// zero arguments, so a nil error is not a failure.
		err := cmd.Args(cmd, nil)
		if err == nil {
			return
		}
		if strings.Contains(err.Error(), "arg(s)") {
			t.Errorf("%q still reports Cobra's raw count message; use exactArgs/minimumArgs instead:\n%s",
				cmd.CommandPath(), err)
		}
		if !strings.Contains(err.Error(), cmd.UseLine()) {
			t.Errorf("%q arg error omits its own usage line %q:\n%s",
				cmd.CommandPath(), cmd.UseLine(), err)
		}
	}
	walk(rootCmd)
}

// TestValidInvocationsStillResolve is a regression guard: swapping the
// validators must not reject argument counts that were previously accepted.
func TestValidInvocationsStillResolve(t *testing.T) {
	tests := []struct {
		name      string
		validator cobra.PositionalArgs
		args      []string
	}{
		{"exact 1 with 1", exactArgs(1), []string{"a"}},
		{"exact 2 with 2", exactArgs(2), []string{"a", "b"}},
		{"minimum 1 with 1", minimumArgs(1), []string{"a"}},
		{"minimum 1 with 3", minimumArgs(1), []string{"a", "b", "c"}},
		{"maximum 1 with 0", maximumArgs(1), nil},
		{"maximum 1 with 1", maximumArgs(1), []string{"a"}},
	}

	cmd := &cobra.Command{Use: "demo <x>"}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.validator(cmd, tt.args); err != nil {
				t.Errorf("expected %v to be accepted, got %v", tt.args, err)
			}
		})
	}
}

func TestPositionalSignature(t *testing.T) {
	tests := []struct {
		name string
		use  string
		want string
	}{
		{"two placeholders", "set <key> <value>", "<key> <value>"},
		{"flags marker is dropped", "rule [flags] <path...>", "<path...>"},
		{"inline enumeration is dropped", "completion [bash|zsh|fish]", ""},
		{"command name only", "version", ""},
		{"placeholder after flags marker", "show [flags] <session-id>", "<session-id>"},
		{"empty use", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := positionalSignature(&cobra.Command{Use: tt.use}); got != tt.want {
				t.Errorf("positionalSignature(%q) = %q, want %q", tt.use, got, tt.want)
			}
		})
	}
}

func TestValidArgNames(t *testing.T) {
	tests := []struct {
		name  string
		valid []string
		want  []string
	}{
		{"plain values", []string{"bash", "zsh"}, []string{"bash", "zsh"}},
		{"tab-separated descriptions are stripped", []string{"bash\tBourne again shell", "zsh\tZ shell"}, []string{"bash", "zsh"}},
		// Values pass through as cobra.OnlyValidArgs sees them, so the listed
		// values are exactly the accepted ones.
		{"values are not otherwise altered", []string{"bash", " fish"}, []string{"bash", " fish"}},
		{"none", nil, nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validArgNames(tt.valid)
			if len(got) != len(tt.want) {
				t.Fatalf("validArgNames(%v) = %v, want %v", tt.valid, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("validArgNames(%v)[%d] = %q, want %q", tt.valid, i, got[i], tt.want[i])
				}
			}
		})
	}
}
