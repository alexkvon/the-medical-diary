/* ============================================================
 * МедЖурнал — вся интерактивная логика приложения.
 *
 *  - Хранилище: localStorage (id, date, sys, dia, pul, comment)
 *  - Камера: navigator.mediaDevices.getUserMedia — запуск строго
 *    по клику на кнопку сканирования
 *  - OCR: стоп-кадр со скрытого canvas → Tesseract.recognize
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

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

let cameraStream = null; // активный MediaStream камеры
let currentShot = null;  // dataURL последнего стоп-кадра
let toastTimer = null;

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
      <div class="empty-note mt-3">Здесь появится ваше последнее измерение.<br />Добавьте его вручную или отсканируйте тонометр.</div>`;
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
 * 9. Камера (запуск строго по кнопке сканирования)
 * ------------------------------------------------------------ */

async function openScanner() {
  const video = $('scannerVideo');
  $('cameraError').hidden = true;
  $('cameraHint').hidden = false;
  $('shotBtn').disabled = false;
  setModal($('cameraModal'), true);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError('Камера недоступна. Откройте приложение по HTTPS (например, на GitHub Pages) либо введите данные вручную.');
    return;
  }

  try {
    stopCamera();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' }, // задняя камера
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = cameraStream;
    try {
      await video.play(); // на iOS требует playsinline
    } catch {
      /* автозапуск может быть отклонён — не критично */
    }
  } catch (err) {
    console.warn('[МедЖурнал] Камера:', err);
    showCameraError(
      err && err.name === 'NotAllowedError'
        ? 'Доступ к камере запрещён. Разрешите его в настройках браузера и повторите.'
        : 'Не удалось запустить камеру. Введите данные вручную.'
    );
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  $('scannerVideo').srcObject = null;
}

function showCameraError(message) {
  $('cameraHint').hidden = true;
  $('cameraErrorText').textContent = message;
  $('cameraError').hidden = false;
  $('shotBtn').disabled = true;
}

function closeScanner() {
  stopCamera();
  setModal($('cameraModal'), false);
}

/* ------------------------------------------------------------
 * 10. OCR: стоп-кадр → Tesseract → разбор цифр
 * ------------------------------------------------------------ */

function captureShot() {
  const video = $('scannerVideo');
  if (!cameraStream || video.readyState < 2) return; // поток ещё не готов

  const canvas = $('captureCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  currentShot = canvas.toDataURL('image/jpeg', 0.9);

  stopCamera();
  setModal($('cameraModal'), false);
  openReview(currentShot);
}

function openReview(shotDataUrl) {
  $('shotPreview').src = shotDataUrl;
  $('reviewSys').value = '';
  $('reviewDia').value = '';
  $('reviewPul').value = '';
  $('reviewComment').value = '';
  $('ocrRawText').textContent = '—';
  $('ocrProgressBar').style.width = '0%';
  $('ocrProgress').hidden = false;
  $('reviewFields').hidden = true;
  setModal($('reviewModal'), true);
  void runOcr(shotDataUrl);
}

function closeReview() {
  currentShot = null; // «остывшие» результаты OCR игнорируются
  setModal($('reviewModal'), false);
}

function setOcrProgress(ratio) {
  $('ocrProgressBar').style.width = `${Math.round(ratio * 100)}%`;
}

async function runOcr(imageDataUrl) {
  if (typeof Tesseract === 'undefined') {
    finishOcrFailure('Модуль распознавания не загрузился. При первом запуске нужен интернет — введите данные вручную.');
    return;
  }
  try {
    $('ocrProgressText').textContent = 'Распознаю цифры…';
    const result = await Tesseract.recognize(imageDataUrl, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') setOcrProgress(m.progress);
      },
    });
    if (currentShot !== imageDataUrl) return; // окно закрыли / пересняли
    finishOcrSuccess(result.data.text || '');
  } catch (err) {
    console.warn('[МедЖурнал] OCR:', err);
    if (currentShot !== imageDataUrl) return;
    finishOcrFailure('Не удалось распознать снимок. Введите показания вручную.');
  }
}

