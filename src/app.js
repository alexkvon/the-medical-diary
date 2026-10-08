/* ============================================================
 * МедЖурнал — вся интерактивная логика приложения.
 *
 *  - Хранилище: localStorage (id, date, sys, dia, pul, comment)
 *  - Камера: navigator.mediaDevices.getUserMedia — запуск строго
 *    по клику на кнопку сканирования
 *  - OCR: стоп-кадр рамки-видоискателя -> бинаризация ->
 *    семисегментный распознаватель (основной, офлайн) ->
 *    Tesseract (резерв)
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

let cameraStream = null; // активный MediaStream камеры
let currentShot = null;  // dataURL последнего стоп-кадра
let toastTimer = null;
let ocrWorker = null;    // лениво создаваемый воркер Tesseract

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
        width: { ideal: 2560 },
        height: { ideal: 1440 },
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

/*
 * Область кадра, ограниченная рамкой-видоискателем, в координатах видео.
 * Видео растянуто на весь экран с обрезкой краёв (object-fit: cover),
 * поэтому экранные координаты рамки пересчитываются в пиксели потока.
 */
function getViewfinderCrop(video) {
  const screenW = video.clientWidth || window.innerWidth;
  const screenH = video.clientHeight || window.innerHeight;
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;
  if (!videoW || !videoH) return null;

  const scale = Math.max(screenW / videoW, screenH / videoH); // object-fit: cover
  const offX = (videoW * scale - screenW) / 2;
  const offY = (videoH * scale - screenH) / 2;

  // Геометрия рамки из styles.css: портретная 3:4 — ширина min(70vw, 460px),
  // высота 4/3 ширины (не выше 62vh), центр по горизонтали, по вертикали — на 42%
  const vfW = Math.min(screenW * 0.7, 460);
  const vfH = Math.min((vfW * 4) / 3, screenH * 0.62);
  const vfLeft = screenW / 2 - vfW / 2;
  const vfTop = screenH * 0.42 - vfH / 2;

  // Небольшой отступ внутрь — берём только то, что точно внутри рамки
  const inset = 0.05;
  const x = (vfLeft + offX + vfW * inset) / scale;
  const y = (vfTop + offY + vfH * inset) / scale;
  const cw = (vfW * (1 - inset * 2)) / scale;
  const ch = (vfH * (1 - inset * 2)) / scale;

  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    w: Math.min(videoW - Math.max(0, Math.floor(x)), Math.ceil(cw)),
    h: Math.min(videoH - Math.max(0, Math.floor(y)), Math.ceil(ch)),
  };
}

/*
 * Определяем прямоугольник дисплея по цвету: стекло LCD — крупная связная
 * область малонасыщенных средне-тёмных пикселей, а корпус прибора (синий
 * пластик, белые панели) отсекается по насыщенности и яркости.
 * Возвращает {x0, y0, x1, y1} в координатах кадра или null.
 */
function detectDisplayBox(px, w, h) {
  const s = 4; // анализ на уменьшенной сетке
  const aw = Math.max(1, Math.floor(w / s));
  const ah = Math.max(1, Math.floor(h / s));
  const mask = new Uint8Array(aw * ah);
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const p = ((y * s + (s >> 1)) * w + Math.min(w - 1, x * s + (s >> 1))) * 4;
      const r = px[p], g = px[p + 1], b = px[p + 2];
      const max = Math.max(r, g, b);
      // Стекло LCD тёплое (оливковое: r > b), синий корпус — холодный (b > r),
      // белые панели отсекаются по яркости
      mask[y * aw + x] = r > b * 1.12 && max >= 35 && max <= 220 ? 1 : 0;
    }
  }

  // Крупнейшая связная область (4-связность)
  const seen = new Uint8Array(aw * ah);
  let best = null;
  const stack = [];
  for (let i = 0; i < aw * ah; i++) {
    if (!mask[i] || seen[i]) continue;
    let area = 0, minX = aw, minY = ah, maxX = 0, maxY = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % aw, y = (p / aw) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < aw - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - aw] && !seen[p - aw]) { seen[p - aw] = 1; stack.push(p - aw); }
      if (y < ah - 1 && mask[p + aw] && !seen[p + aw]) { seen[p + aw] = 1; stack.push(p + aw); }
    }
    if (!best || area > best.area) best = { area, minX, minY, maxX, maxY };
  }

  // Область должна быть достаточно крупной, чтобы считаться дисплеем
  if (!best || best.area < aw * ah * 0.04) return null;
  return {
    x0: Math.max(0, best.minX * s - 2),
    y0: Math.max(0, best.minY * s - 2),
    x1: Math.min(w, (best.maxX + 1) * s + 2),
    y1: Math.min(h, (best.maxY + 1) * s + 2),
  };
}

