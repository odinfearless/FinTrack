/**
 * Leitura de extrato de conta corrente em PDF.
 *
 * O extrato parece a fatura do cartão, mas o problema é outro. Na fatura toda
 * linha é uma despesa e o que se decide é a categoria. No extrato cada linha
 * pode ser dinheiro entrando ou saindo, e cada uma vai para um lugar diferente
 * do app: receita, conta fixa ou gasto avulso. Classificar é o trabalho
 * principal daqui, e não separar linha de rodapé.
 *
 * Por isso a extração devolve linha estruturada — data, descrição, valor e
 * saldo em campos separados — em vez do texto corrido que o leitor de fatura
 * produz. O motivo é a coluna: extrato traz o valor do lançamento e o saldo
 * corrente lado a lado, e só a posição X distingue os dois. Num texto já
 * concatenado, "SALDO DO DIA -1.203,55" viraria uma despesa de mil e duzentos
 * reais que nunca aconteceu.
 *
 * Nada aqui grava no banco: quem confirma é o usuário, na tela de revisão.
 */

import { normalizar, sugerirCategoria } from './categorias.js';

/* ------------------------------ extração --------------------------------- */

// Fragmento que é só um valor: "-1.203,55", "R$ -708,63", "81,24 D". O sinal
// de menos aparece nos dois lados do "R$" conforme o banco, e o sufixo C/D é
// como alguns marcam crédito e débito em vez de usar sinal.
const RX_SO_VALOR = /^\s*(-)?\s*(?:R\$\s*)?(-)?\s*(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})\s*(-|[CD])?$/;

// Data que abre a linha do lançamento. O ano costuma vir, mas nem sempre.
const RX_DATA_INICIO = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s|$)/;

function lerValor(fragmento) {
  const m = RX_SO_VALOR.exec(fragmento);
  if (!m) return null;
  const n = Number(`${m[3].replace(/\./g, '')}.${m[4]}`);
  const negativo = Boolean(m[1] || m[2]) || m[5] === '-' || m[5] === 'D';
  return negativo ? -n : n;
}

/**
 * Junta os fragmentos do pdf.js em linhas, guardando o X de cada um.
 *
 * O X é o que sobrevive desta etapa e o que a etapa seguinte usa para saber de
 * que coluna veio cada número — descartá-lo aqui tornaria o resto impossível.
 */
function agruparEmLinhas(itens, tolerancia = 3) {
  const linhas = [];

  for (const item of itens) {
    const texto = (item.str || '').trim();
    if (!texto) continue;
    const x = item.transform[4];
    const y = item.transform[5];

    const existente = linhas.find((l) => Math.abs(l.y - y) <= tolerancia);
    if (existente) existente.pedacos.push({ x, texto });
    else linhas.push({ y, pedacos: [{ x, texto }] });
  }

  linhas.sort((a, b) => b.y - a.y);
  for (const l of linhas) l.pedacos.sort((a, b) => a.x - b.x);
  return linhas;
}

/**
 * Em que X termina a coluna "valor" e começa a coluna "saldo".
 *
 * O sinal é o próprio cabeçalho da tabela ("data | lançamentos | valor (R$) |
 * saldo (R$)"): ele diz onde cada coluna começa, e o meio do caminho entre os
 * dois rótulos separa os números com folga dos dois lados, já que valor e saldo
 * são alinhados à direita e ficam bem distantes um do outro.
 *
 * Agrupar os números por proximidade não serviria: num extrato de poucos dias a
 * coluna de saldo tem duas ou três linhas, e um agrupamento acharia que é ruído.
 */
function acharCorteDeColuna(linhas) {
  for (const linha of linhas) {
    const valor = linha.pedacos.find((p) => /^valor\b/i.test(p.texto));
    const saldo = linha.pedacos.find((p) => /^saldos?\b/i.test(p.texto));
    if (valor && saldo && saldo.x > valor.x) return (valor.x + saldo.x) / 2;
  }
  return null;
}

