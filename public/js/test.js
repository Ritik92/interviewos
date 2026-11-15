IOS.requireAuth();
IOS.renderTopbar('topbar', { back: '/dashboard.html' });

const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').toUpperCase();
const isNew = params.get('new') === '1';
const content = document.getElementById('content');

let currentTest = null;
let pollTimer = null;
let lastSubmissionsSig = '';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

function candidateUrl() {
  return `${location.origin}/candidate.html?code=${encodeURIComponent(code)}`;
}

async function loadTest() {
  currentTest = await IOS.api(`/api/tests/${code}`);
  return currentTest;
}

async function loadLiveState() {
  try {
    const r = await fetch(`/api/tests/${code}/state`, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json();
    return d;
  } catch { return null; }
}

async function loadDeviceStatus() {
  try {
    const r = await fetch('/api/device/status', { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function statePillHtml(state) {
  const phase = (state && state.phase) || 'idle';
  const labels = {
    idle: ['idle', 'var(--text-faint)'],
    welcome: ['welcome', 'var(--cyan)'],
    speaking: ['speaking', 'var(--cyan)'],
    listening: ['listening', '#FF6B9D'],
    processing: ['processing', 'var(--accent)'],
    complete: ['complete', 'var(--success)'],
    error: ['error', 'var(--danger)'],
  };
  const [label, color] = labels[phase] || ['—', 'var(--text-faint)'];
  return `<span class="phase-pill" style="color:${color};border-color:${color}33;background:${color}11;">${label}</span>`;
}

function render() {
  const test = currentTest;
  const responses = test.responses || [];
  content.innerHTML = `
    ${isNew ? `<div class="success-banner">Test created. Run it on the device whenever you're ready.</div>` : ''}

    <div class="page-header">
      <div>
        <h1>${escapeHtml(test.title)}</h1>
        <div class="sub">${escapeHtml(test.role || '')} · created ${fmtDate(test.created_at)}</div>
      </div>
      <div class="row gap-2">
        <button id="copy-code" class="btn btn-secondary">Copy code</button>
        <button id="delete-test" class="btn btn-danger">Delete</button>
      </div>
    </div>

    <div class="code-display">
      <div>
        <div class="label">Test code</div>
        <div class="value">${test.code}</div>
      </div>
      <div class="hint">
        Type this code on the device keypad and press <strong>Enter</strong>.
        Then each student types their roll number and presses <strong>Enter</strong>.
      </div>
    </div>

    <div class="meta-row">
      <div class="item">
        <div class="k">Questions</div>
        <div class="v">${test.questions.length}</div>
      </div>
      <div class="item">
        <div class="k">Total duration</div>
        <div class="v">${test.duration_minutes} min</div>
      </div>
      <div class="item">
        <div class="k">Submissions</div>
        <div class="v">${responses.length}</div>
      </div>
    </div>

    <div class="card mt-3 run-card">
      <div class="row between mb-2">
        <div class="section-title" style="margin-bottom:0;">Run on device</div>
        <div class="device-status" id="device-status">checking…</div>
      </div>

      <div class="text-dim text-sm">
        1. On the device, type <span class="text-mono">${test.code}</span> then <strong>Enter</strong>.
        2. Student types roll number then <strong>Enter</strong>.
        3. Device reads each question; student answers after the beep and presses <strong>Enter</strong> when done.
        Results appear below automatically.
      </div>

      <div class="row gap-2 mt-2" style="flex-wrap:wrap;">
        <a id="open-candidate" class="btn btn-secondary btn-lg" target="_blank">Open live screen ↗</a>
        <button id="copy-candidate" class="btn btn-ghost">Copy candidate URL</button>
      </div>

      <div class="live-state hidden" id="live-state">
        <div class="row between">
          <div class="row gap-2" style="align-items:center;">
            <span class="live-dot"></span>
            <span><strong id="live-candidate">—</strong></span>
            <span id="live-pill"></span>
          </div>
          <div class="text-dim text-sm" id="live-detail">—</div>
        </div>
      </div>
    </div>

    <div class="card mt-3">
      <div class="section-title">Questions</div>
      ${test.questions.map((q, i) => `
        <div class="read-question">
          <div class="top">
            <div class="num">Q${i + 1}</div>
            <div class="time">${q.time_limit_seconds}s</div>
          </div>
          <div class="text">${escapeHtml(q.text)}</div>
        </div>
      `).join('')}
    </div>

    <div class="card mt-3">
      <div class="section-title">Submissions</div>
      <div id="submissions-mount">
        ${renderSubmissions(responses, test)}
      </div>
    </div>
  `;

  document.getElementById('open-candidate').href = candidateUrl();

  document.getElementById('copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(test.code); IOS.toast('Code copied.', 'success'); }
    catch { IOS.toast('Could not copy.', 'error'); }
  });

  document.getElementById('copy-candidate').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(candidateUrl()); IOS.toast('Candidate URL copied.', 'success'); }
    catch { IOS.toast('Could not copy.', 'error'); }
  });

  document.getElementById('delete-test').addEventListener('click', async () => {
    if (!confirm(`Delete test ${test.code}? This cannot be undone.`)) return;
    try { await IOS.api(`/api/tests/${test.code}`, { method: 'DELETE' }); window.location.href = '/dashboard.html'; }
    catch (err) { IOS.toast(err.message, 'error'); }
  });

}

function renderSubmissions(responses, test) {
  if (responses.length === 0) {
    return `<div class="text-dim text-sm">No submissions yet. They'll appear here once the Raspberry Pi posts results.</div>`;
  }
  const sorted = responses.slice().sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  return sorted.map(r => `
    <div class="response-card">
      <div class="head">
        <div>
          <div class="name">${escapeHtml(r.candidate_name)}</div>
          <div class="when">${fmtDate(r.submitted_at)}</div>
        </div>
        ${r.overall_score != null
          ? `<div class="score">${r.overall_score}/10</div>`
          : `<div class="score" style="background:rgba(124,92,255,0.08);color:var(--text-dim);"><span class="spinner" style="width:10px;height:10px;border-width:1.5px;margin-right:6px;"></span>scoring…</div>`}
      </div>
      ${r.answers.map(a => `
        <div class="response-answer">
          <div class="q">Q${a.question_id}: ${escapeHtml((test.questions[a.question_id - 1] || {}).text || '')}</div>
          <div>${escapeHtml(a.transcript || '(no answer)')}</div>
          ${a.audio_url ? `<audio controls preload="none" src="${escapeHtml(a.audio_url)}" style="width:100%;height:32px;margin-top:6px;"></audio>` : ''}
          ${a.score != null
            ? `<div class="text-sm" style="margin-top:6px;color:var(--text-dim);"><strong style="color:var(--accent);">${a.score}/10</strong> · ${escapeHtml(a.feedback || '')}</div>`
            : ''}
        </div>
      `).join('')}
    </div>
  `).join('');
}

async function tick() {
  const [state, device] = await Promise.all([loadLiveState(), loadDeviceStatus()]);
  const statusEl = document.getElementById('device-status');
  if (statusEl) {
    if (device && device.online) {
      statusEl.innerHTML = `<span class="dot-online"></span> Device online${device.version ? ' · v' + escapeHtml(device.version) : ''}`;
      statusEl.className = 'device-status online';
    } else {
      const seen = device && device.last_seen_at ? ` · last seen ${new Date(device.last_seen_at).toLocaleString()}` : '';
      statusEl.innerHTML = `<span class="dot-offline"></span> Device offline${seen}`;
      statusEl.className = 'device-status offline';
    }
  }

  if (state && state.phase && state.phase !== 'idle') {
    const live = document.getElementById('live-state');
    if (live) live.classList.remove('hidden');
    const pill = document.getElementById('live-pill');
    if (pill) pill.innerHTML = statePillHtml(state);
    const detail = document.getElementById('live-detail');
    if (detail) {
      const total = state.total_questions || (currentTest && currentTest.questions.length) || '?';
      const idx = (state.current_question_index ?? -1);
      if (state.phase === 'complete') {
        detail.textContent = 'Interview complete';
      } else if (idx >= 0) {
        detail.textContent = `Question ${idx + 1} of ${total}`;
      } else {
        detail.textContent = state.phase;
      }
    }
    const candEl = document.getElementById('live-candidate');
    if (candEl && state.candidate_name) candEl.textContent = state.candidate_name;
  }

  // Always refresh submissions/scores
  try {
    const fresh = await IOS.api(`/api/tests/${code}`);
    currentTest = fresh;
    const mount = document.getElementById('submissions-mount');
    const sig = JSON.stringify(fresh.responses || []);
    if (mount && sig !== lastSubmissionsSig) {
      lastSubmissionsSig = sig;
      mount.innerHTML = renderSubmissions(fresh.responses || [], fresh);
    }
  } catch {}
}

(async () => {
  if (!code) { content.innerHTML = `<div class="auth-error">No test code provided.</div>`; return; }
  try {
    await loadTest();
    render();
    tick();
    pollTimer = setInterval(tick, 2000);
  } catch (err) {
    content.innerHTML = `<div class="auth-error">${err.message}</div>`;
  }
})();

window.addEventListener('beforeunload', () => { if (pollTimer) clearInterval(pollTimer); });
