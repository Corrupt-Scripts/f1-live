// Corrupt Scripts F1 live helper
// Connects to F1's free live timing feed (the one behind the official live timing app),
// keeps the merged live state in memory and serves it, plus the dashboard, on http://localhost:5050
//
// Run:  npm install   (once)   then   node f1-live.js
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const WebSocket = require("ws");

const PORT = +process.env.PORT || 5050;
const HOST = process.env.HOST || "127.0.0.1";   // set HOST=0.0.0.0 to open it to other devices on your network
const F1 = process.env.F1_BASE || "https://livetiming.formula1.com/signalrcore";
const UA = "BestHTTP";
const RS = "\x1e";
const TOPICS = ["Heartbeat", "AudioStreams", "DriverList", "ExtrapolatedClock", "RaceControlMessages", "SessionInfo",
  "SessionStatus", "TeamRadio", "TimingAppData", "TimingStats", "TrackStatus", "WeatherData", "Position.z", "CarData.z",
  "ContentStreams", "SessionData", "TimingData", "TopThree", "RcmSeries", "LapCount"];
// Asked for separately: some of these are behind F1 TV now and may simply return nothing.
const EXTRA = ["ChampionshipPrediction", "PitLaneTimeCollection", "PitStopSeries", "DriverRaceInfo", "OvertakeSeries"];
const PAGE = [path.join(__dirname, "..", "index.html"), path.join(__dirname, "index.html")].find(p => fs.existsSync(p));

// ---------------- state ----------------
let state = {};                 // merged topics
let cars = {}, carHist = {};    // latest telemetry per car, recent speed samples
let pos = {}, outline = [], outlineCar = null, outlineDone = false;
let overtakes = [];
let standings = null, standingsAt = 0;
let connected = false, lastMsg = 0, lastErr = "", ws = null, pingTimer = null, retry = 2000;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function inflate(b64) {
  return JSON.parse(zlib.inflateRawSync(Buffer.from(b64, "base64")).toString("utf8"));
}

// F1 sends partial updates. Arrays arrive whole at first and later as {"index": {...}} patches.
function merge(t, p) {
  if (p === null || typeof p !== "object") return p;
  if (Array.isArray(p)) return p.slice();
  if (t === null || typeof t !== "object") t = {};
  for (const k of Object.keys(p)) {
    if (k === "_deleted") { for (const d of [].concat(p[k])) delete t[d]; continue; }
    t[k] = merge(t[k], p[k]);
  }
  return t;
}

function isRace() { const s = state.SessionInfo; return s && s.Type === "Race"; }
function lineOf(n) { return ((state.TimingData || {}).Lines || {})[n] || {}; }
function order() {
  const m = {};
  for (const [n, l] of Object.entries((state.TimingData || {}).Lines || {})) if (l.Position) m[n] = +l.Position;
  return m;
}

function detectOvertakes(before, patch, ts) {
  if (!isRace()) return;
  const lines = (patch && patch.Lines) || {};
  const after = order();
  for (const a of Object.keys(lines)) {
    if (lines[a].Position == null || before[a] == null || after[a] >= before[a]) continue;   // a gained places
    const la = lineOf(a);
    if (la.PitOut || la.InPit) continue;
    for (const b of Object.keys(after)) {
      if (b === a || before[b] == null) continue;
      if (before[b] < before[a] && after[b] > after[a]) {
        const lb = lineOf(b);
        const why = lb.InPit || lb.PitOut ? "pit" : lb.Retired || lb.Stopped ? "out" : "";
        overtakes.push({ t: ts || new Date().toISOString(), by: a, on: b, pos: after[a], lap: (state.LapCount || {}).CurrentLap || null, why });
      }
    }
  }
  if (overtakes.length > 300) overtakes = overtakes.slice(-300);
}

