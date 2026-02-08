# Claude Relay - Mobile Remote Session Manager

> Access and continue Claude Code sessions from your iPad/iPhone over Headscale VPN.

**Status**: Specification v3 (Final)
**Date**: February 8, 2026

---

## Problem

When away from the Mac, there's no way to continue Claude Code conversations. Work stalls until you're back at the laptop. Claude Relay bridges this gap — open the app, tap a session, and you're in Claude Code's native terminal UI over your Headscale mesh.

### Why This Matters

- **Unblock async workflows** — kick off a long-running task, leave the desk, check progress from the couch
- **Incident response** — fix a production issue from your phone without rushing home
- **Platform play** — the relay daemon pattern and future `react-native-tailscale` library extend to Atlas Mobile, Kratos Mobile, Grafana Mobile, etc.

### Target User

Power user who already runs Claude Code daily, has Headscale infrastructure, and wants continuity between desktop and mobile. Personal tool first, platform primitive second.

### Success Metrics

| Metric | Target (Month 1) |
|--------|-------------------|
| Sessions resumed from mobile / week | 5+ |
| Time from app open to first message | < 10 seconds |
| Attach success rate (succeed within 10s) | > 95% |
| Median mobile session duration | > 5 minutes |
| Days/week with a mobile session leading to a committed change | 3+ |

---

## Architecture

```
┌────────────────────────────┐                         ┌──────────────────────────┐
│   iOS/iPadOS               │    System Tailscale      │   Mac (atlas)            │
│   Claude Relay             │    (iOS VPN app)         │   100.64.0.2             │
│                            │◄───────────────────────►│                          │
│  ┌──────────────────────┐  │    Direct tailnet IP     │  ┌────────────────────┐  │
│  │  Session Picker      │  │                         │  │  Relay Daemon      │  │
│  │  (React Native)      │──┼── fetch(100.64.0.2) ──►│  │  (Node.js)         │  │
│  └──────────────────────┘  │                         │  │                    │  │
│                            │                         │  │  - Session index   │  │
│  ┌──────────────────────┐  │                         │  │  - tmux manager    │  │
│  │  Terminal View       │  │                         │  │  - WS bridge       │  │
│  │  (xterm.js WebView)  │──┼── ws(100.64.0.2) ─────►│  │    (node-pty)      │  │
│  └──────────────────────┘  │                         │  └────────────────────┘  │
│                            │                         │           │              │
│  ┌──────────────────────┐  │                         │           ▼              │
│  │  VPN Check           │  │                         │  ┌────────────────────┐  │
│  │  (ping 100.64.0.2)   │  │                         │  │  tmux sessions     │  │
│  └──────────────────────┘  │                         │  └────────────────────┘  │
└────────────────────────────┘                         └──────────────────────────┘
```

### Components

1. **Relay Daemon** (Node.js, runs on Mac) — Session index + tmux manager + WebSocket-to-terminal bridge
2. **Mobile App** (React Native) — Native session picker + xterm.js terminal in WebView
3. **System Tailscale** — iOS Tailscale app provides VPN connectivity to Headscale mesh

### Key Design Decisions

**Terminal-first**: The app embeds Claude Code's native terminal UI via xterm.js, not a custom chat UI. This means permissions, tool use, diffs, and every CLI feature work automatically. CLI updates never break the app.

**tmux for persistence**: Sessions run inside tmux. Disconnect your phone, the session keeps running. Reconnect later, scroll up and see everything that happened. Battle-tested.

**System Tailscale for now**: Phase 1-3 requires the Tailscale iOS app for VPN. Phase 4+ replaces this with embedded TailscaleKit (`@somniatore/react-native-tailscale`) so the app handles connectivity itself — no VPN toggle needed.

