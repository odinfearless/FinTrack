/**
 * Sugestão de categoria a partir da descrição de um lançamento.
 *
 * Vive fora dos leitores porque os dois precisam dela e precisam da mesma:
 * "SABESP" tem que cair em Casa venha ela da fatura do cartão ou do extrato da
 * conta. Com uma tabela em cada leitor, a mesma compra seria classificada de
 * dois jeitos dependendo de por onde entrou.
 */

export const normalizar = (v) => String(v ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Apelidos de estabelecimento por categoria. A chave é procurada entre as
 * categorias cadastradas pelos seis primeiros caracteres, então ela precisa
 * bater com o começo do nome que o app semeia — não com ele inteiro.
 */
const APELIDOS = {
  ifood: ['ifood', 'rappi', 'ze delivery'],
  mercado: ['supermerc', 'atacad', 'carrefour', 'assai', 'pao de acucar', 'hortifruti'],
  combustivel: ['posto', 'shell', 'ipiranga', 'petrobras', 'br distrib', 'combusti'],
  uber: ['uber', '99app', '99 tecnologia', 'cabify', 'taxi'],
  saude: ['farmac', 'drogaria', 'droga raia', 'panvel', 'laborat', 'clinica', 'hospital', 'odonto',
    'unimed', 'amil', 'bradesco saude', 'sulamerica'],
  'compras online': ['mercado livre', 'mercadolivre', 'mercpago', 'amazon', 'magazine', 'shopee', 'aliexpress', 'americanas'],
  assinaturas: ['spotify', 'netflix', 'disney', 'hbo max', 'youtube', 'apple.com', 'prime video'],
  lazer: ['cinema', 'ingresso', 'teatro', 'restaurante', 'lanchonete', 'padaria'],
  // Concessionárias e contas do imóvel. Entram aqui por causa do extrato, onde
  // esse é o grosso do débito automático, mas valem também para o cartão.
  casa: ['eletropaulo', 'enel', 'cpfl', 'cemig', 'copel', 'light serv', 'energia',
    'sabesp', 'sanepar', 'copasa', 'cedae', 'comgas', 'naturgy',
    'claro', 'vivo', 'telefonica', 'tim ', 'oi fixo', 'net serv', 'internet',
    'condominio', 'aluguel', 'iptu', 'seguro resid'],
};

/**
 * Compara a descrição com o nome das categorias cadastradas e com os apelidos.
 * `categorias` é a lista do banco: sem ela não há o que sugerir.
 */
export function sugerirCategoria(descricao, categorias = []) {
  const alvo = normalizar(descricao);
  if (!alvo) return null;

  // Todos os candidatos disputam, e vence o termo mais longo — assim
  // "mercado livre" ganha de "mercado" e a compra não cai em supermercado.
  const candidatos = [];

  for (const c of categorias) {
    const nome = normalizar(c.nome);
    if (nome.length >= 3 && alvo.includes(nome)) candidatos.push({ id: c.id, peso: nome.length });
  }

  for (const [nomeCategoria, termos] of Object.entries(APELIDOS)) {
    const chave = normalizar(nomeCategoria);
    const categoria = categorias.find((c) => normalizar(c.nome).startsWith(chave.slice(0, 6)));
    if (!categoria) continue;
    for (const termo of termos) {
      if (alvo.includes(termo)) candidatos.push({ id: categoria.id, peso: termo.length });
    }
  }

  if (candidatos.length === 0) return null;
  return candidatos.sort((a, b) => b.peso - a.peso)[0].id;
}
