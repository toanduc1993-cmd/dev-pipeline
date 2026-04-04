export function validate(schema) {
  return (req, res, next) => {
    const errors = [];

    if (schema.body) {
      const result = schema.body.safeParse(req.body);
      if (!result.success) {
        errors.push(...result.error.issues.map((i) => `body.${i.path.join('.')}: ${i.message}`));
      } else {
        req.body = result.data;
      }
    }

    if (schema.params) {
      const result = schema.params.safeParse(req.params);
      if (!result.success) {
        errors.push(...result.error.issues.map((i) => `params.${i.path.join('.')}: ${i.message}`));
      } else {
        req.params = result.data;
      }
    }

    if (schema.query) {
      const result = schema.query.safeParse(req.query);
      if (!result.success) {
        errors.push(...result.error.issues.map((i) => `query.${i.path.join('.')}: ${i.message}`));
      } else {
        req.query = result.data;
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    next();
  };
}