### Technology Choices (Researched)

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Terminal bridge | node-pty (Microsoft, 2.1M/wk npm) | Same as VS Code. ttyd as fallback. |
| Terminal render | xterm.js v6 in WebView | Industry standard. `@fressh/react-native-xtermjs-webview` proves RN works. |
| Terminal fallback | SwiftTerm v1.6 (native iOS) | If WebView keyboard is bad, swap to native Turbo Module. |
| Daemon framework | Node.js + Fastify | Shared TS types with mobile. Go rewrite in Phase 5 if distributing. |
| File watching | chokidar | macOS `fs.watch` unreliable for recursive/symlink dirs. |
| Session discovery | JSONL scanning + disk cache | No Claude Code API exists. Parse first + last 5 lines only. |
| VPN (Phase 1-3) | System Tailscale iOS app | Eliminates native module complexity. Ship fast. |
| VPN (Phase 4+) | `@somniatore/react-native-tailscale` | Embedded TailscaleKit with local TCP proxy. Reusable. |

---

## VPN Connectivity

### Phase 1-3: System Tailscale

The app connects directly to `100.64.0.2:7860` over the tailnet. This requires the Tailscale iOS app to be connected to the Headscale network.

**On app launch:**

```
App opens
  │
  ├── Ping http://100.64.0.2:7860/api/status (2s timeout)
  │
  ├── Reachable? → Load session list → Ready
  │
  └── Not reachable? → Show VPN screen:
        ┌─────────────────────────────────┐
        │                                 │
        │     Cannot reach your Mac       │
        │                                 │
        │  Open the Tailscale app and     │
        │  connect to your Headscale      │
        │  network, then tap Retry.       │
        │                                 │
        │  [Open Tailscale]    [Retry]    │
        │                                 │
        └─────────────────────────────────┘
```

- "Open Tailscale" deep-links via `tailscale://` URL scheme
- User toggles VPN on in Tailscale app, comes back, taps Retry
- For returning users, Tailscale VPN is usually already connected (iOS keeps VPN profiles active), so this screen is rarely seen
- Connection status indicator in the header shows VPN state at all times

### Phase 4+: Embedded TailscaleKit (`@somniatore/react-native-tailscale`)

Replaces the "Open Tailscale" flow with in-app auto-connect:

```
App opens
  │
  ├── TailscaleKit connects to headscale.somniatore.com (1-2s)
  │     └── Userspace WireGuard — no system VPN needed
  │
  ├── Local proxy starts on localhost (tunnels to 100.64.0.2)
  │
  └── App uses standard fetch/WebSocket to localhost → tunneled to Mac
```

The mobile app code doesn't change — only the transport layer swaps from "direct tailnet IP" to "localhost proxy." This is why the `useLocalProxy` hook abstraction matters: consumer code calls `fetch(proxyUrl + '/api/sessions')` either way.

**TailscaleKit status** (researched Feb 2026):
- Actively maintained (last commit Feb 7, 2026)
- Swift 6 async API complete
- iOS sandbox and signing issues fixed
- One App Store app ships with it (NovaAccess by GalaxNet Ltd, uses a fork)
- No pre-built binaries — must build from source
- Headscale compatibility untested publicly but should work via `ControlURL`
- Early stage — build the library when there's a second consumer (Atlas Mobile)

---

## Relay Daemon

A lightweight Node.js service running on the Mac. Three responsibilities: session discovery, tmux lifecycle, and terminal bridging.

### Tech Stack

- **Runtime**: Node.js 22+
- **Framework**: Fastify (HTTP) + ws (WebSocket)
- **Terminal**: node-pty (pseudo-terminal for tmux attachment)
- **File watching**: chokidar (reliable recursive watching on macOS)
- **Auth**: Pre-shared key

### REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List Claude sessions with metadata |
| GET | `/api/sessions/:id` | Session detail (project, last message, timestamp, tmux status) |
| GET | `/api/projects` | List projects with session counts |
| GET | `/api/status` | Daemon health, Claude CLI version, active tmux sessions |
| POST | `/api/sessions/:id/attach` | Create/attach tmux session, returns terminal WS URL |

**Error response format** (all endpoints):
```json
{
  "error": "SESSION_CONFLICT",
  "message": "This session is active on another device",
  "action": "Close the session on your Mac first, or use a different session"
}
```

### Session Discovery

Sessions are stored as JSONL at `~/.claude/projects/{project-hash}/{session-id}.jsonl`.

