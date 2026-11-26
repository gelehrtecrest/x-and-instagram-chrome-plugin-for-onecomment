(() => {
  'use strict';

  const Selectors = globalThis.InstagramLiveSelectors;
  if (!Selectors) return;

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

  const seenOrder = [];
  const seenSet = new Set();
  const MAX_SEEN = 1000;
  const pendingComments = [];

  function rememberId(id) {
    if (seenSet.has(id)) return false;
    seenSet.add(id);
    seenOrder.push(id);
    while (seenOrder.length > MAX_SEEN) {
      const oldest = seenOrder.shift();
      seenSet.delete(oldest);
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
          platform: 'instagram',
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

  function processElement(el, { initialSeed = false } = {}) {
    if (!el || el.nodeType !== 1) return;

    const parsed = Selectors.parseLiveCommentElement(el, {
      customSelectors: settings.customSelectors,
    });
    if (!parsed) return;

    if (parsed.isSystem && settings.skipSystemMessages) {
      return;
    }

    const isNew = rememberId(parsed.id);
    if (!isNew) return;
    if (initialSeed && settings.skipInitialComments) return;
    if (!settings.enabled) return;

    pendingComments.push(parsed);
    scheduleFlush();
  }

  function handleAddedNode(node) {
    if (!node || node.nodeType !== 1) return;
    const customItem = settings.customSelectors && settings.customSelectors.item;
    const nested = Selectors.findMessageElements(node, customItem);

    if (nested.length > 0 && nested[0] !== node) {
      let parsedAny = false;
      for (const child of nested) {
        const before = seenSet.size;
        processElement(child);
        if (seenSet.size > before) parsedAny = true;
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

  function checkAndAttach() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detachObserver();
    }

    if (!Selectors.isInstagramLivePage(location.href)) {
      if (activeContainer) detachObserver();
      return;
    }

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
      sendResponse({
        url: location.href,
        isLivePage: Selectors.isInstagramLivePage(location.href),
        containerFound: Boolean(activeContainer && document.contains(activeContainer)),
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