function addOutline() {
  if (outlineDone) return;
  if (!outlineCar) {
    const lead = Object.entries(order()).sort((a, b) => a[1] - b[1])[0];
    outlineCar = lead ? lead[0] : Object.keys(pos)[0];
  }
  const p = pos[outlineCar];
  if (!p || p.st !== "OnTrack" || (!p.x && !p.y)) return;
  const last = outline[outline.length - 1];
  if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 40) return;
  outline.push([p.x, p.y]);
  // closed once the car is back near where it started after a decent number of points
  if (outline.length > 150 && Math.hypot(p.x - outline[0][0], p.y - outline[0][1]) < 300) outlineDone = true;
  if (outline.length > 2500) outlineDone = true;
}

function apply(topic, data, ts) {
  try {
    if (topic.endsWith(".z")) { if (typeof data === "string") data = inflate(data); topic = topic.slice(0, -2); }
    if (data == null) return;
    if (topic === "CarData") {
      for (const e of data.Entries || []) for (const [n, c] of Object.entries(e.Cars || {})) {
        const ch = c.Channels || {};
        const s = { t: e.Utc, rpm: ch["0"], speed: ch["2"], gear: ch["3"], thr: ch["4"], brk: ch["5"], drs: ch["45"] };
        cars[n] = s;
        (carHist[n] = carHist[n] || []).push(s.speed);
        if (carHist[n].length > 110) carHist[n].shift();
      }
      return;
    }
    if (topic === "Position") {
      for (const p of data.Position || []) for (const [n, e] of Object.entries(p.Entries || {})) pos[n] = { x: e.X, y: e.Y, st: e.Status };
      addOutline();
      return;
    }
    if (topic === "SessionInfo") {
      const old = state.SessionInfo && state.SessionInfo.Key;
      if (old && data.Key && data.Key !== old) resetSession();
    }
    const before = topic === "TimingData" ? order() : null;
    state[topic] = merge(state[topic], data);
    if (before) detectOvertakes(before, data, ts);
  } catch (e) { log("Could not apply", topic, e.message); }
}

function resetSession() {
  log("New session, clearing old data");
  state = {}; cars = {}; carHist = {}; pos = {}; outline = []; outlineCar = null; outlineDone = false; overtakes = [];
}

// ---------------- F1 connection (SignalR Core, JSON protocol) ----------------
function cookiesFrom(res, jar) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
  for (const c of list) { const kv = c.split(";")[0]; const i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
}

async function connect() {
  clearInterval(pingTimer);
  const jar = {};
  try {
    log("Connecting to F1 live timing…");
    try { cookiesFrom(await fetch(F1 + "/negotiate?negotiateVersion=1", { method: "OPTIONS", headers: { "User-Agent": UA } }), jar); } catch {}
    const cookie = () => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
    const neg = await fetch(F1 + "/negotiate?negotiateVersion=1", { method: "POST", headers: { "User-Agent": UA, Cookie: cookie(), "Content-Type": "text/plain;charset=UTF-8" } });
    if (!neg.ok) throw new Error("negotiate returned HTTP " + neg.status);
    cookiesFrom(neg, jar);
    const nj = await neg.json();
    const id = nj.connectionToken || nj.connectionId;
    const url = F1.replace(/^http/, "ws") + (id ? "?id=" + encodeURIComponent(id) : "");
    ws = new WebSocket(url, { headers: { "User-Agent": UA, Cookie: cookie() } });
  } catch (e) { return fail(e); }

  let handshake = false;
  ws.on("open", () => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS));
  ws.on("message", buf => {
    for (const part of buf.toString("utf8").split(RS)) {
      if (!part) continue;
      let m; try { m = JSON.parse(part); } catch { continue; }
      if (!handshake) {
        handshake = true;
        if (m.error) return fail(new Error("handshake: " + m.error));
        connected = true; retry = 2000; lastErr = "";
        log("Connected. Subscribing to " + TOPICS.length + " feeds");
        ws.send(JSON.stringify({ type: 1, invocationId: "1", target: "Subscribe", arguments: [TOPICS] }) + RS);
        ws.send(JSON.stringify({ type: 1, invocationId: "2", target: "Subscribe", arguments: [EXTRA] }) + RS);
        pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ type: 6 }) + RS); } catch {} }, 15000);
        continue;
      }
      lastMsg = Date.now();
      if (m.type === 1 && m.target === "feed") apply(m.arguments[0], m.arguments[1], m.arguments[2]);
      else if (m.type === 3) {
        if (m.error) log("Subscribe " + m.invocationId + " error: " + m.error);
        if (m.result && typeof m.result === "object" && Object.keys(m.result).length) {
          for (const [k, v] of Object.entries(m.result)) apply(k, v);
          const s = state.SessionInfo;
          log("Got initial data" + (s ? ": " + (s.Meeting && s.Meeting.Name) + " – " + s.Name : ""));
        }
      } else if (m.type === 7) { log("F1 closed the connection" + (m.error ? ": " + m.error : "")); ws.close(); }
    }
  });
  ws.on("close", () => { if (connected) log("Disconnected"); connected = false; schedule(); });
  ws.on("error", e => fail(e));
}