**Metadata extracted per session:**
- Session ID (filename)
- Project path (from directory name or first JSONL line `cwd` field)
- Last message preview (last 5 lines of JSONL)
- Timestamp (file mtime via `fs.stat` — don't parse from JSONL)
- tmux status: `active` (attached client) / `detached` (tmux alive, no client) / `none`

**Hardening:**
- Use `chokidar` for recursive file watching (handles symlinks, coalesced events)
- Periodic full rescan every 120s as a safety net
- Parse only first line + last 4KB of each JSONL (seek from end, find last newline)
- Every `JSON.parse` wrapped in try/catch — skip malformed lines, never crash
- Persist session index to `~/.config/claude-relay/session-cache.json` — on startup, only rescan files with mtime newer than cache
- Pin to minimal JSONL fields: `sessionId`, `cwd`, `type`, `timestamp`, `message.role`
- If parsing fails for a file, still list it with filename + mtime (user can still attach)
- Empty files (0 bytes) handled gracefully

### Session Locking (P0)

Before creating a tmux session, the daemon must check for conflicts:

```
POST /api/sessions/:id/attach
  │
  ├── Check: Is there already a node-pty/WS active for this session?
  │     └── Yes → 409 { error: "SESSION_ATTACHED", action: "Already connected from another device" }
  │
  ├── Check: Is a Claude process already running with this session ID?
  │     └── pgrep -f "claude.*--resume.*{session-id}"
  │     └── Yes → 409 { error: "SESSION_CONFLICT", action: "Close Claude on your Mac first" }
  │
  ├── Check: Does a tmux session already exist for this ID?
  │     └── tmux has-session -t claude-{id} 2>/dev/null
  │     └── Yes → Attach to existing (session was detached from previous mobile connection)
  │
  └── No conflicts → tmux new-session -d -s claude-{id} ... claude --resume {id}
       └── Return { wsUrl: "/terminal/{id}", tmuxSession: "claude-{id}" }
```

**Serialization**: The `POST /attach` handler is serialized per session ID (not globally) using an in-memory lock map. This prevents race conditions from rapid taps.

### tmux Integration

```bash
# Create new tmux session with Claude
tmux new-session -d -s claude-{session-id} -x 120 -y 40 \
  "claude --resume {session-id}"

# Check if session exists
tmux has-session -t claude-{session-id} 2>/dev/null

# List active sessions
tmux list-sessions -F "#{session_name}:#{session_attached}"
```

**Session naming**: Full session UUID (not truncated). tmux allows up to 256 chars.

**Cleanup**: When Claude exits, the tmux session closes automatically. The daemon detects this via tmux session events and updates its index.

### WebSocket Terminal Bridge

```
WS /terminal/:sessionId
  ├── Query: ?cols=120&rows=40
  ├── Auth: Authorization: Bearer <psk>
  │
  ├── Client → Server: raw terminal input (binary frames)
  ├── Server → Client: raw terminal output (binary frames)
  │
  └── Text frames for control messages:
      { "type": "resize", "cols": 100, "rows": 50 }
      { "type": "heartbeat" }
```

**node-pty lifecycle (P0)**:

On WS connect:
- Spawn `node-pty` running `tmux attach-session -t claude-{id}`
- Pipe PTY stdout → WS (binary frames)
- Pipe WS input → PTY stdin

On WS disconnect (mobile backgrounded, VPN drop, app killed):
- Explicitly call `ptyProcess.kill()` — do NOT leave it running
- Verify process exited (check with timeout, escalate to SIGKILL after 5s)
- tmux session stays alive (tmux detaches the client automatically)
- Claude process continues running inside tmux

**Safeguards:**
- Track active node-pty processes per session — refuse new WS if one already active
- Reap timer every 60s: check for orphaned node-pty processes whose WS is gone
- On daemon startup: `pkill -f "tmux attach"` orphans from previous daemon instance
- On daemon startup: `tmux list-sessions -F "#{session_name}"` to discover existing `claude-*` sessions and reconcile with session index

**Backpressure / flow control:**
- Check `ws.bufferedAmount` before writing terminal output — pause if buffer exceeds 64KB
- Batch terminal output at 16ms intervals (60fps) to avoid flooding the WS
- Buffer node-pty output to avoid splitting multi-byte UTF-8 characters
- Use binary WebSocket frames for terminal data, text frames for control messages
- Use xterm.js `write(Uint8Array)` on the client (handles raw bytes correctly)

### Configuration

```yaml
# ~/.config/claude-relay/config.yaml
port: 7860
host: "0.0.0.0"
auth:
  psk: "generated-secret-key"    # chmod 600 this file
tmux:
  defaultCols: 120
  defaultRows: 40
  scrollbackLines: 10000
claude:
  binary: "claude"
  maxSessions: 5
rateLimit:
  attachPerSession: "1/5s"       # max 1 attach per session per 5 seconds
  wsHeartbeat: 30                # ping interval in seconds
  wsMaxMissedPongs: 3            # disconnect after 3 missed pongs
```

### Auto-Start (launchd)

```xml
<!-- ~/Library/LaunchAgents/com.somniatore.claude-relay.plist -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.somniatore.claude-relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/ghaz/.nvm/versions/node/v22.x.x/bin/node</string>
    <string>/path/to/claude-relay/daemon/dist/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/ghaz/Library/Logs/claude-relay/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/ghaz/Library/Logs/claude-relay/daemon.log</string>
</dict>
</plist>
```

Note: Pin Node path to specific nvm version to survive Homebrew upgrades. Log to `~/Library/Logs/` (not `/tmp`) with rotation via pino-roll.

---

## Mobile App

### Tech Stack

- **Framework**: React Native 0.76+ (New Architecture)
- **Navigation**: React Navigation 7
- **State**: Zustand
- **Terminal**: xterm.js v6 in WebView via `@fressh/react-native-xtermjs-webview` (or custom wrapper)
- **Terminal fallback**: SwiftTerm v1.6 as React Native Turbo Module (if WebView keyboard is bad)
- **Secure storage**: react-native-keychain (PSK + daemon address)
- **Platform**: iOS 17+ / iPadOS 17+

### Screens

#### 1. VPN Check (shown when Mac unreachable)

```
Cannot reach your Mac
─────────────────────
Open the Tailscale app and connect to
your Headscale network, then tap Retry.

[Open Tailscale]    [Retry]
```

- Deep-links to Tailscale app via `tailscale://` URL scheme
- Auto-retries every 5s in background while screen is shown
- Disappears automatically when Mac becomes reachable

#### 2. Setup (first launch only)

Guided checklist — user can't proceed until all pass:

```
Setup Claude Relay
──────────────────
[✓] Tailscale connected
[✓] Mac reachable (atlas — 100.64.0.2)
[✓] Relay daemon running (v1.0.0, Claude 2.1.37)
[ ] Enter relay key: ________________  [Save]
```

- Stores daemon address + PSK in iOS Keychain
- Shows actionable errors ("Daemon unreachable — is it running on atlas?")
- Only shown once — subsequent launches go straight to session list

#### 3. Session List

- Sessions grouped by project, sorted by recency
- Each row: project name, last message preview, relative timestamp ("2h ago")
- Status badge: `Active` (tmux attached) / `Detached` (tmux alive) / none
- Pull-to-refresh
- Search bar (filter by project or content)
- Tap → POST /attach → open Terminal View

#### 4. Terminal View

- Full-screen xterm.js WebView (xterm.js HTML bundled as local asset — no CDN)
- Connects to `ws://{daemon}/terminal/{sessionId}`
- Claude Code's native terminal UI renders exactly as on Mac
- Toolbar: session name, disconnect button, connection status
- Disconnect button detaches tmux (goes back to session list)

#### 5. Session Info (long-press on session row)

- Session ID, project path, created date
- tmux session name and status
- "New Session" button — creates fresh `claude` session in same project

### iPad Layout

- Split view: session list sidebar (320pt) + terminal main area
- Keyboard shortcuts:
  - `Cmd+K` — Quick session search
  - `Cmd+D` — Detach (go back to list)
  - Full keyboard pass-through to terminal when focused

### Offline / Disconnected

- Cache session list in AsyncStorage for instant display on launch
- Show "Reconnecting..." banner when VPN drops
- tmux sessions keep running on Mac — no data loss
- On reconnect, re-attach to tmux — scrollback shows what happened while away

### Custom Keyboard Toolbar (iPhone)

Claude Code needs special keys (Escape, Tab, Ctrl+C, arrow keys) that the iOS software keyboard doesn't provide. Add an input accessory view above the keyboard:

```
[Esc] [Tab] [Ctrl] [↑] [↓] [←] [→] [/]
```

---

## Security

| Layer | Mechanism |
|-------|-----------|
| Transport | WireGuard (via system Tailscale VPN) |
| Network ACL | Headscale ACL restricts which nodes can reach atlas:7860 |
| Daemon Auth | PSK validated on every REST/WS request |
| Authorization | Single user (no multi-tenancy) |
| Secrets | PSK in iOS Keychain, daemon config `chmod 600` |
| Process isolation | Claude CLI runs as user's own macOS process |
| Data locality | Session files never leave the Mac; mobile sees terminal output only |

### Rate Limiting

- Max 1 `POST /attach` per session per 5 seconds
- Max `maxSessions` concurrent tmux sessions (default: 5)
- WebSocket heartbeat every 30s; disconnect after 3 missed pongs
- All auth attempts logged with source IP

### Headscale ACL

Restrict daemon port to mobile node only:
```json
{ "action": "accept", "src": ["tag:mobile"], "dst": ["tag:server:7860"] }
```

---

## Project Structure

Two packages (library deferred to Phase 4):

```
claude-relay/
├── specs.md                           # This file
├── package.json                       # Workspace root
│
├── daemon/                            # Relay daemon (Node.js, runs on Mac)
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                   # Entry point (Fastify + WS)
│   │   ├── config.ts                  # YAML config loader
│   │   ├── auth.ts                    # PSK middleware
│   │   ├── sessions/
│   │   │   ├── discovery.ts           # JSONL scanner + chokidar watcher + disk cache
│   │   │   └── types.ts              # Session metadata types
│   │   ├── tmux/
│   │   │   ├── manager.ts            # Create/attach/list/kill tmux sessions
│   │   │   ├── lock.ts               # Per-session mutex for attach serialization
│   │   │   └── types.ts
│   │   ├── terminal/
│   │   │   └── bridge.ts             # WS ↔ node-pty ↔ tmux attach
│   │   └── routes/
│   │       ├── sessions.ts           # GET /api/sessions, GET /api/sessions/:id
│   │       ├── attach.ts             # POST /api/sessions/:id/attach
│   │       └── status.ts             # GET /api/status
│   ├── tests/
│   └── launchd/
│       └── com.somniatore.claude-relay.plist
│
├── mobile/                            # React Native app
│   ├── package.json
│   ├── app.json
│   ├── src/
│   │   ├── App.tsx
│   │   ├── screens/
│   │   │   ├── VpnCheckScreen.tsx     # "Open Tailscale" fallback
│   │   │   ├── SetupScreen.tsx        # First-launch checklist
│   │   │   ├── SessionListScreen.tsx  # Session picker
│   │   │   ├── TerminalScreen.tsx     # xterm.js WebView
│   │   │   └── SessionInfoScreen.tsx
│   │   ├── components/
│   │   │   ├── SessionRow.tsx
│   │   │   ├── StatusBadge.tsx
│   │   │   ├── TerminalWebView.tsx    # xterm.js wrapper (local HTML asset)
│   │   │   ├── KeyboardToolbar.tsx    # Esc/Tab/Ctrl/arrows accessory view
│   │   │   └── SetupChecklist.tsx
│   │   ├── services/
│   │   │   ├── relay.ts              # REST API client (direct fetch to tailnet IP)
│   │   │   └── storage.ts            # Keychain + AsyncStorage
│   │   ├── stores/
│   │   │   ├── connection.ts         # VPN + daemon connection state
│   │   │   └── sessions.ts           # Session list cache
│   │   ├── assets/
│   │   │   └── terminal.html         # Bundled xterm.js page (no CDN dependency)
│   │   └── types/
│   │       └── session.ts
│   └── ios/
│
└── packages/                          # Phase 4+
    └── react-native-tailscale/        # @somniatore/react-native-tailscale (deferred)
        └── README.md                  # "Coming in Phase 4"
```

---

## Implementation Phases

### Phase 1: Relay Daemon MVP (~1 week)

**Goal**: Attach to a Claude session from any terminal via the daemon.

1. Session discovery — chokidar watcher, JSONL head/tail parsing, disk cache
2. tmux manager — create/attach/list with session locking and conflict detection
3. Terminal bridge — WebSocket ↔ node-pty ↔ tmux attach, with cleanup on disconnect
4. REST API — `GET /sessions`, `POST /sessions/:id/attach`, `GET /status`
5. PSK auth — validate on all requests
6. Config — YAML loader with defaults
7. Structured error responses on all endpoints

**Deliverable**: Run daemon on Mac, connect via `wscat` or browser xterm.js demo. Resume Claude sessions remotely.

**Validation**: `curl /api/sessions` lists sessions. Open xterm.js page at `ws://localhost:7860/terminal/{id}` and interact with Claude.

### Phase 2: Mobile App (~2 weeks)

**Goal**: Session picker + terminal on iPad/iPhone, using system Tailscale for VPN.

1. VPN check screen — ping daemon, "Open Tailscale" deep-link, auto-retry
2. Setup screen — first-launch checklist (daemon reachable, PSK entry)
3. Session list — fetch via direct tailnet IP, grouped by project
4. Terminal view — xterm.js in WebView (bundled HTML asset), connecting to daemon WS
5. iPad split view (session list sidebar + terminal)
6. iPhone keyboard toolbar (Esc, Tab, Ctrl, arrows)
7. Basic keyboard shortcuts (Cmd+K, Cmd+D)

**Deliverable**: Open app → Tailscale connected → see sessions → tap → Claude Code terminal.

**Validation**: Resume a real Claude session from iPad, do meaningful work, verify tmux persists on disconnect.

### Phase 3: Launch Polish (~1 week)

**Must-have (launch blockers):**
1. launchd plist for daemon auto-start + log rotation
2. Auto-reconnect with exponential backoff on VPN drop
3. Offline session list caching (AsyncStorage)
4. Session conflict UX — clear error messages, "session active on Mac" warnings

**Nice-to-have (post-launch):**
5. Session status badges (active/detached indicators)
6. New session creation (pick project, start fresh)
7. Session info screen (token usage if parseable from JSONL)
8. Daemon installer script with QR code for mobile setup

### Phase 4: `@somniatore/react-native-tailscale` (~2-3 weeks)

**Goal**: Reusable library — any RN app joins the Somniatore tailnet without system VPN.

Build this when Atlas Mobile or Kratos Mobile needs it, OR when TailscaleKit matures further.

1. Build TailscaleKit.xcframework from libtailscale source (Go + cgo)
2. Swift native module — `start()`, `stop()`, `status()`, `getProxyPort()`
3. LocalProxy.swift — TCP proxy on localhost:0 (dynamic port) tunneling via TailscaleKit
4. TailscaleProvider context + `useTailscale()` + `useLocalProxy()` hooks
5. Headscale compatibility testing (ControlURL field)
6. Example app — connect to tailnet, reach daemon, display terminal
7. Publish v0.1.0 to `npm.somniatore.com`

**Replaces**: VPN check screen → auto-connect. `fetch(proxyUrl + '/api/sessions')` instead of `fetch('http://100.64.0.2:7860/api/sessions')`. Consumer code barely changes.

### Phase 5: Platform Expansion

- **Atlas Mobile** — K8s dashboard, reuses `react-native-tailscale`
- **Kratos Mobile** — deployment management from phone
- **Go daemon rewrite** — single static binary, distributable via Homebrew
- **SwiftTerm native module** — if xterm.js WebView keyboard is insufficient
- **Push notifications** — daemon sends APNs when long-running task completes
- **Voice input** — iOS Speech framework → terminal input
- **Android** — libtailscale JNI bindings for `react-native-tailscale`
- **Multiple Macs** — daemon discovery via Tailscale peer list

---

## Development Setup

### Prerequisites

- Mac (atlas) on Headscale at 100.64.0.2
- tmux installed (`brew install tmux`)
- Node.js 22+ (`nvm install 22`)
- Claude Code CLI installed and authenticated
- iOS device with Tailscale app connected to Headscale

### Relay Daemon

```bash
cd daemon
npm install
cp config.example.yaml ~/.config/claude-relay/config.yaml
chmod 600 ~/.config/claude-relay/config.yaml
# Edit config: set PSK
npm run dev
# Verify: curl http://localhost:7860/api/status
```

### Mobile App

```bash
cd mobile
npm install
npx pod-install ios
npm run ios          # Simulator
# Or: open ios/*.xcworkspace in Xcode for device builds
```

### End-to-End Test

```bash
# 1. Daemon running on Mac
curl http://localhost:7860/api/status
# → { "version": "1.0.0", "claude": "2.1.37", "activeSessions": 0 }

# 2. List sessions
curl -H "Authorization: Bearer <psk>" http://localhost:7860/api/sessions
# → [{ "id": "abc123...", "project": "/Users/ghaz/myapp", ... }]

# 3. Attach to session
curl -X POST -H "Authorization: Bearer <psk>" http://localhost:7860/api/sessions/abc123.../attach
# → { "wsUrl": "/terminal/abc123...", "tmuxSession": "claude-abc123..." }

# 4. Connect terminal
npx wscat -c "ws://localhost:7860/terminal/abc123...?cols=120&rows=40" -H "Authorization: Bearer <psk>"
# → Claude Code terminal output streams
```

---

## Failure Modes

| Scenario | Detection | User Sees | Recovery |
|----------|-----------|-----------|----------|
| VPN disconnected | Ping fails | "Cannot reach Mac" + "Open Tailscale" button | Toggle VPN, tap Retry |
| Daemon crashed | `/api/status` fails | "Daemon unreachable" | launchd auto-restarts; app auto-retries |
| tmux session died | tmux has-session fails | Session disappears from list | Start new session |
| Claude process crashed | tmux session closes | Session moves to "none" status | Tap to start new Claude in same project |
| Session conflict (Mac + mobile) | pgrep detects running Claude | 409 error: "Session active on Mac" | Close on Mac, or pick different session |
| WebSocket drops mid-session | WS close event | "Reconnecting..." banner | Auto-reconnect; tmux preserves session |
| iOS backgrounds app | WS closes, TailscaleKit freezes | Nothing (user left app) | On foreground: VPN reconnects, WS reconnects, tmux reattaches |
| Node-pty orphan | Reap timer (60s) | Nothing (invisible) | Daemon kills orphan automatically |

---

## Open Questions

1. **xterm.js WebView keyboard on iPhone** — Predictive text interference, special keys. The keyboard toolbar helps, but needs testing. SwiftTerm Turbo Module is the fallback.

2. **Terminal sizing** — Auto-fitting xterm.js to different screen sizes. Start with daemon defaults (120x40), add dynamic resize in Phase 3 via `{ type: "resize" }` control message.

3. **`claude --resume` workspace trust prompt** — May ask to trust workspace on first resume in a new terminal context. Needs testing — should render fine in terminal.

4. **JSONL format stability** — Internal format, may change between CLI versions. Pin to minimal fields, handle parse failures gracefully, budget time for fixes after CLI updates.

5. **Headscale pre-auth key lifecycle (Phase 4)** — Keys expire. Library should detect auth failure and prompt re-auth. Use long-lived keys (8760h).

---

## Appendix: v1 vs v2 vs v3 Comparison

| Concern | v1: Custom Bridge | v2: tmux + Terminal | v3: + System Tailscale |
|---------|-------------------|---------------------|------------------------|
| Permission prompts | Custom relay protocol | Native terminal | Native terminal |
| Tool use rendering | Custom chat UI | Native terminal | Native terminal |
| CLI update resilience | Breaks on format changes | Just works | Just works |
| Session persistence | Custom process manager | tmux | tmux |
| VPN connectivity | Embedded TailscaleKit | Embedded TailscaleKit | System Tailscale (Phase 4: embedded) |
| Native modules | TailscaleKit Swift module | TailscaleKit Swift module | Zero (Phase 4: add library) |
| Code complexity | ~3000 lines | ~2500 lines | ~1500 lines |
| Time to ship | ~6 weeks | ~4 weeks | ~2-3 weeks |

---

*Last Updated: February 8, 2026*