/* ------------------------------------------------------------
 * 10. Подготовка кадра к распознаванию
 *     Область дисплея -> адаптивная бинаризация (Брэдли) -> полярность
 * ------------------------------------------------------------ */

function prepareOcrImage(source) {
  // Семисегментный путь работает в исходном разрешении кропа: апскейл
  // размывает штрихи сегментов, поэтому крупный кадр только уменьшаем
  const k = source.height > 1000 ? 1000 / source.height : 1;
  const w = Math.max(1, Math.round(source.width * k));
  const h = Math.max(1, Math.round(source.height * k));

  const canvas = $('ocrCanvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = k < 1;
  ctx.drawImage(source, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const n = w * h;

  // Серый + интегральное изображение для локальных средних
  const gray = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000 | 0;
  }
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }

  // Брэдли: пиксель чёрный, если заметно темнее локального среднего
  const r = Math.max(8, Math.round(Math.min(w, h) / 14));
  const t = 0.15;
  const bin = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = integral[(y1 + 1) * iw + (x1 + 1)] - integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] + integral[y0 * iw + x0];
      bin[y * w + x] = gray[y * w + x] < (s / area) * (1 - t) ? 1 : 0;
    }
  }

  // Цифры должны быть меньшинством; тёмный фон дисплея инвертируем
  let black = 0;
  for (let i = 0; i < n; i++) black += bin[i];
  if (black > n / 2) {
    for (let i = 0; i < n; i++) bin[i] ^= 1;
  }

  // Отсекаем корпус прибора: оставляем бинаризацию только в области дисплея,
  // иначе надписи корпуса («ВЕРХНЕЕ», «DIA.», «ПУЛЬС») ломают сегментацию строк
  const box = detectDisplayBox(px, w, h);
  if (box) {
    for (let y = 0; y < h; y++) {
      const rowOutside = y < box.y0 || y >= box.y1;
      for (let x = 0; x < w; x++) {
        if (rowOutside || x < box.x0 || x >= box.x1) bin[y * w + x] = 0;
      }
    }
  }

  // Ч/б версию пишем в canvas — её получит Tesseract в резервном пути
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = bin[i] ? 0 : 255;
    px[p] = px[p + 1] = px[p + 2] = v;
    px[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  return { bin, w, h, dataUrl: canvas.toDataURL('image/png') };
}

/* ------------------------------------------------------------
 * 11. Распознавание семисегментных цифр (основной путь).
 *     Чистые функции без обращения к DOM.
 * ------------------------------------------------------------ */

/* Эталонные маски: биты [a,b,c,d,e,f,g] — a-верх, b/c-право, d-низ, e/f-лево, g-центр */
const DIGIT_PATTERNS = {
  0b1111110: '0', 0b0110000: '1', 0b1101101: '2', 0b1111001: '3',
  0b0110011: '4', 0b1011011: '5', 0b1011111: '6', 0b1110000: '7',
  0b1111111: '8', 0b1111011: '9',
};

function findComponents(bin, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!bin[i] || labels[i] !== -1) continue;
    const id = comps.length;
    comps.push({ minX: w, minY: h, maxX: 0, maxY: 0, area: 0 });
    stack.push(i);
    labels[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      const c = comps[id];
      c.area++;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      const xs = x > 0, xr = x < w - 1, yu = y > 0, yd = y < h - 1;
      if (xs && bin[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack.push(p - 1); }
      if (xr && bin[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack.push(p + 1); }
      if (yu && bin[p - w] && labels[p - w] === -1) { labels[p - w] = id; stack.push(p - w); }
      if (yd && bin[p + w] && labels[p + w] === -1) { labels[p + w] = id; stack.push(p + w); }
      if (xs && yu && bin[p - 1 - w] && labels[p - 1 - w] === -1) { labels[p - 1 - w] = id; stack.push(p - 1 - w); }
      if (xr && yu && bin[p + 1 - w] && labels[p + 1 - w] === -1) { labels[p + 1 - w] = id; stack.push(p + 1 - w); }
      if (xs && yd && bin[p - 1 + w] && labels[p - 1 + w] === -1) { labels[p - 1 + w] = id; stack.push(p - 1 + w); }
      if (xr && yd && bin[p + 1 + w] && labels[p + 1 + w] === -1) { labels[p + 1 + w] = id; stack.push(p + 1 + w); }
    }
  }
  return comps;
}

