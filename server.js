#!/usr/bin/env node
/**
 * MSRTC ST Bus Depot QR app - local server
 * ---------------------------------------------------------------
 * Zero dependencies. Needs Node.js 16+.
 *
 *   node server.js
 *
 * TWO FILES in the same folder: server.js + index.html (the app). Edit index.html, refresh the browser.
 * (Optional) set APP_FILE=... to serve a different HTML file.
 *
 * What it does
 *   GET  /              serves the app (gzip-compressed, cached)
 *   POST /sync/push     { store, records[] }  -> upsert records
 *   GET  /sync/pull     -> { users, qrCodes, depotRegister, notices }
 *   POST /otp/send      { username, mobile, email }
 *   POST /otp/verify    { username, code } -> { ok }
 *   GET  /health
 *
 * Settings (environment variables, all optional)
 *   PORT=8080            HOST=0.0.0.0
 *   APP_FILE=...         the app HTML file (default ./index.html)
 *   DATA_FILE=...        where data is saved (default ./data/db.json)
 *   CERT_FILE / KEY_FILE paths to a TLS cert + key (default ./certs/cert.pem, ./certs/key.pem)
 *
 * Who gets / sends the OTP
 *   TO   : the email address entered for the staff account (saved on the server)
 *   FROM : the email address entered for that staff member's Depot account
 *          (shown as the sender + Reply-To; if the depot has no email, SMTP_FROM is used)
 *
 * Depot Gmail accounts (so the mail REALLY comes from the depot's @gmail.com address):
 *   Open this file in Notepad and edit the DEPOT_GMAIL block near the top.
 *   Each line:  'depot@gmail.com': 'Gmail App Password',
 *   (Google Account -> Security -> 2-Step Verification ON -> App passwords)
 *   No separate .json file is needed.
 *
 * Email OTP (SMTP) - set these to send real emails:
 *   SMTP_HOST=smtp.gmail.com      SMTP_PORT=465 (default; 587 also works via STARTTLS)
 *   SMTP_USER=you@gmail.com       SMTP_PASS=app-password
 *   SMTP_FROM="MSRTC Depot <you@gmail.com>"   (default: SMTP_USER)
 *   SMTP_SECURE=true|false   only needed on unusual ports (465 = true, others = STARTTLS)
 * If SMTP_HOST is not set, the OTP is only printed in this console (test mode).
 * The SMTP account still does the actual sending. Mail providers (e.g. Gmail) may replace
 * the From address with the SMTP account unless the depot address is an allowed alias, or the
 * SMTP server belongs to the depot's own mail domain.
 * The recipient is always read from the account saved on the server, never from the request.
 */
'use strict';

/* ================================================================== */
/*  ALWAYS-ON SUPERVISOR (added)                                       */
/*  `node server.js` now keeps itself running: if the server crashes   */
/*  or stops, it restarts automatically. Press Ctrl+C to really stop.  */
/*  Set NO_SUPERVISOR=1 to turn this off.                              */
/* ================================================================== */
if (!process.env.MSRTC_CHILD && process.env.NO_SUPERVISOR !== '1') {
  const { spawn } = require('child_process');
  let stopping = false, quick = 0, child = null, first = true;
  const stop = () => { stopping = true; if (child) child.kill(); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const launch = () => {
    const t = Date.now();
    child = spawn(process.execPath, [__filename].concat(process.argv.slice(2)), {
      stdio: 'inherit',
      env: Object.assign({}, process.env, { MSRTC_CHILD: '1', MSRTC_FIRST: first ? '1' : '' })
    });
    first = false;
    child.on('exit', code => {
      if (stopping) return process.exit(0);
      quick = Date.now() - t < 5000 ? quick + 1 : 0;
      const wait = Math.min(1000 * (quick + 1), 10000);
      console.error('[supervisor] server stopped (code ' + code + '). Restarting in ' + wait / 1000 + 's ...');
      setTimeout(launch, wait);
    });
  };
  launch();
  return; // the supervisor does nothing else; the child process runs the real server below
}

// Never let one bad request kill the server
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.stack || e));

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');

