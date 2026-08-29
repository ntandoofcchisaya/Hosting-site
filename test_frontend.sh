#!/bin/bash
# Kill old servers and start fresh, then test pages
pkill -9 -f "node server.js" 2>/dev/null
sleep 2
cd /workspace/knightbot-hosting
setsid node server.js > /tmp/server.log 2>&1 &
disown
sleep 5
echo "=== Server log ==="
cat /tmp/server.log
echo ""
echo "=== Page status codes ==="
for page in "/" "/auth" "/admin" "/dashboard" "/admin.js" "/styles.css"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000${page}")
  echo "  ${page}: ${code}"
done
echo ""
echo "=== Auth page contains login form? ==="
curl -s http://localhost:3000/auth | grep -c "authForm"
echo "=== Admin page contains install-repo? ==="
curl -s http://localhost:3000/admin | grep -c "installRepoBtn"
echo "=== Dashboard has coin display? ==="
curl -s http://localhost:3000/dashboard | grep -c "coinSection"
echo "=== Index has auth navbar? ==="
curl -s http://localhost:3000/ | grep -c "signInNavLink"
