(() => {
  'use strict';

  if (window.__X_LIVE_ONECOMME_HOOKED__) return;
  window.__X_LIVE_ONECOMME_HOOKED__ = true;

  const HOOK_SOURCE = 'x-live-onecomme-hook';
  const CONTENT_SOURCE = 'x-live-onecomme-content';
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return;

  const activeChatSockets = new Set();
  const seenWsUrls = [];

  function sanitizeWsUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return String(url || '').slice(0, 120);
    }
  }

  function recordSeenUrl(url) {
    const clean = sanitizeWsUrl(url);
    if (!clean || seenWsUrls.includes(clean)) return;
    seenWsUrls.push(clean);
    if (seenWsUrls.length > 5) {
      seenWsUrls.shift();
    }
  }

  function isChatSocketUrl(url) {
    if (typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return (
      lower.includes('/chatapi/v1/chatnow') ||
      lower.includes('/chatapi/') ||
      lower.includes('chatman') ||
      lower.includes('chatnow') ||
      lower.includes('pscp.tv') ||
      lower.includes('periscope.tv')
    );
  }

  function postHookMessage(type, payload) {
    try {
      window.postMessage(
        {
          source: HOOK_SOURCE,
          type,
          payload: payload || {},
        },
        '*'
      );
    } catch {
      // ignore postMessage errors
    }
  }

  function postStatus(extra = {}) {
    postHookMessage('WS_STATUS', {
      alive: true,
      connected: activeChatSockets.size > 0,
      activeCount: activeChatSockets.size,
      seenUrls: [...seenWsUrls],
      ...extra,
    });
  }

  function handleIncomingData(url, data) {
    if (typeof data === 'string') {
      postHookMessage('WS_MESSAGE', { url, data });
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data
        .text()
        .then((text) => postHookMessage('WS_MESSAGE', { url, data: text }))
        .catch(() => {});
      return;
    }
    if (data instanceof ArrayBuffer) {
      try {
        const text = new TextDecoder('utf-8').decode(data);
        postHookMessage('WS_MESSAGE', { url, data: text });
      } catch {
        // ignore decode error
      }
    }
  }

  function PatchedWebSocket(url, protocols) {
    const ws =
      protocols !== undefined
        ? new NativeWebSocket(url, protocols)
        : new NativeWebSocket(url);

    const urlStr = typeof url === 'string' ? url : String(url || '');
    recordSeenUrl(urlStr);

    if (isChatSocketUrl(urlStr)) {
      const markOpen = () => {
        activeChatSockets.add(ws);
        postStatus({ url: sanitizeWsUrl(urlStr) });
      };

      const markClosed = () => {
        activeChatSockets.delete(ws);
        postStatus({ url: sanitizeWsUrl(urlStr) });
      };

      ws.addEventListener('open', markOpen);
      ws.addEventListener('close', markClosed);
      ws.addEventListener('error', markClosed);
      ws.addEventListener('message', (event) => {
        if (!activeChatSockets.has(ws)) {
          markOpen();
        }
        handleIncomingData(urlStr, event.data);
      });
    } else {
      postStatus();
    }

    return ws;
  }

  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  PatchedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = NativeWebSocket.OPEN;
  PatchedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = NativeWebSocket.CLOSED;
  try {
    Object.setPrototypeOf(PatchedWebSocket, NativeWebSocket);
  } catch {
    // ignore
  }

  window.WebSocket = PatchedWebSocket;

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === CONTENT_SOURCE && event.data.type === 'PING') {
      postStatus();
    }
  });

  postStatus();
})();
