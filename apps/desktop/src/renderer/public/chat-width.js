(() => {
  const storageKey = 'kimi-web.chat-width';
  const languageRowSelector = '.language-row';
  const appearanceRowSelector = `.settings-dialog .settings-group > ${languageRowSelector}`;
  const settingSelector = '[data-kimi-chat-width-setting]';
  const labels = {
    en: { title: 'Conversation width', compact: 'Compact', standard: 'Standard', wide: 'Wide' },
    zh: { title: '对话宽度', compact: '紧凑', standard: '标准', wide: '宽屏' },
  };
  const presets = ['compact', 'standard', 'wide'];
  const root = document.documentElement;

  function readPreference(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function applyWidth(value) {
    const width = presets.includes(value) ? value : 'standard';
    root.dataset.kimiChatWidth = width;
    return width;
  }

  function renderSetting(anchor) {
    let row = anchor.parentElement.querySelector(settingSelector);
    if (!row) {
      row = document.createElement('label');
      row.dataset.kimiChatWidthSetting = '';
      const title = document.createElement('span');
      const select = document.createElement('select');
      for (const preset of presets) {
        const option = document.createElement('option');
        option.value = preset;
        select.append(option);
      }
      select.addEventListener('change', () => {
        const width = applyWidth(select.value);
        try {
          localStorage.setItem(storageKey, width);
        } catch {
          return;
        }
      });
      row.append(title, select);
      anchor.after(row);
    }

    const savedLanguage = readPreference('kimi-locale');
    const chinese = savedLanguage === 'zh' ||
      (savedLanguage !== 'en' && navigator.language.toLowerCase().startsWith('zh'));
    const text = chinese ? labels.zh : labels.en;
    const [title, select] = row.children;
    title.textContent = text.title;
    for (const option of select.options) {
      option.textContent = text[option.value];
    }
    select.value = root.dataset.kimiChatWidth;
  }

  applyWidth(readPreference(storageKey));
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    const width = applyWidth(readPreference(storageKey));
    const select = document.querySelector(`${settingSelector} select`);
    if (select) select.value = width;
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll(appearanceRowSelector).forEach(renderSetting);
    const observer = new MutationObserver((records) => {
      const anchors = new Set();
      for (const record of records) {
        const anchor = record.target.closest?.(appearanceRowSelector);
        if (anchor) anchors.add(anchor);
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(languageRowSelector)) anchors.add(node);
          node.querySelectorAll(languageRowSelector).forEach((row) => anchors.add(row));
        }
      }
      for (const anchor of anchors) {
        if (anchor.isConnected && anchor.matches(appearanceRowSelector)) renderSetting(anchor);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
