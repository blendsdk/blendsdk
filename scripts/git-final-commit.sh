#!/bin/bash

git commit -m "$1" && \

echo "=== COMMIT SUCCESSFUL ===" && \

git log -1 --oneline && \

echo "=== FINAL STATUS ===" && \

git status && \

exit 0