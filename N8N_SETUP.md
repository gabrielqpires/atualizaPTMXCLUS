# n8n — Sync Metabase → Supabase (node a node)

8 nós. Credenciais necessárias no n8n:
- **Postgres** (Supabase): host `aws-1-...pooler.supabase.com`, port 5432, db `postgres`,
  user/senha do seu `DATABASE_URL`, SSL on.
- Metabase: base URL `https://shipsmart.metabaseapp.com`, user `henrique.vital@shipsmart.global`,
  senha, card id `15629`. (Melhor guardar como credenciais/variáveis do n8n, não hardcode.)

Fluxo linear: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**

---

## Nó 1 — Schedule Trigger
- Tipo: **Schedule Trigger**
- Regra: a cada 1 hora (ou o intervalo que quiser).

## Nó 2 — Postgres: Get Clientes
- Tipo: **Postgres** → Operation **Execute Query**
- Query:
  ```sql
  SELECT cliente_id, emails_usuario, pais, tms, mor FROM clientes;
  ```
- Retorna N itens (um por cliente). O nó de Transform vai ler todos via `$()`.

## Nó 3 — HTTP Request: Metabase Login
- Tipo: **HTTP Request**
- Method **POST**, URL `https://shipsmart.metabaseapp.com/api/session`
- Body: JSON → `{ "username": "henrique.vital@shipsmart.global", "password": "SUA_SENHA" }`
- Header: `Content-Type: application/json`
- **Settings → Execute Once: LIGADO** (senão roda 1x por cliente do nó 2).
- Saída: `{ "id": "<session-token>" }`

## Nó 4 — HTTP Request: Metabase Query
- Tipo: **HTTP Request**
- Method **POST**, URL `https://shipsmart.metabaseapp.com/api/card/15629/query/json`
- Headers:
  - `Content-Type: application/json`
  - `X-Metabase-Session: {{ $json.id }}`
- Options → Response: pode deixar padrão. A resposta é um **array** de linhas.

## Nó 5 — Code: Transform (JS)
- Tipo: **Code** (Run Once for All Items), linguagem JavaScript.
- Faz: filtro por data, de-para dos campos, inferência de país/grupo, match de cliente.
- Cole:

```js
// linhas do Metabase (o HTTP pode devolver array em 1 item OU já dividido em itens)
let rows = [];
if (items.length === 1 && Array.isArray(items[0].json)) rows = items[0].json;
else if (items.length === 1 && items[0].json && Array.isArray(items[0].json.data)) rows = items[0].json.data;
else rows = items.map(i => i.json);

// clientes (do nó 2)
const clientes = $('Get Clientes').all().map(i => i.json);
const emailMap = {};
for (const c of clientes) {
  for (const raw of String(c.emails_usuario || '').split(',')) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    (emailMap[e] = emailMap[e] || []).push({ clienteId: c.cliente_id, pais: c.pais, tms: !!c.tms, mor: !!c.mor });
  }
}

const FROM = new Date('2026-05-01T00:00:00').getTime();
const EU = new Set(['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK']);
const num = v => { const n = Number(String(v ?? '').replace(',', '.').trim()); return isNaN(n) ? 0 : n; };
const pick = (r, ks) => { for (const k of ks) if (r[k] !== undefined && r[k] !== null) return r[k]; return ''; };
const toBool = v => v === true || ['true','sim','1','yes'].includes(String(v ?? '').trim().toLowerCase());
function taxValue(v){ if(v==null||v==='')return null; if(typeof v==='object'&&v.tax_value!==undefined)return num(v.tax_value); try{const p=JSON.parse(String(v)); if(p&&p.tax_value!==undefined)return num(p.tax_value);}catch(e){} const m=String(v).match(/tax_value["']?\s*:\s*["']?(-?\d+(?:[.,]\d+)?)/i); return m?num(m[1]):null; }
function inferPais(d){ const t=String(d||'').toLowerCase(); if(!t)return ''; if(t.includes('portugal')||/\bpt\b/.test(t)||/\beur\b/.test(t))return 'PT'; if(t.includes('united states')||t.includes('estados unidos')||/\busa\b/.test(t)||/\bus\b/.test(t)||/\busd\b/.test(t))return 'US'; if(t.includes('chile')||/\bcl\b/.test(t))return 'CL'; if(t.includes('mexico')||t.includes('méxico')||/\bmx\b/.test(t))return 'MX'; return ''; }
function inferGrupo(base, dest){ const b=String(base||'').trim(); if(b==='EU'||b==='Non-EU')return b; const p=String(dest||'').toUpperCase().trim(); if(!p)return ''; return EU.has(p)?'EU':'Non-EU'; }

const out = [];
for (const row of rows) {
  const remessaId = String(pick(row, ['remessa_id','RemessaID','id']) || '');
  if (!remessaId) continue;
  const dataRaw = pick(row, ['created_at','Data','data']);
  if (!dataRaw) continue;
  const d = new Date(dataRaw);
  if (isNaN(d.getTime()) || d.getTime() < FROM) continue;

  const email = String(pick(row, ['email','EmailUsuario','usuario_email']) || '').trim().toLowerCase();
  const contrato = String(pick(row, ['ContratoDescricao','contrato_descricao','contratos_descricao','Contratos - Descricao','Contratos - Descrição']) || '');
  const destino = String(pick(row, ['pais_destinatario','destination','Destination']) || '');
  const tv = taxValue(pick(row, ['imposto_detalhes','impostos_detalhes','ImpostosDetalhes','tax_value_details']));
  const paisInf = inferPais(contrato);

  const cand = emailMap[email] || [];
  let match = null;
  if (cand.length === 1) match = cand[0];
  else if (cand.length > 1) match = cand.find(c => c.pais === paisInf) || cand[0];

  out.push({ json: {
    remessa_id: remessaId,
    awb: String(pick(row,['awb','AWB'])||''),
    cliente_id: match ? match.clienteId : null,
    pais: paisInf || (match ? match.pais : '') || null,
    email_usuario: email,
    frete_usd: num(pick(row,['Cotacoes Transportadores - Codigo__frete','frete_usd','FreteUSD'])),
    imposto_original: tv !== null ? tv : num(pick(row,['impostos_final','ImpostoOriginal','imposto_original'])),
    imposto_eur: num(pick(row,['impostos_final_eur','ImpostoEUR','impostos_eur'])),
    imposto_tipo: String(pick(row,['imposto_tipo','ImpostoTipo'])||'').toLowerCase(),
    moeda_cotacao: String(pick(row,['moeda_cotacao','MoedaCotacao'])||'').toUpperCase(),
    status: String(pick(row,['status_nome','Status','status'])||''),
    status_codigo: String(pick(row,['status_id','StatusCodigo','status_codigo'])||''),
    data: dataRaw,
    contrato_descricao: contrato,
    tms: toBool(pick(row,['tms','TMS'])) || (match ? match.tms : false),
    mor: toBool(pick(row,['mor','MOR'])) || (match ? match.mor : false),
    order_id: String(pick(row,['order_id','OrderID','order','Order','pedido'])||''),
    weight: num(pick(row,['peso_valor','weight','Weight','peso','peso_kg'])),
    destination: destino,
    grupo: inferGrupo(pick(row,['destino_bloco_eu','destino_bloco','Group','group']), destino),
  }});
}
return out;
```

