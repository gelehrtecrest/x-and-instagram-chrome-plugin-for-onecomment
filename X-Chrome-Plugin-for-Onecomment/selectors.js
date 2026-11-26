(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.XLiveSelectors = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CONTAINER_SELECTORS = [
    '[data-testid="liveChatMessages"]',
    '[data-testid="chatMessages"]',
    '[data-testid="broadcastChat"]',
    '[aria-label*="ライブチャット" i]',
    '[aria-label*="Live chat" i]',
    '[aria-label*="チャット" i][role="region"]',
    '[aria-label*="Chat" i][role="region"]',
    '[role="log"]',
  ];

  const DEFAULT_ITEM_SELECTORS = [
    '[data-testid="liveChatMessage"]',
    '[data-testid="chatMessage"]',
    '[data-testid="broadcastChatMessage"]',
    '[role="listitem"]',
  ];

  const DEFAULT_AUTHOR_SELECTORS = [
    '[data-testid="User-Name"]',
    '[data-testid="chatMessageAuthor"]',
    'a[href^="/"] span',
    'a[role="link"] span',
    'strong',
  ];

  const DEFAULT_MESSAGE_SELECTORS = [
    '[data-testid="chatMessageText"]',
    '[data-testid="liveChatMessageText"]',
    '[data-testid="tweetText"]',
    '[dir="auto"]',
  ];

  const SYSTEM_PATTERNS = [
    /^.+?(?:さんが)?参加しました[。!！]?$/,
    /^.+? joined(?:\s+the\s+broadcast)?[.!]?$/i,
    /^.+?(?:さんが)?シェアしました[。!！]?$/,
    /^.+? shared(?:\s+the\s+broadcast)?[.!]?$/i,
    /^.+?(?:さんが)?(?:この配信を)?リポストしました[。!！]?$/,
    /^.+? reposted this stream[!.]?$/i,
    /^.+? invited .+$/i,
  ];

  const UI_NOISE_PATTERNS = [
    /^\d[\d,.\s万億kKmM]*\s*(?:件の表示|views?|watching|viewers?|人が視聴中|人視聴中|件の返信|件のリポスト|件のいいね)$/i,
    /^(?:ライブ|LIVE|配信中|チャット|Chat|トップチャット|Top chat|ライブチャット|Live chat|リプレイ|Replay|チャットのリプレイ|配信終了|フォローする|フォロー中|Follow|Following|送信|Send)$/i,
  ];

  const CHAT_INPUT_HINT_PATTERN = /チャット|コメント|メッセージ|返信|chat|comment|say something|message|reply/i;
  const CHAT_HEADER_PATTERN = /^(?:ライブチャット|チャット|トップチャット|Live chat|Top chat|Chat|チャットのリプレイ|Chat replay)$/i;

  function isXLivePage(urlString) {
    if (typeof urlString !== 'string') return false;
    try {
      const url = new URL(urlString);
      const host = url.hostname.toLowerCase();
      if (host !== 'x.com' && host !== 'www.x.com' && host !== 'twitter.com' && host !== 'www.twitter.com') {
        return false;
      }
      const path = url.pathname;
      return (
        path.startsWith('/i/broadcasts/') ||
        path.startsWith('/i/events/') ||
        path.startsWith('/i/spaces/') ||
        path.includes('/status/') ||
        path.includes('/live')
      );
    } catch {
      return false;
    }
  }

  function isDedicatedBroadcastUrl(urlString) {
    if (typeof urlString !== 'string') return false;
    try {
      const url = new URL(urlString);
      const path = url.pathname;
      return (
        path.startsWith('/i/broadcasts/') ||
        path.startsWith('/i/events/') ||
        path.startsWith('/i/spaces/') ||
        path.includes('/live')
      );
    } catch {
      return false;
    }
  }

  function fnv1aHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function safeJsonParse(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function normalizeTimestamp(value, fallbackNow) {
    if (typeof value === 'string' && value.includes('T') && value.includes('-')) {
      const parsedDate = Date.parse(value);
      if (Number.isFinite(parsedDate) && parsedDate > 0) return Math.floor(parsedDate);
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallbackNow;
    if (num > 1e15) {
      return Math.floor(num / 1e6);
    }
    if (num > 1e12) {
      return num > 1e14 ? Math.floor(num / 1e3) : Math.floor(num);
    }
    if (num > 1e9) {
      return Math.floor(num * 1000);
    }
    return fallbackNow;
  }

  function sanitizeHttpUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      return trimmed;
    }
    return '';
  }

  function extractTextWithEmoji(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName ? node.tagName.toUpperCase() : '';
    if (tag === 'IMG') {
      const alt = node.getAttribute ? node.getAttribute('alt') : '';
      return alt || '';
    }
    if (tag === 'BR') {
      return ' ';
    }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') {
      return '';
    }

    let out = '';
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i += 1) {
      out += extractTextWithEmoji(children[i]);
    }
    return out;
  }

  function normalizeWhitespace(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isUiNoiseText(text) {
    const trimmed = normalizeWhitespace(text);
    if (!trimmed) return true;
    return UI_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  function isScrollableElement(el) {
    if (!el || el.nodeType !== 1 || typeof getComputedStyle !== 'function') return false;
    try {
      const style = getComputedStyle(el);
      if (!style) return false;
      const oy = style.overflowY;
      return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
    } catch {
      return false;
    }
  }

  function isElementVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
          return false;
        }
      }
      if (typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        if (rect && rect.width <= 0 && rect.height <= 0) {
          return false;
        }
      }
    } catch {
      // ignore style/rect errors in minimal environments
    }
    return true;
  }

  function isHiddenHelperInput(inputEl) {
    if (!inputEl || inputEl.nodeType !== 1) return false;
    if (inputEl.getAttribute && inputEl.getAttribute('aria-hidden') === 'true') return true;
    if (inputEl.getAttribute && inputEl.getAttribute('type') === 'hidden') return true;
    return !isElementVisible(inputEl);
  }

  function hasVisibleInputInside(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;
    const inputs = el.querySelectorAll('textarea, input, [contenteditable="true"]');
    for (const inp of inputs) {
      if (!isHiddenHelperInput(inp)) return true;
    }
    return false;
  }

  function isStopAncestor(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    return tag === 'BODY' || tag === 'HTML' || tag === 'HEADER' || tag === 'NAV';
  }

  function isExcludedContainer(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV') {
      return true;
    }
    if (typeof el.closest === 'function' && el.closest('[data-testid="sidebarColumn"] nav')) {
      return true;
    }
    if (typeof el.querySelector === 'function') {
      if (el.querySelector('video')) return true;
      if (el.querySelector('article[data-testid="tweet"]')) return true;
      if (el.querySelector('[data-testid="videoPlayer"]')) return true;
    }
    return false;
  }

  function findLowestCommonAncestor(a, b, maxDepth = 20) {
    if (!a || !b) return null;
    const ancestors = new Set();
    let cur = a;
    for (let i = 0; i <= maxDepth && cur; i += 1) {
      ancestors.add(cur);
      cur = cur.parentElement;
    }
    cur = b;
    for (let i = 0; i <= maxDepth && cur; i += 1) {
      if (ancestors.has(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function pickBestChatListInside(parent, excludeEl, options = {}) {
    if (!parent || typeof parent.querySelectorAll !== 'function') return null;
    const allowSmall = Boolean(options.allowSmall);
    const allowLowScore = Boolean(options.allowLowScore);
    const excludeHeader = options.excludeHeader || null;
    const minHeight = allowSmall ? 24 : 60;
    const minWidth = allowSmall ? 100 : 120;
    const minScore = allowLowScore ? 4 : 8;

    const candidates = parent.querySelectorAll('div, ul, section');
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (excludeEl && (el === excludeEl || el.contains(excludeEl) || excludeEl.contains(el))) {
        continue;
      }
      if (excludeHeader && (el === excludeHeader || el.contains(excludeHeader) || excludeHeader.contains(el))) {
        continue;
      }
      if (isExcludedContainer(el)) continue;
      if (!isElementVisible(el)) continue;

      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (rect && (rect.height < minHeight || rect.width < minWidth)) continue;

      if (hasVisibleInputInside(el)) continue;

      const scrollable = isScrollableElement(el);
      const childCount = el.children ? el.children.length : 0;
      const profileImgs = el.querySelectorAll ? el.querySelectorAll('img[src*="profile_images"]').length : 0;
      const hasUserLink = el.querySelector ? Boolean(el.querySelector('a[href^="/"]')) : false;
      const role = el.getAttribute ? (el.getAttribute('role') || '').toLowerCase() : '';
      const ariaLive = el.getAttribute ? el.getAttribute('aria-live') || '' : '';

      let score = 0;
      if (scrollable) score += 15;
      if (profileImgs > 0) score += Math.min(12, profileImgs * 4);
      if (hasUserLink) score += 4;
      if (childCount > 0) score += Math.min(6, childCount);
      if (rect && rect.height >= 140) score += 5;
      else if (allowSmall && rect && rect.height >= 40) score += 4;
      if (role === 'list' || role === 'log' || ariaLive) score += 10;

      // より内側の具体的なリストコンテナを優先（同点なら深い要素）
      if (score > bestScore || (score === bestScore && best && best.contains(el))) {
        bestScore = score;
        best = el;
      }
    }

    return best && bestScore >= minScore ? { element: best, score: bestScore } : null;
  }

  function collectCandidateChatInputs(doc, isDedicated) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const rawInputs = Array.from(
      doc.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')
    );
    const matched = [];
    for (const input of rawInputs) {
      if (isHiddenHelperInput(input)) continue;
      const testId = input.getAttribute('data-testid') || '';
      if (testId === 'dmComposerTextInput' || testId === 'SearchBox_Search_Input') {
        continue;
      }
      if (!isDedicated && testId.startsWith('tweetTextarea')) {
        continue;
      }
      const placeholder = input.getAttribute('placeholder') || '';
      const ariaLabel = input.getAttribute('aria-label') || '';
      const combinedHint = `${placeholder} ${ariaLabel}`;
      const hasHint = CHAT_INPUT_HINT_PATTERN.test(combinedHint);
      if (!hasHint && !isDedicated) {
        continue;
      }
      matched.push({
        element: input,
        hasHint,
        visible: isElementVisible(input),
      });
    }
    // ヒント一致＆可視の入力欄を優先
    matched.sort((a, b) => Number(b.visible) - Number(a.visible) || Number(b.hasHint) - Number(a.hasHint));
    return matched;
  }

  function collectCandidateChatHeaders(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const nodes = doc.querySelectorAll('h1, h2, h3, span, div');
    const matched = [];
    for (const node of nodes) {
      if (node.children && node.children.length > 0) continue;
      const text = normalizeWhitespace(node.textContent || '');
      if (!text || text.length > 30) continue;
      if (!CHAT_HEADER_PATTERN.test(text)) continue;
      matched.push({
        element: node,
        text,
        visible: isElementVisible(node),
      });
    }
    matched.sort((a, b) => Number(b.visible) - Number(a.visible));
    return matched;
  }

  function findChatContainerByHeaderAndInputPair(doc, isDedicated) {
    const inputs = collectCandidateChatInputs(doc, isDedicated);
    const headers = collectCandidateChatHeaders(doc);
    if (inputs.length === 0 || headers.length === 0) return null;

    let bestList = null;
    let bestLcaFallback = null;

    for (const inp of inputs) {
      for (const hdr of headers) {
        const lca = findLowestCommonAncestor(inp.element, hdr.element, 20);
        if (!lca || isStopAncestor(lca)) continue;
        if (isExcludedContainer(lca)) continue;
        if (!isElementVisible(lca)) continue;

        const picked = pickBestChatListInside(lca, inp.element, {
          allowSmall: true,
          allowLowScore: true,
          excludeHeader: hdr.element,
        });
        if (picked) {
          const bonus = (inp.hasHint ? 6 : 0) + (inp.visible && hdr.visible ? 4 : 0);
          const totalScore = picked.score + bonus;
          if (!bestList || totalScore > bestList.score) {
            bestList = { element: picked.element, score: totalScore, selector: 'heuristic:header-input-pair' };
          }
        } else {
          // チャット一覧が空・極小・または入力欄と同一スクロール領域内にある場合、
          // ヘッダと入力欄の共通祖先（video を含まないチャットパネル自体）をフォールバック候補にする
          const rect = typeof lca.getBoundingClientRect === 'function' ? lca.getBoundingClientRect() : null;
          const areaOk = !rect || (rect.width >= 140 && rect.height >= 80);
          if (areaOk) {
            const area = rect ? rect.width * rect.height : 100000;
            const bonus = (inp.hasHint ? 1000 : 0) + (inp.visible && hdr.visible ? 500 : 0);
            // より具体的な（面積が小さい・深い）チャットパネルを優先
            if (
              !bestLcaFallback ||
              bonus > bestLcaFallback.bonus ||
              (bonus === bestLcaFallback.bonus && area < bestLcaFallback.area)
            ) {
              bestLcaFallback = { element: lca, bonus, area, selector: 'heuristic:header-input-lca' };
            }
          }
        }
      }
    }

    if (bestList) {
      return { element: bestList.element, selector: bestList.selector };
    }
    if (bestLcaFallback) {
      return { element: bestLcaFallback.element, selector: bestLcaFallback.selector };
    }
    return null;
  }

  function findChatContainerByInputHeuristic(doc, isDedicated) {
    const inputs = collectCandidateChatInputs(doc, isDedicated);
    let best = null;

    for (const item of inputs) {
      const input = item.element;
      // React Native Web の深いラッパーに対応するため最大20階層まで探索
      // video等を含む共通親に到達しても、専用配信ページならその層の「videoを含まない兄弟」を最大2階層だけ確認して打ち切る
      let parent = input.parentElement;
      let crossedExcluded = 0;
      for (let depth = 0; depth < 20 && parent; depth += 1) {
        if (isStopAncestor(parent)) break;
        const parentExcluded = isExcludedContainer(parent);
        if (parentExcluded) {
          if (!isDedicated) break;
          crossedExcluded += 1;
          if (crossedExcluded > 2) break;
        }
        const picked = pickBestChatListInside(parent, input, {
          allowSmall: !parentExcluded && item.hasHint,
          allowLowScore: !parentExcluded && item.hasHint,
        });
        if (picked) {
          const score = picked.score + (item.hasHint ? 5 : 0) - (parentExcluded ? 4 : 0);
          if (!best || score > best.score) {
            best = {
              element: picked.element,
              score,
              selector: parentExcluded ? 'heuristic:input-cross-sibling' : 'heuristic:input-sibling',
            };
          }
          if (!parentExcluded) break;
        }
        parent = parent.parentElement;
      }
    }

    return best ? { element: best.element, selector: best.selector } : null;
  }

  function findChatContainerByChatHeaderHeuristic(doc, isDedicated) {
    const headers = collectCandidateChatHeaders(doc);
    let best = null;

    for (const item of headers) {
      const node = item.element;
      let parent = node.parentElement;
      let crossedExcluded = 0;
      for (let depth = 0; depth < 18 && parent; depth += 1) {
        if (isStopAncestor(parent)) break;
        const parentExcluded = isExcludedContainer(parent);
        if (parentExcluded) {
          if (!isDedicated) break;
          crossedExcluded += 1;
          if (crossedExcluded > 2) break;
        }
        const picked = pickBestChatListInside(parent, node, {
          allowSmall: !parentExcluded,
          allowLowScore: !parentExcluded,
        });
        if (picked) {
          const score = picked.score - (parentExcluded ? 4 : 0);
          if (!best || score > best.score) {
            best = {
              element: picked.element,
              score,
              selector: parentExcluded ? 'heuristic:header-cross-sibling' : 'heuristic:chat-header',
            };
          }
          if (!parentExcluded) break;
        }
        parent = parent.parentElement;
      }
    }

    return best ? { element: best.element, selector: best.selector } : null;
  }

  function findChatContainer(doc, customContainerSelector, urlString = '') {
    if (!doc || typeof doc.querySelector !== 'function') {
      return { element: null, selector: '' };
    }

    const candidates = [];
    if (customContainerSelector && customContainerSelector.trim()) {
      candidates.push(customContainerSelector.trim());
    }
    candidates.push(...DEFAULT_CONTAINER_SELECTORS);

    for (const selector of candidates) {
      try {
        const el = doc.querySelector(selector);
        if (el && !isExcludedContainer(el) && isElementVisible(el)) {
          return { element: el, selector };
        }
      } catch {
        // 無効なカスタムセレクタは無視
      }
    }

    const currentUrl = urlString || (doc.location && doc.location.href) || '';
    const isDedicated = isDedicatedBroadcastUrl(currentUrl);

    const byPair = findChatContainerByHeaderAndInputPair(doc, isDedicated);
    if (byPair) return byPair;

    const byInput = findChatContainerByInputHeuristic(doc, isDedicated);
    if (byInput) return byInput;

    const byHeader = findChatContainerByChatHeaderHeuristic(doc, isDedicated);
    if (byHeader) return byHeader;

    return { element: null, selector: '' };
  }

  function countProfileImages(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return 0;
    try {
      return el.querySelectorAll('img[src*="profile_images"]').length;
    } catch {
      return 0;
    }
  }

  function unwrapSingleChildContainers(rootEl, maxDepth = 5) {
    let current = rootEl;
    for (let depth = 0; depth < maxDepth && current; depth += 1) {
      const children = Array.from(current.children || []).filter((child) => child && child.nodeType === 1);
      if (children.length !== 1) {
        return children;
      }
      const only = children[0];
      const grandChildren = Array.from(only.children || []).filter((child) => child && child.nodeType === 1);
      if (grandChildren.length === 0) {
        return children;
      }
      const tag = only.tagName ? only.tagName.toUpperCase() : '';
      const isContainerTag = tag === 'DIV' || tag === 'UL' || tag === 'OL' || tag === 'SECTION' || tag === 'MAIN';
      if (!isContainerTag) {
        return children;
      }
      // 複数コメントを含むラッパー（プロフィール画像が2枚以上、または子要素が1個でさらに内側を持つラッパー）なら掘り下げる
      const profCount = countProfileImages(only);
      const onlyHasMultipleMessageChildren =
        grandChildren.length >= 2 &&
        (profCount >= 2 ||
          grandChildren.filter((gc) => gc.querySelector && gc.querySelector('a[href^="/"]')).length >= 2);
      if (onlyHasMultipleMessageChildren || grandChildren.length === 1) {
        current = only;
        continue;
      }
      return children;
    }
    return Array.from((current && current.children) || []).filter((child) => child && child.nodeType === 1);
  }

  function findMessageElements(rootEl, customItemSelector) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];

    const candidates = [];
    if (customItemSelector && customItemSelector.trim()) {
      candidates.push(customItemSelector.trim());
    }
    candidates.push(...DEFAULT_ITEM_SELECTORS);

    for (const selector of candidates) {
      try {
        const matches = rootEl.querySelectorAll(selector);
        if (matches && matches.length > 0) {
          return Array.from(matches);
        }
      } catch {
        // ignore invalid selector
      }
    }

    return unwrapSingleChildContainers(rootEl, 5);
  }

  function extractHandlesFromElement(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return [];
    const links = itemEl.querySelectorAll('a[href^="/"]');
    const handles = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,30})(?:\/|$|\?)/);
      if (match) {
        const candidate = match[1];
        if (!['i', 'home', 'explore', 'search', 'messages', 'notifications', 'settings'].includes(candidate)) {
          if (!handles.includes(candidate)) {
            handles.push(candidate);
          }
        }
      }
    }
    return handles;
  }

  function extractProfileImage(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return '';
    const imgs = itemEl.querySelectorAll('img[src]');
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      if (src.includes('profile_images') || src.includes('pbs.twimg.com')) {
        if (!src.includes('/emoji/')) {
          return src;
        }
      }
    }
    return '';
  }

  function collectLeafTextSegments(rootEl) {
    const segments = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const t = normalizeWhitespace(node.nodeValue || '');
        if (t) segments.push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'BUTTON') return;
      if (tag === 'IMG') {
        const alt = node.getAttribute ? node.getAttribute('alt') : '';
        if (alt && !alt.includes('プロフィール') && !alt.toLowerCase().includes('avatar')) {
          segments.push(alt);
        }
        return;
      }
      const children = node.childNodes || [];
      // テキストと絵文字imgだけで構成されたspanは1つのセグメントとしてまとめる
      const hasBlockChild = Array.from(children).some(
        (c) => c.nodeType === 1 && c.tagName && !['IMG', 'BR'].includes(c.tagName.toUpperCase())
      );
      if (!hasBlockChild) {
        const t = normalizeWhitespace(extractTextWithEmoji(node));
        if (t) segments.push(t);
        return;
      }
      for (let i = 0; i < children.length; i += 1) {
        walk(children[i]);
      }
    };
    walk(rootEl);
    return segments;
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripAuthorPrefix(text, displayName, handle) {
    let out = normalizeWhitespace(text);
    if (!out) return '';

    const cleanName = String(displayName || '')
      .replace(/\s*@[A-Za-z0-9_]+$/, '')
      .trim();
    const cleanHandle = String(handle || '')
      .replace(/^@/, '')
      .trim();

    for (let pass = 0; pass < 2; pass += 1) {
      const before = out;
      if (cleanName && out.startsWith(cleanName)) {
        const afterName = out.slice(cleanName.length);
        if (
          !afterName ||
          /^[\s:：·・@]/.test(afterName) ||
          (cleanHandle && afterName.toLowerCase().startsWith(`@${cleanHandle.toLowerCase()}`))
        ) {
          out = normalizeWhitespace(afterName.replace(/^[\s:：·・]+/, ''));
        }
      }
      if (cleanHandle) {
        const handleRe = new RegExp(`^@${escapeRegExp(cleanHandle)}(?:[\\s:：·・]+)?`, 'i');
        if (handleRe.test(out)) {
          out = normalizeWhitespace(out.replace(handleRe, ''));
        }
      }
      if (out === before) break;
    }

    return out;
  }

  function isSystemMessage(text) {
    const trimmed = normalizeWhitespace(text);
    if (!trimmed) return false;
    return SYSTEM_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  function buildFormattedName(displayName, handle, nameFormat) {
    const cleanDisplayName =
      String(displayName || '')
        .replace(/\s*@[A-Za-z0-9_]+$/, '')
        .trim() ||
      handle ||
      'Xユーザー';
    const screenName = handle ? `@${handle}` : '';
    const formattedName =
      nameFormat === 'both' && screenName && cleanDisplayName !== handle
        ? `${cleanDisplayName} (${screenName})`
        : cleanDisplayName;
    return { cleanDisplayName, screenName, formattedName };
  }

  function parseChatmanPayload(rawData, options = {}) {
    const outer = safeJsonParse(rawData);
    if (!outer || typeof outer !== 'object') return null;

    if (typeof outer.kind === 'number' && outer.kind !== 1) {
      return null;
    }

    const payload = safeJsonParse(outer.payload) || outer;
    if (!payload || typeof payload !== 'object') return null;

    const parsedBody = safeJsonParse(payload.body);
    const hasInnerObj = Boolean(parsedBody && typeof parsedBody === 'object');
    const bodyObj = hasInnerObj ? parsedBody : {};

    const msgType =
      typeof bodyObj.type === 'number'
        ? bodyObj.type
        : typeof payload.type === 'number'
          ? payload.type
          : undefined;

    if (msgType !== undefined && msgType !== 1) {
      return null;
    }

    const rawComment =
      typeof bodyObj.body === 'string'
        ? bodyObj.body
        : typeof bodyObj.message === 'string'
          ? bodyObj.message
          : typeof bodyObj.text === 'string'
            ? bodyObj.text
            : !hasInnerObj && typeof payload.body === 'string'
              ? payload.body
              : typeof payload.message === 'string'
                ? payload.message
                : '';

    const commentText = normalizeWhitespace(rawComment);
    if (!commentText) return null;

    const sender =
      (payload.sender && typeof payload.sender === 'object' ? payload.sender : null) ||
      (outer.sender && typeof outer.sender === 'object' ? outer.sender : null) ||
      (bodyObj.sender && typeof bodyObj.sender === 'object' ? bodyObj.sender : null) ||
      {};

    const handle = String(
      bodyObj.username ||
        payload.username ||
        sender.username ||
        sender.twitter_screen_name ||
        sender.screen_name ||
        ''
    )
      .replace(/^@/, '')
      .trim();

    const rawDisplayName = String(
      bodyObj.displayName ||
        bodyObj.display_name ||
        payload.displayName ||
        payload.display_name ||
        sender.display_name ||
        sender.displayName ||
        handle ||
        ''
    ).trim();

    if (!rawDisplayName && !handle) {
      return null;
    }

    const nameFormat = options.nameFormat || 'display';
    const { cleanDisplayName, screenName, formattedName } = buildFormattedName(
      rawDisplayName,
      handle,
      nameFormat
    );

    const userId = String(
      handle ||
        sender.twitter_id ||
        sender.user_id ||
        bodyObj.user_id ||
        cleanDisplayName
    ).trim();

    const profileImage = sanitizeHttpUrl(
      bodyObj.profileImageURL ||
        bodyObj.profileImageUrl ||
        bodyObj.profile_image_url ||
        payload.profileImageURL ||
        payload.profileImageUrl ||
        payload.profile_image_url ||
        sender.profile_image_url ||
        sender.profileImageUrl ||
        ''
    );

    const now = typeof options.now === 'number' ? options.now : Date.now();
    const timestamp = normalizeTimestamp(
      bodyObj.timestamp || bodyObj.programDateTime || payload.timestamp || outer.timestamp,
      now
    );

    const uuid = String(bodyObj.uuid || payload.uuid || outer.uuid || '').trim();
    const bucket = Math.floor(timestamp / 15000);
    const id = uuid
      ? `x_live_ws_${uuid}`
      : `x_live_${fnv1aHash(`${userId}|${commentText}|${bucket}`)}`;

    const isOwner = Boolean(
      bodyObj.isBroadcaster ||
        bodyObj.is_broadcaster ||
        payload.isBroadcaster ||
        sender.is_broadcaster ||
        sender.isOwner
    );
    const isSystem = isSystemMessage(commentText);

    return {
      id,
      userId,
      name: formattedName,
      screenName,
      comment: commentText,
      profileImage,
      timestamp,
      isOwner,
      isModerator: Boolean(bodyObj.isModerator || sender.is_moderator),
      hasGift: false,
      isSystem,
      badges: isOwner ? [{ url: '', label: '配信者', type: 'owner' }] : [],
    };
  }

  function parseHistoryResponse(rawData, options = {}) {
    const parsed = safeJsonParse(rawData);
    if (!parsed || typeof parsed !== 'object') return [];
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
      : Array.isArray(parsed)
        ? parsed
        : [];
    const results = [];
    for (const msg of messages) {
      const item = parseChatmanPayload(msg, options);
      if (item) results.push(item);
    }
    return results;
  }

  function parseChatMessageElement(itemEl, options = {}) {
    if (!itemEl || itemEl.nodeType !== 1) return null;

    if (typeof itemEl.querySelector === 'function') {
      if (itemEl.querySelector('video, textarea, input, article[data-testid="tweet"]')) {
        return null;
      }
    }

    // 複数コメントを含む親コンテナを誤って1件としてパースしないように除外
    if (countProfileImages(itemEl) >= 2) {
      return null;
    }

    const custom = options.customSelectors || {};
    const nameFormat = options.nameFormat || 'display';

    const handles = extractHandlesFromElement(itemEl);
    if (handles.length > 2) {
      return null;
    }
    let handle = handles[0] || '';
    const profileImage = extractProfileImage(itemEl);

    // 1. ユーザー名抽出（標準セレクタ）
    let displayName = '';
    const authorSelectors = [];
    if (custom.author && custom.author.trim()) {
      authorSelectors.push(custom.author.trim());
    }
    authorSelectors.push(...DEFAULT_AUTHOR_SELECTORS, 'a[href^="/"]', 'a[role="link"]');

    let authorEl = null;
    let fallbackHandleOnlyName = '';
    let fallbackHandleOnlyEl = null;

    for (const selector of authorSelectors) {
      try {
        const els =
          typeof itemEl.querySelectorAll === 'function'
            ? Array.from(itemEl.querySelectorAll(selector))
            : [];
        for (const el of els) {
          const text = normalizeWhitespace(extractTextWithEmoji(el));
          if (!text || isUiNoiseText(text)) continue;
          if (/^@[A-Za-z0-9_]{1,30}$/.test(text)) {
            if (!handle) handle = text.slice(1);
            if (!fallbackHandleOnlyName) {
              fallbackHandleOnlyName = text;
              fallbackHandleOnlyEl = el;
            }
            continue;
          }
          // リンクに本文まで含まれている長すぎるテキストはスキップ
          if (text.length > 60 && (selector === 'a[href^="/"]' || selector === 'a[role="link"]')) {
            continue;
          }
          displayName = text;
          authorEl = el;
          break;
        }
        if (displayName) break;
      } catch {
        // ignore invalid selector
      }
    }

    let usedHandleFallbackForName = false;
    if (!displayName && fallbackHandleOnlyName) {
      displayName = fallbackHandleOnlyName.replace(/^@/, '');
      authorEl = fallbackHandleOnlyEl;
      usedHandleFallbackForName = true;
    }
    if (!displayName && handle) {
      displayName = handle;
      usedHandleFallbackForName = true;
    }

    let commentText = '';

    // 2. 本文抽出（標準セレクタ）
    if (displayName && !usedHandleFallbackForName) {
      const messageSelectors = [];
      if (custom.message && custom.message.trim()) {
        messageSelectors.push(custom.message.trim());
      }
      messageSelectors.push(...DEFAULT_MESSAGE_SELECTORS);

      for (const selector of messageSelectors) {
        try {
          const els = itemEl.querySelectorAll(selector);
          for (const el of els) {
            if (authorEl && (el === authorEl || authorEl.contains(el) || el.contains(authorEl))) {
              continue;
            }
            const rawText = normalizeWhitespace(extractTextWithEmoji(el));
            if (!rawText) continue;
            if (rawText === displayName || rawText === `@${handle}` || /^@[A-Za-z0-9_]{1,30}$/.test(rawText)) {
              continue;
            }
            const cleanedText = stripAuthorPrefix(rawText, displayName, handle);
            if (!cleanedText) continue;
            if (isUiNoiseText(cleanedText)) continue;
            commentText = cleanedText;
            break;
          }
          if (commentText) break;
        } catch {
          // ignore invalid selector
        }
      }
    }

    // 3. フォールバック: 葉ノードのテキストセグメント分解（[表示名, @handle, 本文] や <a>なしのX Live行に対応）
    if (!displayName || !commentText) {
      const segments = collectLeafTextSegments(itemEl).filter((s) => !isUiNoiseText(s));
      const nonHandleSegments = [];
      let handleSegmentIndex = -1;

      for (const seg of segments) {
        if (/^@[A-Za-z0-9_]{1,30}$/.test(seg)) {
          if (!handle) handle = seg.slice(1);
          if (handleSegmentIndex === -1) handleSegmentIndex = nonHandleSegments.length;
          continue;
        }
        // "ゲレの工房@gelehrte_crest" のように名前と@handleが1つのセグメントに結合している場合は分離
        const inlineHandleMatch = seg.match(/^(.+?)\s*(@[A-Za-z0-9_]{1,30})(.*)$/);
        if (inlineHandleMatch) {
          const beforeH = normalizeWhitespace(inlineHandleMatch[1]);
          const foundHandle = inlineHandleMatch[2].slice(1);
          const afterH = normalizeWhitespace(inlineHandleMatch[3]);
          if (!handle) handle = foundHandle;
          if (beforeH) nonHandleSegments.push(beforeH);
          if (handleSegmentIndex === -1) handleSegmentIndex = nonHandleSegments.length;
          if (afterH) nonHandleSegments.push(afterH);
          continue;
        }
        nonHandleSegments.push(seg);
      }

      // ハンドルしか取れておらず、@handleの前後にセグメントがある場合は [前=表示名, 後=本文] として分離
      if (usedHandleFallbackForName && handleSegmentIndex > 0 && handleSegmentIndex < nonHandleSegments.length) {
        const beforeParts = nonHandleSegments.slice(0, handleSegmentIndex);
        const afterParts = nonHandleSegments.slice(handleSegmentIndex);
        const candidateAuthor = normalizeWhitespace(beforeParts.join(' '));
        const candidateBody = normalizeWhitespace(afterParts.join(' '));
        if (candidateAuthor && candidateAuthor.length <= 40 && candidateBody && !isUiNoiseText(candidateBody)) {
          displayName = candidateAuthor;
          commentText = candidateBody;
          usedHandleFallbackForName = false;
        }
      }

      if ((!displayName || usedHandleFallbackForName) && !commentText && nonHandleSegments.length >= 2) {
        const candidateAuthor = nonHandleSegments[0];
        const candidateBody = nonHandleSegments.slice(1).join(' ').trim();
        if (
          candidateAuthor.length <= 40 &&
          candidateBody.length > 0 &&
          candidateBody.length <= 500 &&
          (profileImage || handle)
        ) {
          displayName = candidateAuthor;
          commentText = candidateBody;
        }
      } else if (displayName && !commentText) {
        const cleanAuthorForMatch = displayName.replace(/\s*@[A-Za-z0-9_]+$/, '').trim();
        const remainingSegments = nonHandleSegments.filter((seg, idx) => {
          if (seg === displayName || seg === cleanAuthorForMatch || seg === `@${handle}` || seg === handle) {
            return false;
          }
          // 先頭セグメントが "表示名@handle" の形式だった場合も除外
          if (idx === 0 && cleanAuthorForMatch && seg.startsWith(cleanAuthorForMatch) && seg.length <= cleanAuthorForMatch.length + 2) {
            return false;
          }
          return true;
        });

        if (remainingSegments.length > 0) {
          const joined = normalizeWhitespace(remainingSegments.join(' '));
          const cleaned = stripAuthorPrefix(joined, displayName, handle);
          if (cleaned && cleaned !== displayName && cleaned !== `@${handle}` && !isUiNoiseText(cleaned)) {
            commentText = cleaned;
          }
        }

        if (!commentText) {
          const fullText = normalizeWhitespace(extractTextWithEmoji(itemEl));
          if (fullText.length <= 600) {
            let rest = stripAuthorPrefix(fullText, displayName, handle);
            if (rest === fullText && fullText.startsWith(displayName)) {
              rest = stripAuthorPrefix(fullText.slice(displayName.length), displayName, handle);
            }
            if (rest === fullText && handle) {
              const handleToken = `@${handle}`;
              const idx = fullText.toLowerCase().indexOf(handleToken.toLowerCase());
              if (idx >= 0) {
                const beforeH = normalizeWhitespace(fullText.slice(0, idx));
                const afterH = normalizeWhitespace(fullText.slice(idx + handleToken.length));
                if (beforeH && (!displayName || displayName === handle)) {
                  displayName = beforeH;
                }
                if (afterH) {
                  rest = afterH;
                }
              }
            }
            if (rest && rest !== fullText && rest !== `@${handle}` && !isUiNoiseText(rest)) {
              commentText = rest;
            }
          }
        }
      }
    }

    if (commentText) {
      commentText = stripAuthorPrefix(commentText, displayName, handle);
    }

    if (!displayName && !handle) return null;
    if (!commentText || isUiNoiseText(commentText)) return null;
    if (commentText === displayName || commentText === `@${handle}`) return null;

    const { cleanDisplayName, screenName, formattedName } = buildFormattedName(
      displayName,
      handle,
      nameFormat
    );

    const userId = handle || cleanDisplayName;
    const itemText = normalizeWhitespace(itemEl.textContent || '');
    const isOwner = Boolean(
      itemEl.querySelector('[data-testid="broadcasterBadge"], [aria-label*="Host" i], [aria-label*="ホスト" i]')
    );
    const isSystem = isSystemMessage(commentText) || isSystemMessage(itemText);

    const domId =
      itemEl.getAttribute('data-message-id') ||
      itemEl.getAttribute('data-id') ||
      itemEl.id ||
      '';

    const now = typeof options.now === 'number' ? options.now : Date.now();
    const bucket = Math.floor(now / 15000);
    const id = domId
      ? `x_live_${domId}`
      : `x_live_${fnv1aHash(`${userId}|${commentText}|${bucket}`)}`;

    return {
      id,
      userId,
      name: formattedName,
      screenName,
      comment: commentText,
      profileImage,
      timestamp: now,
      isOwner,
      isModerator: false,
      hasGift: false,
      isSystem,
      badges: isOwner ? [{ url: '', label: '配信者', type: 'owner' }] : [],
    };
  }

  function parseLivePipelinePayload(rawData, options = {}) {
    const outer = safeJsonParse(rawData);
    if (!outer || typeof outer !== 'object') return null;

    // まず既存の Chatman 形式としてパース試行
    const directChatman = parseChatmanPayload(outer, options);
    if (directChatman) return directChatman;

    const topic = typeof outer.topic === 'string' ? outer.topic : '';
    const rootPayload = safeJsonParse(outer.payload) || outer.payload || outer;
    if (!rootPayload || typeof rootPayload !== 'object') return null;

    // Chatman ペイロードが payload 内にネストされているケース
    const nestedChatman = parseChatmanPayload(rootPayload, options);
    if (nestedChatman) return nestedChatman;

    // X LivePipeline の各種候補コンテナを探索
    const msgCandidates = [
      rootPayload.live_chat_message,
      rootPayload.liveChatMessage,
      rootPayload.chat_message,
      rootPayload.chatMessage,
      rootPayload.broadcast_chat_message,
      rootPayload.broadcastChatMessage,
      rootPayload.message,
      rootPayload,
    ].filter((obj) => obj && typeof obj === 'object');

    for (const msg of msgCandidates) {
      // エンゲージメント更新等の非チャットイベントを除外
      if (topic && !/chat|broadcast|live|message|comment|space/i.test(topic)) {
        if (!msg.sender && !msg.author && !msg.user && !msg.user_results) {
          continue;
        }
      }

      const rawText =
        typeof msg.body === 'string'
          ? msg.body
          : typeof msg.text === 'string'
            ? msg.text
            : typeof msg.message === 'string'
              ? msg.message
              : typeof msg.content === 'string'
                ? msg.content
                : '';
      const commentText = normalizeWhitespace(rawText);
      if (!commentText) continue;

      const userResult =
        (msg.user_results && msg.user_results.result) ||
        (msg.sender_results && msg.sender_results.result) ||
        (msg.author_results && msg.author_results.result) ||
        null;
      const legacy = (userResult && userResult.legacy) || {};
      const core = (userResult && userResult.core) || {};
      const sender =
        (msg.sender && typeof msg.sender === 'object' ? msg.sender : null) ||
        (msg.author && typeof msg.author === 'object' ? msg.author : null) ||
        (msg.user && typeof msg.user === 'object' ? msg.user : null) ||
        {};

      const handle = String(
        core.screen_name ||
          legacy.screen_name ||
          sender.screen_name ||
          sender.username ||
          sender.twitter_screen_name ||
          msg.username ||
          msg.screen_name ||
          ''
      )
        .replace(/^@/, '')
        .trim();

      const rawDisplayName = String(
        core.name ||
          legacy.name ||
          sender.display_name ||
          sender.displayName ||
          sender.name ||
          msg.display_name ||
          msg.displayName ||
          handle ||
          ''
      ).trim();

      if (!rawDisplayName && !handle) continue;

      const nameFormat = options.nameFormat || 'display';
      const { cleanDisplayName, screenName, formattedName } = buildFormattedName(
        rawDisplayName,
        handle,
        nameFormat
      );

      const userId = String(
        handle ||
          (userResult && userResult.rest_id) ||
          sender.rest_id ||
          sender.user_id ||
          sender.id ||
          cleanDisplayName
      ).trim();

      const profileImage = sanitizeHttpUrl(
        (userResult && userResult.avatar && userResult.avatar.image_url) ||
          legacy.profile_image_url_https ||
          sender.profile_image_url_https ||
          sender.profile_image_url ||
          sender.profileImageUrl ||
          sender.avatar_url ||
          msg.profile_image_url ||
          ''
      );

      const now = typeof options.now === 'number' ? options.now : Date.now();
      const timestamp = normalizeTimestamp(
        msg.timestamp_ms || msg.timestamp || msg.created_at || outer.timestamp,
        now
      );

      const msgId = String(msg.id || msg.uuid || msg.message_id || outer.id || '').trim();
      const bucket = Math.floor(timestamp / 15000);
      const id = msgId
        ? `x_live_lp_${msgId}`
        : `x_live_lp_${fnv1aHash(`${userId}|${commentText}|${bucket}`)}`;

      const isOwner = Boolean(msg.is_broadcaster || msg.isBroadcaster || sender.is_broadcaster || sender.isOwner);
      const isSystem = isSystemMessage(commentText);

      return {
        id,
        userId,
        name: formattedName,
        screenName,
        comment: commentText,
        profileImage,
        timestamp,
        isOwner,
        isModerator: Boolean(msg.is_moderator || msg.isModerator || sender.is_moderator),
        hasGift: false,
        isSystem,
        badges: isOwner ? [{ url: '', label: '配信者', type: 'owner' }] : [],
      };
    }

    return null;
  }

  function summarizeElementForDiag(el) {
    if (!el || el.nodeType !== 1) return null;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    let oy = '';
    if (typeof getComputedStyle === 'function') {
      try {
        const st = getComputedStyle(el);
        oy = st ? st.overflowY || '' : '';
      } catch {
        // ignore
      }
    }
    return {
      tag: el.tagName,
      testid: el.getAttribute ? el.getAttribute('data-testid') || '' : '',
      role: el.getAttribute ? el.getAttribute('role') || '' : '',
      size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '',
      visible: isElementVisible(el),
      oy,
      kids: el.children ? el.children.length : 0,
      hasVideo: Boolean(el.querySelector && el.querySelector('video, [data-testid="videoPlayer"]')),
      hasTweet: Boolean(el.querySelector && el.querySelector('article[data-testid="tweet"]')),
      hasInput: hasVisibleInputInside(el),
      excluded: isExcludedContainer(el),
    };
  }

  function traceAncestorsForDiag(el, maxDepth = 10) {
    const trace = [];
    let cur = el && el.parentElement;
    for (let depth = 0; depth < maxDepth && cur; depth += 1) {
      trace.push({ depth, ...summarizeElementForDiag(cur) });
      if (isStopAncestor(cur)) break;
      cur = cur.parentElement;
    }
    return trace;
  }

  function collectDomDiagnostics(doc, urlString = '') {
    if (!doc || typeof doc.querySelectorAll !== 'function') return {};

    const rawInputs = Array.from(
      doc.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')
    ).slice(0, 8);

    const inputs = rawInputs.map((el, idx) => {
      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      const item = {
        tag: el.tagName,
        testid: el.getAttribute('data-testid') || '',
        placeholder: (el.getAttribute('placeholder') || '').slice(0, 40),
        aria: (el.getAttribute('aria-label') || '').slice(0, 40),
        visible: isElementVisible(el),
        size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '',
      };
      if (idx < 2) {
        item.ancestorTrace = traceAncestorsForDiag(el, 10);
      }
      return item;
    });

    const chatHeaders = [];
    const chatHeaderEls = [];
    const nodes = doc.querySelectorAll('h1, h2, h3, span, div');
    for (const node of nodes) {
      if (chatHeaders.length >= 5) break;
      if (node.children && node.children.length > 0) continue;
      const text = normalizeWhitespace(node.textContent || '');
      if (text && text.length <= 30 && CHAT_HEADER_PATTERN.test(text)) {
        const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
        chatHeaders.push({
          tag: node.tagName,
          text,
          testid: node.getAttribute('data-testid') || '',
          visible: isElementVisible(node),
          size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '',
        });
        chatHeaderEls.push(node);
      }
    }

    let lcaCheck = null;
    if (rawInputs.length > 0 && chatHeaderEls.length > 0) {
      const lca = findLowestCommonAncestor(rawInputs[0], chatHeaderEls[0], 20);
      lcaCheck = lca ? summarizeElementForDiag(lca) : { found: false };
    }

    const iframes = Array.from(doc.querySelectorAll('iframe'))
      .slice(0, 5)
      .map((f) => (f.getAttribute('src') || '').split('?')[0]);

    const found = findChatContainer(doc, '', urlString);
    let containerInfo = null;
    if (found.element) {
      const rect =
        typeof found.element.getBoundingClientRect === 'function'
          ? found.element.getBoundingClientRect()
          : null;
      const sampleChildren = Array.from(found.element.children || [])
        .slice(-3)
        .map((c) => ({
          tag: c.tagName,
          testid: c.getAttribute('data-testid') || '',
          text: normalizeWhitespace(extractTextWithEmoji(c)).slice(0, 80),
          hasImg: Boolean(c.querySelector && c.querySelector('img[src*="profile_images"]')),
          hasLink: Boolean(c.querySelector && c.querySelector('a[href^="/"]')),
        }));
      const resolvedItems = findMessageElements(found.element, '');
      const sampleItems = resolvedItems.slice(-3).map((item) => {
        const parsed = parseChatMessageElement(item, { nameFormat: 'display' });
        return {
          tag: item.tagName,
          testid: item.getAttribute ? item.getAttribute('data-testid') || '' : '',
          childCount: item.children ? item.children.length : 0,
          profileImgCount: countProfileImages(item),
          handles: extractHandlesFromElement(item).slice(0, 4),
          leafSegments: collectLeafTextSegments(item).slice(0, 6),
          text: normalizeWhitespace(extractTextWithEmoji(item)).slice(0, 100),
          parsed: parsed
            ? { name: parsed.name, comment: parsed.comment, userId: parsed.userId }
            : null,
        };
      });
      containerInfo = {
        selector: found.selector,
        tag: found.element.tagName,
        testid: found.element.getAttribute('data-testid') || '',
        childCount: found.element.children ? found.element.children.length : 0,
        resolvedItemCount: resolvedItems.length,
        size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '',
        sampleChildren,
        sampleItems,
      };
    }

    return {
      inputs,
      chatHeaders,
      lcaCheck,
      iframes,
      containerInfo,
    };
  }

  return {
    DEFAULT_CONTAINER_SELECTORS,
    DEFAULT_ITEM_SELECTORS,
    isXLivePage,
    isUiNoiseText,
    extractTextWithEmoji,
    countProfileImages,
    hasVisibleInputInside,
    findChatContainer,
    findMessageElements,
    parseChatMessageElement,
    parseChatmanPayload,
    parseLivePipelinePayload,
    parseHistoryResponse,
    stripAuthorPrefix,
    collectDomDiagnostics,
    isSystemMessage,
    fnv1aHash,
  };
});
