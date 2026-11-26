(() => {
  'use strict';

  if (globalThis.__IG_LIVE_ONECOMME_CONTENT_LOADED__) return;
  globalThis.__IG_LIVE_ONECOMME_CONTENT_LOADED__ = true;

  const Selectors = globalThis.InstagramLiveSelectors;
  if (!Selectors) return;

  const HOOK_SOURCE = 'ig-live-onecomme-hook';
  const CONTENT_SOURCE = 'ig-live-onecomme-content';

  const DEFAULT_SETTINGS = {
    enabled: true,
    skipSystemMessages: true,
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

  // MAIN world (page_hook.js) のAPIフック状態
  let hookAlive = false;
  let pollFetchCount = 0;
  let postCommentCount = 0;
  let apiLastPollAt = 0;
  let apiCommentCount = 0;
  let wsSeenUrls = [];
  let seenNetUrls = [];

  const seenOrder = [];
  const seenSet = new Set();
  const recentContentMap = new Map();
  const MAX_SEEN = 1000;
  const CONTENT_DEDUP_WINDOW_MS = 30000;
  const pendingComments = [];

  function rememberComment(parsed) {
    if (!parsed || !parsed.id) return false;
    if (seenSet.has(parsed.id)) return false;

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

  let disposed = false;

  function isExtensionContextValid() {
    try {
      return !disposed && typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    if (rescanTimer) {
      clearInterval(rescanTimer);
      rescanTimer = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingComments.length = 0;
    detachObserver();
    window.removeEventListener('message', onWindowMessage);
  }

  function flushPending() {
    flushTimer = null;
    if (!isExtensionContextValid()) {
      cleanup();
      return;
    }
    if (!settings.enabled || pendingComments.length === 0) {
      pendingComments.length = 0;
      return;
    }

    const batch = pendingComments.splice(0, 20);
    try {
      const maybePromise = chrome.runtime.sendMessage({
        type: 'SEND_COMMENTS',
        payload: {
          platform: 'instagram',
          sourceType: 'live',
          sourceUrl: location.href,
          comments: batch,
        },
      });
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
          // 拡張機能リロード直後などは無視
        });
      }
    } catch {
      cleanup();
      return;
    }

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
    if (parsed.isSystem && settings.skipSystemMessages) {
      return false;
    }
    const isNew = rememberComment(parsed);
    if (!isNew) return false;
    if (initialSeed && settings.skipInitialComments) return false;
    if (!settings.enabled) return false;

    pendingComments.push(parsed);
    scheduleFlush();
    return true;
  }

  function isApiPrimaryActive() {
    return pollFetchCount > 0 && apiLastPollAt > 0 && Date.now() - apiLastPollAt < 60000;
  }

  function processElement(el, { initialSeed = false } = {}) {
    if (!el || el.nodeType !== 1) return false;

    // APIポーリング（get_comment）が稼働しており、かつヒューリスティック検出コンテナの場合はDOM側の誤爆を抑制
    const hasCustomContainer = Boolean(settings.customSelectors && settings.customSelectors.container);
    if (!initialSeed && isApiPrimaryActive() && !hasCustomContainer && activeContainerSelector.startsWith('heuristic:')) {
      return false;
    }

    const parsed = Selectors.parseLiveCommentElement(el, {
      customSelectors: settings.customSelectors,
    });
    if (!parsed) return false;

    return enqueueParsedComment(parsed, { initialSeed });
  }

  function handleAddedNode(node) {
    if (!node || node.nodeType !== 1) return;

    // コンテナ直下の1コメント行が追加された場合は、内部divへ分解する前に行全体を優先パースする
    if (activeContainer && node.parentElement === activeContainer) {
      if (processElement(node)) return;
    }

    const customItem = settings.customSelectors && settings.customSelectors.item;
    const nested = Selectors.findMessageElements(node, customItem);

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
    if (!isExtensionContextValid()) {
      cleanup();
      return;
    }

    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detachObserver();
    }

    if (!Selectors.isInstagramLivePage(location.href)) {
      if (activeContainer) detachObserver();
      return;
    }

    pingPageHook();

    if (activeContainer && document.contains(activeContainer)) {
      return;
    }

    const customContainer = settings.customSelectors && settings.customSelectors.container;
    const found = Selectors.findChatContainer(document, customContainer);
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

  // MAIN world (page_hook.js) からの API 通信イベントを受信
  function onWindowMessage(event) {
    if (!isExtensionContextValid()) {
      cleanup();
      return;
    }
    if (event.source !== window || !event.data) return;
    if (event.data.source !== HOOK_SOURCE) return;

    const { type, payload } = event.data;
    if (type === 'HOOK_STATUS') {
      hookAlive = true;
      if (payload && typeof payload.pollFetchCount === 'number') {
        pollFetchCount = payload.pollFetchCount;
      }
      if (payload && typeof payload.postCommentCount === 'number') {
        postCommentCount = payload.postCommentCount;
      }
      if (payload && Array.isArray(payload.seenUrls)) {
        wsSeenUrls = payload.seenUrls;
      }
      if (payload && Array.isArray(payload.seenNetUrls)) {
        seenNetUrls = payload.seenNetUrls;
      }
      return;
    }

    if (type === 'LIVE_COMMENTS' && payload && payload.data) {
      hookAlive = true;
      if (payload.kind === 'poll') {
        pollFetchCount = Number(payload.fetchIndex) || pollFetchCount + 1;
        apiLastPollAt = Date.now();
      } else if (payload.kind === 'post') {
        postCommentCount = Number(payload.fetchIndex) || postCommentCount + 1;
      }

      if (!Selectors.isInstagramLivePage(location.href)) return;
      const items = Selectors.parseLiveCommentsApiResponse(payload.data);
      const isInitialPoll = payload.kind === 'poll' && pollFetchCount <= 1;
      for (const item of items) {
        apiCommentCount += 1;
        enqueueParsedComment(item, { initialSeed: isInitialPoll });
      }
    }
  }

  window.addEventListener('message', onWindowMessage);

  if (isExtensionContextValid()) {
    try {
      chrome.storage.local.get('settings', (result) => {
        if (!isExtensionContextValid()) {
          cleanup();
          return;
        }
        if (result && result.settings) {
          applySettings(result.settings);
        }
        checkAndAttach();
      });

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (!isExtensionContextValid()) {
          cleanup();
          return;
        }
        if (areaName === 'local' && changes.settings && changes.settings.newValue) {
          applySettings(changes.settings.newValue);
        }
      });

      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message && message.type === 'GET_TAB_STATUS') {
          try {
            pingPageHook();
            const domFound = Boolean(activeContainer && document.contains(activeContainer));
            const apiActive = isApiPrimaryActive();
            sendResponse({
              url: location.href,
              isLivePage: Selectors.isInstagramLivePage(location.href),
              containerFound: domFound || apiActive || pollFetchCount > 0,
              domFound,
              apiActive,
              hookAlive,
              pollFetchCount,
              postCommentCount,
              apiCommentCount,
              wsSeenUrls,
              seenNetUrls,
              containerSelector: activeContainerSelector,
              enabled: settings.enabled,
            });
          } catch (err) {
            sendResponse({
              url: location.href,
              error: (err && (err.stack || err.message)) || String(err),
            });
          }
          return true;
        }
        if (message && message.type === 'GET_DIAGNOSTICS') {
          try {
            pingPageHook();
            const domFound = Boolean(activeContainer && document.contains(activeContainer));
            let domDiag = {};
            try {
              domDiag =
                typeof Selectors.collectDomDiagnostics === 'function'
                  ? Selectors.collectDomDiagnostics(document)
                  : { note: 'collectDomDiagnostics unavailable' };
            } catch (diagErr) {
              domDiag = {
                error: (diagErr && (diagErr.stack || diagErr.message)) || String(diagErr),
              };
            }
            sendResponse({
              url: location.href,
              isLivePage: Selectors.isInstagramLivePage(location.href),
              hookAlive,
              apiActive: isApiPrimaryActive(),
              pollFetchCount,
              postCommentCount,
              apiCommentCount,
              wsSeenUrls,
              seenNetUrls,
              domFound,
              containerSelector: activeContainerSelector,
              domDiag,
            });
          } catch (err) {
            sendResponse({
              url: location.href,
              error: (err && (err.stack || err.message)) || String(err),
            });
          }
          return true;
        }
        return false;
      });
    } catch {
      cleanup();
    }
  }

  rescanTimer = setInterval(checkAndAttach, 2000);
  window.addEventListener('beforeunload', cleanup);
})();
