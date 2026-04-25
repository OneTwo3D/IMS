#!/usr/bin/env bash
set -euo pipefail

npm run db:migrate:status
npm run db:schema:diff
npm run db:schema:drift
