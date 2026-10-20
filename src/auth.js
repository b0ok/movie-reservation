import jwt from 'jsonwebtoken';
import { HttpError } from './errors.js';

const TOKEN_TTL = process.env.JWT_EXPIRES_IN || '1d';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

export function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, secret(), { expiresIn: TOKEN_TTL });
}

// Verifies the bearer token and loads the current user, so role changes and deletions take effect immediately.
export function requireAuth(db) {
  const findUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?');
  return (req, _res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Missing bearer token'));
    let payload;
    try {
      payload = jwt.verify(token, secret());
    } catch {
      return next(new HttpError(401, 'Invalid or expired token'));
    }
    const user = findUser.get(Number(payload.sub));
    if (!user) return next(new HttpError(401, 'User no longer exists'));
    req.user = user;
    next();
  };
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') return next(new HttpError(403, 'Admin access required'));
  next();
}
