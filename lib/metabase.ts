import { query } from './db';
import { inferirGrupo } from './faturamento';

// ── Config (via env vars na Vercel) ──────────────────────────
// MB_BASE_URL, MB_USERNAME, MB_PASSWORD, MB_CARD_ID, MB_FROM_DATE
function getConfig() {
  // trim: env vars coladas no dashboard costumam vir com espaço/quebra de linha
  const cfg = {
    baseUrl: (process.env.MB_BASE_URL || '').trim().replace(/\/$/, ''),
    username: (process.env.MB_USERNAME || '').trim(),
    password: (process.env.MB_PASSWORD || '').trim(),
    cardId: (process.env.MB_CARD_ID || '').trim(),
    fromDate: (process.env.MB_FROM_DATE || '2026-05-01').trim(),
  };
  if (!cfg.baseUrl || !cfg.username || !cfg.password || !cfg.cardId) {
    throw new Error('Metabase não configurado. Defina MB_BASE_URL, MB_USERNAME, MB_PASSWORD, MB_CARD_ID nas variáveis de ambiente.');
  }
  return cfg;
}

// ── Helpers (espelho de Code.gs / Metabase.gs) ───────────────
function parseNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const n = Number(String(value ?? '').replace(',', '.').trim());
  return isNaN(n) ? 0 : n;
}

