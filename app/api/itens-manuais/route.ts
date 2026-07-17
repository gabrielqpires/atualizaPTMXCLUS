import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { moedaPagamentoCliente } from '@/lib/faturamento';

export async function GET(req: NextRequest) {
  const clienteId = req.nextUrl.searchParams.get('clienteId');
  if (!clienteId) return NextResponse.json({ error: 'clienteId required' }, { status: 400 });
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM itens_manuais WHERE cliente_id = $1 AND num_fatura IS NULL ORDER BY criado_em DESC`,
    [clienteId]
  );
  // Enrich with valor/valor_convertido for frontend
  const enriched = rows.map(r => ({
    ...r,
    valor: (Number(r.valor_frete) || 0) + (Number(r.valor_imposto) || 0),
    valor_convertido: (Number(r.valor_frete) || 0) + (Number(r.valor_imposto) || 0),
  }));
  return NextResponse.json(enriched);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  // Accept either valor (simple) or valorFrete+valorImposto (detailed)
  const { clienteId, pais, tipo, descricao, valor, valorFrete, valorImposto, data, awb, paisDestino, pedido, ddpDdu, obs } = body;
  let vf = Number(valorFrete !== undefined ? (valorFrete || 0) : (valor || 0)) || 0;
  const vi = Number(valorImposto) || 0;
  const id = `MAN_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  // Moeda e país sempre do cadastro do cliente (espelho de createItemManual)
  const [c] = await query<{ pais: string; moeda_pagamento: string | null }>(
    `SELECT pais, moeda_pagamento FROM clientes WHERE cliente_id=$1`, [clienteId]
  );
  const resolvedPais = pais || c?.pais || 'PT';
  const moeda = moedaPagamentoCliente({ moeda_pagamento: c?.moeda_pagamento, pais: resolvedPais });
  // Desconto é gravado negativo, como no Apps Script
  const envio = String(tipo || '').trim().toLowerCase() === 'envio';
  const paisDestinoIso = String(paisDestino || '').trim().toUpperCase() || null;
  if (!envio && String(tipo || '').trim().toLowerCase() === 'desconto') {
    vf = -Math.abs(vf);
  }
  await query(
    `INSERT INTO itens_manuais (item_id,cliente_id,pais,tipo,descricao,valor_frete,valor_imposto,moeda,data,awb,pais_destino,pedido,ddp_ddu,obs,criado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())`,
    [id, clienteId, resolvedPais, tipo, descricao || null, vf, vi,
     moeda, data, awb || null, paisDestinoIso, pedido || null, ddpDdu || null, obs || null]
  );
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get('itemId');
  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 });
  await query(`DELETE FROM itens_manuais WHERE item_id = $1 AND num_fatura IS NULL`, [itemId]);
  return NextResponse.json({ ok: true });
}