/* ================================================================== */
/*  EDIT HERE - DEPOT GMAIL ACCOUNTS (OTP is sent FROM these)          */
/*  Format:  'depot gmail address': 'Gmail App Password',              */
/*  Add one line per depot. Keep the quotes and the comma.            */
/*  Get an App Password: Google Account > Security > 2-Step            */
/*  Verification (ON) > App passwords.                                 */
/* ================================================================== */
const DEPOT_GMAIL = {
  'guhagar.depot@gmail.com': 'abcd efgh ijkl mnop',
  // 'chiplun.depot@gmail.com': 'xxxx xxxx xxxx xxxx',
};
/* ================================================================== */

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const APP_FILE = process.env.APP_FILE || path.join(__dirname, 'index.html'); // the app (HTML) lives in its own file next to server.js
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const CERT_FILE = process.env.CERT_FILE || path.join(__dirname, 'certs', 'cert.pem');
const KEY_FILE = process.env.KEY_FILE || path.join(__dirname, 'certs', 'key.pem');
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT, 10) || 465,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || ''
};
SMTP.secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : SMTP.port === 465;
const MAIL_ENABLED = !!(SMTP.host && SMTP.from);
// Per-depot Gmail logins: { "guhagar.depot@gmail.com": "abcd efgh ijkl mnop", ... }  (Gmail App Passwords)
const DEPOT_SMTP_FILE = process.env.DEPOT_SMTP_FILE || path.join(__dirname, 'smtp-depots.json');
function loadDepotSmtp() {
  const out = {};
  const add = (k, v) => { // skip the example placeholder
    if (!k || !v || /abcd efgh ijkl mnop/i.test(typeof v === 'string' ? v : String(v.pass || ''))) return;
    out[String(k).trim().toLowerCase()] = v;
  };
  for (const k of Object.keys(DEPOT_GMAIL)) add(k, DEPOT_GMAIL[k]);
  try { // optional extra file (not needed)
    const raw = JSON.parse(fs.readFileSync(DEPOT_SMTP_FILE, 'utf8'));
    for (const k of Object.keys(raw)) add(k, raw[k]);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read ' + DEPOT_SMTP_FILE + ': ' + e.message);
  }
  return out;
}
const EMAIL_RE = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/;

const MAX_BODY = 25 * 1024 * 1024; // 25 MB per request
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_TRIES = 5;

/* ------------------------------------------------------------------ */
/* Storage: in-memory Maps, saved to one JSON file (atomic writes)     */
/* ------------------------------------------------------------------ */
const STORES = ['users', 'qrCodes', 'depotRegister', 'notices', 'auditLogs'];
const keyField = store => (store === 'users' ? 'username' : 'uid');
const PULL_STORES = ['users', 'qrCodes', 'depotRegister', 'notices']; // what the app pulls

const db = {};
for (const s of STORES) db[s] = new Map();

function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const s of STORES) {
      for (const rec of Array.isArray(raw[s]) ? raw[s] : []) {
        const k = rec && rec[keyField(s)];
        if (typeof k === 'string' && k) db[s].set(k, rec);
      }
    }
    console.log('Loaded data from ' + DATA_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read ' + DATA_FILE + ': ' + e.message);
  }
}

let saveTimer = null;
function saveDb() {
  const out = {};
  for (const s of STORES) out[s] = [...db[s].values()];
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, DATA_FILE);
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { saveDb(); } catch (e) { console.error('Save failed: ' + e.message); }
  }, 300);
}
function flushAndExit() {
  try { saveDb(); } catch (e) { console.error('Save failed: ' + e.message); }
  process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function send(res, status, body, headers) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  const data = isStr ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign(
    { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data) },
    headers || {}
  ));
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------------------------------------------ */
/* App file (gzip once, re-compress if the file changes)               */
/* ------------------------------------------------------------------ */
let appCache = null; // { mtimeMs, size, raw, gz, etag }
function getApp() {
  if (APP_FILE) { // optional external override (re-read when the file changes)
    const st = fs.statSync(APP_FILE);
    if (!appCache || appCache.mtimeMs !== st.mtimeMs || appCache.size !== st.size) {
      const raw = fs.readFileSync(APP_FILE);
      appCache = {
        mtimeMs: st.mtimeMs, size: st.size, raw,
        gz: zlib.gzipSync(raw, { level: 9 }),
        etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"'
      };
    }
    return appCache;
  }
  return appCache;
}

