import { NextRequest, NextResponse } from 'next/server';
import {
  carregarTaxasCambio,
  PARES_CAMBIO,
  PARES_CAMBIO_PRINCIPAIS,
  restaurarTaxasCambioPadrao,
  salvarTaxasCambio,
  TAXAS_CAMBIO_PADRAO,
} from '@/lib/cambio';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const taxas = await carregarTaxasCambio(true);
    return NextResponse.json({
      taxas,
      padrao: TAXAS_CAMBIO_PADRAO,
      pares: PARES_CAMBIO,
      principais: PARES_CAMBIO_PRINCIPAIS,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const taxas = body?.reset
      ? await restaurarTaxasCambioPadrao()
      : await salvarTaxasCambio(body?.taxas || {});
    return NextResponse.json({ ok: true, taxas });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
