import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

export async function POST(req: NextRequest) {
  const { senha } = await req.json().catch(() => ({ senha: '' }));
  const esperado = process.env.PANEL_PASSWORD || '';
  if (!esperado || senha !== esperado) {
    return NextResponse.json({ error: 'Senha incorreta' }, { status: 401 });
  }
  const hash = createHash('sha256').update(esperado).digest('hex');
  const res = NextResponse.json({ ok: true });
  res.cookies.set('painel_auth', hash, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 dias
  });
  return res;
}
