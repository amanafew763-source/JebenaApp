// Jebena Express — front-end application.
// Talks directly to Supabase; all access rules live in supabase/schema.sql.
(function(){
  'use strict';

  // ---------- setup ----------
  const CFG = window.JEBENA_CONFIG || {};
  const I18N = window.JEBENA_I18N;
  // 6-digit email codes need your own email sender (custom SMTP) in Supabase.
  // Until then everyone signs up with email + password. To switch codes on,
  // add  emailCodes: true  to config.js.
  const CODES = CFG.emailCodes === true;
  if(!CODES){
    Object.assign(I18N.en, {
      'auth.login.title':'Log in', 'auth.signup.eyebrow':'New here?', 'auth.signup.title':'Create an account',
      'auth.signupIntro':'Create a free account with your email and a password (at least 8 characters).',
      'auth.toSignup':'No account yet? Create one',
      'auth.needLogin':'Create a free account or log in to send your request. What you typed stays in the form.',
      'auth.travelerLogin':'Create a free account or log in to post your trip. What you typed stays in the form.',
      'st.needLogin':'Log in to see this request.'
    });
    Object.assign(I18N.de, {
      'auth.login.title':'Anmelden', 'auth.signup.eyebrow':'Neu hier?', 'auth.signup.title':'Konto erstellen',
      'auth.signupIntro':'Erstelle ein kostenloses Konto mit deiner E-Mail-Adresse und einem Passwort (mindestens 8 Zeichen).',
      'auth.toSignup':'Noch kein Konto? Jetzt erstellen',
      'auth.needLogin':'Erstelle ein kostenloses Konto oder melde dich an, um deine Anfrage zu senden. Deine Eingaben bleiben im Formular.',
      'auth.travelerLogin':'Erstelle ein kostenloses Konto oder melde dich an, um deine Reise einzutragen. Deine Eingaben bleiben im Formular.',
      'st.needLogin':'Melde dich an, um diese Anfrage zu sehen.'
    });
  }
  const sb = (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey)
    : null;
  const store = {
    get(k){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : null }catch(e){ return null } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)) }catch(e){} }
  };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = id => document.getElementById(id);
  const siteUrl = () => location.origin + location.pathname;

  // ---------- translations ----------
  let lang = store.get('jb_lang') || ((navigator.language||'').toLowerCase().startsWith('de') ? 'de' : 'en');
  if(!I18N[lang]) lang = 'en';
  const LOC = () => lang === 'de' ? 'de-DE' : 'en-US';
  function t(key, vars){
    let s = I18N[lang][key]; if(s == null) s = I18N.en[key]; if(s == null) s = key;
    if(vars) s = s.replace(/\{(\w+)\}/g, (m,k)=> vars[k] != null ? vars[k] : m);
    return s;
  }
  document.querySelectorAll('[data-i18n]').forEach(el=>{ I18N.en[el.dataset.i18n] ??= el.textContent.trim(); });
  document.querySelectorAll('[data-i18n-html]').forEach(el=>{ I18N.en[el.dataset.i18nHtml] ??= el.innerHTML.trim(); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el=>{ I18N.en[el.dataset.i18nPh] ??= el.placeholder; });
  document.querySelectorAll('[data-i18n-aria]').forEach(el=>{ I18N.en[el.dataset.i18nAria] ??= el.getAttribute('aria-label'); });
  function applyStatic(){
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el=>{ el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach(el=>{ el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-ph]').forEach(el=>{ el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-aria]').forEach(el=>{ el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.querySelectorAll('.lang button').forEach(b=>b.setAttribute('aria-pressed', String(b.dataset.lang===lang)));
  }

  // ---------- state ----------
  let user = null;            // Supabase auth user
  let hasPassword = false;    // senders may sign in with an email code only
  let profile = null;         // { full_name, is_admin }
  let view = 'home';          // home | account | admin | status
  let statusId = null;        // request shown on the status page
  let pendingStatus = null;   // status page to open after logging in

  // ---------- header & mobile menu ----------
  const nav = $('nav'), toggle = $('menuToggle'), topbar = $('topbar');
  const loginBtn = $('loginBtn'), adminLink = $('adminLink');
  function setMenu(open){ nav.dataset.open = String(open); toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-label', t(open?'menu.close':'menu.open')); }
  toggle.addEventListener('click', ()=> setMenu(nav.dataset.open !== 'true'));
  nav.querySelectorAll('a').forEach(a=> a.addEventListener('click', ()=> setMenu(false)));

  function renderAuthButtons(){
    loginBtn.textContent = t(user ? 'nav.account' : 'nav.login');
    adminLink.hidden = !(profile && profile.is_admin);
  }
  loginBtn.addEventListener('click', ()=>{ setMenu(false); if(user) location.hash = '#account'; else openAuth('code'); });

  // ---------- views & simple routing (#account, #r123) ----------
  function setView(v){
    if(v === 'admin' && !(profile && profile.is_admin)) v = 'home';
    if((v === 'account' || v === 'status') && !user) v = 'home';
    view = v;
    document.body.classList.toggle('admin-mode', v === 'admin');
    document.body.classList.toggle('account-mode', v === 'account');
    document.body.classList.toggle('status-mode', v === 'status');
    $('adminWrap').hidden = v !== 'admin';
    $('accountWrap').hidden = v !== 'account';
    $('statusWrap').hidden = v !== 'status';
    adminLink.classList.toggle('active', v === 'admin');
    hideTip();
    if(v !== 'home') window.scrollTo(0, 0);
    if(v === 'admin') renderDashboard();
    if(v === 'account') renderAccount();
    onScroll();
  }
  function route(){
    const h = location.hash, m = h.match(/^#r(\d+)$/);
    if(m){
      const id = Number(m[1]);
      if(!sb) return;
      if(!user){ pendingStatus = id; openAuth('code', 'st.needLogin'); return; }
      statusId = id; setView('status'); renderStatus(id);
    } else if(h === '#account'){
      if(user) setView('account'); else if(sb) openAuth('code');
    } else if(view === 'status' || view === 'account'){
      setView('home');
    }
  }
  window.addEventListener('hashchange', route);
  adminLink.addEventListener('click', e=>{ e.preventDefault(); setMenu(false); setView('admin'); });
  document.querySelectorAll('a[href^="#"]:not(#adminLink):not([href="#account"])').forEach(a=>a.addEventListener('click', ()=>{ if(view !== 'home') setView('home'); }));

  // ---------- account dialog ----------
  // Senders: email code (no password). Travelers: password account.
  const authOverlay = $('authOverlay'), authForm = $('authForm'), authStatus = $('authStatus');
  const AUTH = {
    code:    { email:true,  code:false, name:false, pass:false, pass2:false, captcha:true,  intro:'auth.codeIntro',   alt:['login','auth.toPassword'] },
    verify:  { email:false, code:true,  name:false, pass:false, pass2:false, captcha:false,                            switch:['code','auth.changeEmail'] },
    login:   { email:true,  code:false, name:false, pass:true,  pass2:false, captcha:true,  forgot:true, passKey:'auth.password', passAuto:'current-password', switch:['signup','auth.toSignup'], alt:['code','auth.toCode'] },
    signup:  { email:true,  code:false, name:true,  pass:true,  pass2:true,  captcha:true,  intro:'auth.signupIntro', passKey:'auth.password', passAuto:'new-password', switch:['login','auth.toLogin'], alt:['code','auth.toCode'] },
    reset:   { email:true,  code:false, name:false, pass:false, pass2:false, captcha:true,  intro:'auth.resetIntro',  switch:['login','auth.backToLogin'] },
    newpass: { email:false, code:false, name:false, pass:true,  pass2:true,  captcha:false, passKey:'auth.newPassword', passAuto:'new-password' },
    change:  { email:false, code:false, name:false, pass:true,  pass2:true,  captcha:false, passKey:'auth.newPassword', passAuto:'new-password' }
  };
  if(!CODES){ delete AUTH.login.alt; delete AUTH.signup.alt; }
  let authMode = 'code', authIntroKey = null, authOpenedAt = 0, codeEmail = '', codeName = '';
  const modeKey = () => (authMode === 'change' && !hasPassword) ? 'setpw' : authMode;
  function renderAuthMode(){
    const m = AUTH[authMode], k = modeKey();
    $('authEyebrow').textContent = t('auth.' + k + '.eyebrow');
    $('auth-title').textContent = t('auth.' + k + '.title');
    $('authSubmit').textContent = t('auth.' + k + '.submit');
    $('aNameRow').hidden = !m.name; $('aEmailRow').hidden = !m.email; $('aPassRow').hidden = !m.pass; $('aPass2Row').hidden = !m.pass2; $('aCodeRow').hidden = !m.code;
    if(m.pass){ $('aPassLabel').textContent = t(m.passKey); $('a-pass').setAttribute('autocomplete', m.passAuto); }
    $('authForgot').hidden = !m.forgot;
    $('authSwitch').hidden = !m.switch; if(m.switch) $('authSwitch').textContent = t(m.switch[1]);
    $('authAlt').hidden = !m.alt;       if(m.alt) $('authAlt').textContent = t(m.alt[1]);
    const intro = authMode === 'verify' ? t('auth.codeSent', {e: codeEmail}) : ((authIntroKey || m.intro) ? t(authIntroKey || m.intro) : '');
    $('authIntro').hidden = !intro; $('authIntro').textContent = intro;
    renderTurnstile();
  }
  function openAuth(mode, introKey, prefill){
    if(!CODES && (mode === 'code' || mode === 'verify')) mode = 'login';
    authMode = mode; authIntroKey = introKey || null; authOpenedAt = Date.now();
    authStatus.hidden = true; $('a-pass').value = ''; $('a-pass2').value = ''; $('a-code').value = '';
    if(prefill && prefill.email != null) $('a-email').value = prefill.email;
    if(prefill && prefill.name != null){ codeName = prefill.name; if(!$('a-name').value) $('a-name').value = prefill.name; }
    renderAuthMode();
    authOverlay.hidden = false;
    if(!sb) authMsg('err', 'backend.off');
    setTimeout(()=>{ const first = [...authForm.querySelectorAll('label:not([hidden]) input')].find(i => !i.value) || [...authForm.querySelectorAll('label:not([hidden]) input')][0]; if(first) first.focus(); }, 30);
  }
  function closeAuth(){ authOverlay.hidden = true; loginBtn.focus(); }
  function cancelAuth(){ pendingSend = false; closeAuth(); }
  function authMsg(kind, key, vars){ authStatus.className = 'status ' + kind; authStatus.textContent = t(key, vars); authStatus.hidden = false; }
  $('closeAuth').addEventListener('click', cancelAuth);
  authOverlay.addEventListener('click', e=>{ if(e.target === authOverlay) cancelAuth(); });
  document.addEventListener('keydown', e=>{ if(e.key === 'Escape' && !authOverlay.hidden) cancelAuth(); });
  $('authForgot').addEventListener('click', ()=>openAuth('reset', null, {email: $('a-email').value}));
  $('authSwitch').addEventListener('click', ()=>openAuth(AUTH[authMode].switch[0], null, {email: authMode === 'verify' ? codeEmail : $('a-email').value}));
  $('authAlt').addEventListener('click', ()=>openAuth(AUTH[authMode].alt[0], null, {email: $('a-email').value}));
  $('a-code').addEventListener('input', ()=>{ const v = $('a-code').value.replace(/\D/g, ''); if(v !== $('a-code').value) $('a-code').value = v; });

  function mapAuthError(err){
    const code = (err && err.code) || '', msg = ((err && err.message) || '').toLowerCase();
    if(code === 'otp_expired' || msg.includes('expired') || msg.includes('token') && msg.includes('invalid')) return 'auth.err.code';
    if(code === 'invalid_credentials' || msg.includes('invalid login')) return 'auth.err.invalid';
    if(code === 'email_not_confirmed' || msg.includes('not confirmed')) return 'auth.err.unconfirmed';
    if(code === 'user_already_exists' || code === 'email_exists' || msg.includes('already registered')) return 'auth.err.exists';
    if(code === 'weak_password' || msg.includes('password should')) return 'auth.err.weak';
    if(code === 'same_password') return 'auth.err.same';
    if(code.startsWith('over_') || msg.includes('rate limit') || msg.includes('seconds')) return 'auth.err.rate';
    if(msg.includes('captcha')) return 'auth.err.captcha';
    return 'auth.err.generic';
  }
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  authForm.addEventListener('submit', async e=>{
    e.preventDefault();
    if(!sb) return authMsg('err', 'backend.off');
    const m = AUTH[authMode];
    if($('a-website').value) return authMsg('err', 'auth.err.generic');           // honeypot
    if(authMode !== 'verify' && Date.now() - authOpenedAt < 1200) return authMsg('err', 'auth.err.tooFast'); // too fast for a person (codes may be autofilled)
    const name = $('a-name').value.trim(), email = $('a-email').value.trim(), pass = $('a-pass').value, pass2 = $('a-pass2').value, code = $('a-code').value.trim();
    if((m.name && !name) || (m.email && !email) || (m.pass && !pass) || (m.pass2 && !pass2) || (m.code && !code)) return authMsg('err', 'auth.err.fill');
    if(m.email && !EMAIL_RE.test(email)) return authMsg('err', 'auth.err.email');
    if(m.code && !/^\d{6,10}$/.test(code)) return authMsg('err', 'auth.err.codeFormat');
    if(m.pass2 && pass.length < 8) return authMsg('err', 'auth.err.short');
    if(m.pass2 && pass !== pass2) return authMsg('err', 'auth.err.match');
    const useCaptcha = m.captcha && CFG.turnstileSiteKey;
    if(useCaptcha && !tsToken) return authMsg('err', 'auth.err.captcha');
    const captchaToken = useCaptcha ? tsToken : undefined;
    const btn = $('authSubmit'); btn.disabled = true; authStatus.hidden = true;
    try{
      if(authMode === 'code'){
        const options = { shouldCreateUser: true, emailRedirectTo: siteUrl(), captchaToken };
        if(codeName) options.data = { full_name: codeName };
        const { error } = await sb.auth.signInWithOtp({ email, options });
        if(error) throw error;
        codeEmail = email; authMode = 'verify'; authOpenedAt = Date.now(); renderAuthMode();
        setTimeout(()=>$('a-code').focus(), 30);
      } else if(authMode === 'verify'){
        const { error } = await sb.auth.verifyOtp({ email: codeEmail, token: code, type: 'email' });
        if(error) throw error;
        closeAuth();
      } else if(authMode === 'login'){
        const { error } = await sb.auth.signInWithPassword({ email, password: pass, options: { captchaToken } });
        if(error) throw error;
        closeAuth();
      } else if(authMode === 'signup'){
        const { data, error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name }, emailRedirectTo: siteUrl(), captchaToken } });
        if(error) throw error;
        // With "Confirm email" off in Supabase the account is ready at once.
        if(data && data.session) closeAuth();
        else authMsg('ok', 'auth.checkEmail', { e: email });
      } else if(authMode === 'reset'){
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: siteUrl(), captchaToken });
        if(error) throw error;
        authMsg('ok', 'auth.resetSent', { e: email });
      } else {
        const { error } = await sb.auth.updateUser({ password: pass });
        if(error) throw error;
        hasPassword = true;
        authMsg('ok', 'auth.pwSaved');
        if(view === 'account') renderAccount();
        setTimeout(()=>{ closeAuth(); if(pendingSend){ pendingSend = false; cForm.requestSubmit(); } }, 900);
      }
    } catch(err){
      authMsg('err', mapAuthError(err));
    } finally {
      btn.disabled = false; resetCaptcha();
    }
  });

  // ---------- optional Cloudflare Turnstile ----------
  let tsWidget = null, tsToken = null;
  function renderTurnstile(){
    const box = $('authCaptcha');
    if(!CFG.turnstileSiteKey || !AUTH[authMode].captcha){ box.hidden = true; return; }
    box.hidden = false;
    if(!window.turnstile){
      if(!$('ts-script')){
        const s = document.createElement('script'); s.id = 'ts-script'; s.async = true;
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.onload = renderTurnstile; document.head.appendChild(s);
      }
      return;
    }
    if(tsWidget === null){
      tsWidget = window.turnstile.render(box, {
        sitekey: CFG.turnstileSiteKey, language: lang,
        callback: tok => { tsToken = tok; }, 'expired-callback': () => { tsToken = null; }, 'error-callback': () => { tsToken = null; }
      });
    }
  }
  function resetCaptcha(){ tsToken = null; if(window.turnstile && tsWidget !== null) window.turnstile.reset(tsWidget); }

  // ---------- session ----------
  async function loadProfile(){
    if(!user){ profile = null; hasPassword = false; return; }
    const [p, pw] = await Promise.all([
      sb.from('profiles').select('full_name, is_admin').eq('id', user.id).maybeSingle(),
      sb.rpc('has_password')
    ]);
    profile = p.data || { full_name: '', is_admin: false };
    hasPassword = !!pw.data;
    // A sender who signed in with a code: keep the name they typed in the form.
    if(!profile.full_name && codeName){
      profile.full_name = codeName;
      sb.from('profiles').update({ full_name: codeName }).eq('id', user.id).then(()=>{}, ()=>{});
    }
  }
  let routedOnce = false;
  async function onSession(session, event){
    user = session ? session.user : null;
    try{ await loadProfile(); } catch(e){ profile = { full_name: '', is_admin: false }; }
    renderAuthButtons();
    prefillContact();
    if(event === 'PASSWORD_RECOVERY') openAuth('newpass');
    if(event === 'SIGNED_IN' && pendingSend && user){
      pendingSend = false;
      $('contact').scrollIntoView({behavior: reduce?'auto':'smooth'});
      cForm.requestSubmit();   // finish sending the request they started
    }
    if(event === 'SIGNED_IN' && pendingStatus && user){ const id = pendingStatus; pendingStatus = null; statusId = id; setView('status'); renderStatus(id); }
    if(!routedOnce){ routedOnce = true; route(); }
    if(view === 'account') user ? renderAccount() : setView('home');
    if(view === 'status') user ? null : setView('home');
    if(view === 'admin') (profile && profile.is_admin) ? renderDashboard() : setView('home');
  }
  if(sb){
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    sb.auth.onAuthStateChange((event, session)=>{ setTimeout(()=>onSession(session, event), 0); });
  } else {
    const bar = $('sysbar'); bar.hidden = false; bar.dataset.i18n = 'backend.off'; bar.textContent = t('backend.off');
  }
  async function logout(){
    if(sb) await sb.auth.signOut();
    if(/^#(r\d+|account)$/.test(location.hash)) history.replaceState(null, '', location.pathname);
    setView('home'); window.scrollTo({top:0, behavior: reduce?'auto':'smooth'});
  }
  $('logoutBtn2').addEventListener('click', logout);
  $('logoutBtn3').addEventListener('click', logout);
  $('changePwBtn').addEventListener('click', ()=>openAuth('change'));

  // ---------- places, routes & customs rules ----------
  // The Ethiopia end of a route. "id" is what the database stores
  // (keep in step with public.home_country in supabase/schema.sql).
  const HOMES = [
    { id: 'Addis Ababa', c: 'ET', de: 'Addis Abeba', note: 'ADD · Bole' },
    { id: 'Dire Dawa', c: 'ET' }, { id: 'Adigrat', c: 'ET' }, { id: 'Arba Minch', c: 'ET' },
    { id: 'Asosa', c: 'ET' }, { id: 'Bahir Dar', c: 'ET' }, { id: 'Bonga', c: 'ET' }, { id: 'Gambela', c: 'ET' },
    { id: 'Harar', c: 'ET' }, { id: 'Hawassa', c: 'ET' }, { id: 'Hosaena', c: 'ET' }, { id: 'Jijiga', c: 'ET' },
    { id: 'Jimma', c: 'ET' }, { id: 'Mekelle', c: 'ET' }, { id: 'Semera', c: 'ET' }, { id: 'Shire', c: 'ET' },
    { id: 'Wolaita Sodo', c: 'ET' }
  ];
  const HOME_BY_ID = new Map(HOMES.map(h => [h.id, h]));
  const COUNTRIES = [...new Set(HOMES.map(h => h.c))];   // just Ethiopia for now
  const DEFAULT_HOME = 'Addis Ababa';
  const homeOf = id => HOME_BY_ID.get(id) || HOME_BY_ID.get(DEFAULT_HOME);
  const homeName = id => { const h = homeOf(id); return (lang === 'de' && h.de) || h.id; };
  const countryOf = id => homeOf(id).c;
  const countryName = c => t('country.' + c);
  const routeLabel = (dir, city, home) => dir === 'from' ? homeName(home) + ' → ' + city : city + ' → ' + homeName(home);
  // Fill a <select> with the cities, grouped by country; keeps the current choice.
  function fillHomeSelect(sel){
    const cur = sel.value || DEFAULT_HOME;
    sel.innerHTML = '';
    COUNTRIES.forEach(c=>{
      const g = document.createElement('optgroup'); g.label = countryName(c);
      HOMES.filter(h => h.c === c).forEach(h=>{ const o = document.createElement('option'); o.value = h.id; o.textContent = homeName(h.id); g.appendChild(o); });
      sel.appendChild(g);
    });
    sel.value = HOME_BY_ID.has(cur) ? cur : DEFAULT_HOME;
  }

  // Customs rules live in assets/rules-data.js (shared with rules.html).
  const RULES = window.JEBENA_RULES;
  const CARE_ICON = '<span class="ico care" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 4v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/></svg></span>';
  const dirLabel = (dir, c) => t('dir.' + dir, {c: countryName(c)});
  function rulesList(c, dir){
    const R = RULES[c][dir], frag = document.createDocumentFragment(), ul = document.createElement('ul');
    (R[lang] || R.en).forEach(s=>{ const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); });
    const src = document.createElement('p'); src.className = 'src'; src.append(t('rules.source'));
    R.sources.forEach(([label, url], i)=>{
      if(i) src.append(' · ');
      const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label; src.appendChild(a);
    });
    frag.append(ul, src); return frag;
  }
  const destAlert = $('destAlert');
  function updateDestAlert(c, dir){
    destAlert.innerHTML = ''; destAlert.hidden = false; destAlert.className = 'alert';
    const h = document.createElement('strong'); h.innerHTML = CARE_ICON; h.append(t('rules.forDir', {d: dirLabel(dir, c)}));
    const more = document.createElement('a'); more.href = 'rules.html?dir=' + dir + '#items'; more.target = '_blank'; more.rel = 'noopener'; more.className = 'inline-link'; more.textContent = t('rules.seeAll');
    const p = document.createElement('p'); p.className = 'src'; p.appendChild(more);
    destAlert.append(h, rulesList(c, dir), p);
  }

  // ---------- rules page: opens in its own window ----------
  // Links to rules.html open a separate browser window (re-used on later clicks).
  // If the browser blocks it, or on phones, the link just opens a new tab.
  document.addEventListener('click', e=>{
    const a = e.target.closest('a[href^="rules.html"]');
    if(!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    const w = Math.min(960, screen.availWidth - 40), h = Math.min(860, screen.availHeight - 60);
    const left = Math.max(0, Math.round((screen.availWidth - w) / 2)), top = Math.max(0, Math.round((screen.availHeight - h) / 3));
    const win = window.open(a.href, 'jebenaRules', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
    if(win){ e.preventDefault(); try{ win.focus(); }catch(err){} }
  });

  // ---------- request form ----------
  // "I need something carried" (an item, either direction) or "I'm traveling" (a trip).
  const cForm = $('contactForm'), cStatus = $('contactStatus');
  const PHONE_RE = /^\+?[0-9 ()./-]{6,25}$/;
  let formStartedAt = 0, formFlag = false, pendingSend = false, photoBlob = null, meTouched = false;
  const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const isTraveler = () => cForm.role.value === 'Traveler';

  function placeNames(){
    const city = cForm.city.value.trim() || t('form.yourCity');
    const home = homeName(cForm.home.value);
    return cForm.dir.value === 'from' ? { ho: home, pu: city } : { ho: city, pu: home };
  }
  function setFormDir(){
    const dir = cForm.dir.value, home = cForm.home.value;
    $('c-city-label').textContent = t(dir === 'from' ? 'form.cityLabel.from' : 'form.cityLabel.to');
    $('dirToText').textContent = t('form.dirTo', {home: homeName(home)});
    $('dirFromText').textContent = t('form.dirFrom', {home: homeName(home)});
    $('c-city').placeholder = t('form.cityPh');
    const p = placeNames();
    $('hoSub').textContent = t('form.hoSub', {place: p.ho});
    $('puSub').textContent = t('form.puSub', {place: p.pu});
    // Sensible default: you usually hand the item over yourself when sending to Addis,
    // and pick it up yourself when it comes from Addis.
    if(!meTouched){ setMe('ho', dir === 'to'); setMe('pu', dir === 'from'); }
    updateDestAlert(countryOf(home), dir);
  }
  function setRoleUI(){
    const traveler = isTraveler();
    $('tripFields').hidden = !traveler;
    $('itemFields').hidden = traveler;
    $('msgLabel').textContent = t(traveler ? 'form.msgTrip' : 'form.msgItem');
    setAgreeText();
  }
  function setAgreeText(){
    const traveler = isTraveler();
    $('agreeText').innerHTML = t(traveler ? 'form.agree.traveler' : 'form.agree.sender');
    $('c-msg').placeholder = t(traveler ? 'form.ph.traveler' : 'form.ph.sender');
  }
  // "That's me": copy your own name and phone into the hand-over or pickup person.
  function setMe(which, on){
    const box = $('c-' + which + '-me'); box.checked = on;
    const n = $('c-' + which + '-name'), ph = $('c-' + which + '-phone');
    n.disabled = ph.disabled = on;
    if(on){ n.value = cForm.name.value; ph.value = cForm.phone.value; }
    else if(n.value === cForm.name.value && ph.value === cForm.phone.value){ n.value = ''; ph.value = ''; }
  }
  ['ho', 'pu'].forEach(w => $('c-' + w + '-me').addEventListener('change', e => { meTouched = true; setMe(w, e.target.checked); }));
  ['name', 'phone'].forEach(f => cForm[f].addEventListener('input', () => ['ho', 'pu'].forEach(w => { if($('c-' + w + '-me').checked) $('c-' + w + '-' + f).value = cForm[f].value; })));
  cForm.home.addEventListener('change', setFormDir);
  cForm.city.addEventListener('input', () => { const p = placeNames(); $('hoSub').textContent = t('form.hoSub', {place: p.ho}); $('puSub').textContent = t('form.puSub', {place: p.pu}); });

  function setDateLimits(){
    const today = todayISO();
    $('c-ready').min = today; $('c-needed').min = $('c-ready').value || today; $('c-flight').min = today;
  }
  $('c-ready').addEventListener('change', setDateLimits);

  // Photos are shrunk in the browser (max 1600 px, JPEG) before upload.
  async function compressPhoto(file){
    const url = URL.createObjectURL(file);
    try{
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    } finally { URL.revokeObjectURL(url); }
  }
  $('c-photo').addEventListener('change', async e => {
    const file = e.target.files[0], prev = $('photoPreview');
    photoBlob = null; prev.hidden = true;
    if(!file) return;
    try{
      photoBlob = await compressPhoto(file);
      prev.src = URL.createObjectURL(photoBlob); prev.alt = t('form.photoAlt'); prev.hidden = false;
    } catch(err){ e.target.value = ''; say('err', 'form.photoErr'); }
  });
  async function uploadPhoto(blob){
    const path = `${user.id}/${(crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36)}.jpg`;
    const { error } = await sb.storage.from('item-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if(error) throw Object.assign(new Error('photo_upload'), { cause: error });
    return path;
  }

  function prefillContact(){
    if(user){
      if(!cForm.name.value && profile && profile.full_name) cForm.name.value = profile.full_name;
      if(!cForm.email.value && user.email) cForm.email.value = user.email;
      ['ho', 'pu'].forEach(w => { if($('c-' + w + '-me').checked) setMe(w, true); });
    }
    $('needAccount').hidden = !sb || !!user;
  }
  cForm.querySelectorAll('input[name=role]').forEach(r => r.addEventListener('change', setRoleUI));
  cForm.querySelectorAll('input[name=dir]').forEach(r => r.addEventListener('change', setFormDir));
  cForm.addEventListener('focusin', () => {
    if(!formStartedAt) formStartedAt = Date.now();
    if(!formFlag){ formFlag = true; pushVisit(); }
  });
  function say(kind, key, vars, link){
    cStatus.hidden = false; cStatus.className = 'status ' + kind; cStatus.textContent = t(key, vars);
    if(link){ const a = document.createElement('a'); a.href = link[1]; a.className = 'inline-link'; a.textContent = link[0]; cStatus.append(' ', a); }
  }

  // Checks the form; returns an error key or null.
  function validate(){
    const v = k => cForm[k].value.trim();
    if(!v('name') || !v('email') || !v('phone') || !v('city') || !v('message')) return 'err.fill';
    if(!EMAIL_RE.test(v('email'))) return 'err.email';
    if(!PHONE_RE.test(v('phone'))) return 'err.phone';
    const today = todayISO();
    if(isTraveler()){
      if(!v('flight') || !v('space')) return 'err.fillTrip';
      if(v('flight') < today) return 'err.past';
      const kg = Number(v('space')); if(!(kg > 0 && kg <= 100)) return 'err.space';
    } else {
      if(!v('itype') || !v('weight') || !v('ready') || !$('c-ho-name').value.trim() || !$('c-ho-phone').value.trim() || !$('c-pu-name').value.trim() || !$('c-pu-phone').value.trim()) return 'err.fillItem';
      const kg = Number(v('weight')); if(!(kg > 0 && kg <= 100)) return 'err.weight';
      if(v('ready') < today || (v('needed') && v('needed') < today)) return 'err.past';
      if(v('needed') && v('needed') < v('ready')) return 'err.neededBeforeReady';
      if(!PHONE_RE.test($('c-ho-phone').value.trim()) || !PHONE_RE.test($('c-pu-phone').value.trim())) return 'err.phone';
      if(!photoBlob) return 'err.photo';
    }
    if(!cForm.agree.checked) return 'err.agree';
    return null;
  }
  function resetForm(){
    cForm.reset(); formStartedAt = 0; photoBlob = null; meTouched = false;
    $('photoPreview').hidden = true;
    setRoleUI(); setFormDir(); setDateLimits(); prefillContact();
  }

  cForm.addEventListener('submit', async e => {
    e.preventDefault();
    const problem = validate();
    if(problem){ say('err', problem); if(problem === 'err.agree') cForm.agree.focus(); return; }
    if(cForm.website.value){ resetForm(); return say('ok', 'ok.sent'); }   // honeypot: pretend success
    if(Date.now() - formStartedAt < 3000) return say('err', 'err.tooFast');
    if(!sb) return say('err', 'backend.off');
    const traveler = isTraveler();
    if(!user){
      pendingSend = true;
      if(traveler) openAuth(CODES ? 'login' : 'signup', 'auth.travelerLogin', {email: cForm.email.value.trim(), name: cForm.name.value.trim()});
      else openAuth(CODES ? 'code' : 'signup', 'auth.needLogin', {email: cForm.email.value.trim(), name: cForm.name.value.trim()});
      return;
    }
    if(traveler && !hasPassword){ pendingSend = true; openAuth('change', 'auth.travelerNeedsPw'); return; }

    const v = k => cForm[k].value.trim();
    const row = {
      role: traveler ? 'traveler' : 'sender',
      direction: cForm.dir.value === 'from' ? 'from_addis' : 'to_addis', home_city: cForm.home.value,
      city: v('city'), details: v('message'),
      contact_name: v('name'), contact_email: v('email'), contact_phone: v('phone'),
      agreed_prohibited: true, lang
    };
    if(traveler) Object.assign(row, { flight_date: v('flight'), space_kg: Number(v('space')) });
    else Object.assign(row, {
      item_type: v('itype'), weight_kg: Number(v('weight')), ready_date: v('ready'), needed_by: v('needed') || null,
      handover_name: $('c-ho-name').value.trim(), handover_phone: $('c-ho-phone').value.trim(),
      pickup_name: $('c-pu-name').value.trim(), pickup_phone: $('c-pu-phone').value.trim()
    });
    const btn = $('contactSubmit'); btn.disabled = true; say('ok', 'form.sendingNow');
    try{
      if(!traveler) row.photo_path = await uploadPhoto(photoBlob);
      const { data, error } = await sb.from('requests').insert(row).select('id').single();
      if(error) throw error;
      resetForm();
      say('ok', 'ok.sent', null, [t('ok.openStatus'), '#r' + data.id]);
    } catch(err){
      const m = String((err && err.message) || '');
      say('err', m.includes('rate_limit') ? 'err.rate' : m === 'photo_upload' ? 'err.photoUpload' : m.includes('date_in_past') ? 'err.past' : 'err.save');
    } finally { btn.disabled = false; }
  });

  // ---------- hero booking card ----------
  let heroRole = 'Sender', heroDir = 'to';
  function setHeroRole(role){
    heroRole = role;
    $('tabSend').setAttribute('aria-selected', String(role==='Sender'));
    $('tabTravel').setAttribute('aria-selected', String(role==='Traveler'));
    $('h-what-label').textContent = t(role==='Sender' ? 'hero.whatSend' : 'hero.whatTravel');
    $('h-what').placeholder = t(role==='Sender' ? 'hero.whatSendPh' : 'hero.whatTravelPh');
    $('bookBtn').textContent = t(role==='Sender' ? 'hero.btnSend' : 'hero.btnTravel');
  }
  function setHeroDir(dir){
    heroDir = dir;
    const toAddis = dir === 'to';
    $('cityField').style.order = toAddis ? 1 : 3;
    $('addisField').style.order = toAddis ? 3 : 1;
    $('h-city-label').textContent = t(toAddis ? 'hero.from' : 'hero.to');
    $('addisLabel').textContent = t(toAddis ? 'hero.to' : 'hero.from');
    $('h-home-note').textContent = homeOf($('h-home').value).note || countryName(countryOf($('h-home').value));
    $('swapBtn').classList.toggle('flipped', !toAddis);
  }
  $('tabSend').addEventListener('click', ()=>setHeroRole('Sender'));
  $('tabTravel').addEventListener('click', ()=>setHeroRole('Traveler'));
  $('swapBtn').addEventListener('click', ()=>setHeroDir(heroDir === 'to' ? 'from' : 'to'));
  $('h-home').addEventListener('change', ()=>setHeroDir(heroDir));
  $('h-city').addEventListener('input', ()=>{ $('bookErr').hidden = true; });
  $('bookForm').addEventListener('submit', e=>{
    e.preventDefault();
    const city = $('h-city').value.trim();
    if(!city){ const err = $('bookErr'); err.textContent = t('hero.errCity'); err.hidden = false; $('h-city').focus(); return; }
    cForm.querySelector(`input[name=role][value="${heroRole}"]`).checked = true; setAgreeText();
    cForm.querySelector(`input[name=dir][value="${heroDir}"]`).checked = true;
    cForm.home.value = $('h-home').value; setFormDir();
    cForm.city.value = city;
    const what = $('h-what').value.trim();
    if(what) cForm.message.value = t(heroRole==='Sender' ? 'form.prefixSend' : 'form.prefixSpace') + what;
    $('contact').scrollIntoView({behavior: reduce?'auto':'smooth'});
    setTimeout(()=>$('c-name').focus({preventScroll:true}), reduce ? 0 : 500);
  });

  // ---------- visit tracking (anonymous, stored in Supabase) ----------
  function classifySource(){
    let r=''; try{ r = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : '' }catch(e){}
    if(!r || r === location.hostname) return 'Direct';
    if(r.includes('whatsapp')) return 'WhatsApp';
    if(r.includes('facebook') || r === 'fb.com') return 'Facebook';
    if(r.includes('instagram')) return 'Instagram';
    if(r.includes('tiktok')) return 'TikTok';
    if(r.includes('google')) return 'Google';
    if(r === 't.co' || r.includes('twitter') || r === 'x.com') return 'X (Twitter)';
    return r.replace(/^www\./,'');
  }
  const deviceType = () => window.innerWidth < 600 ? 'Phone' : window.innerWidth < 1024 ? 'Tablet' : 'Desktop';
  let visitId = null, activeMs = 0, lastTick = Date.now(), lastSent = '';
  function tickTime(){ const now = Date.now(); if(document.visibilityState === 'visible') activeMs += now - lastTick; lastTick = now; }
  function pushVisit(){
    if(!sb || !visitId) return;
    tickTime();
    const payload = { p_id: visitId, p_duration_s: Math.round(activeMs/1000), p_form_started: formFlag };
    const key = payload.p_duration_s + ':' + formFlag;
    if(key === lastSent) return;
    lastSent = key;
    sb.rpc('touch_visit', payload).then(()=>{}, ()=>{});
  }
  if(sb){
    let tz = null; try{ tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null }catch(e){}
    sb.rpc('start_visit', { p_source: classifySource(), p_device: deviceType(), p_time_zone: tz, p_lang: lang })
      .then(({ data })=>{ visitId = data || null; }, ()=>{});
    setInterval(()=>{ if(document.visibilityState === 'visible') pushVisit(); }, 15000);
    document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'hidden') pushVisit(); else lastTick = Date.now(); });
  }

  // ---------- active nav link ----------
  const links = [...nav.querySelectorAll('a[data-link]')];
  if('IntersectionObserver' in window){
    const io = new IntersectionObserver(entries=>{
      entries.forEach(en=>{ if(en.isIntersecting){ links.forEach(l=>l.classList.toggle('active', l.dataset.link===en.target.id)) } });
    }, {rootMargin:'-45% 0px -50% 0px'});
    ['home','about','items','contact'].forEach(id=>io.observe($(id)));
  }

  // ---------- shared formatting ----------
  const DAY = 864e5;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtInt = n => Math.round(n).toLocaleString(LOC());
  const fmtPct = x => { const d = x>0 && x<0.1 ? 1 : 0; const v = (x*100).toLocaleString(LOC(), {minimumFractionDigits:d, maximumFractionDigits:d}); return lang==='de' ? v + ' %' : v + '%'; };
  const fmtDur = s => { s = Math.round(s); const m = Math.floor(s/60); return m ? t('dur', {m, s: String(s%60).padStart(2,'0')}) : t('durS', {s}); };
  const fmtMoney = n => new Intl.NumberFormat(LOC(), {style:'currency', currency:'USD', maximumFractionDigits:0}).format(n);
  const fmtDate = ts => new Date(ts).toLocaleString(LOC(), {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
  const fmtDay = iso => iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString(LOC(), {day:'numeric', month:'short', year:'numeric'}) : '—';
  const fmtKg = n => n == null ? '—' : Number(n).toLocaleString(LOC(), {maximumFractionDigits:1}) + ' kg';
  const dayKey = ts => { const d = new Date(ts); return d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate(); };
  const shortDate = d => d.toLocaleDateString(LOC(), {month:'short', day:'numeric'});
  const unit = (n, one, many) => t(n===1 ? one : many);
  const lbl = k => { const key = 'lbl.' + k; const s = t(key); return s === key ? k : s; };
  const typeName = k => k ? t('type.' + k) : '—';
  const telLink = p => `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}">${esc(p)}</a>`;
  const REQ_COLS = 'id, user_id, created_at, role, direction, city, home_city, details, contact_name, contact_email, contact_phone, status, fee_usd, flight_date, space_kg, item_type, weight_kg, ready_date, needed_by';
  const fromDb = r => ({ id: r.id, at: Date.parse(r.created_at), name: r.contact_name, email: r.contact_email, phone: r.contact_phone,
    role: r.role === 'traveler' ? 'Traveler' : 'Sender', dir: r.direction === 'from_addis' ? 'from' : 'to',
    city: r.city, home: r.home_city || DEFAULT_HOME, message: r.details, status: r.status, fee: r.fee_usd, userId: r.user_id,
    flight: r.flight_date, space: r.space_kg == null ? null : Number(r.space_kg), itemType: r.item_type,
    weight: r.weight_kg == null ? null : Number(r.weight_kg), ready: r.ready_date, needed: r.needed_by });
  const summary = r => r.role === 'Traveler'
    ? t('sum.trip', {d: fmtDay(r.flight), kg: fmtKg(r.space)})
    : t('sum.item', {type: typeName(r.itemType), kg: fmtKg(r.weight), d: fmtDay(r.ready)});
  async function photoUrl(path){
    if(!path) return null;
    const { data } = await sb.storage.from('item-photos').createSignedUrl(path, 3600);
    return data && data.signedUrl;
  }
  // Two clicks for anything that can't easily be undone.
  const armed = new Map();
  function twoStep(btn, confirmKey, run){
    btn.addEventListener('click', ()=>{
      const first = armed.get(btn);
      if(first && Date.now() - first < 5000){ armed.delete(btn); run(); return; }
      armed.set(btn, Date.now());
      const label = btn.textContent; btn.textContent = t(confirmKey); btn.classList.add('btn-confirm');
      setTimeout(()=>{ if(armed.get(btn)){ armed.delete(btn); btn.textContent = label; btn.classList.remove('btn-confirm'); } }, 5000);
    });
  }
  const el = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; };
  const button = (key, cls, vars) => { const b = el('button', 'btn btn-sm ' + (cls || 'btn-ghost')); b.type = 'button'; b.textContent = t(key, vars); return b; };

  // ---------- my account ----------
  async function renderAccount(){
    if(!user) return;
    const display = (profile && profile.full_name) || (user.email || '').split('@')[0];
    $('account-title').textContent = t('acct.hello', {name: display});
    $('accountEmail').textContent = user.email || '';
    $('changePwBtn').textContent = t(hasPassword ? 'acct.changePw' : 'acct.setPw');
    $('changePwBtn').title = hasPassword ? '' : t('acct.setPwHint');
    const box = $('myRequests');
    box.innerHTML = `<p class="note">${esc(t('acct.loading'))}</p>`;
    const { data, error } = await sb.from('requests').select(REQ_COLS)
      .eq('user_id', user.id).order('created_at', {ascending:false}).limit(50);
    if(error){ box.innerHTML = `<p class="note">${esc(t('acct.loadErr'))}</p>`; return; }
    if(!data.length){ box.innerHTML = `<p class="note">${esc(t('acct.empty'))}</p>`; return; }
    box.innerHTML = '';
    data.map(fromDb).forEach(r=>{
      const item = el('a', 'my-item'); item.href = '#r' + r.id;
      item.innerHTML = `<div><div class="mi-route">${esc(routeLabel(r.dir, r.city, r.home))}</div>
        <div class="mi-meta">${esc(t('role.' + r.role))} · ${esc(summary(r))} · ${esc(t('acct.sentOn', {d: fmtDate(r.at)}))}</div></div>
        <span class="chip ${esc(r.status)}">${esc(t('st.' + r.status))}</span>
        <div class="mi-details">${esc(r.message)}</div>`;
      box.appendChild(item);
    });
  }

  // ---------- status page ----------
  function stMsg(box, kind, key, vars){ let m = box.querySelector(':scope > .st-msg'); if(!m){ m = el('div', 'status st-msg'); box.prepend(m); } m.className = 'status st-msg ' + kind; m.textContent = t(key, vars); m.hidden = false; }
  function stErrKey(err){
    const m = String((err && err.message) || '');
    for(const [code, key] of [['request_locked', 'st.err.locked'], ['date_in_past', 'err.past'], ['request_fields', 'st.err.fields'], ['rating_exists', 'st.err.rated'],
                              ['match_not_proposed', 'st.err.changed'], ['match_not_accepted', 'st.err.changed'], ['match_not_handed_over', 'st.err.changed'],
                              ['not_your', 'st.err.notYours'], ['_check', 'st.err.fields']])
      if(m.includes(code)) return key;
    return 'st.err.generic';
  }
  async function rpcThen(box, name, args, okKey){
    const { data, error } = await sb.rpc(name, args);
    if(error){ stMsg(box, 'err', stErrKey(error)); return null; }
    await renderStatus(statusId);
    if(okKey) stMsg($('statusBody'), 'ok', okKey);
    return data ?? true;
  }

  async function renderStatus(id){
    const box = $('statusBody');
    box.innerHTML = `<p class="note">${esc(t('st.loading'))}</p>`;
    const { data, error } = await sb.rpc('request_details', { p_id: id });
    if(statusId !== id) return;
    if(error || !data){ box.innerHTML = `<p class="banner-cancel">${esc(t('st.notFound'))}</p>`; return; }
    box.innerHTML = '';
    if(data.request.role === 'traveler') await renderTripStatus(box, data); else await renderItemStatus(box, data);
  }

  function head(r, eyebrowKey){
    const h = el('div', 'st-head');
    h.innerHTML = `<div class="stack" style="gap:6px"><span class="eyebrow">${esc(t(eyebrowKey, {id: r.id}))}</span>
      <h2>${esc(routeLabel(r.direction === 'from_addis' ? 'from' : 'to', r.city, r.home_city))}</h2></div>
      <span class="chip ${esc(r.status)}">${esc(t('st.' + r.status))}</span>`;
    return h;
  }
  function card(titleKey, vars){ const c = el('article', 'card'); if(titleKey) c.appendChild(el('h3', null, esc(t(titleKey, vars)))); return c; }
  function kv(rows){ return el('dl', 'kv', rows.filter(Boolean).map(([k, v]) => `<dt>${esc(t(k))}</dt><dd>${v}</dd>`).join('')); }

  function timeline(r, match){
    const firstAt = s => { const e = (r.__events || []).find(x => x.status === s); return e ? e.at : null; };
    const order = { new: 0, waiting: 0, matched: 1, accepted: 2, handed_over: 3, delivered: 5, cancelled: -1 };
    let reached = order[r.status] ?? 0;
    const flown = match && match.flight_date && match.flight_date <= todayISO();
    if(r.status === 'handed_over' && flown) reached = 4;
    const steps = [['new', 'st.step.posted'], ['matched', 'st.step.matched'], ['accepted', 'st.step.accepted'],
                   ['handed_over', 'st.step.handed'], ['transit', 'st.step.transit'], ['delivered', 'st.step.picked']];
    const ol = el('ol', 'timeline'); ol.setAttribute('aria-label', t('st.timeline'));
    steps.forEach(([s, key], i) => {
      const li = el('li', i < reached || (i === reached && r.status === 'delivered') ? 'done' : i === reached ? 'now' : '');
      const at = s === 'transit' ? (flown && reached >= 4 ? match.flight_date : null) : firstAt(s);
      li.innerHTML = `<b>${esc(t(key))}</b>${at ? `<small>${esc(s === 'transit' ? fmtDay(at) : fmtDate(Date.parse(at)))}</small>` : ''}`;
      if(i === reached && r.status !== 'delivered') li.setAttribute('aria-current', 'step');
      ol.appendChild(li);
    });
    return ol;
  }

  function stars(onPick){
    const wrap = el('div', 'stars'); wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', t('st.rate.stars'));
    let value = 0;
    for(let i = 1; i <= 5; i++){
      const b = el('button', null, '★'); b.type = 'button'; b.setAttribute('aria-label', t('st.rate.n', {n: i})); b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { value = i; [...wrap.children].forEach((c, j) => c.setAttribute('aria-pressed', String(j < i))); onPick(i); });
      wrap.appendChild(b);
    }
    return wrap;
  }
  function ratingCard(matchId, whoKey, whoName){
    const c = card('st.rate.title', {name: whoName});
    let chosen = 0;
    const s = stars(n => { chosen = n; });
    const ta = el('textarea'); ta.id = 'rate-comment-' + matchId; ta.maxLength = 1000; ta.placeholder = t('st.rate.commentPh');
    const lab = el('label'); lab.htmlFor = ta.id; lab.append(t('st.rate.comment'), ta);
    const btn = button('st.rate.submit', 'btn-primary');
    btn.addEventListener('click', () => { if(!chosen) return stMsg(c, 'err', 'st.rate.pick'); rpcThen(c, 'rate_match', { p_match_id: matchId, p_stars: chosen, p_comment: ta.value }, 'st.rate.thanks'); });
    c.append(el('p', 'note', esc(t(whoKey))), s, lab, btn);
    return c;
  }
  const ratingText = rt => rt && rt.count ? t(rt.count === 1 ? 'st.ratingVal1' : 'st.ratingVal', {avg: Number(rt.avg).toLocaleString(LOC(), {maximumFractionDigits:1}), n: rt.count}) : t('st.ratingNone');

  // Edit form for a request that is still waiting.
  function editForm(r, onDone){
    const f = el('form', 'inline-form'); f.noValidate = true;
    const field = (key, name, type, value, extra = '') => `<label><span>${esc(t(key))}</span><input name="${name}" type="${type}" value="${esc(value ?? '')}" ${extra}></label>`;
    if(r.role === 'traveler'){
      f.innerHTML = `<div class="two">${field('form.flight', 'flight_date', 'date', r.flight_date, `min="${todayISO()}"`)}${field('form.space', 'space_kg', 'number', r.space_kg, 'min="0.5" max="100" step="0.5"')}</div>`;
    } else {
      const opts = ['clothes', 'medicine', 'electronics', 'documents', 'food', 'other'].map(k => `<option value="${k}" ${k === r.item_type ? 'selected' : ''}>${esc(t('type.' + k))}</option>`).join('');
      f.innerHTML = `<div class="two"><label><span>${esc(t('form.type'))}</span><select name="item_type">${opts}</select></label>${field('form.weight', 'weight_kg', 'number', r.weight_kg, 'min="0.1" max="100" step="0.1"')}</div>
        <div class="two">${field('form.ready', 'ready_date', 'date', r.ready_date, `min="${todayISO()}"`)}${field('form.needed', 'needed_by', 'date', r.needed_by, `min="${todayISO()}"`)}</div>
        <div class="two">${field('st.hoName', 'handover_name', 'text', r.handover_name)}${field('st.hoPhone', 'handover_phone', 'tel', r.handover_phone)}</div>
        <div class="two">${field('st.puName', 'pickup_name', 'text', r.pickup_name)}${field('st.puPhone', 'pickup_phone', 'tel', r.pickup_phone)}</div>`;
    }
    // The city in Ethiopia can change too.
    const homeLbl = el('label', null, `<span>${esc(t('form.homeLabel'))}</span>`), homeSel = document.createElement('select');
    homeSel.name = 'home_city'; homeSel.value = ''; fillHomeSelect(homeSel); homeSel.value = r.home_city || DEFAULT_HOME;
    homeLbl.appendChild(homeSel); f.prepend(homeLbl);
    f.insertAdjacentHTML('beforeend', `<label><span>${esc(t(r.role === 'traveler' ? 'form.msgTrip' : 'form.msgItem'))}</span><textarea name="details" maxlength="2000">${esc(r.details)}</textarea></label>
      <div class="actions"><button class="btn btn-primary btn-sm" type="submit">${esc(t('st.save'))}</button><button class="btn btn-ghost btn-sm" type="button" data-cancel>${esc(t('st.cancelEdit'))}</button></div>`);
    f.querySelector('[data-cancel]').addEventListener('click', onDone);
    f.addEventListener('submit', e => {
      e.preventDefault();
      const p = {};
      new FormData(f).forEach((v, k) => { v = String(v).trim(); if(v !== '' || k === 'needed_by') p[k] = v; });
      if(p.details != null && p.details.length < 3) return stMsg(f, 'err', 'err.fill');
      rpcThen(f, 'update_my_request', { p_id: r.id, p }, 'st.saved');
    });
    return f;
  }
  function manageCard(r, canEdit, canCancel){
    if(!canEdit && !canCancel) return null;
    const c = card('st.manage');
    const row = el('div', 'actions');
    if(canEdit){
      const b = button('st.edit');
      b.addEventListener('click', () => { const f = editForm(r, () => { f.remove(); b.hidden = false; }); b.hidden = true; c.appendChild(f); });
      row.appendChild(b);
    }
    if(canCancel){
      const b = button(r.role === 'traveler' ? 'st.cancelTrip' : 'st.cancelReq');
      twoStep(b, 'st.cancelConfirm', () => rpcThen(c, 'cancel_my_request', { p_id: r.id }, 'st.cancelled'));
      row.appendChild(b);
    }
    c.appendChild(row);
    if(!canEdit) c.appendChild(el('p', 'note', esc(t('st.editLocked'))));
    return c;
  }

  async function renderItemStatus(box, d){
    const r = d.request, m = d.match;
    r.__events = d.events;
    box.appendChild(head(r, 'st.itemEyebrow'));
    if(r.status === 'cancelled') box.appendChild(el('p', 'banner-cancel', esc(t('st.cancelledBanner'))));
    else box.appendChild(timeline(r, m));
    const grid = el('div', 'st-grid'), left = el('div', 'st-col'), right = el('div', 'st-col');
    grid.append(left, right); box.appendChild(grid);

    // The item
    const ci = card('st.item');
    const url = await photoUrl(r.photo_path);
    if(url){ const img = el('img', 'item-photo'); img.src = url; img.alt = t('st.photoAlt', {type: typeName(r.item_type)}); ci.appendChild(img); }
    ci.appendChild(kv([['form.type', esc(typeName(r.item_type))], ['form.weight', esc(fmtKg(r.weight_kg))], ['form.ready', esc(fmtDay(r.ready_date))],
      r.needed_by && ['st.neededBy', esc(fmtDay(r.needed_by))], ['st.details', esc(r.details)]]));
    left.appendChild(ci);
    // The people
    const dir = r.direction === 'from_addis' ? 'from' : 'to', home = homeName(r.home_city), places = dir === 'from' ? {ho: home, pu: r.city} : {ho: r.city, pu: home};
    const cp = card('st.people');
    cp.appendChild(kv([[t('st.hoIn', {place: places.ho}), `${esc(r.handover_name)}<br>${telLink(r.handover_phone)}`],
                       [t('st.puIn', {place: places.pu}), `${esc(r.pickup_name)}<br>${telLink(r.pickup_phone)}`]]));
    left.appendChild(cp);

    // Pickup code
    if(!['delivered', 'cancelled'].includes(r.status) && r.pickup_code){
      const cc = el('article', 'code-box');
      cc.innerHTML = `<span class="eyebrow">${esc(t('st.codeTitle'))}</span><span class="code" aria-label="${esc(t('st.codeAria', {code: r.pickup_code.split('').join(' ')}))}">${esc(r.pickup_code)}</span>
        <p class="note">${esc(t('st.codeHelp', {name: r.pickup_name}))}</p>`;
      right.appendChild(cc);
    }
    // The traveler
    const cm = card('st.traveler');
    if(!m) cm.appendChild(el('p', 'note', esc(t(r.status === 'cancelled' ? 'st.noTraveler' : 'st.lookingForTraveler'))));
    else if(m.status === 'proposed') cm.appendChild(el('p', 'note', esc(t('st.proposed', {name: m.traveler_first_name, d: fmtDay(m.flight_date)}))));
    else {
      cm.appendChild(kv([['st.name', esc(m.traveler_name)], ['form.phone', telLink(m.traveler_phone)], ['form.email', `<a href="mailto:${esc(m.traveler_email)}">${esc(m.traveler_email)}</a>`],
        ['form.flight', esc(fmtDay(m.flight_date))], ['st.rating', esc(ratingText(m.traveler_rating))]]));
      if(m.status === 'accepted' && r.status === 'accepted') cm.appendChild(el('p', 'note', esc(t('st.arrange', {name: m.traveler_first_name}))));
    }
    right.appendChild(cm);
    if(m && m.status === 'completed' && !m.rated) right.appendChild(ratingCard(m.id, 'st.rate.whoTraveler', m.traveler_first_name));
    const mc = manageCard(r, ['new', 'waiting'].includes(r.status) && !m, ['new', 'waiting', 'matched', 'accepted'].includes(r.status));
    if(mc) right.appendChild(mc);
  }

  async function renderTripStatus(box, d){
    const r = d.request, items = d.items || [];
    box.appendChild(head(r, 'st.tripEyebrow'));
    if(r.status === 'cancelled') box.appendChild(el('p', 'banner-cancel', esc(t('st.cancelledBannerTrip'))));
    const grid = el('div', 'st-grid'), left = el('div', 'st-col'), right = el('div', 'st-col');
    grid.append(left, right); box.appendChild(grid);

    const used = Number(d.used_kg || 0), total = Number(r.space_kg || 0);
    const ct = card('st.trip');
    ct.appendChild(kv([['form.flight', esc(fmtDay(r.flight_date))], ['st.space', esc(t('st.spaceVal', {used: fmtKg(used), total: fmtKg(total)}))], ['st.details', esc(r.details)]]));
    const bar = el('div', 'space-bar', `<i style="width:${Math.min(100, total ? used / total * 100 : 0).toFixed(0)}%"></i>`);
    bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', t('st.spaceVal', {used: fmtKg(used), total: fmtKg(total)}));
    ct.appendChild(bar);
    right.appendChild(ct);

    const ci = card('st.items');
    if(!items.length) ci.appendChild(el('p', 'note', esc(t(r.status === 'cancelled' ? 'st.noItemsCancelled' : 'st.noItems'))));
    for(const it of items){
      const row = el('div', 'trip-item');
      const url = await photoUrl(it.photo_path);
      const thumb = el('img', 'thumb'); thumb.alt = t('st.photoAlt', {type: typeName(it.item_type)}); if(url) thumb.src = url;
      const body = el('div', 'body');
      const stateKey = it.match_status === 'proposed' ? 'st.it.proposed' : it.match_status === 'completed' ? 'st.it.done' : it.handed_over ? 'st.it.carrying' : 'st.it.accepted';
      body.innerHTML = `<div class="top"><b>${esc(typeName(it.item_type))} · ${esc(fmtKg(it.weight_kg))}</b><span class="chip ${it.match_status === 'completed' ? 'delivered' : it.handed_over ? 'handed_over' : it.match_status === 'proposed' ? 'matched' : 'accepted'}">${esc(t(stateKey))}</span></div>
        <div>${esc(it.details)}</div>`;
      body.appendChild(kv([['form.ready', esc(fmtDay(it.ready_date))], it.needed_by && ['st.neededBy', esc(fmtDay(it.needed_by))],
        ['st.requester', esc(it.requester_name || it.requester_first_name) + ' · ' + esc(ratingText(it.requester_rating))]]));
      const itHome = homeName(it.home_city), places = it.direction === 'from_addis' ? {ho: itHome, pu: it.city} : {ho: it.city, pu: itHome};
      if(it.match_status !== 'proposed'){
        body.appendChild(kv([['form.phone', telLink(it.requester_phone)], ['form.email', `<a href="mailto:${esc(it.requester_email)}">${esc(it.requester_email)}</a>`],
          [t('st.hoIn', {place: places.ho}), `${esc(it.handover_name)} · ${telLink(it.handover_phone)}`],
          [t('st.puIn', {place: places.pu}), `${esc(it.pickup_name)} · ${telLink(it.pickup_phone)}`]]));
      }
      const acts = el('div', 'actions');
      if(it.match_status === 'proposed'){
        body.appendChild(el('p', 'note', esc(t('st.it.decide'))));
        const yes = button('st.accept', 'btn-primary'); yes.addEventListener('click', () => rpcThen(ci, 'respond_match', { p_match_id: it.match_id, p_accept: true }, 'st.acceptedMsg'));
        const no = button('st.decline'); twoStep(no, 'st.declineConfirm', () => rpcThen(ci, 'respond_match', { p_match_id: it.match_id, p_accept: false }, 'st.declinedMsg'));
        acts.append(yes, no);
      } else if(it.match_status === 'accepted' && !it.handed_over){
        body.appendChild(el('p', 'note', esc(t('st.it.inspect'))));
        const got = button('st.received', 'btn-primary'); twoStep(got, 'st.receivedConfirm', () => rpcThen(ci, 'mark_handed_over', { p_match_id: it.match_id }, 'st.receivedMsg'));
        acts.append(got);
      } else if(it.match_status === 'accepted' && it.handed_over){
        const left5 = Math.max(0, 5 - (it.code_attempts || 0));
        if(left5 === 0) body.appendChild(el('p', 'banner-cancel', esc(t('st.codeLocked'))));
        else {
          const f = el('form', 'code-entry'); f.noValidate = true;
          const inId = 'code-' + it.match_id;
          f.innerHTML = `<label for="${inId}" class="sr">${esc(t('st.codeEnter'))}</label><input id="${inId}" class="code-input" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="000000">
            <button class="btn btn-primary btn-sm" type="submit">${esc(t('st.codeConfirm'))}</button>`;
          f.addEventListener('submit', async e => {
            e.preventDefault();
            const code = f.querySelector('input').value.replace(/\D/g, '');
            if(code.length !== 6) return stMsg(ci, 'err', 'st.codeFormat');
            const { data: res, error } = await sb.rpc('confirm_pickup', { p_match_id: it.match_id, p_code: code });
            if(error) return stMsg(ci, 'err', stErrKey(error));
            await renderStatus(statusId);
            const bx = $('statusBody');
            if(res === 'ok') stMsg(bx, 'ok', 'st.codeOk');
            else if(res === 'wrong') stMsg(bx, 'err', 'st.codeWrong', {n: Math.max(0, left5 - 1)});
            else stMsg(bx, 'err', 'st.codeLocked');
          });
          body.appendChild(el('p', 'note', esc(t('st.codeAsk', {name: it.pickup_name}))));
          body.appendChild(f);
        }
      } else if(it.match_status === 'completed' && !it.rated){
        body.appendChild(ratingCard(it.match_id, 'st.rate.whoRequester', it.requester_first_name));
      }
      if(acts.children.length) body.appendChild(acts);
      row.append(thumb, body); ci.appendChild(row);
    }
    left.appendChild(ci);
    const active = items.some(i => ['proposed', 'accepted'].includes(i.match_status));
    const carrying = items.some(i => i.match_status === 'accepted' && i.handed_over);
    const mc = manageCard(r, ['new', 'waiting'].includes(r.status) && !active, !['delivered', 'cancelled'].includes(r.status) && !carrying);
    if(mc) right.appendChild(mc);
  }

  // ---------- admin dashboard ----------
  function lastNDays(n){ const d0 = new Date(); d0.setHours(12,0,0,0); const out=[]; for(let i=n-1;i>=0;i--) out.push(new Date(d0.getTime()-i*DAY)); return out; }
  function rng(seed){ return ()=>{ seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed>>>15, 1|seed); x = x + Math.imul(x ^ x>>>7, 61|x) ^ x; return ((x ^ x>>>14)>>>0) / 4294967296; }; }
  function niceMax(m){ m = Math.max(2, m); const e = Math.pow(10, Math.floor(Math.log10(m))); const f = m/e; return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10) * e; }
  const split = (total, shares) => { const sum = shares.reduce((a,s)=>a+s[1],0); return shares.map(([k,s])=>[k, Math.round(total*s/sum)]); };
  const countBy = (arr, f) => { const m = new Map(); arr.forEach(x=>{ const k = f(x); if(k) m.set(k, (m.get(k)||0)+1); }); return [...m].sort((a,b)=>b[1]-a[1]); };

  function sampleData(){
    const r = rng(20261013), days = lastNDays(30), visitors = [], orders = [];
    days.forEach((d,i)=>{
      const wk = (d.getDay()===0 || d.getDay()===6) ? 1.25 : 1;
      const v = Math.round((105 + i*2.4) * wk * (0.85 + r()*0.3));
      visitors.push(v); orders.push(Math.round(v * (0.035 + r()*0.02)));
    });
    const totalV = visitors.reduce((a,b)=>a+b,0), totalO = orders.reduce((a,b)=>a+b,0);
    const senders = Math.round(totalO*0.71), travelers = totalO - senders;
    const delivered = Math.round(senders*0.64*0.8), fees = delivered*42, now = Date.now();
    const rows = [
      ['Selam Tesfaye','Sender','to','Washington DC','2 kg of clothes and vitamins for my mother','2 kg Kleidung und Vitamine für meine Mutter','waiting',0.15,null],
      ['Dawit Bekele','Traveler','to','Washington DC','Flying Nov 14 from Washington Dulles, one free checked bag','Abflug 14. Nov. ab Washington Dulles, ein Koffer frei','matched',0.6,35],
      ['Hanna Gebremedhin','Sender','from','Frankfurt','Coffee and berbere for my sister, about 3 kg','Kaffee und Berbere für meine Schwester, etwa 3 kg','matched',1.1,30],
      ['Meron Alemu','Sender','to','London','Laptop for my brother, wiped and boxed','Laptop für meinen Bruder, zurückgesetzt und verpackt','waiting',1.8,null],
      ['Bereket Tesfay','Traveler','from','Toronto','Flying back to Toronto Nov 20, 15 kg free','Rückflug nach Toronto am 20. Nov., 15 kg frei','matched',2.3,null],
      ['Abebe Girma','Sender','to','Washington DC','Whole bag: school supplies for a library in Addis','Ganzer Koffer: Schulsachen für eine Bibliothek in Addis','delivered',4.2,120],
      ['Amina Mohammed','Sender','to','Minneapolis','Baby clothes and shoes, about 4 kg','Babykleidung und Schuhe, etwa 4 kg','waiting',5.0,null],
      ['Samuel Kebede','Sender','to','Seattle','Phone and charger for my father','Handy und Ladegerät für meinen Vater','delivered',6.4,25],
      ['Liya Tadesse','Sender','from','Frankfurt','Two handwoven netela scarves for my cousins','Zwei handgewebte Netela-Schals für meine Cousinen','delivered',8.1,20],
      ['Yonas Haile','Traveler','to','Frankfurt','Flying Dec 2 from Frankfurt, half a suitcase free','Abflug 2. Dez. ab Frankfurt, halber Koffer frei','waiting',9.0,null]
    ].map(([name,role,dir,city,en,de,status,ago,fee], i)=>({name, email: name.split(' ')[0].toLowerCase()+'@example.com', role, dir, city,
      home: ['Addis Ababa','Addis Ababa','Bahir Dar','Mekelle','Gambela','Addis Ababa','Dire Dawa','Hawassa','Adigrat','Jimma'][i],
      message: lang==='de'?de:en, status, fee, at: now - ago*DAY}));
    const rt = (dir, city, home) => routeLabel(dir, city, home);
    return {
      days, visitors, orders, totalV, totalO, avgTime: 168, conversion: totalO/totalV,
      senders, travelers, match: {rate: 0.64, days: 3.2},
      funnel: {visits: totalV, started: Math.round(totalO/0.45), submitted: totalO},
      delivered, fees, cut: fees*0.15,
      dests: split(totalO, [[rt('to','Washington DC','Addis Ababa'),31],[rt('to','Frankfurt','Addis Ababa'),14],[rt('from','Washington DC','Addis Ababa'),12],[rt('to','London','Hawassa'),10],[rt('to','Frankfurt','Mekelle'),8],[t('lbl.otherRoutes'),25]]),
      sources: split(totalV, [['WhatsApp',38],['Facebook',24],['Google',17],[lbl('Direct'),13],['Instagram',6],['TikTok',2]]),
      locations: split(totalV, [[lbl('United States'),52],[lbl('Ethiopia'),14],[lbl('Canada'),9],[lbl('United Kingdom'),7],[lbl('Germany'),5],[t('lbl.otherCountries'),13]]),
      devices: split(totalV, [[lbl('Phone'),78],[lbl('Desktop'),18],[lbl('Tablet'),4]]),
      orderRows: rows, live: false
    };
  }

  const tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.hidden = true; tipEl.setAttribute('role','presentation'); document.body.appendChild(tipEl);
  function showTip(ev, html){
    tipEl.innerHTML = html; tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect(); let x = ev.clientX + 14, y = ev.clientY + 14;
    if(x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
    if(y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
    tipEl.style.left = x+'px'; tipEl.style.top = y+'px';
  }
  function hideTip(){ tipEl.hidden = true; }
  function roundedTop(x, y, w, h, r){ r = Math.min(r, h, w/2); return `M${x},${y+h} L${x},${y+r} Q${x},${y} ${x+r},${y} L${x+w-r},${y} Q${x+w},${y} ${x+w},${y+r} L${x+w},${y+h} Z`; }

  function drawTrend(el, days, vals, type, one, many){
    const W = Math.max(260, Math.round(el.clientWidth || 600)), H = 160, L = 36, R = 12, Tp = 10, B = 24;
    const pw = W-L-R, ph = H-Tp-B, n = vals.length, max = niceMax(Math.max(...vals));
    const x = i => type==='bar' ? L + (i+0.5)*pw/n : L + i*pw/(n-1);
    const y = v => Tp + ph - v/max*ph;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(t('chart.aria', {u: t(many)}))}">`;
    [0, max/2, max].forEach(v=>{ s += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end">${fmtInt(v)}</text>`; });
    [0, Math.floor((n-1)/2), n-1].forEach(i=>{ s += `<text x="${x(i)}" y="${H-6}" text-anchor="${i===0?'start':i===n-1?'end':'middle'}">${shortDate(days[i])}</text>`; });
    if(type==='line'){
      const pts = vals.map((v,i)=>x(i).toFixed(1)+','+y(v).toFixed(1));
      s += `<path d="M${pts.join(' L')} L${x(n-1)},${y(0)} L${x(0)},${y(0)} Z" fill="var(--data-1)" opacity=".12"/>`;
      s += `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--data-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      s += `<circle cx="${x(n-1)}" cy="${y(vals[n-1])}" r="4" fill="var(--data-1)" stroke="var(--surface)" stroke-width="2"/>`;
    } else {
      const bw = Math.max(2, pw/n - 2);
      vals.forEach((v,i)=>{ const h = v/max*ph; if(h > 0) s += `<path class="bar" data-i="${i}" d="${roundedTop(x(i)-bw/2, y(v), bw, h, 3)}" fill="var(--data-1)"/>`; });
    }
    s += `<line class="xh" x1="0" x2="0" y1="${Tp}" y2="${Tp+ph}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"/>`;
    s += `<circle class="hd" r="5" fill="var(--data-1)" stroke="var(--surface)" stroke-width="2" opacity="0"/>`;
    s += `<rect class="hit" x="${L}" y="${Tp}" width="${pw}" height="${ph+B}" fill="transparent"/></svg>`;
    el.innerHTML = s;
    const svg = el.querySelector('svg'), xh = svg.querySelector('.xh'), hd = svg.querySelector('.hd'), hit = svg.querySelector('.hit');
    const idx = ev => { const rc = svg.getBoundingClientRect(); const px = (ev.clientX - rc.left) * W / rc.width; const i = type==='bar' ? Math.floor((px-L)/(pw/n)) : Math.round((px-L)/(pw/(n-1))); return Math.max(0, Math.min(n-1, i)); };
    hit.addEventListener('pointermove', ev=>{
      const i = idx(ev);
      if(type==='line'){ xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('opacity','.6'); hd.setAttribute('cx', x(i)); hd.setAttribute('cy', y(vals[i])); hd.setAttribute('opacity','1'); }
      svg.querySelectorAll('.bar').forEach(b=>b.setAttribute('opacity', +b.dataset.i===i ? '1' : '.45'));
      showTip(ev, `<b>${fmtInt(vals[i])}</b> ${esc(unit(vals[i], one, many))}<br><span>${days[i].toLocaleDateString(LOC(), {weekday:'short', month:'short', day:'numeric'})}</span>`);
    });
    hit.addEventListener('pointerleave', ()=>{ xh.setAttribute('opacity','0'); hd.setAttribute('opacity','0'); svg.querySelectorAll('.bar').forEach(b=>b.setAttribute('opacity','1')); hideTip(); });
  }
  function drawBars(id, rows, base, many, emptyKey){
    const el = $(id); el.innerHTML = '';
    if(!rows.length || !rows.some(r=>r[1]>0)){ const p = document.createElement('p'); p.className = 'note'; p.textContent = t(emptyKey || 'none.data'); el.appendChild(p); return; }
    const max = Math.max(...rows.map(r=>r[1]), 1);
    rows.forEach(([name, v])=>{
      const row = document.createElement('div'); row.className = 'bar-row';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name;
      const val = document.createElement('span'); val.className = 'v'; val.textContent = fmtInt(v) + (base ? ' · ' + fmtPct(v/base) : '');
      const tr = document.createElement('div'); tr.className = 'bar-track';
      const f = document.createElement('div'); f.className = 'bar-fill'; f.style.width = (v/max*100) + '%';
      tr.appendChild(f); row.append(nm, val, tr);
      row.addEventListener('pointermove', ev=>showTip(ev, `<b>${esc(name)}</b><br>${fmtInt(v)} ${esc(t(many))}${base ? '<br><span>'+esc(t('u.ofTotal', {p: fmtPct(v/base)}))+'</span>' : ''}`));
      row.addEventListener('pointerleave', hideTip);
      el.appendChild(row);
    });
  }
  function drawBalance(s, tr){
    const el = $('balance'), total = s + tr;
    if(!total){ el.innerHTML = `<p class="note">${esc(t('none.orders'))}</p>`; return; }
    const ratio = tr ? s/tr : null;
    const advice = t(ratio===null ? 'b.adviceNone' : ratio > 3 ? 'b.adviceHigh' : ratio < 1 ? 'b.adviceLow' : 'b.adviceOk');
    const big = ratio===null ? t('b.noTravelers') : t('b.ratio', {r: ratio.toLocaleString(LOC(), {minimumFractionDigits:1, maximumFractionDigits:1})});
    el.innerHTML = `<div class="stack-bar" role="img" aria-label="${esc(t('b.aria', {s, t: tr}))}">${s?`<span style="flex:${s};background:var(--c-sender)"></span>`:''}${tr?`<span style="flex:${tr};background:var(--c-traveler)"></span>`:''}</div>
      <div class="legend-rows">
        <div><i style="background:var(--c-sender)"></i>${esc(t('b.senders'))}<b>${fmtInt(s)}</b><span>${fmtPct(s/total)}</span></div>
        <div><i style="background:var(--c-traveler)"></i>${esc(t('b.travelers'))}<b>${fmtInt(tr)}</b><span>${fmtPct(tr/total)}</span></div>
      </div>
      <p class="big">${esc(big)}</p>
      <p class="note">${esc(advice)}</p>`;
  }
  async function liveData(){
    const since = new Date(Date.now() - 30*DAY).toISOString();
    const [rq, vs, op, mt] = await Promise.all([
      sb.from('requests').select(REQ_COLS).gte('created_at', since).order('created_at', {ascending:false}).limit(1000),
      sb.from('visits').select('created_at, source, device, time_zone, duration_s, form_started').gte('created_at', since).limit(1000),
      // matching works on every open request, however old
      sb.from('requests').select(REQ_COLS).in('status', ['new', 'waiting', 'matched', 'accepted', 'handed_over'])
        .order('created_at', {ascending:true}).limit(1000),
      sb.from('matches').select('id, status, sender_request_id, traveler_request_id, created_at').in('status', ['proposed', 'accepted', 'completed'])
        .order('created_at', {ascending:false}).limit(1000)
    ]);
    for(const r of [rq, vs, op, mt]) if(r.error) throw r.error;
    const R = rq.data.map(fromDb), V = vs.data;
    const days = lastNDays(30), keys = days.map(d=>dayKey(d)), vBy = {}, oBy = {};
    keys.forEach(k=>{ vBy[k]=0; oBy[k]=0; });
    V.forEach(v=>{ const k = dayKey(Date.parse(v.created_at)); if(k in vBy) vBy[k]++; });
    R.forEach(r=>{ const k = dayKey(r.at); if(k in oBy) oBy[k]++; });
    const timed = V.filter(v=>v.duration_s > 1);
    const items = R.filter(r=>r.role === 'Sender' && r.status !== 'cancelled');
    const matched = items.filter(r=>['matched', 'accepted', 'handed_over', 'delivered'].includes(r.status)).length;
    const done = R.filter(r=>r.status === 'delivered' && r.role === 'Sender');
    const fees = done.reduce((a,r)=>a + (Number(r.fee) || 0), 0);
    const started = Math.max(V.filter(v=>v.form_started).length, R.length);
    return {
      days, visitors: keys.map(k=>vBy[k]), orders: keys.map(k=>oBy[k]), totalV: V.length, totalO: R.length,
      avgTime: timed.length ? timed.reduce((a,v)=>a+v.duration_s,0)/timed.length : 0,
      conversion: V.length ? R.length/V.length : 0,
      senders: R.filter(r=>r.role==='Sender').length, travelers: R.filter(r=>r.role==='Traveler').length,
      match: items.length ? {rate: matched/items.length, days: null} : null,
      funnel: {visits: V.length, started, submitted: R.length},
      delivered: done.length, fees, cut: fees*0.15,
      dests: countBy(R, r=>routeLabel(r.dir, r.city, r.home)).slice(0,6),
      sources: countBy(V, v=>lbl(v.source || 'Direct')).slice(0,6),
      locations: countBy(V, v=>(v.time_zone || t('lbl.unknownTz')).replace(/_/g,' ')).slice(0,6),
      devices: countBy(V, v=>lbl(v.device || 'Desktop')),
      orderRows: R, live: true,
      open: op.data.map(fromDb), matches: mt.data
    };
  }

  // ---------- orders table: filters, notes, export ----------
  const STATUSES = ['new', 'waiting', 'matched', 'accepted', 'handed_over', 'delivered', 'cancelled'];
  let lastD = null;
  async function saveRequest(id, patch, flag){
    flag.className = 'saved-flag'; flag.textContent = '…';
    const { error } = await sb.from('requests').update(patch).eq('id', id);
    flag.className = 'saved-flag' + (error ? ' err' : '');
    flag.textContent = t(error ? 'o.saveErr' : 'o.saved');
  }
  function fillStatusFilter(){
    const sel = $('f-status'), keep = sel.value;
    sel.innerHTML = `<option value="">${esc(t('o.allStatuses'))}</option>` + STATUSES.map(s => `<option value="${s}">${esc(t('st.' + s))}</option>`).join('');
    sel.value = keep;
  }
  function filteredRows(rows){
    const q = $('f-q').value.trim().toLowerCase(), st = $('f-status').value, ty = $('f-type').value, dir = $('f-dir').value;
    return rows.filter(r => (!st || r.status === st) && (!ty || r.role === ty) && (!dir || r.dir === dir) &&
      (!q || [r.name, r.email, r.phone, r.city, r.home, homeName(r.home), r.message, String(r.id), r.itemType && typeName(r.itemType)].some(x => x && String(x).toLowerCase().includes(q))));
  }
  ['f-q', 'f-status', 'f-type', 'f-dir'].forEach(id => $(id).addEventListener('input', () => { if(lastD) drawOrders(lastD); }));

  async function loadNotes(id, box){
    box.innerHTML = `<p class="note">${esc(t('o.notesLoading'))}</p>`;
    const { data, error } = await sb.from('request_notes').select('id, body, created_at').eq('request_id', id).order('created_at', {ascending:true});
    box.innerHTML = '';
    if(error){ box.appendChild(el('p', 'note', esc(t('o.notesErr')))); return; }
    if(!data.length) box.appendChild(el('p', 'note', esc(t('o.notesNone'))));
    data.forEach(n => box.appendChild(el('div', 'note-item', `${esc(n.body)}<small>${esc(fmtDate(Date.parse(n.created_at)))}</small>`)));
    const f = el('form'); f.noValidate = true;
    const taId = 'note-' + id;
    f.innerHTML = `<label for="${taId}" class="sr">${esc(t('o.noteAdd'))}</label><textarea id="${taId}" maxlength="2000" placeholder="${esc(t('o.notePh'))}"></textarea>
      <button class="btn btn-primary btn-sm" type="submit">${esc(t('o.noteAdd'))}</button>`;
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const body = f.querySelector('textarea').value.trim(); if(!body) return;
      const { error: err } = await sb.from('request_notes').insert({ request_id: id, body });
      if(err) return box.appendChild(el('p', 'note', esc(t('o.notesErr'))));
      loadNotes(id, box);
    });
    box.appendChild(f);
  }

  function drawOrders(D){
    lastD = D;
    const rows = filteredRows(D.orderRows), tb = $('ordersBody'); tb.innerHTML = '';
    const total = D.orderRows.length;
    $('ordersSub').textContent = (D.live ? (total === 1 ? t('o.liveSub1') : t('o.liveSub', {n: fmtInt(total)})) : t('o.sampleSub'))
      + (rows.length !== total ? ' · ' + t('o.shown', {n: fmtInt(rows.length)}) : '');
    if(!rows.length){
      const tr = el('tr'), td = el('td', 'note'); td.colSpan = 8; td.textContent = t(total ? 'o.noMatch' : 'o.empty'); tr.appendChild(td); tb.appendChild(tr); return;
    }
    rows.forEach(m=>{
      const tr = el('tr');
      const td = cls=>{ const c = el('td', cls); tr.appendChild(c); return c; };
      td('nowrap').textContent = fmtDate(m.at);
      const who = td(); who.textContent = m.name; who.appendChild(el('small', null, esc(m.email))); if(m.phone) who.appendChild(el('small', null, esc(m.phone)));
      td('nowrap').textContent = t('role.' + (m.role || 'Sender'));
      td('nowrap').textContent = routeLabel(m.dir, m.city, m.home);
      const det = td('details'); det.textContent = m.message;
      if(m.itemType || m.flight) det.appendChild(el('small', null, esc(summary(m))));
      const stCell = td(), feeCell = td('nowrap'), notesCell = td('nowrap');
      if(D.live){
        const sel = el('select', 'cell-input'); sel.setAttribute('aria-label', t('o.statusAria', {id: m.id}));
        STATUSES.forEach(s=>{ const o = el('option'); o.value = s; o.textContent = t('st.' + s); if(s === m.status) o.selected = true; sel.appendChild(o); });
        const flag1 = el('span', 'saved-flag');
        sel.addEventListener('change', ()=>saveRequest(m.id, {status: sel.value}, flag1));
        stCell.append(sel, flag1);
        const fee = el('input', 'cell-input'); fee.type = 'number'; fee.min = '0'; fee.step = '1';
        fee.value = m.fee == null ? '' : m.fee; fee.setAttribute('aria-label', t('o.feeAria', {id: m.id}));
        const flag2 = el('span', 'saved-flag');
        fee.addEventListener('change', ()=>{ const v = fee.value === '' ? null : Math.max(0, Number(fee.value)); saveRequest(m.id, {fee_usd: v}, flag2); });
        feeCell.append(fee, flag2);
        const nb = button('o.notes'); nb.setAttribute('aria-expanded', 'false');
        nb.addEventListener('click', () => {
          const next = tr.nextElementSibling;
          if(next && next.classList.contains('notes-row')){ next.remove(); nb.setAttribute('aria-expanded', 'false'); return; }
          const nr = el('tr', 'notes-row'), nc = el('td'); nc.colSpan = 8; const box = el('div', 'notes'); nc.appendChild(box); nr.appendChild(nc);
          tr.after(nr); nb.setAttribute('aria-expanded', 'true'); loadNotes(m.id, box);
        });
        notesCell.appendChild(nb);
      } else {
        stCell.appendChild(el('span', 'chip ' + m.status, esc(t('st.' + m.status))));
        feeCell.textContent = m.fee == null ? '—' : fmtMoney(m.fee);
        notesCell.textContent = '—';
      }
      tb.appendChild(tr);
    });
  }
  $('exportCsv').addEventListener('click', () => {
    if(!lastD) return;
    const cols = ['id', 'created_at', 'type', 'direction', 'home_city', 'diaspora_city', 'status', 'name', 'email', 'phone', 'item_type', 'weight_kg', 'ready_date', 'needed_by', 'flight_date', 'space_kg', 'fee_usd', 'details'];
    const cell = v => { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [cols.join(',')].concat(filteredRows(lastD.orderRows).map(r => [r.id, new Date(r.at).toISOString(), r.role === 'Traveler' ? 'trip' : 'item',
      r.dir === 'from' ? 'from' : 'to', r.home, r.city, r.status, r.name, r.email, r.phone, r.itemType, r.weight, r.ready, r.needed, r.flight, r.space, r.fee, r.message].map(cell).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = `jebena-express-requests-${todayISO()}.csv`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  let dashSrc = sb ? 'live' : 'sample', dashSeq = 0;
  function kpi(label, val, sub, na){ return `<div class="kpi${na?' na':''}"><span class="k-label">${esc(label)}</span><span class="k-val">${esc(val)}</span><span class="k-sub">${esc(sub)}</span></div>`; }
  async function renderDashboard(){
    const seq = ++dashSeq;
    document.querySelectorAll('.seg button').forEach(b=>{ b.setAttribute('aria-pressed', String(b.dataset.src===dashSrc)); if(b.dataset.src === 'live') b.disabled = !sb; });
    const banner = $('srcBanner');
    let D;
    if(dashSrc === 'live' && sb){
      banner.textContent = t('banner.loading');
      try{ D = await liveData(); }
      catch(err){ if(seq === dashSeq) banner.textContent = t('banner.error', {m: (err && err.message) || ''}); return; }
      if(seq !== dashSeq) return;
      banner.textContent = t('banner.live');
    } else {
      D = sampleData(); banner.textContent = t('banner.sample');
    }
    $('locSub').textContent = t(D.live ? 'd.locLive' : 'd.locSample');
    $('kpis').innerHTML = [
      kpi(t('k.orders'), fmtInt(D.totalO), t('k.last30')),
      kpi(t('k.visitors'), fmtInt(D.totalV), t('k.last30')),
      kpi(t('k.time'), D.avgTime ? fmtDur(D.avgTime) : '—', t('k.perVisit')),
      kpi(t('k.conv'), D.totalV ? fmtPct(D.conversion) : '—', t('k.convSub')),
      D.match ? kpi(t('k.match'), fmtPct(D.match.rate), D.match.days == null ? t('k.matchSubLive') : t('k.matchSub', {d: D.match.days.toLocaleString(LOC())})) : kpi(t('k.match'), '—', t('k.matchSubLive'), true),
      kpi(t('k.drop'), D.funnel.started ? fmtPct(1 - D.funnel.submitted/D.funnel.started) : '—', t('k.dropSub')),
      kpi(t('k.deliv'), fmtInt(D.delivered), t('k.delivSub', {m: fmtMoney(D.fees)})),
      kpi(t('k.rev'), fmtMoney(D.cut), t('k.revSub'))
    ].join('');
    drawTrend($('trendVisitors'), D.days, D.visitors, 'line', 'u.visitor', 'u.visitors');
    drawTrend($('trendOrders'), D.days, D.orders, 'bar', 'u.order', 'u.orders');
    drawBalance(D.senders, D.travelers);
    drawBars('dests', D.dests, D.totalO, 'u.orders', 'none.orders');
    drawBars('sources', D.sources, D.totalV, 'u.visitors');
    drawBars('locations', D.locations, D.totalV, 'u.visitors');
    drawBars('devices', D.devices, D.totalV, 'u.visitors');
    const f = D.funnel;
    drawBars('funnel', [[t('f.visited'), f.visits], [t('f.started'), f.started], [t('f.sent'), f.submitted]], f.visits, 'u.visitors');
    fillStatusFilter();
    drawOrders(D);
    drawMatching(D);
  }
  document.querySelectorAll('.seg button').forEach(b=>b.addEventListener('click', ()=>{ dashSrc = b.dataset.src; renderDashboard(); }));
  let rsz; window.addEventListener('resize', ()=>{ clearTimeout(rsz); rsz = setTimeout(()=>{ if(view === 'admin') renderDashboard(); }, 250); });

  // ---------- matching (admin) ----------
  // Suggestions are worked out here; the database (create_match) re-checks
  // everything and has the final say, including emails we can't see here.
  const normName = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}]+/gu, '');
  const normCity = s => String(s || '').trim().toLowerCase();
  const digits = s => String(s || '').replace(/\D/g, '');
  const samePerson = (a, b) => (a.userId && a.userId === b.userId) || a.email.toLowerCase() === b.email.toLowerCase() || (a.phone && digits(a.phone) === digits(b.phone));
  function matchMsg(kind, key, vars){ const m = $('matchMsg'); m.className = 'status ' + kind; m.textContent = t(key, vars); m.hidden = false; }
  function matchErrKey(err){
    const m = String((err && err.message) || '');
    for(const code of ['match_same_account', 'match_same_email', 'match_sender_taken', 'match_wrong_direction', 'match_wrong_country', 'match_closed', 'match_needs_confirm',
                       'match_not_found', 'match_dates', 'match_no_space', 'match_trip_past', 'match_handed_over'])
      if(m.includes(code)) return 'm.err.' + code.replace('match_', '');
    return 'm.err.generic';
  }
  async function doMatch(s, tr, confirm){
    const { error } = await sb.rpc('create_match', { p_sender_request: s.id, p_traveler_request: tr.id, p_confirm: confirm });
    if(error) return matchMsg('err', matchErrKey(error));
    await renderDashboard();
    matchMsg('ok', 'm.done', { s: s.name, t: tr.name });
  }
  async function undoMatch(id){
    const { error } = await sb.rpc('cancel_match', { p_match_id: id });
    if(error) return matchMsg('err', matchErrKey(error));
    await renderDashboard();
    matchMsg('ok', 'm.cancelled');
  }
  function drawMatching(D){
    const body = $('matchBody'); body.innerHTML = '';
    if(!D.live){ $('matchMsg').hidden = true; body.innerHTML = `<p class="note">${esc(t('m.sampleNote'))}</p>`; return; }
    const byId = new Map(D.orderRows.concat(D.open).map(r => [r.id, r]));
    const active = D.matches.filter(m => m.status === 'proposed' || m.status === 'accepted');
    const taken = new Set(active.map(m => m.sender_request_id));
    const usedKg = trId => D.matches.filter(m => m.traveler_request_id === trId).reduce((a, m) => a + ((byId.get(m.sender_request_id) || {}).weight || 0), 0);
    const today = todayISO();
    const trips = D.open.filter(r => r.role === 'Traveler' && ['new', 'waiting', 'matched'].includes(r.status) && r.flight >= today)
      .sort((a, b) => a.flight < b.flight ? -1 : 1);
    const items = D.open.filter(r => r.role === 'Sender' && ['new', 'waiting'].includes(r.status) && !taken.has(r.id));

    const secTrips = el('div', 'match-section', `<h4>${esc(t('m.openTrips'))}</h4>`);
    if(!trips.length) secTrips.appendChild(el('p', 'note', esc(t('m.noTrips'))));
    trips.forEach(tr=>{
      const used = usedKg(tr.id), left = Math.max(0, (tr.space || 0) - used);
      const box = el('div', 'trip');
      box.innerHTML = `<div class="trip-head"><div><b>${esc(tr.name)}</b> <span class="muted">${esc(routeLabel(tr.dir, tr.city, tr.home))}</span></div>
        <span class="muted">${esc(t('m.flight', {d: fmtDay(tr.flight)}))} · ${esc(t('m.spaceLeft', {left: fmtKg(left), total: fmtKg(tr.space)}))}</span></div>
        <div class="trip-details">${esc(tr.message)}</div>`;
      const list = el('div', 'cands');
      // Same direction and same country; other cities are flagged.
      const same = items.filter(s => s.dir === tr.dir && countryOf(s.home) === countryOf(tr.home));
      const hiddenSelf = same.filter(s => samePerson(s, tr));
      const fits = s => s.ready <= addDays(tr.flight, -1) && (!s.needed || s.needed >= tr.flight) && (s.weight || 0) <= left + 1e-9;
      const others = same.filter(s => !samePerson(s, tr));
      const noFit = others.filter(s => !fits(s));
      const cands = others.filter(fits)
        .sort((a, b) => (b.home === tr.home) - (a.home === tr.home) || (normCity(b.city) === normCity(tr.city)) - (normCity(a.city) === normCity(tr.city)) || a.at - b.at)
        .slice(0, 8);
      if(!cands.length) list.appendChild(el('div', 'cand-empty', esc(t('m.noCands'))));
      cands.forEach(s=>{
        const cityOk = normCity(s.city) === normCity(tr.city), homeOk = s.home === tr.home, nameAlike = normName(s.name) === normName(tr.name);
        const flag = (ok, c) => ok ? `<span class="flag good">${esc(t('m.sameCity', {c}))}</span>` : `<span class="flag warn">${esc(t('m.otherCity', {c}))}</span>`;
        const flags = [flag(homeOk, homeName(s.home)), flag(cityOk, s.city)];
        if(nameAlike) flags.push(`<span class="flag warn">${esc(t('m.sameName'))}</span>`);
        const row = el('div', 'cand');
        row.innerHTML = `<div><div class="who">${esc(s.name)} <span class="muted">· ${esc(routeLabel(s.dir, s.city, s.home))}</span></div>
          <div class="what">${esc(summary(s))}${s.needed ? ' · ' + esc(t('m.neededBy', {d: fmtDay(s.needed)})) : ''} · ${esc(s.message)}</div><div class="flags">${flags.join('')}</div></div>`;
        const btn = button('m.match', 'btn-primary');
        if(!cityOk || !homeOk || nameAlike) twoStep(btn, 'm.confirm', ()=>doMatch(s, tr, true));
        else btn.addEventListener('click', ()=>doMatch(s, tr, false));
        row.appendChild(btn); list.appendChild(row);
      });
      if(noFit.length) list.appendChild(el('div', 'hidden-note', esc(t(noFit.length === 1 ? 'm.noFit1' : 'm.noFitN', {n: noFit.length}))));
      if(hiddenSelf.length) list.appendChild(el('div', 'hidden-note', esc(t(hiddenSelf.length === 1 ? 'm.hidden1' : 'm.hiddenN', {n: hiddenSelf.length}))));
      box.appendChild(list); secTrips.appendChild(box);
    });
    body.appendChild(secTrips);

    const secActive = el('div', 'match-section', `<h4>${esc(t('m.active'))}</h4>`);
    const pairs = active.map(m => ({ m, s: byId.get(m.sender_request_id), tr: byId.get(m.traveler_request_id) })).filter(p => p.s && p.tr);
    if(!pairs.length) secActive.appendChild(el('p', 'note', esc(t('m.noActive'))));
    pairs.forEach(({ m, s, tr })=>{
      const state = s.status === 'handed_over' ? 'handed_over' : m.status === 'accepted' ? 'accepted' : 'matched';
      const row = el('div', 'pair', `<div><b>${esc(s.name)}</b> → <b>${esc(tr.name)}</b> <span class="chip ${state}">${esc(t(m.status === 'proposed' ? 'm.st.proposed' : state === 'handed_over' ? 'm.st.carrying' : 'm.st.accepted'))}</span>
        <div class="pr-route">${esc(routeLabel(s.dir, s.city, s.home))} · ${esc(summary(s))} · ${esc(t('m.matchedOn', {d: fmtDate(Date.parse(m.created_at))}))}</div></div>`);
      if(s.status !== 'handed_over'){
        const btn = button('m.cancel'); twoStep(btn, 'm.cancelConfirm', ()=>undoMatch(m.id));
        row.appendChild(btn);
      }
      secActive.appendChild(row);
    });
    body.appendChild(secActive);
  }

  // ---------- jebena pour (How it works) ----------
  const jebena = $('jebena'), stream = $('stream'), cupFill = $('cupFill'), crema = $('crema'), steam = $('steam'), dropsG = $('drops');
  const stepsEl = $('steps'), stepCards = [...stepsEl.querySelectorAll('.step')], howVisual = document.querySelector('.how-visual');
  const desktopQ = window.matchMedia('(min-width: 861px)');
  const PIVOT = {x:270, y:366}, TIP = {x:122, y:168}, MAX_TILT = 44, POUR_START = 0.18;
  const CUP_X = 90, CUP_BOTTOM = 508, CUP_TOP = 456;
  const drops = [];
  if(!reduce){
    for(let i=0;i<4;i++){
      const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
      c.setAttribute('r', i%2?2.4:3.2); c.setAttribute('opacity','0'); dropsG.appendChild(c); drops.push({el:c, off:i/4});
    }
  }
  let target = 0, current = 0, ticking = false, lastStep = -1;
  const clamp = (v,a=0,b=1)=>Math.min(b,Math.max(a,v));
  function progress(){
    const vh = window.innerHeight;
    if(desktopQ.matches){
      const r = stepsEl.getBoundingClientRect();
      return clamp((vh*0.6 - r.top) / Math.max(1, r.height - vh*0.2));
    }
    const r = howVisual.getBoundingClientRect();
    return clamp((vh*0.95 - r.top) / (vh*0.75));
  }
  function setStepCaption(act){
    $('howStepLabel').textContent = t('step.label', {n: act+1});
    $('howStepName').textContent = '· ' + t('step' + (act+1) + '.short');
  }
  function onScroll(){
    topbar.classList.toggle('scrolled', window.scrollY > 8);
    target = progress();
    const vh = window.innerHeight; let act = 0;
    stepCards.forEach((s,i)=>{ if(s.getBoundingClientRect().top < vh*0.55) act = i; });
    if(act !== lastStep){
      lastStep = act;
      stepCards.forEach((s,i)=>s.classList.toggle('on', i===act));
      setStepCaption(act);
    }
    if(!ticking){ ticking = true; requestAnimationFrame(frame); }
  }
  function frame(ts){
    current += (target - current) * (reduce ? 1 : 0.14);
    if(Math.abs(target-current) < 0.0005) current = target;
    const p = current;
    const angle = -MAX_TILT * (p < .5 ? 2*p*p : 1 - Math.pow(-2*p+2,2)/2);
    jebena.setAttribute('transform', `rotate(${angle.toFixed(2)} ${PIVOT.x} ${PIVOT.y})`);
    const r = angle*Math.PI/180, dx = TIP.x-PIVOT.x, dy = TIP.y-PIVOT.y;
    const tip = { x: PIVOT.x + dx*Math.cos(r) - dy*Math.sin(r), y: PIVOT.y + dx*Math.sin(r) + dy*Math.cos(r) };
    const fill = clamp((p - POUR_START - 0.04) / (0.96 - POUR_START));
    const surface = CUP_BOTTOM - fill*(CUP_BOTTOM - CUP_TOP - 4);
    cupFill.setAttribute('y', surface.toFixed(1));
    crema.setAttribute('y', (surface-2).toFixed(1));
    crema.setAttribute('opacity', fill>0.02 ? '1':'0');
    steam.classList.toggle('on', fill > 0.25);
    $('howMeter').style.width = (fill*100).toFixed(1) + '%';
    const pourAmt = clamp((p - POUR_START)/0.06);
    const endY = Math.max(surface, tip.y + 20);
    stream.setAttribute('d', `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} C${(tip.x-14).toFixed(1)} ${(tip.y+18).toFixed(1)} ${(CUP_X-4).toFixed(1)} ${(endY-60).toFixed(1)} ${CUP_X} ${endY.toFixed(1)}`);
    const amt = fill >= 1 ? Math.max(0, 1 - (p-0.96)*30) : pourAmt;
    stream.setAttribute('stroke-dashoffset', (1-amt).toFixed(3));
    stream.setAttribute('stroke-width', (3 + 4*amt).toFixed(1));
    const now = (ts||0)/1000;
    drops.forEach((dr,i)=>{
      if(amt < 0.6){ dr.el.setAttribute('opacity','0'); return; }
      const k = (now*0.9 + dr.off) % 1, mid = (tip.y + endY)/2;
      dr.el.setAttribute('cx', (CUP_X + (i%2? 7 : -7) - k*2).toFixed(1));
      dr.el.setAttribute('cy', (mid + k*(endY - mid)).toFixed(1));
      dr.el.setAttribute('opacity', (0.8*(1-k)).toFixed(2));
    });
    const visible = view === 'home';
    if(visible && (current !== target || (amt >= 0.6 && drops.length))) requestAnimationFrame(frame); else ticking = false;
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  window.addEventListener('resize', onScroll);

  // ---------- language switch ----------
  function applyLang(){
    applyStatic();
    if(!sb) $('sysbar').textContent = t('backend.off');
    setMenu(nav.dataset.open === 'true');
    fillHomeSelect($('h-home')); fillHomeSelect(cForm.home);
    setHeroRole(heroRole); setHeroDir(heroDir);
    setRoleUI(); setFormDir();
    setStepCaption(Math.max(0, lastStep));
    $('bookErr').hidden = true; cStatus.hidden = true;
    renderAuthButtons(); prefillContact();
    if(!authOverlay.hidden) renderAuthMode();
    if(view === 'admin') renderDashboard();
    if(view === 'account') renderAccount();
    if(view === 'status' && statusId) renderStatus(statusId);
  }
  document.querySelectorAll('.lang button').forEach(b=>b.addEventListener('click', ()=>{
    if(b.dataset.lang === lang) return;
    lang = b.dataset.lang; store.set('jb_lang', lang); applyLang();
  }));

  setDateLimits();
  applyLang();
  onScroll();
  if(!sb) route();
})();
