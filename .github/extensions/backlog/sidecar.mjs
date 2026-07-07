// Sidecar viewer: singleton process owns one HTTP+WS server bound to a
// fixed port (SHARED_PORT) plus the chromeless browser window. Other
// extension processes register as clients over /peer WS and forward their
// session info, mutations, and engage callbacks through the owner.
//
// Roles:
//   owner  — bound the fixed port; runs server; spawns viewer; tracks peers.
//   client — connected to owner over WS; mutates DB locally then asks owner
//            to refresh; receives engage requests and calls session.send().
//
// All sessions share a DB (WAL mode) so the owner can serve a unified view
// of every session's items by querying directly. Clients still mutate the
// DB themselves — peer messages only carry intent and identity, not data.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, watch } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as net_module from "node:net";

import { db, BACKLOG_DIR, setSessionLabel, getSessionLabel, getItemPorContext } from "./db.mjs";
import {
  addItem,
  moveTop,
  moveUp,
  moveDown,
  editItem,
  removeItem,
  getTopItem,
  resolveItemRef,
} from "./items.mjs";
import { makeEngagePrompt } from "./prompt.mjs";
import { getRuntimeInfo } from "./doctor.mjs";
import { listHumanDecisions } from "./review-channel.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SHARED_PORT = 47823;
export const HEARTBEAT_MS = 2000;
export const STALE_OWNER_MS = 6000;

const VIEWER_HTML_PATH = join(__dirname, "viewer.html");
const FAVICON_PATH = join(__dirname, "favicon.svg");

function loadViewerHtml() {
  return existsSync(VIEWER_HTML_PATH)
    ? readFileSync(VIEWER_HTML_PATH, "utf8")
    : "<h1>viewer.html missing</h1>";
}
function loadFavicon() {
  return existsSync(FAVICON_PATH) ? readFileSync(FAVICON_PATH) : null;
}
let VIEWER_HTML = loadViewerHtml();
let FAVICON_SVG = loadFavicon();

// Watch viewer.html and favicon.svg so any process that happens to be the
// owner picks up edits without needing the user to click refresh or wait
// for failover. Debounced because editors typically write twice (truncate
// + write) which fires two "change" events back-to-back.
let assetReloadTimer = null;
function scheduleAssetReload() {
  if (assetReloadTimer) return;
  assetReloadTimer = setTimeout(() => {
    assetReloadTimer = null;
    try { VIEWER_HTML = loadViewerHtml(); } catch {}
    try { FAVICON_SVG = loadFavicon(); } catch {}
  }, 100);
}
try { watch(VIEWER_HTML_PATH, { persistent: false }, scheduleAssetReload); } catch {}
try { watch(FAVICON_PATH,    { persistent: false }, scheduleAssetReload); } catch {}

export const sidecarState = {
  role: null,                  // "owner" | "client" | null
  // Owner-only:
  server: null,
  token: "",                   // shared with browser; clients re-use across failover
  wsClients: new Set(),        // browser WS sockets
  peers: new Map(),            // sessionId -> { socket, label, cwd, repo, branch }
  viewerProc: null,
  lastSpawnAt: 0,                // debounce for window respawn
  heartbeatTimer: null,
  ownerStartedAt: null,
  electionInFlight: false,
  // Owner-only viewer visibility flags. Pinning is gone:
  //   forceOpen          — /backlog show sets true so the viewer opens even
  //                        when the backlog is empty. Cleared on user-close.
  //   viewerSuppressed   — user closed the window themselves; stay closed
  //                        until a new item is added or /backlog show.
  //   programmaticClose  — distinguishes our own close (no suppression)
  //                        from the user clicking the X.
  forceOpen: false,
  viewerSuppressed: false,
  programmaticClose: false,
  // Sessions in burndown mode — when an item completes (markDone), the next
  // top item is auto-engaged. In-memory only; cleared on owner restart and
  // when the session disconnects.
  burndown: new Set(),
  // sessionId -> itemId currently dispatched for engagement. Set when an
  // engage prompt is sent; cleared when that item is markDone'd / removed
  // / no longer pending. Drives the viewer's "engaging…" badge so manual
  // clicks and burndown auto-engage look the same. Burndown auto-advance
  // is gated on `state === "idle"` (below), not on this — the engaging map
  // is purely a visual signal.
  engaging: new Map(),
  // sessionId -> "idle" | "busy". The agent's activity state, derived from
  // SDK events and bumped to "busy" immediately when we programmatically
  // inject an engage prompt via session.send, so back-to-back burndown
  // advances don't race the not-yet-published busy signal. Drives the rail
  // chip dot color and gates burndown auto-advance.
  // Defaults to "idle" on first sighting of a session.
  sessionState: new Map(),
  deferViewerClose: 0,
  deferredViewerClose: false,
  // Client-only:
  peerSocket: null,
  peerReconnectTimer: null,
  failoverTimer: null,
  // Always:
  sessionRef: null,
  activeSessionId: null,
};

