'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

interface Pendente {
  remessa_id: string;
  awb: string;
  email: string;
  pais: string;
  contrato_descricao: string;
  weight: number;
  status: string;
  data: string;
  moeda: string;
  valor_frete: number;
  valor_imposto: number;
}

interface ClienteOpt {
  cliente_id: string;
  nome: string;
  pais: string;
}

function fmt(v: number, moeda: string) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda || 'USD' }).format(v ?? 0);
}

function fmtDate(s: string | null) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 10);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function PendentesInner() {
  const searchParams = useSearchParams();
  const paisParam = searchParams.get('pais') || 'PT';

  const [pais, setPais] = useState(paisParam);
  const [rows, setRows] = useState<Pendente[]>([]);
  const [clientes, setClientes] = useState<ClienteOpt[]>([]);
  const [sel, setSel] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/pendentes?pais=${pais}`).then(r => r.json()).then(d => {
      setRows(Array.isArray(d) ? d : []);
      setLoading(false);
    });
  }, [pais]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch('/api/clientes?all=1').then(r => r.json()).then(d => setClientes(Array.isArray(d) ? d : []));
  }, []);

  async function assign(remessaId: string) {
    const clienteId = sel[remessaId];
    if (!clienteId) { alert('Selecione um cliente.'); return; }
    setBusy(remessaId);
    const res = await fetch('/api/pendentes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'assign', remessaId, clienteId }),
    }).then(r => r.json());
    setBusy(null);
    if (res.ok) load();
    else alert('Erro: ' + (res.error || 'desconhecido'));
  }

  async function ignorar(awb: string) {
    if (!confirm(`Ignorar remessa ${awb}? Ela não aparecerá mais como pendente.`)) return;
    setBusy(awb);
    const res = await fetch('/api/pendentes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ignore', awb }),
    }).then(r => r.json());
    setBusy(null);
    if (res.ok) load();
    else alert('Erro: ' + (res.error || 'desconhecido'));
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Link href={`/dashboard/${pais}`} className="text-zinc-400 hover:text-white text-sm">← {pais}</Link>
          <span className="text-zinc-600">/</span>
          <h1 className="text-xl font-bold">Remessas não identificadas</h1>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary text-xs" onClick={load}>Atualizar</button>
          <Link href="/" className="btn text-xs">Início</Link>
        </div>
      </div>
      <p className="text-zinc-500 text-sm mb-5">Remessas sem cliente vinculado. O país pode vir do contrato mesmo antes da atribuição manual.</p>

      <div className="flex gap-2 mb-5">
        {['PT', 'MX', 'US', 'CL'].map(p => (
          <button key={p} onClick={() => setPais(p)}
            className={`btn ${pais === p ? 'bg-indigo-700 border-indigo-500 text-white' : ''}`}>
            {p}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-zinc-400 py-8 text-center">Carregando...</div>
      ) : (
        <div className="card overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>AWB</th>
                <th>Created At</th>
                <th>Email</th>
                <th>País</th>
                <th>Contrato</th>
                <th className="amount">Frete</th>
                <th className="amount">Imposto</th>
                <th>Status</th>
                <th>Atribuir</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.remessa_id}>
                  <td className="mono whitespace-nowrap">{r.awb}</td>
                  <td className="whitespace-nowrap">{fmtDate(r.data)}</td>
                  <td className="text-xs">{r.email || '—'}</td>
                  <td><span className="pill pill-ok">{r.pais || '—'}</span></td>
                  <td className="text-xs max-w-[200px] truncate">{r.contrato_descricao || '—'}</td>
                  <td className="amount">{fmt(r.valor_frete, r.moeda)}</td>
                  <td className="amount">{fmt(r.valor_imposto, r.moeda)}</td>
                  <td className="text-zinc-400 text-xs">{r.status || '—'}</td>
                  <td>
                    <select
                      value={sel[r.remessa_id] || ''}
                      onChange={e => setSel(s => ({ ...s, [r.remessa_id]: e.target.value }))}
                      className="max-w-[220px]"
                    >
                      <option value="">Selecione</option>
                      {clientes.map(c => (
                        <option key={c.cliente_id} value={c.cliente_id}>{c.nome} ({c.pais})</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="btn btn-primary text-xs" disabled={busy === r.remessa_id} onClick={() => assign(r.remessa_id)}>OK</button>
                  </td>
                  <td>
                    <button className="btn btn-danger text-xs" disabled={busy === r.awb} onClick={() => ignorar(r.awb)} title="Ignorar esta remessa">Ignorar</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={11} className="text-zinc-500 text-center py-6">Nenhuma remessa pendente.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Pendentes() {
  return (
    <Suspense fallback={<div className="text-zinc-400 py-8 text-center">Carregando...</div>}>
      <PendentesInner />
    </Suspense>
  );
}
