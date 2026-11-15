IOS.requireAuth();
IOS.renderTopbar('topbar', { back: '/dashboard.html' });

const state = {
  mode: 'ai',
  questions: [],
};

const els = {
  title: document.getElementById('title'),
  role: document.getElementById('role'),
  duration: document.getElementById('duration'),
  numQuestions: document.getElementById('num-questions'),
  topics: document.getElementById('topics'),
  difficulty: document.getElementById('difficulty'),
  timePerQuestion: document.getElementById('time-per-question'),
  questionsList: document.getElementById('questions-list'),
  generateBtn: document.getElementById('generate-btn'),
  addBtn: document.getElementById('add-question-btn'),
  saveBtn: document.getElementById('save-btn'),
  aiControls: document.getElementById('ai-controls'),
};

document.querySelectorAll('.mode-option').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.mode-option').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    state.mode = opt.dataset.mode;
    els.aiControls.style.display = state.mode === 'ai' ? '' : 'none';
  });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function renderQuestions() {
  if (!state.questions.length) {
    els.questionsList.innerHTML = `<div class="text-dim text-sm">No questions yet. ${state.mode === 'ai' ? 'Click Generate above, or add one manually.' : 'Click + Add question below.'}</div>`;
    return;
  }
  els.questionsList.innerHTML = state.questions.map((q, idx) => `
    <div class="question-item" data-idx="${idx}">
      <div class="num">${idx + 1}.</div>
      <div class="body">
        <textarea class="q-text" placeholder="Question text">${escapeHtml(q.text)}</textarea>
        <div class="row">
          <div class="time-input">
            <input class="q-time" type="number" min="30" max="900" value="${q.time_limit_seconds}" />
          </div>
          <div class="text-dim text-sm" style="display:flex;align-items:center;">seconds for answer</div>
          <div style="flex:1"></div>
          <button class="remove" data-action="remove" data-idx="${idx}">remove</button>
        </div>
      </div>
    </div>
  `).join('');

  els.questionsList.querySelectorAll('.q-text').forEach((ta, idx) => {
    ta.addEventListener('input', e => { state.questions[idx].text = e.target.value; });
  });
  els.questionsList.querySelectorAll('.q-time').forEach((inp, idx) => {
    inp.addEventListener('input', e => {
      state.questions[idx].time_limit_seconds = Number(e.target.value) || 180;
    });
  });
  els.questionsList.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.questions.splice(Number(btn.dataset.idx), 1);
      renderQuestions();
    });
  });
}

els.addBtn.addEventListener('click', () => {
  state.questions.push({
    text: '',
    time_limit_seconds: Number(els.timePerQuestion.value) || 180,
    expected_topics: [],
  });
  renderQuestions();
});

els.generateBtn.addEventListener('click', async () => {
  const role = els.role.value.trim() || els.title.value.trim();
  const topics = els.topics.value.trim();
  const n = Math.max(1, Math.min(20, Number(els.numQuestions.value) || 6));
  const difficulty = els.difficulty.value;
  const timePer = Number(els.timePerQuestion.value) || 180;

  if (!role) {
    IOS.toast('Add a role or title first.', 'error');
    return;
  }
  IOS.showLoading('Generating questions with AI…');
  els.generateBtn.disabled = true;

  try {
    const generated = await IOS.api('/api/generate-questions', {
      method: 'POST',
      body: { role, topics, n, difficulty },
    });
    const items = generated.questions || [];

    if (!items.length) throw new Error('AI returned no questions.');

    items.forEach(q => {
      state.questions.push({
        text: String(q.text || q.question || '').trim(),
        time_limit_seconds: Number(q.time_limit_seconds) || timePer,
        expected_topics: Array.isArray(q.expected_topics) ? q.expected_topics : [],
      });
    });

    renderQuestions();
    IOS.toast(`Added ${items.length} questions.`, 'success');
  } catch (err) {
    console.error(err);
    IOS.toast(err.message || 'AI generation failed.', 'error');
  } finally {
    IOS.hideLoading();
    els.generateBtn.disabled = false;
  }
});

els.saveBtn.addEventListener('click', async () => {
  const title = els.title.value.trim();
  if (!title) { IOS.toast('Add a title.', 'error'); return; }
  if (!state.questions.length) { IOS.toast('Add at least one question.', 'error'); return; }
  const filled = state.questions.filter(q => q.text.trim().length > 0);
  if (filled.length === 0) { IOS.toast('Questions need text.', 'error'); return; }

  IOS.showLoading('Saving test…');
  els.saveBtn.disabled = true;

  try {
    const test = await IOS.api('/api/tests', {
      method: 'POST',
      body: {
        title,
        role: els.role.value.trim(),
        duration_minutes: Number(els.duration.value) || 60,
        questions: filled,
      },
    });
    window.location.href = `/test.html?code=${encodeURIComponent(test.code)}&new=1`;
  } catch (err) {
    IOS.toast(err.message, 'error');
    els.saveBtn.disabled = false;
  } finally {
    IOS.hideLoading();
  }
});

renderQuestions();
