// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/alibaba/open-code-review/internal/buildinfo"
)

// staleCommandNameAllowlist lists the production files that may legitimately
// keep the literal "ocr" in a string. Each entry is a persisted or externally
// consumed contract, not user-facing command text; renaming it would break
// compatibility, so the guard must not flag it.
var staleCommandNameAllowlist = map[string]string{
	"internal/telemetry/metrics.go":       "OTel metric names (ocr.*): consumed by external monitoring/backends; renaming breaks existing dashboards.",
	"internal/session/manifest.go":        "RunManifest SchemaVersion \"ocr.run-manifest/v1\": persisted in session JSONL and read back by the viewer and resume logic.",
	"internal/session/resume_identity.go": "ResumeLineage SchemaVersion \"ocr.resume-lineage/v1\": persisted in session files and consumed on resume.",
	"internal/llm/retry_report.go":        "RetryReportSchemaVersion \"ocr.llm-retry-report/v1\": embedded in --format json output; consumed by CI and host agents.",
	"internal/llm/retry_meta.go":          "logicalRequestIDVersion \"ocr.llm-request/v1\": persisted request identity.",
	// root.go is owned by a separate workflow; this PR must not edit it. Its
	// remaining stale literal ("version for ocr") is recorded as a follow-up in
	// the PR description. Remove this entry once that file is fixed.
	"cmd/opencodereview/root.go": "owned by the root-command workflow; stale literal tracked as a follow-up outside this PR.",
}

// staleCommandNamePattern matches the old executable name as a standalone token
// ("ocr" bounded by non-identifier characters), which covers `ocr review`,
// `run 'ocr config model'`, `_ocr`, and `version for ocr`, while leaving things
// like "opencodereview" or the OCR_* environment variables alone.
var staleCommandNamePattern = regexp.MustCompile(`(^|[^0-9A-Za-z_])ocr([^0-9A-Za-z_]|$)`)

// TestNoStaleCommandNameInUserFacingText scans the string literals of the
// production sources under cmd/ and internal/ and fails when one still names the
// old executable ("ocr") as a standalone token. User-facing text must derive
// from commandName/buildinfo.CommandName so that what the tool prints is
// runnable as printed.
//
// Test-only sources are not scanned: they assert against the production text
// (and are themselves the regression guard for it) and legitimately contain
// fixture strings such as "ocr-test-*" or "OCR_LLM_TOKEN" that are not the
// command name.
func TestNoStaleCommandNameInUserFacingText(t *testing.T) {
	engineRoot := filepath.Join("..", "..")
	for _, dir := range []string{filepath.Join(engineRoot, "cmd"), filepath.Join(engineRoot, "internal")} {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			rel, relErr := filepath.Rel(engineRoot, path)
			if relErr != nil {
				return relErr
			}
			rel = filepath.ToSlash(rel)
			if _, allowed := staleCommandNameAllowlist[rel]; allowed {
				return nil
			}
			return checkFileForStaleCommandName(t, path, rel)
		})
		if err != nil {
			t.Fatalf("scan %s: %v", dir, err)
		}
	}
}

func checkFileForStaleCommandName(t *testing.T, path, rel string) error {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
	if err != nil {
		return err
	}
	ast.Inspect(file, func(n ast.Node) bool {
		lit, ok := n.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		value, unquoteErr := strconv.Unquote(lit.Value)
		if unquoteErr != nil {
			return true
		}
		if staleCommandNamePattern.MatchString(value) {
			pos := fset.Position(lit.Pos())
			t.Errorf("%s:%d: user-facing text still names the old executable \"ocr\": %q (derive it from commandName instead)",
				rel, pos.Line, value)
		}
		return true
	})
	return nil
}

// TestCommandNameSourcesAgree pins the single source of truth: the value every
// package shares (buildinfo.CommandName), the alias this package uses
// (commandName), and the cobra root command must all be the same name. If one
// drifts, the guard above and the help/usage tests would disagree about what the
// tool is called.
func TestCommandNameSourcesAgree(t *testing.T) {
	if commandName != buildinfo.CommandName {
		t.Errorf("commandName = %q, buildinfo.CommandName = %q; they must match", commandName, buildinfo.CommandName)
	}
	if got := rootCmd.Name(); got != commandName {
		t.Errorf("rootCmd.Name() = %q, commandName = %q; the root command must be named from the single source", got, commandName)
	}
}
