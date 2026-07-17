import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

// Espelho de desvinularRemessa: tira a remessa do cliente (cliente_id/vinculado_em
// NULL) mantendo-a faturável, então ela volta para "não identificadas" e sai da
// fatura em andamento. Depois pode ser reatribuída (próxima janela).
// Não permite desvincular remessa já faturada (num_fatura preenchido).
export async function POST(req: NextRequest) {
  const { remessaId } = await req.json();
  if (!remessaId) return NextResponse.json({ error: 'remessaId obrigatorio' }, { status: 400 });

  const res = await query<{ remessa_id: string }>(
    `UPDATE remessas
     SET cliente_id = NULL, vinculado_em = NULL, operacao_faturavel = true
     WHERE remessa_id = $1 AND num_fatura IS NULL
     RETURNING remessa_id`,
    [remessaId]
  );
  if (!res.length) {
    return NextResponse.json({ error: 'Remessa não encontrada ou já faturada' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
