#!/bin/bash
echo "=== UNSTAGED CHANGES ===" && \

git --no-pager diff && \

echo "=== STAGED CHANGES ===" && \

git diff --cached && \

exit 0