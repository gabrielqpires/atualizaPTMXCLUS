import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calcularValores, isStatusRemessaVisivel, moedaPagamentoCliente } from '@/lib/faturamento';
import { aplicarMediaFrete, aplicarRegras, carregarRegras, round2 } from '@/lib/regras';
import type { Remessa } from '@/lib/types';

export async function GET(req: NextRequest) {
  const clienteId = req.nextUrl.searchParams.get('clienteId');
  if (!clienteId) return NextResponse.json({ error: 'clienteId required' }, { status: 400 });
  try {
    const rowsAll = await query<Remessa & { _pais: string; _moeda_pagamento: string | null }>(
      `SELECT r.*, c.pais as _pais, c.moeda_pagamento as _moeda_pagamento
       FROM remessas r JOIN clientes c ON c.cliente_id=r.cliente_id
       WHERE r.cliente_id=$1 AND r.operacao_faturavel=true AND r.num_fatura IS NULL
       ORDER BY r.data DESC`,
      [clienteId]
    );
    // Espelho do Apps Script: só remessas com status visível entram na janela
    const rows = rowsAll.filter(r => isStatusRemessaVisivel(r.status_codigo, r.status));
    if (!rows.length) return NextResponse.json([]);

    const pais = rows[0]._pais || 'PT';
    const moedaFat = moedaPagamentoCliente({ moeda_pagamento: rows[0]._moeda_pagamento, pais });
    const regras = await carregarRegras(pais);

    // Passo 1: valores + regras por remessa
    const workItems = rows.map(r => {
      const ctx = {
        clienteId: r.cliente_id,
        weightKg: r.weight || 0,
        paisOrigem: pais,
        paisDestino: r.destination || '',
        contratoDescricao: r.contrato_descricao || '',
      };
      const raw = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moedaFat, r.imposto_eur, r.imposto_tipo);
      const ruled = aplicarRegras(raw, ctx, regras);
      return { r, valores: { frete: ruled.frete, imposto: ruled.imposto }, contexto: ctx };
    });

    // Passo 2: equaliza fretes elegíveis à média (markup_media_frete)
    if (workItems.length > 0) {
      aplicarMediaFrete(clienteId, workItems, regras);
    }

    const enriched = workItems.map(({ r, valores }) => ({
      remessa_id: r.remessa_id,
      awb: r.awb,
      order_id: r.order_id || null,
      destination: r.destination || null,
      grupo: r.grupo || null,
      weight: r.weight,
      contrato_descricao: r.contrato_descricao,
      status: r.status,
      imposto_tipo: r.imposto_tipo || null,
      gateway_pagamento: r.gateway_pagamento || null,
      data: r.data,
      valor_frete: round2(valores.frete),
      valor_imposto: round2(valores.imposto),
      valor_total: round2(valores.frete + valores.imposto),
      moeda: moedaFat,
    }));

    return NextResponse.json(enriched);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
