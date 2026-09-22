let mcqData = [];
let mcqAnswered = 0;
let mcqCorrect = 0;
let rawText = '';

function setTopic(t) {
  document.getElementById('topicInput').value = t;
  document.getElementById('topicInput').focus();
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

async function generateStudyMaterial() {
  const topic = document.getElementById('topicInput').value.trim();
  if (!topic) { showError('Please enter a topic.'); return; }

  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  hide('results'); hide('errorState');
  show('loadingState');

  try {
    // 1. Search Wikipedia for best matching article
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&format=json&origin=*&srlimit=1`
    );
    const searchData = await searchRes.json();
    const pages = searchData.query?.search;
    if (!pages || pages.length === 0) throw new Error(`No results found for "${topic}". Try a different topic.`);

    const pageTitle = pages[0].title;

    // 2. Fetch full article extract
    const articleRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=extracts&explaintext=true&exsectionformat=plain&format=json&origin=*`
    );
    const articleData = await articleRes.json();
    const pageObj = Object.values(articleData.query.pages)[0];
    if (!pageObj || !pageObj.extract) throw new Error('Could not fetch article content.');

    rawText = pageObj.extract;
    const actualTitle = pageObj.title;

    // 3. Process into study material
    const material = processContent(actualTitle, rawText);
    renderResults(actualTitle, material);

  } catch (e) {
    showError(e.message || 'Something went wrong. Try again.');
  } finally {
    btn.disabled = false;
    hide('loadingState');
  }
}

// ── Content Processing ──────────────────────────────────────────────

function processContent(title, text) {
  const sentences = splitSentences(text);
  const paragraphs = splitParagraphs(text);

  return {
    shortNotes:       buildShortNotes(title, text, paragraphs),
    keyPoints:        buildKeyPoints(sentences),
    mcqs:             buildMCQs(sentences, title),
    simpleExplanation: buildSimpleExplanation(title, paragraphs, sentences)
  };
}

function splitSentences(text) {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 40 && s.length < 300 && /[a-zA-Z]/.test(s));
}

function splitParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(p => p.length > 80);
}

function buildShortNotes(title, text, paragraphs) {
  // Split text into sections by Wikipedia headings (== Heading ==)
  const sectionRegex = /={2,3}\s*(.+?)\s*={2,3}/g;
  const rawSections = text.split(sectionRegex);

  let html = '';
  let sectionCount = 0;

  // First chunk = intro
  const intro = rawSections[0];
  const introSentences = splitSentences(intro).slice(0, 4);
  if (introSentences.length) {
    html += `<h3>Introduction</h3><p>${introSentences.join(' ')}</p>`;
    sectionCount++;
  }

  // Named sections
  for (let i = 1; i < rawSections.length - 1; i += 2) {
    const heading = rawSections[i];
    const body    = rawSections[i + 1] || '';
    if (!body.trim() || sectionCount >= 6) continue;
    const sents = splitSentences(body).slice(0, 3);
    if (sents.length === 0) continue;
    const highlighted = highlightTerms(sents.join(' '));
    html += `<h3>${heading}</h3><p>${highlighted}</p>`;
    sectionCount++;
  }

  // Fallback if no sections found
  if (sectionCount < 3) {
    paragraphs.slice(0, 5).forEach((p, i) => {
      const label = i === 0 ? 'Overview' : `Part ${i + 1}`;
      html += `<h3>${label}</h3><p>${highlightTerms(p.slice(0, 400))}</p>`;
    });
  }

  return html;
}

