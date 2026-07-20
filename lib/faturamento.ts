import { query } from './db';
import { Remessa, ItemManual, ResumoCliente, Cliente } from './types';
import { aplicarRegras, getTaxaIntercompany, round2, carregarRegras } from './regras';
import { formatDateIsoLocal } from './dates';
export { inferirGrupo } from './grupo';

// ── Moedas e câmbio (espelho de Faturamento.gs) ─────────────

export function moedaDoPais(pais: string): string {
  if (pais === 'PT') return 'EUR';
  if (pais === 'MX') return 'MXN';
  return 'USD';
}

export function normalizarMoeda(value: string | null | undefined): string {
  const cur = String(value || '').trim().toUpperCase();
  if (cur === 'EURO') return 'EUR';
  if (cur === 'DOLAR' || cur === 'DOLLAR') return 'USD';
  if (cur === 'PESO' || cur === 'PESO MEXICANO') return 'MXN';
  return cur;
}

export function moedaPagamentoCliente(cliente: { moeda_pagamento?: string | null; pais?: string | null } | null | undefined): string {
  if (!cliente) return 'USD';
  return normalizarMoeda(cliente.moeda_pagamento || moedaDoPais(cliente.pais || ''));
}

// Igual a TAXAS_CAMBIO_PADRAO_ do Apps Script
const TAXAS_CAMBIO: Record<string, number> = {
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

export function converterMoeda(
  valor: number | string | null | undefined,
  moedaOrigem: string | null | undefined,
  moedaDestino: string | null | undefined
): number {
  const amount = Number(valor) || 0;
  const from = normalizarMoeda(moedaOrigem);
  const to = normalizarMoeda(moedaDestino);
  if (!from || !to || from === to) return amount;
  const rate = TAXAS_CAMBIO[`${from}>${to}`];
  return rate ? amount * rate : amount;
}

// Espelho de calcularValoresPorPais_: converte o frete da moeda de cotação
// para a moeda de pagamento; imposto zera apenas para 'receiver'.
export function calcularValores(
  freteUsd: number,
  impostoOriginal: number,
  moedaCotacao: string,
  moedaPagamento: string,
  _impostoEur: number,
  impostoTipo: string
): { frete: number; imposto: number } {
  const freteBase = Number(freteUsd) || 0;
  const impostoBase = Number(impostoOriginal) || 0;
  const moedaOriginal = normalizarMoeda(moedaCotacao || moedaPagamento);
  const moedaDestino = normalizarMoeda(moedaPagamento || moedaOriginal || 'USD');
  const tipo = String(impostoTipo || '').toLowerCase();
  const frete = converterMoeda(freteBase, moedaOriginal, moedaDestino);
  const imposto = tipo === 'receiver' ? 0 : converterMoeda(impostoBase, moedaOriginal, moedaDestino);
  return { frete, imposto };
}

// Espelho de isStatusRemessaVisivel_: código 5-11 ou 14 visível; sem código, esconde cancelled.
export function isStatusRemessaVisivel(
  statusCodigo: string | number | null | undefined,
  statusNome: string | null | undefined
): boolean {
  const code = Number(statusCodigo);
  if (!isNaN(code) && code > 0) return (code >= 5 && code <= 11) || code === 14;
  const name = String(statusNome || '').trim().toLowerCase();
  if (!name) return true;
  return name !== 'cancelled' && name !== 'canceled';
}

export function isEnvioManual(item: ItemManual): boolean {
  const tipo = (item.tipo || '').toLowerCase();
  return tipo === 'envio' || !!item.awb;
}

export function converterValorManual(valor: number | null, moedaItem: string, moedaFat: string): number {
  return converterMoeda(valor, moedaItem || moedaFat, moedaFat);
}

export async function calcularResumo(pais: string): Promise<ResumoCliente[]> {
  const regras = await carregarRegras(pais);

  const clientes = await query<Cliente>(
    `SELECT * FROM clientes WHERE pais = $1 ORDER BY nome`, [pais]
  );
  const moedaByCliente: Record<string, string> = {};
  for (const c of clientes) moedaByCliente[c.cliente_id] = moedaPagamentoCliente(c);

  const remessasAll = await query<Remessa>(
    `SELECT * FROM remessas WHERE pais = $1 AND operacao_faturavel = true AND num_fatura IS NULL`,
    [pais]
  );
  const remessas = remessasAll.filter(r => isStatusRemessaVisivel(r.status_codigo, r.status));

  const itens = await query<ItemManual>(
    `SELECT * FROM itens_manuais WHERE pais = $1 AND num_fatura IS NULL`,
    [pais]
  );

  type Acc = {
    qtdAwbs: number; frete: number; imposto: number; manual: number;
    moeda: string; janela_inicio: string | null; janela_fim: string | null;
  };

  const byCliente: Record<string, Acc> = {};
  const accFor = (clienteId: string): Acc => {
    if (!byCliente[clienteId]) {
      byCliente[clienteId] = {
        qtdAwbs: 0, frete: 0, imposto: 0, manual: 0,
        moeda: moedaByCliente[clienteId] || moedaDoPais(pais),
        janela_inicio: null, janela_fim: null,
      };
    }
    return byCliente[clienteId];
  };

  for (const r of remessas) {
    const acc = accFor(r.cliente_id);
    let vals = calcularValores(
      r.frete_usd, r.imposto_original, r.moeda_cotacao,
      acc.moeda, r.imposto_eur, r.imposto_tipo
    );
    vals = aplicarRegras(vals, {
      clienteId: r.cliente_id,
      weightKg: r.weight || 0,
      paisOrigem: pais,
      paisDestino: r.destination || '',
      contratoDescricao: r.contrato_descricao || '',
    }, regras);

    acc.qtdAwbs++;
    acc.frete += vals.frete;
    if (!(pais === 'PT' && r.grupo === 'EU')) acc.imposto += vals.imposto;
    const raw: unknown = r.data;
    const d = raw ? formatDateIsoLocal(raw instanceof Date ? raw : String(raw)) : null;
    if (d) {
      if (!acc.janela_inicio || d < acc.janela_inicio) acc.janela_inicio = d;
      if (!acc.janela_fim || d > acc.janela_fim) acc.janela_fim = d;
    }
  }

  for (const item of itens) {
    const acc = accFor(item.cliente_id);
    const vf = converterValorManual(item.valor_frete, item.moeda, acc.moeda);
    const vi = converterValorManual(item.valor_imposto, item.moeda, acc.moeda);
    let val = vf + vi;
    const tipo = (item.tipo || '').toLowerCase();
    if (tipo === 'desconto') val = -Math.abs(val);
    if (isEnvioManual(item)) {
      acc.qtdAwbs++;
      acc.frete += vf;
      acc.imposto += vi;
    } else {
      acc.manual += val;
    }
  }

  return clientes
    .map(c => {
      const acc = byCliente[c.cliente_id] || {
        qtdAwbs: 0, frete: 0, imposto: 0, manual: 0,
        moeda: moedaByCliente[c.cliente_id] || moedaDoPais(pais),
        janela_inicio: null, janela_fim: null,
      };
      const taxaPct = getTaxaIntercompany(c.cliente_id, regras);
      const base = round2(acc.frete) + round2(acc.imposto) + round2(acc.manual);
      const taxa = taxaPct > 0 ? round2(base * taxaPct / 100) : 0;
      return {
        ...c,
        qtd_awbs: acc.qtdAwbs,
        valor_frete: round2(acc.frete),
        valor_imposto: round2(acc.imposto),
        valor_manual: round2(acc.manual),
        taxa_intercompany_pct: taxaPct,
        taxa_intercompany: taxa,
        valor_total: round2(base + taxa),
        moeda: acc.moeda,
        janela_inicio: acc.janela_inicio,
        janela_fim: acc.janela_fim,
      };
    })
    .filter(c => c.qtd_awbs > 0 || Math.abs(c.valor_manual) > 0 || Math.abs(c.valor_total) > 0);
}