// Setters used by extension.mjs to push state in without circular import.
export function setActiveSessionId(id) { sidecarState.activeSessionId = id; }
export function setSessionRef(ref)     { sidecarState.sessionRef = ref; }

export function getCurrentItems(sessionId) {
  return db.prepare(`
    SELECT id, description, position, queue_id, priority, status, created_at
    FROM items
    WHERE session_id = ? AND status = ? AND (queue_id = ? OR queue_id IS NULL)
    ORDER BY position
  `).all(sessionId, "pending", "inbox");
}

function summarizePorContext(context) {
  if (!context) return null;
  const parts = [];
  if (context.por_id) parts.push(`por:${context.por_id}`);
  if (context.kind && context.kind !== "por") parts.push(context.kind);
  const metadata = context.metadata && typeof context.metadata === "object" ? context.metadata : {};
  const metadataKeys = Object.keys(metadata).filter((key) => metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== "");
  if (metadataKeys.length > 0) {
    const sample = metadataKeys.slice(0, 2).map((key) => `${key}:${String(metadata[key]).slice(0, 24)}`).join(", ");
    parts.push(sample);
  }
  return parts.length > 0 ? parts.join(" • ") : null;
}

function buildQueueSnapshot(sessions) {
  const queueRows = db.prepare("SELECT id, name, description, metadata_json FROM queues ORDER BY name, created_at").all();
  const rows = db.prepare(`
    SELECT
      i.rowid AS item_rowid,
      i.id,
      i.session_id,
      i.description,
      i.position,
      i.priority,
      i.status,
      i.created_at,
      i.queue_id,
      q.rowid AS queue_rowid,
      q.name AS queue_name,
      q.description AS queue_description,
      q.metadata_json AS queue_metadata_json
    FROM items i
    LEFT JOIN queues q ON q.id = i.queue_id
    WHERE i.status = ?
    ORDER BY COALESCE(q.name, 'Inbox'), i.position
  `).all("pending");
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const queues = new Map();

  function ensureQueue(id, name, description, metadata) {
    if (!queues.has(id)) {
      queues.set(id, { id, name: name || "Inbox", description: description || null, metadata: metadata || {}, items: [], itemCount: 0 });
    }
    return queues.get(id);
  }

  for (const row of queueRows) {
    ensureQueue(row.id, row.name || "Inbox", row.description, row.metadata_json ? JSON.parse(row.metadata_json) : {});
  }

  for (const row of rows) {
    const session = sessionsById.get(row.session_id) || {
      id: row.session_id,
      label: row.session_id.slice(0, 8),
      live: false,
      state: "offline",
    };
    const queueId = row.queue_id;
    if (!queueId) continue;
    if (typeof row.queue_rowid === "number" && typeof row.item_rowid === "number" && row.queue_rowid >= row.item_rowid) continue;
    const queue = ensureQueue(queueId, row.queue_name || (queueId === "inbox" ? "Inbox" : queueId), row.queue_description, row.queue_metadata_json ? JSON.parse(row.queue_metadata_json) : {});
    const porContext = getItemPorContext(row.id);
    queue.items.push({
      id: row.id,
      session_id: row.session_id,
      session_label: session.label,
      session_live: !!session.live,
      session_state: session.state,
      description: row.description,
      position: row.position,
      queue_id: queueId,
      priority: row.priority,
      status: row.status,
      created_at: row.created_at,
      por_context: porContext ? { porId: porContext.por_id, kind: porContext.kind, metadata: porContext.metadata } : null,
      por_context_summary: summarizePorContext(porContext),
    });
    queue.itemCount += 1;
  }

  for (const queue of queues.values()) {
    queue.items.sort((a, b) => {
      if (b.position !== a.position) return b.position - a.position;
      const left = a.created_at || "";
      const right = b.created_at || "";
      return right.localeCompare(left);
    });
  }

  return [...queues.values()].map((queue) => ({
    ...queue,
    items: queue.items,
  }));
}

// ---- Lock file (owner identity for failover) ----

function lockPath() { return join(BACKLOG_DIR, "viewer.lock"); }

export function readLock() {
  try {
    const raw = readFileSync(lockPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && typeof parsed?.port === "number") return parsed;
    return null;
  } catch { return null; }
}

