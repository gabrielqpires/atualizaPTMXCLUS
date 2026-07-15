import { NextResponse } from 'next/server';
import { getUltimaSync } from '@/lib/metabase';

export const dynamic = 'force-dynamic';

// Última sincronização — usado pela notificação no painel
export async function GET() {
  try {
    const d = await getUltimaSync();
    return NextResponse.json(d);
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
