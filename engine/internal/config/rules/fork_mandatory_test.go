// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package rules

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// forkMandatoryGolden is the exact preamble the fork shipped before this refactor
// (the fixedReviewRules Go constant at c8ce29d). It pins the byte-for-byte text so
// any wording drift — or a wrong embed path — fails loudly instead of silently
// changing every review. Update it only when the wording is intentionally changed.
const forkMandatoryGolden = `## Mandatory Review Rules (always apply)

Always review the diff against these three mandatory focuses, in addition to any
language-specific rules below. Report every concrete finding with file path, line
range, severity, and a concrete fix suggestion.

1. Security & secrets exposure: flag hardcoded credentials, API keys, tokens,
   passwords, or PII (phone numbers, ID-card numbers, emails); flag internal IPs,
   internal domains and company-private information that would leak when the
   repository is published; flag security vulnerabilities such as SQL injection,
   XSS, path traversal, and missing auth/permission checks.
2. Correctness bugs: logic errors, missing boundary conditions, improper exception
   handling, race conditions in concurrent code, and resource leaks.
3. Redundancy & scope creep: dead code, unused imports or references, duplicated
   logic, and changes unrelated to what the diff claims to do.

Write "N/A" for a focus only when it has nothing to flag for a specific file.`

// TestForkMandatoryDoc_MatchesPreRefactorConstant proves the data move from the
// Go constant to rule_docs/fork_mandatory.md is byte-identical: the loaded,
// newline-trimmed doc must equal the pre-refactor constant verbatim.
func TestForkMandatoryDoc_MatchesPreRefactorConstant(t *testing.T) {
	got, err := loadFixedReviewRules()
	if err != nil {
		t.Fatalf("loadFixedReviewRules: %v", err)
	}
	if got != forkMandatoryGolden {
		t.Errorf("fork_mandatory.md drifted from the pre-refactor constant:\n got %q\nwant %q", got, forkMandatoryGolden)
	}
}

// TestPrefixFixedRules pins the mechanism itself — which stays in Go: empty text
// yields only the fixed part, non-empty text is joined by the exact
// "\n\n---\n\n" separator with the fixed part first.
func TestPrefixFixedRules(t *testing.T) {
	const fixed = "FIXED-PREAMBLE"

	if got := prefixFixedRules("", fixed); got != fixed {
		t.Errorf("empty text: expected only the fixed part, got %q", got)
	}
	got := prefixFixedRules("DOC-BODY", fixed)
	want := fixed + "\n\n---\n\n" + "DOC-BODY"
	if got != want {
		t.Errorf("non-empty text: expected %q, got %q", want, got)
	}
}

// TestForkMandatory_PrependedToEverySystemRule asserts the fork_mandatory preamble
// is prepended, followed by the exact separator, to the default rule AND to every
// path rule — so it is effective no matter which rule resolves.
func TestForkMandatory_PrependedToEverySystemRule(t *testing.T) {
	fixed, err := loadFixedReviewRules()
	if err != nil {
		t.Fatalf("loadFixedReviewRules: %v", err)
	}
	rule, err := LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault: %v", err)
	}

	check := func(name, text string) {
		t.Helper()
		if !strings.HasPrefix(text, fixed) {
			t.Errorf("%s does not start with the fork_mandatory preamble, got %q", name, truncate(text, 80))
			return
		}
		rest := strings.TrimPrefix(text, fixed)
		if !strings.HasPrefix(rest, "\n\n---\n\n") {
			t.Errorf("%s: expected \"\\n\\n---\\n\\n\" right after the preamble, got %q", name, truncate(rest, 40))
		}
	}

	check("default rule", rule.DefaultRule)
	for _, pr := range rule.PathRules {
		check("path rule "+pr.Pattern, pr.Rule)
	}
}

// TestMergeSystemRule_ParagraphOrder pins the section order for a user rule that
// opts into merge_system_rule: the System-Specific section header, then the
// fork_mandatory preamble, then the system language doc, then the User-Specific
// section header, then the user rule text.
func TestMergeSystemRule_ParagraphOrder(t *testing.T) {
	setTestHome(t, t.TempDir())

	dir := t.TempDir()
	ocrDir := filepath.Join(dir, ".opencodereview")
	if err := os.MkdirAll(ocrDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ruleJSON := `{"rules":[{"path":"**/*.go","rule":"project-go-rule","merge_system_rule":true}]}`
	if err := os.WriteFile(filepath.Join(ocrDir, "rule.json"), []byte(ruleJSON), 0o644); err != nil {
		t.Fatalf("write rule.json: %v", err)
	}

	resolver, _, err := NewResolver(dir, "", ResolverOptions{})
	if err != nil {
		t.Fatalf("NewResolver: %v", err)
	}
	got := resolver.Resolve("main.go")

	// Ordering markers. "Go Review Principles" is a heading inside the embedded
	// Go language doc, so it must land after the preamble and before the user rule.
	order := []string{
		"## System-Specific Rules (Mandatory)",
		"## Mandatory Review Rules (always apply)",
		"Go Review Principles",
		"## User-Specific Rules (Mandatory)",
		"project-go-rule",
	}
	prev := -1
	for _, marker := range order {
		idx := strings.Index(got, marker)
		if idx < 0 {
			t.Fatalf("expected marker %q in merged rule, got %q", marker, truncate(got, 160))
		}
		if idx <= prev {
			t.Fatalf("marker %q appears out of order (section order must be: %v)", marker, order)
		}
		prev = idx
	}
}
