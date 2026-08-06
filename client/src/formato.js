// Dinheiro sempre com as duas casas: R$ 100,50, R$ 100,00, R$ 0,00. Nunca
// arredondado para o real cheio, nem em resumo, gráfico ou campo de edição.
const moeda = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const inteiro = new Intl.NumberFormat('pt-BR');

export const brl = (v) => moeda.format(Number(v) || 0);
export const num = (v) => inteiro.format(Number(v) || 0);

/**
 * Valor monetário como texto de campo de entrada — as mesmas duas casas da
 * leitura, só que com ponto decimal, que é o que `input[type=number]` aceita.
 * Vazio continua vazio: campo em branco não é o mesmo que zero.
 */
export const valorEntrada = (v) => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
};

export const pct = (v, casas = 1) => (v === null || v === undefined
  ? '—'
  : `${Number(v).toFixed(casas).replace('.', ',')}%`);

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function rotuloMes(mes, { curto = false } = {}) {
  if (!mes) return '—';
  const [ano, m] = mes.split('-').map(Number);
  const nome = MESES[m - 1] || '?';
  const capitalizado = nome.charAt(0).toUpperCase() + nome.slice(1);
  return curto ? `${capitalizado.slice(0, 3)}/${String(ano).slice(2)}` : `${capitalizado} de ${ano}`;
}

export function mesAtual(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function somarMeses(mes, n) {
  const [ano, m] = mes.split('-').map(Number);
  const total = ano * 12 + (m - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * Situação de uma compra parcelada em relação ao mês que está sendo olhado:
 * `futuro` (a primeira parcela ainda vem), `ativo` (cai neste mês) ou `quitado`
 * (a última parcela já passou). `parcela` é o número da parcela do mês.
 */
export function situacaoParcelamento(p, mes) {
  const [a1, m1] = p.mes_inicio.split('-').map(Number);
  const [a2, m2] = mes.split('-').map(Number);
  const indice = (a2 * 12 + m2) - (a1 * 12 + m1);
  if (indice < 0) return { estado: 'futuro', parcela: 0 };
  if (indice >= p.parcelas) return { estado: 'quitado', parcela: p.parcelas };
  return { estado: 'ativo', parcela: indice + 1 };
}

/** Texto da vigência de um item recorrente, como aparece nas listagens. */
export function vigencia(inicio, fim) {
  if (!fim) return `desde ${rotuloMes(inicio, { curto: true })}`;
  if (fim === inicio) return `só em ${rotuloMes(inicio, { curto: true })}`;
  return `${rotuloMes(inicio, { curto: true })} → ${rotuloMes(fim, { curto: true })}`;
}

export const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sábado'];

const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Rótulo de um dia para cabeçalho de agrupamento.
 * "Hoje" e "Ontem" poupam o leitor de converter a data mentalmente; o resto vem
 * por extenso com o dia da semana, que ajuda a lembrar do gasto.
 */
export function rotuloDia(iso, mesReferencia) {
  if (!iso) return { titulo: 'Sem data', detalhe: 'lançamentos sem dia informado' };

  const [ano, mes, dia] = iso.split('-').map(Number);
  // Meio-dia evita que fuso horário empurre a data para o dia anterior.
  const data = new Date(ano, mes - 1, dia, 12);
  const hoje = hojeISO();

  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);
  const ontemISO = `${ontem.getFullYear()}-${String(ontem.getMonth() + 1).padStart(2, '0')}-${String(ontem.getDate()).padStart(2, '0')}`;

  // Parcela comprada em outro mês mantém a data original da compra, que pode ser
  // de outro ano. Sem o ano, "26 de novembro" de 2025 e de 2026 ficariam iguais.
  const foraDoMes = mesReferencia && iso.slice(0, 7) !== mesReferencia;
  const porExtenso = `${String(dia).padStart(2, '0')} de ${MESES[mes - 1]}${foraDoMes ? ` de ${ano}` : ''}`;

  if (iso === hoje) return { titulo: 'Hoje', detalhe: porExtenso };
  if (iso === ontemISO) return { titulo: 'Ontem', detalhe: porExtenso };

  return { titulo: porExtenso, detalhe: DIAS[data.getDay()] };
}
