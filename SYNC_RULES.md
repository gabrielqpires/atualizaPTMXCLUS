# Regras do Sync Metabase → Supabase (para replicar no n8n)

Extraído de `lib/metabase.ts` (o sync que roda hoje). O objetivo é fazer o
UPSERT em `remessas` **sem apagar nenhuma informação que o painel gerou**
(cliente vinculado, ignorado, país, faturas fechadas).

Chave de conflito: **`remessa_id`** (`ON CONFLICT (remessa_id)`).

---

## 1. Regra de ouro — o que NUNCA pode ser sobrescrito

Numa remessa que **já existe**, o sync **nunca** toca nestas colunas — e o n8n
também não pode incluí-las no UPDATE:

| Coluna | Por quê |
|---|---|
| `num_fatura` | Linka a remessa à fatura fechada. Se zerar, a fatura perde as remessas. **O mais perigoso.** |
| `vinculado_em` | Data em que foi vinculada manualmente a um cliente. |
| `gateway_pagamento` | Preenchido pelo painel, não vem do Metabase. |

E estas colunas são **preservadas/mescladas** (não sobrescritas cegamente) no UPDATE:

| Coluna | Regra no UPDATE | Por quê |
|---|---|---|
| `operacao_faturavel` | mantém o valor atual do banco (`= remessas.operacao_faturavel`) | É a flag de "Ignorar" manual. O `is_operacao_faturavel` do Metabase **não** desativa remessa (senão FOC e outras somem). |
| `cliente_id` | `COALESCE(novo, atual)` — só preenche se o sync achou match; nunca zera | Preserva atribuição manual e match anterior. |
| `pais` | `COALESCE(NULLIF(atual,''), novo)` — mantém o que já tem; só preenche se vazio | Preserva país já definido/inferido. |
| `tms` | `atual OR novo` — uma vez true, fica true | Flag herdada do cliente. |
| `mor` | `atual OR novo` — uma vez true, fica true | Flag herdada do cliente. |

Todo o **resto** é atualizado direto do Metabase (awb, email_usuario, frete_usd,
imposto_original, imposto_eur, imposto_tipo, moeda_cotacao, status,
status_codigo, data, contrato_descricao, order_id, weight, destination, grupo,
synced_at).

Numa remessa **nova** (INSERT): `operacao_faturavel = true` sempre;
`num_fatura`, `vinculado_em`, `gateway_pagamento` ficam NULL.

---

## 2. SQL do UPSERT (usar no node Postgres do n8n, NÃO o upsert padrão)

```sql
INSERT INTO remessas (
  remessa_id, awb, cliente_id, pais, email_usuario, frete_usd, imposto_original,
  imposto_eur, imposto_tipo, moeda_cotacao, status, status_codigo, operacao_faturavel,
  data, contrato_descricao, tms, mor, synced_at, order_id, weight, destination, grupo
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14, $15, $16,
  now(), $17, $18, $19, $20
)
ON CONFLICT (remessa_id) DO UPDATE SET
  awb                = EXCLUDED.awb,
  email_usuario      = EXCLUDED.email_usuario,
  frete_usd          = EXCLUDED.frete_usd,
  imposto_original   = EXCLUDED.imposto_original,
  imposto_eur        = EXCLUDED.imposto_eur,
  imposto_tipo       = EXCLUDED.imposto_tipo,
  moeda_cotacao      = EXCLUDED.moeda_cotacao,
  status             = EXCLUDED.status,
  status_codigo      = EXCLUDED.status_codigo,
  data               = EXCLUDED.data,
  contrato_descricao = EXCLUDED.contrato_descricao,
  order_id           = EXCLUDED.order_id,
  weight             = EXCLUDED.weight,
  destination        = EXCLUDED.destination,
  grupo              = EXCLUDED.grupo,
  synced_at          = now(),
  operacao_faturavel = remessas.operacao_faturavel,           -- preserva ignorado
  tms                = remessas.tms OR EXCLUDED.tms,           -- once true, fica true
  mor                = remessas.mor OR EXCLUDED.mor,
  cliente_id         = COALESCE(EXCLUDED.cliente_id, remessas.cliente_id),
  pais               = COALESCE(NULLIF(remessas.pais,''), EXCLUDED.pais);
```

Ordem dos parâmetros ($1..$20): remessa_id, awb, cliente_id, pais, email_usuario,
frete_usd, imposto_original, imposto_eur, imposto_tipo, moeda_cotacao, status,
status_codigo, data, contrato_descricao, tms, mor, order_id, weight, destination, grupo.

> `operacao_faturavel` é fixo `true` no INSERT (posição 13 dos valores, não é
> parâmetro). `synced_at` é `now()`.

---

## 3. Transformação de cada linha do Metabase (antes do insert)

O Metabase pode devolver a coluna com nomes diferentes; o código testa esses
aliases (usa o primeiro que existir):