function fail(e) {
  lastErr = e.message || String(e);
  log("Connection problem: " + lastErr);
  connected = false;
  try { ws && ws.terminate(); } catch {}
  ws = null;
  schedule();
}
let reconnectTimer = null;
function schedule() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, retry);
  retry = Math.min(retry * 2, 30000);
}

// ---------------- standings (Jolpica, free) ----------------
async function loadStandings() {
  if (Date.now() - standingsAt < 10 * 60000) return;
  standingsAt = Date.now();
  try {
    const r = await fetch(process.env.STANDINGS_URL || "https://api.jolpi.ca/ergast/f1/current/driverStandings.json");
    const j = await r.json();
    const list = j.MRData.StandingsTable.StandingsLists[0];
    standings = { round: list && +list.round, drivers: (list ? list.DriverStandings : []).map(d => ({ code: d.Driver.code, num: d.Driver.permanentNumber, points: +d.points, pos: +d.position })) };
  } catch (e) { log("Standings unavailable: " + e.message); }
}

// ---------------- HTTP server ----------------
function snapshot() {
  const rc = ((state.RaceControlMessages || {}).Messages) || [];
  const radio = ((state.TeamRadio || {}).Captures) || [];
  return {
    connected, lastMsg, error: lastErr, now: Date.now(),
    session: state.SessionInfo || null, status: state.SessionStatus || null, track: state.TrackStatus || null,
    lap: state.LapCount || null, clock: state.ExtrapolatedClock || null, weather: state.WeatherData || null,
    drivers: state.DriverList || {}, timing: state.TimingData || {}, app: state.TimingAppData || {}, stats: state.TimingStats || {},
    champ: state.ChampionshipPrediction || null, pitlane: state.PitLaneTimeCollection || null,
    rc: (Array.isArray(rc) ? rc : Object.values(rc)).slice(-60), radio: (Array.isArray(radio) ? radio : Object.values(radio)).slice(-40),
    cars, carHist, pos, outline, overtakes: overtakes.slice(-60), standings
  };
}

const server = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true", "Access-Control-Allow-Headers": "*" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const u = req.url.split("?")[0];
  if (u === "/api/state") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(snapshot()));
  }
  if (u === "/" || u === "/index.html") {
    if (!PAGE) { res.writeHead(404); return res.end("index.html not found next to the helper"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return fs.createReadStream(PAGE).pipe(res);
  }
  res.writeHead(404, cors); res.end("Not found");
});

server.listen(PORT, HOST, () => {
  log(`Dashboard: http://localhost:${PORT}`);
  connect();
  loadStandings(); setInterval(loadStandings, 60000);
});
server.on("error", e => { log("Could not start the web server: " + e.message + (e.code === "EADDRINUSE" ? " (port " + PORT + " is in use; set PORT=5051)" : "")); process.exit(1); });
