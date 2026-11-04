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

// O pedido é uma linha só, e isso foi medido, não é estilo.
//
// Ele nasceu curto quando o modelo ainda raciocinava antes de responder: com
// três regras a mais ("ignore o rodapé", "formato da data", "ignore o total") o
// raciocínio dobrava e a leitura voltava vazia. Hoje o raciocínio é pulado (ver
// `SEM_RACIOCINIO`), mas este pedido é o que foi conferido valor a valor — uma
// instrução nova precisa de medição nova antes de entrar.
//
// O que se perde de instrução se recupera no cruzamento: a data e o descarte de
// rodapé já vêm do leitor determinístico, e desta leitura só interessa o valor.
const PEDIDO_VISAO = 'Liste os lancamentos desta fatura em JSON: '
  + '{"lancamentos":[{"descricao":"","valor":0}]}';

// A resposta do modelo já começa com o raciocínio aberto e fechado, vazio.
//
// O `qwen3-vl:8b` é a variante que sempre raciocina, e `think: false` não muda
// nada nele — medido: 14 s e 5 mil caracteres de raciocínio com ou sem a opção,
// para ler uma linha só. Em lista curta isso é só lentidão; em lista longa é a
// leitura inteira que some. Numa coluna circulada de 34 lançamentos ele confere
// linha por linha e não termina: com 3 mil tokens de teto, 36 s e resposta vazia;
// com 12 mil, 182 s e vazia do mesmo jeito. Dar mais orçamento não resolve,
// porque o raciocínio não converge.
//
// O Ollama continua a última mensagem quando ela é do assistente, em vez de
// abrir outra. Entregando a resposta com o bloco `<think>` já encerrado, o
// modelo vai direto ao JSON. Medido na fatura de novembro digitalizada: os 34
// lançamentos da página 2 em 14 s, os 29 da página 3 em 13 s, o círculo de uma
// linha em 1 s — os 64 valores certos, sem nenhum a mais.
//
// Num modelo sem raciocínio (outro `IA_MODELO_VISAO`) isto não foi medido: ali o
// bloco vazio é só um começo de resposta, e o JSON continua sendo extraído do
// texto que vier depois dele.
const SEM_RACIOCINIO = { role: 'assistant', content: '<think>\n\n</think>\n\n' };

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
        // A janela é a soma da imagem com a resposta, e as duas contas fecham
        // nela. A imagem ocupa de 2 a 3,4 mil tokens no recorte de uma página
        // circulada, e 4,1 mil na página inteira sem marcação (o Ollama reduz
        // antes de olhar). A resposta agora é só o JSON, perto de 40 tokens por
        // lançamento — 34 gastaram 1,3 mil; o maior recorte medido, 56. O teto
        // de 4 mil cabe uns 100 lançamentos sem passar da janela.
        num_ctx: 8192,
        num_predict: 4000,
      },
      // A imagem vai na resolução em que o reconhecimento a leu. Reduzir não
      // compensa: na metade, o recorte de 34 lançamentos saiu 0,3 s mais rápido
      // — o tempo é o da resposta, não o da imagem — e com 3 valores errados.
      messages: [
        { role: 'user', content: PEDIDO_VISAO, images: [buffer.toString('base64')] },
        SEM_RACIOCINIO,
      ],
    }, LIMITE_VISAO);

    // Resposta cortada no teto é leitura perdida, e antes ela sumia sem deixar
    // rastro: a importação seguia só com o reconhecimento de texto e ninguém
    // ficava sabendo por quê.
    if (resposta?.done_reason === 'length' && sinal !== 'silencioso') {
      console.warn(`FinTrack • leitura por visão cortada no teto de ${resposta.eval_count} tokens`);
    }

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

/* -------------------------- marcação na imagem ---------------------------- */

// Uma letra, e a alternativa de dizer que nenhuma serve. Curto de propósito: é
// a diferença entre 5 e 33 segundos, e entre uma resposta e nenhuma.
const PEDIDO_ESCOLHA = 'Qual retangulo foi desenhado a mao por uma pessoa, '
  + 'em volta de linhas de texto? Responda so a letra, ou N se nenhum.';

/**
 * Entre as manchas coloridas de uma página, qual é a caneta do usuário.
 *
 * Esta função não mede nada — as coordenadas já vieram da varredura de pixels,
 * que é exata. Ela só desempata, e o formato da pergunta é o que a torna
 * confiável.
 *
 * A medição que levou a este desenho: pedir a caixa ao modelo (`box_2d`, o
 * formato de ancoragem da própria família Qwen) funcionou algumas vezes — 0,7%
 * de erro, 5 segundos — e falhou em outras com o mesmo pedido e a mesma
 * imagem: raciocínio de 4,5k caracteres, orçamento de tokens estourado,
 * resposta vazia, 17 segundos. Dando mais orçamento ele termina, mas **erra
 * mais**: 8,6k de raciocínio e 12,7% de erro. Coordenada é medida, e medir não
 * é o que ele faz bem.
 *
 * Responder uma letra é. A saída é um caractere: ou corresponde a uma candidata
 * que a varredura já mediu, ou é descartada — não existe resposta 12% fora do
 * lugar.
 */
export async function escolherMarcacao(png, quantidade, { sinal } = {}) {
  if (quantidade < 1) return null;
  try {
    const resposta = await chamar('/api/chat', {
      model: MODELO_VISAO,
      stream: false,
      // Orçamento curto de propósito. Se o modelo começar a divagar, o melhor
      // resultado é ele não responder: quem chama trata o silêncio como "não
      // sei" e cai para a regra determinística.
      options: { temperature: 0, num_ctx: 8192, num_predict: 1200 },
      messages: [
        { role: 'user', content: PEDIDO_ESCOLHA, images: [png.toString('base64')] },
      ],
    }, LIMITE_VISAO);

    const conteudo = (resposta?.message?.content || '').trim().toUpperCase();
    if (!conteudo) return null;

    const letra = conteudo.match(/\b([A-Z])\b/)?.[1];
    if (!letra || letra === 'N') return null;

    const indice = letra.charCodeAt(0) - 65;
    return indice >= 0 && indice < quantidade ? indice : null;
  } catch (erro) {
    if (sinal !== 'silencioso') console.warn('FinTrack • escolha da marcação indisponível:', erro.message);
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
