import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { calcularValores, converterValorManual, isEnvioManual, isStatusRemessaVisivel, moedaPagamentoCliente } from '@/lib/faturamento';
import { aplicarMediaFrete, aplicarRegras, carregarRegras, getTaxaIntercompany, resetCache, round2 } from '@/lib/regras';
import type { Remessa, ItemManual, Cliente } from '@/lib/types';

// Espelho de fecharFaturamentoCliente + montarSnapshotFaturamento_:
// aceita data de corte — só remessas/itens com data <= corte entram na fatura.
export async function POST(req: NextRequest) {
  const { clienteId, pais, nomeCliente, fechadoPor, dataFechamento } = await req.json();
  if (!clienteId || !pais) return NextResponse.json({ error: 'clienteId e pais obrigatorios' }, { status: 400 });

  const [cliente] = await query<Cliente>(`SELECT * FROM clientes WHERE cliente_id=$1`, [clienteId]);
  if (!cliente) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 });

  // Data de corte: fim do dia escolhido (ou agora, se não informada)
  let fechamento: Date;
  if (dataFechamento) {
    const m = String(dataFechamento).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return NextResponse.json({ error: 'Data de fechamento inválida' }, { status: 400 });
    fechamento = new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:59.999Z`);
  } else {
    fechamento = new Date();
  }

  resetCache();
  const regras = await carregarRegras(pais);
  const moeda = moedaPagamentoCliente(cliente);

  // Remessas em aberto do cliente: status visível, faturável e dentro do corte
  const remessasAll = await query<Remessa>(
    `SELECT * FROM remessas WHERE cliente_id=$1 AND operacao_faturavel=true AND num_fatura IS NULL`,
    [clienteId]
  );
  const remessas = remessasAll
    .filter(r => isStatusRemessaVisivel(r.status_codigo, r.status))
    .filter(r => {
      if (!r.data) return true;
      const d = new Date(r.data);
      return isNaN(d.getTime()) || d.getTime() <= fechamento.getTime();
    });

  // Valores + regras + média de frete (espelho do snapshot)
  const workItems = remessas.map(r => {
    const ctx = {
      clienteId,
      weightKg: r.weight || 0,
      paisOrigem: String(r.pais || pais),
      paisDestino: r.destination || '',
      contratoDescricao: r.contrato_descricao || '',
    };
    const raw = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moeda, r.imposto_eur, r.imposto_tipo);
    const ruled = aplicarRegras(raw, ctx, regras);
    return { r, valores: { frete: ruled.frete, imposto: ruled.imposto }, contexto: ctx };
  });
  if (workItems.length > 0) aplicarMediaFrete(clienteId, workItems, regras);

  let qtdAwbs = 0, frete = 0, imposto = 0, manual = 0;
  const remessaIdList: string[] = [];
  for (const { r, valores, contexto } of workItems) {
    qtdAwbs++;
    frete += valores.frete;
    const ehEuPt = contexto.paisOrigem === 'PT' && String(r.grupo || '') === 'EU';
    if (!ehEuPt) imposto += valores.imposto;
    remessaIdList.push(r.remessa_id);
  }

  // Itens manuais em aberto dentro do corte
  const itensAll = await query<ItemManual>(
    `SELECT * FROM itens_manuais WHERE cliente_id=$1 AND num_fatura IS NULL`,
    [clienteId]
  );
  const itens = itensAll.filter(i => {
    if (!i.data) return true;
    const d = new Date(i.data);
    return isNaN(d.getTime()) || d.getTime() <= fechamento.getTime();
  });
  const itemIdList: string[] = [];
  for (const item of itens) {
    const vf = converterValorManual(item.valor_frete, item.moeda, moeda);
    const vi = converterValorManual(item.valor_imposto, item.moeda, moeda);
    if (isEnvioManual(item) && String(item.awb || '').trim()) {
      qtdAwbs++;
      frete += vf;
      imposto += vi;
    } else {
      manual += vf + vi;
    }
    itemIdList.push(item.item_id);
  }

  if (!remessaIdList.length && !itemIdList.length) {
    return NextResponse.json({ error: 'Nada para faturar até essa data.' }, { status: 400 });
  }

  const valorFrete = round2(frete);
  const valorImposto = round2(imposto);
  const valorManual = round2(manual);
  const taxaPct = getTaxaIntercompany(clienteId, regras);
  const base = valorFrete + valorImposto + valorManual;
  const taxa = taxaPct > 0 ? round2(base * taxaPct / 100) : 0;
  const valorTotal = round2(base + taxa);

  // Espelho de gerarNumFatura_: sequência POR CLIENTE
  const [cnt] = await query<{ total: string }>(
    `SELECT COUNT(*) as total FROM faturamentos_fechados WHERE cliente_id=$1`, [clienteId]
  );
  const seq = String(Number(cnt?.total || 0) + 1).padStart(3, '0');
  const numFatura = `SS-${pais}-${seq}`;

  const faturaId = `FAT_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  await query(`BEGIN`);
  try {
    await query(
      `INSERT INTO faturamentos_fechados (fatura_id,cliente_id,pais,nome_cliente,data_fechamento,ultimo_faturamento_anterior,qtd_awbs,valor_frete,valor_imposto,valor_manual,valor_total,moeda,remessa_ids,item_ids,status,criado_em,num_fatura,fechado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'fechado',now(),$15,$16)`,
      [faturaId, clienteId, pais, nomeCliente || cliente.nome,
       fechamento.toISOString(), cliente.ultimo_faturamento || null, qtdAwbs,
       valorFrete, valorImposto, valorManual, valorTotal,
       moeda, remessaIdList.join(','), itemIdList.length ? itemIdList.join(',') : null,
       numFatura, fechadoPor || null]
    );
    if (remessaIdList.length) {
      await query(`UPDATE remessas SET num_fatura=$1 WHERE remessa_id = ANY($2::text[])`, [numFatura, remessaIdList]);
    }
    if (itemIdList.length) {
      await query(`UPDATE itens_manuais SET num_fatura=$1 WHERE item_id = ANY($2::text[])`, [numFatura, itemIdList]);
    }
    await query(`UPDATE clientes SET ultimo_faturamento=$1 WHERE cliente_id=$2`, [fechamento.toISOString(), clienteId]);
    await query(`COMMIT`);
  } catch (e) {
    await query(`ROLLBACK`);
    throw e;
  }

  return NextResponse.json({ ok: true, faturaId, numFatura, qtdAwbs, valorTotal });
}