/* --------------------------- cabeçalho da conta --------------------------- */

const BANCOS = [
  [/ita[uú]/i, 'Itaú'],
  [/bradesco/i, 'Bradesco'],
  [/santander/i, 'Santander'],
  [/banco\s+do\s+brasil|\bbb\.com/i, 'Banco do Brasil'],
  [/caixa\s+econ[oô]mica|\bcaixa\b/i, 'Caixa'],
  [/nubank|nu\s+pagamentos/i, 'Nubank'],
  [/banco\s+inter\b/i, 'Inter'],
  [/\bc6\s*bank/i, 'C6 Bank'],
  [/sicoob/i, 'Sicoob'],
  [/sicredi/i, 'Sicredi'],
  [/banco\s+original/i, 'Original'],
  [/\bsafra\b/i, 'Safra'],
  [/\bbtg\b/i, 'BTG'],
  [/picpay/i, 'PicPay'],
  [/mercado\s+pago/i, 'Mercado Pago'],
];

// Rótulos do topo do extrato e o campo do app que cada um alimenta.
const CAMPOS_DO_TOPO = [
  [/saldo\s+(em\s+conta|dispon[íi]vel|atual)/i, 'saldo'],
  [/limite.*utilizado/i, 'limite_usado'],
  [/limite.*total/i, 'limite_total'],
  [/limite.*dispon[íi]vel/i, 'limite_disponivel'],
];

/**
 * Dados da conta impressos no topo do documento.
 *
 * Nome do titular e CPF são deixados de fora de propósito: identificam a
 * pessoa, não a conta, e o app não teria o que fazer com eles — guardar dado
 * pessoal que nunca vai ser lido só aumenta o estrago se o arquivo do banco
 * vazar. Agência e conta ficam porque são elas que dizem, na importação
 * seguinte, que o extrato é o da mesma conta já cadastrada.
 *
 * Saldo e limites vêm em duas linhas: os rótulos em uma, os números logo
 * abaixo, cada um alinhado com o seu. É por esse alinhamento que eles são
 * emparelhados — a ordem sozinha não bastaria, porque nem todo extrato traz
 * todos os campos.
 */
function lerCabecalho(linhas, textoInteiro) {
  const conta = {
    banco: null,
    agencia: null,
    numero: null,
    saldo: null,
    limite_total: null,
    limite_usado: null,
    limite_disponivel: null,
    periodo_inicio: null,
    periodo_fim: null,
  };

  const banco = BANCOS.find(([rx]) => rx.test(textoInteiro));
  if (banco) [, conta.banco] = banco;

  const agencia = /ag[êe]ncia:?\s*(\d{3,6})/i.exec(textoInteiro);
  if (agencia) [, conta.agencia] = agencia;

  const numero = /\bconta:?\s*([\d.]{3,12}-?[\dxX]?)/i.exec(textoInteiro);
  if (numero) [, conta.numero] = numero;

  const periodo = /(\d{2}\/\d{2}\/\d{4})\s*(?:at[ée]|a)\s*(\d{2}\/\d{2}\/\d{4})/i.exec(textoInteiro);
  if (periodo) {
    conta.periodo_inicio = periodo[1];
    conta.periodo_fim = periodo[2];
  }

  for (let i = 0; i < linhas.length - 1; i += 1) {
    const rotulos = linhas[i].pedacos.filter((p) => CAMPOS_DO_TOPO.some(([rx]) => rx.test(p.texto)));
    if (rotulos.length === 0) continue;

    const numeros = linhas[i + 1].pedacos.filter((p) => lerValor(p.texto) !== null);
    if (numeros.length === 0) continue;

    for (const rotulo of rotulos) {
      const proximo = numeros
        .map((n) => ({ n, distancia: Math.abs(n.x - rotulo.x) }))
        .sort((a, b) => a.distancia - b.distancia)[0];
      // Mais de meia coluna de distância não é alinhamento, é coincidência.
      if (!proximo || proximo.distancia > 60) continue;
      const [, campo] = CAMPOS_DO_TOPO.find(([rx]) => rx.test(rotulo.texto));
      if (conta[campo] === null) conta[campo] = lerValor(proximo.n.texto);
    }
  }

  // O limite utilizado é dívida, e o extrato o imprime sem sinal. Guardá-lo
  // como número positivo é o que deixa "usado + disponível = total" fechar.
  if (conta.limite_usado !== null) conta.limite_usado = Math.abs(conta.limite_usado);

  return conta;
}

