const $ = selector => document.querySelector(selector);

if (!document.querySelector('link[href="/ui.css"]')) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/ui.css";
  document.head.append(stylesheet);
}

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = {"Content-Type": "application/json", ...(options.headers || {})};
  let response;
  let lastError;

  for (let attempt = 0; attempt < (method === "GET" ? 3 : 1); attempt += 1) {
    try {
      response = await fetch(path, {...options, method, headers, credentials: "same-origin"});
      if (![502, 503, 504].includes(response.status) || attempt === 2) break;
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw new ApiError("Сервис временно недоступен", 0);
    }
    await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
  }

  if (!response) throw new ApiError(lastError?.message || "Сервис временно недоступен", 0);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await response.json() : null;
  if (!response.ok) throw new ApiError(data?.error || `HTTP ${response.status}`, response.status);
  return data;
}

const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"}[character]));

async function user() {
  return api("/api/me");
}

async function optionalUser() {
  try {
    return await user();
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

function showAuthError(message) {
  let element = $("#auth-error");
  if (!element) {
    element = document.createElement("p");
    element.id = "auth-error";
    element.className = "notice";
    document.querySelector("main")?.prepend(element);
  }
  element.textContent = message;
}

async function guard(role) {
  let me;
  try {
    me = await user();
  } catch (error) {
    if (error.status === 401) {
      location.replace("/login/");
      return null;
    }
    showAuthError("Не удалось проверить сессию. Повторите попытку через несколько секунд.");
    return null;
  }
  if (role && me?.role !== role) {
    location.replace(me?.role === "seller" ? "/seller/" : "/account/");
    return null;
  }
  document.querySelectorAll("[data-user]").forEach(element => {
    element.textContent = `${me.username} · ${me.balance} cr`;
  });
  return me;
}

async function logout() {
  await api("/api/logout", {method: "POST", body: "{}"});
  location.href = "/";
}

document.querySelectorAll("[data-logout]").forEach(element => element.onclick = event => {
  event.preventDefault();
  logout().catch(error => showAuthError(error.message));
});


async function renderNav() {
  if (document.body.dataset.nav === "static") return;
  const nav = document.querySelector("header nav");
  if (!nav) return;
  let me = null;
  try {
    me = await optionalUser();
  } catch {
    me = null;
  }
  const role = me?.role || null;
  const links = [];
  const add = (href, label, extra = "") => links.push(`<a ${extra}href="${href}">${label}</a>`);
  add("/marketplace/", "Маркетплейс");
  if (role === "buyer") {
    add("/cart/", "Корзина");
    add("/orders/", "Заказы");
    add("/account/", "Кабинет");
  } else if (role === "seller") {
    add("/seller/", "Панель станции");
    add("/contract/", "Договор");
  } else {
    add("/account/", "Кабинет");
    add("/login/", "Войти");
    add("/registr/", "Регистрация", "class=\"button\" ");
  }
  if (role) add("/login/", "Выйти", "data-logout ");
  nav.innerHTML = links.join("");
  nav.querySelectorAll("[data-logout]").forEach(element => element.onclick = event => {
    event.preventDefault();
    logout().catch(error => showAuthError(error.message));
  });
}
renderNav();

function ensureUiLayer() {
  if ($("#ui-layer")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div id="ui-layer">
      <div id="toast-stack" class="toast-stack" aria-live="polite"></div>
      <div id="confirm-backdrop" class="dialog-backdrop" hidden>
        <section class="custom-dialog" role="dialog" aria-modal="true">
          <p class="eyebrow">ПОДТВЕРЖДЕНИЕ</p>
          <h2 id="confirm-title">Подтвердите действие</h2>
          <p id="confirm-message" class="muted"></p>
          <div class="dialog-actions"><button id="confirm-cancel" class="ghost-button">Отмена</button><button id="confirm-ok">Продолжить</button></div>
        </section>
      </div>
    </div>`);
}

function notify(message, type = "info") {
  ensureUiLayer();
  const toast = document.createElement("div");
  toast.className = `custom-toast ${type}`;
  toast.innerHTML = `<span>${type === "error" ? "!" : "✓"}</span><div><b>${type === "error" ? "Ошибка" : "Готово"}</b><p>${esc(message)}</p></div>`;
  $("#toast-stack").append(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function confirmAction(message, title = "Подтвердите действие") {
  ensureUiLayer();
  return new Promise(resolve => {
    const backdrop = $("#confirm-backdrop");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    backdrop.hidden = false;
    const finish = result => {
      backdrop.hidden = true;
      resolve(result);
    };
    $("#confirm-ok").onclick = () => finish(true);
    $("#confirm-cancel").onclick = () => finish(false);
    backdrop.onclick = event => {
      if (event.target === backdrop) finish(false);
    };
  });
}

ensureUiLayer();
