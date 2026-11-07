import express from 'express';
import { hashPassword, verifyPassword, signToken, requireAuth } from './auth.js';
import { parseAmountToCents, formatCents, isValidDate } from './money.js';
import { rateLimit } from './rateLimit.js';
import { landingPage } from './page.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isUniqueViolation = (err) => /UNIQUE constraint failed/.test(err?.message ?? '');

// Used so a login for an unknown email costs the same as one for a known email,
// otherwise response time would reveal which emails are registered.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

const toExpense = (r) => ({
  id: r.id,
  amount: formatCents(r.amount_cents),
  description: r.description,
  date: r.spent_on,
  category: r.category_id ? { id: r.category_id, name: r.category } : null,
});

const encodeCursor = (r) => Buffer.from(`${r.spent_on}|${r.id}`).toString('base64url');
function decodeCursor(c) {
  try {
    const [date, id] = Buffer.from(c, 'base64url').toString().split('|');
    return isValidDate(date) && /^\d+$/.test(id) ? { date, id: Number(id) } : null;
  } catch {
    return null;
  }
}

export function createApp(db, {
  jwtSecret,
  // Limits on /auth/*: per client IP, and (for login) per target account, so guessing one
  // account's password is throttled even when the attempts come from many IPs.
  authLimit = { max: 20, windowMs: 15 * 60_000 },
  loginEmailLimit = { max: 10, windowMs: 15 * 60_000 },
  // Number of reverse proxies in front of the app (0/false = none); see README "Deploying".
  trustProxy = false,
}) {
  if (!jwtSecret) throw new Error('jwtSecret is required');
  const auth = requireAuth(jwtSecret);

  const q = {
    insertUser: db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)'),
    userByEmail: db.prepare('SELECT id, password_hash FROM users WHERE email = ?'),
    insertCategory: db.prepare('INSERT INTO categories (user_id, name) VALUES (?, ?)'),
    categories: db.prepare('SELECT id, name FROM categories WHERE user_id = ? ORDER BY name'),
    categoryOwned: db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?'),
    insertExpense: db.prepare(
      'INSERT INTO expenses (user_id, category_id, amount_cents, description, spent_on) VALUES (?, ?, ?, ?, ?)'),
    expenseById: db.prepare(`
      SELECT e.id, e.amount_cents, e.description, e.spent_on, e.category_id, c.name AS category
      FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
      WHERE e.id = ? AND e.user_id = ?`),
    updateExpense: db.prepare(
      'UPDATE expenses SET category_id = ?, amount_cents = ?, description = ?, spent_on = ? WHERE id = ? AND user_id = ?'),
    deleteExpense: db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?'),
    summaryTotal: db.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM expenses WHERE user_id = ? AND spent_on BETWEEN ? AND ?'),
    summaryByCategory: db.prepare(`
      SELECT COALESCE(c.name, '(uncategorized)') AS category, SUM(e.amount_cents) AS total, COUNT(*) AS n
      FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
      WHERE e.user_id = ? AND e.spent_on BETWEEN ? AND ?
      GROUP BY e.category_id ORDER BY total DESC, category`),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/', (_req, res) => res.type('html').send(landingPage));

  // ---- Auth -----------------------------------------------------------------
  const authIpLimiter = rateLimit(authLimit);
  const loginEmailLimiter = rateLimit({
    ...loginEmailLimit,
    key: (req) => `login:${String(req.body?.email ?? '').toLowerCase().slice(0, 254)}`,
  });

  app.post('/auth/register', authIpLimiter, (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 8-128 characters.' });
    }
    try {
      const { lastInsertRowid } = q.insertUser.run(email.toLowerCase(), hashPassword(password));
      res.status(201).json({ id: Number(lastInsertRowid), email: email.toLowerCase() });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'Email already registered.' });
      throw err;
    }
  });

  app.post('/auth/login', authIpLimiter, loginEmailLimiter, (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required.' });
    }
    const user = q.userByEmail.get(email.toLowerCase());
    const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH) && user;
    // Same message for "no such user" and "wrong password".
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
    res.json({ token: signToken(user.id, jwtSecret) });
  });

  // Everything below requires a valid token.
  app.use(auth);

  // ---- Categories -----------------------------------------------------------
  app.post('/categories', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 50) return res.status(400).json({ error: 'name is required (max 50 chars).' });
    try {
      const { lastInsertRowid } = q.insertCategory.run(req.userId, name);
      res.status(201).json({ id: Number(lastInsertRowid), name });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'Category already exists.' });
      throw err;
    }
  });

  app.get('/categories', (req, res) => res.json(q.categories.all(req.userId)));

  // ---- Expenses -------------------------------------------------------------
  // Validates fields present in `input`; returns { error } or { values }.
  function validateExpense(input, userId, base = {}) {
    const v = { ...base };
    if ('amount' in input) {
      v.amount_cents = parseAmountToCents(input.amount);
      if (v.amount_cents === null) return { error: 'amount must be a positive decimal with at most 2 decimal places.' };
    }
    if ('date' in input) {
      if (!isValidDate(input.date)) return { error: 'date must be a valid YYYY-MM-DD date.' };
      v.spent_on = input.date;
    }
    if ('description' in input) {
      if (typeof input.description !== 'string' || input.description.length > 200) {
        return { error: 'description must be a string of at most 200 chars.' };
      }
      v.description = input.description;
    }
    if ('categoryId' in input) {
      if (input.categoryId === null) {
        v.category_id = null;
      } else {
        // Ownership check: without it, a user could attach another user's category id.
        if (!Number.isInteger(input.categoryId) || !q.categoryOwned.get(input.categoryId, userId)) {
          return { error: 'categoryId does not exist.' };
        }
        v.category_id = input.categoryId;
      }
    }
    return { values: v };
  }

  app.post('/expenses', (req, res) => {
    const body = req.body ?? {};
    if (!('amount' in body) || !('date' in body)) return res.status(400).json({ error: 'amount and date are required.' });
    const { error, values } = validateExpense(body, req.userId, { description: '', category_id: null });
    if (error) return res.status(400).json({ error });
    const { lastInsertRowid } = q.insertExpense.run(
      req.userId, values.category_id, values.amount_cents, values.description, values.spent_on);
    res.status(201).json(toExpense(q.expenseById.get(Number(lastInsertRowid), req.userId)));
  });

  // Keyset pagination: "give me rows after this (date, id)". Unlike OFFSET, the cost
  // doesn't grow with page depth and rows inserted mid-scroll don't cause skips/duplicates.
  app.get('/expenses', (req, res) => {
    const { from, to, categoryId, cursor } = req.query;
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 100.' });
    }

    const where = ['e.user_id = ?'];
    const params = [req.userId];
    if (from !== undefined) {
      if (!isValidDate(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD.' });
      where.push('e.spent_on >= ?'); params.push(from);
    }
    if (to !== undefined) {
      if (!isValidDate(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD.' });
      where.push('e.spent_on <= ?'); params.push(to);
    }
    if (categoryId !== undefined) {
      if (!/^\d+$/.test(categoryId)) return res.status(400).json({ error: 'categoryId must be an integer.' });
      where.push('e.category_id = ?'); params.push(Number(categoryId));
    }
    if (cursor !== undefined) {
      const c = decodeCursor(cursor);
      if (!c) return res.status(400).json({ error: 'Invalid cursor.' });
      where.push('(e.spent_on < ? OR (e.spent_on = ? AND e.id < ?))');
      params.push(c.date, c.date, c.id);
    }

    // Fetch one extra row to learn whether another page exists.
    const rows = db.prepare(`
      SELECT e.id, e.amount_cents, e.description, e.spent_on, e.category_id, c.name AS category
      FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.spent_on DESC, e.id DESC
      LIMIT ?`).all(...params, limit + 1);

    const page = rows.slice(0, limit);
    res.json({
      data: page.map(toExpense),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  const parseId = (req, res) => {
    if (!/^\d+$/.test(req.params.id)) { res.status(404).json({ error: 'Expense not found.' }); return null; }
    return Number(req.params.id);
  };

  // Every lookup is scoped by user_id and returns 404 (not 403) for other users' rows,
  // so the API doesn't reveal which ids exist.
  app.get('/expenses/:id', (req, res) => {
    const id = parseId(req, res); if (id === null) return;
    const row = q.expenseById.get(id, req.userId);
    if (!row) return res.status(404).json({ error: 'Expense not found.' });
    res.json(toExpense(row));
  });

  app.patch('/expenses/:id', (req, res) => {
    const id = parseId(req, res); if (id === null) return;
    const existing = q.expenseById.get(id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Expense not found.' });
    const { error, values } = validateExpense(req.body ?? {}, req.userId, {
      amount_cents: existing.amount_cents, description: existing.description,
      spent_on: existing.spent_on, category_id: existing.category_id,
    });
    if (error) return res.status(400).json({ error });
    q.updateExpense.run(values.category_id, values.amount_cents, values.description, values.spent_on, id, req.userId);
    res.json(toExpense(q.expenseById.get(id, req.userId)));
  });

  app.delete('/expenses/:id', (req, res) => {
    const id = parseId(req, res); if (id === null) return;
    if (!q.deleteExpense.run(id, req.userId).changes) return res.status(404).json({ error: 'Expense not found.' });
    res.status(204).end();
  });

  // ---- Reports --------------------------------------------------------------
  app.get('/reports/summary', (req, res) => {
    const { month } = req.query;
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM.' });
    }
    const range = [`${month}-01`, `${month}-31`]; // ISO dates compare correctly as strings
    const total = q.summaryTotal.get(req.userId, ...range);
    res.json({
      month,
      total: formatCents(total.total),
      count: total.n,
      byCategory: q.summaryByCategory.all(req.userId, ...range)
        .map((r) => ({ category: r.category, total: formatCents(r.total), count: r.n })),
    });
  });

  // ---- Errors ---------------------------------------------------------------
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large.' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