// Atomic lock write — write to a sibling tmp file and rename. Without this,
// a heartbeat in flight can leave a partial file that readLock() rejects,
// which would tempt the failover path to mint a fresh token and strand the
// browser viewer. Token is preserved across writes — only minted at owner
// election time when no usable token exists.
export function writeLock(extra = {}) {
  if (!sidecarState.token) return;
  const payload = JSON.stringify({
    port: SHARED_PORT,
    token: sidecarState.token,
    ownerPid: process.pid,
    startedAt: extra.startedAt || sidecarState.ownerStartedAt || new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  });
  const tmp = lockPath() + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, lockPath());
  } catch { try { unlinkSync(tmp); } catch {} }
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

export function lockIsStale(lock) {
  if (!lock) return true;
  if (!pidAlive(lock.ownerPid)) return true;
  const hbMs = Date.parse(lock.heartbeatAt);
  if (!hbMs || Date.now() - hbMs > STALE_OWNER_MS) return true;
  return false;
}

// ---- Snapshot assembly ----

// One unified payload for the browser. The viewer is the source of truth
// for what's in the DB — every session with pending items appears, even
// if no live extension process is currently registered for it (orphan).
// Live peers contribute cwd/repo/branch metadata; orphans surface their
// stored label (or short-id) and are flagged live:false so the UI can
// render them as offline (red dot, engage disabled).
export function buildSnapshot(activeSessionIdHint) {
  const peers = sidecarState.peers;
  const sessions = [];
  const seen = new Set();
  for (const [sid, peer] of peers) {
    sessions.push({
      id: sid,
      label: peer.label || sid.slice(0, 8),
      cwd: peer.cwd || null,
      repo: peer.repo || null,
      branch: peer.branch || null,
      live: true,
      burndown: sidecarState.burndown.has(sid),
      engagingId: sidecarState.engaging.get(sid) || null,
      state: sidecarState.sessionState.get(sid) || "idle",
      items: getCurrentItems(sid),
    });
    seen.add(sid);
  }
  // Orphan sessions: any session in the DB with pending items but no live peer.
  const orphanRows = db.prepare(`
    SELECT s.id, s.label
    FROM sessions s
    WHERE EXISTS (SELECT 1 FROM items i WHERE i.session_id = s.id AND i.status = 'pending')
    ORDER BY s.last_accessed DESC
  `).all();
  for (const row of orphanRows) {
    if (seen.has(row.id)) continue;
    sessions.push({
      id: row.id,
      label: row.label || row.id.slice(0, 8),
      cwd: null,
      repo: null,
      branch: null,
      live: false,
      burndown: false,
      engagingId: null,
      state: "offline",
      items: getCurrentItems(row.id),
    });
  }
  return {
    type: "snapshot",
    activeSessionId: activeSessionIdHint || sessions.find(s => s.live)?.id || sessions[0]?.id || null,
    activeQueueId: null,
    runtime: getRuntimeInfo(),
    decisions: listHumanDecisions(),
    queues: buildQueueSnapshot(sessions),
    sessions,
  };
}

function ownerWantVisible() {
  if (sidecarState.role !== "owner") return false;
  if (sidecarState.forceOpen) return true;
  if (sidecarState.viewerSuppressed) return false;
  const row = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM items WHERE status = 'pending') AS has_items"
  ).get();
  return !!row?.has_items;
}

// Called when a new item appears or /backlog show is invoked — drops the
// "user closed it, leave it closed" flag so the viewer can reopen.
export function clearViewerSuppression() {
  if (sidecarState.role !== "owner") {
    if (sidecarState.role === "client") peerSend({ type: "show" });
    return;
  }
  sidecarState.viewerSuppressed = false;
}

// Re-broadcast the unified snapshot to every connected browser, and decide
// whether the viewer window should be open. Called whenever DB state or
// peer state changes on the owner.
function ownerRefresh(activeSessionIdHint) {
  if (sidecarState.role !== "owner") return;
  syncOwnerVisibility();
  if (!sidecarState.server) return;
  const payload = JSON.stringify(buildSnapshot(activeSessionIdHint));
  for (const ws of sidecarState.wsClients) {
    try { wsSendText(ws, payload); } catch {}
  }
}

// Idempotent visibility decision — owner-side. Window-alive is inferred
// from active browser WS connections (the launcher process always exits
// immediately so its lifetime tells us nothing). lastSpawnAt is a short
// debounce that suppresses duplicate spawns during the 1–2s window between
// launcher exit and the page connecting back via /ws.
function syncOwnerVisibility() {
  if (sidecarState.role !== "owner") return;
  const want = ownerWantVisible();
  const windowAlive = sidecarState.wsClients.size > 0;
  const recentlySpawned = Date.now() - sidecarState.lastSpawnAt < 5000;
  if (!want) {
    if (sidecarState.deferViewerClose > 0) {
      sidecarState.deferredViewerClose = true;
      return;
    }
    closeViewerWindow();
    return;
  }
  if (!windowAlive && !recentlySpawned) spawnViewerWindow();
}

