#!/bin/sh
# Refresh the Claude Code plugin clone after `npm install -g` so the
# marketplace copy at ~/.claude/plugins/marketplaces/wezard-local/ stays
# in lockstep with the npm global install. Silent no-op in any irrelevant
# context (local dev install, claude not on PATH, marketplace never added).
# Must never fail npm install.

[ "$npm_config_global" = "true" ] || exit 0
command -v claude >/dev/null 2>&1 || exit 0

claude plugin marketplace update wezard-local >/dev/null 2>&1 || true
exit 0
