/* ============================================================
 * МедЖурнал — вся интерактивная логика приложения.
 *
 *  - Хранилище: localStorage (id, date, sys, dia, pul, comment)
 *  - Голосовой ввод: Web Speech API (webkitSpeechRecognition /
 *    SpeechRecognition), ru-RU — показания диктуются, парсер
 *    извлекает числа и заполняет поля проверки
 *  - Экспорт: medical_diary.csv
 *  - Offline: регистрация ./sw.js
 * ============================================================ */

'use strict';

/* ------------------------------------------------------------
 * 1. Регистрация Service Worker (offline-first)
 * ------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js') // относительный путь — работает и в подпапке GitHub Pages
      .catch((err) => console.warn('[МедЖурнал] Service Worker не зарегистрирован:', err));
  });
}

/* ------------------------------------------------------------
 * 2. Константы и состояние
 * ------------------------------------------------------------ */

const STORAGE_KEY = 'medjournal.records';

// Допустимые диапазоны значений [мин, макс]
const LIMITS = {
  sys: [60, 260],
  dia: [30, 180],
  pul: [30, 250],
};

// BOM для CSV (Excel + кириллица); через fromCharCode, чтобы не держать
// невидимый символ в исходнике
const CSV_BOM = String.fromCharCode(0xfeff);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

let toastTimer = null;
let recognition = null;   // текущий инстанс SpeechRecognition
let voiceActive = false;  // слушаем прямо сейчас
let voiceGotResult = false; // пришли ли хоть какие-то данные

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ------------------------------------------------------------
 * 3. Утилиты
 * ------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function genId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* «8 октября, 14:05»; для прошлых лет добавляем год */
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dateOpts = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date().getFullYear()) dateOpts.year = 'numeric';
  return `${d.toLocaleDateString('ru-RU', dateOpts)}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}

/* «08.10.2026 14:05» — для CSV */
function formatCsvDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function csvCell(value) {
  const s = String(value);
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function showToast(message, type = 'info') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setModal(modal, open) {
  modal.classList.toggle('open', open);
  document.body.classList.toggle('no-scroll', Boolean(document.querySelector('.modal.open')));
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

/* ------------------------------------------------------------
 * 4. Хранилище (localStorage)
 * ------------------------------------------------------------ */

function loadRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.id && r.date) : [];
  } catch (err) {
    console.warn('[МедЖурнал] Не удалось прочитать хранилище:', err);
    return [];
  }
}

function persistRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function addRecord({ sys, dia, pul, comment }) {
  const records = loadRecords();
  records.push({
    id: genId(),
    date: new Date().toISOString(), // дата и время генерируются при сохранении
    sys,
    dia,
    pul: Number.isInteger(pul) ? pul : null,
    comment: (comment || '').trim(),
  });
  persistRecords(records);
}

function deleteRecord(id) {
  persistRecords(loadRecords().filter((r) => r.id !== id));
}

function sortedRecords(direction = 'desc') {
  const records = loadRecords();
  records.sort((a, b) =>
    direction === 'desc' ? new Date(b.date) - new Date(a.date) : new Date(a.date) - new Date(b.date)
  );
  return records;
}

/* ------------------------------------------------------------
 * 5. Категория давления
 * ------------------------------------------------------------ */

function classifyBP(sys, dia) {
  if (sys >= 160 || dia >= 100) return { label: 'Кризисное', cls: 'cat-crisis' };
  if (sys >= 140 || dia >= 90) return { label: 'Высокое', cls: 'cat-high' };
  if (sys >= 130 || dia >= 85) return { label: 'Повышенное', cls: 'cat-elevated' };
  if (sys >= 120 && dia < 80) return { label: 'Норма', cls: 'cat-normal' };
  return { label: 'Оптимальное', cls: 'cat-optimal' };
}

/* ------------------------------------------------------------
 * 6. Рендер интерфейса
 * ------------------------------------------------------------ */

function renderAll() {
  renderSummary();
  renderHistory();
  refreshIcons();
}

function renderSummary() {
  const box = $('summaryCard');
  const [last] = sortedRecords('desc');

  if (!last) {
    box.innerHTML = `
      <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">Последнее измерение</p>
      <div class="empty-note mt-3">Здесь появится ваше последнее измерение.<br />Добавьте его вручную или надиктуйте голосом.</div>`;
    return;
  }

  const cat = classifyBP(last.sys, last.dia);
  box.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">Последнее измерение</p>
        <p class="summary-pair mt-1">
          <span>${last.sys}</span><span class="summary-slash">/</span><span>${last.dia}</span>
          <span class="summary-unit">мм рт. ст.</span>
        </p>
      </div>
      <span class="badge ${cat.cls}">${cat.label}</span>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
      ${last.pul != null ? `<span class="inline-flex items-center gap-1.5"><i data-lucide="activity" class="h-4 w-4 text-rose-500"></i><span class="font-semibold text-slate-700">${last.pul}</span>&nbsp;уд/мин</span>` : ''}
      <span>${formatDate(last.date)}</span>
      ${last.comment ? `<p class="w-full text-slate-400">${escapeHtml(last.comment)}</p>` : ''}
    </div>`;
}

