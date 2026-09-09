'use strict';
/**
 * 无线传输 前端
 * - 设备发现：通过 WebSocket 信令服务器（同房间 peers）
 * - 文本：临时聊天室（房间广播，服务端不持久化）
 * - 文件：WebRTC 数据通道 P2P 直传，分块 + 断点续传，不限大小
 *
 * 传输协议（两个数据通道：ctrl=JSON 控制，file=二进制分块）
 *   发送端 -> 接收端： file-meta / file-start / file-end / file-cancel
 *   接收端 -> 发送端： file-ready(带已收偏移) / file-done
 */
(function () {
  const CHUNK = 16 * 1024;                 // 单块 16KB
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // 由 /ice-config 注入，缺省单 STUN
  const READY_TIMEOUT = 15000;

  let ws = null;
  let myId = null;
  let myName = '';
  let myRoom = '';
  const peers = new Map();                 // id -> peer
  const discoveredPeers = new Map();       // id -> name（服务端广播的房间内其他成员）
  let pendingSendQueue = [];               // 待发送队列：手机端多次单选累加，最后统一发送（绕开系统 multiple 限制）

  const $ = (id) => document.getElementById(id);
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function fmtSize(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (i === 0 ? x : x.toFixed(2)) + ' ' + u[i];
  }
  function waitFor(cond, timeout) {
    return new Promise((resolve, reject) => {
      if (cond()) return resolve();
      const start = Date.now();
      const iv = setInterval(() => {
        if (cond()) { clearInterval(iv); resolve(); }
        else if (Date.now() - start > (timeout || 20000)) { clearInterval(iv); reject(new Error('等待超时')); }
      }, 100);
    });
  }

  // ---------------- WebSocket ----------------
  async function loadIceServers() {
    try {
      const r = await fetch('/ice-config', { cache: 'no-store' });
      const cfg = await r.json();
      if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) iceServers = cfg.iceServers;
    } catch (e) { /* 网络异常时退回默认单 STUN，局域网仍可用 */ }
  }

  async function connectWS() {
    await loadIceServers();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: myName, room: myRoom }));
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } handleServer(m); };
    ws.onclose = () => { toast('与服务器断开，正在重连…'); setTimeout(connectWS, 1500); };
    ws.onerror = () => {};
  }
  function handleServer(m) {
    switch (m.type) {
      case 'welcome': myId = m.id; break;
      case 'peers': renderPeers(m.peers); break;
      case 'signal': onSignal(m); break;
      case 'chat': appendChat(m.name, m.text, false); break;
    }
  }

  // ---------------- 设备列表 ----------------
  function renderPeers(list) {
    discoveredPeers.clear();
    list.forEach((p) => discoveredPeers.set(p.id, p.name));
    const ul = $('peerList');
    ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="empty">暂无其他设备，邀请同伴加入同一房间</li>'; return; }
    list.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'peer';
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      const btn = document.createElement('button');
      btn.textContent = '发送文件';
      btn.onclick = () => pickFile(p.id);
      li.appendChild(name);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  // ---------------- WebRTC ----------------
  function getPeer(id, name) {
    let p = peers.get(id);
    if (!p) {
      p = { id: id, name: name || id, pc: null, ctrl: null, fileChannel: null, connected: false,
        outTransfers: new Map(), downloads: new Map(), currentDownload: null,
        sendQueue: [], _busy: false, pendingDownloads: [], _currentTransfer: null };
      peers.set(id, p);
    }
    if (name) p.name = name;
    return p;
  }

  function initPC(p, isInitiator) {
    if (p.pc) return p.pc;
    const pc = new RTCPeerConnection({ iceServers: iceServers });
    p.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: 'signal', to: p.id, data: { ice: e.candidate } })); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') p.connected = true;
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        p.connected = false;
        // 连接断开：保留传输进度，待下次发送/接收时自动恢复
      }
    };
    if (isInitiator) {
      const ctrl = pc.createDataChannel('ctrl');
      setupCtrl(p, ctrl);
      const fc = pc.createDataChannel('file');
      setupFileChannel(p, fc);
    } else {
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctrl') setupCtrl(p, e.channel);
        else if (e.channel.label === 'file') setupFileChannel(p, e.channel);
      };
    }
    return pc;
  }

  function setupCtrl(p, ch) {
    p.ctrl = ch;
    ch.onopen = () => { p.connected = true; resumeOutgoing(p); };
    ch.onmessage = (ev) => onCtrlMessage(p, ev.data);
  }
  function setupFileChannel(p, ch) {
    p.fileChannel = ch;
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (ev) => onFileChunk(p, ev.data);
  }

  async function connectToPeer(p) {
    if (p.pc && ['connected', 'connecting', 'new'].includes(p.pc.connectionState)) return p.pc;
    const pc = initPC(p, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'signal', to: p.id, data: { sdp: pc.localDescription } }));
    return pc;
  }

  async function onSignal(m) {
    const p = getPeer(m.from, m.name);
    const data = m.data || {};
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        const pc = initPC(p, false);
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'signal', to: p.id, data: { sdp: pc.localDescription } }));
      } else if (data.sdp.type === 'answer') {
        if (p.pc) await p.pc.setRemoteDescription(data.sdp);
      }
    } else if (data.ice) {
      if (p.pc) { try { await p.pc.addIceCandidate(data.ice); } catch (e) {} }
    }
  }

  // ---------------- 发送文件 ----------------
  function pickFile(peerId) {
    const p = getPeer(peerId);
    const input = $('fileInput');
    input.value = '';
    input.onchange = () => {
      const files = input.files;
      if (!files || !files.length) return;
      for (const f of files) enqueueSend(p, f, true);
    };
    input.click();
  }

  // 顶栏“添加文件”：每次打开选择器，选完文件加入待发送队列，可多次累加，不依赖系统 multiple
  function addPendingFilesFlow() {
    const input = $('fileInput');
    input.value = '';
    input.onchange = () => {
      const files = input.files;
      if (!files || !files.length) return;
      addPendingFiles(files);
    };
    input.click();
  }
  // 按「文件名+大小+最后修改时间」去重加入待发送队列
  function addPendingFiles(files) {
    let added = 0;
    for (const f of files) {
      const dup = pendingSendQueue.some(x => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
      if (!dup) { pendingSendQueue.push(f); added++; }
    }
    if (added > 0) toast('已加入待发送 ' + added + ' 个（累计 ' + pendingSendQueue.length + '）');
    else toast('已跳过重复文件');
    renderPending();
  }
  function removePendingAt(idx) { pendingSendQueue.splice(idx, 1); renderPending(); }
  function clearPending() { pendingSendQueue = []; renderPending(); }
  function renderPending() {
    const panel = $('pendingPanel');
    const ul = $('pendingList');
    if (!pendingSendQueue.length) {
      panel.setAttribute('hidden', '');
      ul.innerHTML = '';
      $('pendingCount').textContent = '0';
      $('sendPending').textContent = '🚀 选择目标发送';
      return;
    }
    panel.removeAttribute('hidden');
    ul.innerHTML = '';
    pendingSendQueue.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = 'pending-item';
      li.innerHTML = '<span class="pname" title="' + escapeHtml(f.name) + '">📎 ' + escapeHtml(f.name) + ' (' + fmtSize(f.size) + ')</span>' +
        '<button class="ghost-btn small" data-i="' + i + '">移除</button>';
      ul.appendChild(li);
    });
    ul.querySelectorAll('button[data-i]').forEach(b => { b.onclick = () => removePendingAt(parseInt(b.getAttribute('data-i'), 10)); });
    $('pendingCount').textContent = pendingSendQueue.length;
    $('sendPending').textContent = '🚀 选择目标发送 (' + pendingSendQueue.length + ')';
  }
  // “选择目标发送”：弹 chooser 让用户选人/广播，确认后批量入队发送并清空队列
  function sendPendingNow() {
    if (!pendingSendQueue.length) { toast('待发送为空'); return; }
    if (discoveredPeers.size === 0) { toast('还没有同伴加入房间，无法发送。请邀请同伴进入同一房间。'); return; }
    showPendingChooser();
  }
  function showPendingChooser() {
    const ul = $('chooserList');
    ul.innerHTML = '';
    for (const [id, name] of discoveredPeers) {
      const li = document.createElement('li');
      li.className = 'mode1';
      li.innerHTML = '<span class="pname">' + escapeHtml(name) + '</span><span class="hint">对方自动接收</span>';
      li.onclick = () => {
        $('peerChooser').classList.add('hidden');
        const files = pendingSendQueue.slice();
        clearPending();
        for (const f of files) enqueueSend(getPeer(id), f, true);
      };
      ul.appendChild(li);
    }
    $('peerChooser').classList.remove('hidden');
  }

  // 模式二：广播给房间所有人，由对方自行点接收
  function broadcastSend(files) {
    $('peerChooser').classList.add('hidden');
    for (const [id] of discoveredPeers) {
      for (const f of files) enqueueSend(getPeer(id), f, false);
    }
  }

  function newTransfer(p, file, auto) {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const t = { id, file, name: file.name, size: file.size, mime: file.type, offset: 0, done: false, failed: false, paused: false, pumping: false, auto: !!auto, _readyResolve: null, _doneResolve: null, _inQueue: false };
    p.outTransfers.set(id, t);
    addTransferUI(t, p, false);
    return t;
  }

  function enqueueSend(p, file, auto) {
    const t = newTransfer(p, file, auto);
    p.sendQueue.push(t);
    refreshQueueStatus(p);
    processQueue(p);
  }

  async function processQueue(p) {
    if (p._busy) return;
    p._busy = true;
    while (p.sendQueue.length) {
      const t = p.sendQueue.shift();
      p._currentTransfer = t;   // 标记当前正在发送，供 resumeOutgoing 排除，避免同一文件被重复排队
      refreshQueueStatus(p);
      try { await connectToPeer(p); await doSend(p, t); }
      catch (e) { t.failed = true; t.pumping = false; updateTransferUI(t, p, true); toast('发送失败: ' + e.message); }
      finally { p._currentTransfer = null; }
    }
    p._busy = false;
  }

  // 连接断开后，自动把未完成的发送重新入队恢复（排除正在发送中/已在队列里的，防止重复发送同一文件）
  function resumeOutgoing(p) {
    for (const t of p.outTransfers.values()) {
      if (!t.done && !t.failed && t.offset < t.size && t !== p._currentTransfer && !p.sendQueue.includes(t)) {
        t._inQueue = true;
        p.sendQueue.push(t);
      }
    }
    processQueue(p);
  }

  async function doSend(p, t) {
    t._inQueue = false;
    await waitFor(() => p.ctrl && p.ctrl.readyState === 'open');
    await waitFor(() => p.fileChannel && p.fileChannel.readyState === 'open');
    p.ctrl.send(JSON.stringify({ t: 'file-meta', id: t.id, name: t.file.name, size: t.file.size, mime: t.file.type, auto: t.auto }));
    try {
      await Promise.race([
        new Promise((res) => { t._readyResolve = res; }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('对方未响应')), READY_TIMEOUT))
      ]);
    } catch (e) {
      p.ctrl.send(JSON.stringify({ t: 'file-cancel', id: t.id }));
      throw e;
    }
    await pump(t, p);
  }

  async function pump(t, p) {
    t.pumping = true;
    const fc = p.fileChannel;
    p.ctrl.send(JSON.stringify({ t: 'file-start', id: t.id, offset: t.offset }));
    while (t.offset < t.size) {
      if (t.paused) { t.pumping = false; return; }
      if (fc.readyState !== 'open') { try { await waitFor(() => fc.readyState === 'open', 5000); } catch (e) { t.pumping = false; return; } }
      while (t.offset < t.size && fc.bufferedAmount < (1 << 20)) {
        const end = Math.min(t.offset + CHUNK, t.size);
        const buf = await t.file.slice(t.offset, end).arrayBuffer();
        fc.send(buf);
        t.offset = end;
        updateTransferUI(t, p, false);
      }
      if (t.offset >= t.size) break;
      await new Promise((res) => {
        fc.bufferedAmountLowThreshold = 1 << 18;
        fc.onbufferedamountlow = () => res();
        setTimeout(res, 400);
      });
    }
    if (t.offset >= t.size) {
      p.ctrl.send(JSON.stringify({ t: 'file-end', id: t.id }));
      await new Promise((res) => { t._doneResolve = res; });
      t.done = true; t.pumping = false;
      updateTransferUI(t, p, true);
    }
  }

  function pauseTransfer(t, p) { t.paused = true; updateTransferUI(t, p, false); }
  function resumeTransfer(t, p) {
    if (!t.paused) return;
    t.paused = false;
    if (!t.pumping && !t.done) pump(t, p);
  }
  function cancelTransfer(t, p) {
    t.paused = true; t.failed = true;
    if (p.ctrl && p.ctrl.readyState === 'open') p.ctrl.send(JSON.stringify({ t: 'file-cancel', id: t.id }));
    updateTransferUI(t, p, true);
  }

  // ---------------- 接收文件 ----------------
  async function onCtrlMessage(p, data) {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    switch (m.t) {
      case 'file-meta': {
        let dl = p.downloads.get(m.id);
        if (!dl) {
          dl = { id: m.id, name: m.name, size: m.size, mime: m.mime, received: 0, parts: [], writer: null, done: false, accepted: false, auto: !!m.auto };
          p.downloads.set(m.id, dl);
          showIncoming(dl, p);
        } else {
          dl.name = m.name; dl.size = m.size; dl.mime = m.mime; dl.auto = !!m.auto;
        }
        if (dl.accepted) p.ctrl.send(JSON.stringify({ t: 'file-ready', id: dl.id, offset: dl.received }));
        break;
      }
      case 'file-start': {
        const dl = p.downloads.get(m.id); if (!dl) break;
        dl.received = m.offset || 0;
        if (dl.writer && dl.received > 0) { try { await dl.writer.seek(dl.received); } catch (e) {} }
        p.currentDownload = dl;
        break;
      }
      case 'file-chunk-ack': break; // 未使用
      case 'file-end': {
        const dl = p.downloads.get(m.id); if (!dl) break;
        if (dl.done) break;   // 幂等：同一文件已被保存过，不再重复下载
        if (dl.writer) { try { await dl.writer.close(); } catch (e) {} }
        else { const blob = new Blob(dl.parts, { type: dl.mime || 'application/octet-stream' }); triggerDownload(blob, dl.name); }
        dl.done = true;
        p.currentDownload = null;
        p.ctrl.send(JSON.stringify({ t: 'file-done', id: m.id }));
        updateDownloadUI(dl, p, true);
        // 处理排队中的下一个下载
        if (p.pendingDownloads && p.pendingDownloads.length) {
          const next = p.pendingDownloads.shift();
          beginDownload(next.dl, p, next.li, next.dl.auto);
        }
        break;
      }
      case 'file-cancel': {
        const dl = p.downloads.get(m.id); if (dl) { dl.cancelled = true; updateDownloadUI(dl, p, true); }
        break;
      }
      case 'file-ready': {
        const t = p.outTransfers.get(m.id);
        if (t) { t.offset = m.offset || 0; if (t._readyResolve) { const r = t._readyResolve; t._readyResolve = null; r(); } }
        break;
      }
      case 'file-done': {
        const t = p.outTransfers.get(m.id);
        if (t) { t.done = true; t.pumping = false; if (t._doneResolve) { const r = t._doneResolve; t._doneResolve = null; r(); } updateTransferUI(t, p, true); }
        break;
      }
    }
  }

  async function onFileChunk(p, data) {
    const dl = p.currentDownload;
    if (!dl) return;
    const u = new Uint8Array(data);
    try {
      if (dl.writer) await dl.writer.write(u);
      else dl.parts.push(u);
      dl.received += u.byteLength;
      updateDownloadUI(dl, p, false);
    } catch (e) { /* 忽略单块写入错误 */ }
  }

  function showIncoming(dl, p) {
    const ul = $('transferList');
    const empty = ul.querySelector('.empty'); if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = 'transfer incoming';
    li.id = 'd-' + p.id + '-' + dl.id;
    if (dl.auto) {
      // 模式一：自动接收，无需手动确认
      li.innerHTML =
        '<div class="t-head"><span class="t-name">📥 ' + escapeHtml(dl.name) + ' (' + fmtSize(dl.size) + ')</span>' +
        '<span class="t-status">自动接收中…</span></div>' +
        '<div class="t-bar"><div class="t-fill"></div></div>' +
        '<div class="t-actions"><span class="auto-tag">自动接收</span><button class="ghost-btn decline">取消</button></div>';
      ul.appendChild(li);
      li.querySelector('.decline').onclick = () => {
        if (p.ctrl && p.ctrl.readyState === 'open') p.ctrl.send(JSON.stringify({ t: 'file-cancel', id: dl.id }));
        li.remove(); dl.cancelled = true;
      };
      autoAccept(dl, p, li);
    } else {
      // 模式二：等待接收方自行确认
      li.innerHTML =
        '<div class="t-head"><span class="t-name">📥 ' + escapeHtml(dl.name) + ' (' + fmtSize(dl.size) + ')</span>' +
        '<span class="t-status">等待接收</span></div>' +
        '<div class="t-bar"><div class="t-fill"></div></div>' +
        '<div class="t-actions"><button class="accept">接收</button><button class="ghost-btn decline">拒绝</button></div>';
      ul.appendChild(li);
      li.querySelector('.accept').onclick = () => acceptDownload(dl, p, li);
      li.querySelector('.decline').onclick = () => {
        if (p.ctrl && p.ctrl.readyState === 'open') p.ctrl.send(JSON.stringify({ t: 'file-cancel', id: dl.id }));
        li.remove(); dl.cancelled = true;
      };
    }
  }

  // 手动接收（模式二）：弹出保存位置选择（需用户手势）
  async function acceptDownload(dl, p, li) {
    await beginDownload(dl, p, li, false);
  }
  // 自动接收（模式一）：无需确认，直接开始
  async function autoAccept(dl, p, li) {
    await beginDownload(dl, p, li, true);
  }
  // 统一开始下载：auto=true 时不用 showSaveFilePicker（无手势），改为内存缓冲后自动触发下载
  async function beginDownload(dl, p, li, auto) {
    dl.accepted = true;
    if (auto) {
      dl.writer = null;
    } else {
      try { if (window.showSaveFilePicker) { const handle = await window.showSaveFilePicker({ suggestedName: dl.name }); dl.writer = await handle.createWritable(); } }
      catch (e) { dl.writer = null; }
    }
    if (p.currentDownload) {
      // 串行：当前有下载中任务，排队
      p.pendingDownloads.push({ dl, li });
      const st = li.querySelector('.t-status'); if (st) st.textContent = auto ? '排队中(自动)' : '排队中';
      const acts = li.querySelector('.t-actions'); if (acts) acts.remove();
      return;
    }
    activateDownload(dl, p, li);
  }

  function activateDownload(dl, p, li) {
    li.querySelector('.t-status').textContent = '接收中';
    const acts = li.querySelector('.t-actions'); if (acts) acts.remove();
    p.currentDownload = dl;
    p.ctrl.send(JSON.stringify({ t: 'file-ready', id: dl.id, offset: dl.received }));
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ---------------- 传输 UI ----------------
  function addTransferUI(t, p, isIncoming) {
    const ul = $('transferList');
    const empty = ul.querySelector('.empty'); if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = 'transfer';
    li.id = 't-' + p.id + '-' + t.id;
    li.innerHTML =
      '<div class="t-head"><span class="t-name">📤 ' + escapeHtml(t.name) + ' (' + fmtSize(t.size) + ')</span>' +
      '<span class="t-status">0%</span></div>' +
      '<div class="t-bar"><div class="t-fill"></div></div>' +
      '<div class="t-actions"><button class="ghost-btn pause">暂停</button><button class="ghost-btn cancel">取消</button></div>';
    ul.appendChild(li);
    const pauseBtn = li.querySelector('.pause');
    const cancelBtn = li.querySelector('.cancel');
    pauseBtn.onclick = () => {
      if (t.paused) { resumeTransfer(t, p); pauseBtn.textContent = '暂停'; }
      else { pauseTransfer(t, p); pauseBtn.textContent = '继续'; }
    };
    cancelBtn.onclick = () => cancelTransfer(t, p);
    updateTransferUI(t, p, false);
  }

  function updateTransferUI(t, p, final) {
    const li = document.getElementById('t-' + p.id + '-' + t.id);
    if (!li) return;
    const pct = t.size ? Math.floor((t.offset / t.size) * 100) : 100;
    li.querySelector('.t-fill').style.width = pct + '%';
    const st = li.querySelector('.t-status');
    if (t.failed) { li.classList.add('failed'); st.textContent = '已取消/失败'; }
    else if (final || t.done) { li.classList.add('done'); st.textContent = '完成 100%'; }
    else { st.textContent = pct + '% · ' + fmtSize(t.offset) + ' / ' + fmtSize(t.size); }
  }

  // 标记仍在队列中、尚未开始传输（未处于 pumping）的文件为“排队中”，让轮流过程可见
  function refreshQueueStatus(p) {
    for (const t of p.outTransfers.values()) {
      if (t.done || t.failed || t.pumping) continue;
      const li = document.getElementById('t-' + p.id + '-' + t.id);
      if (li) { const st = li.querySelector('.t-status'); if (st) st.textContent = '排队中'; }
    }
  }

  function updateDownloadUI(dl, p, final) {
    const li = document.getElementById('d-' + p.id + '-' + dl.id);
    if (!li) return;
    const pct = dl.size ? Math.floor((dl.received / dl.size) * 100) : 100;
    li.querySelector('.t-fill').style.width = pct + '%';
    const st = li.querySelector('.t-status');
    if (dl.cancelled) { li.classList.add('failed'); st.textContent = '已拒绝/取消'; }
    else if (final || dl.done) { li.classList.add('done'); st.textContent = '已保存 100%'; }
    else { st.textContent = pct + '% · ' + fmtSize(dl.received) + ' / ' + fmtSize(dl.size); }
  }

  // ---------------- 聊天室 ----------------
  function appendChat(name, text, self) {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'msg' + (self ? ' self' : '');
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;

    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = time;

    const body = document.createElement('span');
    body.className = 'text';
    body.textContent = text;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-msg';
    copyBtn.type = 'button';
    copyBtn.textContent = '复制';
    copyBtn.onclick = () => {
      const done = () => { copyBtn.textContent = '已复制'; setTimeout(() => { copyBtn.textContent = '复制'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => { fallbackCopy(text); done(); });
      } else { fallbackCopy(text); done(); }
    };

    div.appendChild(who);
    div.appendChild(t);
    div.appendChild(body);
    div.appendChild(copyBtn);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) { toast('复制失败'); }
  }
  function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    ws.send(JSON.stringify({ type: 'chat', text }));
    appendChat(myName + '(我)', text, true);
    input.value = '';
  }

  // ---------------- 启动 ----------------
  function join() {
    // 切换房间/重新进入：先断开旧连接并清理状态
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    peers.clear();
    discoveredPeers.clear();
    clearPending();
    renderPending();
    try { $('peerList').innerHTML = '<li class="empty">暂无其他设备，邀请同伴加入同一房间</li>'; } catch (e) {}
    try { $('transferList').innerHTML = '<li class="empty">暂无传输</li>'; } catch (e) {}
    myName = $('nameInput').value.trim() || '匿名';
    myRoom = $('roomInput').value.trim() || 'default';
    try { localStorage.setItem('wt_name', myName); localStorage.setItem('wt_room', myRoom); } catch (e) {}
    $('join').classList.add('hidden');
    $('main').classList.remove('hidden');
    $('roomLabel').textContent = myRoom;
    $('nameLabel').textContent = myName;
    connectWS();
  }

  // 已有名称时，刷新页面自动进入传输页；否则展示加入界面
  function maybeAutoJoin() {
    try {
      if (localStorage.getItem('wt_name')) join();
      else $('join').classList.remove('hidden');
    } catch (e) { $('join').classList.remove('hidden'); }
  }

  function prefill() {
    try {
      const n = localStorage.getItem('wt_name');
      if (n) $('nameInput').value = n;
      const r = localStorage.getItem('wt_room');
      if (r) $('roomInput').value = r;
    } catch (e) {}
  }

  function bind() {
    prefill();
    $('sendFileBtn').onclick = addPendingFilesFlow;
    $('chooserBroadcast').onclick = () => {
      if (pendingSendQueue.length) {
        $('peerChooser').classList.add('hidden');
        const f = pendingSendQueue.slice();
        clearPending();
        broadcastSend(f);
      } else { $('peerChooser').classList.add('hidden'); }
    };
    $('chooserCancel').onclick = () => $('peerChooser').classList.add('hidden');
    $('clearPending').onclick = clearPending;
    $('sendPending').onclick = sendPendingNow;
    renderPending();
    $('joinBtn').onclick = join;
    // 输入时实时记忆，刷新/重开页面免重复输入
    $('nameInput').addEventListener('input', () => { try { localStorage.setItem('wt_name', $('nameInput').value.trim()); } catch (e) {} });
    $('roomInput').addEventListener('input', () => { try { localStorage.setItem('wt_room', $('roomInput').value.trim()); } catch (e) {} });
    $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    $('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    $('sendChat').onclick = sendChat;
    $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    $('copyLink').onclick = () => {
      navigator.clipboard.writeText(location.href).then(() => toast('邀请链接已复制')).catch(() => toast('复制失败，请手动复制地址栏'));
    };
    $('leaveBtn').onclick = () => { if (ws) ws.close(); location.reload(); };
    // 页内「配置」：回到加入界面修改名称/房间，点「进入房间」即用新配置重连
    $('configBtn').onclick = () => {
      $('nameInput').value = myName;
      $('roomInput').value = myRoom;
      $('main').classList.add('hidden');
      $('join').classList.remove('hidden');
    };
    maybeAutoJoin();
  }

  bind();
})();