## Nó 6 — Postgres: Upsert
- Tipo: **Postgres** → Operation **Execute Query** (NÃO usar "Insert"/"Upsert" pronto).
- Roda 1x por item (por remessa).
- Query:
```sql
INSERT INTO remessas (
  remessa_id, awb, cliente_id, pais, email_usuario, frete_usd, imposto_original,
  imposto_eur, imposto_tipo, moeda_cotacao, status, status_codigo, operacao_faturavel,
  data, contrato_descricao, tms, mor, synced_at, order_id, weight, destination, grupo
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,now(),$17,$18,$19,$20)
ON CONFLICT (remessa_id) DO UPDATE SET
  awb=EXCLUDED.awb, email_usuario=EXCLUDED.email_usuario, frete_usd=EXCLUDED.frete_usd,
  imposto_original=EXCLUDED.imposto_original, imposto_eur=EXCLUDED.imposto_eur,
  imposto_tipo=EXCLUDED.imposto_tipo, moeda_cotacao=EXCLUDED.moeda_cotacao,
  status=EXCLUDED.status, status_codigo=EXCLUDED.status_codigo, data=EXCLUDED.data,
  contrato_descricao=EXCLUDED.contrato_descricao, order_id=EXCLUDED.order_id,
  weight=EXCLUDED.weight, destination=EXCLUDED.destination, grupo=EXCLUDED.grupo,
  synced_at=now(),
  operacao_faturavel=remessas.operacao_faturavel,
  tms=remessas.tms OR EXCLUDED.tms, mor=remessas.mor OR EXCLUDED.mor,
  cliente_id=COALESCE(EXCLUDED.cliente_id, remessas.cliente_id),
  pais=COALESCE(NULLIF(remessas.pais,''), EXCLUDED.pais);
```
- **Query Parameters** (na ordem $1..$20), cole como expressão:
```
{{ [$json.remessa_id, $json.awb, $json.cliente_id, $json.pais, $json.email_usuario, $json.frete_usd, $json.imposto_original, $json.imposto_eur, $json.imposto_tipo, $json.moeda_cotacao, $json.status, $json.status_codigo, $json.data, $json.contrato_descricao, $json.tms, $json.mor, $json.order_id, $json.weight, $json.destination, $json.grupo] }}
```
> Nunca inclua `num_fatura`, `vinculado_em`, `gateway_pagamento` — ficam intactos.

## Nó 7 — Code: Summarize
- Tipo: **Code**. Colapsa os N itens em 1 (pro sync_state rodar 1x):
```js
return [{ json: { total: items.length } }];
```

## Nó 8 — Postgres: Update sync_state
- Tipo: **Postgres** → **Execute Query**
```sql
UPDATE sync_state
SET last_sync = now(), tipo = 'automatico',
    stats = jsonb_build_object('totalProcessadas', $1::int)
WHERE id = 1;
```
- Query Parameters: `{{ [$json.total] }}`

---

## Notas
- **Desligar o cron do Actions** depois que o n8n estiver rodando (senão os dois
  syncam). É só desabilitar o workflow em GitHub → Actions.
- Nó 6 rodando 1 query por remessa (~3.4k) leva alguns minutos — ok pra job horário.
  Se quiser acelerar, dá pra montar INSERT multi-linha em lotes de ~400 num Code node.
- Teste primeiro com o card apontando poucos dias (ou `MB_FROM_DATE` recente) pra
  validar sem processar tudo.