function renderHistory() {
  const records = sortedRecords('desc');
  $('historyEmpty').hidden = records.length > 0;
  $('recordsCount').textContent = String(records.length);

  $('historyList').innerHTML = records.map((r) => {
    const cat = classifyBP(r.sys, r.dia);
    return `
      <li class="card record">
        <span class="cat-dot ${cat.cls}" aria-hidden="true"></span>
        <div class="min-w-0 flex-1">
          <p class="record-main">
            <span class="font-bold">${r.sys}/${r.dia}</span><span class="text-xs text-slate-400">мм рт. ст.</span>
            ${r.pul != null ? `<span class="record-pulse"><i data-lucide="activity" class="h-3.5 w-3.5"></i>${r.pul}</span>` : ''}
          </p>
          <p class="text-xs text-slate-400">${formatDate(r.date)} · ${cat.label}</p>
          ${r.comment ? `<p class="record-comment" title="${escapeHtml(r.comment)}">${escapeHtml(r.comment)}</p>` : ''}
        </div>
        <button type="button" class="btn-icon-danger" data-delete-id="${r.id}" aria-label="Удалить запись">
          <i data-lucide="trash-2" class="h-5 w-5"></i>
        </button>
      </li>`;
  }).join('');
}

/* ------------------------------------------------------------
 * 7. Валидация
 * ------------------------------------------------------------ */

function validateVitals({ sys, dia, pul }) {
  if (!Number.isInteger(sys) || sys < LIMITS.sys[0] || sys > LIMITS.sys[1]) {
    return `SYS: введите число от ${LIMITS.sys[0]} до ${LIMITS.sys[1]}`;
  }
  if (!Number.isInteger(dia) || dia < LIMITS.dia[0] || dia > LIMITS.dia[1]) {
    return `DIA: введите число от ${LIMITS.dia[0]} до ${LIMITS.dia[1]}`;
  }
  if (pul !== null && (!Number.isInteger(pul) || pul < LIMITS.pul[0] || pul > LIMITS.pul[1])) {
    return `Пульс: введите число от ${LIMITS.pul[0]} до ${LIMITS.pul[1]} или оставьте поле пустым`;
  }
  if (sys <= dia) return 'SYS должно быть больше DIA';
  return null;
}

/* ------------------------------------------------------------
 * 8. Ручной ввод
 * ------------------------------------------------------------ */

function onManualSubmit(event) {
  event.preventDefault();
  const vitals = {
    sys: parseInt($('manualSys').value, 10),
    dia: parseInt($('manualDia').value, 10),
    pul: $('manualPul').value.trim() === '' ? null : parseInt($('manualPul').value, 10),
    comment: $('manualComment').value,
  };
  const error = validateVitals(vitals);
  if (error) {
    showToast(error, 'error');
    return;
  }
  addRecord(vitals);
  event.target.reset();
  renderAll();
  showToast('Измерение сохранено', 'success');
}

/* ------------------------------------------------------------
 * 9. Голосовой ввод (Web Speech API)
 * ------------------------------------------------------------ */

