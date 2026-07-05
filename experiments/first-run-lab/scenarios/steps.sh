# Shared helper for lab scenario scripts. Each step prints a banner, runs the
# command with stdin closed (anything that tries to prompt fails fast instead
# of hanging the battery), and records the exit code. Failures never stop the
# script: the failures are the data.

step() {
  local desc="$1"
  shift
  echo
  echo "════════════════════════════════════════════════════════════"
  echo "STEP: ${desc}"
  echo "CMD : $*"
  echo "────────────────────────────────────────────────────────────"
  local rc=0
  timeout 300 "$@" </dev/null 2>&1 || rc=$?
  echo "────────────────────────────────────────────────────────────"
  if [ "$rc" -eq 124 ]; then
    echo "EXIT: ${rc} (TIMED OUT after 300s — likely waiting for input)"
  else
    echo "EXIT: ${rc}"
  fi
}

banner() {
  echo
  echo "############################################################"
  echo "## $1"
  echo "############################################################"
}
