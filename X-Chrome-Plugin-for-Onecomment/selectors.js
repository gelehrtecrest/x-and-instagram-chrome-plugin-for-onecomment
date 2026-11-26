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
    /^.+? invited .+$/i,
  ];

  const CHAT_INPUT_HINT_PATTERN = /チャット|コメント|メッセージ|chat|comment|say something|message/i;

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
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallbackNow;
    if (num > 1e15) {
      // ナノ秒 (Chatman の ntp/timestamp)
      return Math.floor(num / 1e6);
    }
    if (num > 1e12) {
      // マイクロ秒またはミリ秒判定 (2001年〜2286年は 1e12〜1e13)
      return num > 1e14 ? Math.floor(num / 1e3) : Math.floor(num);
    }
    if (num > 1e9) {
      // 秒
      return Math.floor(num * 1000);
    }
    return fallbackNow;
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

  function isExcludedAsTimeline(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') return true;
    if (typeof el.closest === 'function' && el.closest('[data-testid="sidebarColumn"] nav')) {
      return true;
    }
    if (typeof el.querySelector === 'function' && el.querySelector('article[data-testid="tweet"]')) {
      return true;
    }
    return false;
  }

  function findChatContainerByInputHeuristic(doc, isDedicated) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;

    const inputs = doc.querySelectorAll(
      'textarea, input[type="text"], input:not([type]), [contenteditable="true"]'
    );
    for (const input of inputs) {
      const testId = input.getAttribute('data-testid') || '';
      if (
        testId.startsWith('tweetTextarea') ||
        testId === 'dmComposerTextInput' ||
        testId === 'SearchBox_Search_Input'
      ) {
        continue;
      }

      const placeholder = input.getAttribute('placeholder') || '';
      const ariaLabel = input.getAttribute('aria-label') || '';
      const combinedHint = `${placeholder} ${ariaLabel}`;
      if (!CHAT_INPUT_HINT_PATTERN.test(combinedHint) && !isDedicated) {
        continue;
      }

      // 入力欄の親階層を辿り、近傍にあるスクロール可能なチャット領域を探す
      let parent = input.parentElement;
      for (let depth = 0; depth < 8 && parent; depth += 1) {
        if (isExcludedAsTimeline(parent)) break;
        const candidates = parent.querySelectorAll('div, ul, section');
        let best = null;
        let bestScore = 0;

        for (const el of candidates) {
          if (el === input || el.contains(input)) continue;
          if (isExcludedAsTimeline(el)) continue;

          const scrollable = isScrollableElement(el);
          const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
          if (rect && (rect.height < 80 || rect.width < 160)) continue;

          let score = 0;
          if (scrollable) score += 10;
          if (el.children && el.children.length > 0) score += Math.min(5, el.children.length);
          if (rect && rect.height >= 150) score += 3;

          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }

        if (best && bestScore >= 10) {
          return { element: best, selector: 'heuristic:input-sibling' };
        }
        parent = parent.parentElement;
      }
    }

    return null;
  }

  function findChatContainerByBroadcastScrollHeuristic(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;

    const divs = doc.querySelectorAll('div, section');
    let best = null;
    let bestScore = 0;

    for (const el of divs) {
      if (isExcludedAsTimeline(el)) continue;
      if (!isScrollableElement(el)) continue;

      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (rect && (rect.height < 140 || rect.width < 180)) continue;

      const imgs = el.querySelectorAll('img[src*="profile_images"]').length;
      const links = el.querySelectorAll('a[href^="/"]').length;
      const score = imgs * 3 + links + (rect && rect.height >= 200 ? 5 : 0);

      if (score > bestScore && (imgs > 0 || links > 0 || (el.children && el.children.length >= 2))) {
        bestScore = score;
        best = el;
      }
    }

    if (best) {
      return { element: best, selector: 'heuristic:broadcast-scroll' };
    }
    return null;
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
        if (el) {
          return { element: el, selector };
        }
      } catch {
        // 無効なカスタムセレクタは無視
      }
    }

    const currentUrl = urlString || (doc.location && doc.location.href) || '';
    const isDedicated = isDedicatedBroadcastUrl(currentUrl);

    const byInput = findChatContainerByInputHeuristic(doc, isDedicated);
    if (byInput) return byInput;

    if (isDedicated) {
      const byScroll = findChatContainerByBroadcastScrollHeuristic(doc);
      if (byScroll) return byScroll;
    }

    return { element: null, selector: '' };
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

    // フォールバック: コンテナ直下の子要素
    return Array.from(rootEl.children || []).filter((child) => child && child.nodeType === 1);
  }

  function extractHandleFromElement(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return '';
    const links = itemEl.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,30})(?:\/|$|\?)/);
      if (match) {
        const candidate = match[1];
        if (!['i', 'home', 'explore', 'search', 'messages', 'notifications', 'settings'].includes(candidate)) {
          return candidate;
        }
      }
    }
    return '';
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

    // Chatmanプロトコル: kind=1 がチャット/イベントフレーム (kind=2: control, kind=3: auth)
    if (typeof outer.kind === 'number' && outer.kind !== 1) {
      return null;
    }

    const payload = safeJsonParse(outer.payload) || outer;
    if (!payload || typeof payload !== 'object') return null;

    const parsedBody = safeJsonParse(payload.body);
    const hasInnerObj = Boolean(parsedBody && typeof parsedBody === 'object');
    const bodyObj = hasInnerObj ? parsedBody : {};

    // Periscope/Chatman の type 判定 (1 = 通常チャットコメント, 2/3等 = ハート・参加等の非チャットイベント)
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

    const profileImage = String(
      bodyObj.profileImageURL ||
        bodyObj.profileImageUrl ||
        bodyObj.profile_image_url ||
        payload.profileImageURL ||
        payload.profileImageUrl ||
        payload.profile_image_url ||
        sender.profile_image_url ||
        sender.profileImageUrl ||
        ''
    ).trim();

    const now = typeof options.now === 'number' ? options.now : Date.now();
    const timestamp = normalizeTimestamp(
      bodyObj.timestamp || payload.timestamp || outer.timestamp,
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

  function parseChatMessageElement(itemEl, options = {}) {
    if (!itemEl || itemEl.nodeType !== 1) return null;

    const custom = options.customSelectors || {};
    const nameFormat = options.nameFormat || 'display';

    // ユーザー名抽出
    let displayName = '';
    const authorSelectors = [];
    if (custom.author && custom.author.trim()) {
      authorSelectors.push(custom.author.trim());
    }
    authorSelectors.push(...DEFAULT_AUTHOR_SELECTORS);

    let authorEl = null;
    for (const selector of authorSelectors) {
      try {
        const el = itemEl.querySelector(selector);
        if (el) {
          const text = normalizeWhitespace(extractTextWithEmoji(el));
          if (text) {
            displayName = text;
            authorEl = el;
            break;
          }
        }
      } catch {
        // ignore invalid selector
      }
    }

    const handle = extractHandleFromElement(itemEl);
    if (!displayName && handle) {
      displayName = handle;
    }

    // 本文抽出
    let commentText = '';
    const messageSelectors = [];
    if (custom.message && custom.message.trim()) {
      messageSelectors.push(custom.message.trim());
    }
    messageSelectors.push(...DEFAULT_MESSAGE_SELECTORS);

    for (const selector of messageSelectors) {
      try {
        const els = itemEl.querySelectorAll(selector);
        for (const el of els) {
          if (authorEl && (el === authorEl || authorEl.contains(el))) {
            continue;
          }
          const text = normalizeWhitespace(extractTextWithEmoji(el));
          if (!text) continue;
          if (text === displayName || text === `@${handle}`) continue;
          commentText = text;
          break;
        }
        if (commentText) break;
      } catch {
        // ignore invalid selector
      }
    }

    // フォールバック: 行全体のテキストからユーザー名プレフィックスを除去
    if (!commentText) {
      const fullText = normalizeWhitespace(extractTextWithEmoji(itemEl));
      if (displayName && fullText.startsWith(displayName)) {
        commentText = normalizeWhitespace(fullText.slice(displayName.length).replace(/^[:：\s]+/, ''));
      } else {
        commentText = fullText;
      }
    }

    if (!commentText) return null;

    // 名前と @handle の整形
    const { cleanDisplayName, screenName, formattedName } = buildFormattedName(
      displayName,
      handle,
      nameFormat
    );

    const userId = handle || cleanDisplayName;
    const profileImage = extractProfileImage(itemEl);

    // オーナー / バッジ判定
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

  return {
    DEFAULT_CONTAINER_SELECTORS,
    DEFAULT_ITEM_SELECTORS,
    isXLivePage,
    extractTextWithEmoji,
    findChatContainer,
    findMessageElements,
    parseChatMessageElement,
    parseChatmanPayload,
    isSystemMessage,
    fnv1aHash,
  };
});
