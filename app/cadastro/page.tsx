'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Cliente {
  cliente_id: string;
  nome: string;
  pais: string;
  regime: string;
  moeda_pagamento: string;
  tms: boolean;
  mor: boolean;
}

export default function Cadastro() {
  const [pais, setPais] = useState('PT');
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const [nome, setNome] = useState('');
  const [regime, setRegime] = useState('DDP');
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    fetch(`/api/clientes?pais=${pais}`).then(r => r.json()).then(d => {
      setClientes(d);
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, [pais]);

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch('/api/clientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, pais, regime }),
    });
    setNome('');
    setSaving(false);
    setShowForm(false);
    load();
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Clientes</h1>
        <Link href="/" className="btn text-xs">← Dashboard</Link>
      </div>

      <div className="flex gap-2 mb-5">
        {['PT', 'MX', 'US', 'CL'].map(p => (
          <button
            key={p}
            onClick={() => setPais(p)}
            className={`btn ${pais === p ? 'bg-indigo-700 border-indigo-500 text-white' : ''}`}
          >
            {p}
          </button>
        ))}
        <button className="btn btn-primary ml-auto" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancelar' : '+ Novo Cliente'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={salvar} className="card p-4 mb-5 grid grid-cols-3 gap-3">
          <input className="col-span-2" placeholder="Nome do cliente" value={nome} onChange={e => setNome(e.target.value)} required />
          <select value={regime} onChange={e => setRegime(e.target.value)}>
            <option>DDP</option>
            <option>DDU</option>
            <option>DAP</option>
          </select>
          <button type="submit" className="btn btn-primary col-span-3" disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-zinc-400 py-8 text-center">Carregando...</div>
      ) : (
        <div className="card overflow-hidden">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>País</th>
                <th>Regime</th>
                <th>Moeda</th>
                <th>TMS</th>
                <th>MOR</th>
              </tr>
            </thead>
            <tbody>
              {clientes.map(c => (
                <tr key={c.cliente_id}>
                  <td className="font-medium">{c.nome}</td>
                  <td><span className="pill pill-ok">{c.pais}</span></td>
                  <td>{c.regime}</td>
                  <td>{c.moeda_pagamento}</td>
                  <td>{c.tms ? '✓' : '—'}</td>
                  <td>{c.mor ? '✓' : '—'}</td>
                </tr>
              ))}
              {clientes.length === 0 && (
                <tr><td colSpan={6} className="text-zinc-500 text-center py-6">Nenhum cliente.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
