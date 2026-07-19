#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR=".opencode/plugins/04-simple-plugin"

if [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR"
  echo "[clean] Deleted $PLUGIN_DIR"
else
  echo "[clean] $PLUGIN_DIR not found, nothing to clean"
fi
