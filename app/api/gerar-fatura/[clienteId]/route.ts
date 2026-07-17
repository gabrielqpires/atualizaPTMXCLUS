import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { query } from '@/lib/db';
import { calcularValores, converterValorManual, inferirGrupo, isEnvioManual, isStatusRemessaVisivel, moedaPagamentoCliente } from '@/lib/faturamento';
import { aplicarMediaFrete, aplicarRegras, carregarRegras, getTaxaIntercompany, resetCache, round2 } from '@/lib/regras';
import type { Remessa, ItemManual } from '@/lib/types';
import { formatDateIsoLocal } from '@/lib/dates';

// Espelho do GerarFatura.gs: Consolidado + Ajustes + Resumo (PT/US) e Consolidado único (MX)

function fmtMoeda(moeda: string) {
  return `"${String(moeda || 'EUR').toUpperCase()}" #,##0.00`;
}

function fmtDateIso(d: string | null): string {
  return formatDateIsoLocal(d);
}

function normalizarTipoAjuste(tipo: string | null): string {
  const t = String(tipo || '').trim().toLowerCase();
  if (t === 'desconto') return 'Desconto';
  if (t === 'sobrepeso') return 'Sobrepeso';
  if (t === 'armazenamento') return 'Armazenamento';
  return 'Outro';
}

const TIPO_EN: Record<string, string> = {
  Desconto: 'Discount', Sobrepeso: 'Overweight', Armazenamento: 'Storage', Outros: 'Others', Outro: 'Others',
};

const PRETO = 'FF000000';
const BRANCO = 'FFFFFFFF';

