#!/usr/bin/env bash

# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 alibaba/open-code-review Contributors

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CURRENT_YEAR=$(date +%Y)
MIN_YEAR=2026
SPDX_REGEX="SPDX-License-Identifier: Apache-2.0"
YEAR_REGEX="Copyright ([0-9]{4})"
# dsh-code-review 是 open-code-review 的 fork：engine/ 内文件保留上游归属，
# 插件根（engine/ 之外）文件属于本仓库（与根 NOTICE 的归属口径一致）。
# 单持有人时代上游脚本硬编码 alibaba，会给我们自己的文件盖上虚假归属。
license_holder() {
  local file="$1"
  if [[ "$file" == engine/* ]]; then
    echo "alibaba/open-code-review Contributors"
  else
    echo "dsh-code-review contributors"
  fi
}

# Keep in step with LICENSE_EXTS in add-license.sh, which also records why each
# extension is in or out. This side only greps for the header text, so the
# comment syntax does not matter here.
LICENSE_EXTS=(go js mjs ts tsx kt kts sh py css)

IGNORED_PATHS=(
  "vendor/"
  "dist/"
  "node_modules/"
  "testdata/"
)

is_ignored() {
  local file="$1"
  for ignore in "${IGNORED_PATHS[@]}"; do
    if [[ "$file" == */"$ignore"* ]] || [[ "$file" == "$ignore"* ]]; then
      return 0
    fi
  done
  return 1
}

FAILED=()

while IFS= read -r file; do
  [ -z "$file" ] && continue
  is_ignored "$file" && continue

  ext="${file##*.}"
  match=false
  for e in "${LICENSE_EXTS[@]}"; do
    if [[ "$ext" == "$e" ]]; then
      match=true
      break
    fi
  done
  $match || continue

  header="$(head -20 "$file")"

  # Feed $header via here-string, not `echo |`: grep -q exits on the first match,
  # so echo can die of SIGPIPE (141) and pipefail then reports a valid header as missing.
  if ! grep -qF "$SPDX_REGEX" <<<"$header"; then
    FAILED+=("$file (missing SPDX identifier)")
    continue
  fi

  holder="$(license_holder "$file")"
  if ! grep -qE "Copyright [0-9]{4} ${holder}" <<<"$header"; then
    FAILED+=("$file (missing copyright notice: ${holder})")
    continue
  fi

  year=""
  [[ "$header" =~ $YEAR_REGEX ]] && year="${BASH_REMATCH[1]}"
  if [ -z "$year" ] || [ "$year" -lt "$MIN_YEAR" ] || [ "$year" -gt "$CURRENT_YEAR" ]; then
    FAILED+=("$file (invalid year: ${year:-none})")
    continue
  fi
done < <(git ls-files)

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "ERROR: The following files are missing or have invalid license headers:"
  printf '  %s\n' "${FAILED[@]}"
  echo ""
  echo "Run 'make license-add' to fix."
  exit 1
fi

echo "All source files have valid license headers."
