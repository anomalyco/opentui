#!/bin/bash
# Probe theme-related terminal queries inside and outside tmux.
#
# Run this in the pane you want to test. It writes queries directly to /dev/tty,
# captures any replies, and prints both an escaped representation and raw hex.
#
# Usage:
#   ./packages/core/dev/test-tmux-theme-queries.sh

set -u
set -o pipefail

LC_ALL=C

ESC=$'\033'
BEL=$'\a'
ST="${ESC}\\"
LOG_FILE="${LOG_FILE:-./_tmux_theme_query_$(date +%s).log}"

exec 3<> /dev/tty

ORIGINAL_STTY="$(stty -g <&3)"

cleanup() {
  stty "$ORIGINAL_STTY" <&3 2>/dev/null || true
  exec 3>&- 3<&-
}

interrupt() {
  cleanup
  exit 130
}

trap cleanup EXIT
trap interrupt INT TERM

READ_GAP_TENTHS="${READ_GAP_TENTHS:-4}"

stty -echo -icanon min 0 time "$READ_GAP_TENTHS" <&3

tmux_wrap() {
  local payload="$1"
  payload=${payload//$ESC/$ESC$ESC}
  printf '%s' "${ESC}Ptmux;${payload}${ST}"
}

escape_for_display() {
  local value="$1"
  value=${value//$ESC/\\e}
  value=${value//$BEL/\\a}
  value=${value//$'\r'/\\r}
  value=${value//$'\n'/\\n$'\n'}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

hex_dump() {
  if [ -z "$1" ]; then
    printf '(none)\n'
    return
  fi

  printf '%s' "$1" | od -An -tx1 -v | tr -s ' ' | sed 's/^ //'
}

read_until_gap() {
  local response=""
  local chunk=""

  while true; do
    chunk="$(dd bs=1 count=1 2>/dev/null <&3)"
    if [ -z "$chunk" ]; then
      break
    fi
    response+="$chunk"
  done

  printf '%s' "$response"
}

drain_input() {
  local drained=""
  drained="$(read_until_gap)"
  if [ -n "$drained" ]; then
    printf 'Drained pending input before next test.\n' | tee -a "$LOG_FILE"
    printf '  escaped: %s\n' "$(escape_for_display "$drained")" | tee -a "$LOG_FILE"
    printf '  hex: %s\n' "$(hex_dump "$drained")" | tee -a "$LOG_FILE"
  fi
}

run_case() {
  local name="$1"
  local payload="$2"
  local response=""

  drain_input

  {
    printf '\n=== %s ===\n' "$name"
    printf 'query escaped: %s\n' "$(escape_for_display "$payload")"
    printf 'query hex: %s\n' "$(hex_dump "$payload")"
  } | tee -a "$LOG_FILE"

  printf '%s' "$payload" >&3
  response="$(read_until_gap)"

  if [ -z "$response" ]; then
    printf 'response: (none)\n' | tee -a "$LOG_FILE"
    return
  fi

  {
    printf 'response escaped: %s\n' "$(escape_for_display "$response")"
    printf 'response hex: %s\n' "$(hex_dump "$response")"
  } | tee -a "$LOG_FILE"
}

OSC10_BEL="${ESC}]10;?${BEL}"
OSC11_BEL="${ESC}]11;?${BEL}"
OSC10_ST="${ESC}]10;?${ST}"
OSC11_ST="${ESC}]11;?${ST}"
OSC10_11_BEL="${OSC10_BEL}${OSC11_BEL}"
OSC10_11_ST="${OSC10_ST}${OSC11_ST}"
CPR_QUERY="${ESC}[6n"
XTVERSION_QUERY="${ESC}[>0q"
COLOR_SCHEME_REQUEST="${ESC}[?996n"

{
  printf 'tmux theme query probe\n'
  printf 'log file: %s\n' "$LOG_FILE"
  printf 'tmux env: %s\n' "${TMUX:-<not set>}"
  printf 'TERM: %s\n' "${TERM:-<not set>}"
  printf 'TERM_PROGRAM: %s\n' "${TERM_PROGRAM:-<not set>}"
  printf 'read gap tenths: %s\n' "$READ_GAP_TENTHS"
  printf '\n'
  printf 'Recommended: run this inside tmux in the same pane where theme-mode.ts fails.\n'
} | tee "$LOG_FILE"

run_case 'Control: plain CPR (CSI 6n)' "$CPR_QUERY"
run_case 'Control: plain xtversion (CSI > 0q)' "$XTVERSION_QUERY"
run_case 'Plain OSC 10/11 combined with BEL terminators' "$OSC10_11_BEL"
run_case 'Plain OSC 10/11 combined with ST terminators' "$OSC10_11_ST"
run_case 'tmux wrapped OSC 10/11 combined in one DCS wrapper (BEL)' "$(tmux_wrap "$OSC10_11_BEL")"
run_case 'tmux wrapped OSC 10/11 combined in one DCS wrapper (ST)' "$(tmux_wrap "$OSC10_11_ST")"
run_case 'tmux wrapped OSC 10 only (BEL)' "$(tmux_wrap "$OSC10_BEL")"
run_case 'tmux wrapped OSC 11 only (BEL)' "$(tmux_wrap "$OSC11_BEL")"
run_case 'tmux wrapped OSC 10 then OSC 11 as separate DCS wrappers (BEL)' "$(tmux_wrap "$OSC10_BEL")$(tmux_wrap "$OSC11_BEL")"
run_case 'Plain color scheme request (CSI ?996n)' "$COLOR_SCHEME_REQUEST"
run_case 'tmux wrapped color scheme request (CSI ?996n)' "$(tmux_wrap "$COLOR_SCHEME_REQUEST")"

printf '\nDone. If you want, paste the generated log file and I will compare which query forms tmux answers.\n' | tee -a "$LOG_FILE"
