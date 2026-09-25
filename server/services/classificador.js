/**
 * Classificador que aprende com o que você já classificou.
 *
 * A sugestão de categoria começou como uma lista fixa de apelidos
 * (`categorias.js`): uns sessenta termos escritos à mão. Ela resolve o caso
 * óbvio e para aí — "MLP *KaBuM" não cai em lugar nenhum, e pior: um posto
 * chamado "Auto posto rio amazonas" ia para Compras online porque a palavra
 * "amazon" aparece no meio do nome do rio.
 *
 * Este módulo olha para outra fonte, que a lista fixa nunca terá: o seu
 * histórico. Cada gasto já categorizado é um exemplo, e o mesmo
 * estabelecimento volta todo mês. De cada exemplo saem três sinais, do mais
 * específico para o mais geral:
 *
 *   descrição exata   "DL*UberRides" de novo é o mesmo DL*UberRides;
 *   raiz do nome      "Drogasil3953carapicuibabra" e "Drogasil 4874carapicuiba
 *                     bra" são a mesma farmácia com outro número de loja;
 *   primeira palavra  no print do Inter a categoria do próprio banco vem colada
 *                     na frente ("Transporte DL*UberRides", "Drogaria IFD…").
 *                     Esse sinal só existe naquele cartão, e é por isso que a
 *                     chave é guardada por cartão — em outro, a primeira
 *                     palavra é só o começo do nome da loja.
 *
 * Nada aqui sai da máquina: o modelo é uma contagem sobre as suas próprias
 * linhas, refeita a cada importação. Ele melhora sozinho conforme você usa o
 * app, que é o que uma lista fixa não faz.
 */

import { db } from '../db/index.js';
import { normalizar, sugerirCategoria } from './categorias.js';

/* --------------------------- extração de chaves --------------------------- */

// Intermediadores de pagamento que aparecem grudados na frente do nome real.
// Não são o estabelecimento: "PAG*Steam" é a Steam, não a PagSeguro.
const INTERMEDIARIOS = new Set([
  'dl', 'mlp', 'pag', 'pagseguro', 'ifd', 'mp', 'pp', 'ame', 'rec', 'ton',
  'sumup', 'cielo', 'stone', 'getnet', 'mercpago', 'pagarme', 'iugu', 'asaas',
  'di', 'jim.com', 'jim', 'ebn', 'zp',
]);

/**
 * O nome do estabelecimento reduzido a algo comparável.
 *
 * A cidade vem colada no fim sem espaço ("drogasil3953carapicuibabra") e o
 * número da loja muda de uma compra para a outra. Tirando dígito, pontuação e
 * espaço sobra uma sequência estável o bastante para duas lojas da mesma rede
 * caírem na mesma raiz.
 */
export function raizDe(descricao) {
  let texto = normalizar(descricao);

  // Depois do "*" costuma vir o nome real; antes, o intermediário. O corte só
  // acontece quando o que está na frente é reconhecidamente um intermediário,
  // senão "Mercadolivre*hardware" perderia justamente o "mercadolivre".
  const estrela = texto.indexOf('*');
  if (estrela > 0) {
    const antes = texto.slice(0, estrela).trim().split(/\s+/).pop();
    if (INTERMEDIARIOS.has(antes)) texto = texto.slice(estrela + 1);
  }

  const soLetras = texto.replace(/[^a-z]/g, '');
  // "bra" no fim é o país que a fatura carimba em toda compra nacional.
  return soLetras.replace(/bra$/, '');
}

/** A primeira palavra com cara de palavra — a categoria que o banco escreveu. */
function primeiraPalavra(descricao) {
  const [palavra] = normalizar(descricao).split(/\s+/);
  return palavra && palavra.length >= 4 && /^[a-z]+$/.test(palavra) ? palavra : null;
}

/**
 * As chaves de uma descrição, com o peso de cada uma.
 *
 * O peso é o que impede o sinal mais frouxo de atropelar o mais forte: a
 * descrição inteira batendo vale muito mais do que a primeira palavra bater.
 */
function chavesDe(descricao, cartaoId) {
  const chaves = [];

  const exata = normalizar(descricao);
  if (exata.length >= 4) chaves.push({ chave: `exata:${exata}`, peso: 100 });

  const raiz = raizDe(descricao);
  // Menos de seis letras não identifica ninguém: "pag", "uber" solto e sobra
  // de OCR casariam com meio mundo.
  if (raiz.length >= 6) chaves.push({ chave: `raiz:${raiz}`, peso: 60 });

  const palavra = primeiraPalavra(descricao);
  if (palavra && cartaoId) chaves.push({ chave: `inicio:${cartaoId}:${palavra}`, peso: 20 });

  return chaves;
}

/* ------------------------------- o modelo --------------------------------- */