function highlightTerms(text) {
  // Bold capitalized multi-word terms and numbers
  return text
    .replace(/\b([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/g, '<strong>$1</strong>')
    .replace(/\b(\d{4})\b/g, '<strong>$1</strong>');
}

function buildKeyPoints(sentences) {
  // Score sentences by informativeness
  const scored = sentences.map(s => ({
    text: s,
    score: scoreKeyPoint(s)
  }));

  scored.sort((a, b) => b.score - a.score);

  // Deduplicate similar sentences
  const selected = [];
  for (const item of scored) {
    if (selected.length >= 8) break;
    const isDup = selected.some(s => similarity(s.text, item.text) > 0.5);
    if (!isDup) selected.push(item);
  }

  return selected.map(s => cleanSentence(s.text));
}

function scoreKeyPoint(s) {
  let score = 0;
  if (/\b(is|are|was|were|refers to|defined as|known as)\b/i.test(s)) score += 3;
  if (/\b\d{4}\b/.test(s)) score += 2;
  if (/\b(first|discovered|invented|developed|introduced|founded)\b/i.test(s)) score += 2;
  if (/\b(important|significant|major|key|primary|main|essential)\b/i.test(s)) score += 2;
  if (s.length > 80 && s.length < 200) score += 1;
  return score;
}

function similarity(a, b) {
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = new Set(b.toLowerCase().split(/\s+/));
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / Math.max(wa.size, wb.size);
}

function cleanSentence(s) {
  return s.replace(/\s+/g, ' ').replace(/^\s*[,;]\s*/, '').trim();
}

function buildMCQs(sentences, title) {
  const mcqs = [];
  const used = new Set();

  // Filter good candidate sentences for MCQs
  const candidates = sentences.filter(s =>
    s.length > 60 && s.length < 250 &&
    /\b(is|are|was|were|refers to|known as|called|defined)\b/i.test(s)
  );

  for (const sent of candidates) {
    if (mcqs.length >= 5) break;

    const q = tryMakeQuestion(sent, sentences, used);
    if (q) {
      used.add(sent);
      mcqs.push(q);
    }
  }

  // Fallback generic questions if not enough
  while (mcqs.length < 5 && sentences.length > mcqs.length) {
    const s = sentences[mcqs.length * 3] || sentences[mcqs.length];
    if (!s || used.has(s)) break;
    const words = s.split(' ');
    if (words.length < 8) break;
    const blankIdx = Math.floor(words.length * 0.6);
    const answer = words[blankIdx];
    if (answer.length < 3) break;
    const question = words.map((w, i) => i === blankIdx ? '______' : w).join(' ');
    const distractors = getDistractors(answer, sentences, 3);
    const options = shuffle([answer, ...distractors]);
    mcqs.push({
      question: `Fill in the blank: "${question}"`,
      options,
      answer: options.indexOf(answer),
      explanation: `The correct word is "${answer}" based on the original text.`
    });
    used.add(s);
  }

  return mcqs;
}

function tryMakeQuestion(sent, allSentences, used) {
  // Pattern: "X is/was/are Y" → "What is X?"
  const isPattern = sent.match(/^(.{10,60}?)\s+(is|was|are|were|refers to|is known as)\s+(.{10,})/i);
  if (isPattern) {
    const subject = isPattern[1].trim();
    const verb    = isPattern[2];
    const answer  = isPattern[3].split(/[,;]/)[0].trim().slice(0, 80);
    if (answer.split(' ').length < 2) return null;

    const distractors = getDistractors(answer, allSentences, 3);
    if (distractors.length < 3) return null;

    const options = shuffle([answer, ...distractors]);
    return {
      question: `What ${verb} ${subject}?`,
      options,
      answer: options.indexOf(answer),
      explanation: `According to the text: "${sent.slice(0, 120)}..."`
    };
  }
  return null;
}

function getDistractors(correct, sentences, count) {
  const correctWords = new Set(correct.toLowerCase().split(/\s+/));
  const pool = [];

  for (const s of sentences) {
    const chunks = s.split(/[,;.]/).map(c => c.trim()).filter(c => c.length > 15 && c.length < 90);
    for (const chunk of chunks) {
      const chunkWords = new Set(chunk.toLowerCase().split(/\s+/));
      const overlap = [...correctWords].filter(w => chunkWords.has(w)).length;
      if (overlap < 2 && chunk !== correct) pool.push(chunk);
    }
  }

  return shuffle(pool).slice(0, count);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildSimpleExplanation(title, paragraphs, sentences) {
  const intro = paragraphs[0] || '';
  const introClean = intro.slice(0, 500);

  // Pick 2-3 more paragraphs that are informative
  const more = paragraphs.slice(1, 4).map(p => p.slice(0, 300));

  let html = `<p>Let's break down <strong>${title}</strong> in simple terms.</p>`;
  html += `<p>${introClean}</p>`;

  more.forEach(p => {
    html += `<p>${p}</p>`;
  });

  // Add a "why it matters" closing
  const importantSent = sentences.find(s =>
    /\b(important|significant|used|helps|enables|allows|plays a role)\b/i.test(s)
  );
  if (importantSent) {
    html += `<p><strong>Why it matters:</strong> ${importantSent}</p>`;
  }

  return html;
}

// ── Render ──────────────────────────────────────────────────────────

function renderResults(topic, data) {
  document.getElementById('resultTopic').textContent = topic;
  document.getElementById('notesContent').innerHTML = data.shortNotes;

  const kp = data.keyPoints;
  document.getElementById('keypointsContent').innerHTML =
    '<ul>' + kp.map(p => `<li>${p}</li>`).join('') + '</ul>';

  mcqData = data.mcqs;
  mcqAnswered = 0; mcqCorrect = 0;
  renderMCQ();

  document.getElementById('explainContent').innerHTML = data.simpleExplanation;

  hide('errorState');
  show('results');
  switchTab('overview', document.querySelector('[data-tab="overview"]'));
  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderMCQ() {
  const container = document.getElementById('mcqContent');
  const letters = ['A', 'B', 'C', 'D'];

  if (!mcqData.length) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:20px">Not enough structured content to generate MCQs for this topic.</p>';
    return;
  }

  container.innerHTML = mcqData.map((q, qi) => `
    <div class="mcq-item" id="mcq-${qi}">
      <div class="mcq-q">
        <span class="mcq-num">${qi + 1}</span>
        <span>${q.question}</span>
      </div>
      <div class="mcq-options">
        ${q.options.map((opt, oi) => `
          <button class="mcq-option" onclick="answerMCQ(${qi}, ${oi})" id="opt-${qi}-${oi}">
            <span class="opt-letter">${letters[oi] || oi + 1}</span>
            ${opt}
          </button>
        `).join('')}
      </div>
      <div class="mcq-explanation" id="exp-${qi}">
        <strong>Explanation:</strong> ${q.explanation || ''}
      </div>
    </div>
  `).join('');

  hide('mcqScore');
  hide('resetMcqBtn');
}

function answerMCQ(qi, selected) {
  const q = mcqData[qi];
  const opts = document.querySelectorAll(`#mcq-${qi} .mcq-option`);
  opts.forEach((btn, i) => {
    btn.classList.add('disabled');
    btn.onclick = null;
    if (i === q.answer) btn.classList.add('correct');
    else if (i === selected && selected !== q.answer) btn.classList.add('wrong');
  });
  document.getElementById(`exp-${qi}`).classList.add('show');
  mcqAnswered++;
  if (selected === q.answer) mcqCorrect++;
  const scoreEl = document.getElementById('mcqScore');
  document.getElementById('scoreText').textContent = `${mcqCorrect}/${mcqAnswered}`;
  scoreEl.classList.remove('hidden');
  if (mcqAnswered === mcqData.length) show('resetMcqBtn');
}

function resetMCQ() {
  mcqAnswered = 0; mcqCorrect = 0;
  renderMCQ();
}

function showError(msg) {
  hide('loadingState');
  document.getElementById('errorMsg').textContent = msg;
  show('errorState');
}

async function copyContent(id) {
  const el = document.getElementById(id);
  try {
    await navigator.clipboard.writeText(el.innerText || el.textContent);
    const toast = document.getElementById('toast');
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2200);
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('topicInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') generateStudyMaterial();
  });
});
