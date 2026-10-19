#!/bin/sh
# Prints the CHANGELOG.md section of one version: everything under `## <version>`
# up to the next `## ` heading. Exits 1 when there is none, so a release
# without notes stops before it publishes.
set -eu
version="${1:?usage: changelog-section.sh <version>}"
file="$(dirname "$0")/../CHANGELOG.md"
section=$(awk -v v="$version" '
  /^## / { found = ($2 == v); next }
  found { print }
' "$file")
if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md has no section for ${version}" >&2
  exit 1
fi
printf '%s\n' "$section"
