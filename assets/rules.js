// Jebena Express — the rules page (rules.html), opened in its own tab.
(function(){
  'use strict';
  const I18N = window.JEBENA_I18N, RULES = window.JEBENA_RULES;
  const $ = id => document.getElementById(id);
  const store = {
    get(k){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : null }catch(e){ return null } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)) }catch(e){} }
  };

  // Same language as the main site (shared setting in this browser).
  let lang = store.get('jb_lang') || ((navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en');
  if(!I18N[lang]) lang = 'en';
  function t(key, vars){
    let s = I18N[lang][key]; if(s == null) s = I18N.en[key]; if(s == null) s = key;
    if(vars) s = s.replace(/\{(\w+)\}/g, (m, k) => vars[k] != null ? vars[k] : m);
    return s;
  }
  document.querySelectorAll('[data-i18n]').forEach(el => { I18N.en[el.dataset.i18n] ??= el.textContent.trim(); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { I18N.en[el.dataset.i18nHtml] ??= el.innerHTML.trim(); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { I18N.en[el.dataset.i18nAria] ??= el.getAttribute('aria-label'); });

  // Customs rules: "Into Ethiopia" / "Out of Ethiopia". rules.html?dir=from opens the second.
  const country = 'ET';
  let dir = new URLSearchParams(location.search).get('dir') === 'from' ? 'from' : 'to';
  const dirTabs = $('dirTabs'), panel = $('countryRules');
  ['to', 'from'].forEach(d => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.d = d;
    b.addEventListener('click', () => { dir = d; renderRules(); });
    dirTabs.appendChild(b);
  });
  function renderRules(){
    dirTabs.querySelectorAll('button').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.d === dir));
      b.textContent = t('dir.' + b.dataset.d, {c: t('country.' + country)});
    });
    const R = RULES[country][dir], ul = document.createElement('ul');
    (R[lang] || R.en).forEach(s => { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); });
    const src = document.createElement('p'); src.className = 'src'; src.append(t('rules.source'));
    R.sources.forEach(([label, url], i) => {
      if(i) src.append(' · ');
      const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label; src.appendChild(a);
    });
    panel.innerHTML = ''; panel.append(ul, src);
  }

  function apply(){
    document.documentElement.lang = lang;
    document.title = t('rp.title');
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    renderRules();
  }
  document.querySelectorAll('.lang button').forEach(b => b.addEventListener('click', () => {
    if(b.dataset.lang === lang) return;
    lang = b.dataset.lang; store.set('jb_lang', lang); apply();
  }));
  // Opened as its own window from the site: the back links close the window instead.
  if(window.opener && window.name === 'jebenaRules'){
    document.querySelectorAll('[data-i18n="rp.back"]').forEach(a => {
      a.dataset.i18n = 'rp.close';
      a.addEventListener('click', e => { e.preventDefault(); window.close(); });
    });
  }
  // Back to top
  const toTop = $('toTop'), reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const updateToTop = () => toTop.classList.toggle('on', window.scrollY > window.innerHeight * 0.9);
  window.addEventListener('scroll', updateToTop, {passive: true});
  toTop.addEventListener('click', () => window.scrollTo({top: 0, behavior: reduce ? 'auto' : 'smooth'}));
  apply();
})();
