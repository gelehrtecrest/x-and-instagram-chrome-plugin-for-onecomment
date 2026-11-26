(() => {
  'use strict';

  if (window.__X_LIVE_ONECOMME_HOOKED__) return;
  window.__X_LIVE_ONECOMME_HOOKED__ = true;

  const HOOK_SOURCE = 'x-live-onecomme-hook';
  const CONTENT_SOURCE = 'x-live-onecomme-content';
  const MAX_PAYLOAD_LEN = 128 * 1024;

  const NativeWebSocket = window.WebSocket;
  const NativeEventSource = typeof window.EventSource === 'function' ? window.EventSource : null;
  const NativeFetch = window.fetch;
  const NativeXhrOpen = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype.open : null;
  const NativeXhrSend = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype.send : null;

  const activeChatSockets = new Set();
  const seenWsUrls = [];
  const seenEventSourceUrls = [];
  const seenChatNetUrls = [];
  let historyFetchCount = 0;

  function sanitizeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return String(url || '').slice(0, 120);
    }
  }

  function pushUniqueLimited(list, value, limit) {
    if (!value || list.includes(value)) return;
    list.push(value);
    if (list.length > limit) list.shift();
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

  function isInterestingNetUrl(url) {
    if (typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (
      lower.includes('.ts') ||
      lower.includes('.m3u8') ||
      lower.includes('.m4s') ||
      lower.includes('.mp4') ||
      lower.includes('.jpg') ||
      lower.includes('.jpeg') ||
      lower.includes('.png') ||
      lower.includes('.webp') ||
      lower.includes('.svg') ||
      lower.includes('/transcoding/') ||
      lower.includes('client_event') ||
      lower.includes('/jot/') ||
      lower.includes('ces/p2')
    ) {
      return false;
    }
    return (
      lower.includes('/chatapi/') ||
      lower.includes('chatman') ||
      lower.includes('pscp.tv') ||
      lower.includes('periscope') ||
      lower.includes('broadcast') ||
      lower.includes('live_video_stream') ||
      lower.includes('live_pipeline') ||
      lower.includes('/i/api/graphql/') ||
      lower.includes('/chat') ||
      lower.includes('message')
    );
  }

  function isHistoryApiUrl(url) {
    if (typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return lower.includes('/chatapi/v1/history') || (lower.includes('/chatapi/') && lower.includes('history'));
  }

  function looksLikeChatmanText(text) {
    if (typeof text !== 'string' || text.length < 10 || text.length > MAX_PAYLOAD_LEN) return false;
    return (
      text.includes('"payload"') &&
      (text.includes('"kind"') || text.includes('"body"') || text.includes('"sender"') || text.includes('"displayName"'))
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
      historyFetchCount,
      seenUrls: [...seenWsUrls],
      seenEventSourceUrls: [...seenEventSourceUrls],
      seenNetUrls: [...seenChatNetUrls],
      ...extra,
    });
  }

  function handleHistoryResponseText(urlStr, text) {
    if (!text || text.length > MAX_PAYLOAD_LEN * 4) return;
    historyFetchCount += 1;
    postHookMessage('CHAT_HISTORY', {
      url: sanitizeUrl(urlStr),
      fetchIndex: historyFetchCount,
      data: text,
    });
    postStatus();
  }

  function forwardWsData(url, data, direction, isKnownChatSocket, markOpen) {
    const emitText = (text) => {
      if (typeof text !== 'string' || text.length > MAX_PAYLOAD_LEN) return;
      if (!isKnownChatSocket && !looksLikeChatmanText(text)) return;
      if (markOpen) markOpen();
      postHookMessage('WS_MESSAGE', {
        url: sanitizeUrl(url),
        direction,
        data: text,
      });
    };

    if (typeof data === 'string') {
      emitText(data);
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.text().then(emitText).catch(() => {});
      return;
    }
    if (data instanceof ArrayBuffer) {
      try {
        emitText(new TextDecoder('utf-8').decode(data));
      } catch {
        // ignore decode error
      }
    }
  }

  // 1. WebSocket フック（送受信両方）
  if (typeof NativeWebSocket === 'function') {
    function PatchedWebSocket(url, protocols) {
      const ws =
        protocols !== undefined
          ? new NativeWebSocket(url, protocols)
          : new NativeWebSocket(url);

      const urlStr = typeof url === 'string' ? url : String(url || '');
      pushUniqueLimited(seenWsUrls, sanitizeUrl(urlStr), 8);

      let knownChat = isChatSocketUrl(urlStr);

      const markOpen = () => {
        knownChat = true;
        const before = activeChatSockets.size;
        activeChatSockets.add(ws);
        if (activeChatSockets.size !== before) {
          postStatus({ url: sanitizeUrl(urlStr) });
        }
      };

      const markClosed = () => {
        if (activeChatSockets.delete(ws)) {
          postStatus({ url: sanitizeUrl(urlStr) });
        }
      };

      if (knownChat) {
        ws.addEventListener('open', markOpen);
      }
      ws.addEventListener('close', markClosed);
      ws.addEventListener('error', markClosed);
      ws.addEventListener('message', (event) => {
        forwardWsData(urlStr, event.data, 'in', knownChat, markOpen);
      });

      const origSend = ws.send;
      if (typeof origSend === 'function') {
        ws.send = function patchedSend(data) {
          try {
            forwardWsData(urlStr, data, 'out', knownChat, markOpen);
          } catch {
            // ignore
          }
          return origSend.apply(this, arguments);
        };
      }

      postStatus();
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
  }

  // 1.5. EventSource (SSE) フック
  if (typeof NativeEventSource === 'function') {
    function PatchedEventSource(url, eventSourceInitDict) {
      const es =
        eventSourceInitDict !== undefined
          ? new NativeEventSource(url, eventSourceInitDict)
          : new NativeEventSource(url);
      const urlStr = typeof url === 'string' ? url : String(url || '');
      pushUniqueLimited(seenEventSourceUrls, sanitizeUrl(urlStr), 8);
      es.addEventListener('message', (event) => {
        if (typeof event.data === 'string' && looksLikeChatmanText(event.data)) {
          postHookMessage('WS_MESSAGE', {
            url: sanitizeUrl(urlStr),
            direction: 'sse',
            data: event.data,
          });
        }
      });
      postStatus();
      return es;
    }
    PatchedEventSource.prototype = NativeEventSource.prototype;
    PatchedEventSource.CONNECTING = NativeEventSource.CONNECTING;
    PatchedEventSource.OPEN = NativeEventSource.OPEN;
    PatchedEventSource.CLOSED = NativeEventSource.CLOSED;
    try {
      Object.setPrototypeOf(PatchedEventSource, NativeEventSource);
    } catch {
      // ignore
    }
    window.EventSource = PatchedEventSource;
  }

  // 2. fetch フック
  if (typeof NativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const urlStr =
        typeof input === 'string'
          ? input
          : input && typeof input.url === 'string'
            ? input.url
            : '';

      if (isInterestingNetUrl(urlStr)) {
        pushUniqueLimited(seenChatNetUrls, sanitizeUrl(urlStr), 25);
      }

      const promise = NativeFetch.apply(this, arguments);

      if (isHistoryApiUrl(urlStr)) {
        promise
          .then((response) => {
            if (!response || !response.ok) return;
            response
              .clone()
              .text()
              .then((text) => handleHistoryResponseText(urlStr, text))
              .catch(() => {});
          })
          .catch(() => {});
      }

      return promise;
    };
  }

  // 3. XMLHttpRequest フック（XHR経由のチャット履歴・配信通信も捕捉）
  if (typeof NativeXhrOpen === 'function' && typeof NativeXhrSend === 'function') {
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__xLiveHookUrl = typeof url === 'string' ? url : String(url || '');
      return NativeXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend() {
      const urlStr = this.__xLiveHookUrl || '';
      if (isInterestingNetUrl(urlStr)) {
        pushUniqueLimited(seenChatNetUrls, sanitizeUrl(urlStr), 25);
      }
      if (isHistoryApiUrl(urlStr)) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300 && typeof this.responseText === 'string') {
              handleHistoryResponseText(urlStr, this.responseText);
            }
          } catch {
            // ignore
          }
        });
      }
      return NativeXhrSend.apply(this, arguments);
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === CONTENT_SOURCE && event.data.type === 'PING') {
      postStatus();
    } else if (event.data.source === CONTENT_SOURCE && event.data.type === 'RESET_NAV') {
      historyFetchCount = 0;
      postStatus();
    }
  });

  postStatus();
})();