/* Слова-числительные, которые может вернуть распознаватель речи */
const RU_NUM_WORDS = {
  'ноль': 0, 'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3,
  'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9,
  'десять': 10, 'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13,
  'четырнадцать': 14, 'пятнадцать': 15, 'шестнадцать': 16,
  'семнадцать': 17, 'восемнадцать': 18, 'девятнадцать': 19,
  'двадцать': 20, 'тридцать': 30, 'сорок': 40, 'пятьдесят': 50,
  'шестьдесят': 60, 'семьдесят': 70, 'восемьдесят': 80, 'девяносто': 90,
  'сто': 100, 'двести': 200, 'триста': 300, 'четыреста': 400,
  'пятьсот': 500, 'шестьсот': 600, 'семьсот': 700, 'восемьсот': 800,
  'девятьсот': 900,
};

/*
 * Разбор произнесённой фразы: «Сто двадцать на восемьдесят, пульс семьдесят,
 * подъём по лестнице» -> { sys: '120', dia: '80', pul: '70', comment: '...' }.
 * Слова-числительные складываются в группы (сотни+десятки+единицы),
 * разделители групп — слова-не-числительные и цифры. Назначение: сначала
 * по ключевым словам (пульс / верхнее / нижнее), затем по порядку чтения
 * с проверкой диапазонов LIMITS. Текст после последнего числа — комментарий.
 */
function parseVoiceVitals(raw) {
  const result = { sys: '', dia: '', pul: '', comment: '' };
  if (!raw) return result;
  const rawTokens = String(raw).trim().split(/\s+/).filter(Boolean);
  if (!rawTokens.length) return result;

  // Нормализация отдельного токена: регистр, ё; разделители (дефисы, слэши,
  // запятые) превращаются в пробелы — «122-83-75» распадётся на три числа
  const norm = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/[-–—/\\,.:;!?+()]/g, ' ');

  const inRange = (v, range) => v >= range[0] && v <= range[1];

  // Собираем группы чисел; перед группой — последнее ключевое слово
  const groups = [];
  let keyword = '';
  let composed = null;   // { h, t, u } — сотни/десятки/единицы текущей группы
  let lastNumToken = -1; // индекс последнего токена, вошедшего в число

  const flush = () => {
    if (composed) {
      const v = composed.h + composed.t + composed.u;
      if (v > 0) groups.push({ value: v, keyword, endToken: lastNumToken });
      composed = null;
    }
  };

  for (let i = 0; i < rawTokens.length; i++) {
    // Один сырой токен может распасться на несколько («122-83-75» -> 122, 83, 75)
    const pieces = norm(rawTokens[i]).split(' ').filter(Boolean);
    for (const token of pieces) {
      if (/^\d{1,3}$/.test(token)) {
        flush();
        groups.push({ value: Number(token), keyword, endToken: i });
        lastNumToken = i;
        keyword = ''; // ключевое слово «израсходовано» этой группой
        continue;
      }
      const word = RU_NUM_WORDS[token];
      if (word !== undefined) {
        lastNumToken = i;
        if (!composed) composed = { h: 0, t: 0, u: 0 };
        if (word >= 100 && !composed.h) composed.h = word;
        else if (word >= 20 && word < 100 && !composed.t) composed.t = word;
        else if (word < 20 && !composed.u) composed.u = word;
        else { flush(); composed = { h: word >= 100 ? word : 0, t: word >= 20 && word < 100 ? word : 0, u: word < 20 ? word : 0 }; }
        continue;
      }
      // Слово-не-числительное завершает текущую группу
      flush();
      if (/^(пульс|пульса|пульсом|удар|удара|ударов|сердц)/.test(token)) keyword = 'pul';
      else if (/^(верхн|систол)/.test(token)) keyword = 'sys';
      else if (/^(нижн|диастол)/.test(token)) keyword = 'dia';
      else keyword = ''; // прочие слова сбрасывают ключевое слово
    }
  }
  flush();

  // 1) Группы с ключевыми словами
  const used = new Array(groups.length).fill(false);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g.keyword || used[i]) continue;
    if (g.keyword === 'sys' && !result.sys && inRange(g.value, LIMITS.sys)) {
      result.sys = String(g.value); used[i] = true;
    } else if (g.keyword === 'dia' && !result.dia && inRange(g.value, LIMITS.dia)) {
      result.dia = String(g.value); used[i] = true;
    } else if (g.keyword === 'pul' && !result.pul && inRange(g.value, LIMITS.pul)) {
      result.pul = String(g.value); used[i] = true;
    }
  }

  // 2) Фолбэк по порядку чтения: SYS, затем DIA < SYS, затем пульс
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (used[i]) continue;
    if (!result.sys && inRange(g.value, LIMITS.sys)) {
      result.sys = String(g.value); used[i] = true;
      continue;
    }
    if (result.sys && !result.dia && inRange(g.value, LIMITS.dia) && g.value < Number(result.sys)) {
      result.dia = String(g.value); used[i] = true;
      continue;
    }
    if (result.sys && result.dia && !result.pul && inRange(g.value, LIMITS.pul)) {
      result.pul = String(g.value); used[i] = true;
    }
  }

  // Комментарий: всё, что произнесено после последнего распознанного числа
  let lastEnd = -1;
  for (let i = 0; i < groups.length; i++) {
    if (used[i]) lastEnd = Math.max(lastEnd, groups[i].endToken);
  }
  const tail = rawTokens.slice(lastEnd + 1)
    .filter((t) => !/^(пульс|пульса|пульсом|давление|удар|удара|ударов)$/i.test(norm(t)));
  let comment = tail.join(' ').trim();
  if (comment) comment = comment.charAt(0).toUpperCase() + comment.slice(1);
  if (comment.length > 300) comment = comment.slice(0, 300);
  // Без распознанных показаний хвост фразы — не комментарий, а мусор
  if (!result.sys && !result.dia) comment = '';
  result.comment = comment;

  return result;
}

