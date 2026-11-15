// Shared auth + utility helpers
window.IOS = window.IOS || {};

IOS.SESSION_KEY = 'ios.session';

IOS.getSession = function () {
  try {
    return JSON.parse(localStorage.getItem(IOS.SESSION_KEY));
  } catch {
    return null;
  }
};

IOS.setSession = function (session) {
  localStorage.setItem(IOS.SESSION_KEY, JSON.stringify(session));
};

IOS.clearSession = function () {
  localStorage.removeItem(IOS.SESSION_KEY);
};

IOS.requireAuth = function () {
  const session = IOS.getSession();
  if (!session) {
    window.location.href = '/index.html';
    return null;
  }
  return session;
};

IOS.logout = async function () {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  IOS.clearSession();
  window.location.href = '/index.html';
};

IOS.toast = function (message, type) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast' + (type ? ' ' + type : ''); }, 2400);
};

IOS.api = async function (path, options) {
  options = options || {};
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  if (res.status === 401) {
    IOS.clearSession();
    window.location.href = '/index.html';
    throw new Error('Please sign in.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
};

IOS.renderTopbar = function (mountId, opts) {
  const el = document.getElementById(mountId);
  if (!el) return;
  const session = IOS.getSession();
  el.innerHTML = `
    <div class="brand">
      <span class="dot"></span>
      <span>InterviewOS</span>
    </div>
    <div class="actions">
      ${opts && opts.back ? `<a class="btn btn-ghost" href="${opts.back}">← Back</a>` : ''}
      ${session ? `<span class="user-pill">${session.username}</span>` : ''}
      <button class="btn btn-ghost" id="ios-logout">Logout</button>
    </div>
  `;
  document.getElementById('ios-logout').addEventListener('click', IOS.logout);
};

IOS.showLoading = function (text) {
  let el = document.querySelector('.loading-overlay');
  if (!el) {
    el = document.createElement('div');
    el.className = 'loading-overlay';
    el.innerHTML = `<div class="panel"><span class="spinner"></span><span class="text"></span></div>`;
    document.body.appendChild(el);
  }
  el.querySelector('.text').textContent = text || 'Working…';
  el.classList.add('show');
};

IOS.hideLoading = function () {
  const el = document.querySelector('.loading-overlay');
  if (el) el.classList.remove('show');
};
