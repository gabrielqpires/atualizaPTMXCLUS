import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calcularValores, converterValorManual, inferirGrupo, isEnvioManual, moedaDoPais, normalizarMoeda } from '@/lib/faturamento';
import { aplicarMediaFrete, aplicarRegras, carregarRegras, getTaxaIntercompany, resetCache, round2 } from '@/lib/regras';
import type { Remessa, ItemManual, FaturaFechada } from '@/lib/types';

export async function GET(req: NextRequest) {
  const faturaId = req.nextUrl.searchParams.get('faturaId');
  if (!faturaId) return NextResponse.json({ error: 'faturaId required' }, { status: 400 });

  const [fat] = await query<FaturaFechada>(
    `SELECT * FROM faturamentos_fechados WHERE fatura_id=$1`, [faturaId]
  );
  if (!fat) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 });

  const pais = fat.pais || 'PT';
  const clienteId = fat.cliente_id;
  const moedaFat = normalizarMoeda(fat.moeda) || moedaDoPais(pais);
  const numFatura = fat.num_fatura || fat.fatura_id;
  const remessaIds = String(fat.remessa_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const itemIds = String(fat.item_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  resetCache(pais);
  const regras = await carregarRegras(pais);

  // Espelho do Apps Script: a remessa pertence à fatura por remessa_id
  // (gravado no fechamento) OU por num_fatura+cliente — cobre faturas reabertas.
  const remessas = await query<Remessa>(
    `SELECT * FROM remessas
     WHERE remessa_id = ANY($1::text[]) OR (num_fatura=$2 AND cliente_id=$3)
     ORDER BY data`,
    [remessaIds, numFatura, clienteId]
  );

  const itens = itemIds.length
    ? await query<ItemManual>(
        `SELECT * FROM itens_manuais WHERE item_id = ANY($1::text[]) ORDER BY criado_em`,
        [itemIds]
      )
    : await query<ItemManual>(
        `SELECT * FROM itens_manuais WHERE num_fatura=$1 AND cliente_id=$2 ORDER BY criado_em`,
        [numFatura, clienteId]
      );

  // Passo 1: valores + regras por remessa
  const remWorkItems = remessas.map(r => {
    const ctx = {
      clienteId,
      weightKg: r.weight || 0,
      paisOrigem: String(r.pais || pais),
      paisDestino: r.destination || '',
      contratoDescricao: r.contrato_descricao || '',
    };
    const raw = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moedaFat, r.imposto_eur, r.imposto_tipo);
    const ruled = aplicarRegras(raw, ctx, regras);
    return { r, valores: { frete: ruled.frete, imposto: ruled.imposto }, contexto: ctx };
  });

  // Passo 2: equaliza fretes elegíveis à média (markup_media_frete)
  if (remWorkItems.length > 0) {
    aplicarMediaFrete(clienteId, remWorkItems, regras);
  }

  const enrichedRemessas = remWorkItems.map(({ r, valores }) => ({
    remessa_id: r.remessa_id,
    awb: r.awb,
    order_id: r.order_id || null,
    destination: r.destination || null,
    grupo: r.grupo || null,
    weight: r.weight,
    contrato_descricao: r.contrato_descricao,
    status: r.status,
    imposto_tipo: r.imposto_tipo || null,
    data: r.data,
    valor_frete: round2(valores.frete),
    valor_imposto: round2(valores.imposto),
    moeda: moedaFat,
    tipo: 'remessa',
  }));

  // Itens manuais tipo envio entram na seção de remessas; ajustes na seção própria
  const enrichedEnviosManuais = itens
    .filter(i => isEnvioManual(i))
    .map(i => {
      const vf = converterValorManual(i.valor_frete, i.moeda, moedaFat);
      const vi = converterValorManual(i.valor_imposto, i.moeda, moedaFat);
      return {
        remessa_id: i.item_id,
        awb: i.awb || i.descricao || '—',
        order_id: i.pedido || null,
        destination: i.pais_destino || null,
        grupo: inferirGrupo(i.pais_destino) || null,
        weight: null,
        contrato_descricao: i.descricao || null,
        status: null,
        imposto_tipo: i.ddp_ddu || null,
        data: i.data,
        valor_frete: round2(vf),
        valor_imposto: round2(vi),
        moeda: moedaFat,
        isManual: true,
      };
    });

  const enrichedItens = itens
    .filter(i => !isEnvioManual(i))
    .map(i => {
      const vf = converterValorManual(i.valor_frete, i.moeda, moedaFat);
      const vi = converterValorManual(i.valor_imposto, i.moeda, moedaFat);
      return {
        item_id: i.item_id,
        descricao: i.descricao,
        tipo_ajuste: i.tipo,
        data: i.data,
        valor: round2(vf + vi),
        moeda: moedaFat,
      };
    });

  // Resumo recalculado (taxa intercompany sobre frete+imposto+manual, como o Excel)
  let totFrete = 0, totImposto = 0;
  for (const r of enrichedRemessas) {
    totFrete += r.valor_frete;
    if (!(pais === 'PT' && r.grupo === 'EU')) totImposto += r.valor_imposto;
  }
  for (const e of enrichedEnviosManuais) {
    totFrete += e.valor_frete;
    totImposto += e.valor_imposto;
  }
  const totManual = enrichedItens.reduce((s, i) => s + i.valor, 0);
  const taxaPct = getTaxaIntercompany(clienteId, regras);
  const base = round2(totFrete) + round2(totImposto) + round2(totManual);
  const taxa = taxaPct > 0 ? round2(base * taxaPct / 100) : 0;
  const resumo = {
    valor_frete: round2(totFrete),
    valor_imposto: round2(totImposto),
    valor_manual: round2(totManual),
    taxa_pct: taxaPct,
    taxa_intercompany: taxa,
    valor_total: round2(base + taxa),
    moeda: moedaFat,
  };

  return NextResponse.json({ remessas: [...enrichedRemessas, ...enrichedEnviosManuais], itens: enrichedItens, resumo });
}
