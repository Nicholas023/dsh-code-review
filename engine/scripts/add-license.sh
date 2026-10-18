#!/usr/bin/env bash

# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 alibaba/open-code-review Contributors

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MIN_YEAR=2026
SPDX_REGEX="SPDX-License-Identifier: Apache-2.0"

# Same holder split as verify-license.sh: engine/ keeps the upstream
# attribution, the plugin root belongs to this repository.
license_holder() {
  local file="$1"
  if [[ "$file" == engine/* ]]; then
    echo "alibaba/open-code-review Contributors"
  else
    echo "dsh-code-review contributors"
  fi
}

# Comment syntax depends on the extension: // for Go, the JS/TS family and
# Kotlin, # for shell and Python, /* */ for CSS.
header_for() {
  local file="$1"
  local holder
  holder="$(license_holder "$file")"
  local ext="${file##*.}"
  case "$ext" in
    sh | py)
      printf '# SPDX-License-Identifier: Apache-2.0\n# Copyright 2026 %s\n' "$holder"
      ;;
    css)
      # CSS has no // line comment — that is SCSS — so a block is the only
      # option. The lines inside carry no prefix, matching the {{/* */}} header
      # already in internal/viewer/templates/app-header.html.
      printf '/*\nSPDX-License-Identifier: Apache-2.0\nCopyright 2026 %s\n*/\n' "$holder"
      ;;
    *)
      printf '// SPDX-License-Identifier: Apache-2.0\n// Copyright 2026 %s\n' "$holder"
      ;;
  esac
}

# Grouped by the comment syntax add_header gives each below: // for Go, the
# JS/TS family and Kotlin, # for shell and Python, /* */ for CSS. Extensions
# whose comment cannot simply be prepended stay out — .html would need its
# DOCTYPE kept on the first line, so it is not covered yet.
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

has_header() {
  local file="$1"
  local holder
  local header
  holder="$(license_holder "$file")"
  header="$(head -20 "$file")"
  # Here-string, not `echo |`: grep -q exits on the first match, so echo can die of
  # SIGPIPE (141) and pipefail turns that into a false "no header", which makes
  # add_header prepend a second copyright block to a file that already has one.
  grep -qF "$SPDX_REGEX" <<<"$header" && grep -qE "Copyright [0-9]{4} ${holder}" <<<"$header"
}

add_header() {
  local file="$1"
  local header="$2"
  local tmp
  tmp=$(mktemp)
  if stat -f '%Lp' "$file" >/dev/null 2>&1; then
    chmod "$(stat -f '%Lp' "$file")" "$tmp"
  else
    chmod "$(stat -c '%a' "$file")" "$tmp"
  fi

  local first_line
  first_line="$(head -1 "$file")"

  if [[ "$first_line" =~ ^//go:build ]]; then
    echo "$first_line" > "$tmp"
    echo "" >> "$tmp"
    echo "$header" >> "$tmp"
    echo "" >> "$tmp"
    tail -n +2 "$file" >> "$tmp"
  elif [[ "$first_line" =~ ^#! ]]; then
    echo "$first_line" > "$tmp"
    echo "" >> "$tmp"
    echo "$header" >> "$tmp"
    echo "" >> "$tmp"
    tail -n +2 "$file" >> "$tmp"
  else
    echo "$header" > "$tmp"
    echo "" >> "$tmp"
    cat "$file" >> "$tmp"
  fi

  mv "$tmp" "$file"
}

ADDED=0

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

  has_header "$file" && continue

  add_header "$file" "$(header_for "$file")"

  ADDED=$((ADDED + 1))
  echo "  Added: $file"
done < <(git ls-files)

echo "Done. Added license headers to $ADDED file(s)."
