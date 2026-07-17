import { NextRequest, NextResponse } from 'next/server';
import { syncRemessasDoMetabase } from '@/lib/metabase';

export const dynamic = 'force-dynamic';
// Sync completo pode passar de 60s quando o Metabase está lento (Fluid Compute
// no plano Hobby permite até 300s)
export const maxDuration = 300;

function autorizado(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // sem secret configurado, não bloqueia (dev)
  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return true; // Vercel Cron manda esse header
  if (req.nextUrl.searchParams.get('secret') === secret) return true; // trigger externo
  return false;
}

// GET → gatilho do cron (Vercel Cron ou trigger externo a cada 10 min)
export async function GET(req: NextRequest) {
  if (!autorizado(req)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  try {
    const res = await syncRemessasDoMetabase('automatico');
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

// POST → sync manual (botão "Sincronizar" no painel)
export async function POST() {
  try {
    const res = await syncRemessasDoMetabase('manual');
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