function openVoiceInput() {
  setModal($('voiceModal'), true);
  if (!SpeechRec) {
    showVoiceError('Голосовой ввод не поддерживается этим браузером. Введите показания вручную.');
    return;
  }
  startListening();
}

function startListening() {
  $('voiceError').hidden = true;
  $('voiceRetryBtn').hidden = true;
  $('micWrap').classList.remove('is-idle');
  $('voiceStatus').textContent = 'Слушаю… Произнесите показания (например: 120 на 80, пульс 70)';

  // Инстансы SpeechRecognition одноразовые — создаём на каждое прослушивание
  recognition = new SpeechRec();
  recognition.lang = 'ru-RU';
  recognition.interimResults = false;
  recognition.maxAlternatives = 3;
  voiceActive = true;
  voiceGotResult = false;

  recognition.onresult = (event) => {
    voiceGotResult = true;
    voiceActive = false;

    // Перебираем альтернативы распознавания: берём первую, где нашлись SYS и DIA
    let best = null, bestHeard = '';
    const alternatives = event.results[0] || [];
    for (let i = 0; i < alternatives.length; i++) {
      const heard = alternatives[i].transcript || '';
      const parsed = parseVoiceVitals(heard);
      const better = !best || ((parsed.sys && parsed.dia) && !(best.sys && best.dia));
      if (better) { best = parsed; bestHeard = heard; }
      if (best.sys && best.dia) break;
    }

    closeVoiceModal();
    openVoiceReview(best, bestHeard);
  };

  recognition.onerror = (event) => {
    voiceGotResult = true; // onend после ошибки не должен писать «не расслышал»
    const messages = {
      'not-allowed': 'Доступ к микрофону запрещён. Разрешите его в настройках браузера и попробуйте снова.',
      'service-not-allowed': 'Распознавание речи недоступно. Если приложение открыто с домашнего экрана, откройте его в Safari.',
      'no-speech': 'Речь не распознана. Говорите ближе к микрофону.',
      'audio-capture': 'Микрофон не найден на этом устройстве.',
      'network': 'Для распознавания речи нужен интернет.',
    };
    showVoiceError(messages[event.error] || 'Не удалось распознать речь. Попробуйте ещё раз.');
  };

  recognition.onend = () => {
    if (voiceActive && !voiceGotResult) {
      voiceActive = false;
      showVoiceError('Не расслышал ни одного слова. Нажмите «Слушать ещё раз» и произнесите показания.');
    }
  };

  try {
    recognition.start();
  } catch {
    /* попытка стартовать уже запущенный инстанс — не критично */
  }
}