function usarLayoutCompacto(pais: string, nomeCliente: string): boolean {
  return pais === 'MX' || (pais === 'US' && /\bparcel\b/i.test(nomeCliente));
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ clienteId: string }> }) {
  const { clienteId } = await params;
  const pais = (req.nextUrl.searchParams.get('pais') || 'PT').toUpperCase();
  const numFatura = req.nextUrl.searchParams.get('numFatura') || null;

  const [cliente] = await query<{ nome: string; regime: string; moeda_pagamento: string; tms: boolean; mor: boolean }>(
    `SELECT nome, regime, moeda_pagamento, tms, mor FROM clientes WHERE cliente_id=$1`, [clienteId]
  );
  if (!cliente) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 });

  resetCache(pais);
  const regras = await carregarRegras(pais);
  const moedaFat = moedaPagamentoCliente({ moeda_pagamento: cliente.moeda_pagamento, pais });
  const FMT_MOEDA = fmtMoeda(moedaFat);
  const taxaPct = getTaxaIntercompany(clienteId, regras);
  const tms = !!cliente.tms;
  const mor = !!cliente.mor;

  // num_fatura é compartilhado entre clientes — sempre filtrar por cliente também
  const remessasAll = numFatura
    ? await query<Remessa>(`SELECT * FROM remessas WHERE num_fatura=$1 AND cliente_id=$2 ORDER BY data`, [numFatura, clienteId])
    : await query<Remessa>(`SELECT * FROM remessas WHERE cliente_id=$1 AND operacao_faturavel=true AND num_fatura IS NULL ORDER BY data`, [clienteId]);
  const remessas = numFatura ? remessasAll : remessasAll.filter(r => isStatusRemessaVisivel(r.status_codigo, r.status));

  const itensBrutos = numFatura
    ? await query<ItemManual>(`SELECT * FROM itens_manuais WHERE num_fatura=$1 AND cliente_id=$2 ORDER BY criado_em`, [numFatura, clienteId])
    : await query<ItemManual>(`SELECT * FROM itens_manuais WHERE cliente_id=$1 AND num_fatura IS NULL ORDER BY criado_em`, [clienteId]);

  // Valores + regras + média de frete
  const workItems = remessas.map(r => {
    const ctx = {
      clienteId,
      weightKg: r.weight || 0,
      paisOrigem: pais,
      paisDestino: r.destination || '',
      contratoDescricao: r.contrato_descricao || '',
    };
    const raw = calcularValores(r.frete_usd, r.imposto_original, r.moeda_cotacao, moedaFat, r.imposto_eur, r.imposto_tipo);
    const ruled = aplicarRegras(raw, ctx, regras);
    return { r, valores: { frete: ruled.frete, imposto: ruled.imposto }, contexto: ctx };
  });
  if (workItems.length > 0) aplicarMediaFrete(clienteId, workItems, regras);

  // Linhas do Consolidado (espelho de montarRemessasDaFatura_)
  interface LinhaConsolidado {
    data: string; awb: string; orderId: string; destination: string; group: string;
    weight: number; valorFrete: number; valorImposto: number;
    chargeDescription: string; source: string; description: string;
  }
  const linhas: LinhaConsolidado[] = workItems.map(({ r, valores }) => {
    const orderId = String(r.order_id || '');
    return {
      data: fmtDateIso(r.data),
      awb: String(r.awb || ''),
      orderId,
      destination: String(r.destination || r.pais || ''),
      group: String(r.grupo || ''),
      weight: Number(r.weight) || 0,
      valorFrete: round2(valores.frete),
      valorImposto: round2(valores.imposto),
      chargeDescription: orderId.toLowerCase().includes('return') ? 'Return - Freight' : 'Freight',
      source: 'tech',
      description: String(r.contrato_descricao || r.awb || ''),
    };
  });

  // Envios manuais entram no Consolidado (source=manual; group fixo como no GerarFatura.gs)
  for (const i of itensBrutos.filter(x => isEnvioManual(x))) {
    const vf = converterValorManual(i.valor_frete, i.moeda, moedaFat);
    const vi = converterValorManual(i.valor_imposto, i.moeda, moedaFat);
    const destino = String(i.pais_destino || pais);
    linhas.push({
      data: fmtDateIso(i.data),
      awb: String(i.awb || '').trim(),
      orderId: String(i.pedido || ''),
      destination: destino,
      group: inferirGrupo(destino) || 'Non-EU',
      weight: 0,
      valorFrete: round2(vf),
      valorImposto: round2(vi),
      chargeDescription: 'Freight',
      source: 'manual',
      description: String(i.descricao || 'Manual shipment'),
    });
  }

  // Ajustes (espelho de montarAjustesDaFatura_)
  const ajustes = itensBrutos
    .filter(i => !isEnvioManual(i))
    .map(i => {
      const categoria = normalizarTipoAjuste(i.tipo);
      let valor = converterValorManual(i.valor_frete, i.moeda, moedaFat) + converterValorManual(i.valor_imposto, i.moeda, moedaFat);
      if (categoria === 'Desconto') valor = -Math.abs(valor);
      return {
        data: fmtDateIso(i.data),
        categoria,
        tipoEn: TIPO_EN[categoria] || categoria,
        descricao: i.descricao || '',
        valor: round2(valor),
      };
    });

  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;

  const CONSOLIDADO_HEADERS = [
    'Created At', 'AWB', 'Order', 'Destination', 'Weight',
    `Billed Freight ${moedaFat}`, `Duties&Taxes ${moedaFat}`, 'Group',
    'Charge Category', 'Charge Description', 'Source',
  ];
  const CONSOLIDADO_WIDTHS = [18, 22, 16, 12, 10, 18, 18, 10, 15, 18, 10];

  function headerRow(ws: ExcelJS.Worksheet, values: string[]) {
    const row = ws.addRow(values);
    row.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRETO } };
      c.font = { bold: true, color: { argb: BRANCO } };
    });
    return row;
  }

  function preencherConsolidado(ws: ExcelJS.Worksheet) {
    ws.columns = CONSOLIDADO_WIDTHS.map(w => ({ width: w }));
    headerRow(ws, CONSOLIDADO_HEADERS);
    for (const l of linhas) {
      const row = ws.addRow([
        l.data, l.awb, l.orderId, l.destination, l.weight,
        l.valorFrete, l.valorImposto, l.group,
        'Regular Invoice', l.chargeDescription, l.source,
      ]);
      row.getCell(6).font = { bold: true };
      row.getCell(7).font = { bold: true };
      row.getCell(6).numFmt = FMT_MOEDA;
      row.getCell(7).numFmt = FMT_MOEDA;
    }
  }

  if (usarLayoutCompacto(pais, cliente.nome)) {
    // ── Formato compacto: MX e Parcel US, layout original aprovado ──
    const ws = workbook.addWorksheet('Consolidado');
    ws.columns = [
      { width: 16 },
      { width: 24 },
      { width: 16 },
      { width: 13 },
      { width: 18 },
      { width: 18 },
    ];

    const blueFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    const whiteBold: Partial<ExcelJS.Font> = { bold: true, color: { argb: BRANCO } };
    const lightBorder: Partial<ExcelJS.Borders> = {
      top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
      right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    };
    const mxAmountHeader = `Valor (${moedaFat})`;

    const styleSectionRow = (row: ExcelJS.Row) => {
      row.height = 24;
      for (let col = 1; col <= 6; col++) {
        const cell = row.getCell(col);
        cell.fill = blueFill;
        cell.font = whiteBold;
        cell.alignment = { vertical: 'middle', horizontal: col >= 4 ? 'right' : 'left' };
        cell.border = lightBorder;
      }
    };

    const styleDataRow = (row: ExcelJS.Row) => {
      row.height = 20;
      for (let col = 1; col <= 6; col++) {
        const cell = row.getCell(col);
        cell.border = lightBorder;
        cell.alignment = {
          vertical: 'middle',
          horizontal: col >= 4 ? 'right' : (col === 1 ? 'center' : 'left'),
        };
      }
    };

    const mergeLabelAndAmount = (row: ExcelJS.Row) => {
      ws.mergeCells(row.number, 1, row.number, 4);
      ws.mergeCells(row.number, 5, row.number, 6);
    };

    const hdr = ws.addRow([
      'Created At', 'AWB', 'Destination', 'Peso',
      `Valor Frete (${moedaFat})`, `Valor Imposto (${moedaFat})`,
    ]);
    styleSectionRow(hdr);
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const firstDataRow = ws.rowCount + 1;

    for (const l of linhas) {
      const row = ws.addRow([
        l.data,
        l.awb,
        l.destination,
        l.weight || '',
        l.valorFrete,
        l.valorImposto,
      ]);
      row.getCell(5).numFmt = FMT_MOEDA;
      row.getCell(6).numFmt = FMT_MOEDA;
      styleDataRow(row);
    }

    const lastDataRow = ws.rowCount;

    if (ajustes.length > 0) {
      ws.addRow([]);
      const ajHdr = ws.addRow(['Ajustes', 'Descrição', 'Tipo', 'Data', mxAmountHeader, '']);
      styleSectionRow(ajHdr);
      for (const a of ajustes) {
        const row = ws.addRow(['', a.descricao, a.tipoEn, a.data, a.valor, '']);
        row.getCell(5).numFmt = FMT_MOEDA;
        if (a.valor < 0) row.getCell(5).font = { color: { argb: 'FFFF4444' } };
        styleDataRow(row);
      }
    }

    const lastBeforeFeeRow = ws.rowCount;
    if (taxaPct > 0 && lastBeforeFeeRow >= firstDataRow) {
      ws.addRow([]);
      const feeHdr = ws.addRow(['Fees', '', '', '', mxAmountHeader, '']);
      mergeLabelAndAmount(feeHdr);
      styleSectionRow(feeHdr);
      const feeRow = ws.addRow([
        `Intercompany Cross-Border Fee (${taxaPct}%)`, '', '', '',
        { formula: `(SUM(E${firstDataRow}:E${lastBeforeFeeRow})+SUM(F${firstDataRow}:F${lastDataRow}))*${taxaPct / 100}` },
        '',
      ]);
      mergeLabelAndAmount(feeRow);
      feeRow.getCell(5).numFmt = FMT_MOEDA;
      feeRow.getCell(5).font = { bold: true };
      styleDataRow(feeRow);
    }

    const lastBeforeTotalRow = ws.rowCount;
    if (lastBeforeTotalRow >= firstDataRow) {
      ws.addRow([]);
      const taxRange = lastDataRow >= firstDataRow ? `+SUM(F${firstDataRow}:F${lastDataRow})` : '';
      const totalRow = ws.addRow(['TOTAL', '', '', '', { formula: `SUM(E${firstDataRow}:E${lastBeforeTotalRow})${taxRange}` }, '']);
      mergeLabelAndAmount(totalRow);
      totalRow.getCell(5).numFmt = FMT_MOEDA;
      styleSectionRow(totalRow);
    }
  } else {
    // ── Formato PT/US: Consolidado + Ajustes + Resumo (espelho do GerarFatura.gs) ──
    const wsC = workbook.addWorksheet('Consolidado');
    preencherConsolidado(wsC);

    const temAjustes = ajustes.length > 0;
    if (temAjustes) {
      const wsA = workbook.addWorksheet('Ajustes');
      wsA.columns = [{ width: 14 }, { width: 20 }, { width: 15 }, { width: 10 }, { width: 34 }];
      headerRow(wsA, ['Data', 'Tipo', 'Valor', 'Moeda', 'Descricao']);
      for (const a of ajustes) {
        const row = wsA.addRow([a.data, a.tipoEn, a.valor, moedaFat, a.descricao]);
        row.getCell(3).numFmt = FMT_MOEDA;
        row.getCell(3).font = { bold: true };
      }
    }

    // ── Aba Resumo (fórmulas idênticas ao preencherResumo_) ──
    const wsR = workbook.addWorksheet('Resumo');
    const FMT_PCT = '0%';
    const FMT_QTY = '#,##0';
    const hasTech = tms || mor;
    const techPrice = (tms ? 0.53 : 0) + (mor ? 1.30 : 0);

    const hdr = (row: number, col: number, val: string) => {
      const c = wsR.getCell(row, col);
      c.value = val;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRETO } };
      c.font = { bold: true, color: { argb: BRANCO } };
    };
    const cell = (row: number, col: number, val: string | number, bold?: boolean, fmt?: string) => {
      const c = wsR.getCell(row, col);
      c.value = typeof val === 'string' && val.startsWith('=') ? { formula: val.slice(1) } : val;
      if (bold) c.font = { bold: true };
      if (fmt) c.numFmt = fmt;
    };

    // Currency
    hdr(1, 1, 'Currency');
    cell(2, 1, 1.17);

    // Freight summary
    ['Shipments Destination', 'Shipments', 'Freight', 'Demand Surcharge*', 'Duties&Taxes', 'TOTAL']
      .forEach((h, i) => hdr(4, i + 1, h));

    cell(5, 1, 'Freight Non.EU');
    cell(5, 2, '=COUNTIFS(Consolidado!J:J, "Freight", Consolidado!H:H, "Non-EU")', false, FMT_QTY);
    cell(5, 3, '=SUMIFS(Consolidado!F:F, Consolidado!J:J, "Freight", Consolidado!H:H, "Non-EU")', true, FMT_MOEDA);
    cell(5, 4, 'NA');
    cell(5, 5, '=SUMIFS(Consolidado!G:G, Consolidado!J:J, "Freight", Consolidado!H:H, "Non-EU")', true, FMT_MOEDA);
    cell(5, 6, '=E5+C5', true, FMT_MOEDA);

    cell(6, 1, 'Freight EU');
    cell(6, 2, '=COUNTIFS(Consolidado!J:J, "Freight", Consolidado!H:H, "EU")', false, FMT_QTY);
    cell(6, 3, '=SUMIFS(Consolidado!F:F, Consolidado!J:J, "Freight", Consolidado!H:H, "EU")', true, FMT_MOEDA);
    cell(6, 4, 'NA');
    cell(6, 5, '=SUMIFS(Consolidado!G:G, Consolidado!J:J, "Freight", Consolidado!H:H, "EU")', true, FMT_MOEDA);
    cell(6, 6, '=E6+C6', true, FMT_MOEDA);

    cell(7, 1, 'Return ');
    cell(7, 2, '=COUNTIFS(Consolidado!J:J, "Return - Freight")', false, FMT_QTY);
    cell(7, 3, '=SUMIFS(Consolidado!F:F, Consolidado!J:J, "Return - Freight")', true, FMT_MOEDA);
    cell(7, 4, 'NA');
    cell(7, 5, 0.0, true, FMT_MOEDA);
    cell(7, 6, '=C7', true, FMT_MOEDA);

    cell(9, 1, '*1 Euro for shipments in peak season');

    // Service table
    ['Service', 'Quantity', 'Price', 'IVA', 'TOTAL'].forEach((h, i) => hdr(12, i + 1, h));

    ([
      [13, 'Subtotal Freight Non.EU', '=B5', '=C5', 0.0, '=C13'],
      [14, 'Subtotal Freight EU', '=B6', '=C6', 0.0, '=C14'],
      [15, 'Return', '=B7', '=C7', 0.0, '=C15'],
    ] as [number, string, string, string, number, string][]).forEach(r => {
      cell(r[0], 1, r[1]); cell(r[0], 2, r[2]);
      cell(r[0], 3, r[3], true, FMT_MOEDA);
      cell(r[0], 4, r[4], false, FMT_PCT);
      cell(r[0], 5, r[5], true, FMT_MOEDA);
    });

    let ajusteOffset = 0;
    if (temAjustes) {
      ajusteOffset = 4;
      ([
        [16, 'Discount', '=COUNTIF(Ajustes!B:B, "Discount")', '=SUMIF(Ajustes!B:B, "Discount", Ajustes!C:C)', 0.0, '=C16'],
        [17, 'Overweight', '=COUNTIF(Ajustes!B:B, "Overweight")', '=SUMIF(Ajustes!B:B, "Overweight", Ajustes!C:C)', 0.0, '=C17'],
        [18, 'Storage', '=COUNTIF(Ajustes!B:B, "Storage")', '=SUMIF(Ajustes!B:B, "Storage", Ajustes!C:C)', 0.0, '=C18'],
        [19, 'Others', '=COUNTIF(Ajustes!B:B, "Others")', '=SUMIF(Ajustes!B:B, "Others", Ajustes!C:C)', 0.0, '=C19'],
      ] as [number, string, string, string, number, string][]).forEach(r => {
        cell(r[0], 1, r[1]); cell(r[0], 2, r[2]);
        cell(r[0], 3, r[3], true, FMT_MOEDA);
        cell(r[0], 4, r[4], false, FMT_PCT);
        cell(r[0], 5, r[5], true, FMT_MOEDA);
      });
    }

    // Linhas dinâmicas conforme TMS/MOR
    const baseRow = 16 + ajusteOffset;
    let sepRow: number, totalRow: number, totalSum: string, debitRow: number, refStart: number;
    if (hasTech) {
      const techRow = baseRow;
      cell(techRow, 1, 'Subtotal Tech');
      cell(techRow, 2, '=COUNTIFS(Consolidado!J:J,"Freight",Consolidado!K:K,"tech")+COUNTIFS(Consolidado!J:J,"Return - Freight",Consolidado!K:K,"tech")');
      cell(techRow, 3, techPrice, true, FMT_MOEDA);
      cell(techRow, 4, 0.23, false, FMT_PCT);
      cell(techRow, 5, `=(B${techRow}*C${techRow})*(1+D${techRow})`, true, FMT_MOEDA);
      sepRow = techRow + 1; totalRow = techRow + 2;
      totalSum = `=SUM(E13:E${techRow})`;
      debitRow = techRow + 4; refStart = techRow + 6;
    } else {
      sepRow = baseRow; totalRow = baseRow + 1;
      totalSum = `=SUM(E13:E${baseRow - 1})`;
      debitRow = baseRow + 3; refStart = baseRow + 5;
    }

    cell(sepRow, 3, '.');
    cell(totalRow, 1, 'Invoice Total HT com IVA', true);
    cell(totalRow, 5, totalSum, true, FMT_MOEDA);

    if (taxaPct > 0) {
      const feeRow = totalRow + 2;
      const grandTotalRow = totalRow + 3;
      cell(feeRow, 1, `Intercompany Cross-Border Fee (${taxaPct}%)`);
      cell(feeRow, 5, `=E${totalRow}*${taxaPct / 100}`, true, FMT_MOEDA);
      cell(grandTotalRow, 1, 'Invoice Total incl. Fee', true);
      cell(grandTotalRow, 5, `=E${totalRow}+E${feeRow}`, true, FMT_MOEDA);
      debitRow = grandTotalRow + 2;
      refStart = grandTotalRow + 4;
    }

    cell(debitRow, 1, 'TOTAL Debit Note', true);
    cell(debitRow, 2, '=E5', true, FMT_MOEDA);

    let nextRow = refStart;
    if (tms) { cell(nextRow, 1, 'TMS'); cell(nextRow, 2, 0.53); nextRow++; }
    if (mor) { cell(nextRow, 1, 'MOR'); cell(nextRow, 2, 1.30); nextRow++; }
    if (hasTech) { cell(nextRow, 1, 'Total Tech', true); cell(nextRow, 2, techPrice, true); }

    wsR.getColumn(1).width = 30;
    wsR.getColumn(2).width = 14;
    wsR.getColumn(3).width = 14;
    wsR.getColumn(4).width = 18;
    wsR.getColumn(5).width = 16;
    wsR.getColumn(6).width = 16;
  }

  const buf = await workbook.xlsx.writeBuffer();
  // Nome do arquivo: cliente + período (espelho do GerarFatura.gs)
  const datas = linhas.map(l => l.data).filter(Boolean).sort();
  const ddmm = (iso: string) => { const p = iso.split('-'); return p.length >= 3 ? `${p[2]}-${p[1]}` : iso; };
  const periodo = datas.length
    ? (datas[0] === datas[datas.length - 1] ? ddmm(datas[0]) : `${ddmm(datas[0])} a ${ddmm(datas[datas.length - 1])}`)
    : '';
  const safeName = `${cliente.nome} ${periodo}`.replace(/[^a-zA-Z0-9 \-]/g, '_').trim().replace(/ +/g, '_');
  return new NextResponse(buf as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safeName || 'fatura'}.xlsx"`,
    },
  });
}
