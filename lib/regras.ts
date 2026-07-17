import { query } from './db';
import { RegraFaturamento } from './types';

// Cache por execução (equivalente ao _cacheRegras do Apps Script)
let _cache: Record<string, RegraFaturamento[]> | null = null;

export async function carregarRegras(pais: string): Promise<Record<string, RegraFaturamento[]>> {
  if (_cache) return _cache;
  const rows = await query<RegraFaturamento>(
    `SELECT rf.* FROM regras_faturamento rf
     JOIN clientes c ON c.cliente_id = rf.cliente_id
     WHERE c.pais = $1`, [pais]
  );
  const mapa: Record<string, RegraFaturamento[]> = {};
  for (const r of rows) {
    if (!mapa[r.cliente_id]) mapa[r.cliente_id] = [];
    mapa[r.cliente_id].push(r);
  }
  _cache = mapa;
  return mapa;
}

export function resetCache() { _cache = null; }

// Tabela FedEx Zone 4 — [weightKg, precoUSD]
const FEDEX_ZONE4: [number, number][] = [
  [0.453515,8.20],[0.907029,8.99],[1.360544,9.15],[1.814059,9.11],[2.267574,9.52],
  [2.721088,10.00],[3.174603,12.74],[3.628118,13.58],[4.081633,14.47],[4.535147,13.67],
  [4.988662,15.58],[5.442177,15.74],[5.895692,15.79],[6.349206,16.08],[6.802721,16.31],
  [7.256236,17.11],[7.709751,17.29],[8.163265,17.47],[8.616780,18.37],[9.070295,18.38],
  [9.523810,21.53],[9.977324,22.29],[10.430839,22.81],[10.884354,23.96],[11.337868,24.06],
  [11.791383,25.06],[12.244898,25.55],[12.698413,26.56],[13.151927,26.79],[13.605442,27.81],
  [14.058957,28.40],[14.512472,28.42],[14.965986,29.68],[15.419501,30.64],[15.873016,31.40],
  [16.326531,40.21],[16.780045,40.55],[17.233560,41.57],[17.687075,42.99],[18.140590,42.99],
  [18.594104,44.02],[19.047619,45.40],[19.501134,45.45],[19.954649,46.40],[20.408163,46.43],
  [20.861678,47.63],[21.315193,48.26],[21.768707,48.72],[22.222222,48.73],[22.675737,48.75],
  [23.129252,59.86],[23.582766,59.89],[24.036281,59.89],[24.489796,59.99],[24.943311,60.00],
  [25.396825,60.01],[25.850340,60.03],[26.303855,60.04],[26.757370,60.40],[27.210884,61.30],
  [27.664399,61.80],[28.117914,62.68],[28.571429,63.20],[29.024943,63.68],[29.478458,63.69],
  [29.931973,64.12],[30.385488,64.14],[30.839002,67.52],[31.292517,68.11],[31.746032,68.95],
];

export function buscarPrecoFedex(weightKg: number): number {
  if (!weightKg || weightKg <= 0) return 0;
  for (const [w, p] of FEDEX_ZONE4) {
    if (weightKg <= w) return p;
  }
  return FEDEX_ZONE4[FEDEX_ZONE4.length - 1][1];
}

export function getTaxaIntercompany(clienteId: string, regras: Record<string, RegraFaturamento[]>): number {
  const lista = regras[clienteId] || [];
  for (const r of lista) {
    if (r.tipo_regra === 'taxa_intercompany') {
      const pct = Number((r.params as Record<string, number>).pct || 0);
      return pct > 0 ? pct : 0;
    }
  }
  return 0;
}

export interface ValoresRemessa { frete: number; imposto: number; }
export interface ContextoRemessa {
  clienteId: string;
  weightKg: number;
  paisOrigem: string;
  paisDestino: string;
  contratoDescricao: string;
}

// Elegibilidade do markup_media_frete:
// - params.contratoExato → contrato_descricao idêntico (ex.: regra SweetCare
//   "[Shipsmart PT] FEDEX CP SweetCare Partner 2026"); maxKg opcional
// - legado (sem contratoExato) → contrato contém 'fedex' e peso <= maxKg (2.5)
export function elegivelMediaFrete(ctx: ContextoRemessa, p: Record<string, unknown>): boolean {
  if (p.contratoExato) {
    if (ctx.contratoDescricao.trim() !== String(p.contratoExato).trim()) return false;
    if (p.maxKg != null && Number(ctx.weightKg) > Number(p.maxKg)) return false;
    return true;
  }
  const maxKg = p.maxKg != null ? Number(p.maxKg) : 2.5;
  const isFedex = ctx.contratoDescricao.toLowerCase().includes('fedex');
  return Number(ctx.weightKg) <= maxKg && isFedex;
}

export function aplicarRegras(
  valores: ValoresRemessa,
  ctx: ContextoRemessa,
  regras: Record<string, RegraFaturamento[]>
): ValoresRemessa {
  const lista = regras[ctx.clienteId] || [];
  for (const r of lista) {
    const p = r.params as Record<string, unknown>;
    const origemOk = !p.origemPais || p.origemPais === ctx.paisOrigem;
    const destinoOk = !p.destinoPais || p.destinoPais === ctx.paisDestino;
    if (!origemOk || !destinoOk) continue;

    if (r.tipo_regra === 'tabela_fedex') {
      const preco = buscarPrecoFedex(ctx.weightKg);
      if (preco > 0) valores = { ...valores, frete: round2(preco) };
    }
    if (r.tipo_regra === 'zerar_imposto') {
      valores = { ...valores, imposto: 0 };
    }
    if (r.tipo_regra === 'markup_media_frete') {
      const markup = p.markup != null ? Number(p.markup) : 0;
      if (elegivelMediaFrete(ctx, p)) {
        valores = { ...valores, frete: round2(valores.frete * (1 + markup)) };
      }
    }
  }
  return valores;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Equaliza fretes dos itens elegíveis à média — equivalente a aplicarMediaFrete_ do Apps Script.
// Chamado após aplicarRegras em todos os itens de um cliente.
export function aplicarMediaFrete(
  clienteId: string,
  items: Array<{ valores: ValoresRemessa; contexto: ContextoRemessa }>,
  regras: Record<string, RegraFaturamento[]>
): void {
  const lista = regras[clienteId] || [];
  for (const r of lista) {
    if (r.tipo_regra !== 'markup_media_frete') continue;
    const p = r.params as Record<string, unknown>;
    const elegiveis = items.filter(it => elegivelMediaFrete(it.contexto, p));
    if (!elegiveis.length) continue;
    const soma = elegiveis.reduce((acc, it) => acc + it.valores.frete, 0);
    const media = round2(soma / elegiveis.length);
    for (const it of elegiveis) {
      it.valores.frete = media;
    }
  }
}
