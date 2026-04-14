#!/bin/sh
set -e
echo "[STARTUP] Starting application..."
npx prisma migrate deploy
echo "[STARTUP] Migrations complete, starting server..."
exec node dist/server.js
