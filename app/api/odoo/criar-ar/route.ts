import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calcularValores, isStatusRemessaVisivel, moedaDoPais, moedaPagamentoCliente } from '@/lib/faturamento';
import { execKw, odooConfigurado } from '@/lib/odoo';
import { aplicarMediaFrete, aplicarRegras, carregarRegras, resetCache, round2 } from '@/lib/regras';
import type { Cliente, Remessa } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Mapa país → company_id do Odoo. Por enquanto SÓ MX.
const COMPANY_BY_PAIS: Record<string, number> = { MX: 2 };
const STRIPE_JOURNAL_ID = 26; // diario Stripe da empresa MX
type OdooRel = [number, string] | false;
type OdooInvoiceRead = {
  id?: number;
  name?: string;
  amount_residual?: number;
  partner_id?: OdooRel;
};
type OdooJournalRead = {
  default_account_id?: OdooRel;
};
type OdooMoveLineRead = {
  id: number;
  account_id?: OdooRel;
  partner_id?: OdooRel;
};

function relId(value: OdooRel | undefined): number | null {
  return Array.isArray(value) ? value[0] : null;
}

function primeiroEmail(...values: Array<string | null | undefined>): string {
  return values
    .join(' ')
    .split(/[;,\s]+/)
    .map(v => v.trim().toLowerCase())
    .find(v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || '';
}

async function valoresParaRemessa(r: Remessa, cliente: Cliente | null, pais: string) {
  if (!cliente) {
    const moeda = moedaDoPais(pais);
    const vals = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moeda, r.imposto_eur, r.imposto_tipo);
    return { moeda, frete: round2(vals.frete), imposto: round2(vals.imposto) };
  }

  const moeda = moedaPagamentoCliente(cliente);
  resetCache(pais);
  const regras = await carregarRegras(pais);
  const rowsAll = await query<Remessa>(
    `SELECT * FROM remessas WHERE cliente_id=$1 AND operacao_faturavel=true AND num_fatura IS NULL`,
    [cliente.cliente_id],
  );
  const rows = rowsAll.filter(x => isStatusRemessaVisivel(x.status_codigo, x.status));
  const workItems = rows.map(row => {
    const ctx = {
      clienteId: row.cliente_id,
      weightKg: row.weight || 0,
      paisOrigem: pais,
      paisDestino: row.destination || '',
      contratoDescricao: row.contrato_descricao || '',
    };
    const raw = calcularValores(row.frete_usd, row.imposto_original, row.moeda_cotacao, moeda, row.imposto_eur, row.imposto_tipo);
    const ruled = aplicarRegras(raw, ctx, regras);
    return { r: row, valores: { frete: ruled.frete, imposto: ruled.imposto }, contexto: ctx };
  });
  if (workItems.length > 0) aplicarMediaFrete(cliente.cliente_id, workItems, regras);

  const item = workItems.find(x => x.r.remessa_id === r.remessa_id);
  if (!item) throw new Error('Remessa nao esta ativa na fatura em andamento deste cliente.');
  return { moeda, frete: round2(item.valores.frete), imposto: round2(item.valores.imposto) };
}

