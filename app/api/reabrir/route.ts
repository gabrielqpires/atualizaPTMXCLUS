import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import type { FaturaFechada } from '@/lib/types';

export async function POST(req: NextRequest) {
  const { faturaId } = await req.json();
  if (!faturaId) return NextResponse.json({ error: 'faturaId obrigatorio' }, { status: 400 });

  const [fat] = await query<FaturaFechada>(
    `SELECT * FROM faturamentos_fechados WHERE fatura_id=$1`, [faturaId]
  );
  if (!fat) return NextResponse.json({ error: 'Fatura não encontrada' }, { status: 404 });

  const remessaIds = String(fat.remessa_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const itemIds = String(fat.item_ids || '').split(',').map(s => s.trim()).filter(Boolean);

  await query(`BEGIN`);
  try {
    await query(`UPDATE faturamentos_fechados SET status='reaberto', reaberto_em=now() WHERE fatura_id=$1`, [faturaId]);
    // Espelho do Apps Script: limpa num_fatura apenas das remessas/itens DESTA fatura
    // (num_fatura é compartilhado entre clientes — nunca limpar globalmente)
    if (remessaIds.length) {
      await query(`UPDATE remessas SET num_fatura=NULL WHERE remessa_id = ANY($1::text[])`, [remessaIds]);
    }
    if (itemIds.length) {
      await query(`UPDATE itens_manuais SET num_fatura=NULL WHERE item_id = ANY($1::text[])`, [itemIds]);
    }
    if (fat.num_fatura) {
      // Fallback escopado ao cliente para faturas antigas sem ids gravados
      await query(`UPDATE remessas SET num_fatura=NULL WHERE num_fatura=$1 AND cliente_id=$2`, [fat.num_fatura, fat.cliente_id]);
      await query(`UPDATE itens_manuais SET num_fatura=NULL WHERE num_fatura=$1 AND cliente_id=$2`, [fat.num_fatura, fat.cliente_id]);
    }
    // Restaura o último faturamento anterior do cliente (como o Apps Script)
    await query(`UPDATE clientes SET ultimo_faturamento=$1 WHERE cliente_id=$2`, [fat.ultimo_faturamento_anterior || null, fat.cliente_id]);
    await query(`COMMIT`);
  } catch (e) {
    await query(`ROLLBACK`);
    throw e;
  }

  return NextResponse.json({ ok: true });
}
