// Cliente JSON-RPC do Odoo. Credenciais só via env (nunca commitadas):
// ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
const URL = (process.env.ODOO_URL || '').replace(/\/$/, '');
const DB = process.env.ODOO_DB || '';
const LOGIN = process.env.ODOO_LOGIN || '';
const KEY = process.env.ODOO_API_KEY || '';

export function odooConfigurado(): boolean {
  return !!(URL && DB && LOGIN && KEY);
}

async function rpc(service: string, method: string, args: unknown[]): Promise<unknown> {
  const resp = await fetch(`${URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
  });
  const j = await resp.json();
  if (j.error) {
    const msg = j.error?.data?.message || j.error?.message || JSON.stringify(j.error);
    throw new Error(String(msg));
  }
  return j.result;
}

let _uid: number | null = null;
async function uid(): Promise<number> {
  if (_uid) return _uid;
  const id = await rpc('common', 'authenticate', [DB, LOGIN, KEY, {}]);
  if (!id || typeof id !== 'number') throw new Error('Falha ao autenticar no Odoo (login/chave).');
  _uid = id;
  return id;
}

// execute_kw genérico
export async function execKw<T = unknown>(
  model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}
): Promise<T> {
  const u = await uid();
  return rpc('object', 'execute_kw', [DB, u, KEY, model, method, args, kwargs]) as Promise<T>;
}
