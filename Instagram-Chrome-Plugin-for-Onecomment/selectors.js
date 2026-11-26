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
    '[aria-label*="ライブコメント" i]',
    '[aria-label*="Live comments" i]',
    '[aria-label*="コメント" i][role="region"]',
    '[aria-label*="Comments" i][role="region"]',
    '[role="log"]',
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
    'channels',
    'notifications',
  ]);

  const SYSTEM_PATTERNS = [
    /^参加しました[。!！]?$/,
    /^.+?(?:さんが|が)?(?:ライブ動画に)?参加しました[。!！]?$/,
    /^視聴を開始しました[。!！]?$/,
    /^.+?視聴を開始しました[。!！]?$/,
    /^視聴し始めました[。!！]?$/,
    /^.+?視聴し始めました[。!！]?$/,
    /^手を振りました[。!！]?$/,
    /^.+?手を振りました[。!！]?$/,
    /^.+?リクエスト(?:しました|を送信しました)[。!！]?$/,
    /^.+?フォローを始めました[。!！]?$/,
    /^joined(?:\s+your\s+live\s+video)?[.!]?$/i,
    /^.+?\s+joined(?:\s+your\s+live\s+video)?[.!]?$/i,
    /^started watching[.!]?$/i,
    /^.+?\s+started watching[.!]?$/i,
    /^waved[.!]?$/i,
    /^.+?\s+waved[.!]?$/i,
    /^requested to be in your live video[.!]?$/i,
    /^.+?\s+requested to be in your live video[.!]?$/i,
    /^.+?\s+started following you[.!]?$/i,
  ];

  const UI_NOISE_PATTERNS = [
    /^\d[\d,.\s万億kKmM]*\s*(?:人が視聴中|人視聴中|watching|viewers?|views?|件のいいね|likes?)$/i,
    /^(?:ライブ|LIVE|配信中|ライブ動画|Live video|コメント|Comments?|コメントを追加(?:\.{3}|…)?|Add a comment(?:\.{3}|…)?|投稿する?|Post|送信|Send|返信|Reply|フォローする|フォロー中|Follow|Following|いいね！?|Like|シェア|Share|ミュート|Mute|音声|Audio|閉じる|Close|オプション|Options)$/i,
  ];

  const COMMENT_INPUT_HINT_PATTERN = /コメント|メッセージ|comment|say something|message/i;

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

  function safeJsonParse(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    let trimmed = value.trim();
    if (!trimmed) return null;
    // Instagram API の XSSI プレフィックス対策
    if (trimmed.startsWith('for (;;);')) {
      trimmed = trimmed.slice(9).trim();
    }
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
      // プロフィール写真のaltは本文に含めない
      if (alt && /プロフィール写真|profile picture|avatar/i.test(alt)) {
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

  function isExcludedContainer(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV') {
      return true;
    }
    if (typeof el.querySelector === 'function') {
      if (el.querySelector('video')) return true;
    }
    return false;
  }

  function pickBestCommentListInside(parent, excludeEl) {
    if (!parent || typeof parent.querySelectorAll !== 'function') return null;
    const candidates = parent.querySelectorAll('div, ul, section');
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      if (excludeEl && (el === excludeEl || el.contains(excludeEl) || excludeEl.contains(el))) {
        continue;
      }
      if (isExcludedContainer(el)) continue;

      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (rect && (rect.height < 80 || rect.width < 140)) continue;

      const hasInputInside = el.querySelector
        ? Boolean(el.querySelector('textarea, input, [contenteditable="true"]'))
        : false;
      if (hasInputInside) continue;

      const scrollable = isScrollableElement(el);
      const childCount = el.children ? el.children.length : 0;
      const profileImgs = el.querySelectorAll
        ? el.querySelectorAll('img[alt*="プロフィール写真"], img[alt*="profile picture" i], img[src*="cdninstagram.com"], img[src*="fbcdn.net"]').length
        : 0;
      const userLinks = el.querySelectorAll ? el.querySelectorAll('a[href^="/"]').length : 0;

      let score = 0;
      if (scrollable) score += 15;
      if (profileImgs > 0) score += Math.min(12, profileImgs * 4);
      if (userLinks > 0) score += Math.min(8, userLinks * 2);
      if (childCount > 0) score += Math.min(6, childCount);
      if (rect && rect.height >= 140) score += 5;
      if (el.getAttribute && (el.getAttribute('role') === 'list' || el.getAttribute('role') === 'log')) {
        score += 8;
      }

      if (score > bestScore || (score === bestScore && best && best.contains(el))) {
        bestScore = score;
        best = el;
      }
    }

    return best && bestScore >= 8 ? { element: best, score: bestScore } : null;
  }

  function findChatContainerByInputHeuristic(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;

    const inputs = doc.querySelectorAll(
      'textarea, input[type="text"], input:not([type]), [contenteditable="true"]'
    );
    for (const input of inputs) {
      const placeholder = input.getAttribute('placeholder') || '';
      const ariaLabel = input.getAttribute('aria-label') || '';
      const combinedHint = `${placeholder} ${ariaLabel}`;
      if (combinedHint.trim() && !COMMENT_INPUT_HINT_PATTERN.test(combinedHint)) {
        continue;
      }

      let parent = input.parentElement;
      for (let depth = 0; depth < 14 && parent; depth += 1) {
        if (isExcludedContainer(parent)) break;
        const picked = pickBestCommentListInside(parent, input);
        if (picked) {
          return { element: picked.element, selector: 'heuristic:input-sibling' };
        }
        parent = parent.parentElement;
      }
    }

    return null;
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
        if (el && !isExcludedContainer(el)) {
          return { element: el, selector };
        }
      } catch {
        // ignore invalid selector
      }
    }

    const byInput = findChatContainerByInputHeuristic(doc);
    if (byInput) return byInput;

    return { element: null, selector: '' };
  }

  function isAvatarImageElement(img) {
    if (!img || typeof img.getAttribute !== 'function') return false;
    const src = img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || '';
    if (!src) return false;
    const lowerSrc = src.toLowerCase();
    if (lowerSrc.includes('/emoji/') || lowerSrc.includes('/rsrc.php')) {
      return false;
    }
    if (/プロフィール写真|profile picture|avatar/i.test(alt)) {
      return true;
    }
    return lowerSrc.includes('cdninstagram.com') || lowerSrc.includes('fbcdn.net');
  }

  function countAvatarImages(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return 0;
    try {
      const imgs = el.querySelectorAll('img[src]');
      let count = 0;
      for (const img of imgs) {
        if (isAvatarImageElement(img)) count += 1;
      }
      return count;
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
      const avatarCount = countAvatarImages(only);
      const onlyHasMultipleMessageChildren =
        grandChildren.length >= 2 &&
        (avatarCount >= 2 ||
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

  function extractUsernamesFromElement(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return [];
    const links = itemEl.querySelectorAll('a[href^="/"]');
    const names = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9._]{1,30})\/?(?:\?|$)/);
      if (match && !RESERVED_PATHS.has(match[1].toLowerCase())) {
        if (!names.includes(match[1])) {
          names.push(match[1]);
        }
      }
    }
    return names;
  }

  function extractProfileImage(itemEl) {
    if (!itemEl || typeof itemEl.querySelectorAll !== 'function') return '';
    const imgs = itemEl.querySelectorAll('img[src]');
    let fallbackSrc = '';
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      const cleanUrl = sanitizeHttpUrl(src);
      if (!cleanUrl) continue;
      if (
        /プロフィール写真|profile picture/i.test(alt) ||
        src.includes('cdninstagram.com') ||
        src.includes('fbcdn.net')
      ) {
        return cleanUrl;
      }
      if (!fallbackSrc && !src.includes('/emoji/')) {
        fallbackSrc = cleanUrl;
      }
    }
    return fallbackSrc;
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
        if (alt && !/プロフィール写真|profile picture|avatar/i.test(alt)) {
          segments.push(alt);
        }
        return;
      }
      const children = node.childNodes || [];
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

  function stripAuthorPrefix(text, displayName, username) {
    let out = normalizeWhitespace(text);
    if (!out) return '';

    const cleanName = String(displayName || '').trim();
    const cleanUsername = String(username || '').replace(/^@/, '').trim();

    for (let pass = 0; pass < 2; pass += 1) {
      const before = out;
      if (cleanName && out.startsWith(cleanName)) {
        const afterName = out.slice(cleanName.length);
        if (!afterName || /^[\s:：·・@]/.test(afterName)) {
          out = normalizeWhitespace(afterName.replace(/^[\s:：·・]+/, ''));
        }
      }
      if (cleanUsername) {
        const handleRe = new RegExp(`^@?${escapeRegExp(cleanUsername)}(?:[\\s:：·・]+)?`, 'i');
        if (handleRe.test(out)) {
          const candidate = normalizeWhitespace(out.replace(handleRe, ''));
          if (candidate !== out) {
            out = candidate;
          }
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

  function normalizeApiCommentObject(raw, { isSystemDefault = false, now = Date.now() } = {}) {
    if (!raw || typeof raw !== 'object') return null;

    const text = normalizeWhitespace(raw.text || raw.comment || raw.body || '');
    if (!text) return null;

    const user = raw.user && typeof raw.user === 'object' ? raw.user : {};
    const username = String(user.username || raw.username || '')
      .replace(/^@/, '')
      .trim();
    const fullName = String(user.full_name || user.fullName || raw.full_name || '').trim();
    const finalName = username || fullName;
    if (!finalName) return null;

    const userId = String(username || user.pk || user.id || raw.user_id || finalName).trim();
    const profileImage = sanitizeHttpUrl(
      user.profile_pic_url || user.profilePicUrl || raw.profile_pic_url || ''
    );
    const isVerified = Boolean(user.is_verified || raw.is_verified);
    const isOwner = Boolean(raw.is_broadcaster || raw.isOwner || user.is_broadcaster);
    const isSystem = Boolean(isSystemDefault || raw.is_system || isSystemMessage(text));

    const timestamp = normalizeTimestamp(
      raw.created_at_utc || raw.created_at || raw.timestamp,
      now
    );

    const pk = String(raw.pk || raw.id || '').trim();
    const bucket = Math.floor(timestamp / 30000);
    const id = pk
      ? `ig_live_api_${pk}`
      : `ig_live_${fnv1aHash(`${userId}|${text}|${bucket}`)}`;

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
      comment: text,
      profileImage,
      timestamp,
      isOwner,
      isModerator: false,
      hasGift: false,
      isSystem,
      badges,
    };
  }

  function collectApiCommentsFromNode(node, results, options, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return;

    if (Array.isArray(node)) {
      for (const item of node) {
        collectApiCommentsFromNode(item, results, options, depth + 1);
      }
      return;
    }

    if (Array.isArray(node.comments)) {
      for (const c of node.comments) {
        const parsed = normalizeApiCommentObject(c, { isSystemDefault: false, now: options.now });
        if (parsed) results.push(parsed);
      }
    }

    if (Array.isArray(node.system_comments)) {
      for (const c of node.system_comments) {
        const parsed = normalizeApiCommentObject(c, { isSystemDefault: true, now: options.now });
        if (parsed) results.push(parsed);
      }
    }

    if (node.comment && typeof node.comment === 'object') {
      const parsed = normalizeApiCommentObject(node.comment, { isSystemDefault: false, now: options.now });
      if (parsed) results.push(parsed);
    }

    if (node.pinned_comment && typeof node.pinned_comment === 'object') {
      const parsed = normalizeApiCommentObject(node.pinned_comment, { isSystemDefault: false, now: options.now });
      if (parsed) results.push(parsed);
    }

    // GraphQL のネスト構造にも対応（data 配下のみ再帰探索）
    if (node.data && typeof node.data === 'object') {
      collectApiCommentsFromNode(node.data, results, options, depth + 1);
    } else if (depth > 0) {
      for (const key of Object.keys(node)) {
        if (key === 'comments' || key === 'system_comments' || key === 'comment' || key === 'pinned_comment') {
          continue;
        }
        const val = node[key];
        if (val && typeof val === 'object') {
          collectApiCommentsFromNode(val, results, options, depth + 1);
        }
      }
    }
  }

  function parseLiveCommentsApiResponse(rawData, options = {}) {
    const parsed = safeJsonParse(rawData);
    if (!parsed || typeof parsed !== 'object') return [];
    const now = typeof options.now === 'number' ? options.now : Date.now();
    const results = [];
    collectApiCommentsFromNode(parsed, results, { now }, 0);
    return results;
  }

  function parseLiveCommentElement(itemEl, options = {}) {
    if (!itemEl || itemEl.nodeType !== 1) return null;

    if (typeof itemEl.querySelector === 'function') {
      if (itemEl.querySelector('video, textarea, input')) {
        return null;
      }
    }

    // 複数コメントを含む親コンテナを誤って1件としてパースしないように除外
    if (countAvatarImages(itemEl) >= 2) {
      return null;
    }

    const custom = options.customSelectors || {};

    const usernames = extractUsernamesFromElement(itemEl);
    if (usernames.length > 2) {
      return null;
    }
    let username = usernames[0] || '';
    const profileImage = extractProfileImage(itemEl);
    let authorEl = null;

    const authorSelectors = [];
    if (custom.author && custom.author.trim()) {
      authorSelectors.push(custom.author.trim());
    }
    authorSelectors.push(...DEFAULT_AUTHOR_SELECTORS);

    let displayName = '';
    for (const selector of authorSelectors) {
      try {
        const els =
          typeof itemEl.querySelectorAll === 'function'
            ? Array.from(itemEl.querySelectorAll(selector))
            : [];
        for (const el of els) {
          const text = normalizeWhitespace(extractTextWithEmoji(el));
          if (!text || isUiNoiseText(text)) continue;
          if (text.length > 60 && selector === 'a[href^="/"]') continue;
          displayName = text;
          authorEl = el;
          break;
        }
        if (displayName) break;
      } catch {
        // ignore invalid selector
      }
    }

    let finalName = displayName || username;
    let commentText = '';

    // 本文抽出（標準セレクタ）
    if (finalName) {
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
            if (rawText === finalName || rawText === username) continue;
            const cleaned = stripAuthorPrefix(rawText, finalName, username);
            if (!cleaned || isUiNoiseText(cleaned)) continue;
            commentText = cleaned;
            break;
          }
          if (commentText) break;
        } catch {
          // ignore invalid selector
        }
      }
    }

    // フォールバック: <a>タグを使わない行構造や、先頭ユーザー名除去
    const hasAvatarImg = Boolean(profileImage || (itemEl.querySelector && itemEl.querySelector('img')));
    if (!finalName || !commentText) {
      const segments = collectLeafTextSegments(itemEl).filter((s) => !isUiNoiseText(s));
      if (!finalName && segments.length >= 2) {
        const candidateAuthor = segments[0];
        const candidateBody = segments.slice(1).join(' ').trim();
        if (
          candidateAuthor.length <= 40 &&
          candidateBody.length > 0 &&
          candidateBody.length <= 500 &&
          (hasAvatarImg || username)
        ) {
          finalName = candidateAuthor;
          if (!username && /^[A-Za-z0-9._]{1,30}$/.test(candidateAuthor)) {
            username = candidateAuthor;
          }
          commentText = candidateBody;
        }
      } else if (!finalName && segments.length === 1 && hasAvatarImg) {
        const single = segments[0];
        if (isSystemMessage(single)) {
          return {
            id: `ig_live_${fnv1aHash(`system|${single}|${Math.floor((typeof options.now === 'number' ? options.now : Date.now()) / 30000)}`)}`,
            userId: 'system',
            name: 'システム',
            screenName: '',
            comment: single,
            profileImage,
            timestamp: typeof options.now === 'number' ? options.now : Date.now(),
            isOwner: false,
            isModerator: false,
            hasGift: false,
            isSystem: true,
            badges: [],
          };
        }
        const splitMatch = single.match(/^@?([A-Za-z0-9._]{1,30})\s+(.+)$/);
        if (splitMatch) {
          const candidateAuthor = splitMatch[1];
          const candidateBody = normalizeWhitespace(splitMatch[2]);
          if (candidateBody && candidateBody.length <= 500 && !isUiNoiseText(candidateBody)) {
            finalName = candidateAuthor;
            if (!username) username = candidateAuthor;
            commentText = candidateBody;
          }
        }
      } else if (finalName && !commentText) {
        const remainingSegments = segments.filter((seg) => {
          return seg !== finalName && seg !== username && seg !== `@${username}`;
        });
        if (remainingSegments.length > 0) {
          const joined = normalizeWhitespace(remainingSegments.join(' '));
          const cleaned = stripAuthorPrefix(joined, finalName, username);
          if (cleaned && cleaned !== finalName && cleaned !== username && !isUiNoiseText(cleaned)) {
            commentText = cleaned;
          }
        }
        if (!commentText) {
          const fullText = normalizeWhitespace(extractTextWithEmoji(itemEl));
          if (fullText.length <= 600) {
            const rest = stripAuthorPrefix(fullText, finalName, username);
            if (rest && rest !== fullText && rest !== finalName && rest !== username && !isUiNoiseText(rest)) {
              commentText = rest;
            }
          }
        }
      }
    }

    if (commentText) {
      commentText = stripAuthorPrefix(commentText, finalName, username);
    }

    if (!finalName) return null;
    if (!commentText || isUiNoiseText(commentText)) return null;
    if (commentText === finalName || commentText === username) return null;

    const userId = username || finalName;
    const isVerified = Boolean(
      itemEl.querySelector('svg[aria-label*="認証" i], svg[aria-label*="Verified" i]')
    );
    const isOwner = Boolean(
      itemEl.querySelector('[aria-label*="ホスト" i], [aria-label*="Host" i]')
    );
    const itemText = normalizeWhitespace(itemEl.textContent || '');
    const isSystem = isSystemMessage(commentText) || isSystemMessage(itemText);

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

  function collectDomDiagnostics(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return {};

    const inputs = Array.from(
      doc.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')
    )
      .slice(0, 8)
      .map((el) => ({
        tag: el.tagName,
        testid: el.getAttribute('data-testid') || '',
        placeholder: (el.getAttribute('placeholder') || '').slice(0, 40),
        aria: (el.getAttribute('aria-label') || '').slice(0, 40),
      }));

    const iframes = Array.from(doc.querySelectorAll('iframe'))
      .slice(0, 5)
      .map((f) => (f.getAttribute('src') || '').split('?')[0]);

    const found = findChatContainer(doc, '');
    let containerInfo = null;
    if (found.element) {
      const rect =
        typeof found.element.getBoundingClientRect === 'function'
          ? found.element.getBoundingClientRect()
          : null;
      const sampleChildren = Array.from(found.element.children || [])
        .slice(-3)
        .map((c) => {
          const parsed = parseLiveCommentElement(c);
          return {
            tag: c.tagName,
            testid: c.getAttribute('data-testid') || '',
            text: normalizeWhitespace(extractTextWithEmoji(c)).slice(0, 80),
            hasImg: Boolean(c.querySelector && c.querySelector('img')),
            hasLink: Boolean(c.querySelector && c.querySelector('a[href^="/"]')),
            parsed: parsed
              ? {
                  name: parsed.name,
                  comment: parsed.comment.slice(0, 50),
                  isSystem: parsed.isSystem,
                  hasProfileImage: Boolean(parsed.profileImage),
                }
              : null,
          };
        });
      const resolvedItems = findMessageElements(found.element, '');
      const sampleItems = resolvedItems.slice(-3).map((item) => {
        const parsed = parseLiveCommentElement(item);
        return {
          tag: item.tagName,
          testid: item.getAttribute ? item.getAttribute('data-testid') || '' : '',
          childCount: item.children ? item.children.length : 0,
          avatarImgCount: countAvatarImages(item),
          usernames: extractUsernamesFromElement(item).slice(0, 4),
          leafSegments: collectLeafTextSegments(item).slice(0, 6),
          text: normalizeWhitespace(extractTextWithEmoji(item)).slice(0, 100),
          parsed: parsed
            ? {
                name: parsed.name,
                comment: parsed.comment.slice(0, 50),
                isSystem: parsed.isSystem,
                hasProfileImage: Boolean(parsed.profileImage),
              }
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
      iframes,
      containerInfo,
    };
  }

  return {
    DEFAULT_CONTAINER_SELECTORS,
    DEFAULT_ITEM_SELECTORS,
    isInstagramLivePage,
    isUiNoiseText,
    extractTextWithEmoji,
    countAvatarImages,
    findChatContainer,
    findMessageElements,
    parseLiveCommentElement,
    parseLiveCommentsApiResponse,
    stripAuthorPrefix,
    collectDomDiagnostics,
    isSystemMessage,
    fnv1aHash,
  };
});
