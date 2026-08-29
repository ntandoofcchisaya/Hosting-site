# KnightBot-Mini Hosting — Admin + Coin System

## Phase 1: Backend (userStore, botManager, server) ✅
- [x] Create userStore.js (accounts, coins, admin seed)
- [x] Update botManager.js (coin deduction, estimateRuntime)
- [x] Update server.js (auth, coins, admin, bot routes, SPA fallback)
- [x] Syntax-check all backend files

## Phase 2: Boot & Backend Test ✅
- [x] Boot server, verify admin seed (ntando/ntandoooe)
- [x] Test register / login / me endpoints
- [x] Test coin balance endpoint
- [x] Test admin route protection
- [x] Test admin: list users, grant coins, repo status
- [x] Test bot route auth gating, logout invalidation

## Phase 3: Frontend Pages ✅
- [x] Create auth.html (login + register)
- [x] Create admin.html (user list, coin grants, repo install, all bots)
- [x] Update dashboard.js to use auth tokens + show coin balance
- [x] Update dashboard.html (coin display, auth-aware nav)
- [x] Update index.html navbar (login/logout, admin link)

## Phase 4: Styling ✅
- [x] Add auth + admin styles to styles.css

## Phase 5: End-to-End Test ✅
- [x] Test full flow: register → login → dashboard → admin panel (browser-verified)
- [x] Admin login redirects to /admin, user login redirects to /dashboard
- [x] Coin display shows ∞ for admin, actual coins for users
- [x] Auth-aware navbar on all pages (login/logout, admin link)
- [x] Admin panel: user table, coin grants, engine tab, all bots tab
- [x] Test admin install-repo endpoint with real GitHub URL
- [x] Final E2E test suite: 27/27 tests PASSED

## Phase 6: Docs & Delivery ✅
- [x] Update README.md
- [x] Verify all files & attach for user