const SQL_HISTORICO = `
  SELECT descricao, categoria_id, cartao_id FROM lancamentos WHERE categoria_id IS NOT NULL
  UNION ALL
  SELECT descricao, categoria_id, cartao_id FROM parcelamentos WHERE categoria_id IS NOT NULL
  UNION ALL
  SELECT descricao, categoria_id, NULL FROM contas WHERE categoria_id IS NOT NULL`;

/**
 * Monta o modelo a partir do histórico.
 *
 * É reconstruído a cada importação em vez de ficar em cache: é uma consulta só,
 * sobre algumas centenas de linhas, e um cache aqui significaria sugerir pela
 * foto antiga logo depois de o usuário corrigir uma categoria — justamente o
 * momento em que ele espera que o app tenha aprendido.
 */
export async function construirModelo() {
  const historico = await db.prepare(SQL_HISTORICO).all();

  // chave -> Map(categoria_id -> quantas vezes)
  const indice = new Map();
  for (const linha of historico) {
    for (const { chave } of chavesDe(linha.descricao, linha.cartao_id)) {
      if (!indice.has(chave)) indice.set(chave, new Map());
      const porCategoria = indice.get(chave);
      porCategoria.set(linha.categoria_id, (porCategoria.get(linha.categoria_id) || 0) + 1);
    }
  }

  return { indice, exemplos: historico.length };
}

/* ----------------------------- classificação ------------------------------ */

function motivoDe({ chave, vezes }) {
  const vezesTexto = vezes === 1 ? '1 vez' : `${vezes} vezes`;
  if (chave.startsWith('exata:')) return `mesma descrição já classificada assim ${vezesTexto}`;
  if (chave.startsWith('raiz:')) return `mesmo estabelecimento já classificado assim ${vezesTexto}`;
  return `neste cartão, gastos que começam assim foram para esta categoria ${vezesTexto}`;
}

/**
 * A categoria mais provável para uma descrição, ou `null` quando o histórico
 * não tem o que dizer.
 *
 * Cada chave vota com `peso × vezes`, e a confiança é a fatia do vencedor sobre
 * o total — um estabelecimento sempre classificado igual chega perto de 1; um
 * que você já mandou para duas categorias diferentes fica no meio. É essa fatia
 * que a tela mostra, para a sugestão poder ser conferida em vez de aceita no
 * escuro.
 */
export function classificarComModelo(modelo, descricao, { cartaoId = null } = {}) {
  const votos = new Map();
  const origens = new Map();

  for (const { chave, peso } of chavesDe(descricao, cartaoId)) {
    const porCategoria = modelo.indice.get(chave);
    if (!porCategoria) continue;
    for (const [categoriaId, vezes] of porCategoria) {
      votos.set(categoriaId, (votos.get(categoriaId) || 0) + peso * vezes);
      const atual = origens.get(categoriaId);
      // Guarda a chave mais forte que votou nesta categoria: é ela que vira a
      // explicação mostrada na tela.
      if (!atual || peso > atual.peso) origens.set(categoriaId, { chave, peso, vezes });
    }
  }

  if (votos.size === 0) return null;

  const total = [...votos.values()].reduce((t, v) => t + v, 0);
  const [categoriaId, pontos] = [...votos.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    categoria_id: categoriaId,
    confianca: Math.round((pontos / total) * 100) / 100,
    motivo: motivoDe(origens.get(categoriaId)),
    aprendido: true,
  };
}

/**
 * A sugestão final: o que foi aprendido, com a lista fixa como piso.
 *
 * O aprendido tem precedência quando a confiança é razoável, e isso é de
 * propósito: a lista fixa erra em nome que contém a palavra de outro ramo — o
 * posto "Auto posto rio amazonas" ia para Compras online por causa do "amazon".
 * Seu histórico sabe que aquilo é combustível; a lista não tem como saber.
 */
export function sugerir(modelo, descricao, { cartaoId = null, categorias = [] } = {}) {
  const aprendido = classificarComModelo(modelo, descricao, { cartaoId });
  if (aprendido && aprendido.confianca >= 0.5) return aprendido;

  const fixo = sugerirCategoria(descricao, categorias);
  if (fixo) return { categoria_id: fixo, confianca: null, motivo: 'nome conhecido', aprendido: false };

  // Empate fraco no histórico ainda é melhor que nada, mas vai marcado para a
  // tela poder avisar que a sugestão é incerta.
  return aprendido;
}

/** O que o modelo aprendeu, para a tela de diagnóstico. */
export function resumirModelo(modelo) {
  const porTipo = { exata: 0, raiz: 0, inicio: 0 };
  let ambiguas = 0;

  for (const [chave, porCategoria] of modelo.indice) {
    const tipo = chave.slice(0, chave.indexOf(':'));
    if (tipo in porTipo) porTipo[tipo] += 1;
    // Chave que já foi para mais de uma categoria: é onde a sugestão tem menos
    // confiança, e onde uma correção sua ensina mais.
    if (porCategoria.size > 1) ambiguas += 1;
  }

  return { exemplos: modelo.exemplos, chaves: modelo.indice.size, por_tipo: porTipo, ambiguas };
}
