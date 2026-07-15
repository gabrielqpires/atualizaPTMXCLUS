import { NextRequest, NextResponse } from 'next/server';

// Proteção por senha do painel inteiro (páginas + APIs).
// - /login e /api/login: públicos (fluxo de autenticação)
// - /api/sync (GET do cron): público, protegido pelo próprio CRON_SECRET
// - Sem PANEL_PASSWORD configurado (dev local): não bloqueia nada
const PUBLIC_EXACT = new Set(['/login', '/api/login', '/api/sync']);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_EXACT.has(pathname)) return NextResponse.next();

  const senha = process.env.PANEL_PASSWORD;
  if (!senha) return NextResponse.next();

  const cookie = req.cookies.get('painel_auth')?.value;
  if (cookie && cookie === (await sha256(senha))) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
