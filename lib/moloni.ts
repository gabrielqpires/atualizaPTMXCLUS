const API_BASE = 'https://api.moloni.pt/v1';

export type MoloniCustomer = {
  customer_id: number;
  name?: string;
  vat?: string;
  email?: string;
};

export type MoloniCustomerDetails = MoloniCustomer & {
  number?: string;
  address?: string;
  city?: string;
  zip_code?: string;
  country_id?: number;
  country?: { country?: string; iso_3166_1?: string };
};

export type MoloniProduct = {
  product_id: number;
  name?: string;
  reference?: string;
};

type MoloniConfig = {
  companyId: number;
  documentSetId: number;
  languageId: number;
  maturityDateId: number;
  paymentMethodId: number;
  productCategoryId: number;
  unitId: number;
  countryId: number;
  exemptionReason: string;
};

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

function env(name: string): string {
  return String(process.env[name] || '').trim();
}

function numEnv(name: string, fallback = 0): number {
  const n = Number(env(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function moloniConfigurado(): boolean {
  return !!(
    env('MOLONI_CLIENT_ID') &&
    env('MOLONI_CLIENT_SECRET') &&
    env('MOLONI_USERNAME') &&
    env('MOLONI_PASSWORD') &&
    numEnv('MOLONI_COMPANY_ID') &&
    numEnv('MOLONI_DOCUMENT_SET_ID')
  );
}

export function moloniConfig(): MoloniConfig {
  return {
    companyId: numEnv('MOLONI_COMPANY_ID'),
    documentSetId: numEnv('MOLONI_DOCUMENT_SET_ID'),
    languageId: numEnv('MOLONI_LANGUAGE_ID', 1),
    maturityDateId: numEnv('MOLONI_MATURITY_DATE_ID', 1),
    paymentMethodId: numEnv('MOLONI_PAYMENT_METHOD_ID', 1),
    productCategoryId: numEnv('MOLONI_PRODUCT_CATEGORY_ID'),
    unitId: numEnv('MOLONI_UNIT_ID'),
    countryId: numEnv('MOLONI_COUNTRY_ID', 1),
    exemptionReason: env('MOLONI_EXEMPTION_REASON') || 'M19',
  };
}

function appendForm(form: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendForm(form, `${key}[${index}]`, item));
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      appendForm(form, `${key}[${childKey}]`, childValue);
    }
    return;
  }
  form.append(key, String(value));
}

function toForm(body: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) appendForm(form, key, value);
  return form;
}

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;

  const url = new URL(`${API_BASE}/grant/`);
  url.searchParams.set('grant_type', 'password');
  url.searchParams.set('client_id', env('MOLONI_CLIENT_ID'));
  url.searchParams.set('client_secret', env('MOLONI_CLIENT_SECRET'));
  url.searchParams.set('username', env('MOLONI_USERNAME'));
  url.searchParams.set('password', env('MOLONI_PASSWORD'));

  const resp = await fetch(url, { cache: 'no-store' });
  const json = await resp.json().catch(() => null) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
  if (!resp.ok || !json?.access_token) {
    throw new Error(`Moloni grant falhou: ${resp.status} ${json?.error_description || json?.error || 'sem detalhes'}`);
  }

  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
  return tokenCache.accessToken;
}

