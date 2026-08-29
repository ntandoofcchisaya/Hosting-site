#!/bin/bash
# Kill any existing server instances
pkill -9 -f "node server.js" 2>/dev/null
sleep 1
cd /workspace/knightbot-hosting
# Start server fully detached
setsid node server.js > /tmp/server.log 2>&1 &
disown
sleep 4
echo "Server log:"
cat /tmp/server.log
echo "---"
echo "Health check:"
curl -s --max-time 5 http://localhost:3000/health || echo "FAILED"
