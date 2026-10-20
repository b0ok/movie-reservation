import { badRequest } from './errors.js';

// Minimal schema checker: rules map field -> { type, required, min, max, pattern, oneOf }.
// Returns only the declared fields so unknown input never reaches SQL.
export function validate(body, rules, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('JSON object body required');
  const out = {};
  const errors = [];
  for (const [field, rule] of Object.entries(rules)) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      if (rule.required && !partial) errors.push(`${field} is required`);
      continue;
    }
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') { errors.push(`${field} must be a string`); continue; }
        if (rule.min && value.trim().length < rule.min) errors.push(`${field} must be at least ${rule.min} characters`);
        if (rule.max && value.length > rule.max) errors.push(`${field} must be at most ${rule.max} characters`);
        if (rule.pattern && !rule.pattern.test(value)) errors.push(`${field} is invalid`);
        if (rule.oneOf && !rule.oneOf.includes(value)) errors.push(`${field} must be one of ${rule.oneOf.join(', ')}`);
        out[field] = rule.trim === false ? value : value.trim();
        break;
      case 'int':
        if (!Number.isInteger(value)) { errors.push(`${field} must be an integer`); continue; }
        if (rule.min !== undefined && value < rule.min) errors.push(`${field} must be >= ${rule.min}`);
        if (rule.max !== undefined && value > rule.max) errors.push(`${field} must be <= ${rule.max}`);
        out[field] = value;
        break;
      case 'datetime': {
        const d = typeof value === 'string' ? new Date(value) : null;
        if (!d || Number.isNaN(d.getTime())) { errors.push(`${field} must be an ISO-8601 datetime`); continue; }
        out[field] = d.toISOString();
        break;
      }
      case 'stringArray':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          errors.push(`${field} must be an array of strings`); continue;
        }
        if (rule.max && value.length > rule.max) errors.push(`${field} must contain at most ${rule.max} items`);
        out[field] = value.map((v) => (rule.upper ? v.trim().toUpperCase() : v.trim())).filter(Boolean);
        if (rule.min && out[field].length < rule.min) errors.push(`${field} must contain at least ${rule.min} item(s)`);
        break;
      default:
        throw new Error(`Unknown rule type ${rule.type}`);
    }
  }
  if (errors.length) throw badRequest('Validation failed', errors);
  return out;
}

export function parseId(raw, what = 'id') {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw badRequest(`Invalid ${what}`);
  return id;
}

export function parsePaging(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

// Accepts YYYY-MM-DD and returns the [start, end) UTC range for that day.
export function parseDay(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw badRequest('date must be YYYY-MM-DD');
  const start = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw badRequest('date must be YYYY-MM-DD');
  const end = new Date(start.getTime() + 86_400_000);
  return [start.toISOString(), end.toISOString()];
}
