/**
 * Modelo de linguagem rodando localmente, via Ollama.
 *
 * Entra como camada do meio na sugestão de categoria:
 *
 *   histórico  →  IA local  →  lista fixa
 *
 * O histórico é instantâneo e acerta o que se repete; a lista fixa é o piso
 * conhecido. Entre os dois sobrava o estabelecimento **inédito** — "MLP *KaBuM",
 * "Palladino" —, que nenhum dos dois tinha como resolver. É esse buraco que o
 * modelo preenche.
 *
 * Duas regras de projeto atravessam o arquivo inteiro:
 *
 *   é opcional      se o container da IA estiver fora, lento ou sem o modelo
 *                   baixado, tudo aqui devolve `null` e o app segue pelo
 *                   histórico. Nenhuma falha daqui pode derrubar uma
 *                   importação — a melhoria não vale virar dependência.
 *
 *   não decide      dinheiro nem data. O modelo sugere categoria, e na leitura
 *                   de imagem ele entra como segunda opinião: onde discorda do
 *                   reconhecimento de texto, a linha é marcada para conferência
 *                   em vez de um dos dois ser eleito no escuro. Um valor errado
 *                   e plausível é pior que um valor visivelmente quebrado.
 */

const URL_BASE = process.env.IA_URL || 'http://localhost:11434';
const MODELO_TEXTO = process.env.IA_MODELO_TEXTO || 'qwen3:8b';
const MODELO_VISAO = process.env.IA_MODELO_VISAO || 'qwen3-vl:8b';

// Classificar é rápido; ler uma imagem, não. Os limites são diferentes porque
// um timeout curto na visão desperdiçaria o trabalho quase pronto, e um longo
// na classificação seguraria a importação inteira por causa de uma linha.
const LIMITE_TEXTO = Number(process.env.IA_TIMEOUT_TEXTO) || 120_000;
const LIMITE_VISAO = Number(process.env.IA_TIMEOUT_VISAO) || 180_000;

/* ------------------------------ transporte -------------------------------- */

async function chamar(caminho, corpo, limite) {
  const cancelar = AbortSignal.timeout(limite);
  const resposta = await fetch(`${URL_BASE}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: cancelar,
  });
  if (!resposta.ok) throw new Error(`IA respondeu ${resposta.status}`);
  return resposta.json();
}

/** A IA está no ar e com os modelos baixados? Usado pelo diagnóstico. */
export async function estado() {
  try {
    const resposta = await fetch(`${URL_BASE}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!resposta.ok) return { disponivel: false, motivo: `respondeu ${resposta.status}` };
    const { models = [] } = await resposta.json();
    const nomes = models.map((m) => m.name);
    const temModelo = (alvo) => nomes.some((n) => n === alvo || n.startsWith(`${alvo.split(':')[0]}:`));
    return {
      disponivel: true,
      url: URL_BASE,
      modelo_texto: MODELO_TEXTO,
      modelo_visao: MODELO_VISAO,
      texto_pronto: temModelo(MODELO_TEXTO),
      visao_pronto: temModelo(MODELO_VISAO),
      baixados: nomes,
    };
  } catch (erro) {
    return { disponivel: false, motivo: erro.message };
  }
}

/* ---------------------------- classificação ------------------------------- */

/**
 * O modelo devolve JSON, e não texto livre, porque a saída é lida por código.
 * O esquema é passado no `format` do Ollama, que restringe a geração — é mais
 * confiável do que pedir JSON no prompt e torcer.
 */
const ESQUEMA_CLASSIFICACAO = {
  type: 'object',
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          // O modelo é obrigado a NOMEAR a empresa que reconheceu antes de
          // escolher a categoria. Isso muda o resultado de verdade: sem a
          // âncora, tudo o que ele não conhecia caía numa categoria comum com
          // 80% de confiança — errado e confiante, o pior tipo de erro. Com
          // ela, ou existe uma marca real ou ele se abstém. E a marca vira a
          // explicação na tela, que é o que permite conferir a sugestão.
          marca: { type: 'string' },
          categoria: { type: 'string' },
          confianca: { type: 'number' },
        },
        required: ['i', 'marca', 'categoria', 'confianca'],
      },
    },
  },
  required: ['itens'],
};

const INSTRUCAO = `Você classifica gastos de cartão e conta bancária brasileiros.
Recebe descrições como aparecem na fatura — abreviadas, com a cidade colada no
fim, às vezes com erro de leitura.

Para cada uma:
1. "marca": o nome da empresa que você RECONHECE na descrição. Se não reconhecer
   nenhuma empresa real e conhecida, deixe "" (string vazia).
2. "categoria": só preencha quando "marca" não estiver vazia. Use exatamente uma
   das categorias fornecidas, escrita como está na lista.
3. "confianca": de 0 a 1.

REGRAS DURAS:
- NUNCA deduza a categoria pela cidade. "carapicuiba", "sao paulo", "cotia",
  "osasco", "barueri" e "bra" são lugares, não ramos de negócio.
- NUNCA chute uma categoria comum para o que não reconhece. Na dúvida:
  marca="", categoria="", confianca=0. Abster-se é a resposta certa.
- Transferência entre pessoas (PIX TRANSF, PIX QRS, PAG BOLETO seguido de nome)
  não tem categoria: deixe vazio.
- Nome de pessoa não é marca.
- Não invente categoria fora da lista.
- Cuidado com nome que contém palavra de outro ramo: "Auto posto rio amazonas"
  é um posto de combustível, não uma compra na Amazon.
- Responda apenas o JSON.`;

