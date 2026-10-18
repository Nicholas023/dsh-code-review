.PHONY: build test clean run help fmt vet check coverage \
	build-all dist sha256sum version-info \
	build-linux-amd64 build-linux-arm64 build-darwin-amd64 build-darwin-arm64 \
	build-windows-amd64 build-windows-arm64 \
	license-check license-add english-check

# Fork naming: the binary is codecheck (open-code-review fork); the
# upstream name opencodereview is gone. Controls the -o file name.
BINARY_NAME := codecheck
GO          := go
DIST_DIR    := ./dist
EXE         := $(if $(filter Windows_NT,$(OS)),.exe,)

GIT_COMMIT  := $(shell git rev-parse --short HEAD)
BUILD_DATE  := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

# Version matches engine/scripts/build-fork.sh: root package.json is the only
# source of truth, stamp is "<plugin version>+fork.<N>". Do not reintroduce a
# git-tag dependency here; fork tags do not map to engine versions.
REPO_ROOT   := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))..)
PLUGIN_VERSION := $(shell sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$(REPO_ROOT)/package.json" | head -n1)
FORK_N      := $(shell git rev-list --no-merges --count HEAD -- engine/)
VERSION     ?= $(PLUGIN_VERSION)+fork.$(FORK_N)

LD_FLAGS    := \
	-X main.Version=$(VERSION) \
	-X main.GitCommit=$(GIT_COMMIT) \
	-X main.BuildDate=$(BUILD_DATE)

RELEASE_LD_FLAGS := -s -w $(LD_FLAGS)

define BUILD_PLATFORM
	GOOS=$(1) GOARCH=$(2) CGO_ENABLED=0 $(GO) build -ldflags "$(RELEASE_LD_FLAGS)" \
		-o $(DIST_DIR)/$(BINARY_NAME)-$(1)-$(2)$(3) \
		./cmd/opencodereview
endef

# ── Development targets ──────────────────────────────────────────────────────
build:
	$(GO) build -ldflags "$(LD_FLAGS)" -o $(DIST_DIR)/$(BINARY_NAME)$(EXE) ./cmd/opencodereview

# No filters: the upstream pages/ (docs site) and extensions/ (IDE plugins)
# trees were never committed to this fork, so `go list ./...` sees only engine
# code. Re-add a module boundary or a grep filter here if a sibling Go tree
# ever lands.
PACKAGES := $(shell $(GO) list ./...)

test:
	LC_ALL=C $(GO) test -v -race -count=1 $(PACKAGES)

COVERAGE_THRESHOLD := 90

coverage:
	LC_ALL=C $(GO) test -count=1 -coverprofile=coverage.out $(PACKAGES)
	$(GO) tool cover -func=coverage.out | grep total:
	@COVERAGE=$$($(GO) tool cover -func=coverage.out | grep total: | awk '{print $$3}' | sed 's/%//'); \
	if awk "BEGIN {exit !($$COVERAGE < $(COVERAGE_THRESHOLD))}"; then \
		echo "FAIL: Coverage $${COVERAGE}% is below $(COVERAGE_THRESHOLD)% threshold"; \
		exit 1; \
	fi; \
	echo "PASS: Coverage $${COVERAGE}% meets $(COVERAGE_THRESHOLD)% threshold"

clean:
	rm -rf $(DIST_DIR) coverage.out

run: build
	$(DIST_DIR)/$(BINARY_NAME)$(EXE) --staged

help: build
	$(DIST_DIR)/$(BINARY_NAME)$(EXE) -h

fmt:
	gofmt -s -w .

vet:
	LC_ALL=C $(GO) vet $(PACKAGES)

check: license-check english-check
	$(GO) mod tidy
	gofmt -s -w .
	LC_ALL=C $(GO) vet $(PACKAGES)
	@echo "check passed"

license-check:
	@bash scripts/verify-license.sh

english-check:
	@$(GO) run scripts/verify-english-only.go

license-add:
	@bash scripts/add-license.sh

# ── Cross-platform targets ───────────────────────────────────────────────────
build-linux-amd64:
	$(call BUILD_PLATFORM,linux,amd64)

build-linux-arm64:
	$(call BUILD_PLATFORM,linux,arm64)

build-darwin-amd64:
	$(call BUILD_PLATFORM,darwin,amd64)

build-darwin-arm64:
	$(call BUILD_PLATFORM,darwin,arm64)

build-windows-amd64:
	$(call BUILD_PLATFORM,windows,amd64,.exe)

build-windows-arm64:
	$(call BUILD_PLATFORM,windows,arm64,.exe)

build-all: build-linux-amd64 build-linux-arm64 build-darwin-amd64 build-darwin-arm64 build-windows-amd64 build-windows-arm64

# Generate SHA256 checksums for all release binaries
sha256sum: build-all
	cd $(DIST_DIR) && shasum -a 256 $(BINARY_NAME)-* | sort > sha256sum.txt

# Full release: clean → build all platforms → checksums
dist: clean build-all sha256sum
	@echo $(VERSION) > $(DIST_DIR)/VERSION

version-info:
	@echo "Version:   $(VERSION)"
	@echo "GitCommit: $(GIT_COMMIT)"
	@echo "BuildDate: $(BUILD_DATE)"
	@echo "LD_FLAGS:  $(LD_FLAGS)"
