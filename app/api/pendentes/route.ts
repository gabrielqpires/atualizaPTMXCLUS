import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calcularValores, isStatusRemessaVisivel, normalizarMoeda } from '@/lib/faturamento';
import { round2 } from '@/lib/regras';
import type { Remessa } from '@/lib/types';

// Lista remessas sem ClienteID (não identificadas). Espelho de listRemessasNaoIdentificadas.
export async function GET(req: NextRequest) {
  const pais = req.nextUrl.searchParams.get('pais') || 'PT';
  const rows = await query<Remessa>(
    `SELECT * FROM remessas
     WHERE pais = $1 AND cliente_id IS NULL AND operacao_faturavel = true AND num_fatura IS NULL
     ORDER BY data DESC`,
    [pais]
  );
  const visiveis = rows.filter(r => isStatusRemessaVisivel(r.status_codigo, r.status));
  const enriched = visiveis.map(r => {
    // Sem cliente ainda: moeda de exibição = moeda de cotação (sem conversão), como no Apps Script
    const moeda = normalizarMoeda(r.moeda_cotacao) || 'USD';
    const vals = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moeda, r.imposto_eur, r.imposto_tipo);
    return {
      remessa_id: r.remessa_id,
      awb: r.awb,
      email: r.email_usuario || '',
      pais: r.pais || '',
      contrato_descricao: r.contrato_descricao || '',
      weight: r.weight,
      status: r.status || '',
      data: r.data,
      moeda,
      valor_frete: round2(vals.frete),
      valor_imposto: round2(vals.imposto),
    };
  });
  return NextResponse.json(enriched);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const action = String(body.action || '');

  if (action === 'assign') {
    const { remessaId, clienteId } = body;
    if (!remessaId || !clienteId) return NextResponse.json({ error: 'remessaId e clienteId obrigatorios' }, { status: 400 });
    const [cliente] = await query<{ pais: string; tms: boolean; mor: boolean }>(
      `SELECT pais, tms, mor FROM clientes WHERE cliente_id=$1`, [clienteId]
    );
    if (!cliente) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 });
    // Espelho de assignRemessaCliente: vincula cliente, país, marca faturável e herda flags
    await query(
      `UPDATE remessas
       SET cliente_id=$1, pais=$2, operacao_faturavel=true, vinculado_em=now(),
           tms = tms OR $3, mor = mor OR $4
       WHERE remessa_id=$5`,
      [clienteId, cliente.pais, !!cliente.tms, !!cliente.mor, remessaId]
    );
    return NextResponse.json({ ok: true, pais: cliente.pais });
  }

  if (action === 'ignore') {
    const { awb } = body;
    if (!awb) return NextResponse.json({ error: 'awb obrigatorio' }, { status: 400 });
    // Espelho de ignorarRemessa: marca operacao_faturavel=false (sai da lista de pendentes)
    const res = await query(
      `UPDATE remessas SET operacao_faturavel=false WHERE awb=$1 AND cliente_id IS NULL RETURNING remessa_id`,
      [awb]
    );
    if (!res.length) return NextResponse.json({ error: 'Remessa não encontrada' }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Ação inválida' }, { status: 400 });
}
