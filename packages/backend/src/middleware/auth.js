export function authMiddleware(req, res, next) {
  if (req.path === '/api/health') return next();

  const secret = process.env.API_SECRET;
  if (!secret) return next(); // Dev mode — no secret set, allow all

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || token !== secret) {
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API token' });
  }

  next();
}