function deferViewerCloseUntilResponseFinishes(res) {
  sidecarState.deferViewerClose++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    sidecarState.deferViewerClose = Math.max(0, sidecarState.deferViewerClose - 1);
    if (sidecarState.deferViewerClose === 0 && sidecarState.deferredViewerClose) {
      sidecarState.deferredViewerClose = false;
      setImmediate(syncOwnerVisibility);
    }
  };
  if (typeof res.once === "function") res.once("finish", release);
  else queueMicrotask(release);
}

// Cross-role entry point used by every mutation site. Routes based on role.
export function notifyChange(sessionId) {
  if (sidecarState.role === "owner") {
    ownerRefresh(sessionId);
  } else if (sidecarState.role === "client") {
    peerSend({ type: "refresh", sessionId });
  }
}

// Backwards-compat alias used throughout the codebase.
export function sidecarBroadcast(sessionId) { notifyChange(sessionId); }

// ---- Hand-rolled WebSocket (RFC 6455) ----

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function wsAcceptKey(secWsKey) {
  return createHash("sha1").update(secWsKey + WS_GUID).digest("base64");
}

export function wsSendText(socket, text) {
  const data = Buffer.from(text, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, data]));
}

function wsSendClose(socket) {
  try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
  try { socket.end(); } catch {}
}

// Frame parser shared by browser-WS and peer-WS server sides. Calls
// onText(string) for each complete unmasked text payload. Server-to-client
// frames are unmasked; client-to-server frames are masked per RFC 6455.
function attachWsTextReader(socket, onText) {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buf.length < off + 8) return; len = Number(buf.readBigUInt64BE(off)); off += 8; }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { wsSendClose(socket); continue; } // close
      if (opcode === 0x1 || opcode === 0x0) {
        try { onText(payload.toString("utf8")); }
        catch (e) { try { sidecarState.sessionRef?.log(`ws read error: ${e.message}`, { level: "warn" }); } catch {} }
      }
      // Ignore binary (0x2) and control frames (0x9 ping, 0xa pong).
    }
  });
}

