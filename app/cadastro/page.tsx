'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';

type Pais = 'PT' | 'MX' | 'US' | 'CL';
type Aba = 'cadastrar' | 'lista';
type AbaCadastro = 'individual' | 'lote';
type MsgKind = 'ok' | 'err';

interface Cliente {
  cliente_id: string;
  nome: string;
  emails_usuario: string | null;
  emails_contato: string | null;
  intermediario_cobranca: string | null;
  pais: string;
  regime: string;
  dias_vencimento: number | null;
  moeda_pagamento: string | null;
  tms: boolean;
  mor: boolean;
}

interface ClienteForm {
  nome: string;
  emailsUsuario: string;
  emailsContato: string;
  intermediarioCobranca: string;
  regime: string;
  diasVencimento: string;
  moedaPagamento: string;
  tms: boolean;
  mor: boolean;
}

const PAISES: Pais[] = ['PT', 'US', 'CL', 'MX'];
const REGIMES = ['por_remessa', 'semanal', 'quinzenal', 'mensal'];
const MOEDAS = ['EUR', 'USD', 'MXN'];

function defaultMoedaPais(pais: string) {
  if (pais === 'PT') return 'EUR';
  if (pais === 'MX') return 'MXN';
  return 'USD';
}

function emptyForm(pais: string): ClienteForm {
  return {
    nome: '',
    emailsUsuario: '',
    emailsContato: '',
    intermediarioCobranca: '',
    regime: 'quinzenal',
    diasVencimento: '5',
    moedaPagamento: defaultMoedaPais(pais),
    tms: false,
    mor: false,
  };
}

function formFromCliente(c: Cliente): ClienteForm {
  return {
    nome: c.nome || '',
    emailsUsuario: c.emails_usuario || '',
    emailsContato: c.emails_contato || '',
    intermediarioCobranca: c.intermediario_cobranca || '',
    regime: c.regime || 'quinzenal',
    diasVencimento: String(c.dias_vencimento || 5),
    moedaPagamento: c.moeda_pagamento || defaultMoedaPais(c.pais),
    tms: !!c.tms,
    mor: !!c.mor,
  };
}

function parseBoolText(value: string) {
  const text = value.trim().toLowerCase();
  return text === 'true' || text === 'sim' || text === '1' || text === 'yes';
}

function parseLote(text: string) {
  return text.split('\n')
    .map(row => row.trim())
    .filter(Boolean)
    .map(row => {
      const p = row.split(';');
      return {
        nome: (p[0] || '').trim(),
        emailsUsuario: (p[1] || '').trim(),
        emailsContato: (p[2] || '').trim(),
        intermediarioCobranca: (p[3] || '').trim(),
        regime: (p[4] || 'quinzenal').trim(),
        diasVencimento: Number(p[5]) || 5,
        tms: parseBoolText(p[6] || ''),
        mor: parseBoolText(p[7] || ''),
        moedaPagamento: (p[8] || '').trim(),
      };
    });
}

function Msg({ msg }: { msg: { text: string; kind: MsgKind } | null }) {
  if (!msg) return null;
  return (
    <div className={`mt-3 rounded px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-green-950/50 text-green-300 border border-green-900' : 'bg-red-950/50 text-red-300 border border-red-900'}`}>
      {msg.text}
    </div>
  );
}

