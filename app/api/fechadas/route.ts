import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const pais = req.nextUrl.searchParams.get('pais') || 'PT';
  const limit = Number(req.nextUrl.searchParams.get('limit') || 50);
  const offset = Number(req.nextUrl.searchParams.get('offset') || 0);
  // Espelho do Apps Script: faturas reabertas não aparecem na lista
  const where = pais
    ? `WHERE pais = $1 AND status IS DISTINCT FROM 'reaberto'`
    : `WHERE status IS DISTINCT FROM 'reaberto'`;
  const countParams: unknown[] = pais ? [pais] : [];
  const [countRow] = await query<{ total: string }>(
    `SELECT COUNT(*) as total FROM faturamentos_fechados ${where}`,
    countParams
  );
  const total = Number(countRow?.total || 0);
  const params: unknown[] = pais ? [pais, limit, offset] : [limit, offset];
  const faturas = await query(
    `SELECT * FROM faturamentos_fechados ${where} ORDER BY data_fechamento DESC LIMIT $${pais ? 2 : 1} OFFSET $${pais ? 3 : 2}`,
    params
  );
  return NextResponse.json({ faturas, total });
}