async function registrarPagamentoStripe(invoiceId: number, companyId: number, partnerId: number, data: string): Promise<number | null> {
  const ctx = { allowed_company_ids: [companyId], company_id: companyId };
  const [invoice] = await execKw<OdooInvoiceRead[]>('account.move', 'read', [[invoiceId]], {
    fields: ['id', 'name', 'amount_residual', 'partner_id'],
    context: ctx,
  });
  const amount = round2(Number(invoice?.amount_residual || 0));
  if (amount <= 0) return null;

  const [journal] = await execKw<OdooJournalRead[]>('account.journal', 'read', [[STRIPE_JOURNAL_ID]], {
    fields: ['default_account_id'],
    context: ctx,
  });
  const stripeAccountId = relId(journal?.default_account_id);
  if (!stripeAccountId) throw new Error('Diario Stripe sem conta padrao configurada.');

  const [invoiceReceivable] = await execKw<OdooMoveLineRead[]>('account.move.line', 'search_read', [[
    ['move_id', '=', invoiceId],
    ['account_type', '=', 'asset_receivable'],
    ['amount_residual', '>', 0],
  ]], {
    fields: ['id', 'account_id', 'partner_id'],
    limit: 1,
    context: ctx,
  });
  const receivableAccountId = relId(invoiceReceivable?.account_id);
  if (!invoiceReceivable || !receivableAccountId) {
    throw new Error('Linha a receber da fatura nao encontrada para reconciliar.');
  }

  const invoicePartnerId = relId(invoice?.partner_id) || relId(invoiceReceivable.partner_id) || partnerId;
  const label = `Stripe payment ${invoice?.name || invoiceId}`;
  const paymentMoveId = await execKw<number>('account.move', 'create', [{
    move_type: 'entry',
    company_id: companyId,
    journal_id: STRIPE_JOURNAL_ID,
    date: data,
    ref: label,
    line_ids: [
      [0, 0, { name: label, account_id: stripeAccountId, partner_id: invoicePartnerId, debit: amount, credit: 0 }],
      [0, 0, { name: label, account_id: receivableAccountId, partner_id: invoicePartnerId, debit: 0, credit: amount }],
    ],
  }], { context: ctx });

  await execKw('account.move', 'action_post', [[paymentMoveId]], { context: ctx });

  const [paymentReceivable] = await execKw<OdooMoveLineRead[]>('account.move.line', 'search_read', [[
    ['move_id', '=', paymentMoveId],
    ['account_id', '=', receivableAccountId],
    ['credit', '>', 0],
  ]], {
    fields: ['id', 'account_id', 'partner_id'],
    limit: 1,
    context: ctx,
  });
  if (!paymentReceivable) {
    throw new Error('Linha do pagamento Stripe nao encontrada para reconciliar.');
  }

  await execKw('account.move.line', 'reconcile', [[invoiceReceivable.id, paymentReceivable.id]], { context: ctx });
  return paymentMoveId;
}
// Cria uma conta a receber (fatura de cliente) no Odoo com 2 linhas (Freight +
// Duties & Taxes, sem imposto do Odoo) e já registra o pagamento no diário Stripe.
// Se o parceiro (por e-mail) não existir e não vier `nome`, responde needsName.
export async function POST(req: NextRequest) {
  if (!odooConfigurado()) {
    return NextResponse.json({ error: 'Odoo não configurado (faltam env vars ODOO_*).' }, { status: 500 });
  }
  const { remessaId, nome } = await req.json();
  if (!remessaId) return NextResponse.json({ error: 'remessaId obrigatorio' }, { status: 400 });

  const [r] = await query<Remessa>(`SELECT * FROM remessas WHERE remessa_id=$1`, [remessaId]);
  if (!r) return NextResponse.json({ error: 'Remessa não encontrada' }, { status: 404 });

  if (r.num_fatura) return NextResponse.json({ error: 'Remessa ja pertence a uma fatura fechada.' }, { status: 400 });
  if (!r.operacao_faturavel) return NextResponse.json({ error: 'Remessa nao esta faturavel no painel.' }, { status: 400 });

  const [cliente] = r.cliente_id
    ? await query<Cliente>(`SELECT * FROM clientes WHERE cliente_id=$1`, [r.cliente_id])
    : [null];
  const pais = String(cliente?.pais || r.pais || '').toUpperCase();
  const companyId = COMPANY_BY_PAIS[pais];
  if (!companyId) return NextResponse.json({ error: `Sem empresa Odoo para o país ${pais || '(vazio)'} (por enquanto só MX).` }, { status: 400 });

  const { moeda, frete, imposto } = await valoresParaRemessa(r, cliente, pais);
  if (frete <= 0 && imposto <= 0) {
    return NextResponse.json({ error: 'Remessa sem valor a faturar.' }, { status: 400 });
  }

  const email = cliente
    ? (primeiroEmail(cliente.emails_contato, cliente.emails_usuario) || String(r.email_usuario || '').trim().toLowerCase())
    : String(r.email_usuario || '').trim().toLowerCase();
  const ctx = { allowed_company_ids: [companyId], company_id: companyId };

  try {
    // 1) Parceiro por e-mail
    let partnerId: number | null = null;
    if (email) {
      const found = await execKw<number[]>('res.partner', 'search', [[['email', '=', email]]], { limit: 1 });
      if (found.length) partnerId = found[0];
    }
    if (!partnerId && cliente?.nome) {
      const found = await execKw<number[]>('res.partner', 'search', [[['name', '=', cliente.nome]]], { limit: 1 });
      if (found.length) partnerId = found[0];
    }
    if (!partnerId) {
      if (!cliente && !nome) {
        // UI abre a caixinha pedindo o nome
        return NextResponse.json({ needsName: true, email });
      }
      partnerId = await execKw<number>('res.partner', 'create', [{
        name: String(cliente?.nome || nome).trim(),
        email: email || false,
        customer_rank: 1,
      }]);
    }

    // 2) Fatura de cliente (conta a receber) com 2 linhas, sem imposto do Odoo
    const linhas: unknown[] = [];
    if (frete > 0) linhas.push([0, 0, { name: `Freight — AWB ${r.awb}`, quantity: 1, price_unit: frete, tax_ids: [[6, 0, []]] }]);
    if (imposto > 0) linhas.push([0, 0, { name: `Duties & Taxes — AWB ${r.awb}`, quantity: 1, price_unit: imposto, tax_ids: [[6, 0, []]] }]);

    const hoje = new Date().toISOString().slice(0, 10);
    const invoiceId = await execKw<number>('account.move', 'create', [{
      move_type: 'out_invoice',
      company_id: companyId,
      partner_id: partnerId,
      invoice_date: hoje,
      ref: `AWB ${r.awb}`,
      invoice_line_ids: linhas,
    }], { context: ctx });

    // 3) Postar (vira a conta a receber de fato)
    await execKw('account.move', 'action_post', [[invoiceId]], { context: ctx });

    // 4) Lancar recebimento no diario Stripe e reconciliar a conta a receber.
    const paymentMoveId = await registrarPagamentoStripe(invoiceId, companyId, partnerId, hoje);

    // 5) Ler número e status final
    const [mv] = await execKw<Array<{ name: string; amount_total: number; payment_state: string }>>(
      'account.move', 'read', [[invoiceId]], { fields: ['name', 'amount_total', 'payment_state'], context: ctx }
    );

    let resolvidoLocalmente = true;
    try {
      const resolvidas = await query<{ remessa_id: string }>(
        `UPDATE remessas
         SET operacao_faturavel=false, gateway_pagamento=$1
         WHERE remessa_id=$2 AND num_fatura IS NULL
         RETURNING remessa_id`,
        ['odoo_stripe', remessaId]
      );
      resolvidoLocalmente = resolvidas.length > 0;
    } catch {
      resolvidoLocalmente = false;
    }

    return NextResponse.json({
      ok: true,
      invoiceId,
      numero: mv?.name || String(invoiceId),
      total: mv?.amount_total ?? round2(frete + imposto),
      pagamento: mv?.payment_state || '?',
      paymentMoveId,
      resolvidoLocalmente,
      frete, imposto, moeda,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