/**
 * Classifica várias descrições numa chamada só.
 *
 * Em lote, e não uma por vez, porque o custo aqui é o tempo de carregar e
 * percorrer o modelo: cinquenta chamadas de uma linha demorariam quase cinquenta
 * vezes mais que uma chamada de cinquenta linhas.
 *
 * Devolve um Map(índice → { categoria_id, confianca }). Qualquer falha devolve
 * um Map vazio: sem sugestão é pior que com, mas muito melhor que uma
 * importação que não abre.
 */
export async function classificarEmLote(descricoes, categorias, { sinal } = {}) {
  const vazio = new Map();
  if (descricoes.length === 0 || categorias.length === 0) return vazio;

  const nomes = categorias.map((c) => c.nome);
  const lista = descricoes.map((d, i) => `${i}. ${String(d).slice(0, 120)}`).join('\n');

  try {
    const resposta = await chamar('/api/chat', {
      model: MODELO_TEXTO,
      stream: false,
      format: ESQUEMA_CLASSIFICACAO,
      // O raciocínio passo a passo do modelo não ajuda aqui e multiplica o
      // tempo de resposta: a tarefa é reconhecer um nome, não deduzir.
      think: false,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: INSTRUCAO },
        {
          role: 'user',
          content: `Categorias disponíveis: ${nomes.join(', ')}\n\nGastos:\n${lista}`,
        },
      ],
    }, LIMITE_TEXTO);

    const conteudo = resposta?.message?.content;
    if (!conteudo) return vazio;

    const { itens } = JSON.parse(conteudo);
    if (!Array.isArray(itens)) return vazio;

    // O nome volta como texto: casar sem acento e sem caixa evita perder
    // "Combustível" por causa do acento que o modelo comeu.
    const porNome = new Map(categorias.map((c) => [chaveDeNome(c.nome), c.id]));

    const saida = new Map();
    for (const item of itens) {
      const id = porNome.get(chaveDeNome(item?.categoria));
      const indice = Number(item?.i);
      if (!id || !Number.isInteger(indice) || indice < 0 || indice >= descricoes.length) continue;
      // Sem marca nomeada não há sugestão: é o próprio modelo dizendo que não
      // reconheceu nada, e a categoria que viesse junto seria chute.
      const marca = String(item?.marca ?? '').trim();
      if (!marca) continue;

      const confianca = Number(item?.confianca);
      saida.set(indice, {
        categoria_id: id,
        marca,
        confianca: Number.isFinite(confianca) ? Math.min(Math.max(confianca, 0), 1) : 0.5,
      });
    }
    return saida;
  } catch (erro) {
    if (sinal !== 'silencioso') console.warn('FinTrack • IA local indisponível:', erro.message);
    return vazio;
  }
}

const chaveDeNome = (v) => String(v ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().trim();

/* ------------------------------- visão ------------------------------------ */

const ESQUEMA_LEITURA = {
  type: 'object',
  properties: {
    lancamentos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          data: { type: 'string' },
          descricao: { type: 'string' },
          valor: { type: 'number' },
        },
        required: ['descricao', 'valor'],
      },
    },
  },
  required: ['lancamentos'],
};

// O pedido é uma linha só, e isso é medido, não estilo.
//
// Este modelo raciocina antes de responder, e o raciocínio cresce com o número
// de instruções. Com o pedido curto: 5.5k de raciocínio, resposta completa, os
// cinco lançamentos da tela com os valores certos. Acrescentando três regras
// ("ignore o rodapé", "formato da data", "ignore o total"): 11k de raciocínio,
// o teto de tokens estoura antes de sair a primeira linha de JSON e a leitura
// volta vazia. Cada instrução a mais aqui custa o dobro do orçamento.
//
// O que se perde de instrução se recupera no cruzamento: a data e o descarte de
// rodapé já vêm do leitor determinístico, e desta leitura só interessa o valor.
const PEDIDO_VISAO = 'Liste os lancamentos desta fatura em JSON: '
  + '{"lancamentos":[{"descricao":"","valor":0}]}';

/**
 * Lê uma imagem de fatura e devolve os lançamentos que o modelo enxergou.
 *
 * Esta saída **não substitui** a do reconhecimento de texto: ela é a segunda
 * opinião de `cruzarLeituras`. A razão é o tipo de erro. O Tesseract erra de
 * forma visível — "ce] -R$ 26,75 >" denuncia a si mesmo — enquanto um modelo de
 * visão erra de forma plausível: lê 72,88 como 78,88 e nada na tela indica que
 * algo saiu errado. Num app de dinheiro, erro invisível é o pior tipo.
 */
