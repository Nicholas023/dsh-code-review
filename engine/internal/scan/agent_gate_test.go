// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package scan

// Cross-batch pipeline tests: the four behaviours that changed when
// dispatchSubtasks moved from batch-serial dispatch to a shared
// concurrency pool with per-batch settle (dedup + checkpoint persist).
// They pin, respectively:
//
//  1. files of a later batch enter their LLM request while an earlier
//     batch's file is still blocked in flight (the throughput fix itself);
//  2. batch dedup sees ONLY its own batch's comments even though later
//     batches may have already appended theirs;
//  3. the token budget gate stops scheduling across the remaining batches;
//  4. context cancellation stops scheduling but settles the completed work
//     without deadlock and surfaces the cancellation error.
//
// All four drive the real llmloop path (executeSubtask -> RunMainTask)
// through a scripted LLM client, with a real CommentWorkerPool so the
// AwaitKey drain in stage B is exercised.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alibaba/open-code-review/internal/config/template"
	"github.com/alibaba/open-code-review/internal/llm"
	"github.com/alibaba/open-code-review/internal/llmloop"
	"github.com/alibaba/open-code-review/internal/model"
	"github.com/alibaba/open-code-review/internal/session"
	"github.com/alibaba/open-code-review/internal/tool"
)

// pathMarkerRe extracts the rendered `path=<file>` marker (from the scan
// template's {{current_file_path}} placeholder) out of a request's text.
var pathMarkerRe = regexp.MustCompile(`path=([^\s\n]+)`)

// scriptedGateClient hands every request to a test-supplied handler along
// with the file path rendered into the request ("" for requests that carry
// no file, e.g. the batch dedup call), the full concatenated request text,
// and the 1-based call index for that path. It also tracks the peak number
// of concurrently in-flight requests, which the cross-batch overlap test
// asserts on.
type scriptedGateClient struct {
	mu      sync.Mutex
	perPath map[string]int // path -> call index
	calls   int            // total request count
	events  []string       // wall-clock enter/exit trace (mutex-guarded)
	peak    int64          // peak concurrent in-flight requests (atomic)
	active  int64          // currently in-flight request count (atomic)
	handler func(ctx context.Context, req llm.ChatRequest, path, text string, pathCall int) (*llm.ChatResponse, error)
	epoch   time.Time // trace zero point
}

func newScriptedGateClient(handler func(ctx context.Context, req llm.ChatRequest, path, text string, pathCall int) (*llm.ChatResponse, error)) *scriptedGateClient {
	return &scriptedGateClient{perPath: make(map[string]int), handler: handler, epoch: time.Now()}
}

func (c *scriptedGateClient) trace(format string, args ...any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, fmt.Sprintf("%9.2fms %s", float64(time.Since(c.epoch)/time.Microsecond)/1000.0, fmt.Sprintf(format, args...)))
}

func (c *scriptedGateClient) traceEvents() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.events...)
}

func (c *scriptedGateClient) CompletionsWithCtx(ctx context.Context, req llm.ChatRequest) (*llm.ChatResponse, error) {
	text := ""
	for _, m := range req.Messages {
		if s, ok := m.Content.(string); ok {
			text += s
		}
	}
	path := ""
	if m := pathMarkerRe.FindStringSubmatch(text); m != nil {
		path = m[1]
	}
	c.mu.Lock()
	c.perPath[path]++
	pathCall := c.perPath[path]
	c.calls++
	c.mu.Unlock()
	c.trace("enter %-5s #%d", path, pathCall)

	active := atomic.AddInt64(&c.active, 1)
	defer atomic.AddInt64(&c.active, -1)
	defer c.trace("exit  %-5s #%d", path, pathCall)
	for {
		peak := atomic.LoadInt64(&c.peak)
		if active <= peak || atomic.CompareAndSwapInt64(&c.peak, peak, active) {
			break
		}
	}
	return c.handler(ctx, req, path, text, pathCall)
}

func (c *scriptedGateClient) requests() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func (c *scriptedGateClient) peakActive() int64 {
	return atomic.LoadInt64(&c.peak)
}

// gateRespTaskDone builds a bare task_done response with a small usage.
func gateRespTaskDone(promptTokens int64) *llm.ChatResponse {
	empty := ""
	return &llm.ChatResponse{
		Choices: []llm.Choice{{
			Message: llm.ResponseMessage{
				Content: &empty,
				ToolCalls: []llm.ToolCall{{
					ID:       "done",
					Type:     "function",
					Function: llm.FunctionCall{Name: "task_done", Arguments: "{}"},
				}},
			},
			FinishReason: "tool_calls",
		}},
		Usage: &llm.UsageInfo{PromptTokens: promptTokens, CompletionTokens: 5, TotalTokens: promptTokens + 5},
	}
}