export async function moloniPost<T = unknown>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const token = await accessToken();
  const cleanEndpoint = endpoint.replace(/^\/+|\/+$/g, '');
  const resp = await fetch(`${API_BASE}/${cleanEndpoint}/?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toForm(body),
    cache: 'no-store',
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || (json && typeof json === 'object' && 'error' in json)) {
    const msg = (json as { error_description?: string; error?: string } | null)?.error_description
      || (json as { error?: string } | null)?.error
      || JSON.stringify(json).slice(0, 500);
    throw new Error(`Moloni ${cleanEndpoint} falhou: ${resp.status} ${msg}`);
  }
  return json as T;
}

export function primeiroEmail(...values: Array<string | null | undefined>): string {
  return values
    .join(' ')
    .split(/[;,\s]+/)
    .map(v => v.trim().toLowerCase())
    .find(v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || '';
}

export async function buscarClienteMoloni(nome: string, email: string): Promise<MoloniCustomer | null> {
  const cfg = moloniConfig();
  const terms = [email, nome].map(v => String(v || '').trim()).filter(Boolean);
  for (const search of terms) {
    const rows = await moloniPost<MoloniCustomer[]>('customers/getBySearch', {
      company_id: cfg.companyId,
      search,
    });
    if (Array.isArray(rows) && rows[0]?.customer_id) return rows[0];
  }
  return null;
}

export async function criarClienteMoloni(nome: string, email: string): Promise<number> {
  const cfg = moloniConfig();
  const numberBase = `SS-${Date.now().toString().slice(-9)}`;
  const payload = {
    company_id: cfg.companyId,
    vat: env('MOLONI_DEFAULT_CUSTOMER_VAT') || '999999990',
    number: numberBase,
    name: nome || email || 'Cliente ShipSmart',
    language_id: cfg.languageId,
    address: env('MOLONI_DEFAULT_CUSTOMER_ADDRESS') || 'Desconhecido',
    city: env('MOLONI_DEFAULT_CUSTOMER_CITY') || 'Desconhecido',
    zip_code: env('MOLONI_DEFAULT_CUSTOMER_ZIP') || '',
    country_id: cfg.countryId,
    email: email || '',
    maturity_date_id: cfg.maturityDateId,
    payment_method_id: cfg.paymentMethodId,
    copies: [{ document_type_id: 1, copies: 1 }],
  };
  const created = await moloniPost<number | { customer_id?: number }>('customers/insert', payload);
  if (typeof created === 'number') return created;
  if (created?.customer_id) return created.customer_id;
  throw new Error(`Moloni criou cliente sem customer_id: ${JSON.stringify(created).slice(0, 300)}`);
}

export async function getOrCreateMoloniCustomer(nome: string, email: string): Promise<number> {
  const found = await buscarClienteMoloni(nome, email);
  if (found?.customer_id) return found.customer_id;
  return criarClienteMoloni(nome, email);
}

export async function getMoloniCustomerDetails(customerId: number): Promise<MoloniCustomerDetails> {
  const cfg = moloniConfig();
  return moloniPost<MoloniCustomerDetails>('customers/getOne', {
    company_id: cfg.companyId,
    customer_id: customerId,
  });
}

export async function buscarProdutoMoloni(reference: string, name: string): Promise<MoloniProduct | null> {
  const cfg = moloniConfig();
  const terms = [reference, name].map(v => String(v || '').trim()).filter(Boolean);
  for (const search of terms) {
    const rows = await moloniPost<MoloniProduct[]>('products/getBySearch', {
      company_id: cfg.companyId,
      search,
    });
    if (!Array.isArray(rows)) continue;
    const exact = rows.find(p => String(p.reference || '').trim().toLowerCase() === reference.trim().toLowerCase())
      || rows.find(p => String(p.name || '').trim().toLowerCase() === name.trim().toLowerCase())
      || rows[0];
    if (exact?.product_id) return exact;
  }
  return null;
}

export async function criarProdutoMoloni(reference: string, name: string): Promise<number> {
  const cfg = moloniConfig();
  if (!cfg.productCategoryId || !cfg.unitId) {
    throw new Error('Moloni nao configurado para criar artigos (faltam MOLONI_PRODUCT_CATEGORY_ID e/ou MOLONI_UNIT_ID).');
  }
  const created = await moloniPost<number | { product_id?: number }>('products/insert', {
    company_id: cfg.companyId,
    category_id: cfg.productCategoryId,
    type: 2,
    reference,
    name,
    summary: '',
    price: 0,
    unit_id: cfg.unitId,
    has_stock: 0,
    taxes: [],
    exemption_reason: cfg.exemptionReason,
  });
  if (typeof created === 'number') return created;
  if (created?.product_id) return created.product_id;
  throw new Error(`Moloni criou artigo sem product_id: ${JSON.stringify(created).slice(0, 300)}`);
}

export async function getOrCreateMoloniProduct(reference: string, name: string): Promise<number> {
  const found = await buscarProdutoMoloni(reference, name);
  if (found?.product_id) return found.product_id;
  return criarProdutoMoloni(reference, name);
}
