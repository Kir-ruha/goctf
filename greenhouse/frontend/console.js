'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const pane = $('#operator-console'), output = $('#console-output'), input = $('#console-input');
  let session = null, busy = false, unloading = false;
  const history = [];
  let historyIndex = 0, draft = '';
  const stringify = value => typeof value === 'string' ? value : JSON.stringify(value) ?? '';

  function lines(value, className = '') {
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 45;
    const values = Array.isArray(value) ? value : [value];
    const fragment = document.createDocumentFragment();
    for (const item of values) for (const line of stringify(item).slice(0, 131072).split(/\r?\n/).slice(0, 500)) {
      const row = document.createElement('div'); row.className = `console-line ${className}`;

      row.textContent = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 8192) || ' ';
      fragment.append(row);
    }
    output.append(fragment);
    while (output.childElementCount > 1000) output.firstElementChild.remove();
    if (nearBottom) output.scrollTop = output.scrollHeight;
  }
  function update(message) {
    $('#console-state').textContent = message ?? (session ? 'Подключено' : 'Нет сеанса');
    $('#console-indicator').classList.toggle('connected', session !== null);
    input.disabled = busy || session === null;
    $('#console-send').disabled = busy || session === null;
    $('#console-reconnect').disabled = busy;
    $('#console-disconnect').disabled = busy || session === null;
    $('#console-reconnect').textContent = session ? 'Переподключить' : 'Подключить';
    pane.setAttribute('aria-busy', String(busy));
  }
  function error(message) {
    $('#console-error').textContent = message; $('#console-error').hidden = !message;
  }
  async function request(action, payload) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/console/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), signal: controller.signal, cache: 'no-store' });
      let data; try { data = await response.json(); } catch { const problem = new Error(`Некорректный ответ консоли (HTTP ${response.status}).`); problem.status = response.status; throw problem; }
      if (!response.ok) {
        const problem = new Error(`HTTP ${response.status}: ${stringify(data?.error ?? data?.message ?? 'запрос отклонён').slice(0, 300)}`);
        problem.status = response.status; throw problem;
      }
      return data;
    } catch (problem) {
      if (problem.name === 'AbortError') throw new Error('Консоль не ответила за 15 секунд.');
      if (problem instanceof TypeError) throw new Error('Нет связи с консолью. Проверьте соединение.');
      throw problem;
    } finally { clearTimeout(timeout); }
  }
  async function closeSession() {
    if (session === null) return;
    try {
      const result = await request('close', { session });
      if (result?.ok !== true) throw new Error('Сервер не подтвердил закрытие сеанса.');
    } catch (problem) {
      if (![404, 410].includes(problem.status)) throw problem;

    }
    session = null; lines('Сеанс закрыт.', 'console-system');
  }
  async function connect() {
    if (busy || unloading) return;
    busy = true; error(''); update('Подключение…');
    try {
      await closeSession();
      const data = await request('open', {});
      if (data?.session == null || !['string', 'number'].includes(typeof data.session) || String(data.session) === '') throw new Error('Сервер не выдал идентификатор сеанса.');
      session = data.session;
      if (unloading) { release(); return; }
      lines('Соединение установлено.', 'console-system');
      if (data.banner != null) lines(data.banner);
    } catch (problem) { error(`${problem.message} Автоматического повтора не было.`); }
    finally { busy = false; update(); if (session !== null && !pane.hidden) input.focus(); }
  }
  async function disconnect() {
    if (busy || session === null) return;
    busy = true; error(''); update('Отключение…');
    try { await closeSession(); }
    catch (problem) { error(`${problem.message} Сеанс не подтверждён как закрытый; можно повторить отключение.`); }
    finally { busy = false; update(); }
  }
  function show() {
    document.body.classList.add('console-open');
    pane.hidden = false; pane.dispatchEvent(new Event('greenhouse:raise')); $('#console-launch').setAttribute('aria-expanded', 'true');
    if (session !== null && !busy) input.focus(); else $('#console-title').focus();
    if (session === null && !busy) connect();
  }
  function hide() { document.body.classList.remove('console-open'); pane.hidden = true; $('#console-launch').setAttribute('aria-expanded', 'false'); $('#console-launch').focus(); }
  $('#console-launch').addEventListener('click', () => pane.hidden ? show() : hide());
  $('#console-hide').addEventListener('click', hide);
  $('#console-reconnect').addEventListener('click', connect);
  $('#console-disconnect').addEventListener('click', disconnect);
  $('#console-clear').addEventListener('click', () => { output.replaceChildren(); if (!input.disabled) input.focus(); });
  $('#console-form').addEventListener('submit', async event => {
    event.preventDefault(); const command = input.value;
    if (busy || session === null || !command.trim()) return;
    if (command.length > 1024) { error('Команда не должна превышать 1024 символа.'); return; }
    const currentSession = session;
    busy = true; error(''); update('Выполнение…'); lines(`> ${command}`, 'console-command');
    if (history.at(-1) !== command) { history.push(command); if (history.length > 100) history.shift(); }
    historyIndex = history.length; draft = ''; input.value = '';
    try {
      const result = await request('command', { session: currentSession, command });
      if (!result || !Object.hasOwn(result, 'reply')) throw new Error('Сервер не передал ответ команды.');
      lines(result.reply);
    } catch (problem) {
      if ([401, 403, 404, 410].includes(problem.status)) { session = null; error(`${problem.message} Сеанс недоступен. Нажмите «Подключить».`); }
      else error(`${problem.message} Результат команды не подтверждён. Повторите её вручную только при необходимости.`);
      lines('Ответ не получен.', 'console-system');
    } finally { busy = false; update(); if (session !== null && !pane.hidden) input.focus(); }
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex === history.length) draft = input.value;
      historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
      input.value = historyIndex === history.length ? draft : history[historyIndex];
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); output.replaceChildren(); }
  });
  pane.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } });
  function release() {
    if (session === null) return;
    const closing = session; session = null;

    fetch('/api/console/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: closing }), keepalive: true }).catch(() => {});
  }
  addEventListener('pagehide', () => { unloading = true; release(); });
  addEventListener('pageshow', event => { if (event.persisted) { unloading = false; busy = false; update(); } });
  update();
})();