function handleBrowserWsUpgrade(req, socket) {
  const url = new URL(req.url, "http://x");
  if (url.searchParams.get("token") !== sidecarState.token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );
  sidecarState.wsClients.add(socket);
  wsSendText(socket, JSON.stringify(buildSnapshot()));
  attachWsTextReader(socket, () => {}); // browser doesn't send via WS today
  const cleanup = () => {
    const wasMember = sidecarState.wsClients.delete(socket);
    // If the user closed the window themselves (not us tearing it down),
    // suppress auto-reopen until a new item arrives or /backlog show fires.
    if (wasMember && !sidecarState.programmaticClose && sidecarState.wsClients.size === 0) {
      sidecarState.viewerSuppressed = true;
      sidecarState.forceOpen = false;
    }
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

function handlePeerWsUpgrade(req, socket) {
  const url = new URL(req.url, "http://x");
  if (url.searchParams.get("token") !== sidecarState.token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );
  let registeredSid = null;
  attachWsTextReader(socket, (text) => {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === "register") {
      registeredSid = msg.sessionId;
      sidecarState.peers.set(registeredSid, {
        socket,
        label: msg.label || null,
        cwd: msg.cwd || null,
        repo: msg.repo || null,
        branch: msg.branch || null,
      });
      // Initial state: assume idle on registration. Clients publish a
      // "state" message immediately after register if they're already busy.
      if (!sidecarState.sessionState.has(registeredSid)) {
        sidecarState.sessionState.set(registeredSid, "idle");
      }
      if (msg.label) setSessionLabel(registeredSid, msg.label);
      syncOwnerVisibility();
      ownerRefresh(registeredSid);
    } else if (msg.type === "label") {
      const peer = sidecarState.peers.get(msg.sessionId);
      if (peer) peer.label = msg.label;
      if (msg.label) setSessionLabel(msg.sessionId, msg.label);
      ownerRefresh();
    } else if (msg.type === "refresh") {
      ownerRefresh(msg.sessionId);
    } else if (msg.type === "show") {
      sidecarState.forceOpen = true;
      sidecarState.viewerSuppressed = false;
      syncOwnerVisibility();
      ownerRefresh();
    } else if (msg.type === "burndown") {
      setBurndown(msg.sessionId, !!msg.enabled);
    } else if (msg.type === "state") {
      if (msg.state === "idle" || msg.state === "busy") {
        setSessionState(msg.sessionId, msg.state);
      }
    } else if (msg.type === "unregister") {
      if (registeredSid) {
        sidecarState.peers.delete(registeredSid);
        sidecarState.burndown.delete(registeredSid);
        sidecarState.engaging.delete(registeredSid);
        sidecarState.sessionState.delete(registeredSid);
      }
      ownerRefresh();
    }
  });
  const cleanup = () => {
    if (registeredSid) {
      sidecarState.peers.delete(registeredSid);
      sidecarState.burndown.delete(registeredSid);
      sidecarState.engaging.delete(registeredSid);
      sidecarState.sessionState.delete(registeredSid);
    }
    ownerRefresh();
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

// ---- HTTP request handler (owner only) ----

function readJsonBody(req, max = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > max) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export async function handleHttp(req, res) {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(VIEWER_HTML);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/reload-viewer") {
    if (url.searchParams.get("token") !== sidecarState.token) { res.writeHead(401); res.end("unauthorized"); return; }
    VIEWER_HTML = loadViewerHtml();
    FAVICON_SVG = loadFavicon();
    res.writeHead(204); res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/favicon.svg") {
    if (!FAVICON_SVG) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
    res.end(FAVICON_SVG);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/snapshot") {
    if (url.searchParams.get("token") !== sidecarState.token) { res.writeHead(401); res.end("unauthorized"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildSnapshot()));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/engage") {
    let body;
    try { body = await readJsonBody(req); }
    catch { res.writeHead(400); res.end("bad body"); return; }
    if (body.token !== sidecarState.token) { res.writeHead(401); res.end("unauthorized"); return; }
    const sid = body.sessionId;
    if (!sid) { res.writeHead(400); res.end("missing sessionId"); return; }
    // Engage requires a live peer (or owner-self) to call session.send.
    const isLive = sid === sidecarState.activeSessionId || sidecarState.peers.get(sid)?.socket;
    if (!isLive) { res.writeHead(409); res.end("session offline"); return; }
    const item = resolveItemRef(body.id, sid);
    if (!item) { res.writeHead(404); res.end("item not found"); return; }
    const dispatched = engageItem(sid, item);
    if (!dispatched) { res.writeHead(503); res.end("session not reachable"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: item.id }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/burndown") {
    let body;
    try { body = await readJsonBody(req); }
    catch { res.writeHead(400); res.end("bad body"); return; }
    if (body.token !== sidecarState.token) { res.writeHead(401); res.end("unauthorized"); return; }
    const sid = body.sessionId;
    if (!sid) { res.writeHead(400); res.end("missing sessionId"); return; }
    setBurndown(sid, !!body.enabled);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, enabled: sidecarState.burndown.has(sid) }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/mutate") {
    deferViewerCloseUntilResponseFinishes(res);
    let body;
    try { body = await readJsonBody(req); }
    catch { res.writeHead(400); res.end("bad body"); return; }
    if (body.token !== sidecarState.token) { res.writeHead(401); res.end("unauthorized"); return; }
    const sid = body.sessionId;
    if (!sid) { res.writeHead(400); res.end("missing sessionId"); return; }
    let result = null;
    const queueId = body.queueId || null;
    switch (body.op) {
      case "add": result = addItem(sid, body.description || "", false, queueId); break;
      case "up":     result = moveUp(sid, body.id, queueId); break;
      case "down":   result = moveDown(sid, body.id, queueId); break;
      case "edit":   result = editItem(sid, body.id, body.description, queueId); break;
      case "delete": result = removeItem(sid, body.id, queueId); break;
      default: res.writeHead(400); res.end("bad op"); return;
    }
    if (!result) { res.writeHead(400); res.end("invalid request"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404); res.end("not found");
}

// Route an engage prompt to the right session: directly if the target is
// the owner's own session, otherwise via the peer WS to that client.
// Returns true if the prompt was dispatched, false if no live target exists.
function routeEngage(sessionId, { prompt }) {
  if (sidecarState.role !== "owner") return false;
  if (sessionId === sidecarState.activeSessionId) {
    setTimeout(() => {
      try { sidecarState.sessionRef?.send({ prompt }); }
      catch (e) { try { sidecarState.sessionRef?.log(`engage failed: ${e.message}`, { level: "error" }); } catch {} }
    }, 0);
    return true;
  }
  const peer = sidecarState.peers.get(sessionId);
  if (!peer?.socket) return false;
  try {
    wsSendText(peer.socket, JSON.stringify({ type: "engage", sessionId, prompt }));
    return true;
  } catch { return false; }
}

// Promote `item` to position 1 and dispatch the standard engage prompt.
// Shared by /api/engage and burndown auto-advance so prompt wording stays
// in lockstep. Marks the item as the session's currently-engaged item so
// the viewer can render the "engaging…" badge, and immediately marks the
// session "busy" so back-to-back burndown advances don't race the
// not-yet-published busy signal from the agent.
function engageItem(sessionId, item) {
  moveTop(sessionId, item.id);
  sidecarState.engaging.set(sessionId, item.id);
  const prompt = makeEngagePrompt(item);
  const dispatched = routeEngage(sessionId, { itemId: item.id, prompt });
  if (!dispatched) {
    sidecarState.engaging.delete(sessionId);
  } else {
    setSessionState(sessionId, "busy");
  }
  ownerRefresh(sessionId);
  return dispatched;
}

// Called after markDone — if burndown is on for this session and there's a
// next item, auto-engage it. Silent no-op when burndown is off, the
// backlog is empty, the session isn't reachable, or the agent isn't idle
// (next session.idle event retries via onSessionIdle handler).
export function maybeBurndownNext(sessionId) {
  if (sidecarState.role !== "owner") return;
  if (!sidecarState.burndown.has(sessionId)) return;
  if ((sidecarState.sessionState.get(sessionId) || "idle") !== "idle") return;
  const next = getTopItem(sessionId);
  if (!next) return;
  engageItem(sessionId, next);
}

// Toggle burndown for a session. Routes to owner from clients via "burndown"
// peer message. Kicks off the first engage immediately when turning on so
// the user doesn't have to manually start the chain — but only if the CLI
// is idle. If the agent is busy when burndown is enabled, the next
// session.idle event will pick up the chain.
export function setBurndown(sessionId, enabled) {
  if (sidecarState.role === "owner") {
    if (enabled) sidecarState.burndown.add(sessionId);
    else sidecarState.burndown.delete(sessionId);
    ownerRefresh(sessionId);
    if (enabled) maybeBurndownNext(sessionId);
  } else if (sidecarState.role === "client") {
    peerSend({ type: "burndown", sessionId, enabled: !!enabled });
  }
}

// Update a session's busy/idle state. Owner stores it directly and may
// fire burndown auto-advance on the idle edge. Clients forward to the
// owner as a peer message so the rail chip and burndown gate stay in sync.
export function setSessionState(sessionId, state) {
  if (sidecarState.role === "owner") {
    const prev = sidecarState.sessionState.get(sessionId) || "idle";
    if (prev === state) return;
    sidecarState.sessionState.set(sessionId, state);
    ownerRefresh(sessionId);
    if (state === "idle") maybeBurndownNext(sessionId);
  } else if (sidecarState.role === "client") {
    peerSend({ type: "state", sessionId, state });
  }
}

// ---- Owner lifecycle ----

function becomeOwner(server) {
  sidecarState.role = "owner";
  sidecarState.server = server;
  // Inherit token from the lock so a viewer/browser whose URL still has the
  // previous token can reconnect transparently. Only mint a fresh token
  // when the lock is genuinely missing (clean boot, no failover).
  sidecarState.token = readLock()?.token || randomBytes(16).toString("hex");
  sidecarState.ownerStartedAt = new Date().toISOString();
  server.on("request", (req, res) => {
    handleHttp(req, res).catch(() => {
      try { res.writeHead(500); res.end("server error"); } catch {}
    });
  });
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/peer") handlePeerWsUpgrade(req, socket);
    else if (url.pathname === "/ws") handleBrowserWsUpgrade(req, socket);
    else { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); }
  });
  writeLock();
  sidecarState.heartbeatTimer = setInterval(writeLock, HEARTBEAT_MS);
  registerActiveSession();
  syncOwnerVisibility();
}

// Register the active session into whichever role we've taken. Idempotent
// and convergent — repeated calls upsert the latest authoritative metadata
// (label, cwd). Safe from multiple paths (post-election,
// post-WS-upgrade, post-session-start).
export function registerActiveSession() {
  const sid = sidecarState.activeSessionId;
  if (!sid) return;
  const label = getSessionLabel(sid) || sid.slice(0, 8);
  if (sidecarState.role === "owner") {
    const existing = sidecarState.peers.get(sid);
    sidecarState.peers.set(sid, {
      socket: existing?.socket || null,
      label,
      cwd: process.cwd(),
      repo: existing?.repo || null,
      branch: existing?.branch || null,
    });
    if (!sidecarState.sessionState.has(sid)) {
      sidecarState.sessionState.set(sid, "idle");
    }
    ownerRefresh(sid);
  } else if (sidecarState.role === "client") {
    peerSend({
      type: "register",
      sessionId: sid,
      label,
      cwd: process.cwd(),
    });
    peerSend({ type: "refresh", sessionId: sid });
  }
}

function closeViewerWindow() {
  // Ask any open viewer pages to close themselves before we tear down WS.
  // Chrome --app= windows can call window.close(); the spawned proc is just
  // a launcher (already exited) so killing it does nothing to the actual
  // window owned by the long-lived browser process.
  sidecarState.programmaticClose = true;
  for (const ws of sidecarState.wsClients) {
    try { wsSendText(ws, JSON.stringify({ type: "close" })); } catch {}
  }
  setTimeout(() => {
    for (const ws of sidecarState.wsClients) { try { wsSendClose(ws); } catch {} }
    sidecarState.wsClients.clear();
    sidecarState.programmaticClose = false;
  }, 150);
}

function teardownOwner() {
  closeViewerWindow();
  if (sidecarState.heartbeatTimer) { clearInterval(sidecarState.heartbeatTimer); sidecarState.heartbeatTimer = null; }
  for (const peer of sidecarState.peers.values()) {
    if (peer.socket) { try { wsSendClose(peer.socket); } catch {} }
  }
  sidecarState.peers.clear();
  if (sidecarState.server) { try { sidecarState.server.close(); } catch {} sidecarState.server = null; }
}

// ---- Browser launch (chromeless --app= window, owner only) ----

function findAppBrowser() {
  if (platform() !== "win32") return null;
  const local = join(homedir(), "AppData", "Local");
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    join(local, "Microsoft\\Edge\\Application\\msedge.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(local, "Google\\Chrome\\Application\\chrome.exe"),
  ];
  for (const p of candidates) { if (existsSync(p)) return p; }
  return null;
}

function spawnViewerWindow() {
  if (sidecarState.role !== "owner") return false;
  sidecarState.lastSpawnAt = Date.now();
  const url = `http://127.0.0.1:${SHARED_PORT}/?token=${sidecarState.token}`;
  const browser = findAppBrowser();
  if (browser) {
    const userDataDir = join(homedir(), ".backlog", "viewer-profile");
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
    const args = [
      `--app=${url}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=720,720",
      "--window-position=1180,80",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    // Note: this proc is just a launcher — it exits within ~1s after the
    // browser process for the shared profile picks up the --app URL. We
    // intentionally do NOT track its exit; window aliveness is inferred
    // from active /ws client count instead.
    spawn(browser, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  if (platform() === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  return false;
}

// ---- Client lifecycle (peer WS to owner) ----

// Build the WebSocket handshake bytes by hand so we don't pull in `ws`.
function peerHandshake(token) {
  const wsKey = randomBytes(16).toString("base64");
  const lines = [
    `GET /peer?token=${encodeURIComponent(token)} HTTP/1.1`,
    `Host: 127.0.0.1:${SHARED_PORT}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${wsKey}`,
    "Sec-WebSocket-Version: 13",
    "", "",
  ].join("\r\n");
  return { lines, expectedAccept: wsAcceptKey(wsKey) };
}

// Write a masked text frame from client to server (RFC 6455 requires
// client→server frames to be masked).
function peerSendFrame(socket, text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  socket.write(Buffer.concat([header, mask, masked]));
}

function peerSend(msg) {
  const sock = sidecarState.peerSocket;
  if (!sock || sock.destroyed) return false;
  try { peerSendFrame(sock, JSON.stringify(msg)); return true; }
  catch { return false; }
}

function becomeClient() {
  sidecarState.role = "client";
  startClientHeartbeatPoll();
  connectPeer();
}

function connectPeer() {
  if (sidecarState.role !== "client") return;
  const lock = readLock();
  if (!lock?.token) {
    schedulePeerReconnect();
    return;
  }
  const sock = net_module.connect(SHARED_PORT, "127.0.0.1");
  let upgraded = false;
  let buf = Buffer.alloc(0);

  const onUpgrade = () => {
    upgraded = true;
    sidecarState.peerSocket = sock;
    registerActiveSession();
    attachWsTextReader(sock, (text) => {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === "engage" && msg.prompt) {
        setTimeout(() => {
          try { sidecarState.sessionRef?.send({ prompt: msg.prompt }); }
          catch (e) { try { sidecarState.sessionRef?.log(`engage failed: ${e.message}`, { level: "error" }); } catch {} }
        }, 0);
      }
    });
  };

  sock.once("connect", () => {
    const hs = peerHandshake(lock.token);
    sock.write(hs.lines);
    sock.once("data", function onHandshakeData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) { sock.once("data", onHandshakeData); return; }
      const headers = buf.subarray(0, headerEnd).toString("utf8");
      if (!/^HTTP\/1\.1 101/i.test(headers) || !headers.includes(hs.expectedAccept)) {
        sock.destroy();
        schedulePeerReconnect();
        return;
      }
      // Hand any extra bytes back to the frame reader.
      const leftover = buf.subarray(headerEnd + 4);
      onUpgrade();
      if (leftover.length) sock.unshift(leftover);
    });
  });

  const onClose = () => {
    if (sidecarState.peerSocket === sock) sidecarState.peerSocket = null;
    schedulePeerReconnect();
  };
  sock.on("close", onClose);
  sock.on("error", () => { try { sock.destroy(); } catch {} });
}

function schedulePeerReconnect(delayMs = 1000) {
  if (sidecarState.peerReconnectTimer) return;
  sidecarState.peerReconnectTimer = setTimeout(() => {
    sidecarState.peerReconnectTimer = null;
    if (sidecarState.role !== "client") return;
    // Before reconnecting, see if we should promote ourselves.
    const lock = readLock();
    if (lockIsStale(lock)) {
      // Drop client role so tryStartSidecar will attempt to bind the port.
      sidecarState.role = null;
      tryStartSidecar();
      return;
    }
    connectPeer();
  }, delayMs);
}

// Even with a healthy WS, the owner could die silently and leave a stale
// lock. Periodically inspect the lock; if stale, drop our peer socket and
// race to take over.
function startClientHeartbeatPoll() {
  if (sidecarState.failoverTimer) return;
  sidecarState.failoverTimer = setInterval(() => {
    if (sidecarState.role !== "client") return;
    const lock = readLock();
    if (!lockIsStale(lock)) return;
    // Owner appears dead — close peer socket and try to promote.
    if (sidecarState.peerSocket) { try { sidecarState.peerSocket.destroy(); } catch {} sidecarState.peerSocket = null; }
    sidecarState.role = null;
    tryStartSidecar();
  }, HEARTBEAT_MS + 1000);
}

// ---- Election + boot ----

// Try to bind the shared port. Win → owner. EADDRINUSE → client. Anything
// else → log and stay in null role for this session.
// Guarded against re-entry during the listen() async window so we don't
// spawn two competing election servers in the same process.
export function tryStartSidecar() {
  if (sidecarState.role) return;            // already settled
  if (sidecarState.electionInFlight) return; // election in progress
  sidecarState.electionInFlight = true;
  const server = createHttpServer();
  server.once("error", (err) => {
    sidecarState.electionInFlight = false;
    try { server.close(); } catch {}
    if (sidecarState.role) return; // we already settled (e.g. won via listen)
    if (err.code === "EADDRINUSE") {
      becomeClient();
    } else {
      try { sidecarState.sessionRef?.log(`Sidecar bind failed: ${err.message}`, { level: "error" }); } catch {}
    }
  });
  server.listen(SHARED_PORT, "127.0.0.1", () => {
    sidecarState.electionInFlight = false;
    if (sidecarState.role) {
      // Lost a race against ourselves (shouldn't happen with the guard, but defensive).
      try { server.close(); } catch {}
      return;
    }
    becomeOwner(server);
  });
}

// Compatibility shims used elsewhere — old per-process visibility logic.
// In the unified architecture, "show" pins this session and "hide" unpins.
export function syncSidecarVisibility(sessionId) {
  if (!sessionId) return;
  if (!sidecarState.role) tryStartSidecar();
  notifyChange(sessionId);
}

export function stopSidecar() {
  if (sidecarState.role === "owner") teardownOwner();
  else if (sidecarState.role === "client") {
    try { peerSend({ type: "unregister", sessionId: sidecarState.activeSessionId }); } catch {}
    if (sidecarState.peerSocket) { try { sidecarState.peerSocket.destroy(); } catch {} sidecarState.peerSocket = null; }
  }
  if (sidecarState.peerReconnectTimer) { clearTimeout(sidecarState.peerReconnectTimer); sidecarState.peerReconnectTimer = null; }
  if (sidecarState.failoverTimer) { clearInterval(sidecarState.failoverTimer); sidecarState.failoverTimer = null; }
  sidecarState.role = null;
}

// Force the viewer open from any session (including clients). Routes to
// owner-side state directly when we are the owner, otherwise sends a "show"
// message over the peer socket. There is no "hide" — the user closes the
// window via its X button, which suppresses auto-reopen until the next item
// or the next /backlog show.
export function showViewer(sessionId) {
  if (sidecarState.role === "owner") {
    sidecarState.forceOpen = true;
    sidecarState.viewerSuppressed = false;
    syncOwnerVisibility();
    ownerRefresh(sessionId);
  } else if (sidecarState.role === "client") {
    peerSend({ type: "show" });
  }
}

// Push a label update to the owner (whether we are owner or a client).
export function pushLabelToOwner(sid, label) {
  if (!sid || !label) return;
  if (sidecarState.role === "owner") {
    const peer = sidecarState.peers.get(sid);
    if (peer) { peer.label = label; ownerRefresh(); }
  } else if (sidecarState.role === "client") {
    peerSend({ type: "label", sessionId: sid, label });
  }
}