// gateRespComment builds a response carrying one code_comment call for path.
func gateRespComment(path, content string) *llm.ChatResponse {
	args, _ := json.Marshal(map[string]any{
		"comments": []map[string]string{{"path": path, "content": content}},
	})
	return &llm.ChatResponse{
		Choices: []llm.Choice{{
			Message: llm.ResponseMessage{
				ToolCalls: []llm.ToolCall{{
					ID:       "c1",
					Type:     "function",
					Function: llm.FunctionCall{Name: "code_comment", Arguments: string(args)},
				}},
			},
			FinishReason: "tool_calls",
		}},
		Usage: &llm.UsageInfo{PromptTokens: 100, CompletionTokens: 10, TotalTokens: 110},
	}
}

// gateBatchingTemplate returns a scan template with by-language batching:
// .go files land in batch 0, .py files in batch 1, deterministically (the
// groupBatches key sort orders ".go" before ".py").
func gateBatchingTemplate() template.ScanTemplate {
	tpl := makeTemplateWithFullScan()
	tpl.BatchStrategy = "by-language"
	tpl.BatchSize = 0 // no size cap: batches are the language groups
	return tpl
}

// gateTestAgent wires the same pieces as the integration tests in
// coverage_test.go, but with a scripted client and a real worker pool so
// code_comment post-processing actually lands on AwaitKey in stage B.
func gateTestAgent(t *testing.T, tpl template.ScanTemplate, client llm.LLMClient, pool *llmloop.CommentWorkerPool, c *tool.CommentCollector) *Agent {
	t.Helper()
	reg := tool.NewRegistry()
	reg.Register(&tool.CodeCommentProvider{Collector: c})
	return NewAgent(Args{
		Template:          tpl,
		LLMClient:         client,
		Model:             "test",
		CommentCollector:  c,
		Tools:             reg,
		CommentWorkerPool: pool,
		MaxConcurrency:    8,
		SkipPlan:          true,
		SkipDedup:         true,
		SkipSummary:       true,
		Session: session.New(t.TempDir(), "main", "test", session.SessionOptions{
			ReviewMode: session.ReviewModeFullScan,
		}),
	})
}

// doneRecordsForPath returns the review_item_done JSON lines from the
// agent's persisted session file, keyed by filePath with the comment
// contents that were checkpointed for it.
func doneRecordsForPath(t *testing.T, a *Agent) map[string][]string {
	t.Helper()
	path, err := session.SessionFilePath(a.args.Session.RepoDir, a.SessionID())
	if err != nil {
		t.Fatalf("SessionFilePath: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open session file %s: %v", path, err)
	}
	defer f.Close()

	out := make(map[string][]string)
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.Contains(line, `"review_item_done"`) {
			continue
		}
		var rec struct {
			FilePath string             `json:"filePath"`
			Comments []model.LlmComment `json:"comments"`
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("parse review_item_done line: %v", err)
		}
		var contents []string
		for _, cm := range rec.Comments {
			contents = append(contents, cm.Content)
		}
		out[rec.FilePath] = contents
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan session file: %v", err)
	}
	return out
}

