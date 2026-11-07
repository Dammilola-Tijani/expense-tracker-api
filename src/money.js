// Parse a decimal amount into integer cents WITHOUT floating-point math.
// Accepts "12", "12.5", "12.50" (strings) or whole numbers / simple decimals.
// Rejects anything with more than 2 decimal places instead of silently rounding.
export function parseAmountToCents(value) {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

export function formatCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// Strict YYYY-MM-DD that also exists on the calendar (rejects 2024-02-31).
export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