/* ---------------------------- leitura do arquivo -------------------------- */

/**
 * Extrato que não escreve o ano nas linhas — há bancos assim — precisa que
 * alguém o complete. A referência é o fim do período: um lançamento de mês
 * maior que ele é do ano anterior, que é o que acontece num extrato de janeiro
 * cuja primeira semana ainda é de dezembro.
 */
function completarAno(mes, anoBruto, referencia) {
  if (anoBruto) {
    const ano = Number(anoBruto);
    return ano < 100 ? ano + 2000 : ano;
  }
  return mes > referencia.mes ? referencia.ano - 1 : referencia.ano;
}

/**
 * Lê o PDF e devolve as linhas já separadas em data, descrição, valor e saldo.
 *
 * Só PDF: num extrato o que separa o lançamento do saldo é a coluna, e a coluna
 * vem das coordenadas do texto. Reconhecer texto de uma foto devolveria os
 * números sem posição confiável, e um saldo lido como lançamento entraria no
 * mês como uma despesa de milhares de reais.
 */
export async function extrair(buffer, nomeArquivo, tipoMime = '') {
  if (!/\.pdf$/i.test(nomeArquivo) && !tipoMime.includes('pdf')) {
    const erro = new Error(
      'O extrato precisa ser o PDF baixado do banco. Numa imagem não dá para saber se um '
      + 'número é o valor do lançamento ou o saldo do dia, e confundir os dois estragaria o mês.',
    );
    erro.status = 415;
    throw erro;
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

  const tarefa = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const todas = [];
  let paginas = 0;

  try {
    const documento = await tarefa.promise;
    paginas = documento.numPages;

    for (let n = 1; n <= paginas; n += 1) {
      const pagina = await documento.getPage(n);
      const conteudo = await pagina.getTextContent();
      todas.push(...agruparEmLinhas(conteudo.items).map((l) => ({ ...l, pagina: n })));
      pagina.cleanup();
    }
  } finally {
    await tarefa.destroy();
  }

  const textoInteiro = todas
    .map((l) => l.pedacos.map((p) => p.texto).join(' '))
    .join('\n');

  if (textoInteiro.replace(/\s/g, '').length < 40) {
    const erro = new Error(
      'Este PDF não tem texto selecionável — parece uma imagem escaneada. Baixe o extrato '
      + 'direto do site ou do aplicativo do banco, em vez de fotografar ou digitalizar.',
    );
    erro.status = 422;
    throw erro;
  }

  const conta = lerCabecalho(todas, textoInteiro);
  const corte = acharCorteDeColuna(todas);
  const agora = new Date();
  const referencia = conta.periodo_fim
    ? { ano: Number(conta.periodo_fim.slice(6, 10)), mes: Number(conta.periodo_fim.slice(3, 5)) }
    : { ano: agora.getFullYear(), mes: agora.getMonth() + 1 };

  const linhas = [];
  for (const linha of todas) {
    const numeros = [];
    const palavras = [];

    for (const pedaco of linha.pedacos) {
      const valor = lerValor(pedaco.texto);
      // Sem cabeçalho de coluna, todo número conta como valor: é melhor mostrar
      // um saldo a mais na tela de revisão, onde ele se desmarca, do que perder
      // um lançamento de um extrato cujo layout não foi previsto.
      if (valor !== null) numeros.push({ valor, saldo: corte !== null && pedaco.x >= corte });
      else palavras.push(pedaco.texto);
    }

    const bruta = linha.pedacos.map((p) => p.texto).join(' ').replace(/\s+/g, ' ').trim();
    const texto = palavras.join(' ').replace(/\s+/g, ' ').trim();
    const data = RX_DATA_INICIO.exec(texto);

    const doLancamento = numeros.find((n) => !n.saldo);
    const doSaldo = numeros.find((n) => n.saldo);

    linhas.push({
      pagina: linha.pagina,
      data: data
        ? `${completarAno(Number(data[2]), data[3], referencia)}-${data[2].padStart(2, '0')}-${data[1].padStart(2, '0')}`
        : null,
      descricao: data ? texto.slice(data[0].length).trim() : texto,
      valor: doLancamento ? doLancamento.valor : null,
      saldo: doSaldo ? doSaldo.valor : null,
      bruta,
    });
  }

  // O saldo do primeiro e do último dia do extrato. Guardar a data de cada um
  // importa tanto quanto o número: o saldo do primeiro dia já inclui o que
  // aconteceu naquele dia, então a conferência só pode somar o que veio depois.
  const comSaldo = linhas
    .filter((l) => l.saldo !== null && l.data)
    .sort((a, b) => a.data.localeCompare(b.data));

  const saldos = comSaldo.length > 0
    ? {
      inicial: comSaldo[0].saldo,
      final: comSaldo[comSaldo.length - 1].saldo,
      data_inicial: comSaldo[0].data,
      data_final: comSaldo[comSaldo.length - 1].data,
    }
    : null;

  // O topo nem sempre imprime o saldo; o último saldo do dia diz a mesma coisa.
  if (conta.saldo === null && saldos) conta.saldo = saldos.final;

  return { linhas, conta, saldos, paginas, colunas_detectadas: corte !== null };
}

/* ------------------------------ classificação ----------------------------- */

// Linhas de resumo: cabeçalho da tabela, saldo do dia, totais do período.
// Nenhuma delas é movimento de dinheiro.
const RUIDO = [
  /^saldo\b/i,
  /^s\s?a\s?l\s?d\s?o\b/i,
  /^total\b/i,
  /^sub-?total\b/i,
  /^extrato\b/i,
  /^per[íi]odo\b/i,
  /^limite\b/i,
  /^lan[çc]amentos?\b/i,
  /^dispon[íi]vel\b/i,
  /^data\b/i,
];

// "DA CLARO CELULAR" — o "DA" na frente é como o Itaú marca débito automático.
// A espiada adiante evita que um Pix para alguém chamado "DAVI" caia aqui.
const RX_DEBITO_AUTOMATICO = /^(?:d\.?\s?a\.?|d[ée]b(?:ito)?\.?\s*autom?\w*)(?=[\s.:-]|$)/i;

// Débito que se repete todo mês com nome e valor próprios: é isto que o app
// chama de conta, e não de gasto avulso.
const CONTA_FIXA = [
  /sabesp|sanepar|copasa|cedae|caesb|agua/,
  /eletropaulo|enel|cpfl|cemig|copel|celesc|coelba|light serv|energia|eletrob/,
  /comgas|naturgy/,
  /claro|vivo|telefonica|\btim\b|net serv|internet|banda larga|telecom/,
  /condominio|aluguel|iptu|ipva|dpvat/,
  // "ITAU SEG AP PF" é como o banco escreve o seguro debitado em conta.
  /seguro|\bseg\b|previd|consorcio|\bprev\b/,
  /mensalidade|escola|faculdade|universidade|academia|unimed|amil|plano de saude/,
  /financiamento|emprestimo|consignado|presta[çc]ao/,
];

// Tarifa e juros do banco. Cabem em dois lugares do app: conta do mês, ou
// receita negativa do tipo "ajuste" — que é como a planilha lançava cheque
// especial e juros do limite. O padrão é conta, porque é assim que eles já
// estão lançados aqui, e porque uma linha chamada "juros" listada entre as
// receitas confunde mais do que explica. Trocar o destino continua a um clique.
const RX_ENCARGO_BANCARIO = /\bjuros|\biof\b|tarifa|cesta|anuidade|manuten[çc]ao de conta|encargo|\bmulta|\bmora\b/;

const RX_SALARIO = /remunera|salario|proventos|pro.?labore|aposentad|beneficio|pensao|ferias/;

// Pagamento da fatura do cartão. É o lançamento mais perigoso do extrato: as
// compras que ele quita já estão no app, vindas da importação da fatura, e
// lançá-lo de novo contaria o cartão inteiro duas vezes no mesmo mês.
const RX_FATURA_CARTAO = /fatura\s+pag|pag(?:amento|to)?\.?\s+(?:de\s+)?fatura|fatura\s+cart|pag(?:amento|to)?\.?\s+cart/;

// Dinheiro que só mudou de lugar dentro do próprio patrimônio.
const RX_MOVIMENTO_PROPRIO = /aplica[çc]|resgate|poupan[çc]|\bcdb\b|tesouro|invest|entre\s+contas|mesma\s+titularidade/;

const FORMAS = [
  [/\bpix\b/, 'Pix'],
  [/\bted\b|\bdoc\b|transf|sispag|remessa/, 'Transferência'],
  [/saque|caixa\s+eletronico|24\s?h|dinheiro/, 'Dinheiro'],
  [/boleto|titulo|cobranca|convenio|tributo|darf|gps\b|fgts/, 'Boleto'],
  [/compra\s+(?:com\s+)?(?:cartao|debito)|cartao\s+debito|\bdebito\b/, 'Débito'],
];

/**
 * Data da própria operação colada no fim do nome ("PIX TRANSF KELLY D24/07").
 * O banco escreve assim quando o campo é curto demais para o nome inteiro. Ela
 * não acrescenta nada — a coluna de data já traz o mesmo dia — e atrapalha o
 * reconhecimento de parcela, que procura exatamente esse formato.
 */
function tirarDataColada(texto, data) {
  if (!data) return texto;
  const [, mes, dia] = data.split('-');
  return texto.replace(new RegExp(`\\s?${dia}/${mes}$`), '');
}

function limparDescricao(bruta, data) {
  return tirarDataColada(String(bruta || '').replace(/\s+/g, ' ').trim(), data)
    // Número de convênio do débito automático ("SABESP 0005691516"): cinco
    // dígitos ou mais é código de cobrança; quatro ou menos pode ser o final de
    // um cartão, que ajuda a identificar o lançamento e por isso fica.
    .replace(/\s*\b\d{5,}\b\s*$/, '')
    .replace(/[\s.\-–—:|]+$/, '')
    .trim();
}

// "ITAU SEG AP PF 11/12" — parcela 11 de 12, e não o dia 11 de dezembro. O
// espaço na frente é obrigatório: nos nomes truncados a data vem colada numa
// letra ("VICTORI07/07"), e sem essa exigência ela viraria parcela 7 de 7.
const RX_PARCELA = /\s(\d{1,2})\/(\d{1,2})$/;

function acharParcela(descricao) {
  const m = RX_PARCELA.exec(descricao);
  if (!m) return null;
  const atual = Number(m[1]);
  const total = Number(m[2]);
  if (total < 2 || atual < 1 || atual > total) return null;
  return { atual, total, texto: m[0].trim() };
}

// O padrão muda com o destino, e não por capricho: conta que o extrato não diz
// como é paga é quase sempre débito automático — é por isso que ela aparece no
// extrato com nome de empresa. Já o gasto avulso sem pista costuma ser compra
// no débito.
const formaDe = (alvo, padrao) => (FORMAS.find(([rx]) => rx.test(alvo)) || [null, padrao])[1];

/**
 * Para onde vai cada linha do extrato.
 *
 * A regra de fundo é a que o usuário pediu: entrou dinheiro, é receita; saiu, é
 * despesa. O que se decide depois é entre os dois tipos de despesa que o app
 * tem — a conta, que se repete com nome e valor próprios, e o gasto avulso, que
 * acontece uma vez. E há dois casos que não são nenhum dos três e por isso
 * chegam desmarcados, com o motivo escrito na tela.
 */
function classificar(descricao, valor, parcela) {
  const alvo = normalizar(descricao);
  const entrada = valor > 0;

  if (RX_FATURA_CARTAO.test(alvo)) {
    return {
      destino: 'gasto',
      forma: 'Débito',
      selecionado: false,
      alerta: 'Pagamento de fatura de cartão. As compras já estão no app pela importação da '
        + 'fatura — importar também o pagamento contaria o cartão duas vezes.',
    };
  }

  if (RX_MOVIMENTO_PROPRIO.test(alvo)) {
    return {
      destino: entrada ? 'receita' : 'gasto',
      tipo: 'ajuste',
      forma: 'Transferência',
      selecionado: false,
      alerta: 'Parece aplicação ou resgate: o dinheiro mudou de lugar, mas continua seu. '
        + 'Como isso não é ganho nem gasto, a linha veio desmarcada.',
    };
  }

  // Estorno de tarifa é dinheiro de volta, e aí vale a regra geral: entrou, é
  // receita. Só o encargo cobrado vira conta.
  if (RX_ENCARGO_BANCARIO.test(alvo) && !entrada) {
    return { destino: 'conta', forma: 'Débito', selecionado: true };
  }

  if (entrada) {
    return {
      destino: 'receita',
      tipo: RX_SALARIO.test(alvo) ? 'fixa' : 'variavel',
      selecionado: true,
    };
  }

  const ehContaFixa = RX_DEBITO_AUTOMATICO.test(descricao)
    || CONTA_FIXA.some((rx) => rx.test(alvo))
    || Boolean(parcela);

  if (ehContaFixa) {
    return {
      destino: 'conta',
      forma: RX_DEBITO_AUTOMATICO.test(descricao) ? 'D.AUTO' : formaDe(alvo, 'D.AUTO'),
      selecionado: true,
    };
  }

  return { destino: 'gasto', forma: formaDe(alvo, 'Débito'), selecionado: true };
}

const arred = (n) => Math.round(n * 100) / 100;

/**
 * O extrato confere consigo mesmo, e é isso que diz se alguma linha escapou.
 *
 * O saldo do último dia menos o do primeiro é, por definição, tudo o que entrou
 * e saiu no meio. Se a soma do que foi lido bate com essa diferença, nenhum
 * lançamento ficou para trás — a mesma ideia do total declarado na fatura, só
 * que aqui o próprio documento faz a conta.
 *
 * A soma exclui o dia do saldo inicial: aquele saldo é do fim daquele dia e já
 * conta o que aconteceu nele.
 */
function conferir(itens, saldos) {
  if (!saldos || saldos.inicial === null || saldos.final === null) return null;

  const movimento = arred(itens
    .filter((i) => i.data && i.data > saldos.data_inicial)
    .reduce((t, i) => t + i.valor_extrato, 0));
  const variacao = arred(saldos.final - saldos.inicial);

  return {
    ...saldos,
    movimento,
    variacao,
    diferenca: arred(movimento - variacao),
    confere: Math.abs(movimento - variacao) < 0.005,
  };
}

/**
 * Transforma as linhas lidas em candidatos prontos para a tela de revisão.
 *
 * `mesPadrao` só vale para linha sem data: a competência de cada lançamento sai
 * da data dele. Extrato quase nunca cabe num mês só — o do Itaú vai do dia 7 de
 * um mês ao dia 6 do seguinte —, e jogar tudo numa competência só mandaria o
 * salário do dia 6 para o mês errado, que é justamente o maior número da conta.
 */
export function analisar(linhas, { mesPadrao, categorias = [], saldos = null } = {}) {
  const itens = [];
  const descartadas = [];

  linhas.forEach((linha, indice) => {
    const descricaoBruta = limparDescricao(linha.descricao, linha.data);
    const largar = (motivo) => descartadas.push({
      linha: indice + 1, texto: linha.bruta, motivo,
    });

    if (RUIDO.some((rx) => rx.test(descricaoBruta))) {
      largar('saldo ou resumo do extrato');
      return;
    }

    if (linha.valor === null || linha.valor === 0) {
      // Linha sem valor nenhum é moldura do documento e não interessa a
      // ninguém; a que tinha valor só na coluna de saldo é anunciada, porque
      // sumir com uma linha que carregava dinheiro merece explicação.
      if (linha.saldo !== null) largar('só o saldo corrente, sem lançamento');
      return;
    }

    if (!linha.data && !descricaoBruta) {
      largar('sem data e sem descrição');
      return;
    }

    if (descricaoBruta.length < 2) {
      largar('sem descrição identificável');
      return;
    }

    const parcela = acharParcela(descricaoBruta);
    const semParcela = parcela
      ? descricaoBruta.slice(0, -parcela.texto.length).trim()
      : descricaoBruta;

    const regra = classificar(semParcela, linha.valor, parcela);
    const descricao = regra.destino === 'conta'
      ? semParcela.replace(RX_DEBITO_AUTOMATICO, '').replace(/^[\s.:-]+/, '').trim() || semParcela
      : semParcela;

    const mes = linha.data ? linha.data.slice(0, 7) : mesPadrao;

    itens.push({
      id: `l${indice}`,
      linha_original: linha.bruta,
      data: linha.data,
      mes,
      descricao,
      // O valor como o extrato escreve: negativo saiu, positivo entrou. Fica
      // guardado porque é ele que diz o que a linha era, mesmo depois que o
      // usuário trocar o destino e o sinal do valor gravado mudar junto.
      valor_extrato: linha.valor,
      // O valor que vai para o banco. Despesa é positiva em `contas` e em
      // `lancamentos` — lá o sinal de menos significa estorno, e não saída.
      valor: regra.destino === 'receita' ? linha.valor : Math.abs(linha.valor),
      entrada: linha.valor > 0,
      destino: regra.destino,
      forma: regra.forma || null,
      tipo: regra.tipo || (linha.valor < 0 ? 'ajuste' : 'variavel'),
      categoria_id: sugerirCategoria(descricao, categorias),
      dia_vencimento: linha.data ? Number(linha.data.slice(8, 10)) : null,
      // Conta e receita valem por um período. O padrão é só o mês do
      // lançamento: o extrato mostra um mês, e só ele. Dizer "repete para
      // sempre" a partir de uma leitura só espalharia pela projeção inteira um
      // valor que muda todo mês — conta de luz nunca vem igual duas vezes.
      recorrente: false,
      // Com parcela conhecida dá para dizer quando acaba: o fim é daqui a
      // quantas ainda faltam, contadas a partir deste mês. Nada é escrito para
      // trás — as parcelas que já venceram pertencem a meses fechados.
      parcela: parcela ? { atual: parcela.atual, total: parcela.total } : null,
      alerta: regra.alerta || null,
      selecionado: regra.selecionado,
    });
  });

  // Mesma data, mesma descrição e mesmo valor duas vezes costuma ser a mesma
  // linha lida em duplicidade. A segunda vem desmarcada, mas continua na lista:
  // débito automático de duas linhas iguais no mesmo dia existe.
  const vistos = new Set();
  for (const item of itens) {
    const chave = `${item.data}|${normalizar(item.descricao)}|${Math.round(item.valor * 100)}`;
    if (vistos.has(chave)) {
      item.repetida = true;
      item.selecionado = false;
    }
    vistos.add(chave);
  }

  const soma = (filtro) => arred(itens.filter(filtro).reduce((t, i) => t + i.valor_extrato, 0));

  return {
    itens,
    descartadas,
    totais: {
      entradas: soma((i) => i.valor_extrato > 0),
      saidas: soma((i) => i.valor_extrato < 0),
      lancamentos: itens.length,
    },
    conferencia: conferir(itens, saldos),
  };
}
