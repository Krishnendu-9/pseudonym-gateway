#!/usr/bin/env bash
# The machine-sampler flake comparison of 2026-10-10 (testing guide, "The
# machine-sampler flake, measured"), kept in the repository for the reason
# ADR-043 gives: a harness left in a scratchpad is lost with it.
#
#   bash scripts/flake-compare.sh <dir outside the repo> [runs per arm, default 20]
#
# Full test runs, alternating with/without, "with" first:
#   with:    vitest run --project main --project timing   (= npm test)
#   without: the same, naming every test file except
#            test/unit/scripts/live-run-guard.test.ts. The main project's own
#            exclude overrides --exclude, so the file is left out by not
#            naming it; config and projects are unchanged.
# Check the first pair: the without-run must report one file fewer and the
# guard file's tests fewer, or the comparison compares nothing.
# Per run: full output in <dir>/<i>-<arm>.txt, one line in <dir>/results.tsv.
#
# As run on 2026-10-10 the two paths were written in; they are now found
# (the repository from this file's place) or given (the output folder).
set -u
OUT="${1:?usage: bash scripts/flake-compare.sh <dir outside the repo> [runs per arm]}"
RUNS="${2:-20}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
cd "$REPO" || exit 2
mapfile -t FILES < <(git ls-files 'test/*.test.ts' | grep -v '\.names\.test\.ts$' | grep -vx 'test/unit/scripts/live-run-guard.test.ts')
echo "without-arm files: ${#FILES[@]}" > "$OUT/files.txt"
printf '%s\n' "${FILES[@]}" >> "$OUT/files.txt"
printf 'i\tarm\texit\tseconds\ttests\tsampler_failed\tfailed_tests\tsampler_line\n' > "$OUT/results.tsv"
for i in $(seq 1 "$RUNS"); do
  for arm in with without; do
    log="$OUT/$i-$arm.txt"
    start=$(date +%s)
    if [ "$arm" = with ]; then
      npx vitest run --project main --project timing > "$log" 2>&1
    else
      npx vitest run --project main --project timing "${FILES[@]}" > "$log" 2>&1
    fi
    code=$?
    secs=$(( $(date +%s) - start ))
    tests=$(grep -E '^ +Tests ' "$log" | tail -n 1 | sed 's/^ *//')
    failed=$(grep -E '^ FAIL ' "$log" | sed 's/^ FAIL  *//' | sort -u | paste -sd ';' -)
    if grep -E '^ FAIL ' "$log" | grep -q 'machine-sampler'; then sampler=yes; else sampler=no; fi
    machine=$(grep -E '^machine: ' "$log" | tail -n 1)
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$i" "$arm" "$code" "$secs" "$tests" "$sampler" "$failed" "$machine" >> "$OUT/results.tsv"
  done
done
echo "done" > "$OUT/results.tsv.done"