function showVoiceError(message) {
  voiceActive = false;
  $('micWrap').classList.add('is-idle');
  $('voiceStatus').textContent = 'Голосовой ввод';
  $('voiceErrorText').textContent = message;
  $('voiceError').hidden = false;
  $('voiceRetryBtn').hidden = false;
}

function closeVoiceModal() {
  voiceActive = false;
  setModal($('voiceModal'), false);
}

function closeVoiceInput() {
  if (recognition) recognition.abort();
  closeVoiceModal();
}

/* Экран проверки: подставляем распознанные числа, пользователь правит и сохраняет */
function openVoiceReview(vitals, heardText) {
  const parsed = vitals || { sys: '', dia: '', pul: '', comment: '' };
  $('heardText').textContent = (heardText || '').trim() || '—';
  $('reviewSys').value = parsed.sys;
  $('reviewDia').value = parsed.dia;
  $('reviewPul').value = parsed.pul;
  $('reviewComment').value = parsed.comment || '';
  setModal($('reviewModal'), true);
  refreshIcons();
  if (!parsed.sys || !parsed.dia) {
    showToast('Не удалось распознать показания — введите их вручную', 'error');
  } else if (!parsed.pul) {
    showToast('Распознались не все цифры — проверьте поля', 'info');
  }
}

/* Сохранение проверенных показаний */
function onSaveReview() {
  const vitals = {
    sys: parseInt($('reviewSys').value, 10),
    dia: parseInt($('reviewDia').value, 10),
    pul: $('reviewPul').value.trim() === '' ? null : parseInt($('reviewPul').value, 10),
    comment: $('reviewComment').value,
  };
  const error = validateVitals(vitals);
  if (error) {
    showToast(error, 'error');
    return;
  }
  addRecord(vitals);
  closeReview();
  renderAll();
  showToast('Измерение сохранено', 'success');
}

function closeReview() {
  setModal($('reviewModal'), false);
}

/* ------------------------------------------------------------
 * 10. Экспорт в CSV
 * ------------------------------------------------------------ */

function exportCsv() {
  const records = sortedRecords('asc'); // в хронологическом порядке
  if (!records.length) {
    showToast('Нет данных для экспорта', 'info');
    return;
  }

  const lines = [['Дата', 'SYS', 'DIA', 'Пульс', 'Комментарий']].concat(
    records.map((r) => [
      formatCsvDate(r.date),
      String(r.sys),
      String(r.dia),
      r.pul != null ? String(r.pul) : '',
      r.comment || '',
    ])
  );

  const csv = CSV_BOM + lines.map((cols) => cols.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'medical_diary.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Экспортировано записей: ${records.length}`, 'success');
}

/* ------------------------------------------------------------
 * 11. Привязка событий и запуск
 * ------------------------------------------------------------ */

function bindEvents() {
  // Ручной ввод
  $('manualForm').addEventListener('submit', onManualSubmit);

  // Голосовой ввод
  $('voiceBtn').addEventListener('click', openVoiceInput);
  $('voiceCloseBtn').addEventListener('click', closeVoiceInput);
  $('voiceRetryBtn').addEventListener('click', startListening);

  // Проверка распознанного
  $('editBtn').addEventListener('click', closeReview);
  $('saveReviewBtn').addEventListener('click', onSaveReview);
  $('reviewCancelBtn').addEventListener('click', closeReview);

  // Закрытие модалок: клик по фону и Esc
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (!event.target.classList.contains('modal-backdrop')) return;
      if (modal.id === 'voiceModal') closeVoiceInput();
      else closeReview();
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if ($('reviewModal').classList.contains('open')) closeReview();
    else if ($('voiceModal').classList.contains('open')) closeVoiceInput();
  });

  // Удаление записей (делегирование)
  $('historyList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-delete-id]');
    if (!btn) return;
    if (!confirm('Удалить это измерение?')) return;
    deleteRecord(btn.getAttribute('data-delete-id'));
    renderAll();
    showToast('Запись удалена', 'success');
  });

  // Экспорт
  $('exportBtn').addEventListener('click', exportCsv);

  // Останавливаем распознавание, когда страница уходит в фон
  window.addEventListener('pagehide', closeVoiceInput);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && $('voiceModal').classList.contains('open')) closeVoiceInput();
  });
}

bindEvents();
renderAll();
