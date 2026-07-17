import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { moedaDoPais, normalizarMoeda } from '@/lib/faturamento';

type ClienteInput = {
  nome?: unknown;
  emailsUsuario?: unknown;
  emails_usuario?: unknown;
  emailsContato?: unknown;
  emails_contato?: unknown;
  intermediarioCobranca?: unknown;
  intermediario_cobranca?: unknown;
  pais?: unknown;
  regime?: unknown;
  diasVencimento?: unknown;
  dias_vencimento?: unknown;
  moedaPagamento?: unknown;
  moeda_pagamento?: unknown;
  tms?: unknown;
  mor?: unknown;
};

function normalizarEmails(value: unknown): string {
  const emails = String(value || '')
    .split(/[,\n;]/)
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(emails)).join(', ');
}

function toBoolean(value: unknown): boolean {
  if (value === true) return true;
  const text = String(value || '').trim().toLowerCase();
  return text === 'true' || text === 'sim' || text === '1' || text === 'yes';
}

function parseCliente(input: ClienteInput, paisPadrao: string) {
  const pais = String(input.pais || paisPadrao || 'PT').trim().toUpperCase();
  const nome = String(input.nome || '').trim();
  const emailsUsuario = normalizarEmails(input.emailsUsuario ?? input.emails_usuario);
  const emailsContato = normalizarEmails(input.emailsContato ?? input.emails_contato);
  const intermediarioCobranca = normalizarEmails(input.intermediarioCobranca ?? input.intermediario_cobranca);
  const regime = String(input.regime || 'quinzenal').trim() || 'quinzenal';
  const diasVencimento = Number(input.diasVencimento ?? input.dias_vencimento) || 5;
  const moedaRaw = input.moedaPagamento ?? input.moeda_pagamento ?? moedaDoPais(pais);
  const moedaPagamento = normalizarMoeda(String(moedaRaw || moedaDoPais(pais)).trim());
  return {
    nome,
    emailsUsuario,
    emailsContato,
    intermediarioCobranca,
    pais,
    regime,
    diasVencimento,
    moedaPagamento,
    tms: toBoolean(input.tms),
    mor: toBoolean(input.mor),
  };
}

async function atribuirRemessasPorEmails(
  emailsUsuario: string,
  clienteId: string,
  pais: string,
  tms: boolean,
  mor: boolean
): Promise<number> {
  const emails = normalizarEmails(emailsUsuario).split(',').map(e => e.trim()).filter(Boolean);
  if (!emails.length) return 0;
  const rows = await query<{ remessa_id: string }>(
    `UPDATE remessas
        SET cliente_id=$1,
            pais=$2,
            vinculado_em=COALESCE(vinculado_em, now()),
            tms = tms OR $3,
            mor = mor OR $4
      WHERE cliente_id IS NULL
        AND num_fatura IS NULL
        AND lower(coalesce(email_usuario, '')) = ANY($5::text[])
      RETURNING remessa_id`,
    [clienteId, pais, tms, mor, emails]
  );
  return rows.length;
}

async function normalizarFlagsRemessasCliente(clienteId: string, tms: boolean, mor: boolean) {
  if (!tms && !mor) return;
  await query(
    `UPDATE remessas
        SET tms = tms OR $2,
            mor = mor OR $3
      WHERE cliente_id=$1`,
    [clienteId, tms, mor]
  );
}

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
  const pais = String(body.pais || 'PT').trim().toUpperCase();

  if (Array.isArray(body.clientes)) {
    let totalClientes = 0;
    let remessasAtribuidas = 0;
    for (const raw of body.clientes as ClienteInput[]) {
      const cliente = parseCliente({ ...raw, pais }, pais);
      if (!cliente.nome || !cliente.emailsUsuario) continue;
      const id = `LOCAL_CLI_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      await query(
        `INSERT INTO clientes (
          cliente_id,nome,emails_usuario,emails_contato,intermediario_cobranca,
          pais,regime,dias_vencimento,data_cadastro,tms,mor,moeda_pagamento
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,current_date,$9,$10,$11)`,
        [id, cliente.nome, cliente.emailsUsuario, cliente.emailsContato || null, cliente.intermediarioCobranca || null,
         cliente.pais, cliente.regime, cliente.diasVencimento, cliente.tms, cliente.mor, cliente.moedaPagamento]
      );
      remessasAtribuidas += await atribuirRemessasPorEmails(cliente.emailsUsuario, id, cliente.pais, cliente.tms, cliente.mor);
      totalClientes++;
    }
    return NextResponse.json({ ok: true, sucesso: true, totalClientes, remessasAtribuidas });
  }

  const cliente = parseCliente(body, pais);
  if (!cliente.nome || !cliente.emailsUsuario) {
    return NextResponse.json({ error: 'Nome e EmailsUsuario sao obrigatorios.' }, { status: 400 });
  }
  const id = `LOCAL_CLI_${Date.now()}`;
  await query(
    `INSERT INTO clientes (
      cliente_id,nome,emails_usuario,emails_contato,intermediario_cobranca,
      pais,regime,dias_vencimento,data_cadastro,tms,mor,moeda_pagamento
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,current_date,$9,$10,$11)`,
    [id, cliente.nome, cliente.emailsUsuario, cliente.emailsContato || null, cliente.intermediarioCobranca || null,
     cliente.pais, cliente.regime, cliente.diasVencimento, cliente.tms, cliente.mor, cliente.moedaPagamento]
  );
  const remessasAtribuidas = await atribuirRemessasPorEmails(cliente.emailsUsuario, id, cliente.pais, cliente.tms, cliente.mor);
  return NextResponse.json({ ok: true, sucesso: true, id, clienteId: id, remessasAtribuidas });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const clienteId = String(body.clienteId || body.cliente_id || '').trim();
  if (!clienteId) return NextResponse.json({ error: 'clienteId obrigatorio' }, { status: 400 });

  const [atual] = await query<{ pais: string }>(`SELECT pais FROM clientes WHERE cliente_id=$1`, [clienteId]);
  if (!atual) return NextResponse.json({ error: 'Cliente nao encontrado.' }, { status: 404 });

  const cliente = parseCliente({ ...body, pais: atual.pais }, atual.pais);
  if (!cliente.nome || !cliente.emailsUsuario) {
    return NextResponse.json({ error: 'Nome e EmailsUsuario sao obrigatorios.' }, { status: 400 });
  }

  await query(
    `UPDATE clientes
        SET nome=$2,
            emails_usuario=$3,
            emails_contato=$4,
            intermediario_cobranca=$5,
            regime=$6,
            dias_vencimento=$7,
            moeda_pagamento=$8,
            tms=$9,
            mor=$10
      WHERE cliente_id=$1`,
    [clienteId, cliente.nome, cliente.emailsUsuario, cliente.emailsContato || null, cliente.intermediarioCobranca || null,
     cliente.regime, cliente.diasVencimento, cliente.moedaPagamento, cliente.tms, cliente.mor]
  );
  const remessasAtribuidas = await atribuirRemessasPorEmails(cliente.emailsUsuario, clienteId, atual.pais, cliente.tms, cliente.mor);
  await normalizarFlagsRemessasCliente(clienteId, cliente.tms, cliente.mor);
  return NextResponse.json({ ok: true, sucesso: true, remessasAtribuidas });
}