export default function Cadastro() {
  const [pais, setPais] = useState<Pais>('PT');
  const [aba, setAba] = useState<Aba>('cadastrar');
  const [abaCadastro, setAbaCadastro] = useState<AbaCadastro>('individual');
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loadingLista, setLoadingLista] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ClienteForm>(() => emptyForm('PT'));
  const [lote, setLote] = useState('');
  const [msgInd, setMsgInd] = useState<{ text: string; kind: MsgKind } | null>(null);
  const [msgLote, setMsgLote] = useState<{ text: string; kind: MsgKind } | null>(null);
  const [msgLista, setMsgLista] = useState<{ text: string; kind: MsgKind } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ClienteForm>(() => emptyForm('PT'));
  const [savingEdit, setSavingEdit] = useState(false);

  async function loadLista(paisAtual = pais) {
    setLoadingLista(true);
    setMsgLista(null);
    try {
      const res = await fetch(`/api/clientes?pais=${paisAtual}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao carregar clientes.');
      setClientes(Array.isArray(data) ? data : []);
    } catch (err) {
      setMsgLista({ text: err instanceof Error ? err.message : 'Erro ao carregar clientes.', kind: 'err' });
    } finally {
      setLoadingLista(false);
    }
  }

  function trocarPais(nextPais: Pais) {
    setPais(nextPais);
    setForm(emptyForm(nextPais));
    setEditId(null);
    setClientes([]);
    setMsgInd(null);
    setMsgLote(null);
    setMsgLista(null);
    if (aba === 'lista') void loadLista(nextPais);
  }

  function abrirAba(nextAba: Aba) {
    setAba(nextAba);
    if (nextAba === 'lista') void loadLista();
  }

  function updateForm(field: keyof ClienteForm, value: string | boolean) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  function updateEdit(field: keyof ClienteForm, value: string | boolean) {
    setEditForm(prev => ({ ...prev, [field]: value }));
  }

  async function salvarIndividual(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsgInd({ text: 'Salvando...', kind: 'ok' });
    try {
      const res = await fetch('/api/clientes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pais, ...form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao criar cliente.');
      setMsgInd({
        text: `Cliente criado: ${data.clienteId || data.id}. Remessas atribuidas: ${data.remessasAtribuidas || 0}.`,
        kind: 'ok',
      });
      setForm(emptyForm(pais));
      if (aba === 'lista') void loadLista();
    } catch (err) {
      setMsgInd({ text: err instanceof Error ? err.message : 'Erro ao criar cliente.', kind: 'err' });
    } finally {
      setSaving(false);
    }
  }

  async function salvarLote(e: React.FormEvent) {
    e.preventDefault();
    const clientesLote = parseLote(lote);
    if (!clientesLote.length) {
      setMsgLote({ text: 'Cole ao menos uma linha de cliente.', kind: 'err' });
      return;
    }
    setSaving(true);
    setMsgLote({ text: 'Salvando...', kind: 'ok' });
    try {
      const res = await fetch('/api/clientes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pais, clientes: clientesLote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao criar lote.');
      setMsgLote({
        text: `${data.totalClientes || clientesLote.length} clientes criados. Remessas atribuidas: ${data.remessasAtribuidas || 0}.`,
        kind: 'ok',
      });
      setLote('');
      if (aba === 'lista') void loadLista();
    } catch (err) {
      setMsgLote({ text: err instanceof Error ? err.message : 'Erro ao criar lote.', kind: 'err' });
    } finally {
      setSaving(false);
    }
  }

  function editarCliente(cliente: Cliente) {
    setEditId(cliente.cliente_id);
    setEditForm(formFromCliente(cliente));
    setMsgLista(null);
  }

  function cancelarEdicao() {
    setEditId(null);
    setEditForm(emptyForm(pais));
  }

  async function salvarEdicao(e: React.FormEvent) {
    e.preventDefault();
    if (!editId) return;
    setSavingEdit(true);
    setMsgLista(null);
    try {
      const res = await fetch('/api/clientes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clienteId: editId, ...editForm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao atualizar cliente.');
      cancelarEdicao();
      await loadLista();
      setMsgLista({
        text: `Cliente atualizado. Remessas atribuidas: ${data.remessasAtribuidas || 0}.`,
        kind: 'ok',
      });
    } catch (err) {
      setMsgLista({ text: err instanceof Error ? err.message : 'Erro ao atualizar cliente.', kind: 'err' });
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <header className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <div className="text-xs text-zinc-500 mb-1 tracking-widest uppercase">ShipSmart / Faturamento</div>
          <h1 className="text-2xl font-bold">Clientes - {pais}</h1>
        </div>
        <Link href={`/dashboard/${pais}`} className="btn text-xs">Voltar</Link>
      </header>

      <div className="flex gap-2 flex-wrap mb-5">
        {PAISES.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => trocarPais(p)}
            className={`btn text-xs ${pais === p ? 'bg-indigo-700 border-indigo-500 text-white' : ''}`}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="flex gap-2 mb-5">
        <button type="button" className={`btn ${aba === 'cadastrar' ? 'btn-primary' : ''}`} onClick={() => abrirAba('cadastrar')}>Cadastrar</button>
        <button type="button" className={`btn ${aba === 'lista' ? 'btn-primary' : ''}`} onClick={() => abrirAba('lista')}>Clientes cadastrados</button>
      </div>

      {aba === 'cadastrar' && (
        <section className="card p-5 max-w-3xl">
          <div className="flex gap-2 mb-4">
            <button type="button" className={`btn text-xs ${abaCadastro === 'individual' ? 'btn-primary' : ''}`} onClick={() => setAbaCadastro('individual')}>Individual</button>
            <button type="button" className={`btn text-xs ${abaCadastro === 'lote' ? 'btn-primary' : ''}`} onClick={() => setAbaCadastro('lote')}>Em lote</button>
          </div>

          {abaCadastro === 'individual' ? (
            <form onSubmit={salvarIndividual}>
              <label>Nome</label>
              <input type="text" value={form.nome} onChange={e => updateForm('nome', e.target.value)} required />

              <label>EmailsUsuario</label>
              <input type="text" value={form.emailsUsuario} onChange={e => updateForm('emailsUsuario', e.target.value)} placeholder="login1@cliente.com, login2@cliente.com" required />

              <label>EmailsContato</label>
              <input type="text" value={form.emailsContato} onChange={e => updateForm('emailsContato', e.target.value)} />

              <label>IntermediarioCobranca</label>
              <input type="text" value={form.intermediarioCobranca} onChange={e => updateForm('intermediarioCobranca', e.target.value)} />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label>Regime</label>
                  <select value={form.regime} onChange={e => updateForm('regime', e.target.value)}>
                    {REGIMES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label>DiasVencimento</label>
                  <input type="number" value={form.diasVencimento} onChange={e => updateForm('diasVencimento', e.target.value)} />
                </div>
                <div>
                  <label>Moeda pagamento</label>
                  <select value={form.moedaPagamento} onChange={e => updateForm('moedaPagamento', e.target.value)}>
                    {MOEDAS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex gap-5 mt-4">
                <label className="inline-flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={form.tms} onChange={e => updateForm('tms', e.target.checked)} className="w-auto" /> tms</label>
                <label className="inline-flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={form.mor} onChange={e => updateForm('mor', e.target.checked)} className="w-auto" /> mor</label>
              </div>

              <button type="submit" className="btn btn-primary mt-5" disabled={saving}>{saving ? 'Salvando...' : 'Cadastrar'}</button>
              <Msg msg={msgInd} />
            </form>
          ) : (
            <form onSubmit={salvarLote}>
              <p className="text-zinc-400 text-sm mb-3">Cole uma linha por cliente: nome;emailsUsuario;emailsContato;intermediario;regime;dias;tms;mor;moedaPagamento</p>
              <textarea
                value={lote}
                onChange={e => setLote(e.target.value)}
                placeholder="Cliente A;user@a.com;financeiro@a.com;;quinzenal;5;true;false;EUR"
                className="min-h-36 font-mono"
              />
              <button type="submit" className="btn btn-primary mt-4" disabled={saving}>{saving ? 'Salvando...' : 'Cadastrar lote'}</button>
              <Msg msg={msgLote} />
            </form>
          )}
        </section>
      )}

      {aba === 'lista' && (
        <section>
          <div className="card overflow-hidden">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Emails usuario</th>
                  <th>Regime</th>
                  <th>Dias</th>
                  <th>Moeda</th>
                  <th>TMS</th>
                  <th>MOR</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loadingLista && (
                  <tr><td colSpan={8} className="text-zinc-500 text-center py-6">Carregando...</td></tr>
                )}
                {!loadingLista && clientes.length === 0 && (
                  <tr><td colSpan={8} className="text-zinc-500 text-center py-6">Nenhum cliente cadastrado.</td></tr>
                )}
                {!loadingLista && clientes.map(c => (
                  <Fragment key={c.cliente_id}>
                    <tr key={c.cliente_id}>
                      <td className="font-medium">{c.nome}</td>
                      <td className="text-xs text-zinc-400">{c.emails_usuario || ''}</td>
                      <td>{c.regime}</td>
                      <td>{c.dias_vencimento || ''}</td>
                      <td>{c.moeda_pagamento || ''}</td>
                      <td>{c.tms ? '✓' : '—'}</td>
                      <td>{c.mor ? '✓' : '—'}</td>
                      <td><button type="button" className="btn text-xs" onClick={() => editarCliente(c)}>Editar</button></td>
                    </tr>
                    {editId === c.cliente_id && (
                      <tr key={`${c.cliente_id}-edit`}>
                        <td colSpan={8} className="bg-indigo-950/30 border-b-2 border-indigo-700">
                          <form onSubmit={salvarEdicao} className="space-y-3 py-1">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div><label className="text-xs">Nome</label><input value={editForm.nome} onChange={e => updateEdit('nome', e.target.value)} required /></div>
                              <div><label className="text-xs">Regime</label><select value={editForm.regime} onChange={e => updateEdit('regime', e.target.value)}>{REGIMES.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
                              <div><label className="text-xs">Emails usuario</label><input value={editForm.emailsUsuario} onChange={e => updateEdit('emailsUsuario', e.target.value)} required /></div>
                              <div><label className="text-xs">Dias vencimento</label><input type="number" value={editForm.diasVencimento} onChange={e => updateEdit('diasVencimento', e.target.value)} /></div>
                              <div><label className="text-xs">Moeda pagamento</label><select value={editForm.moedaPagamento} onChange={e => updateEdit('moedaPagamento', e.target.value)}>{MOEDAS.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
                              <div><label className="text-xs">Emails contato</label><input value={editForm.emailsContato} onChange={e => updateEdit('emailsContato', e.target.value)} /></div>
                              <div><label className="text-xs">Intermediario cobranca</label><input value={editForm.intermediarioCobranca} onChange={e => updateEdit('intermediarioCobranca', e.target.value)} /></div>
                            </div>
                            <div className="flex gap-5">
                              <label className="inline-flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={editForm.tms} onChange={e => updateEdit('tms', e.target.checked)} className="w-auto" /> tms</label>
                              <label className="inline-flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={editForm.mor} onChange={e => updateEdit('mor', e.target.checked)} className="w-auto" /> mor</label>
                            </div>
                            <div className="flex gap-2">
                              <button className="btn btn-primary text-xs" disabled={savingEdit}>{savingEdit ? 'Salvando...' : 'Salvar'}</button>
                              <button type="button" className="btn text-xs" onClick={cancelarEdicao}>Cancelar</button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Msg msg={msgLista} />
        </section>
      )}
    </div>
  );
}
