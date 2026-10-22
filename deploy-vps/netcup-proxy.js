// Läuft auf netcup (Plesk/Passenger) als httpdocs/server.js, seit Letzte Runde auf dem VPS läuft (2026-10-22).
// Geräte mit veraltetem DNS landen noch hier: alles (HTTP + WebSocket) wird unverändert an den VPS durchgereicht.
// Kein 301 – der zeigte auf denselben Namen und liefe bei altem DNS-Cache im Kreis.
// Der VPS übernimmt die Client-IP aus X-Forwarded-For nur von dieser Maschine (set_real_ip_from in nginx).
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');

const VPS = '194.163.182.35';
const HOSTS = new Set(['letzterunde.aize-it.de', 'gang.aize.eu']);
const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade'];
const fs = require('fs');
const log = (m) => fs.appendFile(__dirname + '/logs/proxy.log', new Date().toISOString() + ' ' + m + '\n', () => {});
process.on('uncaughtException', (e) => log('uncaught ' + (e && e.stack || e)));

function target(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return HOSTS.has(host) ? host : 'letzterunde.aize-it.de';
}

// Passenger hängt die echte IP an X-Forwarded-For an → letzter öffentlicher Eintrag (wie clientIp in app/server.js)
const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:|::ffff:127\.|unix|$)/i;
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = xf.length - 1; i >= 0; i--) if (!PRIVATE_IP.test(xf[i])) return xf[i].slice(0, 64);
  const xr = String(req.headers['x-real-ip'] || '').trim();
  if (xr && !PRIVATE_IP.test(xr)) return xr.slice(0, 64);
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function headersFor(req, host) {
  const h = { ...req.headers, host, 'x-forwarded-for': clientIp(req), 'x-forwarded-proto': 'https' };
  delete h['x-real-ip'];
  if (!req.headers.upgrade) for (const k of HOP) delete h[k];
  return h;
}

const server = http.createServer((req, res) => {
  const host = target(req);
  const up = https.request({ host: VPS, servername: host, port: 443, method: req.method, path: req.url,
    headers: headersFor(req, host), agent, timeout: 30000 }, (r) => {
    const h = { ...r.headers }; for (const k of HOP) delete h[k];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => { log(req.method + ' ' + host + req.url.slice(0, 80) + ' → ' + e.message); if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('VPS nicht erreichbar'); });
  req.pipe(up);
});

server.on('upgrade', (req, sock, head) => {
  const host = target(req);
  const up = tls.connect({ host: VPS, port: 443, servername: host, ALPNProtocols: ['http/1.1'] }, () => {
    const h = headersFor(req, host);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const x of [].concat(v)) raw += `${k}: ${x}\r\n`;
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(sock); sock.pipe(up);
  });
  const end = () => { sock.destroy(); up.destroy(); };
  up.on('error', end); sock.on('error', end); up.on('close', end); sock.on('close', end);
});

// Länger als Passenger/nginx eine ruhende Verbindung wiederverwenden (Node-Standard 5 s → sporadische 502)
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.listen(process.env.PORT || 3000);
