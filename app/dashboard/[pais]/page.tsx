'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { use } from 'react';

type Pais = 'PT' | 'MX' | 'US' | 'CL';

interface Resumo {
  cliente_id: string;
  nome: string;
  regime: string;
  tms: boolean;
  mor: boolean;
  qtd_awbs: number;
  valor_frete: number;
  valor_imposto: number;
  valor_manual: number;
  taxa_intercompany_pct: number;
  taxa_intercompany: number;
  valor_total: number;
  moeda: string;
  janela_inicio: string | null;
  janela_fim: string | null;
}

interface Remessa {
  remessa_id: string;
  awb: string;
  order_id: string | null;
  destination: string | null;
  grupo: string | null;
  weight: number;
  contrato_descricao: string;
  status: string;
  imposto_tipo: string | null;
  valor_frete: number;
  valor_imposto: number;
  data: string;
  moeda: string;
}

interface ItemManual {
  item_id: string;
  descricao: string | null;
  tipo: string;
  valor_convertido: number;
  valor_frete: number;
  valor_imposto: number;
  data: string | null;
  awb: string | null;
  pedido: string | null;
  pais_destino: string | null;
  ddp_ddu: string | null;
}

function isEnvioManual(item: ItemManual): boolean {
  return (item.tipo || '').toLowerCase() === 'envio' || !!item.awb;
}

const EU_COUNTRIES = new Set(['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK']);

function inferirGrupo(paisDestino: string | null | undefined): string {
  if (!paisDestino) return '';
  return EU_COUNTRIES.has(paisDestino.toUpperCase().trim()) ? 'EU' : 'Non-EU';
}

const MOEDA: Record<string, string> = { PT: 'EUR', MX: 'USD', US: 'USD', CL: 'USD' };
const NOME_PAIS: Record<string, string> = { PT: 'Portugal', MX: 'México', US: 'Estados Unidos', CL: 'Chile' };
const FLAG: Record<string, string> = { PT: '🇵🇹', MX: '🇲🇽', US: '🇺🇸', CL: '🇨🇱' };

function fmt(v: number, moeda: string) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda || 'USD' }).format(v ?? 0);
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 10);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function Janela({ inicio, fim }: { inicio: string | null; fim: string | null }) {
  if (!inicio && !fim) return <span className="text-zinc-600">—</span>;
  if (inicio === fim || !fim) return <span className="pill pill-warn">{fmtDate(inicio)}</span>;
  return <span className="pill pill-warn">{fmtDate(inicio)} → {fmtDate(fim)}</span>;
}

