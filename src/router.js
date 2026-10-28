// Minimal path router: exact literals win, then patterns with :params, in registration order.
export function makeRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, pattern });
  };
  return {
    get: (p, h) => add('GET', p, h), post: (p, h) => add('POST', p, h), any: (p, h) => add('*', p, h),
    match(method, path) {
      for (const r of routes) {
        if (r.method !== '*' && r.method !== method) continue;
        const m = r.re.exec(path); if (!m) continue;
        const params = {}; r.keys.forEach((k, i) => (params[k] = m[i + 1]));
        return { handler: r.handler, params };
      }
      return null;
    },
  };
}