function normalizarEmail(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

function toBoolean(value: unknown): boolean {
  if (value === true) return true;
  const t = String(value ?? '').trim().toLowerCase();
  return t === 'true' || t === 'sim' || t === '1' || t === 'yes';
}

function pick(row: Record<string, unknown>, aliases: string[]): unknown {
  for (const a of aliases) {
    if (row[a] !== undefined && row[a] !== null) return row[a];
  }
  return '';
}

function extrairTaxValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value !== null && 'tax_value' in value) {
    return parseNumber((value as Record<string, unknown>).tax_value);
  }
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.tax_value !== undefined) return parseNumber(parsed.tax_value);
  } catch { /* not json */ }
  const m = text.match(/["']?tax_value["']?\s*:\s*["']?(-?\d+(?:[.,]\d+)?)["']?/i);
  return m ? parseNumber(m[1]) : null;
}

function isDataDentroDoCorte(value: unknown, fromDateText: string): boolean {
  if (!fromDateText) return true;
  if (!value) return false;
  const fromDate = new Date(fromDateText + 'T00:00:00');
  const date = new Date(value as string);
  if (isNaN(date.getTime())) return false;
  return date.getTime() >= fromDate.getTime();
}

function inferirPaisPorContrato(descricao: unknown): string {
  const text = String(descricao ?? '').toLowerCase();
  if (!text) return '';
  if (text.includes('portugal') || /\bpt\b/.test(text) || /\beur\b/.test(text)) return 'PT';
  if (text.includes('united states') || text.includes('estados unidos') || /\busa\b/.test(text) || /\bus\b/.test(text) || /\busd\b/.test(text)) return 'US';
  if (text.includes('chile') || /\bcl\b/.test(text)) return 'CL';
  if (text.includes('mexico') || text.includes('méxico') || /\bmx\b/.test(text)) return 'MX';
  return '';
}

const EMAIL_PAIS_FALLBACK: Record<string, string> = {
  'paulo@uscloser.com': 'US',
  'exclusive.leather.authentic@gmail.com': 'US',
  'ecomops+schutz@arezzousa.com': 'US',
};

function inferirPaisOperacional(email: string, paisContrato: string): string {
  if (email === 'dev@parcelabc.com') {
    return paisContrato === 'MX' || paisContrato === 'CL' ? paisContrato : 'US';
  }
  return EMAIL_PAIS_FALLBACK[email] || paisContrato;
}

// ── Auth + fetch ─────────────────────────────────────────────
let _tokenCache: { token: string; exp: number } | null = null;

async function getToken(forceNew: boolean): Promise<string> {
  const cfg = getConfig();
  if (!forceNew && _tokenCache && _tokenCache.exp > Date.now()) return _tokenCache.token;
  const resp = await fetch(`${cfg.baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
  if (!resp.ok) throw new Error('Falha ao autenticar no Metabase: ' + (await resp.text()).slice(0, 300));
  const token = (await resp.json()).id as string;
  _tokenCache = { token, exp: Date.now() + 6 * 60 * 60 * 1000 };
  return token;
}

async function buscarDados(): Promise<Record<string, unknown>[]> {
  const cfg = getConfig();
  let token = await getToken(false);
  let resp = await fetch(`${cfg.baseUrl}/api/card/${cfg.cardId}/query/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': token },
  });
  if (resp.status === 401) {
    token = await getToken(true);
    resp = await fetch(`${cfg.baseUrl}/api/card/${cfg.cardId}/query/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Metabase-Session': token },
    });
  }
  if (!resp.ok) throw new Error('Metabase retornou HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const linhas = await resp.json();
  if (!Array.isArray(linhas)) throw new Error('Resposta do Metabase em formato inesperado.');
  return linhas;
}

interface RemessaMB {
  remessaId: string; awb: string; email: string; freteUsd: number;
  impostoOriginal: number; impostoEur: number; impostoTipo: string; moedaCotacao: string;
  status: string; statusCodigo: string; operacaoFaturavel: boolean; data: string;
  contratoDescricao: string; pais: string; tms: boolean; mor: boolean;
  orderId: string; weight: number; destination: string; group: string;
}

function montarRemessas(linhas: Record<string, unknown>[]): RemessaMB[] {
  const fromDate = getConfig().fromDate;
  return linhas.map(row => {
    const contratoDescricao = String(pick(row, [
      'ContratoDescricao', 'contrato_descricao', 'contratos_descricao', 'Contratos__descricao',
      'contratos__descricao', 'Contratos - Descricao', 'Contratos - Descrição',
      'contratos - descricao', 'contratos - descrição',
    ]) || '');
    const taxValue = extrairTaxValue(pick(row, ['imposto_detalhes', 'impostos_detalhes', 'ImpostosDetalhes', 'tax_value_details']));
    const destination = String(pick(row, ['pais_destinatario', 'destination', 'Destination']) || '');
    const email = normalizarEmail(pick(row, ['email', 'EmailUsuario', 'usuario_email']));
    const paisContrato = inferirPaisPorContrato(contratoDescricao);
    return {
      remessaId: String(pick(row, ['remessa_id', 'RemessaID', 'id']) || ''),
      awb: String(pick(row, ['awb', 'AWB']) || ''),
      email,
      freteUsd: parseNumber(pick(row, ['Cotacoes Transportadores - Codigo__frete', 'frete_usd', 'FreteUSD'])),
      impostoOriginal: taxValue !== null ? taxValue : parseNumber(pick(row, ['impostos_final', 'ImpostoOriginal', 'imposto_original'])),
      impostoEur: parseNumber(pick(row, ['impostos_final_eur', 'ImpostoEUR', 'impostos_eur'])),
      impostoTipo: String(pick(row, ['imposto_tipo', 'ImpostoTipo']) || '').toLowerCase(),
      moedaCotacao: String(pick(row, ['moeda_cotacao', 'MoedaCotacao']) || '').toUpperCase(),
      status: String(pick(row, ['status_nome', 'Status', 'status']) || ''),
      statusCodigo: String(pick(row, ['status_id', 'StatusCodigo', 'status_codigo']) || ''),
      operacaoFaturavel: toBoolean(pick(row, ['is_operacao_faturavel', 'OperacaoFaturavel'])),
      data: String(pick(row, ['created_at', 'Data', 'data']) || ''),
      contratoDescricao,
      pais: inferirPaisOperacional(email, paisContrato),
      tms: toBoolean(pick(row, ['tms', 'TMS'])),
      mor: toBoolean(pick(row, ['mor', 'MOR'])),
      orderId: String(pick(row, ['order_id', 'OrderID', 'order', 'Order', 'pedido']) || ''),
      weight: parseNumber(pick(row, ['peso_valor', 'weight', 'Weight', 'peso', 'peso_kg'])),
      destination,
      group: inferirGrupo(String(pick(row, ['destino_bloco_eu', 'destino_bloco', 'Group', 'group']) || '') || destination),
    };
  }).filter(r => r.remessaId && isDataDentroDoCorte(r.data, fromDate));
}

// email → cliente[] (espelho de montarMapaEmailCliente_)
async function montarMapaEmailCliente(): Promise<Record<string, { clienteId: string; pais: string; tms: boolean; mor: boolean }[]>> {
  const clientes = await query<{ cliente_id: string; emails_usuario: string; pais: string; tms: boolean; mor: boolean }>(
    `SELECT cliente_id, emails_usuario, pais, tms, mor FROM clientes`
  );
  const mapa: Record<string, { clienteId: string; pais: string; tms: boolean; mor: boolean }[]> = {};
  for (const c of clientes) {
    for (const raw of String(c.emails_usuario || '').split(',')) {
      const email = normalizarEmail(raw);
      if (!email) continue;
      if (!mapa[email]) mapa[email] = [];
      mapa[email].push({ clienteId: c.cliente_id, pais: c.pais, tms: !!c.tms, mor: !!c.mor });
    }
  }
  return mapa;
}

function resolverCliente(
  mapa: Record<string, { clienteId: string; pais: string; tms: boolean; mor: boolean }[]>,
  email: string, pais: string
) {
  const cand = mapa[email];
  if (!cand || !cand.length) return null;
  if (cand.length === 1) return cand[0];
  if (!pais) return null;
  const exato = cand.filter(c => c.pais === pais);
  return exato.length ? exato[0] : null;
}

export interface SyncResult {
  sucesso: boolean;
  totalProcessadas: number;
  novas: number;
  atualizadas: number;
  comClienteEncontrado: number;
  comPaisContrato: number;
}

// Espelho de syncRemessasDoMetabase: upsert por remessa_id preservando
// cliente manual, flag "ignorado" (operacao_faturavel) e país já definido.
export async function syncRemessasDoMetabase(tipo: 'manual' | 'automatico'): Promise<SyncResult> {
  const remessas = montarRemessas(await buscarDados());
  const mapaEmail = await montarMapaEmailCliente();

  const existentes = await query<{ remessa_id: string }>(`SELECT remessa_id FROM remessas`);
  const existSet = new Set(existentes.map(r => r.remessa_id));

  let novas = 0, atualizadas = 0, comClienteEncontrado = 0, comPaisContrato = 0;

  const CHUNK = 400;
  for (let i = 0; i < remessas.length; i += CHUNK) {
    const slice = remessas.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples: string[] = [];
    slice.forEach((r, idx) => {
      const match = resolverCliente(mapaEmail, r.email, r.pais);
      const pais = match ? match.pais : (r.pais || '');
      if (r.pais) comPaisContrato++;
      if (match) comClienteEncontrado++;
      if (existSet.has(r.remessaId)) atualizadas++; else novas++;
      const tms = r.tms || (match ? match.tms : false);
      const mor = r.mor || (match ? match.mor : false);
      const b = idx * 21;
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},now(),$${b + 18},$${b + 19},$${b + 20},$${b + 21})`);
      values.push(
        r.remessaId, r.awb, match ? match.clienteId : null, pais || null, r.email,
        r.freteUsd, r.impostoOriginal, r.impostoEur, r.impostoTipo, r.moedaCotacao,
        // Espelho do Apps Script: só o "Ignorar" manual exclui da janela (isFaturavel_
        // testa apenas 'nao'); o is_operacao_faturavel do Metabase NÃO desativa remessa
        // (senão FOC etc. somem). Insert sempre true; update preserva o valor local.
        r.status, r.statusCodigo, true, r.data || null, r.contratoDescricao,
        tms, mor, r.orderId, r.weight, r.destination, r.group
      );
    });
    await query(
      `INSERT INTO remessas (
        remessa_id, awb, cliente_id, pais, email_usuario, frete_usd, imposto_original,
        imposto_eur, imposto_tipo, moeda_cotacao, status, status_codigo, operacao_faturavel,
        data, contrato_descricao, tms, mor, synced_at, order_id, weight, destination, grupo
      ) VALUES ${tuples.join(',')}
      ON CONFLICT (remessa_id) DO UPDATE SET
        awb = EXCLUDED.awb,
        email_usuario = EXCLUDED.email_usuario,
        frete_usd = EXCLUDED.frete_usd,
        imposto_original = EXCLUDED.imposto_original,
        imposto_eur = EXCLUDED.imposto_eur,
        imposto_tipo = EXCLUDED.imposto_tipo,
        moeda_cotacao = EXCLUDED.moeda_cotacao,
        status = EXCLUDED.status,
        status_codigo = EXCLUDED.status_codigo,
        operacao_faturavel = remessas.operacao_faturavel,
        data = EXCLUDED.data,
        contrato_descricao = EXCLUDED.contrato_descricao,
        tms = remessas.tms OR EXCLUDED.tms,
        mor = remessas.mor OR EXCLUDED.mor,
        synced_at = now(),
        order_id = EXCLUDED.order_id,
        weight = EXCLUDED.weight,
        destination = EXCLUDED.destination,
        grupo = EXCLUDED.grupo,
        cliente_id = COALESCE(EXCLUDED.cliente_id, remessas.cliente_id),
        pais = COALESCE(
          (SELECT c.pais FROM clientes c WHERE c.cliente_id = COALESCE(EXCLUDED.cliente_id, remessas.cliente_id)),
          NULLIF(EXCLUDED.pais,''),
          NULLIF(remessas.pais,'')
        )`,
      values
    );
  }

  const stats = { totalProcessadas: remessas.length, novas, atualizadas, comClienteEncontrado, comPaisContrato };
  await query(
    `UPDATE sync_state SET last_sync=now(), tipo=$1, stats=$2 WHERE id=1`,
    [tipo, JSON.stringify(stats)]
  );

  return { sucesso: true, ...stats };
}

export async function getUltimaSync(): Promise<{ ts: string | null; tipo: string | null; stats: unknown }> {
  const [row] = await query<{ last_sync: string | null; tipo: string | null; stats: unknown }>(
    `SELECT last_sync, tipo, stats FROM sync_state WHERE id=1`
  );
  return { ts: row?.last_sync || null, tipo: row?.tipo || null, stats: row?.stats || null };
}