function finishOcrSuccess(text) {
  const parsed = parseVitals(text);
  $('reviewSys').value = parsed.sys;
  $('reviewDia').value = parsed.dia;
  $('reviewPul').value = parsed.pul;
  $('ocrRawText').textContent = text.trim() || '—';
  $('ocrProgress').hidden = true;
  $('reviewFields').hidden = false;
  if (!parsed.sys || !parsed.dia) {
    showToast('Цифры не распознались — введите показания вручную', 'info');
  }
}

function finishOcrFailure(message) {
  $('ocrProgress').hidden = true;
  $('ocrRawText').textContent = '—';
  $('reviewFields').hidden = false; // поля остаются доступны для ручного ввода
  showToast(message, 'error');
}

/*
 * Разбор показаний из распознанного текста:
 *  1) пара «120/80» (разделитель / \ | : - – —);
 *  2) пульс рядом со словом PULSE / PUL / PR / BPM / HR;
 *  3) иначе — первые два правдоподобных числа как SYS/DIA,
 *     следующее подходящее — как пульс.
 */
function parseVitals(rawText) {
  const result = { sys: '', dia: '', pul: '' };
  if (!rawText) return result;
  const text = String(rawText).replace(/\u00A0/g, ' ');

  const pair = text.match(/(\d{2,3})\s*[/\\|:\u2010-\u2015-]\s*(\d{2,3})/);
  if (pair) {
    result.sys = pair[1];
    result.dia = pair[2];
  }

  const pulseWord = text.match(/(?:pulse?|pul|pr|bpm|hr)[^0-9]{0,10}(\d{2,3})/i);
  if (pulseWord) result.pul = pulseWord[1];

  // Диапазоны индексов, уже занятые найденными числами
  const used = [];
  if (pair) used.push([pair.index, pair.index + pair[0].length]);
  if (pulseWord) {
    const from = pulseWord.index + pulseWord[0].lastIndexOf(pulseWord[1]);
    used.push([from, from + pulseWord[1].length]);
  }

  // Остальные числа в порядке чтения
  const numbers = [];
  const re = /\d{2,3}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (used.some(([start, end]) => m.index >= start && m.index < end)) continue;
    numbers.push(m[0]);
  }

  if (!result.sys && !result.dia) {
    for (let i = 0; i + 1 < numbers.length; i++) {
      const s = Number(numbers[i]);
      const d = Number(numbers[i + 1]);
      if (s >= LIMITS.sys[0] && s <= LIMITS.sys[1] && d >= LIMITS.dia[0] && d <= LIMITS.dia[1] && s > d) {
        result.sys = numbers[i];
        result.dia = numbers[i + 1];
        numbers.splice(i, 2);
        break;
      }
    }
  }

  if (!result.pul) {
    const pul = numbers.map(Number).find((n) => n >= LIMITS.pul[0] && n <= LIMITS.pul[1]);
    if (pul !== undefined) result.pul = String(pul);
  }

  return result;
}

/* Сохранение проверенных показаний из окна проверки */
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

/* ------------------------------------------------------------
 * 11. Экспорт в CSV
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

  // BOM — чтобы Excel корректно открыл кириллицу; разделитель ';' для русской локали
  const csv = '\uFEFF' + lines.map((cols) => cols.map(csvCell).join(';')).join('\r\n');
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
 * 12. Привязка событий и запуск
 * ------------------------------------------------------------ */

function bindEvents() {
  // Ручной ввод
  $('manualForm').addEventListener('submit', onManualSubmit);

  // Сканирование
  $('scanBtn').addEventListener('click', openScanner);
  $('shotBtn').addEventListener('click', captureShot);
  $('cancelScanBtn').addEventListener('click', closeScanner);

  // Проверка распознанного
  $('retakeBtn').addEventListener('click', () => {
    closeReview();
    openScanner();
  });
  $('saveScanBtn').addEventListener('click', onSaveReview);
  $('reviewCancelBtn').addEventListener('click', closeReview);

  // Закрытие модалок: клик по фону и Esc
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (!event.target.classList.contains('modal-backdrop')) return;
      if (modal.id === 'cameraModal') closeScanner();
      else closeReview();
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if ($('reviewModal').classList.contains('open')) closeReview();
    else if ($('cameraModal').classList.contains('open')) closeScanner();
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

  // Освобождаем камеру, когда страница уходит в фон
  window.addEventListener('pagehide', stopCamera);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && $('cameraModal').classList.contains('open')) closeScanner();
  });
}

bindEvents();
renderAll();
