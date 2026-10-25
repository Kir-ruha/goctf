(() => {
  let front = 30;
  const margin = 12;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  for (const [panelSelector, handleSelector] of [
    ['#terminal', '.terminal-header'],
    ['#operator-console', '.console-titlebar'],
  ]) {
    const panel = document.querySelector(panelSelector);
    const handle = panel.querySelector(handleSelector);
    let drag = null;

    function bringFront() { panel.style.zIndex = String(++front); }
    panel.addEventListener('greenhouse:raise', bringFront);
    function place(x, y, width, height) {
      panel.style.width = `${width}px`;
      panel.style.height = `${height}px`;
      panel.style.left = `${clamp(x, margin, Math.max(margin, innerWidth - width - margin))}px`;
      panel.style.top = `${clamp(y, margin, Math.max(margin, innerHeight - height - margin))}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    panel.addEventListener('pointerdown', bringFront);
    handle.addEventListener('pointerdown', event => {
      if (innerWidth <= 700 || event.button !== 0 || event.target.closest('button, input, a, select, textarea')) return;
      const rect = panel.getBoundingClientRect();
      bringFront();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      handle.setPointerCapture(event.pointerId);
      handle.focus({ preventScroll: true });
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y, drag.width, drag.height);
    });
    function stop(event) {
      if (drag && event.pointerId === drag.pointerId) drag = null;
    }
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('lostpointercapture', stop);
    handle.addEventListener('keydown', event => {
      if (!event.altKey || innerWidth <= 700) return;
      if (event.key === 'Home') {
        for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height']) panel.style[property] = '';
        bringFront(); event.preventDefault(); return;
      }
      const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!move) return;
      const rect = panel.getBoundingClientRect();
      const step = event.shiftKey ? 48 : 16;
      place(rect.left + move[0] * step, rect.top + move[1] * step, rect.width, rect.height);
      bringFront(); event.preventDefault();
    });
    addEventListener('resize', () => {
      if (!panel.style.left || innerWidth <= 700) {
        if (innerWidth <= 700) for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height']) panel.style[property] = '';
        return;
      }
      const rect = panel.getBoundingClientRect();
      place(rect.left, rect.top, rect.width, rect.height);
    });
  }
})();