| Campo final | Aliases no Metabase | Tratamento |
|---|---|---|
| `remessa_id` | `remessa_id`, `RemessaID`, `id` | **obrigatório** — linha sem isso é descartada |
| `awb` | `awb`, `AWB` | |
| `email_usuario` | `email`, `EmailUsuario`, `usuario_email` | minúsculo + trim |
| `frete_usd` | `Cotacoes Transportadores - Codigo__frete`, `frete_usd`, `FreteUSD` | número (vírgula→ponto) |
| `imposto_original` | ver nota tax_value abaixo; senão `impostos_final`, `ImpostoOriginal`, `imposto_original` | número |
| `imposto_eur` | `impostos_final_eur`, `ImpostoEUR`, `impostos_eur` | número |
| `imposto_tipo` | `imposto_tipo`, `ImpostoTipo` | minúsculo |
| `moeda_cotacao` | `moeda_cotacao`, `MoedaCotacao` | MAIÚSCULO |
| `status` | `status_nome`, `Status`, `status` | |
| `status_codigo` | `status_id`, `StatusCodigo`, `status_codigo` | |
| `data` | `created_at`, `Data`, `data` | |
| `contrato_descricao` | `ContratoDescricao`, `contrato_descricao`, `Contratos - Descricao`, etc. | usado p/ inferir país |
| `tms` | `tms`, `TMS` | boolean |
| `mor` | `mor`, `MOR` | boolean |
| `order_id` | `order_id`, `OrderID`, `order`, `Order`, `pedido` | |
| `weight` | `peso_valor`, `weight`, `Weight`, `peso`, `peso_kg` | número |
| `destination` | `pais_destinatario`, `destination`, `Destination` | |
| `grupo` | ver "inferência de grupo" | |

**tax_value:** o imposto pode vir dentro de um JSON no campo `imposto_detalhes`
(ou `impostos_detalhes` / `ImpostosDetalhes` / `tax_value_details`). Se existir,
extrair `tax_value` de dentro dele e usar como `imposto_original`. Só se não
existir é que se usa `impostos_final`.

**Filtro de data:** descartar linhas cuja `data` seja anterior a `MB_FROM_DATE`
(hoje `2026-05-01`). Linha sem `data` também é descartada.

---

## 4. Inferência de país (a partir de `contrato_descricao`, minúsculo)

Primeiro match vence:
- contém `portugal`, ou palavra isolada `pt`, ou `eur` → **PT**
- contém `united states` / `estados unidos`, ou `usa` / `us` / `usd` → **US**
- contém `chile` ou `cl` → **CL**
- contém `mexico` / `méxico` ou `mx` → **MX**
- senão → **''** (vazio) → vira NULL; a remessa fica sem país e **não aparece
  em nenhum painel de país**. (São as ~1.355 "sem país" de hoje.)

---

## 5. Inferência de grupo (EU / Non-EU)

Base: `destino_bloco_eu` (ou `destino_bloco` / `Group` / `group`); se já vier
`EU` ou `Non-EU`, usa direto. Senão olha o país de destino (`destination`):
se estiver na lista de países da UE → `EU`, senão `Non-EU`, vazio se sem destino.

Lista UE: AT, BE, BG, CY, CZ, DE, DK, EE, ES, FI, FR, GR, HR, HU, IE, IT, LT,
LU, LV, MT, NL, PL, PT, RO, SE, SI, SK.

---

## 6. Match de cliente (email → cliente_id)

1. Montar um mapa a partir da tabela `clientes`: para cada cliente, dividir
   `emails_usuario` por vírgula, normalizar (minúsculo+trim), e mapear cada
   email → lista de `{cliente_id, pais, tms, mor}`.
2. Para a remessa, pegar candidatos = mapa[email da remessa]:
   - 0 candidatos → sem cliente (cliente_id NULL).
   - 1 candidato → usa ele.
   - vários → prefere o de mesmo `pais` da remessa; se nenhum, usa o primeiro.
3. Com match: `cliente_id` = do match; `pais` da remessa = `pais` inferido OU
   `pais` do match; `tms`/`mor` = valor do Metabase **OU** flag do cliente.

> Se preferir simplificar no n8n: pode inserir só os campos do Metabase e deixar
> `cliente_id`/`tms`/`mor` como NULL/false no INSERT — o `COALESCE` do UPDATE
> preserva o que o painel já vinculou, e o match por email pode virar um passo
> SQL separado depois. O que **não** pode é sobrescrever `cliente_id` com NULL.

---

## 7. Ao final: atualizar o `sync_state` (para a notificação do painel)

```sql
UPDATE sync_state
SET last_sync = now(), tipo = 'automatico',
    stats = '{"totalProcessadas":N,"novas":N,"atualizadas":N,"comClienteEncontrado":N,"comPaisContrato":N}'::jsonb
WHERE id = 1;
```

Se não fizer isso, o painel continua funcionando, mas a linha "Última sync" não
atualiza.
