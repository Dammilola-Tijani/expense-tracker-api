import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { parseAmountToCents, formatCents, isValidDate } from '../src/money.js';

const SECRET = 'test-secret-at-least-16-chars';
let server, base;

const HIGH = { max: 100_000, windowMs: 60_000 }; // the shared test app makes many auth calls from one IP

before(() => {
  server = createApp(openDb(':memory:'), { jwtSecret: SECRET, authLimit: HIGH, loginEmailLimit: HIGH }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let counter = 0;
async function newUser() {
  const email = `user${++counter}@example.com`;
  await call('POST', '/auth/register', { body: { email, password: 'correct-horse' } });
  const { body } = await call('POST', '/auth/login', { body: { email, password: 'correct-horse' } });
  return body.token;
}

// ---- money helpers ----------------------------------------------------------
test('money: parses decimals exactly, rejects ambiguous input', () => {
  assert.equal(parseAmountToCents('12.50'), 1250);
  assert.equal(parseAmountToCents('12.5'), 1250);
  assert.equal(parseAmountToCents(12), 1200);
  assert.equal(parseAmountToCents('0.10'), 10);
  assert.equal(parseAmountToCents(19.99), 1999); // float-unsafe in naive *100 code (1998.9999...)
  for (const bad of ['0', '-5', '1.234', 'abc', '', null, undefined, '1e3', 0.30000000000000004]) {
    assert.equal(parseAmountToCents(bad), null, `should reject ${String(bad)}`);
  }
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatCents(123456), '1234.56');
});

test('money: date validation rejects impossible dates', () => {
  assert.ok(isValidDate('2024-02-29'));
  assert.ok(!isValidDate('2023-02-29'));
  assert.ok(!isValidDate('2024-13-01'));
  assert.ok(!isValidDate('2024-1-1'));
});

// ---- auth -------------------------------------------------------------------
test('register + login flow; duplicate and bad input handled', async () => {
  const body = { email: 'Alice@Example.com', password: 'longenough1' };
  assert.equal((await call('POST', '/auth/register', { body })).status, 201);
  assert.equal((await call('POST', '/auth/register', { body: { ...body, email: 'alice@example.com' } })).status, 409);
  assert.equal((await call('POST', '/auth/register', { body: { email: 'nope', password: 'longenough1' } })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: { email: 'b@example.com', password: 'short' } })).status, 400);

  const ok = await call('POST', '/auth/login', { body });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  const wrongPw = await call('POST', '/auth/login', { body: { ...body, password: 'wrong-password' } });
  const noUser = await call('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'whatever123' } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.deepEqual(wrongPw.body, noUser.body); // no user enumeration
});

test('protected routes reject missing, garbage, expired, and wrong-secret tokens', async () => {
  assert.equal((await call('GET', '/expenses')).status, 401);
  assert.equal((await call('GET', '/expenses', { token: 'garbage' })).status, 401);
  const expired = jwt.sign({ sub: '1' }, SECRET, { expiresIn: -10 });
  assert.equal((await call('GET', '/expenses', { token: expired })).status, 401);
  const forged = jwt.sign({ sub: '1' }, 'some-other-secret-value');
  assert.equal((await call('GET', '/expenses', { token: forged })).status, 401);
});

// ---- expenses ---------------------------------------------------------------
test('create, read, update, delete an expense', async () => {
  const token = await newUser();
  const cat = (await call('POST', '/categories', { token, body: { name: 'Food' } })).body;

  const created = await call('POST', '/expenses', {
    token, body: { amount: '12.5', date: '2024-03-10', description: 'Lunch', categoryId: cat.id },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, {
    id: created.body.id, amount: '12.50', description: 'Lunch', date: '2024-03-10',
    category: { id: cat.id, name: 'Food' },
  });

  const patched = await call('PATCH', `/expenses/${created.body.id}`, { token, body: { amount: '20' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.amount, '20.00');
  assert.equal(patched.body.description, 'Lunch'); // untouched fields preserved

  assert.equal((await call('GET', `/expenses/${created.body.id}`, { token })).body.amount, '20.00');
  assert.equal((await call('DELETE', `/expenses/${created.body.id}`, { token })).status, 204);
  assert.equal((await call('GET', `/expenses/${created.body.id}`, { token })).status, 404);
});

test('validation: bad amount, date, and missing fields give 400', async () => {
  const token = await newUser();
  const bad = [
    { amount: '-1', date: '2024-01-01' },
    { amount: '1.999', date: '2024-01-01' },
    { amount: '5', date: '2024-02-31' },
    { amount: '5' },
    { date: '2024-01-01' },
  ];
  for (const body of bad) assert.equal((await call('POST', '/expenses', { token, body })).status, 400, JSON.stringify(body));
});

test("users cannot see, edit, or delete each other's expenses", async () => {
  const alice = await newUser();
  const bob = await newUser();
  const { body: exp } = await call('POST', '/expenses', { token: alice, body: { amount: '9.99', date: '2024-05-01' } });

  assert.equal((await call('GET', `/expenses/${exp.id}`, { token: bob })).status, 404);
  assert.equal((await call('PATCH', `/expenses/${exp.id}`, { token: bob, body: { amount: '1' } })).status, 404);
  assert.equal((await call('DELETE', `/expenses/${exp.id}`, { token: bob })).status, 404);
  assert.equal((await call('GET', '/expenses', { token: bob })).body.data.length, 0);
  assert.equal((await call('GET', `/expenses/${exp.id}`, { token: alice })).body.amount, '9.99'); // untouched
});

test("users cannot attach another user's category", async () => {
  const alice = await newUser();
  const bob = await newUser();
  const { body: cat } = await call('POST', '/categories', { token: alice, body: { name: 'Private' } });
  const res = await call('POST', '/expenses', { token: bob, body: { amount: '5', date: '2024-01-01', categoryId: cat.id } });
  assert.equal(res.status, 400);
});

test('duplicate category names conflict per user, but not across users', async () => {
  const alice = await newUser();
  const bob = await newUser();
  assert.equal((await call('POST', '/categories', { token: alice, body: { name: 'Rent' } })).status, 201);
  assert.equal((await call('POST', '/categories', { token: alice, body: { name: 'Rent' } })).status, 409);
  assert.equal((await call('POST', '/categories', { token: bob, body: { name: 'Rent' } })).status, 201);
});

test('keyset pagination walks all rows once, newest first, with no gaps or repeats', async () => {
  const token = await newUser();
  // 7 rows, several sharing a date so the id tiebreaker matters.
  const dates = ['2024-01-05', '2024-01-05', '2024-01-05', '2024-01-04', '2024-01-04', '2024-01-03', '2024-01-01'];
  const ids = [];
  for (const date of dates) ids.push((await call('POST', '/expenses', { token, body: { amount: '1', date } })).body.id);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const qs = `limit=3${cursor ? `&cursor=${cursor}` : ''}`;
    const { status, body } = await call('GET', `/expenses?${qs}`, { token });
    assert.equal(status, 200);
    seen.push(...body.data.map((e) => e.id));
    cursor = body.nextCursor;
    pages++;
  } while (cursor);

  assert.equal(pages, 3);
  // Newest date first; within the same date, highest id first.
  assert.deepEqual(seen, [3, 2, 1, 5, 4, 6, 7].map((n) => ids[n - 1]));
  assert.equal(new Set(seen).size, 7);
});

test('list filters by date range and category; rejects bad params', async () => {
  const token = await newUser();
  const { body: cat } = await call('POST', '/categories', { token, body: { name: 'Travel' } });
  await call('POST', '/expenses', { token, body: { amount: '10', date: '2024-02-01', categoryId: cat.id } });
  await call('POST', '/expenses', { token, body: { amount: '20', date: '2024-02-15' } });
  await call('POST', '/expenses', { token, body: { amount: '30', date: '2024-03-01', categoryId: cat.id } });

  assert.equal((await call('GET', '/expenses?from=2024-02-10&to=2024-02-28', { token })).body.data.length, 1);
  assert.equal((await call('GET', `/expenses?categoryId=${cat.id}`, { token })).body.data.length, 2);
  for (const qs of ['limit=0', 'limit=101', 'limit=abc', 'from=bad', 'cursor=!!!', 'categoryId=x']) {
    assert.equal((await call('GET', `/expenses?${qs}`, { token })).status, 400, qs);
  }
});

test('monthly summary totals are exact and grouped by category', async () => {
  const token = await newUser();
  const { body: food } = await call('POST', '/categories', { token, body: { name: 'Food' } });
  const add = (amount, date, categoryId) => call('POST', '/expenses', { token, body: { amount, date, categoryId } });
  await add('0.10', '2024-04-01', food.id);
  await add('0.20', '2024-04-02', food.id);
  await add('100.05', '2024-04-30');
  await add('999', '2024-05-01', food.id); // other month, excluded

  const { status, body } = await call('GET', '/reports/summary?month=2024-04', { token });
  assert.equal(status, 200);
  assert.equal(body.total, '100.35'); // 0.1 + 0.2 + 100.05 with no float drift
  assert.equal(body.count, 3);
  assert.deepEqual(body.byCategory, [
    { category: '(uncategorized)', total: '100.05', count: 1 },
    { category: 'Food', total: '0.30', count: 2 },
  ]);
  assert.equal((await call('GET', '/reports/summary?month=2024-13', { token })).status, 400);
});

// ---- throttling, proxy, landing page -----------------------------------------
async function withApp(options, fn) {
  const s = createApp(openDb(':memory:'), { jwtSecret: SECRET, ...options }).listen(0);
  const url = `http://127.0.0.1:${s.address().port}`;
  try { await fn(url); } finally { await new Promise((r) => s.close(r)); }
}
const postJson = (url, path, body, headers = {}) =>
  fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('auth endpoints are rate limited per client IP', async () => {
  await withApp({ authLimit: { max: 3, windowMs: 60_000 }, loginEmailLimit: HIGH }, async (url) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await postJson(url, '/auth/login', { email: `u${i}@example.com`, password: 'x' })).status);
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    const limited = await postJson(url, '/auth/login', { email: 'a@example.com', password: 'x' });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

test('login attempts are limited per account even from different IPs', async () => {
  await withApp({ authLimit: HIGH, loginEmailLimit: { max: 3, windowMs: 60_000 }, trustProxy: 1 }, async (url) => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      // Each attempt claims a different client IP; the account is still throttled.
      statuses.push((await postJson(url, '/auth/login', { email: 'Victim@Example.com', password: 'guess' }, { 'x-forwarded-for': `203.0.113.${i}` })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    // A different account is unaffected.
    assert.equal((await postJson(url, '/auth/login', { email: 'other@example.com', password: 'guess' }, { 'x-forwarded-for': '203.0.113.99' })).status, 401);
  });
});

test('root serves the demo page and the server does not advertise Express', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.match(await res.text(), /Expense Tracker API/);
});
