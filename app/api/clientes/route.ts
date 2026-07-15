import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const pais = req.nextUrl.searchParams.get('pais');
  // Sem país (?pais= vazio ou ausente com all=1) → todos os clientes
  const todos = req.nextUrl.searchParams.get('all') === '1' || pais === '';
  if (todos) {
    const rows = await query(`SELECT * FROM clientes ORDER BY nome`);
    return NextResponse.json(rows);
  }
  const rows = await query(`SELECT * FROM clientes WHERE pais = $1 ORDER BY nome`, [pais || 'PT']);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { nome, emailsUsuario, emailsContato, pais, regime, diasVencimento, tms, mor } = body;
  const id = `LOCAL_CLI_${Date.now()}`;
  const moeda = pais === 'PT' ? 'EUR' : 'USD';
  await query(
    `INSERT INTO clientes (cliente_id,nome,emails_usuario,emails_contato,pais,regime,dias_vencimento,tms,mor,moeda_pagamento,data_cadastro)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
    [id, nome, emailsUsuario, emailsContato || null, pais, regime, diasVencimento || 7,
     tms || false, mor || false, moeda]
  );
  return NextResponse.json({ ok: true, id });
}
