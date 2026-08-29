#!/bin/bash
# Full backend test suite for KnightBot-Mini hosting
BASE=http://localhost:3000
pass=0; fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✅ $name"
    pass=$((pass+1))
  else
    echo "  ❌ $name (expected: $expected, got: $actual)"
    fail=$((fail+1))
  fi
}

echo "=== AUTH TESTS ==="

# 1. Admin login
ADMIN_RESP=$(curl -s -X POST $BASE/api/auth/login -H "Content-Type: application/json" -d '{"username":"ntando","password":"ntandoooe"}')
ADMIN_TOKEN=$(echo "$ADMIN_RESP" | jq -r '.token')
check "Admin login returns token" "e62d3b55\|[a-f0-9]" "$ADMIN_TOKEN"
check "Admin is admin" "true" "$(echo "$ADMIN_RESP" | jq -r '.user.isAdmin')"
check "Admin is unlimited" "true" "$(echo "$ADMIN_RESP" | jq -r '.user.isUnlimited')"

# 2. Wrong password
WRONG=$(curl -s -X POST $BASE/api/auth/login -H "Content-Type: application/json" -d '{"username":"ntando","password":"wrongpass"}')
check "Wrong password rejected" "Invalid username or password" "$WRONG"

# 3. Register new user
REG_RESP=$(curl -s -X POST $BASE/api/auth/register -H "Content-Type: application/json" -d '{"username":"bob123","password":"bobpass"}')
USER_TOKEN=$(echo "$REG_RESP" | jq -r '.token')
check "Register returns token" "[a-f0-9]" "$USER_TOKEN"
check "New user gets 50 starter coins" "50" "$(echo "$REG_RESP" | jq -r '.user.coins')"
check "New user is not admin" "false" "$(echo "$REG_RESP" | jq -r '.user.isAdmin')"

# 4. Duplicate username
DUP=$(curl -s -X POST $BASE/api/auth/register -H "Content-Type: application/json" -d '{"username":"bob123","password":"another"}')
check "Duplicate username rejected" "already taken" "$DUP"

# 5. Short username
SHORT=$(curl -s -X POST $BASE/api/auth/register -H "Content-Type: application/json" -d '{"username":"ab","password":"pass1234"}')
check "Short username rejected" "at least 3" "$SHORT"

# 6. /me endpoint
ME=$(curl -s $BASE/api/auth/me -H "x-auth-token: $USER_TOKEN")
check "/me returns username" "bob123" "$(echo "$ME" | jq -r '.user.username')"
check "/me returns economy estimate" "5" "$(echo "$ME" | jq -r '.economy.estimate.botDays')"

# 7. /me without token
NOTOKEN=$(curl -s $BASE/api/auth/me)
check "/me without token → 401" "Not logged in" "$NOTOKEN"

echo ""
echo "=== COIN TESTS ==="

# 8. Balance endpoint
BAL=$(curl -s $BASE/api/coins/balance -H "x-auth-token: $USER_TOKEN")
check "Balance shows 50 coins" "50" "$(echo "$BAL" | jq -r '.coins')"

# 9. Balance without token
BAL_NOTOKEN=$(curl -s $BASE/api/coins/balance)
check "Balance without token → 401" "Authentication required" "$BAL_NOTOKEN"

echo ""
echo "=== ADMIN TESTS ==="

# 10. Admin list users
USERS=$(curl -s $BASE/api/admin/users -H "x-auth-token: $ADMIN_TOKEN")
check "Admin lists users" "ntando" "$(echo "$USERS" | jq -r '.users[0].username')"
check "Admin lists bob123" "bob123" "$(echo "$USERS" | jq -r '.users[1].username')"

# 11. Admin route with user token → 403
FORBIDDEN=$(curl -s $BASE/api/admin/users -H "x-auth-token: $USER_TOKEN")
check "User token → admin route = 403" "Admin access required" "$FORBIDDEN"

# 12. Admin grant coins
USER_ID=$(echo "$ME" | jq -r '.user.id')
GRANT=$(curl -s -X POST $BASE/api/admin/users/$USER_ID/coins -H "x-auth-token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"amount":200,"action":"add"}')
check "Admin grants +200 coins" "250" "$(echo "$GRANT" | jq -r '.user.coins')"

# 13. Admin set coins
SETCOINS=$(curl -s -X POST $BASE/api/admin/users/$USER_ID/coins -H "x-auth-token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"amount":10,"action":"set"}')
check "Admin sets coins to 10" "\"10\"\|10" "$(echo "$SETCOINS" | jq -r '.user.coins')"

# 14. Admin toggle unlimited
UNLIM=$(curl -s -X POST $BASE/api/admin/users/$USER_ID/unlimited -H "x-auth-token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"unlimited":true}')
check "Admin toggles unlimited" "true" "$(echo "$UNLIM" | jq -r '.user.isUnlimited')"

# 15. Repo status
REPO=$(curl -s $BASE/api/admin/repo-status -H "x-auth-token: $ADMIN_TOKEN")
check "Repo status works" "ok" "$(echo "$REPO" | jq -r '.ok')"

# 16. Admin list all bots
ADMINBOTS=$(curl -s $BASE/api/admin/bots -H "x-auth-token: $ADMIN_TOKEN")
check "Admin list bots works" "ok" "$(echo "$ADMINBOTS" | jq -r '.ok')"

echo ""
echo "=== BOT ROUTE AUTH TESTS ==="

# 17. Bot list without token
BOTS_NOTOKEN=$(curl -s $BASE/api/bots)
check "Bot list without token → 401" "Authentication required" "$BOTS_NOTOKEN"

# 18. Bot list with user token
BOTS_USER=$(curl -s $BASE/api/bots -H "x-auth-token: $USER_TOKEN")
check "Bot list with token works" "ok" "$(echo "$BOTS_USER" | jq -r '.ok')"

echo ""
echo "=== LOGOUT TESTS ==="

# 19. Logout
LOGOUT=$(curl -s -X POST $BASE/api/auth/logout -H "x-auth-token: $USER_TOKEN" -H "Content-Type: application/json" -d '{}')
check "Logout works" "true" "$(echo "$LOGOUT" | jq -r '.ok')"

# 20. Token invalid after logout
AFTER_LOGOUT=$(curl -s $BASE/api/auth/me -H "x-auth-token: $USER_TOKEN")
check "Token invalid after logout" "Not logged in" "$AFTER_LOGOUT"

echo ""
echo "==============================="
echo "RESULTS: $pass passed, $fail failed"
echo "==============================="
