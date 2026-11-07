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
 *   POST /sync/delete   { store, keys[] }     -> remove records
 *   GET  /sync/pull     -> { users, qrCodes, depotRegister, notices }
 *   POST /otp/send      { username, mobile, email }
 *   POST /otp/verify    { username, code } -> { ok }
 *   GET  /health
 *
 * Settings (environment variables, all optional)
 *   PORT=8080            HOST=0.0.0.0     (plain http - fine on this computer via localhost)
 *   HTTPS_PORT=8443      HTTPS=0 turns HTTPS off. HTTPS is ON by default (needed for the phone camera / face scan)
 *   APP_FILE=...         the app HTML file (default ./index.html)
 *   DATA_FILE=...        where ALL data is saved (default ./db.json, next to server.js)
 *   CERT_FILE / KEY_FILE your own TLS cert + key (default ./certs/cert.pem, ./certs/key.pem).
 *                        If none exist, a self-signed certificate is created automatically in ./certs
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
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'db.json'); // ALL app data (users, QR codes, register, notices, audit logs) is saved here
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups'); // rotating copies of the database
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 20;
const BACKUP_EVERY_MS = (parseInt(process.env.BACKUP_EVERY_MIN, 10) || 10) * 60 * 1000;
const SYNC_KEY = process.env.SYNC_KEY || ''; // optional: when set, /sync/*, /backup/* need the header x-sync-key
const STARTED_AT = Date.now();
/* Google Cloud Text-to-Speech (optional): natural Google voices for the bus announcement, fetched in advance so there is no gap between languages.
   Set GOOGLE_TTS_KEY on the server (Render -> Environment). Without it the app falls back to the phone's own voices. */
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || '';
const GOOGLE_TTS_URL = process.env.GOOGLE_TTS_URL || 'https://texttospeech.googleapis.com/v1/text:synthesize';
const TTS_VOICES = { mr: process.env.TTS_VOICE_MR || 'mr-IN-Wavenet-A', hi: process.env.TTS_VOICE_HI || 'hi-IN-Neural2-A', en: process.env.TTS_VOICE_EN || 'en-IN-Neural2-A' };
const TTS_LANG = { mr: 'mr-IN', hi: 'hi-IN', en: 'en-IN' };
const ttsCache = new Map(); // text+voice+speed -> base64 mp3 (saves quota; replays are instant)
function googlePost(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(GOOGLE_TTS_URL + (GOOGLE_TTS_URL.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(GOOGLE_TTS_KEY));
    const data = JSON.stringify(body);
    const lib = u.protocol === 'http:' ? require('http') : https;
    const rq = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 8000 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(b || '{}') }); } catch (e) { reject(e); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('Google TTS timeout'))); rq.on('error', reject); rq.end(data);
  });
}
const serverErrors = []; // recent server errors, shown by /health
function trackError(where, e) { serverErrors.push({ t: new Date().toISOString(), where, msg: String((e && e.message) || e).slice(0, 200) }); if (serverErrors.length > 20) serverErrors.shift(); }
let errorTotal = 0, lastSaveAt = 0, lastSaveError = '', lastBackupAt = 0, conflictTotal = 0;
const CERT_FILE = process.env.CERT_FILE || path.join(__dirname, 'certs', 'cert.pem');
const KEY_FILE = process.env.KEY_FILE || path.join(__dirname, 'certs', 'key.pem');
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 8443;
const ON_RENDER = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL); // running on Render.com
// On Render the public https address already has a real certificate (Render handles it), so the built-in self-signed HTTPS is not used there.
const HTTPS_ON = process.env.HTTPS === '1' || (process.env.HTTPS !== '0' && !ON_RENDER);
const CERT_META = path.join(path.dirname(CERT_FILE), 'cert-meta.json');
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

