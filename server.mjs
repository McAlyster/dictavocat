import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import nodemailer from 'nodemailer';

const env = process.env;
const port = Number(env.PORT || 8080);
const host = env.HOST || '127.0.0.1';
const baseUrl = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const uploadToken = env.UPLOAD_TOKEN || '';
const recipient = env.AGE_RECIPIENT || '';
const secretaryEmail = env.SECRETARY_EMAIL || '';
const officeName = (env.OFFICE_NAME || '').slice(0, 80);
const mailFrom = env.MAIL_FROM || '';
const dataDir = resolve(env.DATA_DIR || './data');
const uploadsDir = join(dataDir, 'uploads');
const metadataDir = join(dataDir, 'metadata');
const maxUploadBytes = Number(env.MAX_UPLOAD_BYTES || 125829120);
const linkTtlMs = Number(env.LINK_TTL_HOURS || 72) * 60 * 60 * 1000;
const maxDownloads = Math.max(1, Math.min(2, Number(env.MAX_DOWNLOADS || 2)));
const downloadReservations = new Map();
const completedDownloads = new Map();
const metadataWriteQueues = new Map();
const ageHeader = Buffer.from('age-encryption.org/v1\n');

// ---------- Anti-abuse limits (all configurable in .env) ----------
const int = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value !== undefined ? Number(value) : fallback);
const limits = {
  authFailLimit: int(env.AUTH_FAIL_LIMIT, 5),
  authBlockMs: int(env.AUTH_BLOCK_MINUTES, 15) * 60_000,
  uploadsPerHour: int(env.UPLOADS_PER_HOUR, 20),
  uploadsPerDay: int(env.UPLOADS_PER_DAY, 100),
  maxStoredBytes: int(env.MAX_STORED_BYTES, 2 * 1024 ** 3),
  maxPending: int(env.MAX_PENDING_DEPOSITS, 50),
  maxConcurrent: int(env.MAX_CONCURRENT_UPLOADS, 2),
  downloadsPerHourPerIp: int(env.DOWNLOADS_PER_HOUR_PER_IP, 30),
  headersTimeoutMs: int(env.HEADERS_TIMEOUT_SECONDS, 10) * 1000,
  requestTimeoutMs: int(env.UPLOAD_TIMEOUT_MINUTES, 30) * 60_000
};
// Which X-Forwarded-For to believe: 'loopback' (default, proxy on the same machine),
// 'always' (app reachable only through the proxy, e.g. container port bound to 127.0.0.1), 'never'.
const trustProxy = ['loopback', 'always', 'never'].includes(env.TRUST_PROXY) ? env.TRUST_PROXY : 'loopback';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hits = new Map();
let activeUploads = 0;

if (!uploadToken || Buffer.byteLength(uploadToken) < 32) throw new Error('UPLOAD_TOKEN must contain at least 32 bytes.');
if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{50,}$/.test(recipient)) throw new Error('AGE_RECIPIENT must be a valid age recipient.');
// HTTPS is required, except http://localhost for local testing.
if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) throw new Error('PUBLIC_BASE_URL must use HTTPS.');
if (!secretaryEmail || !mailFrom || !env.SMTP_HOST) throw new Error('Configure SECRETARY_EMAIL, MAIL_FROM and SMTP_HOST.');

await mkdir(uploadsDir, { recursive: true, mode: 0o700 });
await mkdir(metadataDir, { recursive: true, mode: 0o700 });

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: Number(env.SMTP_PORT || 587),
  secure: env.SMTP_SECURE === 'true',
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD || '' } : undefined,
  tls: { minVersion: 'TLSv1.2' }
});

function clientIp(req) {
  const remote = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  const isLoopback = remote === '127.0.0.1' || remote === '::1';
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && (trustProxy === 'always' || (trustProxy === 'loopback' && isLoopback))) {
    // The right-most entry is the one added by our own proxy.
    const last = forwarded.split(',').map((v) => v.trim()).filter(Boolean).pop();
    if (last) return last.replace(/^::ffff:/, '');
  }
  return remote;
}
function countRecent(key, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length) hits.set(key, list); else hits.delete(key);
  return list.length;
}
function record(key) {
  const list = hits.get(key) || [];
  list.push(Date.now());
  hits.set(key, list);
}
function pruneHits() {
  const now = Date.now();
  for (const [key, list] of hits) if (!list.some((t) => now - t < DAY)) hits.delete(key);
}
function tooMany(res, message, retryAfterSeconds) {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return clientError(res, 429, message);
}
function isBlocked(ip) { return countRecent(`fail:${ip}`, limits.authBlockMs) >= limits.authFailLimit; }
function authFailed(ip, where) {
  record(`fail:${ip}`);
  console.warn('auth_failed', where, ip);
}
async function storageUsage() {
  let bytes = 0;
  let deposits = 0;
  for (const name of await readdir(uploadsDir).catch(() => [])) {
    if (!name.endsWith('.age') && !name.endsWith('.part')) continue;
    if (name.endsWith('.age')) deposits++;
    try { bytes += (await stat(join(uploadsDir, name))).size; } catch { /* removed meanwhile */ }
  }
  return { bytes, deposits };
}