/* Маска полезных пикселей: без рамки, крупных пятен и точечного шума */
function keepMask(bin, w, h) {
  const keep = new Uint8Array(w * h);
  for (const c of findComponents(bin, w, h)) {
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (c.area < 6 || bh > h * 0.45 || bw > w * 0.5) continue;
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let x = c.minX; x <= c.maxX; x++) {
        if (bin[y * w + x]) keep[y * w + x] = 1;
      }
    }
  }
  return keep;
}

/* Строки цифр по горизонтальной проекции */
function findBands(keep, w, h) {
  const bands = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    let n = 0;
    if (y < h) for (let x = 0; x < w; x++) n += keep[y * w + x];
    const on = n >= 2;
    if (on && start === -1) start = y;
    if (!on && start !== -1) { bands.push({ y0: start, y1: y - 1 }); start = -1; }
  }
  return bands.filter((b) => {
    const bh = b.y1 - b.y0 + 1;
    return bh >= h * 0.04 && bh <= h * 0.5;
  });
}

/* Подбор наклона: перебираем shear, максимизируем долю пустых колонок —
 * правильный наклон уплотняет цифры и разделяет их промежутками */
function bestSlope(pixels, bh, w) {
  const shift = Math.ceil(0.45 * bh) + 1;
  const uw = w + shift * 2;
  let bestK = 0, bestScore = -1, bestDetail = -1;
  for (let ki = -20; ki <= 20; ki++) {
    const k = ki * 0.02;
    const counts = new Int32Array(uw);
    let minC = uw, maxC = 0;
    for (let i = 0; i < pixels.length; i += 2) {
      const xs = pixels[i] + Math.round(k * pixels[i + 1]) + shift;
      if (xs < 0 || xs >= uw) continue;
      counts[xs]++;
      if (xs < minC) minC = xs;
      if (xs > maxC) maxC = xs;
    }
    let zeros = 0, sq = 0;
    for (let x = minC; x <= maxC; x++) {
      if (!counts[x]) zeros++;
      sq += counts[x] * counts[x];
    }
    const score = maxC >= minC ? zeros / (maxC - minC + 1) : 0;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && sq > bestDetail)) {
      bestScore = score; bestK = k; bestDetail = sq;
    }
  }
  return { k: bestK, shift, uw };
}

/* Доли чёрного в зонах семи сегментов (для выпрямленной цифры) */
const SEG_ZONES = {
  a: [0.25, 0.75, 0.04, 0.26],
  f: [0.02, 0.32, 0.18, 0.44],
  b: [0.68, 0.98, 0.18, 0.44],
  g: [0.25, 0.75, 0.42, 0.60],
  e: [0.02, 0.32, 0.58, 0.84],
  c: [0.68, 0.98, 0.58, 0.84],
  d: [0.25, 0.75, 0.74, 0.98],
};

