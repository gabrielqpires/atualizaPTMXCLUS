import { query } from './db';

export const PARES_CAMBIO = [
  'EUR>USD', 'USD>EUR',
  'EUR>MXN', 'MXN>EUR',
  'USD>MXN', 'MXN>USD',
  'USD>BRL', 'BRL>USD',
  'EUR>BRL', 'BRL>EUR',
  'BRL>MXN', 'MXN>BRL',
];

export const PARES_CAMBIO_PRINCIPAIS = [
  'EUR>USD',
  'EUR>MXN',
  'USD>MXN',
  'USD>BRL',
  'EUR>BRL',
  'BRL>MXN',
];

export const TAXAS_CAMBIO_PADRAO: Record<string, number> = {
  'USD>EUR': 0.8547,
  'EUR>USD': 1.17,
  'EUR>MXN': 19,
  'MXN>EUR': 0.0526,
  'MXN>USD': 0.0588,
  'USD>MXN': 17,
  'BRL>USD': 0.1923,
  'USD>BRL': 5.20,
  'BRL>EUR': 0.1695,
  'EUR>BRL': 5.90,
  'BRL>MXN': 3.37,
  'MXN>BRL': 0.2967,
};

let cacheTaxas: Record<string, number> | null = null;
let initPromise: Promise<void> | null = null;

function inverso(par: string): string {
  const [origem, destino] = par.split('>');
  return `${destino}>${origem}`;
}

function normalizarPar(par: unknown): string | null {
  const value = String(par || '').trim().toUpperCase();
  return /^[A-Z]{3}>[A-Z]{3}$/.test(value) ? value : null;
}

function normalizarTaxa(valor: unknown): number | null {
  const num = Number(valor);
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function garantirTabelaTaxasCambio() {
  if (!initPromise) {
    initPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS taxas_cambio (
          par text PRIMARY KEY CHECK (par ~ '^[A-Z]{3}>[A-Z]{3}$'),
          taxa numeric NOT NULL CHECK (taxa > 0),
          atualizado_em timestamptz NOT NULL DEFAULT now()
        )
      `);
      await query(`ALTER TABLE taxas_cambio ENABLE ROW LEVEL SECURITY`);
      await query(
        `INSERT INTO taxas_cambio (par, taxa)
         SELECT * FROM unnest($1::text[], $2::numeric[])
         ON CONFLICT (par) DO NOTHING`,
        [Object.keys(TAXAS_CAMBIO_PADRAO), Object.values(TAXAS_CAMBIO_PADRAO)]
      );
    })();
  }
  await initPromise;
}

export function getTaxasCambioSync(): Record<string, number> {
  return { ...TAXAS_CAMBIO_PADRAO, ...(cacheTaxas || {}) };
}

export async function carregarTaxasCambio(force = false): Promise<Record<string, number>> {
  if (cacheTaxas && !force) return getTaxasCambioSync();
  await garantirTabelaTaxasCambio();
  const rows = await query<{ par: string; taxa: string | number }>(
    `SELECT par, taxa FROM taxas_cambio ORDER BY par`
  );
  const loaded: Record<string, number> = {};
  for (const row of rows) {
    const par = normalizarPar(row.par);
    const taxa = normalizarTaxa(row.taxa);
    if (par && taxa) loaded[par] = taxa;
  }
  cacheTaxas = { ...TAXAS_CAMBIO_PADRAO, ...loaded };
  return getTaxasCambioSync();
}

export async function salvarTaxasCambio(input: Record<string, unknown>): Promise<Record<string, number>> {
  const next: Record<string, number> = { ...TAXAS_CAMBIO_PADRAO };
  for (const [rawPar, rawTaxa] of Object.entries(input || {})) {
    const par = normalizarPar(rawPar);
    if (!par) continue;
    const taxa = normalizarTaxa(rawTaxa);
    if (!taxa) throw new Error(`Taxa invalida para ${par}`);
    next[par] = taxa;
  }

  for (const par of PARES_CAMBIO_PRINCIPAIS) {
    const taxa = next[par];
    if (taxa > 0) next[inverso(par)] = Number((1 / taxa).toFixed(6));
  }

  await garantirTabelaTaxasCambio();
  await query(
    `INSERT INTO taxas_cambio (par, taxa, atualizado_em)
     SELECT *, now() FROM unnest($1::text[], $2::numeric[])
     ON CONFLICT (par) DO UPDATE SET taxa = EXCLUDED.taxa, atualizado_em = now()`,
    [Object.keys(next), Object.values(next)]
  );
  cacheTaxas = next;
  return getTaxasCambioSync();
}

export async function restaurarTaxasCambioPadrao(): Promise<Record<string, number>> {
  return salvarTaxasCambio(TAXAS_CAMBIO_PADRAO);
}