function serveApp(req, res) {
  let app;
  try { app = getApp(); }
  catch (e) { return send(res, 404, 'App file not found: ' + APP_FILE + ' - put index.html in the same folder as server.js'); }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: app.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === app.etag) { res.writeHead(304, headers); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? app.gz : app.raw;
  if (gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */
async function handlePush(req, res) {
  const body = await readJson(req);
  const store = body && body.store;
  if (!STORES.includes(store) || !Array.isArray(body.records)) return send(res, 400, { ok: false, error: 'Bad store or records' });
  const kf = keyField(store);
  let saved = 0;
  for (const rec of body.records) {
    if (!isObj(rec)) continue;
    const k = rec[kf];
    if (typeof k !== 'string' || !k || k.length > 200) continue;
    const clean = Object.assign({}, rec);
    delete clean.id;      // local auto-increment id of the sender's IndexedDB
    delete clean.synced;  // each device tracks this itself
    db[store].set(k, clean);
    saved++;
  }
  if (saved) scheduleSave();
  send(res, 200, { ok: true, saved });
}

function handlePull(req, res) {
  const out = {};
  for (const s of PULL_STORES) out[s] = [...db[s].values()];
  send(res, 200, out);
}

/* ------------------------------------------------------------------ */
/* OTP                                                                 */
/* ------------------------------------------------------------------ */
const otps = new Map(); // username -> { hash, exp, tries, sentAt }
const hashCode = code => crypto.createHash('sha256').update(String(code)).digest();

/* ---- Minimal SMTP client (implicit TLS on 465, STARTTLS on 587) ---- */
async function smtpSend(o) {
  const net = require('net'), tls = require('tls');
  let sock = o.secure ? tls.connect({ host: o.host, port: o.port, servername: o.host })
                      : net.connect({ host: o.host, port: o.port });
  let buf = '', pending = null, err = null, encrypted = !!o.secure;

  const flush = () => {
    if (!pending) return;
    const m = buf.match(/^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/);
    if (!m) return;
    buf = buf.slice(m[0].length);
    const p = pending; pending = null;
    p.res(m[0].trim().split('\r\n'));
  };
  const wire = s => {
    s.on('data', d => { buf += d.toString('utf8'); flush(); });
    s.on('error', e => { err = e; if (pending) { pending.rej(e); pending = null; } });
    s.on('close', () => { if (!err) err = new Error('SMTP connection closed'); if (pending) { pending.rej(err); pending = null; } });
  };
  const read = () => new Promise((res, rej) => { if (err) return rej(err); pending = { res, rej }; flush(); });
  const expect = async codes => {
    const r = await read();
    if (!codes.includes(r[r.length - 1].slice(0, 3))) throw new Error('SMTP: ' + r.join(' | '));
    return r;
  };
  const cmd = (line, codes) => { sock.write(line + '\r\n'); return expect(codes); };
  const b64 = v => Buffer.from(v, 'utf8').toString('base64');
  wire(sock);

  const run = async () => {
    await expect(['220']);
    const me = 'msrtc-server';
    let caps = (await cmd('EHLO ' + me, ['250'])).join('\n').toUpperCase();
    if (!encrypted) {
      if (caps.includes('STARTTLS')) {
        await cmd('STARTTLS', ['220']);
        sock.removeAllListeners('data'); buf = '';
        sock = tls.connect({ socket: sock, servername: o.host });
        wire(sock); encrypted = true;
        caps = (await cmd('EHLO ' + me, ['250'])).join('\n').toUpperCase();
      } else if (o.user) {
        throw new Error('Server does not offer encryption; refusing to send the password');
      }
    }
    if (o.user) {
      if (/AUTH[^\n]*\bPLAIN\b/.test(caps)) {
        await cmd('AUTH PLAIN ' + b64('\0' + o.user + '\0' + o.pass), ['235']);
      } else {
        await cmd('AUTH LOGIN', ['334']);
        await cmd(b64(o.user), ['334']);
        await cmd(b64(o.pass), ['235']);
      }
    }
    const envFrom = (o.from.match(/<([^>]+)>/) || [null, o.from])[1].trim();
    await cmd('MAIL FROM:<' + envFrom + '>', ['250']);
    await cmd('RCPT TO:<' + o.to + '>', ['250', '251']);
    await cmd('DATA', ['354']);
    const body = Buffer.from(o.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const msg = [
      'From: ' + (o.headerFrom || o.from),
      ...(o.headerFrom ? ['Reply-To: ' + o.headerFrom, 'Sender: ' + o.from] : []),
      'To: <' + o.to + '>',
      'Subject: =?UTF-8?B?' + b64(o.subject) + '?=',
      'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + crypto.randomUUID() + '@msrtc-server>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '', body, ''
    ].join('\r\n');
    sock.write(msg + '\r\n.\r\n');
    await expect(['250']);
    try { sock.write('QUIT\r\n'); } catch (e) { /* ignore */ }
  };

  let timer;
  try {
    await Promise.race([
      run(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SMTP timeout')), 20000); })
    ]);
  } finally {
    clearTimeout(timer);
    try { sock.end(); sock.destroy(); } catch (e) { /* ignore */ }
  }
}

const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Email of the Depot account that belongs to this depot name (the sender)
function findDepotSender(depotName) {
  const want = normName(depotName);
  if (!want) return null;
  for (const u of db.users.values()) {
    if (u && u.role === 'Depot' && normName(u.depotName) === want) {
      const email = typeof u.email === 'string' ? u.email.trim() : '';
      if (EMAIL_RE.test(email)) return { email, name: String(u.depotName || u.name || '').replace(/[\r\n<>"]/g, ' ').trim() };
    }
  }
  return null;
}

const maskEmail = e => e.replace(/^(.).*?(@.*)$/, '$1***$2');

async function deliverOtp(username, email, code, depot) {
  const headerFrom = depot
    ? (/^[\x20-\x7e]*$/.test(depot.name) && depot.name ? '"' + depot.name + '" <' + depot.email + '>'
       : '=?UTF-8?B?' + Buffer.from(depot.name || 'MSRTC Depot', 'utf8').toString('base64') + '?= <' + depot.email + '>')
    : '';
  const entry = depot ? loadDepotSmtp()[depot.email.toLowerCase()] : null;
  if (entry) { // send through the depot's own mailbox: true From = depot address
    const cfg = typeof entry === 'string' ? { pass: entry } : entry;
    const port = parseInt(cfg.port, 10) || 465;
    await smtpSend({
      host: cfg.host || 'smtp.gmail.com', port, secure: port === 465,
      user: depot.email, pass: String(cfg.pass || '').replace(/\s+/g, ''),
      from: headerFrom, to: email,
      subject: 'MSRTC पडताळणी कोड / Verification code',
      text: 'तुमचा MSRTC पडताळणी कोड: ' + code + '\nहा कोड ५ मिनिटांसाठी वैध आहे. तो कोणालाही सांगू नका.\n\n' +
            'Your MSRTC verification code is ' + code + '.\nIt is valid for 5 minutes. Do not share it with anyone.\n'
    });
    return;
  }
  if (depot && /@(gmail|googlemail)\.com$/i.test(depot.email)) {
    console.warn('[OTP] No App Password for ' + depot.email + ' in DEPOT_GMAIL (top of server.js) - Gmail will show the SMTP account as sender instead.');
  }
  if (!MAIL_ENABLED) {
    console.log('[OTP - test mode, no SMTP set] from ' + (depot ? depot.email : '(SMTP_FROM)') + ' to ' + username + ' <' + email + '>: ' + code);
    return;
  }
  await smtpSend({
    host: SMTP.host, port: SMTP.port, secure: SMTP.secure, user: SMTP.user, pass: SMTP.pass,
    from: SMTP.from, headerFrom, to: email,
    subject: 'MSRTC पडताळणी कोड / Verification code',
    text: 'तुमचा MSRTC पडताळणी कोड: ' + code + '\nहा कोड ५ मिनिटांसाठी वैध आहे. तो कोणालाही सांगू नका.\n\n' +
          'Your MSRTC verification code is ' + code + '.\nIt is valid for 5 minutes. Do not share it with anyone.\n'
  });
}

async function handleOtpSend(req, res) {
  const b = await readJson(req);
  if (typeof b.username !== 'string' || !b.username) return send(res, 400, { ok: false });
  // TO: the email entered for this staff account (saved on the server) - never one supplied in the request
  const user = db.users.get(b.username);
  const email = user && typeof user.email === 'string' ? user.email.trim() : '';
  if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: 'No valid email on record for this account (sync the account to the server first)' });
  // FROM: the email entered for this staff member's depot account
  const depot = findDepotSender(user.depotName);
  const prev = otps.get(b.username);
  if (prev && Date.now() - prev.sentAt < OTP_COOLDOWN_MS) return send(res, 429, { ok: false, error: 'Wait before requesting another OTP' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  otps.set(b.username, { hash: hashCode(code), exp: Date.now() + OTP_TTL_MS, tries: 0, sentAt: Date.now() });
  try {
    await deliverOtp(b.username, email, code, depot);
  } catch (e) {
    otps.delete(b.username);
    console.error('OTP email failed for ' + b.username + ': ' + e.message);
    return send(res, 502, { ok: false, error: 'Could not send email' });
  }
  send(res, 200, { ok: true, sentTo: maskEmail(email), from: depot ? depot.email : null });
}

async function handleOtpVerify(req, res) {
  const b = await readJson(req);
  const rec = typeof b.username === 'string' ? otps.get(b.username) : null;
  if (!rec || Date.now() > rec.exp) { if (rec) otps.delete(b.username); return send(res, 200, { ok: false }); }
  rec.tries++;
  const ok = crypto.timingSafeEqual(hashCode(String(b.code || '').trim()), rec.hash);
  if (ok || rec.tries >= OTP_MAX_TRIES) otps.delete(b.username);
  send(res, 200, { ok });
}
setInterval(() => { const n = Date.now(); for (const [k, v] of otps) if (n > v.exp) otps.delete(k); }, 60000).unref();

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
async function handler(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (req.headers['access-control-request-private-network']) cors['Access-Control-Allow-Private-Network'] = 'true';
  for (const k in cors) res.setHeader(k, cors[k]);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const p = new URL(req.url, 'http://x').pathname;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html' || (APP_FILE && p === '/' + path.basename(APP_FILE)))) return serveApp(req, res);
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/sync/pull') return handlePull(req, res);
    if (req.method === 'POST' && p === '/sync/push') return await handlePush(req, res);
    if (req.method === 'POST' && p === '/otp/send') return await handleOtpSend(req, res);
    if (req.method === 'POST' && p === '/otp/verify') return await handleOtpVerify(req, res);
    send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { ok: false, error: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
loadDb();

let server, scheme = 'http';
if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
  server = https.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, handler);
  scheme = 'https';
} else {
  server = http.createServer(handler);
}

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use - close the other copy of this server (or set PORT=8081).' : 'Server error: ' + e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('\nMSRTC server running (' + scheme.toUpperCase() + ')');
  console.log('  This computer :  ' + scheme + '://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  Other devices :  ' + scheme + '://' + i.address + ':' + PORT);
  }
  const dn = Object.keys(loadDepotSmtp()).length;
  console.log('\nDepot Gmail logins: ' + (dn ? dn + ' loaded' : 'none (edit DEPOT_GMAIL at the top of server.js)'));
  console.log('Email OTP: ' + (MAIL_ENABLED ? 'SMTP ' + SMTP.host + ':' + SMTP.port : 'TEST MODE - codes are only printed here (set SMTP_HOST to send real emails)'));
  console.log('\nIn the app: "Sync server settings" -> enter the URL above.');
  if (scheme === 'http') {
    console.log('Note: phones/PCs opening the app over plain http://<ip> cannot use the camera.');
    console.log('      Use HTTPS (put cert.pem + key.pem in ./certs) or open it via localhost.');
  }
  console.log('');
  if (process.env.MSRTC_FIRST === '1' && process.env.NO_BROWSER !== '1') { // open the app once, on first start
    try {
      const url = scheme + '://localhost:' + PORT;
      const cp = require('child_process');
      const c = process.platform === 'win32' ? cp.spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
              : cp.spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
      c.on('error', () => {}); c.unref();
    } catch (e) { /* ignore */ }
  }
});
