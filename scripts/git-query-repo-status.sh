#!/bin/bash
git config --global pager.diff false && \

echo "=== GIT STATUS ===" && \

git status --porcelain && \

echo "=== MODIFIED FILES ===" && \

git diff --name-only && \

echo "=== STAGED FILES ===" && \

git diff --cached --name-only && \

exit 0