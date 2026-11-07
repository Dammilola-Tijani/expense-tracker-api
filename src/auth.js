import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

// scrypt is a memory-hard password hash built into Node (no native dependency).
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected); // constant-time compare
}

export function signToken(userId, secret) {
  return jwt.sign({ sub: String(userId) }, secret, { expiresIn: '1h', algorithm: 'HS256' });
}

export function requireAuth(secret) {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing bearer token.' });
    try {
      // Pin the algorithm so a token can't pick its own (e.g. "none").
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
      req.userId = Number(payload.sub);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token.' });
    }
  };
}
