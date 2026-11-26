(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.InstagramLiveSelectors = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_CONTAINER_SELECTORS = [
    '[data-testid="live-comments-container"]',
    '[aria-label*="コメント" i][role="region"]',
    '[aria-label*="Comments" i][role="region"]',
    '[aria-label*="ライブコメント" i]',
    '[aria-label*="Live comments" i]',
    '[role="log"]',
    'section ul',
  ];

  const DEFAULT_ITEM_SELECTORS = [
    '[data-testid="live-comment-item"]',
    '[role="listitem"]',
    'li',
  ];

  const DEFAULT_AUTHOR_SELECTORS = [
    'a[href^="/"] span',
    'a[href^="/"]',
    'h3',
    'strong',
  ];

  const DEFAULT_MESSAGE_SELECTORS = [
    '[data-testid="live-comment-text"]',
    'span[dir="auto"]',
    'div[dir="auto"]',
    'span',
  ];

  const RESERVED_PATHS = new Set([
    'explore',
    'reels',
    'direct',
    'stories',
    'accounts',
    'p',
    'reel',
    'tv',
    'live',
    'about',
    'legal',
    'developer',
  ]);

  const SYSTEM_PATTERNS = [
    /^参加しました[。!！]?$/,
    /^.+?(?:さんが)?参加しました[。!！]?$/,
    /^視聴を開始しました[。!！]?$/,
    /^.+?視聴を開始しました[。!！]?$/,
    /^手を振りました[。!！]?$/,
    /^.+?手を振りました[。!！]?$/,
    /^.+?リクエストしました[。!！]?$/,
    /^.+?フォローを始めました[。!！]?$/,
    /^joined[.!]?$/i,
    /^.+? joined[.!]?$/i,
    /^started watching[.!]?$/i,
    /^waved[.!]?$/i,
    /^.+? waved[.!]?$/i,
    /^requested to be in your live video[.!]?$/i,
    /^.+? started following you[.!]?$/i,
  ];

  function isInstagramLivePage(urlString) {
    if (typeof urlString !== 'string') return false;
    try {
      const url = new URL(urlString);
      const host = url.hostname.toLowerCase();
      if (host !== 'www.instagram.com' && host !== 'instagram.com') {
        return false;
      }
      const path = url.pathname.toLowerCase();
      return /^\/[^/]+\/live(?:\/|$)/.test(path) || path.startsWith('/live/');
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
      // プロフィール写真のaltは本文に含めない
      if (alt && /プロフィール写真|profile picture/i.test(alt)) {
        return '';
      }
      return alt || '';
    }
    if (tag === 'BR') {
      return ' ';
    }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'BUTTON') {
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
        // ignore invalid selector
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

    return Array.from(rootEl.children || []).filter((child) => child && child.nodeType === 1);
  }

  function extractUsernameFromHref(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return '';
    const links = itemEl.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9._]{1,30})\/?(?:\?|$)/);
      if (match && !RESERVED_PATHS.has(match[1].toLowerCase())) {
        return match[1];
      }
    }
    return '';
  }

  function extractProfileImage(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return '';
    const imgs = itemEl.querySelectorAll('img[src]');
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      if (
        /プロフィール写真|profile picture/i.test(alt) ||
        src.includes('cdninstagram.com') ||
        src.includes('fbcdn.net')
      ) {
        return src;
      }
    }
    return '';
  }

  function isSystemMessage(text) {
    const trimmed = normalizeWhitespace(text);
    if (!trimmed) return false;
    return SYSTEM_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  function parseLiveCommentElement(itemEl, options = {}) {
    if (!itemEl || itemEl.nodeType !== 1) return null;

    const custom = options.customSelectors || {};

    // ユーザー名抽出
    let username = extractUsernameFromHref(itemEl);
    let authorEl = null;

    const authorSelectors = [];
    if (custom.author && custom.author.trim()) {
      authorSelectors.push(custom.author.trim());
    }
    authorSelectors.push(...DEFAULT_AUTHOR_SELECTORS);

    let displayName = '';
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

    const finalName = displayName || username;
    if (!finalName) return null;

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
          if (authorEl && (el === authorEl || authorEl.contains(el) || el.contains(authorEl))) {
            continue;
          }
          const text = normalizeWhitespace(extractTextWithEmoji(el));
          if (!text) continue;
          if (text === finalName || text === username) continue;
          commentText = text;
          break;
        }
        if (commentText) break;
      } catch {
        // ignore invalid selector
      }
    }

    // フォールバック: 行全体テキストから先頭のユーザー名を除去
    if (!commentText) {
      const fullText = normalizeWhitespace(extractTextWithEmoji(itemEl));
      if (fullText.startsWith(finalName)) {
        commentText = normalizeWhitespace(fullText.slice(finalName.length).replace(/^[:：\s]+/, ''));
      } else if (username && fullText.startsWith(username)) {
        commentText = normalizeWhitespace(fullText.slice(username.length).replace(/^[:：\s]+/, ''));
      }
    }

    if (!commentText) return null;

    const userId = username || finalName;
    const profileImage = extractProfileImage(itemEl);
    const isVerified = Boolean(
      itemEl.querySelector('svg[aria-label*="認証" i], svg[aria-label*="Verified" i]')
    );
    const isOwner = Boolean(
      itemEl.querySelector('[aria-label*="ホスト" i], [aria-label*="Host" i]')
    );
    const isSystem = isSystemMessage(commentText);

    const domId =
      itemEl.getAttribute('data-comment-id') ||
      itemEl.getAttribute('data-id') ||
      itemEl.id ||
      '';

    const now = typeof options.now === 'number' ? options.now : Date.now();
    // Instagram Liveの仮想DOM再利用に備え、30秒バケットで重複判定
    const bucket = Math.floor(now / 30000);
    const id = domId
      ? `ig_live_${domId}`
      : `ig_live_${fnv1aHash(`${userId}|${commentText}|${bucket}`)}`;

    const badges = [];
    if (isOwner) {
      badges.push({ url: '', label: '配信者', type: 'owner' });
    }
    if (isVerified) {
      badges.push({ url: '', label: '認証済み', type: 'verified' });
    }

    return {
      id,
      userId,
      name: finalName,
      screenName: username ? `@${username}` : '',
      comment: commentText,
      profileImage,
      timestamp: now,
      isOwner,
      isModerator: false,
      hasGift: false,
      isSystem,
      badges,
    };
  }

  return {
    DEFAULT_CONTAINER_SELECTORS,
    DEFAULT_ITEM_SELECTORS,
    isInstagramLivePage,
    extractTextWithEmoji,
    findChatContainer,
    findMessageElements,
    parseLiveCommentElement,
    isSystemMessage,
  };
});
