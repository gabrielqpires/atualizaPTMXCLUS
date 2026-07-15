import { NextRequest, NextResponse } from 'next/server';
import { calcularResumo } from '@/lib/faturamento';
import { resetCache } from '@/lib/regras';

export async function GET(req: NextRequest) {
  const pais = req.nextUrl.searchParams.get('pais') || 'PT';
  try {
    resetCache();
    const data = await calcularResumo(pais);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