function hashToken(token) { return createHash('sha256').update(token).digest(); }
function safeEqualHex(a, b) {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  } catch { return false; }
}
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}
function clientError(res, status, message) { json(res, status, { error: message }); }
async function readSmallJson(req, limit = 4096) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function loadMetadata(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  try { return JSON.parse(await readFile(join(metadataDir, `${id}.json`), 'utf8')); }
  catch { return null; }
}
async function saveMetadata(meta) {
  const previous = metadataWriteQueues.get(meta.id) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const file = join(metadataDir, `${meta.id}.json`);
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  });
  metadataWriteQueues.set(meta.id, current);
  try { await current; }
  finally { if (metadataWriteQueues.get(meta.id) === current) metadataWriteQueues.delete(meta.id); }
}
async function deleteDeposit(meta) {
  await Promise.allSettled([
    rm(join(uploadsDir, `${meta.id}.age`), { force: true }),
    rm(join(metadataDir, `${meta.id}.json`), { force: true })
  ]);
}
async function expireOldDeposits() {
  const now = Date.now();
  let names = [];
  try { names = await readdir(metadataDir); } catch { return; }
  const known = new Set();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    known.add(name.slice(0, -5));
    try {
      const meta = JSON.parse(await readFile(join(metadataDir, name), 'utf8'));
      if (meta.expiresAt <= now) await deleteDeposit(meta);
    } catch { /* Ignore malformed metadata; do not delete the ciphertext automatically. */ }
  }
  // Purge leftovers from interrupted uploads or crashes: partial files and ciphertexts
  // without metadata, once they are older than the link lifetime.
  let uploads = [];
  try { uploads = await readdir(uploadsDir); } catch { return; }
  for (const name of uploads) {
    const isPart = name.endsWith('.part');
    const isOrphan = name.endsWith('.age') && !known.has(name.slice(0, -4));
    if (!isPart && !isOrphan) continue;
    try {
      const info = await stat(join(uploadsDir, name));
      const maxAge = isPart ? 60 * 60 * 1000 : linkTtlMs;
      if (now - info.mtimeMs > maxAge) await rm(join(uploadsDir, name), { force: true });
    } catch { /* ignore */ }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, { recipient, maxUploadBytes, officeName });
  }

  if (req.method === 'POST' && pathname === '/api/uploads') {
    const ip = clientIp(req);
    if (isBlocked(ip)) return tooMany(res, 'Trop de tentatives avec un lien invalide. Réessayez plus tard.', limits.authBlockMs / 1000);
    const auth = req.headers.authorization;
    const supplied = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const good = typeof supplied === 'string' && safeEqualHex(hashToken(supplied).toString('hex'), hashToken(uploadToken).toString('hex'));
    if (!good) { authFailed(ip, 'upload'); return clientError(res, 401, 'Lien de dépôt invalide.'); }
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength && contentLength > maxUploadBytes) return clientError(res, 413, 'Le dépôt dépasse la limite autorisée.');
    if (activeUploads >= limits.maxConcurrent) return tooMany(res, 'Un autre envoi est en cours. Réessayez dans un instant.', 30);
    if (countRecent('upload', HOUR) >= limits.uploadsPerHour || countRecent('upload', DAY) >= limits.uploadsPerDay) {
      console.warn('rate_limited', 'upload', ip);
      return tooMany(res, 'Le nombre maximal d’envois est atteint pour le moment. Réessayez plus tard ou prévenez l’administrateur.', 600);
    }
    const usage = await storageUsage();
    if (usage.deposits >= limits.maxPending || usage.bytes + (contentLength || maxUploadBytes) > limits.maxStoredBytes) {
      console.warn('storage_full', usage.deposits, usage.bytes);
      return clientError(res, 507, 'L’espace de stockage du service est plein. Prévenez l’administrateur.');
    }
    record('upload');
    activeUploads++;
    res.on('close', () => { activeUploads--; });
    const id = randomUUID();
    const tempPath = join(uploadsDir, `${id}.part`);
    const finalPath = join(uploadsDir, `${id}.age`);
    let total = 0;
    let prefix = Buffer.alloc(0);
    const checker = new Transform({
      transform(chunk, encoding, callback) {
        total += chunk.length;
        if (total > maxUploadBytes) return callback(new Error('UPLOAD_LIMIT'));
        if (prefix.length < ageHeader.length) prefix = Buffer.concat([prefix, chunk.subarray(0, ageHeader.length - prefix.length)]);
        if (prefix.length >= ageHeader.length && !prefix.subarray(0, ageHeader.length).equals(ageHeader)) return callback(new Error('NOT_AGE'));
        callback(null, chunk);
      }
    });
    try {
      await pipeline(req, checker, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      if (total < ageHeader.length) throw new Error('NOT_AGE');
      await rename(tempPath, finalPath);
      const secret = randomBytes(32).toString('base64url');
      const meta = {
        id, tokenHash: hashToken(secret).toString('hex'),
        createdAt: Date.now(), expiresAt: Date.now() + linkTtlMs,
        downloads: 0, size: total
      };
      await saveMetadata(meta);
      const link = `${baseUrl}/download/${id}#t=${secret}`;
      let notificationSent = false;
      try {
        await transporter.sendMail({
          from: mailFrom,
          to: secretaryEmail,
          subject: 'Nouveau dépôt de notes vocales',
          text: `Un nouveau dépôt est disponible.\n\nOuvrez ce lien, choisissez votre fichier clé et saisissez votre phrase secrète :\n${link}\n\nLe lien est valable ${Math.round(linkTtlMs / 3600000)} heures et peut servir ${maxDownloads} fois.`,
          disableFileAccess: true,
          disableUrlAccess: true
        });
        notificationSent = true;
      } catch (error) {
        console.error('notification_failed', error?.code || 'smtp_error');
      }
      return json(res, 201, { ok: true, notificationSent });
    } catch (error) {
      await Promise.allSettled([rm(tempPath, { force: true }), rm(finalPath, { force: true })]);
      const message = error.message === 'UPLOAD_LIMIT' ? 'Le dépôt dépasse la limite autorisée.'
        : error.message === 'NOT_AGE' ? 'Le fichier reçu ne semble pas être une archive age chiffrée.'
        : 'Le dépôt n’a pas pu être enregistré.';
      return clientError(res, error.message === 'UPLOAD_LIMIT' ? 413 : 400, message);
    }
  }

  if (req.method === 'POST' && pathname === '/api/download') {
    const ip = clientIp(req);
    if (isBlocked(ip)) return tooMany(res, 'Trop de tentatives avec un lien invalide. Réessayez plus tard.', limits.authBlockMs / 1000);
    if (countRecent(`dl:${ip}`, HOUR) >= limits.downloadsPerHourPerIp) return tooMany(res, 'Trop de demandes. Réessayez dans un moment.', 600);
    record(`dl:${ip}`);
    let input;
    try { input = await readSmallJson(req); }
    catch { return clientError(res, 400, 'Requête invalide.'); }
    const meta = await loadMetadata(input?.id);
    if (!meta || meta.expiresAt <= Date.now()) { authFailed(ip, 'download'); return clientError(res, 410, 'Lien expiré ou indisponible.'); }
    if (typeof input?.token !== 'string' || !safeEqualHex(hashToken(input.token).toString('hex'), meta.tokenHash)) { authFailed(ip, 'download'); return clientError(res, 403, 'Lien invalide.'); }
    const used = completedDownloads.has(meta.id) ? completedDownloads.get(meta.id) : meta.downloads;
    const reserved = downloadReservations.get(meta.id) || 0;
    if (used + reserved >= maxDownloads) return clientError(res, 410, 'Le nombre de téléchargements autorisés est atteint.');
    downloadReservations.set(meta.id, reserved + 1);
    let completed = false;
    try {
      const filePath = join(uploadsDir, `${meta.id}.age`);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error('missing');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileStat.size,
        'Content-Disposition': 'attachment; filename="depot.age"',
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff'
      });
      await new Promise((resolvePromise, reject) => {
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        res.on('finish', resolvePromise);
        res.on('close', () => { if (!res.writableFinished) reject(new Error('interrupted')); });
        stream.pipe(res);
      });
      completed = true;
    } catch {
      if (!res.headersSent) clientError(res, 404, 'Fichier indisponible.');
    } finally {
      const count = Math.max(0, (downloadReservations.get(meta.id) || 1) - 1);
      if (count) downloadReservations.set(meta.id, count); else downloadReservations.delete(meta.id);
      if (completed) {
        meta.downloads = (completedDownloads.get(meta.id) ?? meta.downloads) + 1;
        completedDownloads.set(meta.id, meta.downloads);
        await saveMetadata(meta).catch(() => {});
        if (meta.downloads >= maxDownloads) await deleteDeposit(meta);
      }
    }
    return;
  }

  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead && (pathname === '/' || pathname === '/download' || pathname.startsWith('/download/'))) {
    return serveStatic(res, 'index.html', req.method === 'HEAD');
  }
  if (isRead && /^\/(assets\/|favicon\.ico$)/.test(pathname)) {
    return serveStatic(res, pathname.slice(1), req.method === 'HEAD');
  }
  return clientError(res, 404, 'Introuvable.');
});

async function serveStatic(res, relative, headOnly = false) {
  const root = resolve('./dist');
  const file = resolve(root, relative);
  if (!file.startsWith(root + '/') && file !== root) return clientError(res, 404, 'Introuvable.');
  try {
    const body = await readFile(file);
    const type = extname(file) === '.html' ? 'text/html; charset=utf-8' : extname(file) === '.js' ? 'text/javascript; charset=utf-8' : extname(file) === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(headOnly ? undefined : body);
  } catch { clientError(res, 404, 'Fichier introuvable.'); }
}

setInterval(() => { expireOldDeposits().catch(() => {}); pruneHits(); }, 60_000).unref();
await expireOldDeposits();
server.headersTimeout = limits.headersTimeoutMs;
server.requestTimeout = limits.requestTimeoutMs;
server.listen(port, host, () => console.log(`dictavocat listening on ${host}:${port}`));
