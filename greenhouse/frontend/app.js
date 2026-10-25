'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const state = { plots: [], selected: null, detail: null, selectionVersion: 0, listLoaded: false };
  const keyStorage = 'greenhouse.plot-keys.v1';
  let plotKeys = Object.create(null);
  try { const saved = JSON.parse(localStorage.getItem(keyStorage) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) Object.assign(plotKeys, saved); } catch {}
  const keyFor = id => String(id) === 'public' ? 'visitor' : plotKeys[String(id)];
  function saveKey(id, key) {
    plotKeys[String(id)] = key;
    try { localStorage.setItem(keyStorage, JSON.stringify(plotKeys)); return true; } catch { return false; }
  }
  const labels = { temperature: 'Температура', humidity: 'Влажность', oxygen: 'Кислород', biometrics: 'Биометрия', co2: 'Углекислый газ', light: 'Освещённость', ph: 'Кислотность' };
  const text = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const node = (tag, className, content) => { const el = document.createElement(tag); if (className) el.className = className; if (content != null) el.textContent = text(content); return el; };
  const idOf = plot => plot && typeof plot === 'object' ? plot.id ?? plot.plot_id : plot;
  const unwrap = (data, key) => data && typeof data === 'object' ? data[key] ?? data.data ?? data : data;
  function collection(data, keys) {
    if (Array.isArray(data)) return data;
    for (const key of [...keys, 'items', 'data']) {
      if (Array.isArray(data?.[key])) return data[key];
      if (data?.[key] && typeof data[key] === 'object') return collection(data[key], keys);
    }
    return data == null ? [] : [data];
  }
  async function api(path, payload, capability) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(capability ? { 'X-Greenhouse-Key': capability } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: controller.signal, cache: 'no-store' });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch { if (response.ok) throw new Error('Сервис вернул некорректный JSON.'); }
      if (!response.ok) throw new Error(`Ошибка ${response.status}: ${text(data?.error ?? data?.message ?? response.statusText).slice(0, 240)}`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Станция не ответила за 15 секунд. Повторите запрос.');
      if (error instanceof TypeError) throw new Error('Нет связи с API. Проверьте подключение к станции.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  let toastTimer;
  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
  function empty(target, message, error = false) { target.replaceChildren(node('p', error ? 'inline-error' : 'empty', message)); }
  function renderPlots() {
    const query = $('#plot-search').value.trim().toLocaleLowerCase('ru');
    const filtered = state.plots.filter(plot => `${text(plot.name)} ${text(plot.cultivar)} ${text(idOf(plot))}`.toLocaleLowerCase('ru').includes(query));
    const target = $('#plot-list'); target.replaceChildren();
    if (!filtered.length) return empty(target, query ? 'Участки не найдены. Попробуйте другой запрос.' : 'Здесь пока нет участков. Создайте первый, чтобы начать наблюдения.');
    for (const plot of filtered) {
      const id = idOf(plot);
      const button = node('button', 'plot-card'); button.type = 'button'; button.setAttribute('aria-pressed', String(String(id) === String(state.selected))); button.setAttribute('aria-controls', 'plot-detail');
      const icon = node('span', 'plant-icon', '•'); icon.setAttribute('aria-hidden', 'true');
      const copy = node('span', 'plot-card-copy'); copy.append(node('strong', '', plot.name ?? `Участок ${text(id)}`), node('small', '', plot.cultivar ?? 'Культура не указана'));
      button.append(icon, copy, node('span', 'arrow', '↗'));
      if (id == null) { button.disabled = true; button.title = 'API не передал идентификатор участка'; }
      else button.addEventListener('click', () => selectPlot(id));
      target.append(button);
    }
  }
  function renderDetail(plot) {
    const target = $('#plot-detail'); target.replaceChildren();
    const top = node('div', 'detail-top'); top.append(node('span', 'eyebrow', 'Паспорт'), node('span', 'pill', `ID / ${text(idOf(plot) ?? state.selected)}`));
    target.append(top, node('h3', '', plot.name ?? 'Участок'));
    const dl = node('dl');
    for (const [label, value] of [['Культура', plot.cultivar], ['Заметка', plot.note ?? 'Заметок пока нет.']]) dl.append(node('dt', '', label), node('dd', '', value));
    target.append(dl);
  }
  function timestamp(value) { if (value == null) return ''; const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }); }
  function renderRecords(target, data, archive) {
    if (archive && typeof data?.archive === 'string') {
      target.replaceChildren();
      if (data.archive) target.append(node('pre', 'raw-data', data.archive));
      else empty(target, 'Архив этого участка пока пуст.');
      return;
    }
    const rows = collection(data, archive ? ['archive', 'records', 'entries'] : ['telemetry', 'records', 'readings']);
    target.replaceChildren();
    if (!rows.length) return empty(target, archive ? 'Архив этого участка пока пуст.' : 'Показаний пока нет. Добавьте первое наблюдение.');
    for (const row of rows) {
      if (row == null || typeof row !== 'object' || (!('kind' in row) && !('value' in row) && !('message' in row) && !('note' in row))) { target.append(node('pre', 'raw-data', row)); continue; }
      const item = node('div', 'record'), copy = node('div');
      copy.append(node('strong', '', labels[row.kind] ?? row.kind ?? row.title ?? 'Наблюдение'));
      const date = timestamp(row.timestamp ?? row.created_at ?? row.created ?? row.time); if (date) copy.append(node('small', '', date));
      item.append(copy, node('span', 'record-value', row.value ?? row.message ?? row.note)); target.append(item);
    }
  }
  async function loadRecords(id, version, archive = false) {
    const target = $(archive ? '#archive-content' : '#telemetry-content');
    if (archive && !keyFor(id)) { target.removeAttribute('aria-busy'); empty(target, 'Для чтения архива нужен ключ доступа к этому участку. В этом браузере ключ не сохранён.'); return; }
    empty(target, 'Получаем данные станции…'); target.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`/${archive ? 'archive' : 'telemetry'}?plot=${encodeURIComponent(id)}`, undefined, archive ? keyFor(id) : undefined);
      if (version !== state.selectionVersion) return;
      renderRecords(target, data, archive);
    } catch (error) { if (version === state.selectionVersion) empty(target, `${error.message} Нажмите «Обновить», чтобы повторить.`, true); }
    finally { if (version === state.selectionVersion) target.removeAttribute('aria-busy'); }
  }
  async function selectPlot(id) {
    state.selected = id; state.detail = null;
    $('#selected-label').textContent = state.plots.find(plot => String(idOf(plot)) === String(id))?.name ?? `Участок ${id}`;
    $('#key-form').hidden = Boolean(keyFor(id));
    const version = ++state.selectionVersion;
    renderPlots(); $('#open-telemetry').disabled = false;
    empty($('#plot-detail'), 'Загружаем паспорт участка…'); $('#plot-detail').setAttribute('aria-busy', 'true');
    const detailRequest = (async () => {
      try {
        if (!keyFor(id)) {
          empty($('#plot-detail'), 'Нужен ключ доступа. Паспорт этого участка закрыт: создайте собственный участок или откройте его в браузере, где сохранён выданный ключ. Телеметрия доступна без ключа.');
          return;
        }
        const plot = unwrap(await api(`/plots/${encodeURIComponent(id)}`, undefined, keyFor(id)), 'plot');
        if (version !== state.selectionVersion) return;
        if (!plot || typeof plot !== 'object' || Array.isArray(plot)) throw new Error('Сервис не вернул паспорт участка.');
        state.detail = plot; renderDetail(plot); $('#open-telemetry').disabled = false;
      } catch (error) { if (version === state.selectionVersion) { empty($('#plot-detail'), `${error.message} Нажмите «Обновить», чтобы повторить.`, true); $('#key-form').hidden = String(id) === 'public'; } }
      finally { if (version === state.selectionVersion) $('#plot-detail').removeAttribute('aria-busy'); }
    })();
    await Promise.allSettled([detailRequest, loadRecords(id, version), loadRecords(id, version, true)]);
  }
  async function loadPlots() {
    const data = await api('/plots');
    state.plots = collection(data, ['plots']).map(plot => typeof plot === 'object' && plot !== null ? plot : { id: plot }); state.listLoaded = true;
    $('#plot-count').textContent = state.plots.length; $('#nav-count').textContent = String(state.plots.length).padStart(2, '0'); $('#metric-plots').textContent = state.plots.length;
    renderPlots();
  }
  async function loadStatus() {
    try {
      const data = await api('/status'); const status = data?.data ?? data;
      const statusText = typeof status === 'string' ? status : status?.status ?? status?.state ?? (status?.ok === true ? 'ok' : 'На связи');
      $('#metric-status').textContent = ({ nominal: 'В норме', ok: 'В норме', healthy: 'В норме', online: 'На связи', degraded: 'Внимание', error: 'Ошибка', offline: 'Не в сети' })[statusText] ?? text(statusText);
      $('#metric-oxygen').textContent = text(status?.oxygen ?? status?.o2 ?? status?.oxygen_regeneration);
      $('#metric-temperature').textContent = status?.temperature == null ? '—' : `${text(status.temperature)} °C`;
      $('#last-update').textContent = `Обновлено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) {
      $('#metric-status').textContent = 'Нет данных'; $('#metric-oxygen').textContent = '—'; $('#metric-temperature').textContent = '—';
      $('#last-update').textContent = 'Нет актуального ответа'; throw error;
    }
  }
  let refreshing = false;
  async function refresh() {
    if (refreshing) return; refreshing = true; $('#refresh').disabled = true; $('#global-error').hidden = true;
    const results = await Promise.allSettled([loadStatus(), loadPlots()]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) {
      $('#global-error').textContent = `${failures.map(result => result.reason.message).filter((v, i, a) => a.indexOf(v) === i).join(' ')} Нажмите «Обновить», чтобы повторить.${state.listLoaded && results[1].status === 'rejected' ? ' В реестре показаны ранее загруженные данные.' : ''}`; $('#global-error').hidden = false;
      if (!state.listLoaded) empty($('#plot-list'), 'Реестр недоступен. Повторите загрузку кнопкой «Обновить».', true);
    }
    if (state.selected != null) await selectPlot(state.selected);
    else if (state.plots.some(plot => String(idOf(plot)) === 'public')) await selectPlot('public');
    refreshing = false; $('#refresh').disabled = false;
  }
  function openDialog(selector) { const dialog = $(selector); dialog.querySelector('.form-error').textContent = ''; dialog.showModal(); }
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (dialog.dataset.busy === 'true') event.preventDefault(); }));
  $('#open-create').addEventListener('click', () => openDialog('#create-dialog'));
  $('#open-telemetry').addEventListener('click', () => { if (state.selected == null) return; $('#telemetry-plot-name').textContent = `Участок: ${text(state.detail?.name ?? state.selected)}`; $('#telemetry-form').dataset.plot = state.selected; openDialog('#telemetry-dialog'); });
  async function submit(event, operation) {
    event.preventDefault(); const form = event.currentTarget, dialog = form.closest('dialog');
    if (dialog.dataset.busy === 'true') return;
    const payload = Object.fromEntries(new FormData(form));
    for (const key of Object.keys(payload)) payload[key] = payload[key].trim();
    const errorTarget = form.querySelector('.form-error'); errorTarget.textContent = '';
    if (Object.entries(payload).some(([key, value]) => key !== 'note' && !value)) { errorTarget.textContent = 'Заполните обязательные поля.'; return; }
    dialog.dataset.busy = 'true'; form.setAttribute('aria-busy', 'true');
    const controls = [...form.querySelectorAll('button,input,textarea,select')]; controls.forEach(el => { el.disabled = true; });
    try { await operation(payload, form, dialog); }
    catch (error) { errorTarget.textContent = error.message; }
    finally { dialog.dataset.busy = 'false'; form.removeAttribute('aria-busy'); controls.forEach(el => { el.disabled = false; }); }
  }
  $('#create-form').addEventListener('submit', event => submit(event, async (payload, form, dialog) => {
    const data = await api('/plots', payload); const id = idOf(unwrap(data, 'plot'));

    const created = unwrap(data, 'plot');
    const key = created?.key ?? data?.key;
    const stored = id != null && typeof key === 'string' && key ? saveKey(id, key) : null;
    dialog.close(); form.reset(); toast('Участок создан. Ключ доступа сохранён.');
    if (stored === false) { $('#global-error').textContent = 'Участок создан. Браузер запретил localStorage: ключ доступен только до перезагрузки этой страницы.'; $('#global-error').hidden = false; }
    if (stored === null) { $('#global-error').textContent = 'Участок создан, но API не вернул ключ доступа. Паспорт и архив недоступны.'; $('#global-error').hidden = false; }
    try { await loadPlots(); } catch (error) { $('#global-error').textContent = `Участок создан, но реестр не обновлён. ${error.message}`; $('#global-error').hidden = false; }
    if (id != null) { $('#plot-search').value = ''; await selectPlot(id); showTerminal('plots', $('#terminal-launch')); }
    else { $('#global-error').textContent = 'Участок создан, но API не вернул его ID. Выберите его в реестре или обновите список.'; $('#global-error').hidden = false; }
  }));
  $('#telemetry-form').addEventListener('submit', event => submit(event, async (payload, form, dialog) => {
    const value = Number(payload.value); if (!Number.isFinite(value)) throw new Error('Введите конечное числовое значение.');
    const plot = state.plots.find(item => String(idOf(item)) === form.dataset.plot);
    const id = plot ? idOf(plot) : form.dataset.plot;
    await api('/telemetry', { plot: id, kind: payload.kind, value }); dialog.close(); form.reset(); toast('Показание сохранено.');
    if (String(state.selected) === String(id)) await Promise.allSettled([loadRecords(id, state.selectionVersion), loadRecords(id, state.selectionVersion, true)]);
  }));
  $('#plot-search').addEventListener('input', renderPlots); $('#refresh').addEventListener('click', refresh);
  let terminalTrigger = null;
  function showTerminal(panel, trigger) {
    const terminal = $('#terminal');
    if (trigger && !terminal.contains(trigger)) terminalTrigger = trigger;
    terminal.hidden = false; document.body.classList.add('terminal-open'); terminal.dispatchEvent(new Event('greenhouse:raise'));
    document.querySelectorAll('[data-panel]').forEach(section => { section.hidden = section.dataset.panel !== panel; });
    document.querySelectorAll('[data-terminal]').forEach(button => {
      const active = button.dataset.terminal === panel;
      if (button.closest('.terminal-tabs')) button.setAttribute('aria-pressed', String(active));
      else { button.setAttribute('aria-expanded', String(active)); button.setAttribute('aria-controls', 'terminal'); }
    });
    $('#terminal-title').textContent = { plots: 'Участки', telemetry: 'Телеметрия', archive: 'Архив наблюдений' }[panel];
    $('#terminal-title').focus({ preventScroll: true });
  }
  function hideTerminal() {
    $('#terminal').hidden = true; document.body.classList.remove('terminal-open');
    document.querySelectorAll('[data-terminal][aria-expanded]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    (terminalTrigger ?? $('#terminal-launch')).focus({ preventScroll: true });
  }
  document.querySelectorAll('[data-terminal]').forEach(button => {
    button.setAttribute('aria-controls', 'terminal');
    if (!button.closest('.terminal-tabs')) button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => showTerminal(button.dataset.terminal, button));
  });
  $('#terminal-close').addEventListener('click', hideTerminal);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !$('#terminal').hidden && !event.target.closest('#operator-console')) { event.preventDefault(); hideTerminal(); } });
  $('#key-form').addEventListener('submit', async event => {
    event.preventDefault(); const key = $('#access-key').value.trim(); if (!key || state.selected == null) return;
    const stored = saveKey(state.selected, key); $('#access-key').value = '';
    if (!stored) toast('Хранилище браузера недоступно: ключ сохранён только на время сеанса.');
    await selectPlot(state.selected);
  });
  setTimeout(() => {
    if (!$('#space').dataset.ready) { $('#scene-loading').hidden = true; $('#scene-fallback').hidden = false; }
  }, 20000);
  refresh();
})();
