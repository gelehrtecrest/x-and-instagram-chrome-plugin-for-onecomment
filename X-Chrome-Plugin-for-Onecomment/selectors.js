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
        path.includes('/status/') ||
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

  function findChatContainer(doc, customContainerSelector) {
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
    if (!itemEl || typeof itemEl.querySelector !== 'function') return '';
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
    const cleanDisplayName = displayName.replace(/\s*@[A-Za-z0-9_]+$/, '').trim() || handle || 'Xユーザー';
    const screenName = handle ? `@${handle}` : '';
    const formattedName =
      nameFormat === 'both' && screenName && cleanDisplayName !== handle
        ? `${cleanDisplayName} (${screenName})`
        : cleanDisplayName;

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
    isSystemMessage,
  };
});