function classifyGlyph(glyph, gw, gh) {
  const frac = (z) => {
    const zone = SEG_ZONES[z];
    let black = 0, total = 0;
    for (let y = Math.floor(zone[2] * gh); y < Math.ceil(zone[3] * gh); y++) {
      for (let x = Math.floor(zone[0] * gw); x < Math.ceil(zone[1] * gw); x++) {
        total++;
        if (glyph[y * gw + x]) black++;
      }
    }
    return total ? black / total : 0;
  };
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const f = {};
  for (const nm of names) f[nm] = frac(nm);

  // Узкий глиф со штрихами — единица (зоны сегментов для него бессмысленны)
  if (gw / gh < 0.4) {
    let black = 0;
    for (let i = 0; i < glyph.length; i++) black += glyph[i];
    if (black > 0.1 * gw * gh) return '1';
  }

  const code = names.reduce((acc, nm) => (acc << 1) | (f[nm] >= 0.35 ? 1 : 0), 0);
  if (DIGIT_PATTERNS[code]) return DIGIT_PATTERNS[code];

  // Расстояние Хэмминга <= 1 до ближайшего эталона
  let best = null, bestD = 8;
  for (const pattern in DIGIT_PATTERNS) {
    let d = 0, v = code ^ Number(pattern);
    while (v) { d += v & 1; v >>= 1; }
    if (d < bestD) { bestD = d; best = DIGIT_PATTERNS[pattern]; }
  }
  return bestD <= 1 ? best : '?';
}

/*
 * Главная функция распознавателя: бинаризованное изображение ->
 * текст вида "102\n86\n75" (строки через \n).
 * Строки по Y-проекции, наклон по перебору, цифры по X-проекции.
 * Надписи корпуса («ВЕРХНЕЕ», «DIA.», «ПУЛЬС») отсекаются по высоте:
 * настоящие цифры — самые высокие глифы в кадре.
 */