export async function lerImagem(buffer, { sinal } = {}) {
  try {
    const resposta = await chamar('/api/chat', {
      model: MODELO_VISAO,
      stream: false,
      // Sem `format` de esquema aqui, ao contrário da classificação: este
      // modelo raciocina antes de responder e, com a saída restrita ao
      // esquema, o campo `content` voltava vazio — o texto todo ficava no
      // raciocínio. Pedir o JSON no prompt e extraí-lo funciona.
      options: {
        temperature: 0,
        // Os dois limites são o que faz a leitura existir. Nos padrões, o
        // raciocínio do modelo consome a janela inteira e a resposta é cortada
        // antes de sair uma linha sequer de JSON.
        num_ctx: 8192,
        num_predict: 3000,
      },
      messages: [
        { role: 'user', content: PEDIDO_VISAO, images: [buffer.toString('base64')] },
      ],
    }, LIMITE_VISAO);

    const conteudo = resposta?.message?.content;
    if (!conteudo) return null;

    // O JSON vem embrulhado em texto; pega do primeiro "{" ao último "}".
    const bruto = conteudo.match(/\{[\s\S]*\}/);
    if (!bruto) return null;

    const { lancamentos } = JSON.parse(bruto[0]);
    if (!Array.isArray(lancamentos)) return null;

    return lancamentos
      .map((l) => ({
        descricao: String(l?.descricao ?? '').trim(),
        // O sinal varia com a tela (o app do banco escreve despesa com menos);
        // aqui só o módulo importa, porque este valor serve para conferir
        // contra o que o reconhecimento de texto leu.
        valor: Math.abs(Number(l?.valor)),
        data: String(l?.data ?? '').trim() || null,
      }))
      .filter((l) => l.descricao && Number.isFinite(l.valor) && l.valor !== 0);
  } catch (erro) {
    if (sinal !== 'silencioso') console.warn('FinTrack • leitura por visão indisponível:', erro.message);
    return null;
  }
}

const centavos = (v) => Math.round(Math.abs(Number(v)) * 100);

/**
 * Confronta o que o reconhecimento de texto leu com o que o modelo viu.
 *
 * O que interessa não é eleger um vencedor, e sim separar o que os dois
 * confirmam do que só um deles afirma:
 *
 *   valor nos dois            confirmado — é o caso da maioria;
 *   só o reconhecimento       continua entrando, como sempre entrou;
 *   só o modelo de visão      entra **desmarcado**, como candidato: pode ser uma
 *                             compra que o Tesseract perdeu, e pode ser
 *                             invenção. Quem decide é quem está olhando a tela.
 *
 * Nada é apagado e nenhum valor é sobrescrito. O ganho é saber em quais linhas
 * confiar sem conferir — e quais merecem um olhar.
 */
export function cruzarLeituras(itens, vistos) {
  if (!Array.isArray(vistos) || vistos.length === 0) return { itens, cruzamento: null };

  const porValor = new Map();
  for (const v of vistos) {
    const chave = centavos(v.valor);
    if (!porValor.has(chave)) porValor.set(chave, []);
    porValor.get(chave).push(v);
  }

  let confirmados = 0;
  const conferidos = itens.map((item) => {
    const iguais = porValor.get(centavos(item.valor));
    if (!iguais || iguais.length === 0) {
      return { ...item, visao: 'so_no_texto' };
    }
    iguais.pop(); // consome, para duas compras de mesmo valor casarem uma a uma
    confirmados += 1;
    return { ...item, visao: 'confirmado' };
  });

  // Sobrou no modelo o que o reconhecimento não viu.
  const sobraram = [...porValor.values()].flat();
  const extras = sobraram.map((v, i) => ({
    id: `visao-${i}`,
    linha_original: `${v.descricao} ${v.valor}`,
    data: null,
    descricao: v.descricao,
    valor: v.valor,
    credito: false,
    tipo: 'avulso',
    parcela_atual: null,
    parcelas: null,
    categoria_id: null,
    visao: 'so_na_visao',
    // Desmarcado: é palpite do modelo, não leitura confirmada.
    selecionado: false,
  }));

  return {
    itens: [...conferidos, ...extras],
    cruzamento: {
      confirmados,
      so_no_texto: conferidos.length - confirmados,
      so_na_visao: extras.length,
      total_visao: vistos.length,
    },
  };
}

/**
 * Carrega o modelo na VRAM sem esperar por ele.
 *
 * A primeira chamada paga a carga do modelo — medido aqui: 68s para subir 5,6 GB,
 * contra 0,1s depois de quente. Sem este aquecimento, quem abrisse a primeira
 * importação depois de subir o container esperaria mais de um minuto achando que
 * travou. Roda solto de propósito: o app não pode ficar esperando a IA para
 * começar a atender.
 */
export function aquecer() {
  fetch(`${URL_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELO_TEXTO,
      stream: false,
      think: false,
      messages: [{ role: 'user', content: 'ok' }],
    }),
    signal: AbortSignal.timeout(300_000),
  })
    .then(() => console.log('FinTrack • IA local pronta'))
    .catch(() => { /* IA é opcional: sem ela o app segue pelo histórico */ });
}
