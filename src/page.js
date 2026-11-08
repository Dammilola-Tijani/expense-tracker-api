// Small demo page so visitors (and reviewers) can try the API in a browser.
// Everything is built with textContent / DOM APIs, never innerHTML, so API data can't inject markup.
// The token is kept in memory only: a refresh logs you out, and nothing sensitive is stored in the browser.
// NOTE: the script below avoids backticks and dollar-brace so it can live inside this template string.
export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expense Tracker API</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 780px; margin: 2.5rem auto; padding: 0 1rem; color: #1f1f1f; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .5rem; }
  p.sub, footer { color: #555; }
  footer { margin-top: 2rem; font-size: .9rem; }
  form, .row { display: flex; flex-wrap: wrap; gap: 8px; margin: .5rem 0; }
  input, select { padding: 9px; font-size: 1rem; border: 1px solid #bbb; border-radius: 6px; min-width: 0; }
  input { flex: 1 1 130px; }
  #amount { flex: 1 1 110px; }
  #desc { flex: 2 1 180px; }
  #cat { flex: 1 1 130px; }
  button { padding: 9px 14px; font-size: 1rem; border: 0; border-radius: 6px; background: #1f1f1f; color: #fff; cursor: pointer; }
  button.alt { background: #e6e6e6; color: #1f1f1f; }
  .msg { min-height: 1.4em; font-size: .95rem; color: #2a6b2a; }
  .msg.err { color: #8a1f1f; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid #e3e3e3; }
  li small { color: #666; display: block; }
  .total { font-size: 1.3rem; font-weight: 600; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<h1>Expense Tracker API</h1>
<p class="sub">A demo front end for the API. Create an account, add some expenses in naira (₦), and see the monthly summary. Data may be reset at any time, so don't use a real password.</p>

<section id="authBox">
  <div class="row">
    <input id="email" type="email" placeholder="you@example.com" autocomplete="email">
    <input id="password" type="password" placeholder="Password (8+ characters)" autocomplete="current-password">
  </div>
  <div class="row">
    <button id="loginBtn">Log in</button>
    <button id="registerBtn" class="alt">Create account</button>
  </div>
  <div id="authMsg" class="msg" role="status"></div>
</section>

<section id="appBox" hidden>
  <div class="row"><span id="who" style="flex:1"></span><button id="logoutBtn" class="alt">Log out</button></div>

  <h2>Add an expense</h2>
  <form id="expForm">
    <input id="amount" placeholder="Amount (₦)" inputmode="decimal" required>
    <input id="date" type="date" required>
    <input id="desc" placeholder="Description (optional)" maxlength="200">
    <select id="cat"><option value="">No category</option></select>
    <button>Add</button>
  </form>
  <form id="catForm">
    <input id="catName" placeholder="New category" maxlength="50" required>
    <button class="alt">Add category</button>
  </form>
  <div id="expMsg" class="msg" role="status"></div>

  <h2>Recent expenses</h2>
  <ul id="list"></ul>
  <div class="row"><button id="moreBtn" class="alt" hidden>Load more</button></div>

  <h2>Monthly summary</h2>
  <div class="row"><input id="month" type="month"></div>
  <div id="summary"></div>
</section>

<footer>
  <a href="/health">Health</a> ·
  <a href="https://github.com/Dammilola-Tijani/expense-tracker-api">Source and README</a>
</footer>

<script>
  var token = null, cursor = null;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, attrs) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n[k] = attrs[k]; });
    for (var i = 2; i < arguments.length; i++) n.append(arguments[i]);
    return n;
  }
  // Display only: the API sends exact decimal strings and the page just formats them as naira.
  var naira = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' });
  function money(s) { return naira.format(Number(s)); }
  function msg(id, text, isErr) { var n = $(id); n.textContent = text; n.className = isErr ? 'msg err' : 'msg'; }

  async function api(method, path, body) {
    var headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    var res = await fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    var text = await res.text();
    var data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error((data && data.error) || 'Request failed');
    return data;
  }

  async function auth(register) {
    var email = $('email').value.trim(), password = $('password').value;
    try {
      if (register) await api('POST', '/auth/register', { email: email, password: password });
      var r = await api('POST', '/auth/login', { email: email, password: password });
      token = r.token;
      $('who').textContent = 'Signed in as ' + email;
      $('authBox').hidden = true; $('appBox').hidden = false;
      $('password').value = ''; msg('authMsg', '');
      var now = new Date();
      var ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      $('date').value = ym + '-' + String(now.getDate()).padStart(2, '0');
      $('month').value = ym;
      await Promise.all([loadCategories(), loadExpenses(true), loadSummary()]);
    } catch (e) { msg('authMsg', e.message, true); }
  }
  $('loginBtn').onclick = function () { auth(false); };
  $('registerBtn').onclick = function () { auth(true); };
  $('logoutBtn').onclick = function () {
    token = null; $('appBox').hidden = true; $('authBox').hidden = false; $('list').replaceChildren();
  };

  async function loadCategories() {
    var cats = await api('GET', '/categories');
    var sel = $('cat'); sel.replaceChildren(el('option', { value: '', textContent: 'No category' }));
    cats.forEach(function (c) { sel.append(el('option', { value: String(c.id), textContent: c.name })); });
  }

  async function loadExpenses(reset) {
    if (reset) { cursor = null; $('list').replaceChildren(); }
    var r = await api('GET', '/expenses?limit=5' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    r.data.forEach(function (e) {
      $('list').append(el('li', {},
        el('span', {}, e.description || '(no description)',
          el('small', {}, e.date + (e.category ? ' · ' + e.category.name : ''))),
        el('strong', {}, money(e.amount))));
    });
    cursor = r.nextCursor; $('moreBtn').hidden = !cursor;
    if (reset && !r.data.length) $('list').append(el('li', {}, 'No expenses yet.'));
  }
  $('moreBtn').onclick = function () { loadExpenses(false).catch(function (e) { msg('expMsg', e.message, true); }); };

  async function loadSummary() {
    var s = await api('GET', '/reports/summary?month=' + encodeURIComponent($('month').value));
    var box = $('summary'); box.replaceChildren(el('div', { className: 'total' }, money(s.total)),
      el('div', { className: 'sub' }, s.count + ' expense(s)'));
    var ul = el('ul');
    s.byCategory.forEach(function (c) { ul.append(el('li', {}, el('span', {}, c.category), el('strong', {}, money(c.total)))); });
    box.append(ul);
  }
  $('month').onchange = function () { loadSummary().catch(function (e) { msg('expMsg', e.message, true); }); };

  $('expForm').onsubmit = async function (ev) {
    ev.preventDefault();
    var body = { amount: $('amount').value.trim(), date: $('date').value, description: $('desc').value };
    if ($('cat').value) body.categoryId = Number($('cat').value);
    try {
      await api('POST', '/expenses', body);
      msg('expMsg', 'Expense added.'); $('amount').value = ''; $('desc').value = '';
      await Promise.all([loadExpenses(true), loadSummary()]);
    } catch (e) { msg('expMsg', e.message, true); }
  };

  $('catForm').onsubmit = async function (ev) {
    ev.preventDefault();
    try {
      await api('POST', '/categories', { name: $('catName').value });
      $('catName').value = ''; msg('expMsg', 'Category added.'); await loadCategories();
    } catch (e) { msg('expMsg', e.message, true); }
  };
</script>
</body>
</html>`;