// ── Detail Panel ──────────────────────────────────────────
function ClienteDetail({
  cliente, pais, onClose, onFechado,
}: {
  cliente: Resumo; pais: Pais; onClose: () => void; onFechado: () => void;
}) {
  const [remessas, setRemessas] = useState<Remessa[]>([]);
  const [itens, setItens] = useState<ItemManual[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [ajDesc, setAjDesc] = useState('');
  const [ajTipo, setAjTipo] = useState('Desconto');
  const [ajValor, setAjValor] = useState('');
  const [ajData, setAjData] = useState(today());
  const [ajLoading, setAjLoading] = useState(false);
  const [fecharLoading, setFecharLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [r, i] = await Promise.all([
      fetch(`/api/remessas?clienteId=${cliente.cliente_id}`).then(r => r.json()),
      fetch(`/api/itens-manuais?clienteId=${cliente.cliente_id}`).then(r => r.json()),
    ]);
    setRemessas(Array.isArray(r) ? r : []);
    setItens(Array.isArray(i) ? i : []);
    setLoading(false);
  }, [cliente.cliente_id]);

  useEffect(() => { load(); }, [load]);

  async function addAjuste(e: React.FormEvent) {
    e.preventDefault();
    if (!ajDesc || !ajValor) return;
    setAjLoading(true);
    await fetch('/api/itens-manuais', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clienteId: cliente.cliente_id, descricao: ajDesc, tipo: ajTipo, valor: parseFloat(ajValor), moeda: MOEDA[pais], data: ajData || today() }),
    });
    setAjDesc(''); setAjValor(''); setAjData(today()); setShowForm(false);
    await load();
    setAjLoading(false);
  }

  async function deleteItem(itemId: string) {
    if (!confirm('Remover item?')) return;
    await fetch(`/api/itens-manuais?itemId=${itemId}`, { method: 'DELETE' });
    await load();
  }

  async function fechar() {
    if (!confirm(`Fechar faturamento de ${cliente.nome}?`)) return;
    setFecharLoading(true);
    const res = await fetch('/api/fechar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clienteId: cliente.cliente_id, pais, nomeCliente: cliente.nome }),
    });
    const data = await res.json();
    setFecharLoading(false);
    if (data.ok) { alert(`Faturamento fechado: ${data.numFatura}`); onFechado(); }
    else alert('Erro: ' + (data.error || 'desconhecido'));
  }

  const moeda = cliente.moeda || MOEDA[pais];
  const impostoLabel = pais === 'PT' ? 'Imposto (Non-EU)' : 'Imposto';

  // Split itens: envio manual goes to remessas table, ajuste goes to ajustes table
  const enviosManuais = itens.filter(isEnvioManual);
  const ajustes = itens.filter(i => !isEnvioManual(i));
  const totalEnvios = remessas.length + enviosManuais.length;

  return (
    <div className="card p-0 overflow-hidden border-indigo-700/50">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 bg-zinc-800/60 border-b border-zinc-700">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-semibold">{cliente.nome}</span>
          {cliente.regime && <span className="pill pill-ok text-xs">{cliente.regime}</span>}
          {cliente.tms && <span className="pill bg-blue-900/50 text-blue-300 text-xs">TMS</span>}
          {cliente.mor && <span className="pill bg-purple-900/50 text-purple-300 text-xs">MOR</span>}
        </div>
        <button className="btn text-xs" onClick={onClose}>✕</button>
      </div>

      {/* Summary */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 px-5 py-3 border-b border-zinc-800 text-sm">
        <span className="text-zinc-400">Frete <strong className="text-white">{fmt(cliente.valor_frete, moeda)}</strong></span>
        <span className="text-zinc-400">{impostoLabel} <strong className="text-white">{fmt(cliente.valor_imposto, moeda)}</strong></span>
        {cliente.valor_manual !== 0 && (
          <span className="text-zinc-400">Outros <strong className={cliente.valor_manual < 0 ? 'text-red-400' : 'text-green-400'}>{fmt(cliente.valor_manual, moeda)}</strong></span>
        )}
        {cliente.taxa_intercompany > 0 && (
          <span className="text-zinc-400">Cross-Border Fee ({cliente.taxa_intercompany_pct}%) <strong className="text-white">{fmt(cliente.taxa_intercompany, moeda)}</strong></span>
        )}
        <span className="text-zinc-400">Total <strong className="text-indigo-300 text-base">{fmt(cliente.valor_total, moeda)}</strong></span>
      </div>

      {/* Actions */}
      <div className="flex gap-2 px-5 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <button className="btn btn-primary text-xs" onClick={fechar} disabled={fecharLoading || (remessas.length === 0 && itens.length === 0)}>
          {fecharLoading ? 'Fechando...' : 'Fechar Faturamento'}
        </button>
        <a href={`/api/gerar-fatura/${cliente.cliente_id}?pais=${pais}`} className="btn text-xs" target="_blank" rel="noopener noreferrer">↓ Excel</a>
        <button className="btn text-xs" onClick={() => setShowForm(v => !v)}>{showForm ? 'Cancelar' : '+ Lançar ajuste'}</button>
      </div>

      {/* Ajuste form */}
      {showForm && (
        <form onSubmit={addAjuste} className="grid grid-cols-2 sm:grid-cols-5 gap-2 px-5 py-3 bg-zinc-800/30 border-b border-zinc-800">
          <input className="col-span-2" placeholder="Descrição" value={ajDesc} onChange={e => setAjDesc(e.target.value)} required />
          <select value={ajTipo} onChange={e => setAjTipo(e.target.value)}>
            <option>Desconto</option><option>Sobrepeso</option><option>Armazenamento</option><option>Outro</option>
          </select>
          <input type="number" step="0.01" placeholder="Valor" value={ajValor} onChange={e => setAjValor(e.target.value)} required />
          <input type="date" value={ajData} onChange={e => setAjData(e.target.value)} />
          <button type="submit" className="btn btn-primary col-span-2 sm:col-span-5" disabled={ajLoading}>{ajLoading ? 'Salvando...' : 'Salvar ajuste'}</button>
        </form>
      )}

      {loading ? (
        <div className="text-zinc-500 text-sm py-6 text-center">Carregando...</div>
      ) : (
        <div className="p-4 space-y-4">
          {/* Remessas: real AWBs + envio manual items */}
          <div>
            <div className="flex justify-between items-center mb-1 px-1">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Remessas da fatura</span>
              <span className="text-xs text-zinc-500">{totalEnvios} AWB(s)</span>
            </div>
            <div className="overflow-x-auto rounded border border-zinc-800">
              <table>
                <thead>
                  <tr>
                    <th>Created At</th><th>AWB</th><th>Order</th><th>Destination</th><th>Group</th>
                    <th>Weight</th><th className="amount">Billed Freight</th><th className="amount">Duties &amp; Taxes</th>
                    <th>Tax Type</th><th>Charge Description</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {remessas.map(r => (
                    <tr key={r.remessa_id}>
                      <td className="whitespace-nowrap">{fmtDate(r.data)}</td>
                      <td className="mono whitespace-nowrap">{r.awb}</td>
                      <td className="text-zinc-400">{r.order_id || '—'}</td>
                      <td>{r.destination || '—'}</td>
                      <td><span className={`pill ${r.grupo === 'EU' ? 'pill-ok' : 'pill-warn'}`}>{r.grupo || '—'}</span></td>
                      <td>{r.weight ? Number(r.weight).toFixed(3) : '—'}</td>
                      <td className="amount">{fmt(r.valor_frete, r.moeda || moeda)}</td>
                      <td className="amount">{fmt(r.valor_imposto, r.moeda || moeda)}</td>
                      <td className="text-zinc-400 text-xs">{r.imposto_tipo || '—'}</td>
                      <td className="text-xs max-w-[180px] truncate">{r.contrato_descricao || '—'}</td>
                      <td className="text-zinc-400 text-xs">{r.status || '—'}</td>
                    </tr>
                  ))}
                  {enviosManuais.map(i => {
                    const grupo = inferirGrupo(i.pais_destino);
                    return (
                      <tr key={i.item_id} className="opacity-80">
                        <td className="whitespace-nowrap">{fmtDate(i.data)}</td>
                        <td className="mono whitespace-nowrap">{i.awb || i.descricao || '—'}</td>
                        <td className="text-zinc-400">{i.pedido || '—'}</td>
                        <td>{i.pais_destino || '—'}</td>
                        <td>{grupo ? <span className={`pill ${grupo === 'EU' ? 'pill-ok' : 'pill-warn'}`}>{grupo}</span> : <span className="text-zinc-600">—</span>}</td>
                        <td>—</td>
                        <td className="amount">{fmt(i.valor_frete, moeda)}</td>
                        <td className="amount">{fmt(i.valor_imposto, moeda)}</td>
                        <td className="text-zinc-400 text-xs">{i.ddp_ddu || '—'}</td>
                        <td className="text-xs max-w-[180px] truncate">{i.descricao || '—'}</td>
                        <td className="text-zinc-400 text-xs">manual</td>
                      </tr>
                    );
                  })}
                  {totalEnvios === 0 && (
                    <tr><td colSpan={11} className="text-zinc-500 text-center py-4">Nenhuma remessa em aberto.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Ajustes: only non-envio manual items */}
          <div>
            <div className="flex justify-between items-center mb-1 px-1">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Ajustes</span>
              <span className="text-xs text-zinc-500">{ajustes.length} item(ns)</span>
            </div>
            <div className="overflow-x-auto rounded border border-zinc-800">
              <table>
                <thead>
                  <tr><th>Tipo</th><th className="amount">Valor</th><th>Data</th><th>Descrição</th><th></th></tr>
                </thead>
                <tbody>
                  {ajustes.map(item => (
                    <tr key={item.item_id}>
                      <td><span className="pill pill-warn">{item.tipo}</span></td>
                      <td className={`amount font-semibold ${item.tipo === 'Desconto' ? 'text-red-400' : 'text-green-400'}`}>{fmt(item.valor_convertido, moeda)}</td>
                      <td className="whitespace-nowrap">{fmtDate(item.data)}</td>
                      <td>{item.descricao || '—'}</td>
                      <td><button className="btn btn-danger text-xs py-0.5 px-2" onClick={() => deleteItem(item.item_id)}>✕</button></td>
                    </tr>
                  ))}
                  {ajustes.length === 0 && (
                    <tr><td colSpan={5} className="text-zinc-500 text-center py-3">Nenhum ajuste.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────
export default function Dashboard({ params }: { params: Promise<{ pais: string }> }) {
  const { pais: paisParam } = use(params);
  const pais = (paisParam?.toUpperCase() || 'PT') as Pais;

  const [resumos, setResumos] = useState<Resumo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendentesCount, setPendentesCount] = useState(0);
  const [ultimaSync, setUltimaSync] = useState<{ ts: string | null; tipo: string | null } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const moeda = MOEDA[pais];
  const impostoLabel = pais === 'PT' ? 'Imposto (Non-EU)' : 'Imposto';

  const loadResumos = useCallback(async () => {
    setLoading(true);
    setSelectedId(null);
    setError(null);
    const data = await fetch(`/api/resumo?pais=${pais}`).then(r => r.json());
    if (Array.isArray(data)) setResumos(data);
    else { setError(data?.error || 'Erro ao carregar dados'); setResumos([]); }
    setLoading(false);
  }, [pais]);

  const loadPendentes = useCallback(async () => {
    try {
      const d = await fetch(`/api/pendentes?pais=${pais}`).then(r => r.json());
      setPendentesCount(Array.isArray(d) ? d.length : 0);
    } catch { setPendentesCount(0); }
  }, [pais]);

  const loadUltimaSync = useCallback(async () => {
    try {
      const d = await fetch('/api/sync/status').then(r => r.json());
      if (d && !d.error) setUltimaSync({ ts: d.ts, tipo: d.tipo });
    } catch { /* ignora */ }
  }, []);

  useEffect(() => { loadResumos(); loadPendentes(); loadUltimaSync(); }, [loadResumos, loadPendentes, loadUltimaSync]);

  // Poll da última sync a cada 5 min (o cron roda no servidor a cada 10 min)
  useEffect(() => {
    const t = setInterval(loadUltimaSync, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [loadUltimaSync]);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch('/api/sync', { method: 'POST' }).then(r => r.json());
      if (res.sucesso) {
        setSyncMsg(`Processadas: ${res.totalProcessadas} · Novas: ${res.novas} · Atualizadas: ${res.atualizadas}`);
        await Promise.all([loadResumos(), loadPendentes(), loadUltimaSync()]);
      } else {
        setSyncMsg('Erro: ' + (res.error || 'desconhecido'));
      }
    } catch (e) {
      setSyncMsg('Erro: ' + String(e));
    }
    setSyncing(false);
  }

  function fmtSyncTs(ts: string | null) {
    if (!ts) return null;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-zinc-400 hover:text-white text-sm">← Países</Link>
          <span className="text-zinc-600">/</span>
          <h1 className="text-xl font-bold">{FLAG[pais]} {NOME_PAIS[pais]}</h1>
        </div>
        <nav className="flex gap-2 items-center">
          <button className="btn btn-primary text-xs" onClick={syncNow} disabled={syncing}>
            {syncing ? 'Sincronizando...' : 'Sincronizar'}
          </button>
          <Link href={`/fechadas?pais=${pais}`} className="btn text-xs">Faturas fechadas</Link>
          <Link href={`/pendentes?pais=${pais}`} className="btn text-xs relative">
            Pendentes
            {pendentesCount > 0 && (
              <span className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full text-[10px] font-extrabold min-w-[18px] h-[18px] leading-[18px] text-center px-1">
                {pendentesCount}
              </span>
            )}
          </Link>
          <Link href="/cadastro" className="btn text-xs">Clientes</Link>
        </nav>
      </div>

      {/* Linha de status do sync */}
      <div className="flex items-center gap-3 mb-6 text-xs text-zinc-500 min-h-[18px]">
        {ultimaSync?.ts && (
          <span>Última sync: {fmtSyncTs(ultimaSync.ts)} ({ultimaSync.tipo || 'automático'})</span>
        )}
        {syncMsg && <span className="text-zinc-400">· {syncMsg}</span>}
      </div>

      {loading ? (
        <div className="text-zinc-400 py-8 text-center">Carregando...</div>
      ) : error ? (
        <div className="text-red-400 py-8 text-center text-sm">Erro: {error}</div>
      ) : resumos.length === 0 ? (
        <div className="text-zinc-500 py-8 text-center">Nenhum cliente com remessas em aberto para {pais}.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Cliente</th><th>Regime</th><th className="amount">AWBs</th>
                <th className="amount">Frete</th><th className="amount">{impostoLabel}</th>
                <th className="amount">Outros</th><th className="amount">Total</th>
                <th>Fechamento</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {resumos.map(r => (
                <React.Fragment key={r.cliente_id}>
                  <tr
                    className={`cursor-pointer ${selectedId === r.cliente_id ? 'bg-indigo-900/30 border-l-2 border-indigo-500' : ''}`}
                    onClick={() => setSelectedId(selectedId === r.cliente_id ? null : r.cliente_id)}
                  >
                    <td className="font-medium">{r.nome}</td>
                    <td>{r.regime ? <span className="pill pill-ok">{r.regime}</span> : '—'}</td>
                    <td className="amount text-zinc-300">{r.qtd_awbs}</td>
                    <td className="amount">{fmt(r.valor_frete, r.moeda || moeda)}</td>
                    <td className="amount">{fmt(r.valor_imposto, r.moeda || moeda)}</td>
                    <td className={`amount ${r.valor_manual < 0 ? 'text-red-400' : r.valor_manual > 0 ? 'text-green-400' : 'text-zinc-600'}`}>
                      {r.valor_manual !== 0 ? fmt(r.valor_manual, r.moeda || moeda) : '—'}
                    </td>
                    <td className="amount font-bold text-indigo-300">{fmt(r.valor_total, r.moeda || moeda)}</td>
                    <td className="whitespace-nowrap"><Janela inicio={r.janela_inicio} fim={r.janela_fim} /></td>
                    <td className="whitespace-nowrap">
                      {r.tms && <span className="pill bg-blue-900/50 text-blue-300 mr-1">TMS</span>}
                      {r.mor && <span className="pill bg-purple-900/50 text-purple-300">MOR</span>}
                      {!r.tms && !r.mor && <span className="text-zinc-600">—</span>}
                    </td>
                  </tr>
                  {selectedId === r.cliente_id && (
                    <tr>
                      <td colSpan={9} className="p-0 border-b-0">
                        <div className="p-3 bg-zinc-950">
                          <ClienteDetail
                            cliente={r}
                            pais={pais}
                            onClose={() => setSelectedId(null)}
                            onFechado={loadResumos}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
