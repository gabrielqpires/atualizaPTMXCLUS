export type Pais = 'PT' | 'MX' | 'US' | 'CL';

export interface Cliente {
  cliente_id: string;
  nome: string;
  emails_usuario: string;
  emails_contato: string;
  intermediario_cobranca: string;
  pais: Pais;
  regime: string;
  dias_vencimento: number;
  tms: boolean;
  mor: boolean;
  moeda_pagamento: string;
  ultimo_faturamento: string | null;
}

export interface Remessa {
  remessa_id: string;
  awb: string;
  cliente_id: string;
  pais: string;
  email_usuario: string;
  frete_usd: number;
  imposto_original: number;
  moeda_cotacao: string;
  moeda_cotacao_cambio: number | null;
  moeda_pagamento: string | null;
  moeda_pagamento_cambio: number | null;
  status: string;
  operacao_faturavel: boolean;
  data: string;
  contrato_descricao: string;
  tms: boolean;
  mor: boolean;
  synced_at: string;
  status_codigo: string;
  imposto_eur: number;
  imposto_tipo: string;
  order_id: string;
  weight: number;
  destination: string;
  grupo: string;
  vinculado_em: string | null;
  num_fatura: string | null;
  gateway_pagamento: string | null;
}

export interface ItemManual {
  item_id: string;
  cliente_id: string;
  pais: string;
  descricao: string | null;
  tipo: string;
  valor_frete: number;
  valor_imposto: number;
  moeda: string;
  data: string;
  obs: string | null;
  criado_em: string;
  awb: string | null;
  pais_destino: string | null;
  pedido: string | null;
  remetente: string | null;
  destinatario: string | null;
  ddp_ddu: string | null;
  num_fatura: string | null;
}

export interface RegraFaturamento {
  id: number;
  cliente_id: string;
  tipo_regra: string;
  params: Record<string, unknown>;
}

export interface FaturaFechada {
  fatura_id: string;
  cliente_id: string;
  pais: string;
  nome_cliente: string;
  data_fechamento: string;
  ultimo_faturamento_anterior: string | null;
  qtd_awbs: number;
  valor_frete: number;
  valor_imposto: number;
  valor_manual: number;
  valor_total: number;
  moeda: string;
  remessa_ids: string;
  item_ids: string | null;
  status: string;
  criado_em: string;
  reaberto_em: string | null;
  num_fatura: string | null;
  fechado_por: string | null;
}

export interface ResumoCliente extends Cliente {
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