// waitChan drains a channel or fails the test after a timeout. It exists so
// tests do not hang forever when the pipeline under test misbehaves.
func waitChan(t *testing.T, what string, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(15 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// ---------------------------------------------------------------------------
// 1. Cross-batch overlap: a later batch's file must start while an earlier
// batch's file is still blocked in flight.
// ---------------------------------------------------------------------------

func TestScanPipeline_CrossBatchOverlap(t *testing.T) {
	var (
		goEntered = make(chan struct{})
		goOnce    sync.Once
		pyStarted = make(chan struct{})
		pyOnce    sync.Once
		release   = make(chan struct{})
	)
	client := newScriptedGateClient(func(ctx context.Context, _ llm.ChatRequest, path string, _ string, pathCall int) (*llm.ChatResponse, error) {
		if strings.HasSuffix(path, ".go") && pathCall == 1 {
			// The entire batch-0 group blocks until the test releases it;
			// batch 1 must start regardless. Everything else returns at once.
			goOnce.Do(func() {
				close(goEntered)
			})
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return gateRespTaskDone(10), nil
			}
		}
		if strings.HasSuffix(path, ".py") {
			// Wait for batch 0 to be provably in flight before answering any
			// batch-1 file. Without this gate the .py goroutine can win the
			// scheduling race, return, and leave the .go requests still
			// waiting for their slot — the "overlap" then never exists to be
			// measured. A blocked wait here still counts toward the client's
			// in-flight peak (the counter is raised before the handler runs),
			// so the moment .go is observed the .py request is provably
			// concurrent with it.
			<-goEntered
			pyOnce.Do(func() {
				close(pyStarted)
			})
		}
		return gateRespTaskDone(10), nil
	})

	tpl := gateBatchingTemplate()
	collector := tool.NewCommentCollector()
	a := gateTestAgent(t, tpl, client, llmloop.NewCommentWorkerPool(2), collector)
	a.items = []model.ScanItem{
		{Path: "a1.go", Content: "package a1\n", LineCount: 1},
		{Path: "a2.go", Content: "package a2\n", LineCount: 1},
		{Path: "b1.py", Content: "x = 1\n", LineCount: 1},
		{Path: "b2.py", Content: "y = 2\n", LineCount: 1},
	}
	a.currentDate = "2026-06-26"

	done := make(chan error, 1)
	go func() {
		_, err := a.dispatchSubtasks(context.Background())
		done <- err
	}()

	// Batch 0 is in flight and blocked.
	waitChan(t, "a .go request to enter the client", goEntered)
	// Batch 1 must start WITHOUT waiting for batch 0 to finish: arrived at
	// this wait only after goEntered was observed, and it returns as soon as
	// a .py request touches the client while every .go request is still
	// parked inside the handler. No wall-clock comparison is attempted: under
	// cross-batch dispatch the .py handler may legitimately fire before the
	// first .go one, and the channel wait sequence above is the airtight
	// statement that matters (py is observed only after .go is observed).
	waitChan(t, "a .py request to start while batch 0 is blocked", pyStarted)
	close(release)

	if err := <-done; err != nil {
		t.Fatalf("dispatchSubtasks: %v", err)
	}

	// The run-level proof, in two complementary forms:
	//  - event ordering (already established above): pyStarted closed while
	//    every .go request was still blocked, so some batch-1 file was in the
	//    LLM client while batch 0 was in flight;
	//  - peak concurrency >= 2, which would be impossible under the old
	//    batch-serial dispatch (per-batch pool: batch 1's requests could only
	//    start after batch 0's pool drained... here they share one pool).
	// Deliberately NOT asserting peak >= 3: goroutine start order between the
	// two .go requests and the .py requests is timing dependent, and the
	// event ordering above is the airtight cross-batch statement.
	for _, ev := range client.traceEvents() {
		t.Logf("trace: %s", ev)
	}
	if peak := client.peakActive(); peak < 2 {
		t.Errorf("peak concurrent LLM requests = %d, want >= 2 (one .py from batch 1 during batch 0)", peak)
	}
	if got := client.requests(); got != 4 {
		t.Errorf("total LLM requests = %d, want 4 (one per file)", got)
	}
	if len(doneRecordsForPath(t, a)) != 4 {
		t.Errorf("review_item_done records = %d, want 4 (one per file)", len(doneRecordsForPath(t, a)))
	}
}

// ---------------------------------------------------------------------------
// 2. Dedup isolation: the dedup request for batch 0 must see only batch 0's
// comments, and the replacement must reach the collector and the persisted
// checkpoints.
// ---------------------------------------------------------------------------

func TestScanPipeline_BatchDedupIsolation(t *testing.T) {
	var (
		dedupMu     sync.Mutex
		dedupBodies []string
	)
	client := newScriptedGateClient(func(_ context.Context, _ llm.ChatRequest, path, text string, pathCall int) (*llm.ChatResponse, error) {
		if path == "" && strings.Contains(text, "c-0") {
			// Batch dedup call: no per-file path marker, body carries the
			// c-N comment index layout. Capture the whole body — the
			// isolation assertion lives on what it saw.
			dedupMu.Lock()
			dedupBodies = append(dedupBodies, text)
			dedupMu.Unlock()
			merged := `{"groups":[{"members":["c-0","c-1"],"merged_content":"combined finding"}]}`
			return &llm.ChatResponse{
				Choices: []llm.Choice{{Message: llm.ResponseMessage{Content: &merged}}},
				Usage:   &llm.UsageInfo{PromptTokens: 100, CompletionTokens: 10, TotalTokens: 110},
			}, nil
		}
		if pathCall == 1 {
			return gateRespComment(path, "dup finding "+path), nil
		}
		return gateRespTaskDone(10), nil
	})

	tpl := gateBatchingTemplate()
	tpl.DedupTask = &template.LlmConversation{
		Messages: []template.ChatMessage{{Role: "user", Content: "dedup {{batch_comments}}"}},
	}
	collector := tool.NewCommentCollector()
	a := gateTestAgent(t, tpl, client, llmloop.NewCommentWorkerPool(2), collector)
	// Batch 0 = a1.go, a2.go (2 comments, dedup fires); batch 1 = b.py
	// (1 comment, below the threshold so no dedup request is made). The
	// extension mix matters: "by-language" would put every .py file in one
	// batch, which is exactly what the isolation assertion must NOT see.
	// Disable dedup skipping but leave the plan/summary skipping intact.
	a.args.SkipDedup = false
	a.items = []model.ScanItem{
		{Path: "a1.go", Content: "package a1\n", LineCount: 1},
		{Path: "a2.go", Content: "package a2\n", LineCount: 1},
		{Path: "b.py", Content: "y = 3\n", LineCount: 1},
	}
	a.currentDate = "2026-06-26"

	if _, err := a.dispatchSubtasks(context.Background()); err != nil {
		t.Fatalf("dispatchSubtasks: %v", err)
	}

	t.Logf("dedup bodies: %d", func() int {
		dedupMu.Lock()
		defer dedupMu.Unlock()
		return len(dedupBodies)
	}())

	dedupMu.Lock()
	nDedup := len(dedupBodies)
	bodies := append([]string(nil), dedupBodies...)
	dedupMu.Unlock()
	if nDedup != 1 {
		t.Fatalf("dedup LLM requests = %d, want 1 (only batch 0 crosses the threshold)", nDedup)
	}
	body := bodies[0]
	if !strings.Contains(body, "dup finding a1.go") || !strings.Contains(body, "dup finding a2.go") {
		t.Errorf("dedup body missing batch 0 comments:\n%s", body)
	}
	if strings.Contains(body, "dup finding b.py") {
		t.Errorf("dedup body leaked a later batch's comment:\n%s", body)
	}

	// Collector: batch 0's pair merged into one; b.py's comment untouched.
	got := collector.Comments()
	if len(got) != 2 {
		t.Fatalf("collector comments = %d, want 2 after dedup", len(got))
	}
	contents := map[string]string{}
	for _, cm := range got {
		contents[cm.Content] = cm.Path
	}
	if _, ok := contents["combined finding"]; !ok {
		t.Errorf("merged comment missing from collector: %v", contents)
	}
	if contents["dup finding b.py"] != "b.py" {
		t.Errorf("b.py comment not preserved: %v", contents)
	}

	// Persisted checkpoints per file: cross-file dedup groups deliberately
	// keep the raw per-file comments (see recordBatchCheckpoints) so a
	// later resume cannot lose one file's finding by invalidating another;
	// the merged canonical comment lives only in the collector view.
	records := doneRecordsForPath(t, a)
	if len(records) != 3 {
		t.Fatalf("review_item_done records = %d, want 3", len(records))
	}
	if len(records["a1.go"]) != 1 || records["a1.go"][0] != "dup finding a1.go" {
		t.Errorf("a1.go checkpoint = %v, want its own raw comment", records["a1.go"])
	}
	if len(records["a2.go"]) != 1 || records["a2.go"][0] != "dup finding a2.go" {
		t.Errorf("a2.go checkpoint = %v, want its own raw comment", records["a2.go"])
	}
	if len(records["b.py"]) != 1 || records["b.py"][0] != "dup finding b.py" {
		t.Errorf("b.py checkpoint = %v, want its own comment", records["b.py"])
	}
}

// ---------------------------------------------------------------------------
// 3. Budget gate: tripping inside one batch stops scheduling ALL remaining
// batches (not just the current one).
// ---------------------------------------------------------------------------

func TestScanPipeline_BudgetGateStopsLaterBatches(t *testing.T) {
	perCall := int64(50_000)
	client := &fakeBudgetClient{perCallTokens: perCall} // usage semantics already proven by budget_test.go
	tpl := budgetTestTemplate()
	tpl.BatchStrategy = "by-language"

	collector := tool.NewCommentCollector()
	reg := tool.NewRegistry()
	reg.Register(&tool.CodeCommentProvider{Collector: collector})
	a := NewAgent(Args{
		Template:         tpl,
		LLMClient:        client,
		Model:            "test",
		CommentCollector: collector,
		Tools:            reg,
		MaxConcurrency:   1, // serialize so the gate is deterministic
		MaxTokensBudget:  80_000,
		SkipPlan:         true,
		SkipDedup:        true,
		SkipSummary:      true,
		Session: session.New(t.TempDir(), "main", "test", session.SessionOptions{
			ReviewMode: session.ReviewModeFullScan,
		}),
	})
	// One file per batch. The look-ahead runs before the loop acquires the
	// next slot, so at check time the usage from the PREVIOUS file is always
	// still missing (the batch order below proves the shift: b1.py sees 0,
	// c2.rs sees 50K); the gate trips on d3.sh, one file AFTER the budget
	// would mathematically allow. That overshoot is the documented gate
	// contract (see budget_test.go: overrun is bounded by in-flight files).
	// Single-file batches under MaxConcurrency=1 keep the shift exact.
	a.items = []model.ScanItem{
		{Path: "a1.go", Content: "package a1\n", LineCount: 1},
		{Path: "b1.py", Content: "x = 1\n", LineCount: 1},
		{Path: "c2.rs", Content: "fn main() {}\n", LineCount: 1},
		{Path: "d3.sh", Content: "#!/bin/sh\n", LineCount: 1},
	}
	a.currentDate = "2026-06-26"
	a.args.Tools.Freeze()

	if _, err := a.dispatchSubtasks(context.Background()); err != nil {
		t.Fatalf("dispatchSubtasks: %v", err)
	}
	t.Logf("tokens used after run: %d", a.runner.TotalTokensUsed())

	// Budget 80_000 with a one-file look-ahead shift: a1.go and b1.py run
	// (50K each); c2.rs is scheduled at 50K seen but the run loop's own
	// token guard stops it before any request (100K accrued); the dispatch
	// gate then trips on d3.sh while it is still queued and breaks out of
	// the WHOLE loop, not just the current batch.
	if got := client.calls; got != 2 {
		t.Errorf("LLM requests = %d, want 2 (later batch must not be scheduled)", got)
	}
	if !a.BudgetExceeded() {
		t.Error("BudgetExceeded() = false, want true")
	}
	warned := false
	for _, w := range a.Warnings() {
		if w.Type == "token_budget_reached" {
			warned = true
		}
	}
	if !warned {
		t.Errorf("token_budget_reached warning missing; warnings = %+v", a.Warnings())
	}
}

// ---------------------------------------------------------------------------
// 4. Cancellation: no new files are scheduled after cancel, the in-flight
// file settles (failed), and the error surfaces without deadlock.
// ---------------------------------------------------------------------------

func TestScanPipeline_CancelStopsScheduling(t *testing.T) {
	var (
		goEntered = make(chan struct{})
		goOnce    sync.Once
		release   = make(chan struct{})
	)
	client := newScriptedGateClient(func(ctx context.Context, _ llm.ChatRequest, path string, _ string, pathCall int) (*llm.ChatResponse, error) {
		if path == "a.go" && pathCall == 1 {
			goOnce.Do(func() { close(goEntered) })
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return gateRespTaskDone(10), nil
			}
		}
		return gateRespTaskDone(10), nil
	})
	tpl := makeTemplateWithFullScan()
	collector := tool.NewCommentCollector()
	a := gateTestAgent(t, tpl, client, llmloop.NewCommentWorkerPool(2), collector)
	// Serial dispatch (1 worker): while a.go holds the only slot, the
	// scheduler is blocked on the semaphore — the perfect spot to cancel.
	a.args.MaxConcurrency = 1
	a.items = []model.ScanItem{
		{Path: "a.go", Content: "package a\n", LineCount: 1},
		{Path: "b.go", Content: "package b\n", LineCount: 1},
		{Path: "c.go", Content: "package c\n", LineCount: 1},
	}
	a.currentDate = "2026-06-26"

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := a.dispatchSubtasks(ctx)
		done <- err
	}()

	waitChan(t, "a.go request to enter the client", goEntered)
	cancel()
	// Intentionally do NOT close(release): the in-flight request must observe
	// the cancelled context (its only exit path) so the file settles as a
	// failed subtask instead of completing. Leaving release open also pins
	// the "no deadlock" claim — if dispatchSubtasks could not return without
	// draining the in-flight slot, the run would hang here.

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancellation error from dispatchSubtasks")
		}
		if err != context.Canceled {
			t.Errorf("error = %v, want context.Canceled", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("dispatchSubtasks did not return after cancellation (deadlock)")
	}

	// Only a.go was ever dispatched; b.go and c.go must never have run.
	if got := client.requests(); got != 1 {
		t.Errorf("LLM requests = %d, want 1 (only a.go)", got)
	}
}
