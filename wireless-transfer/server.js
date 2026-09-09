'use strict';
/**
 * 无线传输 - 本地服务（零依赖）
 * 职责：
 *   1) 提供静态前端（public/）
 *   2) 最小 WebSocket 信令服务：设备发现(peers) + WebRTC 信令中继(signal) + 临时聊天室(chat)
 * 关键点：服务端只转发信令与聊天文本，永远不接触文件字节（文件走 WebRTC P2P 直连）。
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '3000', 10);
// 本工具需要在局域网内被手机/其他设备访问，默认监听所有网卡(0.0.0.0)。
// 若运行环境误注入了回环地址(127.0.0.1 / localhost / ::1)，忽略它，改用 0.0.0.0。
const _envHost = process.env.HOST;
const HOST = (_envHost && _envHost !== '127.0.0.1' && _envHost !== 'localhost' && _envHost !== '::1')
  ? _envHost
  : '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

function buildIceConfig(req) {
  const stunRaw = process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302';
  const stunList = stunRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const iceServers = stunList.length ? [{ urls: stunList }] : [];
  let turnList = (process.env.TURN_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 未显式配置 TURN_URL 时，从请求 Host 自动推导（与网页访问地址同源），免去写死域名/IP。
  if (!turnList.length && req && req.headers && req.headers.host &&
      process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    const hostOnly = String(req.headers.host).split(':')[0];
    const turnPort = parseInt(process.env.TURN_PORT || '34780', 10);
    turnList = ['turn:' + hostOnly + ':' + turnPort];
  }
  if (turnList.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnList, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return { iceServers };
}

function serveStatic(req, res) {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.url === '/ice-config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(buildIceConfig(req)));
    return;
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// ---------- 客户端登记表 ----------
const clients = new Map(); // ws -> { id, name, room }
function genId() { return crypto.randomBytes(4).toString('hex'); }

function encodeFrame(data, opcode) {
  opcode = opcode || 0x1;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function createWS(socket) {
  const ws = { socket: socket, onMessage: null, alive: true };
  let buf = Buffer.alloc(0);
  let fragBuf = [];
  let fragActive = false;
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      let maskKey;
      if (masked) { if (buf.length < offset + 4) break; maskKey = buf.slice(offset, offset + 4); offset += 4; }
      if (buf.length < offset + len) break;
      let payload = buf.slice(offset, offset + len);
      if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4]; payload = out; }
      buf = buf.slice(offset + len);
      if (opcode === 0x8) { try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch (e) {} try { socket.end(); } catch (e) {} return; }
      else if (opcode === 0x9) { try { socket.write(encodeFrame(payload, 0xA)); } catch (e) {} continue; }
      else if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) { fragBuf = []; fragActive = true; }
        fragBuf.push(payload);
        if (fin && fragActive) { const full = Buffer.concat(fragBuf).toString('utf8'); fragBuf = []; fragActive = false; if (ws.onMessage) ws.onMessage(full); }
      }
    }
  });
  socket.on('close', () => handleClose(ws));
  socket.on('error', () => handleClose(ws));
  ws.send = function (msg) { try { socket.write(encodeFrame(msg)); } catch (e) {} };
  ws.close = function () { try { socket.write(encodeFrame(Buffer.alloc(0), 0x8)); socket.end(); } catch (e) {} };
  return ws;
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { try { socket.destroy(); } catch (e) {} return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const ws = createWS(socket);
  const info = { id: genId(), name: '匿名', room: 'default' };
  clients.set(ws, info);
  ws.send(JSON.stringify({ type: 'welcome', id: info.id }));
  ws.onMessage = (text) => handleMessage(ws, info, text);
});

function roomPeers(room, exceptWs) {
  const list = [];
  for (const [c, info] of clients) {
    if (c === exceptWs) continue;
    if (info.room === room) list.push({ id: info.id, name: info.name });
  }
  return list;
}

function broadcastPeerList(room) {
  for (const [c, info] of clients) {
    if (info.room !== room) continue;
    c.send(JSON.stringify({ type: 'peers', peers: roomPeers(room, c) }));
  }
}

function relayTo(id, obj) {
  for (const [c, info] of clients) { if (info.id === id) { c.send(JSON.stringify(obj)); return; } }
}

function broadcastRoom(room, obj, exceptId) {
  for (const [c, info] of clients) {
    if (info.room !== room) continue;
    if (info.id === exceptId) continue;
    c.send(JSON.stringify(obj));
  }
}

function handleMessage(ws, info, text) {
  let msg; try { msg = JSON.parse(text); } catch (e) { return; }
  switch (msg.type) {
    case 'join':
      info.name = String(msg.name || '匿名').slice(0, 32) || '匿名';
      info.room = String(msg.room || 'default').slice(0, 32) || 'default';
      broadcastPeerList(info.room);
      break;
    case 'signal':
      if (msg.to) relayTo(msg.to, { type: 'signal', from: info.id, name: info.name, data: msg.data });
      break;
    case 'chat':
      broadcastRoom(info.room, { type: 'chat', from: info.id, name: info.name, text: String(msg.text || '').slice(0, 4000), ts: Date.now() }, info.id);
      break;
    case 'leave':
      handleClose(ws);
      break;
  }
}

function handleClose(ws) {
  if (!clients.has(ws)) return;
  const info = clients.get(ws);
  clients.delete(ws);
  try { ws.socket.destroy(); } catch (e) {}
  try { broadcastPeerList(info.room); } catch (e) {}
}

function printLanUrls(port) {
  const ifaces = os.networkInterfaces();
  const seen = new Set();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal && !seen.has(ni.address)) {
        seen.add(ni.address);
        console.log('    局域网(' + name + '):  http://' + ni.address + ':' + port);
      }
    }
  }
}

server.listen(PORT, HOST, () => {
  console.log('无线传输 本地服务已启动 (监听 ' + HOST + ':' + PORT + ')');
  console.log('  本机访问:  http://localhost:' + PORT);
  console.log('  局域网设备(手机/其他电脑)请用以下地址加入同一房间:');
  printLanUrls(PORT);
  console.log('  提示: 默认端口 3000，可用环境变量 PORT 修改。');
});
