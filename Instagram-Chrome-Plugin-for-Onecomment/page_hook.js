(() => {
  'use strict';

  if (window.__IG_LIVE_ONECOMME_HOOKED__) return;
  window.__IG_LIVE_ONECOMME_HOOKED__ = true;

  const HOOK_SOURCE = 'ig-live-onecomme-hook';
  const CONTENT_SOURCE = 'ig-live-onecomme-content';
  const MAX_PAYLOAD_LEN = 512 * 1024;

  const NativeWebSocket = window.WebSocket;
  const NativeFetch = window.fetch;
  const NativeXhrOpen = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype.open : null;
  const NativeXhrSend = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype.send : null;

  const seenWsUrls = [];
  const seenNetUrls = [];
  let pollFetchCount = 0;
  let postCommentCount = 0;

  function sanitizeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return String(url || '').slice(0, 140);
    }
  }

  function pushUniqueLimited(list, value, limit) {
    if (!value || list.includes(value)) return;
    list.push(value);
    if (list.length > limit) list.shift();
  }

  function isInterestingNetUrl(url) {
    if (typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (
      lower.includes('.m4s') ||
      lower.includes('.mp4') ||
      lower.includes('.ts') ||
      lower.includes('.m3u8') ||
      lower.includes('.mpd') ||
      lower.includes('.jpg') ||
      lower.includes('.jpeg') ||
      lower.includes('.png') ||
      lower.includes('.webp') ||
      lower.includes('/logging_client_events')
    ) {
      return false;
    }
    return (
      lower.includes('/api/v1/live/') ||
      lower.includes('get_comment') ||
      lower.includes('heartbeat_and_get_viewer_count') ||
      lower.includes('broadcast') ||
      lower.includes('/graphql')
    );
  }

  function classifyLiveCommentUrl(url) {
    if (typeof url !== 'string') return '';
    const lower = url.toLowerCase();
    if (lower.includes('/api/v1/live/') && lower.includes('/get_comment')) {
      return 'poll';
    }
    if (lower.includes('/api/v1/live/') && /\/comment\/?(?:\?|$)/.test(lower)) {
      return 'post';
    }
    if (lower.includes('/graphql')) {
      return 'graphql';
    }
    return '';
  }

  function looksLikeGraphqlLiveComments(text) {
    if (typeof text !== 'string' || text.length < 20 || text.length > MAX_PAYLOAD_LEN) return false;
    const hasCommentKey =
      text.includes('"system_comments"') ||
      text.includes('"live_comments"') ||
      text.includes('"broadcast_comments"') ||
      (text.includes('"comments"') && (text.includes('"broadcast"') || text.includes('"created_at_utc"')));
    return hasCommentKey && text.includes('"username"');
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
    postHookMessage('HOOK_STATUS', {
      alive: true,
      pollFetchCount,
      postCommentCount,
      seenUrls: [...seenWsUrls],
      seenNetUrls: [...seenNetUrls],
      ...extra,
    });
  }

  function handleResponseText(urlStr, kind, text) {
    if (typeof text !== 'string' || !text || text.length > MAX_PAYLOAD_LEN) return;

    if (kind === 'graphql') {
      if (!looksLikeGraphqlLiveComments(text)) return;
      pollFetchCount += 1;
      postHookMessage('LIVE_COMMENTS', {
        url: sanitizeUrl(urlStr),
        kind: 'poll',
        fetchIndex: pollFetchCount,
        data: text,
      });
      postStatus();
      return;
    }

    if (kind === 'poll') {
      pollFetchCount += 1;
      postHookMessage('LIVE_COMMENTS', {
        url: sanitizeUrl(urlStr),
        kind: 'poll',
        fetchIndex: pollFetchCount,
        data: text,
      });
      postStatus();
      return;
    }

    if (kind === 'post') {
      postCommentCount += 1;
      postHookMessage('LIVE_COMMENTS', {
        url: sanitizeUrl(urlStr),
        kind: 'post',
        fetchIndex: postCommentCount,
        data: text,
      });
      postStatus();
    }
  }

  // 1. WebSocket フック（診断用URL記録）
  if (typeof NativeWebSocket === 'function') {
    function PatchedWebSocket(url, protocols) {
      const ws =
        protocols !== undefined
          ? new NativeWebSocket(url, protocols)
          : new NativeWebSocket(url);

      const urlStr = typeof url === 'string' ? url : String(url || '');
      pushUniqueLimited(seenWsUrls, sanitizeUrl(urlStr), 8);
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

  // 2. fetch フック（Instagram Live コメント取得・投稿APIを捕捉）
  if (typeof NativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const urlStr =
        typeof input === 'string'
          ? input
          : input && typeof input.url === 'string'
            ? input.url
            : '';

      if (isInterestingNetUrl(urlStr)) {
        pushUniqueLimited(seenNetUrls, sanitizeUrl(urlStr), 15);
      }

      const kind = classifyLiveCommentUrl(urlStr);
      const promise = NativeFetch.apply(this, arguments);

      if (kind) {
        promise
          .then((response) => {
            if (!response || !response.ok) return;
            response
              .clone()
              .text()
              .then((text) => handleResponseText(urlStr, kind, text))
              .catch(() => {});
          })
          .catch(() => {});
      }

      return promise;
    };
  }

  // 3. XMLHttpRequest フック（XHR経由のライブコメントAPIも捕捉）
  if (typeof NativeXhrOpen === 'function' && typeof NativeXhrSend === 'function') {
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__igLiveHookUrl = typeof url === 'string' ? url : String(url || '');
      return NativeXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend() {
      const urlStr = this.__igLiveHookUrl || '';
      if (isInterestingNetUrl(urlStr)) {
        pushUniqueLimited(seenNetUrls, sanitizeUrl(urlStr), 15);
      }
      const kind = classifyLiveCommentUrl(urlStr);
      if (kind) {
        this.addEventListener('load', () => {
          try {
            if (this.status >= 200 && this.status < 300 && typeof this.responseText === 'string') {
              handleResponseText(urlStr, kind, this.responseText);
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
    }
  });

  postStatus();
})();
