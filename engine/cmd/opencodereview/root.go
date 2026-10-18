// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"fmt"
	"os"
	"runtime"

	"github.com/alibaba/open-code-review/internal/gitcmd"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	// Fork rename (this project): command name "ocr" -> "codecheck" to avoid
	// colliding with optical character recognition naming. Upstream attribution
	// (OpenCodeReview brand) is preserved.
	Use:   "codecheck",
	Short: "codecheck — AI-powered code review engine (fork of OpenCodeReview)",
	Long: `codecheck — AI-powered code review engine (fork of OpenCodeReview)

Reads git diffs, sends them to a configurable LLM service, and generates
review comments.

Fork of alibaba/open-code-review (Apache-2.0); the command name is codecheck
instead of upstream's ocr, which collides with optical character
recognition.`,
	SilenceUsage:  true,
	SilenceErrors: true,
	// Runs for every subcommand, always before any RunE: validate --color once
	// flags are parsed, then resolve the color decision from them, and for
	// commands that need git, check the installed git version (warning, not
	// failing).
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		if err := validateColorMode(colorMode); err != nil {
			return err
		}
		colorEnabled = resolveColor()
		if !commandNeedsGit(cmd) {
			return nil
		}
		if err := gitcmd.CheckGitVersion(); err != nil {
			fmt.Fprintf(os.Stderr, "warning: %v\n", err)
		}
		return nil
	},
	RunE: func(cmd *cobra.Command, args []string) error {
		v, _ := cmd.Flags().GetBool("version")
		if v {
			printVersion()
			return nil
		}
		return cmd.Help()
	},
}

func init() {
	rootCmd.SetFlagErrorFunc(flagErrorWithSuggestion)
	rootCmd.Flags().BoolP("version", "V", false, "print version information")
	addColorFlags(rootCmd)

	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(reviewCmd)
	rootCmd.AddCommand(scanCmd)
	rootCmd.AddCommand(delegateCmd)
	rootCmd.AddCommand(sessionCmd)
	rootCmd.AddCommand(configCmd)
	rootCmd.AddCommand(llmCmd)
	rootCmd.AddCommand(rulesCmd)
	rootCmd.AddCommand(viewerCmd)
	rootCmd.AddCommand(completionCmd)
}

func commandNeedsGit(cmd *cobra.Command) bool {
	topLevel := cmd
	for topLevel.Parent() != nil && topLevel.Parent().Parent() != nil {
		topLevel = topLevel.Parent()
	}
	switch topLevel.Name() {
	case "review", "scan", "delegate":
		return true
	default:
		return false
	}
}

func versionString() string {
	s := fmt.Sprintf("open-code-review %s", Version)
	if GitCommit != "" {
		s += fmt.Sprintf(" (%s)", GitCommit)
	}
	s += fmt.Sprintf(" %s/%s\n", runtime.GOOS, runtime.GOARCH)
	if BuildDate != "" {
		s += fmt.Sprintf("built at: %s\n", BuildDate)
	}
	s += "https://github.com/alibaba/open-code-review\n"
	return s
}
