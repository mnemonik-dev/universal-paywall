#!/bin/sh
set -eu

# The destination is a dedicated named volume owned by the staging stack.
# Copy atomically enough for compose's completed-successfully dependency: the
# MCP service is not started until this process exits zero.
rm -rf /approval-ui/*
cp -R /opt/approval-ui/. /approval-ui/