function listBackups() {
  try { return fs.readdirSync(BACKUP_DIR).filter(f => /^db-.*\.json$/.test(f)).sort(); } catch (e) { return []; }
}
function readDbFile() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') { trackError('load', e); console.error('Could not read ' + DATA_FILE + ': ' + e.message); }
    const b = listBackups().pop();
    if (!b) throw e;
    const raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, b), 'utf8'));
    console.log('RECOVERED the database from backup ' + b);
    trackError('recovery', 'Database restored from backup ' + b);
    return raw;
  }
}
function loadDb() {
  try {
    const raw = readDbFile();
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
  lastSaveAt = Date.now(); lastSaveError = '';
  if (Date.now() - lastBackupAt >= BACKUP_EVERY_MS) makeBackup();
}
function makeBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = 'db-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + '.json';
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, name));
    lastBackupAt = Date.now();
    for (const old of listBackups().slice(0, -BACKUP_KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old));
  } catch (e) { trackError('backup', e); }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { saveDb(); } catch (e) { lastSaveError = e.message; trackError('save', e); console.error('Save failed: ' + e.message); }
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

const PWA_FILES = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'application/javascript; charset=utf-8', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-maskable-512.png': 'image/png' };
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
function keyOk(req) { return !SYNC_KEY || req.headers['x-sync-key'] === SYNC_KEY; }
function health() {
  const counts = {}; for (const st of STORES) counts[st] = db[st].size;
  let dbStatus = 'connected';
  try { fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK); } catch (e) { dbStatus = 'error'; }
  if (lastSaveError) dbStatus = 'error';
  return { ok: true, time: new Date().toISOString(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    db: { status: dbStatus, file: path.basename(DATA_FILE), records: counts, lastSave: lastSaveAt ? new Date(lastSaveAt).toISOString() : null, lastSaveError },
    backups: { count: listBackups().length, last: lastBackupAt ? new Date(lastBackupAt).toISOString() : null },
    conflictsResolved: conflictTotal, keyRequired: !!SYNC_KEY, tts: { configured: !!GOOGLE_TTS_KEY }, errors: { count: errorTotal, recent: serverErrors.slice(-5) } };
}
async function handleTts(req, res) {
  if (!GOOGLE_TTS_KEY) return send(res, 503, { ok: false, error: 'Google voice is not set up on the server' });
  const b = await readJson(req);
  const lang = isObj(b) && TTS_LANG[b.lang] ? b.lang : null, text = isObj(b) && typeof b.text === 'string' ? b.text.trim() : '';
  if (!lang || !text || text.length > 500) return send(res, 400, { ok: false, error: 'Bad text or language' });
  const rate = Math.min(1.5, Math.max(0.5, Number(b.rate) || 0.9));
  const key = lang + '|' + rate + '|' + text;
  if (ttsCache.has(key)) return send(res, 200, { ok: true, mime: 'audio/mpeg', audio: ttsCache.get(key), cached: true });
  const mk = name => ({ input: { text }, voice: Object.assign({ languageCode: TTS_LANG[lang] }, name ? { name } : { ssmlGender: 'FEMALE' }), audioConfig: { audioEncoding: 'MP3', speakingRate: rate, sampleRateHertz: 24000 } });
  let r = await googlePost(mk(TTS_VOICES[lang]));
  if (r.status === 400) r = await googlePost(mk(null)); // that named voice may not exist for this language: use Google's default voice
  if (r.status !== 200 || !r.json.audioContent) { trackError('tts', (r.json && r.json.error && r.json.error.message) || 'HTTP ' + r.status); return send(res, 502, { ok: false, error: 'Google voice request failed' }); }
  if (ttsCache.size > 300) ttsCache.delete(ttsCache.keys().next().value);
  ttsCache.set(key, r.json.audioContent);
  send(res, 200, { ok: true, mime: 'audio/mpeg', audio: r.json.audioContent });
}
function handleBackupDownload(req, res) {
  if (!SYNC_KEY || !keyOk(req)) return send(res, 403, { ok: false, error: 'Set SYNC_KEY on the server and send it as x-sync-key' });
  const out = {}; for (const st of STORES) out[st] = [...db[st].values()];
  send(res, 200, JSON.stringify(out), { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="msrtc-backup-' + new Date().toISOString().slice(0, 10) + '.json"' });
}
async function handleBackupRestore(req, res) {
  if (!SYNC_KEY || !keyOk(req)) return send(res, 403, { ok: false, error: 'Set SYNC_KEY on the server and send it as x-sync-key' });
  const raw = await readJson(req); let n = 0;
  if (!isObj(raw)) return send(res, 400, { ok: false, error: 'Bad backup file' });
  makeBackup(); // keep a copy of what is there now
  for (const st of STORES) for (const rec of Array.isArray(raw[st]) ? raw[st] : []) { const k = isObj(rec) && rec[keyField(st)]; if (typeof k === 'string' && k) { db[st].set(k, rec); n++; } }
  saveDb(); send(res, 200, { ok: true, restored: n });
}

async function handlePush(req, res) {
  const body = await readJson(req);
  const store = body && body.store;
  if (!STORES.includes(store) || !Array.isArray(body.records)) return send(res, 400, { ok: false, error: 'Bad store or records' });
  const kf = keyField(store);
  let saved = 0; const conflictKeys = [];
  for (const rec of body.records) {
    if (!isObj(rec)) continue;
    const k = rec[kf];
    if (typeof k !== 'string' || !k || k.length > 200) continue;
    const old = db[store].get(k);
    if (old && typeof old.updatedAt === 'number' && typeof rec.updatedAt === 'number' && old.updatedAt > rec.updatedAt) { conflictKeys.push(k); conflictTotal++; continue; } // server already has a NEWER edit
    const clean = Object.assign({}, rec);
    delete clean.id;      // local auto-increment id of the sender's IndexedDB
    delete clean.synced;  // each device tracks this itself
    db[store].set(k, clean);
    saved++;
  }
  if (saved) scheduleSave();
  send(res, 200, { ok: true, saved, conflicts: conflictKeys.length, conflictKeys });
}

async function handleDelete(req, res) {
  const body = await readJson(req);
  const store = body && body.store;
  if (!STORES.includes(store) || !Array.isArray(body.keys)) return send(res, 400, { ok: false, error: 'Bad store or keys' });
  let removed = 0;
  for (const k of body.keys) if (typeof k === 'string' && db[store].delete(k)) removed++;
  if (removed) scheduleSave();
  send(res, 200, { ok: true, removed });
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
    'Access-Control-Allow-Headers': 'Content-Type, x-sync-key'
  };
  if (req.headers['access-control-request-private-network']) cors['Access-Control-Allow-Private-Network'] = 'true';
  for (const k in cors) res.setHeader(k, cors[k]);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const p = new URL(req.url, 'http://x').pathname;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && PWA_FILES[p]) { // installable-app files (manifest, service worker, icons)
      try {
        const buf = fs.readFileSync(path.join(__dirname, p.slice(1)));
        res.writeHead(200, { 'Content-Type': PWA_FILES[p], 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400', 'Content-Length': buf.length });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      } catch (e) { return send(res, 404, 'Not found'); }
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html' || (APP_FILE && p === '/' + path.basename(APP_FILE)))) return serveApp(req, res);
    if (req.method === 'GET' && p === '/health') return send(res, 200, health());
    if (p.startsWith('/sync/') && !keyOk(req)) return send(res, 401, { ok: false, error: 'Wrong or missing sync key' });
    if (req.method === 'POST' && p === '/tts') { if (!keyOk(req)) return send(res, 401, { ok: false, error: 'Wrong or missing sync key' }); return await handleTts(req, res); }
    if (req.method === 'GET' && p === '/backup/download') return handleBackupDownload(req, res);
    if (req.method === 'POST' && p === '/backup/restore') return await handleBackupRestore(req, res);
    if (req.method === 'GET' && p === '/sync/pull') return handlePull(req, res);
    if (req.method === 'POST' && p === '/sync/push') return await handlePush(req, res);
    if (req.method === 'POST' && p === '/sync/delete') return await handleDelete(req, res);
    if (req.method === 'POST' && p === '/otp/send') return await handleOtpSend(req, res);
    if (req.method === 'POST' && p === '/otp/verify') return await handleOtpVerify(req, res);
    send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    errorTotal++; trackError(req.method + ' ' + req.url.split('?')[0], e);
    if (!res.headersSent) send(res, e.status || 500, { ok: false, error: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* HTTPS: self-signed certificate made with plain Node (no openssl)    */
/* ------------------------------------------------------------------ */
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
function makeSelfSigned(ips) {
  const derLen = n => { if (n < 128) return Buffer.from([n]); const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); };
  const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); };
  const SEQ = (...p) => der(0x30, ...p), SET = (...p) => der(0x31, ...p);
  const oid = str => {
    const a = str.split('.').map(Number), bytes = [a[0] * 40 + a[1]];
    for (let i = 2; i < a.length; i++) { let v = a[i]; const t = [v & 127]; v >>= 7; while (v > 0) { t.unshift((v & 127) | 128); v >>= 7; } bytes.push(...t); }
    return der(0x06, Buffer.from(bytes));
  };
  const posInt = buf => { let b = Buffer.from(buf); while (b.length > 1 && b[0] === 0 && b[1] < 128) b = b.slice(1); if (b[0] & 128) b = Buffer.concat([Buffer.from([0]), b]); return der(0x02, b); };
  const utc = d => { const p = n => String(n).padStart(2, '0'); return der(0x17, Buffer.from(p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z')); };
  const NULL = der(0x05, Buffer.alloc(0));
  const sigAlg = SEQ(oid('1.2.840.113549.1.1.11'), NULL); // sha256WithRSAEncryption
  const name = SEQ(SET(SEQ(oid('2.5.4.10'), der(0x0c, Buffer.from('MSRTC Local')))), SET(SEQ(oid('2.5.4.3'), der(0x0c, Buffer.from('MSRTC Local Server')))));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notBefore = new Date(Date.now() - 24 * 3600e3), notAfter = new Date(Date.now() + 800 * 24 * 3600e3);
  const names = [der(0x82, Buffer.from('localhost'))];
  const host = os.hostname(); if (host) names.push(der(0x82, Buffer.from(host)));
  for (const ip of ['127.0.0.1', ...ips]) names.push(der(0x87, Buffer.from(ip.split('.').map(Number))));
  const ext = (id, crit, value) => SEQ(oid(id), ...(crit ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
  const tbs = SEQ(
    der(0xa0, posInt(Buffer.from([2]))),
    posInt(crypto.randomBytes(16).map((b, i) => i === 0 ? b & 0x7f : b)),
    sigAlg, name, SEQ(utc(notBefore), utc(notAfter)), name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, SEQ(
      ext('2.5.29.17', false, SEQ(...names)),                         // subjectAltName
      ext('2.5.29.19', true, SEQ()),                                  // basicConstraints: not a CA
      ext('2.5.29.15', true, der(0x03, Buffer.from([5, 0xa0]))),      // keyUsage: digitalSignature + keyEncipherment
      ext('2.5.29.37', false, SEQ(oid('1.3.6.1.5.5.7.3.1')))          // extKeyUsage: serverAuth
    ))
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const cert = SEQ(tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = (label, buf) => '-----BEGIN ' + label + '-----\n' + buf.toString('base64').replace(/(.{64})/g, '$1\n').trim() + '\n-----END ' + label + '-----\n';
  return { cert: pem('CERTIFICATE', cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }), expires: notAfter.getTime() };
}
/* returns { cert, key } or null. Your own cert/key are used as-is; the automatic one is renewed when the IPs change or it nears expiry. */
function getTls() {
  if (!HTTPS_ON) return null;
  try {
    const have = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
    let meta = null; try { meta = JSON.parse(fs.readFileSync(CERT_META, 'utf8')); } catch (e) { /* none */ }
    const ips = lanIps();
    if (have && !meta) return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }; // user-supplied
    const stale = !have || !meta || meta.expires < Date.now() + 30 * 24 * 3600e3 || ips.some(ip => !(meta.ips || []).includes(ip));
    if (stale) {
      const g = makeSelfSigned(ips);
      fs.mkdirSync(path.dirname(CERT_FILE), { recursive: true });
      fs.writeFileSync(CERT_FILE, g.cert); fs.writeFileSync(KEY_FILE, g.key, { mode: 0o600 });
      fs.writeFileSync(CERT_META, JSON.stringify({ ips, expires: g.expires, created: new Date().toISOString() }));
      console.log('Created a self-signed HTTPS certificate in ' + path.dirname(CERT_FILE));
    }
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  } catch (e) { console.error('HTTPS disabled - could not prepare the certificate: ' + e.message); return null; }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
loadDb();

const tls = getTls();
const isLocalHost = h => /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(h);
let httpsServer = null;
if (tls) httpsServer = https.createServer(tls, handler);

/* plain http: this computer uses it via localhost; any other address is sent to https (the camera needs https) */
const httpServer = http.createServer((req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (httpsServer && req.method === 'GET' && !isLocalHost(host) && req.url !== '/health') {
    res.writeHead(302, { Location: 'https://' + host + ':' + HTTPS_PORT + req.url });
    return res.end();
  }
  return handler(req, res);
});

const fail = (port) => e => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + port + ' is already in use - close the other copy of this server (or set PORT / HTTPS_PORT to a free port).' : 'Server error: ' + e.message);
  process.exit(1);
};
httpServer.on('error', fail(PORT));
if (httpsServer) httpsServer.on('error', fail(HTTPS_PORT));

function banner() {
  console.log('\nMSRTC server running');
  if (ON_RENDER) {
    console.log('  Public URL    :  ' + (process.env.RENDER_EXTERNAL_URL || '(your onrender.com address)') + '   (secure https by Render - camera + face scan work)');
  } else {
    console.log('  This computer :  http://localhost:' + PORT);
    for (const ip of lanIps()) console.log('  Other devices :  ' + (httpsServer ? 'https://' + ip + ':' + HTTPS_PORT : 'http://' + ip + ':' + PORT));
  }
  console.log('Database file  :  ' + DATA_FILE);
  const dn = Object.keys(loadDepotSmtp()).length;
  console.log('\nDepot Gmail logins: ' + (dn ? dn + ' loaded' : 'none (edit DEPOT_GMAIL at the top of server.js)'));
  console.log('Email OTP: ' + (MAIL_ENABLED ? 'SMTP ' + SMTP.host + ':' + SMTP.port : 'TEST MODE - codes are only printed here (set SMTP_HOST to send real emails)'));
  console.log('\nOpen the app from the URL above - it saves everything to the database file automatically.');
  if (ON_RENDER) {
    console.log('\nRunning on Render: HTTPS is provided by Render, so no browser warning appears.');
  } else if (httpsServer) {
    console.log('\nHTTPS is ON (camera + face scan work on phones). The certificate is self-signed, so the FIRST time a phone');
    console.log('opens the https address it shows a warning: tap  Advanced  ->  Proceed to <address> (unsafe).  Only needed once.');
    console.log('(Typing http://<address>:' + PORT + ' on a phone is redirected to https automatically.)');
  } else {
    console.log('Note: HTTPS is off. Phones opening the app over plain http://<ip> cannot use the camera.');
  }
  console.log('');
  if (process.env.MSRTC_FIRST === '1' && process.env.NO_BROWSER !== '1') { // open the app once, on first start
    try {
      const url = 'http://localhost:' + PORT;
      const cp = require('child_process');
      const c = process.platform === 'win32' ? cp.spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
              : cp.spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
      c.on('error', () => {}); c.unref();
    } catch (e) { /* ignore */ }
  }
}
httpServer.listen(PORT, HOST, () => {
  if (httpsServer) httpsServer.listen(HTTPS_PORT, HOST, banner); else banner();
});
