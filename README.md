# Expense Tracker API

A REST API for tracking personal expenses, with JWT authentication, per-user data isolation, categories, filtering, cursor pagination, and monthly reports.

Built with Node.js, Express, and SQLite (via Node's built-in `node:sqlite`). Small on purpose: the goal was to get the *backend fundamentals* right: money handling, auth, authorization, and pagination.

## Quick start

Requires Node.js 22.5+ (uses the built-in `node:sqlite` and test runner).

```bash
npm install
cp .env.example .env     # then paste a random JWT_SECRET into .env (generator command is in the file)
npm start               # http://localhost:3000
```

Run the tests:

```bash
npm test
```

| Variable     | Required | Default        | Purpose                                        |
| ------------ | -------- | -------------- | ---------------------------------------------- |
| `JWT_SECRET` | yes      | n/a            | Signing key for tokens (min 16 chars)          |
| `PORT`       | no       | `3000`         | HTTP port                                      |
| `DB_FILE`    | no       | `expenses.db`  | SQLite file path                               |

The server refuses to start without a strong `JWT_SECRET` rather than falling back to a guessable default.

## API

All routes except `/auth/*` and `/health` need `Authorization: Bearer <token>`. Errors are JSON: `{ "error": "message" }`.

| Method | Path                    | Description                                        |
| ------ | ----------------------- | -------------------------------------------------- |
| POST   | `/auth/register`        | Create an account                                  |
| POST   | `/auth/login`           | Get a 1-hour JWT                                   |
| POST   | `/categories`           | Create a category                                  |
| GET    | `/categories`           | List your categories                               |
| POST   | `/expenses`             | Create an expense                                  |
| GET    | `/expenses`             | List expenses (filters + cursor pagination)        |
| GET    | `/expenses/:id`         | Get one expense                                    |
| PATCH  | `/expenses/:id`         | Partially update an expense                        |
| DELETE | `/expenses/:id`         | Delete an expense                                  |
| GET    | `/reports/summary`      | Monthly total and per-category breakdown           |

### Example session

```bash
BASE=http://localhost:3000

curl -X POST $BASE/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct-horse"}'

TOKEN=$(curl -s -X POST $BASE/auth/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct-horse"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

curl -X POST $BASE/categories -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Food"}'

curl -X POST $BASE/expenses -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"amount":"12.50","date":"2024-03-10","description":"Lunch","categoryId":1}'

curl "$BASE/expenses?from=2024-03-01&to=2024-03-31&limit=10" -H "authorization: Bearer $TOKEN"
curl "$BASE/reports/summary?month=2024-03" -H "authorization: Bearer $TOKEN"
```

**Create body:** `amount` (required, string or number, positive, ≤ 2 decimals), `date` (required, `YYYY-MM-DD`), `description` (optional, ≤ 200 chars), `categoryId` (optional).

**List query params:** `from`, `to` (`YYYY-MM-DD`), `categoryId`, `limit` (1–100, default 20), `cursor`. The response is `{ "data": [...], "nextCursor": "..." | null }`. Pass `nextCursor` back as `cursor` to get the next page.

**Summary response:**

```json
{
  "month": "2024-03",
  "total": "100.35",
  "count": 3,
  "byCategory": [{ "category": "Food", "total": "0.30", "count": 2 }]
}
```

## Problems I solved (and why)

### 1. Money without floating-point errors
`0.1 + 0.2 !== 0.3` in JavaScript, and `19.99 * 100` is `1998.9999999999998`. Summing floats in a finance app accumulates errors.

- Amounts are stored as **integer cents** with a `CHECK (amount_cents > 0)` constraint.
- Input is parsed from its *decimal string* form with a strict regex and string splitting, with no multiplication by 100.
- Values with more than 2 decimals (`1.999`) are **rejected** instead of silently rounded, since silently changing a user's number is worse than an error.
- The API returns amounts as strings (`"12.50"`) so clients don't reintroduce float drift.
- A test confirms `0.10 + 0.20 + 100.05` sums to exactly `100.35`.

### 2. Users must never touch each other's data
Authentication ("who are you?") is easy to get right while authorization ("is this yours?") is easy to forget.

- Every expense query includes `AND user_id = ?` using the id from the verified token, never from the request body.
- Other users' rows return **404, not 403**, so the API doesn't reveal which ids exist.
- A less obvious hole: creating an expense with `categoryId` pointing at *someone else's* category. It would pass a foreign-key check. Category ownership is verified explicitly.
- Tests cover read/update/delete/list/category-attach across two users.

### 3. Pagination that stays correct and fast
`LIMIT/OFFSET` gets slower on deep pages, and if a row is inserted while someone pages through results, they see duplicates or miss items.

- The list uses **keyset (cursor) pagination** on `(spent_on, id)`: "give me rows older than the last one I saw."
- `id` is a tiebreaker, because many expenses share a date. Without it, rows on a page boundary would be skipped.
- A composite index `(user_id, spent_on DESC, id DESC)` matches the query's filter and sort order.
- The query fetches `limit + 1` rows to know whether another page exists without a separate `COUNT`.
- A test walks 7 rows (with date ties) in pages of 3 and asserts exact order with no gaps or repeats.

### 4. Authentication details that are easy to get wrong
- Passwords are hashed with **scrypt** (memory-hard) and a per-user salt, and compared with `timingSafeEqual`.
- Login returns the **same error** for "unknown email" and "wrong password" and runs a dummy hash for unknown emails, so neither the message nor the response time reveals whether an email is registered.
- JWT verification **pins the algorithm** (`HS256`), so a token can't choose its own, such as `alg: none`.
- Tests cover missing, garbage, expired, and wrong-secret tokens.

## Design decisions and trade-offs

- **SQLite:** zero setup so anyone can clone and run it. The SQL is standard, and moving to Postgres would mainly mean swapping the driver and the date functions.
- **`node:sqlite`** instead of a third-party driver: avoids native compilation, which often breaks on Windows. It's still marked experimental in Node.
- **Month report uses `BETWEEN 'YYYY-MM-01' AND 'YYYY-MM-31'`:** ISO date strings sort correctly as text, so the index can be used and no per-month date math is needed.
- **No ORM:** raw prepared statements keep the SQL visible and easy to reason about at this size.

## Known limitations

Intentionally out of scope, and what I'd do next:

- **No rate limiting on `/auth/login`**, so it's open to brute-force attempts. I'd add per-IP and per-account throttling.
- **No refresh tokens or revocation.** Tokens are valid for 1 hour and can't be invalidated early.
- **Single currency**, with no multi-currency support.
- **Single-process SQLite.** Fine for one server, but horizontal scaling means moving to Postgres.
- **Migrations are `CREATE TABLE IF NOT EXISTS`.** A real project should use a migration tool.
- Email addresses aren't verified.

## Project layout

```
src/
  server.js   entry point: config check, startup, graceful shutdown
  app.js      routes, validation, authorization
  auth.js     password hashing, JWT sign/verify, auth middleware
  money.js    cents parsing/formatting, date validation
  db.js       schema
test/
  app.test.js end-to-end tests against an in-memory database
```
