// PocketOption DOM automation — runs in the page context (content script).
(function () {
  if (window.UtkTradeEngine) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

  const normCurrencyKey = (s) => {
    const raw = String(s || '').toUpperCase();
    const wantOtc = raw.includes('OTC');
    const key = raw.replace(/OTC/g, '').replace(/\s+/g, '').replace('/', '');
    return { wantOtc, key, raw: raw.trim() };
  };

  const isVisible = (el) => {
    try {
      if (!el || el.offsetParent === null) return false;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      if (!style) return true;
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
      return true;
    } catch {
      return false;
    }
  };

  const isDisabled = (el) => {
    try {
      if (!el) return { disabled: false };
      const aria = el.getAttribute && el.getAttribute('aria-disabled');
      if (aria === 'true') return { disabled: true, reason: 'aria-disabled' };
      if (el.disabled === true) return { disabled: true, reason: 'disabled_prop' };
      const cls = String(el.className || '').toLowerCase();
      if (cls.includes('disabled') || cls.includes('is-disabled')) return { disabled: true, reason: 'class_disabled' };
      return { disabled: false };
    } catch {
      return { disabled: false };
    }
  };

  const queryAllDeep = (root, selector) => {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      try {
        if (node.querySelectorAll) {
          node.querySelectorAll(selector).forEach((el) => out.push(el));
        }
        if (node.shadowRoot) walk(node.shadowRoot);
        Array.from(node.children || []).forEach(walk);
      } catch {}
    };
    walk(root || document);
    return out;
  };

  const firstVisible = (selectors, root) => {
    const scope = root || document;
    for (const sel of selectors) {
      try {
        const nodes = sel.includes(' ') || sel.startsWith('.') || sel.startsWith('[')
          ? Array.from(scope.querySelectorAll(sel))
          : queryAllDeep(scope, sel);
        for (const el of nodes) {
          if (isVisible(el)) return el;
        }
      } catch {}
    }
    return null;
  };

  const CURRENCY_DROPDOWN_SELECTORS = [
    '.pair-number-wrap a',
    '.currencies-block__in a',
    '.pair-number-wrap',
    '[data-toggle-dropdown]',
    '[data-test="asset-select"]',
    '[data-testid="asset-select"]',
    '[data-test="current-asset"]',
    '[aria-label*="Asset" i]',
    '[aria-label*="Currency" i]',
    '[aria-label*="Pair" i]',
    '[class*="current-asset" i]',
    '[class*="asset-current" i]',
    '[class*="pair-number" i] a',
    'button[class*="pair" i]',
    'button[class*="asset" i]',
    'div[class*="pair" i] a',
    'div[class*="asset" i] a',
    '[class*="instrument" i] a',
    '[class*="symbol" i] a'
  ];

  const BET_AMOUNT_BLOCK_SELECTORS = [
    '.block--bet-amount',
    '[class*="bet-amount" i]',
    '[class*="deal-amount" i]'
  ];

  const BET_INPUT_SELECTORS = [
    '.block--bet-amount .value input',
    '.block--bet-amount input',
    '.block--bet-amount .value__val input',
    '.value__val input',
    'input[name*="amount" i]',
    'input[id*="amount" i]',
    'input[aria-label*="amount" i]',
    'input[placeholder*="amount" i]',
    'input[placeholder*="invest" i]',
    'input[data-test*="amount" i]',
    'input[autocomplete="off"]'
  ];

  const TRADE_PANEL_SELECTORS = [
    '.action-high-low',
    '.deal-panel',
    '.trading-panel',
    '[class*="trade-panel" i]',
    '[class*="deal-form" i]',
    '[class*="right-sidebar" i]'
  ];

  function findTradePanel() {
    for (const sel of TRADE_PANEL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return document;
  }

  function getCurrencyItems() {
    let items = Array.from(document.querySelectorAll('li.alist__item'));
    if (items.length) return { kind: 'li.alist__item', items };
    items = Array.from(document.querySelectorAll('a.alist__link'));
    if (items.length) return { kind: 'a.alist__link', items };
    items = Array.from(document.querySelectorAll(
      '[role="listbox"] [role="option"], [role="listbox"] [role="menuitem"], [role="menu"] [role="menuitem"]'
    ));
    if (items.length) return { kind: 'aria', items };
    items = Array.from(document.querySelectorAll('[class*="asset-item" i], [class*="currency-item" i], [class*="pairs-item" i]'));
    if (items.length) return { kind: 'class-fallback', items };
    return { kind: 'none', items: [] };
  }

  async function clickAwayFromInputs() {
    try {
      const pts = [
        { x: Math.floor(window.innerWidth * 0.5), y: Math.floor(window.innerHeight * 0.5) },
        { x: Math.floor(window.innerWidth * 0.5), y: Math.floor(window.innerHeight * 0.6) },
        { x: Math.floor(window.innerWidth * 0.5), y: Math.floor(window.innerHeight * 0.4) },
        { x: Math.floor(window.innerWidth * 0.4), y: Math.floor(window.innerHeight * 0.5) },
        { x: Math.floor(window.innerWidth * 0.6), y: Math.floor(window.innerHeight * 0.5) }
      ];
      for (const p of pts) {
        const el = document.elementFromPoint(p.x, p.y);
        if (!el) continue;
        const interactive = el.closest && el.closest('input,textarea,select,button,a,[role="button"],[contenteditable="true"]');
        if (interactive) continue;
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: p.x, clientY: p.y }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: p.x, clientY: p.y }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: p.x, clientY: p.y }));
        return;
      }
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
    } catch {}
  }

  function findBetAmountBlock() {
    const panel = findTradePanel();
    const scopes = panel === document ? [document] : [panel, document];
    for (const scope of scopes) {
      for (const sel of BET_AMOUNT_BLOCK_SELECTORS) {
        try {
          const el = scope.querySelector(sel);
          if (el && isVisible(el)) return el;
        } catch {}
      }
    }
    return null;
  }

  function parseBetNumber(val) {
    const n = Number(String(val || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function betsMatch(got, intended) {
    const a = parseBetNumber(got);
    const b = parseBetNumber(intended);
    return a != null && b != null && Math.abs(a - b) < 0.011;
  }

  function setNativeInputValue(input, value) {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      const setter = desc && desc.set;
      if (setter) setter.call(input, value);
      else input.value = value;
    } catch {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findBetInput() {
    const block = findBetAmountBlock();
    const scopes = [];
    if (block) scopes.push(block);
    const panel = findTradePanel();
    if (panel && panel !== document) scopes.push(panel);
    scopes.push(document);

    const seen = new Set();
    for (const scope of scopes) {
      if (!scope) continue;
      for (const sel of BET_INPUT_SELECTORS) {
        try {
          const els = Array.from(scope.querySelectorAll(sel));
          for (const el of els) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (!isVisible(el)) continue;
            if (el.disabled || el.readOnly) continue;
            const inTime = el.closest && el.closest('[class*="timer" i],[class*="time" i],[class*="expiration" i],[class*="expiry" i]');
            if (inTime) continue;
            const val = el.value || '';
            if (String(val).includes(':')) continue;
            if (block && !block.contains(el) && sel === 'input[autocomplete="off"]') continue;
            return el;
          }
        } catch {}
      }
    }
    return null;
  }

  async function activateBetInput() {
    const block = findBetAmountBlock();
    if (block) {
      const openers = ['.value', '.control__value', '.control', '.value-wrap', '[class*="value" i]'];
      for (const sel of openers) {
        try {
          const el = block.querySelector(sel);
          if (el && isVisible(el)) {
            try { el.click(); } catch {}
            await sleep(30);
            const input = findBetInput();
            if (input) return input;
          }
        } catch {}
      }
    }
    return findBetInput();
  }

  async function writeBetInput(betInput, amount, fast) {
    const intended = String(Number(amount));
    const delay = fast ? 12 : 60;

    try { betInput.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    try { betInput.click(); } catch {}
    try { betInput.focus(); } catch {}
    try { betInput.select(); } catch {}
    await sleep(fast ? 20 : 80);

    setNativeInputValue(betInput, '');
    await sleep(fast ? 15 : 50);

    for (const ch of intended) {
      const next = String(betInput.value || '') + ch;
      setNativeInputValue(betInput, next);
      betInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      betInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(delay);
    }

    betInput.dispatchEvent(new Event('blur', { bubbles: true }));
    try { betInput.blur(); } catch {}
    await sleep(fast ? 20 : 80);
    await clickAwayFromInputs();

    const got = String(betInput.value || '').trim();
    return { success: betsMatch(got, intended), value: got, intended };
  }

  async function setBetSizeFast(amount) {
    const betSizeNum = Number(amount);
    if (!Number.isFinite(betSizeNum) || betSizeNum <= 0) {
      return { success: false, error: 'invalid_bet_size' };
    }

    let betInput = await activateBetInput();
    if (!betInput) {
      return { success: false, error: 'bet_input_not_found' };
    }

    const result = await writeBetInput(betInput, betSizeNum, true);
    return { ...result, fast: true };
  }

  async function setBetSize(amount) {
    const betSizeNum = Number(amount);
    if (!Number.isFinite(betSizeNum) || betSizeNum <= 0) {
      return { success: false, error: 'invalid_bet_size' };
    }

    await sleep(120);
    let betInput = await activateBetInput();
    if (!betInput) {
      console.warn('[UtkTrade] Bet input not found');
      return { success: false, error: 'bet_input_not_found' };
    }

    let result = await writeBetInput(betInput, betSizeNum, false);
    if (!result.success) {
      console.warn('[UtkTrade] Bet verify failed, retrying:', result);
      betInput = await activateBetInput();
      if (betInput) result = await writeBetInput(betInput, betSizeNum, false);
    }

    return result;
  }

  async function selectCurrency(currencyArg, betSizeArg, opts) {
    const want = normCurrencyKey(currencyArg);
    if (!want.key) return { success: false, error: 'invalid_currency' };

    console.log('[UtkTrade] Selecting currency:', currencyArg);

    const dropdownEl = firstVisible(CURRENCY_DROPDOWN_SELECTORS);
    if (!dropdownEl) {
      console.warn('[UtkTrade] Currency dropdown not found');
      return { success: false, error: 'dropdown_not_found' };
    }

    try { dropdownEl.click(); } catch (e) {
      console.warn('[UtkTrade] Dropdown click failed:', e.message);
    }
    await sleep(700);

    const { items } = getCurrencyItems();
    let found = false;

    for (const item of items) {
      const labelEl = item.querySelector ? item.querySelector('span.alist__label') : null;
      const txtRaw = String((labelEl ? labelEl.textContent : item.textContent) || '').toUpperCase().trim();
      if (!txtRaw) continue;

      const itemKey = normCurrencyKey(txtRaw);
      if (want.wantOtc !== itemKey.wantOtc) continue;
      if (itemKey.key !== want.key) continue;

      const link = (item.matches && item.matches('a,button')) ? item
        : (item.querySelector && item.querySelector('a.alist__link, a, button, [role="option"], [role="menuitem"]'));
      const clickable = link || item;
      try { clickable.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      await sleep(100);
      try { clickable.click(); } catch {}
      found = true;
      await sleep(900);
      break;
    }

    if (!found) {
      console.warn('[UtkTrade] Currency not found:', currencyArg);
      return { success: false, error: 'currency_not_found', currency: currencyArg };
    }

    if (betSizeArg != null) {
      const betSetter = (opts && opts.fastBet) ? setBetSizeFast : setBetSize;
      let betRes = await betSetter(betSizeArg);
      if (betRes && betRes.success !== true && opts && opts.fastBet) {
        betRes = await setBetSize(betSizeArg);
      }
      return { success: true, currency: currencyArg, bet: betRes };
    }

    return { success: true, currency: currencyArg };
  }

  function findClickable(node) {
    if (!node) return null;
    try { if (node.tagName === 'A' || node.tagName === 'BUTTON') return node; } catch {}
    const inside = (node.querySelector && node.querySelector('a,button,[role="button"]')) || null;
    if (inside) return inside;
    const up = (node.closest && node.closest('a,button,[role="button"]')) || null;
    return up || node;
  }

  function findTradeButton(isBuy) {
    const panel = findTradePanel();
    const scope = panel === document ? document : panel;

    const baseXpathA = isBuy
      ? '/html/body/div[4]/div[2]/div[4]/div/div/div/div[1]/div/div[5]/div/div/div[2]/div/div[2]/div[2]/div[1]/a'
      : '/html/body/div[4]/div[2]/div[4]/div/div/div/div[1]/div/div[5]/div/div/div[2]/div/div[2]/div[2]/div[2]/a';
    const baseXpath = baseXpathA.replace(/\/a\s*$/i, '');
    const xpaths = [
      baseXpathA, baseXpath, baseXpath + '/a', baseXpath + '//a',
      baseXpath + '//button', baseXpath + '//*[@role="button"]'
    ];
    for (const xp of xpaths) {
      try {
        const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const node = result.singleNodeValue;
        if (node && isVisible(node)) return { node, strategy: 'xpath', detail: xp };
      } catch {}
    }

    const selectorGroups = isBuy
      ? [
          '.action-high-low.button-call-wrap a.btn.btn-call',
          'a.btn.btn-call', 'a.btn-call', 'button.btn-call', '.btn-call',
          '[data-test="call-button"]', '[data-testid="call-button"]',
          '[class*="button-call" i] a', '[class*="btn-call" i]'
        ]
      : [
          '.action-high-low.button-put-wrap a.btn.btn-put',
          'a.btn.btn-put', 'a.btn-put', 'button.btn-put', '.btn-put',
          '[data-test="put-button"]', '[data-testid="put-button"]',
          '[class*="button-put" i] a', '[class*="btn-put" i]'
        ];

    for (const sel of selectorGroups) {
      try {
        const el = scope.querySelector(sel) || document.querySelector(sel);
        if (el && isVisible(el)) return { node: el, strategy: 'selector', detail: sel };
      } catch {}
    }

    const want = isBuy ? ['buy', 'higher', 'call', 'up'] : ['sell', 'lower', 'put', 'down'];
    const candidates = Array.from(scope.querySelectorAll('a,button,[role="button"],div[role="button"],span[role="button"]'));
    const scored = [];
    for (const el of candidates) {
      try {
        const txt = String(el.innerText || el.textContent || '').trim().toLowerCase();
        const cls = String(el.className || '').toLowerCase();
        const hay = txt + ' ' + cls;
        let score = 0;
        for (const tok of want) if (hay.includes(tok)) score += 2;
        if (score <= 0) continue;
        const r = el.getBoundingClientRect();
        if (r && r.width > 20 && r.height > 12) score += 1;
        const disabled = isDisabled(el);
        if (disabled.disabled) score -= 3;
        scored.push({ el, score });
      } catch {}
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length && scored[0].score > 0) {
      return { node: scored[0].el, strategy: 'heuristic', detail: 'token_match' };
    }

    return null;
  }

  function findUnobstructedPoint(el) {
    try {
      const rect = el.getBoundingClientRect();
      const pts = [
        { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5, name: 'center' },
        { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.35, name: 'upper' },
        { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.65, name: 'lower' },
        { x: rect.left + rect.width * 0.3, y: rect.top + rect.height * 0.5, name: 'left' },
        { x: rect.left + rect.width * 0.7, y: rect.top + rect.height * 0.5, name: 'right' }
      ];
      for (const p of pts) {
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        const top = document.elementFromPoint(x, y);
        if (!top) continue;
        if (top === el || (el.contains && el.contains(top))) return { x, y, pick: p.name, covered: false };
        const topClickable = (top.closest && top.closest('a,button,[role="button"]')) || top;
        if (topClickable === el || (el.contains && el.contains(topClickable))) return { x, y, pick: p.name, covered: false };
      }
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      const top = document.elementFromPoint(cx, cy);
      return {
        x: cx, y: cy, pick: 'center_fallback', covered: !!(top && top !== el && !(el.contains && el.contains(top))),
        coverTag: top ? String(top.tagName || '') : null
      };
    } catch {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), pick: 'center_exception' };
    }
  }

  function performClick(el, point, opts) {
    const options = opts || {};
    if (!el) return false;
    if (!options.noScroll) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    }
    const x = point && Number.isFinite(point.x) ? point.x : null;
    const y = point && Number.isFinite(point.y) ? point.y : null;

    if (x != null && y != null) {
      const target = document.elementFromPoint(x, y);
      const clickable = (target && target.closest && target.closest('a,button,[role="button"]')) || findClickable(el) || el;
      try {
        const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', clientX: x, clientY: y });
        const pu = new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', clientX: x, clientY: y });
        clickable.dispatchEvent(pd);
        clickable.dispatchEvent(pu);
        clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
        return true;
      } catch {}
    }

    try { (findClickable(el) || el).click(); return true; } catch {}
    return false;
  }

  const BTN_CACHE_MS = 45000;
  let cachedBuyBtn = null;
  let cachedSellBtn = null;
  let cachedBtnAt = 0;

  function rememberTradeButton(isBuy, node) {
    if (!node) return;
    if (isBuy) cachedBuyBtn = node;
    else cachedSellBtn = node;
    cachedBtnAt = Date.now();
  }

  function getCachedTradeButton(isBuy) {
    if (Date.now() - cachedBtnAt > BTN_CACHE_MS) return null;
    const node = isBuy ? cachedBuyBtn : cachedSellBtn;
    if (!node || !isVisible(node)) return null;
    const clickable = findClickable(node);
    if (isDisabled(clickable).disabled) return null;
    return clickable;
  }

  function clickTradeButton(isBuy, opts) {
    const options = opts || {};
    const noScroll = options.noScroll === true;
    let clickable = options.cachedNode || getCachedTradeButton(isBuy);
    let foundMeta = options.cachedNode ? { strategy: 'cache', detail: 'warm' } : null;

    if (!clickable) {
      const foundBtn = findTradeButton(isBuy);
      if (!foundBtn || !foundBtn.node) return null;
      foundMeta = foundBtn;
      clickable = findClickable(foundBtn.node);
      rememberTradeButton(isBuy, foundBtn.node);
    }

    if (!clickable || isDisabled(clickable).disabled || !isVisible(clickable)) return null;

    const point = findUnobstructedPoint(clickable);
    const clicked = performClick(clickable, point, { noScroll });
    return clicked ? { clickable, point, foundMeta, clicked } : null;
  }

  async function executeTrade(sideArg, betSizeArg, sentAtArg, signalAtArg, opts) {
    const options = opts || {};
    const useFastBet = options.fastBet === true;
    const skipBet = options.skipBet === true && !useFastBet;
    const clickOnly = options.clickOnly === true;
    const t0 = Date.now();
    const isBuy = String(sideArg || '').toUpperCase() === 'BUY';
    const side = isBuy ? 'BUY' : 'SELL';

    if (clickOnly) {
      const instant = clickTradeButton(isBuy, { noScroll: true });
      if (instant && instant.clicked) {
        const t1 = Date.now();
        return {
          success: true,
          found: true,
          side,
          clicked: true,
          point: instant.point,
          meta: {
            strategy: instant.foundMeta && instant.foundMeta.strategy,
            detail: instant.foundMeta && instant.foundMeta.detail,
            pointPick: instant.point.pick || null,
            lagFromSentMs: Number.isFinite(sentAtArg) ? (t1 - sentAtArg) : null,
            lagFromSignalMs: Number.isFinite(signalAtArg) ? (t1 - signalAtArg) : null,
            execMs: t1 - t0,
            clickOnly: true,
            attempts: 1
          }
        };
      }
    }

    if (!skipBet && betSizeArg != null) {
      let betRes = null;
      try {
        if (useFastBet) betRes = await setBetSizeFast(betSizeArg);
        else betRes = await setBetSize(betSizeArg);
        if (betRes && betRes.success !== true && useFastBet) {
          betRes = await setBetSize(betSizeArg);
        }
      } catch {}
    }

    const deadline = Date.now() + (clickOnly ? 400 : 1200);
    let lastFound = null;

    for (let attempt = 0; Date.now() < deadline; attempt++) {
      const foundBtn = findTradeButton(isBuy);
      if (foundBtn && foundBtn.node) {
        lastFound = foundBtn;
        const clickable = findClickable(foundBtn.node);
        const disabledInfo = isDisabled(clickable);
        if (!disabledInfo.disabled && isVisible(clickable)) {
          const point = findUnobstructedPoint(clickable);
          const t1 = Date.now();
          const clicked = performClick(clickable, point, { noScroll: clickOnly });
          rememberTradeButton(isBuy, foundBtn.node);
          return {
            success: clicked,
            found: true,
            side,
            clicked,
            point,
            meta: {
              strategy: foundBtn.strategy,
              detail: foundBtn.detail,
              visible: isVisible(clickable),
              disabled: false,
              pointPick: point.pick || null,
              lagFromSentMs: Number.isFinite(sentAtArg) ? (t1 - sentAtArg) : null,
              lagFromSignalMs: Number.isFinite(signalAtArg) ? (t1 - signalAtArg) : null,
              execMs: t1 - t0,
              attempts: attempt + 1
            }
          };
        }
      }
      if (attempt === 0) continue;
      await sleep(12);
    }

    return {
      success: false,
      found: !!lastFound,
      side,
      clicked: false,
      error: 'button_not_found_or_disabled',
      meta: lastFound ? { strategy: lastFound.strategy, detail: lastFound.detail } : null
    };
  }

  async function openCurrencyDropdown(opts) {
    const force = !!(opts && opts.force);
    if (!force) {
      const { items } = getCurrencyItems();
      if (items && items.length) return { success: true, alreadyOpen: true };
      // Assets panel may be open even before list items hydrate.
      if (document.querySelector('.assets-block, .assets-block__nav, a.assets-block__nav-item')) {
        return { success: true, alreadyOpen: true };
      }
    }
    const dropdownEl = firstVisible(CURRENCY_DROPDOWN_SELECTORS);
    if (!dropdownEl) return { success: false, error: 'dropdown_not_found' };
    try { dropdownEl.click(); } catch (e) {
      return { success: false, error: 'dropdown_click_failed', detail: e && e.message };
    }
    await sleep(220);
    return { success: true, alreadyOpen: false };
  }

  async function clickOtcTabIfPresent() {
    const candidates = Array.from(document.querySelectorAll(
      'button, a, [role="tab"], [role="button"], span, div'
    )).filter((el) => {
      try {
        if (!isVisible(el)) return false;
        const t = String(el.textContent || '').trim().toUpperCase();
        return t === 'OTC' || t === 'OTC MARKETS' || t === 'OTC MARKET';
      } catch {
        return false;
      }
    });
    for (const el of candidates.slice(0, 6)) {
      try {
        const clickable = findClickable(el) || el;
        clickable.click();
        await sleep(160);
        return true;
      } catch {}
    }
    return false;
  }

  // Category nav inside assets-block (skip Indices).
  const ASSET_CATEGORIES = [
    { key: 'currency', label: 'Currencies', selectors: [
      'a.assets-block__nav-item--currency',
      'a.assets-block__nav-item.assets-block__nav-item--currency'
    ]},
    { key: 'cryptocurrency', label: 'Cryptocurrencies', selectors: [
      'a.assets-block__nav-item--cryptocurrency',
      'a.assets-block__nav-item.assets-block__nav-item--cryptocurrency'
    ]},
    { key: 'commodity', label: 'Commodities', selectors: [
      'a.assets-block__nav-item--commodity',
      'a.assets-block__nav-item.assets-block__nav-item--commodity'
    ]},
    { key: 'stock', label: 'Stocks', selectors: [
      'a.assets-block__nav-item--stock',
      'a.assets-block__nav-item.assets-block__nav-item--stock'
    ]}
  ];

  function findCategoryNav(cat) {
    for (const sel of cat.selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch {}
    }
    // Fallback: match visible nav label text.
    const want = String(cat.label || '').toUpperCase();
    const nodes = Array.from(document.querySelectorAll(
      'a.assets-block__nav-item, .assets-block__nav-item, [class*="assets-block__nav-item"]'
    ));
    for (const el of nodes) {
      try {
        if (!isVisible(el)) continue;
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
        if (t === want || t.includes(want)) return el;
      } catch {}
    }
    return null;
  }

  async function clickAssetCategory(cat) {
    const el = findCategoryNav(cat);
    if (!el) return { success: false, error: 'category_not_found', category: cat.key };
    // Already active?
    try {
      const cls = String(el.className || '');
      if (cls.includes('assets-block__nav-item--active') || cls.includes('--active')) {
        return { success: true, category: cat.key, alreadyActive: true };
      }
    } catch {}
    try {
      (findClickable(el) || el).click();
    } catch (e) {
      return { success: false, error: 'category_click_failed', category: cat.key, detail: e && e.message };
    }
    await sleep(220);
    await clickOtcTabIfPresent();
    await sleep(80);
    return { success: true, category: cat.key };
  }

  // Indices / index CFDs — skip these; keep forex, crypto, commodities, stocks.
  const INDEX_STEMS = new Set([
    'VIX', 'NASUSD', 'NAS100', 'NASDAQ', 'NDX', 'US100',
    'SPX', 'SPX500', 'SP500', 'US500', 'US30', 'DJ30', 'DJIA', 'DJI',
    'DAX', 'GER40', 'GER30', 'FTSE', 'UK100', 'NI225', 'NKY', 'JPN225',
    'EU50', 'ESP35', 'FRA40', 'AUS200', 'HK50', 'CAC40', 'IBEX35',
    'RUSSELL', 'RUT', 'DOT100'
  ]);

  function otcStemKey(label) {
    return normCurrencyKey(label).key || '';
  }

  function isIndexOtcLabel(label) {
    const upper = String(label || '').toUpperCase();
    if (!upper) return false;
    if (upper.includes('INDEX') || upper.includes('INDICES') || upper.includes('INDIE')) return true;
    const stem = otcStemKey(label);
    if (!stem) return false;
    if (INDEX_STEMS.has(stem)) return true;
    if (/^(NAS|SPX|US30|US100|US500|DJ|DAX|FTSE|NKY|NI225|GER|EU50|CAC|IBEX|AUS200|HK50)/.test(stem)) {
      return true;
    }
    return false;
  }

  function shouldSubscribeOtcLabel(label, opts) {
    const forexOnly = !!(opts && opts.forexOnly);
    const excludeIndices = opts && opts.excludeIndices === false ? false : true;
    if (!label) return false;
    const upper = String(label).toUpperCase();
    if (!upper.includes('OTC')) return false;
    if (excludeIndices && isIndexOtcLabel(label)) return false;
    if (forexOnly && !label.includes('/')) return false;
    return true;
  }

  function itemOtcLabel(item) {
    try {
      const labelEl = item.querySelector ? item.querySelector('span.alist__label') : null;
      const txtRaw = String((labelEl ? labelEl.textContent : item.textContent) || '').trim();
      if (!txtRaw) return null;
      const upper = txtRaw.toUpperCase();
      if (!upper.includes('OTC')) return null;
      return txtRaw.replace(/\s+/g, ' ').trim();
    } catch {
      return null;
    }
  }

  function findScrollableAssetList() {
    const { items } = getCurrencyItems();
    if (!items.length) return null;
    let node = items[0];
    for (let i = 0; i < 8 && node; i++) {
      try {
        node = node.parentElement;
        if (!node) break;
        const style = window.getComputedStyle(node);
        const oy = style && style.overflowY;
        if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 20) {
          return node;
        }
      } catch {
        break;
      }
    }
    // Common PO list wrappers.
    const wrappers = Array.from(document.querySelectorAll(
      '.alist, .assets-block__list, [class*="alist" i], [class*="assets-block__body" i]'
    ));
    for (const node of wrappers) {
      try {
        if (!isVisible(node)) continue;
        if (node.scrollHeight > node.clientHeight + 20) return node;
      } catch {}
    }
    return null;
  }

  async function ensureOtcListOpen(state) {
    const open = await openCurrencyDropdown({ force: !(state && state.listLikelyOpen) });
    if (!open.success) return open;
    if (!(state && state.otcTabDone)) {
      await clickOtcTabIfPresent();
      if (state) state.otcTabDone = true;
    }
    if (state) state.listLikelyOpen = true;
    return { success: true };
  }

  async function collectOtcLabelsInCurrentCategory(opts) {
    const labels = new Set();
    const scroller = findScrollableAssetList();
    let stagnant = 0;
    let lastCount = 0;

    // Reset scroll to top so we don't miss items.
    try { if (scroller) scroller.scrollTop = 0; } catch {}
    await sleep(50);

    for (let pass = 0; pass < 100; pass++) {
      const { items } = getCurrencyItems();
      for (const item of items) {
        const label = itemOtcLabel(item);
        if (!shouldSubscribeOtcLabel(label, opts)) continue;
        labels.add(label);
      }
      if (labels.size === lastCount) stagnant += 1;
      else stagnant = 0;
      lastCount = labels.size;
      if (stagnant >= 3) break;

      if (scroller) {
        const before = scroller.scrollTop;
        scroller.scrollTop = Math.min(
          scroller.scrollHeight,
          scroller.scrollTop + Math.max(220, scroller.clientHeight * 0.9)
        );
        await sleep(60);
        if (scroller.scrollTop <= before + 2) {
          stagnant += 1;
          if (stagnant >= 3) break;
        }
      } else {
        break;
      }
    }
    return Array.from(labels);
  }

  async function collectOtcLabels(opts) {
    const state = { otcTabDone: false, listLikelyOpen: false };
    const open = await ensureOtcListOpen(state);
    if (!open.success) return { success: false, error: open.error, labels: [], byCategory: {} };

    const byCategory = {};
    const all = new Set();

    for (const cat of ASSET_CATEGORIES) {
      try {
        chrome.storage.local.set({
          otcClickAllRunning: true,
          otcClickAllStatus: `scanning ${cat.label}…`
        });
      } catch (_) {}

      // Re-open panel if a prior click closed it.
      await ensureOtcListOpen(state);
      const switched = await clickAssetCategory(cat);
      if (!switched.success) {
        byCategory[cat.key] = [];
        continue;
      }
      state.listLikelyOpen = true;
      const labels = await collectOtcLabelsInCurrentCategory(opts);
      byCategory[cat.key] = labels;
      for (const l of labels) all.add(l);
    }

    return {
      success: true,
      labels: Array.from(all).sort((a, b) => a.localeCompare(b)),
      byCategory
    };
  }

  async function quickClickOtcLabel(label, state, preferredCategory) {
    const st = state || { otcTabDone: false, listLikelyOpen: false };
    const open = await ensureOtcListOpen(st);
    if (!open.success) return { success: false, error: open.error, label };

    if (preferredCategory) {
      await clickAssetCategory(preferredCategory);
      st.listLikelyOpen = true;
    }

    const want = normCurrencyKey(label);
    for (let attempt = 0; attempt < 14; attempt++) {
      const { items } = getCurrencyItems();
      for (const item of items) {
        const txt = itemOtcLabel(item);
        if (!txt) continue;
        const itemKey = normCurrencyKey(txt);
        if (want.wantOtc !== itemKey.wantOtc) continue;
        if (itemKey.key !== want.key) continue;

        const link = (item.matches && item.matches('a,button')) ? item
          : (item.querySelector && item.querySelector('a.alist__link, a, button, [role="option"], [role="menuitem"]'));
        const clickable = link || item;
        try { clickable.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
        try { clickable.click(); } catch {}
        st.listLikelyOpen = false;
        await sleep(40);
        return { success: true, label: txt };
      }
      const scroller = findScrollableAssetList();
      if (!scroller) break;
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(200, scroller.clientHeight * 0.85));
      await sleep(45);
    }
    return { success: false, error: 'currency_not_found', label };
  }

  async function clickAllOtcAssets(opts) {
    // Default: OTC in Currencies/Crypto/Commodities/Stocks — skip Indices.
    const forexOnly = opts && opts.forexOnly === true;
    const excludeIndices = opts && opts.excludeIndices === false ? false : true;
    const pauseMs = Math.max(20, Number(opts && opts.pauseMs) || 40);
    const filterOpts = { forexOnly, excludeIndices };

    const collected = await collectOtcLabels(filterOpts);
    if (!collected.success) {
      return { success: false, error: collected.error || 'collect_failed', clicked: 0, failed: 0, labels: [] };
    }

    const byCategory = collected.byCategory || {};
    // Preserve category order while clicking (faster: stay in one category at a time).
    const ordered = [];
    const seen = new Set();
    for (const cat of ASSET_CATEGORIES) {
      for (const label of (byCategory[cat.key] || [])) {
        if (seen.has(label)) continue;
        seen.add(label);
        ordered.push({ label, category: cat });
      }
    }
    // Any leftovers
    for (const label of (collected.labels || [])) {
      if (seen.has(label)) continue;
      seen.add(label);
      ordered.push({ label, category: null });
    }

    if (!ordered.length) {
      return { success: false, error: 'no_otc_items_found', clicked: 0, failed: 0, labels: [], byCategory };
    }

    const state = { otcTabDone: true, listLikelyOpen: false };
    let clicked = 0;
    let failed = 0;
    const errors = [];
    let lastCatKey = null;

    for (let i = 0; i < ordered.length; i++) {
      const { label, category } = ordered[i];
      try {
        chrome.storage.local.set({
          otcClickAllRunning: true,
          otcClickAllStatus: `clicking ${i + 1}/${ordered.length}: ${label}`
        });
      } catch (_) {}

      if (category && category.key !== lastCatKey) {
        await ensureOtcListOpen(state);
        await clickAssetCategory(category);
        state.listLikelyOpen = true;
        lastCatKey = category.key;
      }

      const res = await quickClickOtcLabel(label, state, null);
      if (res && res.success) clicked += 1;
      else {
        // Retry once with explicit category switch.
        const retry = await quickClickOtcLabel(label, state, category);
        if (retry && retry.success) clicked += 1;
        else {
          failed += 1;
          if (errors.length < 10) errors.push({ label, error: (retry && retry.error) || (res && res.error) || 'fail' });
        }
      }
      await sleep(pauseMs);
    }

    return {
      success: clicked > 0,
      clicked,
      failed,
      total: ordered.length,
      forexOnly,
      excludeIndices,
      labels: ordered.map((x) => x.label),
      byCategory,
      errors
    };
  }

  window.UtkTradeEngine = {
    sleep,
    selectCurrency,
    setBetSize,
    setBetSizeFast,
    executeTrade,
    findTradeButton,
    findBetInput,
    collectOtcLabels,
    clickAllOtcAssets
  };
})();
