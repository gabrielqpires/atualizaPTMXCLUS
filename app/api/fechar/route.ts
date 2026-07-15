import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calcularResumo, isStatusRemessaVisivel } from '@/lib/faturamento';
import { resetCache } from '@/lib/regras';

export async function POST(req: NextRequest) {
  const { clienteId, pais, nomeCliente, fechadoPor } = await req.json();
  if (!clienteId || !pais) return NextResponse.json({ error: 'clienteId e pais obrigatorios' }, { status: 400 });

  resetCache();
  const resumos = await calcularResumo(pais);
  const resumo = resumos.find(r => r.cliente_id === clienteId);
  if (!resumo) return NextResponse.json({ error: 'Cliente sem remessas para fechar' }, { status: 400 });

  // Remessas em aberto — só entram na fatura as com status visível (espelho do Apps Script)
  const remessasAll = await query<{ remessa_id: string; status: string; status_codigo: string }>(
    `SELECT remessa_id, status, status_codigo FROM remessas
     WHERE cliente_id=$1 AND operacao_faturavel=true AND num_fatura IS NULL`,
    [clienteId]
  );
  const remessas = remessasAll.filter(r => isStatusRemessaVisivel(r.status_codigo, r.status));
  const itens = await query<{ item_id: string }>(
    `SELECT item_id FROM itens_manuais WHERE cliente_id=$1 AND num_fatura IS NULL`, [clienteId]
  );

  // Ultimo faturamento anterior (para restaurar no reabrir)
  const [ult] = await query<{ data_fechamento: string }>(
    `SELECT data_fechamento FROM faturamentos_fechados WHERE cliente_id=$1 ORDER BY data_fechamento DESC LIMIT 1`,
    [clienteId]
  );

  // Espelho de gerarNumFatura_: sequência POR CLIENTE (conta faturas do cliente)
  const [cnt] = await query<{ total: string }>(
    `SELECT COUNT(*) as total FROM faturamentos_fechados WHERE cliente_id=$1`, [clienteId]
  );
  const seq = String(Number(cnt?.total || 0) + 1).padStart(3, '0');
  const numFatura = `SS-${pais}-${seq}`;

  const faturaId = `FAT_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const remessaIdList = remessas.map(r => r.remessa_id);
  const itemIdList = itens.map(i => i.item_id);
  const remessaIds = remessaIdList.join(',');
  const itemIds = itemIdList.length ? itemIdList.join(',') : null;

  await query(`BEGIN`);
  try {
    await query(
      `INSERT INTO faturamentos_fechados (fatura_id,cliente_id,pais,nome_cliente,data_fechamento,ultimo_faturamento_anterior,qtd_awbs,valor_frete,valor_imposto,valor_manual,valor_total,moeda,remessa_ids,item_ids,status,criado_em,num_fatura,fechado_por)
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12,$13,'fechado',now(),$14,$15)`,
      [faturaId, clienteId, pais, nomeCliente || resumo.nome,
       ult?.data_fechamento || null, resumo.qtd_awbs,
       resumo.valor_frete, resumo.valor_imposto, resumo.valor_manual, resumo.valor_total,
       resumo.moeda, remessaIds, itemIds, numFatura, fechadoPor || null]
    );
    if (remessaIdList.length) {
      await query(`UPDATE remessas SET num_fatura=$1 WHERE remessa_id = ANY($2::text[])`, [numFatura, remessaIdList]);
    }
    if (itemIdList.length) {
      await query(`UPDATE itens_manuais SET num_fatura=$1 WHERE item_id = ANY($2::text[])`, [numFatura, itemIdList]);
    }
    await query(`UPDATE clientes SET ultimo_faturamento=now() WHERE cliente_id=$1`, [clienteId]);
    await query(`COMMIT`);
  } catch (e) {
    await query(`ROLLBACK`);
    throw e;
  }

  return NextResponse.json({ ok: true, faturaId, numFatura });
}
