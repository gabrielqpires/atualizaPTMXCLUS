import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calcularValores, moedaDoPais } from '@/lib/faturamento';
import { execKw, odooConfigurado } from '@/lib/odoo';
import { round2 } from '@/lib/regras';
import type { Remessa } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Mapa país → company_id do Odoo. Por enquanto SÓ MX.
const COMPANY_BY_PAIS: Record<string, number> = { MX: 2 };
const STRIPE_JOURNAL_ID = 26; // diário Stripe da empresa MX

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

  const pais = String(r.pais || '').toUpperCase();
  const companyId = COMPANY_BY_PAIS[pais];
  if (!companyId) return NextResponse.json({ error: `Sem empresa Odoo para o país ${pais || '(vazio)'} (por enquanto só MX).` }, { status: 400 });

  const moeda = moedaDoPais(pais); // MXN
  const vals = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moeda, r.imposto_eur, r.imposto_tipo);
  const frete = round2(vals.frete);
  const imposto = round2(vals.imposto);
  if (frete <= 0 && imposto <= 0) {
    return NextResponse.json({ error: 'Remessa sem valor a faturar.' }, { status: 400 });
  }

  const email = String(r.email_usuario || '').trim().toLowerCase();
  const ctx = { allowed_company_ids: [companyId], company_id: companyId };

  try {
    // 1) Parceiro por e-mail
    let partnerId: number | null = null;
    if (email) {
      const found = await execKw<number[]>('res.partner', 'search', [[['email', '=', email]]], { limit: 1 });
      if (found.length) partnerId = found[0];
    }
    if (!partnerId) {
      if (!nome) {
        // UI abre a caixinha pedindo o nome
        return NextResponse.json({ needsName: true, email });
      }
      partnerId = await execKw<number>('res.partner', 'create', [{
        name: String(nome).trim(),
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

    // 4) Registrar pagamento (liquidação) no diário Stripe — valor cheio
    const wizId = await execKw<number>('account.payment.register', 'create', [{
      payment_date: hoje,
      journal_id: STRIPE_JOURNAL_ID,
    }], { context: { ...ctx, active_model: 'account.move', active_ids: [invoiceId] } });
    await execKw('account.payment.register', 'action_create_payments', [[wizId]], {
      context: { ...ctx, active_model: 'account.move', active_ids: [invoiceId] },
    });

    // 5) Ler número e status final
    const [mv] = await execKw<Array<{ name: string; amount_total: number; payment_state: string }>>(
      'account.move', 'read', [[invoiceId]], { fields: ['name', 'amount_total', 'payment_state'], context: ctx }
    );

    let resolvidoLocalmente = true;
    try {
      const resolvidas = await query<{ remessa_id: string }>(
        `UPDATE remessas
         SET operacao_faturavel=false, gateway_pagamento=$1
         WHERE remessa_id=$2 AND cliente_id IS NULL
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
      resolvidoLocalmente,
      frete, imposto, moeda,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