function recognizeSevenSeg(bin, w, h) {
  const keep = keepMask(bin, w, h);
  const bands = findBands(keep, w, h);

  // Активная область по горизонтали (после отсечения корпуса это дисплей)
  let actMinX = w, actMaxX = 0;
  for (let i = 0; i < w * h; i++) {
    if (bin[i]) {
      const x = i % w;
      if (x < actMinX) actMinX = x;
      if (x > actMaxX) actMaxX = x;
    }
  }
  const edgeZone = Math.max(6, (actMaxX - actMinX) * 0.04);

  // 1) Собираем боксы глифов по всем строкам, классификация — позже
  const bandBoxes = [];
  let maxGh = 0;
  for (const band of bands) {
    const bh = band.y1 - band.y0 + 1;

    const pixels = [];
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < w; x++) {
        if (keep[(band.y0 + y) * w + x]) pixels.push(x, y);
      }
    }

    const { k, shift, uw } = bestSlope(pixels, bh, w);

    // Выпрямленная строка
    const upright = new Uint8Array(uw * bh);
    for (let i = 0; i < pixels.length; i += 2) {
      const xs = pixels[i] + Math.round(k * pixels[i + 1]) + shift;
      upright[pixels[i + 1] * uw + xs] = 1;
    }

    // Глифы по X-проекции выпрямленной строки
    const boxes = [];
    let cs = -1;
    for (let x = 0; x <= uw; x++) {
      let n = 0;
      if (x < uw) for (let y = 0; y < bh; y++) n += upright[y * uw + x];
      const on = n >= 2;
      if (on && cs === -1) cs = x;
      if (!on && cs !== -1) {
        const bx0 = cs, bw = x - cs;
        cs = -1;
        if (bw < 5) continue;

        // Вырезаем глиф и обрезаем пустые строки сверху/снизу
        const grid = [];
        for (let y = 0; y < bh; y++) {
          const row = [];
          for (let gx = 0; gx < bw; gx++) row.push(upright[y * uw + bx0 + gx]);
          grid.push(row);
        }
        let ty = 0, by = bh - 1;
        const rowSum = (r) => grid[r].reduce((s, v) => s + v, 0);
        while (ty < by && rowSum(ty) === 0) ty++;
        while (by > ty && rowSum(by) === 0) by--;
        const gh = by - ty + 1;
        if (gh < bh * 0.4 || gh > bh * 1.3) continue;
        if (bw / gh > 1.2) continue;

        const glyph = [];
        for (let y = ty; y <= by; y++) for (let gx = 0; gx < bw; gx++) glyph.push(grid[y][gx]);

        boxes.push({ bx0, bw, glyph, gh });
        if (gh > maxGh) maxGh = gh;
      }
    }
    bandBoxes.push({ shift, boxes });
  }

  // 2) Классификация: отсекаем надписи корпуса (они заметно ниже цифр)
  const lines = [];
  for (const { shift, boxes } of bandBoxes) {
    let lineText = '';
    let prevMaxX = -999, prevW = 0;
    for (const b of boxes) {
      if (b.gh < maxGh * 0.5) continue;
      const ch = classifyGlyph(b.glyph, b.bw, b.gh);
      if (ch === '?') continue;
      // Рамка дисплея даёт узкие вертикальные обрывки у краёв — это не «единицы»
      const origCenter = b.bx0 + b.bw / 2 - shift;
      if (b.bw / b.gh < 0.4 &&
          (origCenter - actMinX < edgeZone || actMaxX - origCenter < edgeZone)) continue;
      if (lineText && b.bx0 - prevMaxX > 0.6 * prevW) lineText += ' ';
      lineText += ch;
      prevMaxX = b.bx0 + b.bw;
      prevW = b.bw;
    }
    if (lineText) lines.push(lineText);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------
 * 12. Разбор показаний из распознанного текста.
 *     Учитывает обе компоновки:
 *      - «120/80 78» в одну строку (разделитель / \ | : -);
 *      - столбик: SYS сверху, DIA ниже, пульс последним (большинство тонометров).
 * ------------------------------------------------------------ */

function parseVitals(rawText) {
  const result = { sys: '', dia: '', pul: '' };
  if (!rawText) return result;
  const text = String(rawText);

  const inRange = (v, range) => v >= range[0] && v <= range[1];

  // Все группы из 2-3 цифр в порядке чтения; пара «120/80» даёт две записи
  const groups = [];
  const groupRe = /\d{2,3}(?:\s*[/\\|:-]\s*\d{2,3})?/g;
  let m;
  while ((m = groupRe.exec(text)) !== null) {
    const parts = m[0].split(/[^0-9]/).filter(Boolean);
    for (const part of parts) {
      groups.push({ v: Number(part), from: m.index, to: m.index + m[0].length });
    }
  }

  const used = [];
  const isUsed = (g) => used.some(([a, b]) => g.from >= a && g.to <= b);

  // 1) Явная пара «SYS/DIA» с разделителем
  const pair = text.match(/(\d{2,3})\s*[/\\|:-]\s*(\d{2,3})/);
  if (pair) {
    const s = Number(pair[1]);
    const d = Number(pair[2]);
    if (inRange(s, LIMITS.sys) && inRange(d, LIMITS.dia) && s > d) {
      result.sys = String(s);
      result.dia = String(d);
      used.push([pair.index, pair.index + pair[0].length]);
    }
  }

  // 2) Пульс рядом со словом-меткой (если метки попали в кадр)
  const pulseWord = text.match(/(?:pulse?|pul|pr|bpm|hr)[^0-9]{0,10}(\d{2,3})/i);
  if (pulseWord) {
    result.pul = pulseWord[1];
    const from = pulseWord.index + pulseWord[0].lastIndexOf(pulseWord[1]);
    used.push([from, from + pulseWord[1].length]);
  }

  // 3) Вертикальная компоновка: сверху вниз — первая правдоподобная группа SYS,
  //    следующая меньшая DIA, затем пульс
  if (!result.sys) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (isUsed(g) || !inRange(g.v, LIMITS.sys)) continue;
      result.sys = String(g.v);
      for (let j = i + 1; j < groups.length; j++) {
        const d = groups[j];
        if (isUsed(d)) continue;
        if (!result.dia && inRange(d.v, LIMITS.dia) && d.v < g.v) {
          result.dia = String(d.v);
          continue;
        }
        if (result.dia && !result.pul && inRange(d.v, LIMITS.pul)) {
          result.pul = String(d.v);
          break;
        }
      }
      break;
    }
  }

  return result;
}

/* ------------------------------------------------------------
 * 13. OCR: снимок -> распознавание -> поля проверки
 * ------------------------------------------------------------ */

function captureShot() {
  const video = $('scannerVideo');
  if (!cameraStream || video.readyState < 2) return; // поток ещё не готов

  const canvas = $('captureCanvas');
  const crop = getViewfinderCrop(video);
  if (crop && crop.w > 80 && crop.h > 80) {
    canvas.width = crop.w;
    canvas.height = crop.h;
    canvas.getContext('2d').drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  } else {
    // Рамку не удалось сопоставить с потоком — берём весь кадр
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  }
  currentShot = canvas.toDataURL('image/jpeg', 0.92);

  const prepared = prepareOcrImage(canvas);
  prepared.info = video.videoWidth
    ? `Кадр ${video.videoWidth}×${video.videoHeight} → область ${canvas.width}×${canvas.height} → ч/б ${prepared.w}×${prepared.h}`
    : '';
  stopCamera();
  setModal($('cameraModal'), false);
  openReview(currentShot, prepared);
}

