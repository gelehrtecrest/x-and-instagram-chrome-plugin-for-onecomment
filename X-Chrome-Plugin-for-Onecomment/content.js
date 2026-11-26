(() => {
  'use strict';

  if (globalThis.__X_LIVE_ONECOMME_CONTENT_LOADED__) return;
  globalThis.__X_LIVE_ONECOMME_CONTENT_LOADED__ = true;

  const Selectors = globalThis.XLiveSelectors;
  if (!Selectors) return;

  const HOOK_SOURCE = 'x-live-onecomme-hook';
  const CONTENT_SOURCE = 'x-live-onecomme-content';

  const DEFAULT_SETTINGS = {
    enabled: true,
    nameFormat: 'display',
    skipInitialComments: true,
    batchIntervalMs: 300,
    customSelectors: {
      container: '',
      item: '',
      author: '',
      message: '',
    },
  };

  let settings = { ...DEFAULT_SETTINGS, customSelectors: { ...DEFAULT_SETTINGS.customSelectors } };
  let activeContainer = null;
  let activeContainerSelector = '';
  let observer = null;
  let rescanTimer = null;
  let flushTimer = null;
  let lastUrl = location.href;

  // WebSocketフックの状態
  let hookAlive = false;
  let wsConnected = false;
  let wsLastMessageAt = 0;
  let wsSeenUrls = [];

  const seenOrder = [];
  const seenSet = new Set();
  const recentContentMap = new Map();
  const MAX_SEEN = 1000;
  const CONTENT_DEDUP_WINDOW_MS = 15000;
  const pendingComments = [];

  function rememberComment(parsed) {
    if (!parsed || !parsed.id) return false;
    if (seenSet.has(parsed.id)) return false;

    // WS と DOM の両方で同一コメントを検知した場合の二重送信を防止
    const now = Date.now();
    const contentKey = `${String(parsed.userId || '').toLowerCase()}|${parsed.comment}`;
    const prevTs = recentContentMap.get(contentKey);
    if (prevTs && now - prevTs < CONTENT_DEDUP_WINDOW_MS) {
      return false;
    }

    seenSet.add(parsed.id);
    seenOrder.push(parsed.id);
    while (seenOrder.length > MAX_SEEN) {
      const oldest = seenOrder.shift();
      seenSet.delete(oldest);
    }

    recentContentMap.set(contentKey, now);
    if (recentContentMap.size > MAX_SEEN) {
      for (const [key, ts] of recentContentMap.entries()) {
        if (now - ts >= CONTENT_DEDUP_WINDOW_MS) {
          recentContentMap.delete(key);
        }
      }
    }
    return true;
  }

  function flushPending() {
    flushTimer = null;
    if (!settings.enabled || pendingComments.length === 0) {
      pendingComments.length = 0;
      return;
    }

    const batch = pendingComments.splice(0, 20);
    chrome.runtime
      .sendMessage({
        type: 'SEND_COMMENTS',
        payload: {
          platform: 'x',
          sourceType: 'live',
          sourceUrl: location.href,
          comments: batch,
        },
      })
      .catch(() => {
        // 拡張機能リロード直後などは無視
      });

    if (pendingComments.length > 0) {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    const delay = Math.max(100, Math.min(2000, Number(settings.batchIntervalMs) || 300));
    flushTimer = setTimeout(flushPending, delay);
  }

  function enqueueParsedComment(parsed, { initialSeed = false } = {}) {
    if (!parsed) return false;
    const isNew = rememberComment(parsed);
    if (!isNew) return false;
    if (initialSeed && settings.skipInitialComments) return false;
    if (!settings.enabled) return false;

    pendingComments.push(parsed);
    scheduleFlush();
    return true;
  }

  function processElement(el, { initialSeed = false } = {}) {
    if (!el || el.nodeType !== 1) return false;

    const parsed = Selectors.parseChatMessageElement(el, {
      nameFormat: settings.nameFormat,
      customSelectors: settings.customSelectors,
    });
    if (!parsed) return false;

    return enqueueParsedComment(parsed, { initialSeed });
  }

  function handleAddedNode(node) {
    if (!node || node.nodeType !== 1) return;
    const customItem = settings.customSelectors && settings.customSelectors.item;
    const nested = Selectors.findMessageElements(node, customItem);

    // node自体がメッセージ行か、子孫にメッセージ行を持つか判定
    if (nested.length > 0 && nested[0] !== node) {
      let parsedAny = false;
      for (const child of nested) {
        if (processElement(child)) parsedAny = true;
      }
      if (parsedAny) return;
    }

    processElement(node);
  }

  function detachObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    activeContainer = null;
    activeContainerSelector = '';
  }

  function attachToContainer(container, selector) {
    detachObserver();
    activeContainer = container;
    activeContainerSelector = selector;

    const customItem = settings.customSelectors && settings.customSelectors.item;
    const existing = Selectors.findMessageElements(container, customItem);
    for (const el of existing) {
      processElement(el, { initialSeed: true });
    }

    observer = new MutationObserver((mutations) => {
      if (!settings.enabled) return;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          handleAddedNode(node);
        }
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
    });
  }

  function pingPageHook() {
    try {
      window.postMessage({ source: CONTENT_SOURCE, type: 'PING' }, '*');
    } catch {
      // ignore
    }
  }

  function checkAndAttach() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detachObserver();
    }

    if (!Selectors.isXLivePage(location.href)) {
      if (activeContainer) detachObserver();
      return;
    }

    pingPageHook();

    if (activeContainer && document.contains(activeContainer)) {
      return;
    }

    const customContainer = settings.customSelectors && settings.customSelectors.container;
    const found = Selectors.findChatContainer(document, customContainer, location.href);
    if (found.element) {
      attachToContainer(found.element, found.selector);
    }
  }

  function applySettings(stored) {
    if (!stored || typeof stored !== 'object') return;
    const prevContainerCustom = settings.customSelectors.container;
    settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      customSelectors: {
        ...DEFAULT_SETTINGS.customSelectors,
        ...(stored.customSelectors || {}),
      },
    };
    if (prevContainerCustom !== settings.customSelectors.container) {
      detachObserver();
      checkAndAttach();
    }
  }

  // MAIN world (page_hook.js) からの WebSocket チャットイベントを受信
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== HOOK_SOURCE) return;

    const { type, payload } = event.data;
    if (type === 'WS_STATUS') {
      hookAlive = true;
      wsConnected = Boolean(payload && payload.connected);
      if (payload && Array.isArray(payload.seenUrls)) {
        wsSeenUrls = payload.seenUrls;
      }
      return;
    }
    if (type === 'WS_MESSAGE' && payload && payload.data) {
      hookAlive = true;
      wsConnected = true;
      wsLastMessageAt = Date.now();
      if (!Selectors.isXLivePage(location.href)) return;
      const parsed = Selectors.parseChatmanPayload(payload.data, {
        nameFormat: settings.nameFormat,
      });
      if (parsed) {
        enqueueParsedComment(parsed, { initialSeed: false });
      }
    }
  });

  chrome.storage.local.get('settings', (result) => {
    if (result && result.settings) {
      applySettings(result.settings);
    }
    checkAndAttach();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.settings && changes.settings.newValue) {
      applySettings(changes.settings.newValue);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'GET_TAB_STATUS') {
      pingPageHook();
      const domFound = Boolean(activeContainer && document.contains(activeContainer));
      const wsActive = wsConnected || (wsLastMessageAt > 0 && Date.now() - wsLastMessageAt < 60000);
      sendResponse({
        url: location.href,
        isLivePage: Selectors.isXLivePage(location.href),
        containerFound: domFound || wsActive,
        domFound,
        wsConnected: wsActive,
        hookAlive,
        wsSeenUrls,
        containerSelector: activeContainerSelector,
        enabled: settings.enabled,
      });
      return true;
    }
    return false;
  });

  rescanTimer = setInterval(checkAndAttach, 2000);
  window.addEventListener('beforeunload', () => {
    if (rescanTimer) clearInterval(rescanTimer);
    if (flushTimer) clearTimeout(flushTimer);
    detachObserver();
  });
})();