function openReview(shotDataUrl, prepared) {
  $('shotPreview').src = shotDataUrl;
  $('ocrDebugImage').src = prepared.dataUrl;
  $('ocrDebugInfo').textContent = prepared.info || '';
  $('reviewSys').value = '';
  $('reviewDia').value = '';
  $('reviewPul').value = '';
  $('reviewComment').value = '';
  $('ocrRawText').textContent = '—';
  $('ocrProgressBar').style.width = '0%';
  $('ocrProgress').hidden = false;
  $('reviewFields').hidden = true;
  setModal($('reviewModal'), true);
  void runOcr(shotDataUrl, prepared);
}

function closeReview() {
  currentShot = null; // «остывшие» результаты распознавания игнорируются
  setModal($('reviewModal'), false);
}

function setOcrProgress(ratio) {
  $('ocrProgressBar').style.width = `${Math.round(ratio * 100)}%`;
}

function parseScore(parsed) {
  return (parsed.sys ? 1 : 0) + (parsed.dia ? 1 : 0) + (parsed.pul ? 1 : 0);
}

/* Ленивый воркер Tesseract (резервный путь) */
async function getOcrWorker() {
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker('eng');
  return ocrWorker;
}

async function recognizeWithTesseract(imageDataUrl, shotDataUrl) {
  const worker = await getOcrWorker();
  let bestText = '', bestScore = -1;
  for (const psm of ['6', '11']) { // единый блок, затем разрозненный текст
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789/',
      tessedit_pageseg_mode: psm,
    });
    const { data } = await worker.recognize(imageDataUrl);
    if (currentShot !== shotDataUrl) return null; // окно закрыли / пересняли
    const text = data.text || '';
    const score = parseScore(parseVitals(text));
    if (score > bestScore) { bestScore = score; bestText = text; }
    if (bestScore >= 3) break;
  }
  return { text: bestText, score: bestScore };
}

function finishOcr(parsed, rawText, ok) {
  $('ocrProgress').hidden = true;
  $('ocrRawText').textContent = (rawText || '').trim() || '—';
  $('reviewSys').value = parsed.sys;
  $('reviewDia').value = parsed.dia;
  $('reviewPul').value = parsed.pul;
  $('reviewFields').hidden = false;
  if (!ok) showToast('Показания не распознались — введите вручную', 'error');
  else if (!parsed.pul) showToast('Распознались не все цифры — проверьте поля', 'info');
}

async function runOcr(shotDataUrl, prepared) {
  if (currentShot !== shotDataUrl) return;

  // 1) Быстрый путь: семисегментный распознаватель (мгновенно и офлайн)
  let text = '';
  let best = { sys: '', dia: '', pul: '' };
  let bestScore = -1;
  try {
    text = recognizeSevenSeg(prepared.bin, prepared.w, prepared.h);
    best = parseVitals(text);
    bestScore = parseScore(best);
  } catch (err) {
    console.warn('[МедЖурнал] Семисегментный распознаватель:', err);
  }

  // 2) Резерв: Tesseract по ч/б кадру (нужен интернет при первом запуске)
  if (bestScore < 2) {
    if (typeof Tesseract === 'undefined') {
      finishOcr(best, text, false);
      return;
    }
    try {
      $('ocrProgressText').textContent = 'Пробую резервное распознавание…';
      const result = await recognizeWithTesseract(prepared.dataUrl, shotDataUrl);
      if (!result) return;
      if (result.score > bestScore) {
        best = parseVitals(result.text);
        text = result.text;
        bestScore = result.score;
      }
    } catch (err) {
      console.warn('[МедЖурнал] OCR Tesseract:', err);
    }
    if (currentShot !== shotDataUrl) return;
  }

  finishOcr(best, text, bestScore >= 2);
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
 * 14. Экспорт в CSV
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
 * 15. Привязка событий и запуск
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
