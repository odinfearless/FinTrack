import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';
import { transacao } from '../db/index.js';
import { mesDeNome, somarMeses, diferencaMeses } from '../lib/mes.js';

/**
 * Importador da "Planilha 2026.xlsx".
 *
 * O layout é o mesmo em toda aba de mês, então em vez de fixar números de linha
 * o leitor ancora nos rótulos ("Renda", "Encargos", "Nome"/"Valor") e caminha a
 * partir deles — assim uma aba com uma linha a mais no topo continua a funcionar.
 *
 * O ganho de modelo acontece aqui: onde a planilha repetia a mesma conta ou
 * receita em nove abas, o importador junta as ocorrências em faixas de vigência
 * contíguas e grava uma linha só. Gastos de cartão continuam mês a mês.
 */

const normalizar = (v) => String(v ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '')
  .trim();

const numero = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/[R$\s.]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const arred = (n) => Math.round(n * 100) / 100;

/** Matriz da aba indexada por linha/coluna (A=0, B=1, …), 0-based. */
function matriz(aba) {
  return xlsx.utils.sheet_to_json(aba, { header: 1, blankrows: true, defval: null, raw: true });
}
const celula = (m, linha, coluna) => (m[linha] ? m[linha][coluna] ?? null : null);
const texto = (m, linha, coluna) => {
  const v = celula(m, linha, coluna);
  return v === null || v === undefined ? '' : String(v).trim();
};

/** Procura a linha em que a coluna `coluna` bate com um dos rótulos. */
function acharLinha(m, coluna, rotulos, inicio = 0) {
  const alvos = rotulos.map(normalizar);
  for (let i = inicio; i < m.length; i += 1) {
    if (alvos.includes(normalizar(texto(m, i, coluna)))) return i;
  }
  return -1;
}

/** Agrupa meses soltos em faixas contíguas [inicio, fim]. */
export function comprimirVigencias(meses) {
  const ordenados = [...new Set(meses)].sort();
  const faixas = [];
  for (const mes of ordenados) {
    const ultima = faixas[faixas.length - 1];
    if (ultima && diferencaMeses(ultima.fim, mes) === 1) ultima.fim = mes;
    else faixas.push({ inicio: mes, fim: mes });
  }
  return faixas;
}

const COL = { nome: 0, descricao: 1, valor: 2, parcela: 3, qtd: 4 };
const COL2 = { data: 7, descricao: 8, valor: 9, qtd: 10 };

/** Lê uma aba de mês e devolve os registros crus, sem tocar no banco. */
function lerAba(aba, mes) {
  const m = matriz(aba);
  const saida = { mes, receitas: [], contas: [], despesas: [], encargos: [], categorias: [], pessoas: [] };

  // Bloco de categorias: ancorado no cabeçalho "ITAU" da coluna N.
  const linhaCat = acharLinha(m, 13, ['ITAU']);
  if (linhaCat >= 0) {
    for (let i = linhaCat + 1; i < m.length; i += 1) {
      const nome = texto(m, i, 12);
      if (!nome) break;
      saida.categorias.push(nome);
    }
  }

  // Cabeçalhos das duas tabelas de fatura ("Nome … Valor" e "Data … Valor").
  const linhaFatura = acharLinha(m, 0, ['Nome']);
  const linhaDebitos = acharLinha(m, 7, ['Data']);
  const linhaInter = linhaFatura >= 0 ? acharLinha(m, 7, ['Data'], linhaFatura) : -1;

  // Receitas: 11 linhas a partir do cabeçalho "Renda | Valor".
  const linhaRenda = acharLinha(m, 0, ['Renda']);
  if (linhaRenda >= 0) {
    for (let i = linhaRenda + 1; i <= linhaRenda + 11; i += 1) {
      const descricao = texto(m, i, 0);
      const valor = numero(celula(m, i, 1));
      if (!descricao || valor === null || valor === 0) continue;
      saida.receitas.push({ descricao, valor: arred(valor) });
    }
  }

  // Contas fora do cartão: 11 linhas sob o primeiro cabeçalho "Data".
  if (linhaDebitos >= 0 && linhaDebitos !== linhaInter) {
    for (let i = linhaDebitos + 1; i <= linhaDebitos + 11; i += 1) {
      const descricao = texto(m, i, 8);
      const valor = numero(celula(m, i, 9));
      if (!descricao || valor === null || valor === 0) continue;
      saida.contas.push({
        descricao,
        valor: arred(valor),
        forma: texto(m, i, 11) || 'D.AUTO',
        fixo: normalizar(texto(m, i, 10)) === 'fixo',
      });
    }
  }

  // Nome de cada cartão: a célula logo acima do rótulo "Encargos".
  const lerCartao = (coluna) => {
    const linha = acharLinha(m, coluna, ['Encargos']);
    if (linha <= 0) return null;
    return {
      nome: texto(m, linha - 1, coluna) || null,
      encargos: arred(numero(celula(m, linha, coluna + 1)) ?? 0),
    };
  };
  const cartaoA = lerCartao(0) || { nome: 'Cartão principal', encargos: 0 };
  const cartaoB = lerCartao(7) || { nome: 'Cartão secundário', encargos: 0 };
  if (!cartaoA.nome) cartaoA.nome = 'Cartão principal';
  if (!cartaoB.nome) cartaoB.nome = 'Cartão secundário';
  saida.encargos.push({ cartao: cartaoA.nome, valor: cartaoA.encargos });
  saida.encargos.push({ cartao: cartaoB.nome, valor: cartaoB.encargos });

  const empurrar = (item) => {
    if (item.pessoa) saida.pessoas.push(item.pessoa);
    saida.despesas.push(item);
  };

  // Fatura do cartão principal (colunas A–E).
  if (linhaFatura >= 0) {
    for (let i = linhaFatura + 1; i < m.length; i += 1) {
      const valor = numero(celula(m, i, COL.valor));
      if (valor === null || valor === 0) continue;
      const qtdBruta = celula(m, i, COL.qtd);
      const parcela = numero(celula(m, i, COL.parcela));
      const qtd = numero(qtdBruta);

      empurrar({
        cartao: cartaoA.nome,
        pessoa: texto(m, i, COL.nome) || null,
        descricao: texto(m, i, COL.descricao) || null,
        valor: arred(valor),
        // Linha marcada como "fixo" na planilha entra como gasto do mês, igual
        // às outras: a cobrança recorrente é um gasto que se repete, e cada aba
        // já traz a sua.
        tipo: parcela && qtd && qtd > 1 ? 'parcelamento' : 'avulso',
        parcela_atual: parcela,
        parcelas: qtd,
        linha: i + 1,
      });
    }
  }

  // Fatura do cartão secundário (colunas H–K); "2/2" na coluna de parcela.
  if (linhaInter >= 0) {
    for (let i = linhaInter + 1; i < m.length; i += 1) {
      const valor = numero(celula(m, i, COL2.valor));
      if (valor === null || valor === 0) continue;
      const bruta = texto(m, i, COL2.qtd);
      const fracao = bruta.match(/^(\d+)\s*\/\s*(\d+)$/);
      const dataBruta = celula(m, i, COL2.data);

      empurrar({
        cartao: cartaoB.nome,
        pessoa: null,
        descricao: texto(m, i, COL2.descricao) || null,
        valor: arred(valor),
        tipo: fracao && Number(fracao[2]) > 1 ? 'parcelamento' : 'avulso',
        parcela_atual: fracao ? Number(fracao[1]) : null,
        parcelas: fracao ? Number(fracao[2]) : null,
        data: dataBruta instanceof Date ? dataBruta.toISOString().slice(0, 10) : null,
        linha: i + 1,
      });
    }
  }

  return saida;
}

const SEM_DESCRICAO = '(sem descrição)';

/**
 * Importa uma planilha, vinda da pasta do projeto (`arquivo`) ou enviada pela
 * tela (`conteudo` + `nome`). O resto do processo é o mesmo nos dois casos.
 */
export async function importarPlanilha({ arquivo, conteudo, nome, ano, substituir = true } = {}) {
  if (!conteudo && !fs.existsSync(arquivo)) {
    const erro = new Error(`Planilha não encontrada em ${arquivo}`);
    erro.status = 404;
    throw erro;
  }

  const nomeArquivo = conteudo ? String(nome || 'planilha.xlsx') : path.basename(arquivo);
  const anoFinal = ano || Number(nomeArquivo.match(/(20\d{2})/)?.[1]) || new Date().getFullYear();
  const pasta = conteudo
    ? xlsx.read(conteudo, { type: 'buffer', cellDates: true })
    : xlsx.readFile(arquivo, { cellDates: true });

  // 1ª passada: lê todas as abas de mês, em ordem de competência.
  const abas = [];
  for (const nome of pasta.SheetNames) {
    const mes = mesDeNome(nome, anoFinal);
    if (!mes) continue;
    abas.push({ nome, mes, dados: lerAba(pasta.Sheets[nome], mes) });
  }
  if (abas.length === 0) {
    const erro = new Error(
      'Nenhuma aba com nome de mês foi encontrada. As abas precisam se chamar '
      + `Janeiro, Fevereiro… (a planilha enviada tem: ${pasta.SheetNames.join(', ') || 'nenhuma aba'}).`,
    );
    erro.status = 400;
    throw erro;
  }
  abas.sort((a, b) => a.mes.localeCompare(b.mes));
  const ultimoMes = abas[abas.length - 1].mes;

  const relatorio = {
    arquivo: nomeArquivo,
    ano: anoFinal,
    abas: abas.map((a) => ({ aba: a.nome, mes: a.mes })),
    criados: {
      cartoes: 0, categorias: 0, pessoas: 0,
      lancamentos: 0, parcelamentos: 0, contas: 0, receitas: 0, encargos: 0,
    },
    avisos: [],
  };

  // A transação inteira roda numa conexão só, e é por `tx` que tudo passa lá
  // dentro: usar o `db` global aqui pegaria outra conexão do pool, fora da
  // transação, e essas escritas escapariam do COMMIT.
  await transacao(async (tx) => {
    if (substituir) {
      for (const t of ['lancamentos', 'parcelamentos', 'contas', 'receitas', 'encargos']) {
        await tx.prepare(`DELETE FROM ${t}`).run();
      }
    }

    // ---- cadastros básicos -------------------------------------------------
    const cacheCategorias = new Map(
      (await tx.prepare('SELECT id, nome FROM categorias').all()).map((c) => [normalizar(c.nome), c.id]),
    );
    // `RETURNING id` no lugar do `lastInsertRowid`: o Postgres devolve a linha
    // criada na própria instrução.
    const insCategoria = tx.prepare('INSERT INTO categorias (nome) VALUES (?) RETURNING id');
    /** Cria a categoria se ela ainda não existir. Só para o bloco de categorias. */
    const idCategoria = async (nome) => {
      const chave = normalizar(nome);
      if (!chave) return null;
      if (cacheCategorias.has(chave)) return cacheCategorias.get(chave);
      const { linha } = await insCategoria.run(String(nome).trim());
      cacheCategorias.set(chave, linha.id);
      relatorio.criados.categorias += 1;
      return linha.id;
    };
    // `for..of` no lugar do `forEach`: o callback do forEach é uma função à
    // parte, e o `await` lá dentro não seguraria este laço — as categorias
    // seriam criadas fora de ordem e depois do resto da importação.
    for (const aba of abas) {
      for (const c of aba.dados.categorias) await idCategoria(c);
    }

    // Para as despesas a descrição só *classifica*: se ela bate com uma
    // categoria existente o vínculo é feito, senão fica sem categoria. Criar
    // categoria a partir de descrição transformaria cada compra numa categoria.
    const classificar = (descricao) => cacheCategorias.get(normalizar(descricao)) ?? null;

    const cacheCartoes = new Map(
      (await tx.prepare('SELECT id, nome FROM cartoes').all()).map((c) => [normalizar(c.nome), c.id]),
    );
    const cores = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
    const insCartao = tx.prepare('INSERT INTO cartoes (nome, cor) VALUES (?, ?) RETURNING id');
    const idCartao = async (nome) => {
      const chave = normalizar(nome);
      if (cacheCartoes.has(chave)) return cacheCartoes.get(chave);
      const { linha } = await insCartao.run(String(nome).trim(), cores[cacheCartoes.size % cores.length]);
      cacheCartoes.set(chave, linha.id);
      relatorio.criados.cartoes += 1;
      return linha.id;
    };

    const cachePessoas = new Map(
      (await tx.prepare('SELECT id, nome FROM pessoas').all()).map((p) => [normalizar(p.nome), p.id]),
    );
    const insPessoa = tx.prepare('INSERT INTO pessoas (nome, reembolsa) VALUES (?, 1) RETURNING id');
    const idPessoa = async (nome) => {
      const chave = normalizar(nome);
      if (!chave) return null;
      if (cachePessoas.has(chave)) return cachePessoas.get(chave);
      const { linha } = await insPessoa.run(String(nome).trim());
      cachePessoas.set(chave, linha.id);
      relatorio.criados.pessoas += 1;
      return linha.id;
    };
    for (const aba of abas) {
      for (const p of aba.dados.pessoas) await idPessoa(p);
    }

    // Uma linha de renda com nome de pessoa é o SUMIF de reembolso da planilha;
    // o app recalcula isso sozinho, então essas linhas não viram receita.
    const nomesPessoas = new Set([...cachePessoas.keys()]);

    // ---- agregadores de vigência ------------------------------------------
    const contas = new Map();      // descricao|valor|forma  -> Set(mes)
    const receitas = new Map();    // descricao|valor        -> Set(mes)
    const parcelas = new Map();    // cartao|valor|parcelas|mesInicio -> registro

    const registrar = (mapa, chave, mes, extra) => {
      if (!mapa.has(chave)) mapa.set(chave, { ...extra, meses: new Set() });
      mapa.get(chave).meses.add(mes);
    };

    const insLancamento = tx.prepare(`
      INSERT INTO lancamentos (mes, data, cartao_id, categoria_id, pessoa_id, descricao, valor)
      VALUES (@mes, @data, @cartao_id, @categoria_id, @pessoa_id, @descricao, @valor)`);
    const insEncargo = tx.prepare(`
      INSERT INTO encargos (mes, cartao_id, valor) VALUES (?, ?, ?)
      ON CONFLICT (mes, cartao_id) DO UPDATE SET valor = excluded.valor`);

    for (const { mes, dados } of abas) {
      for (const e of dados.encargos) {
        if (!e.valor) continue;
        await insEncargo.run(mes, await idCartao(e.cartao), e.valor);
        relatorio.criados.encargos += 1;
      }

      for (const r of dados.receitas) {
        if (nomesPessoas.has(normalizar(r.descricao))) continue;
        registrar(receitas, `${normalizar(r.descricao)}|${r.valor}`, mes,
          { descricao: r.descricao, valor: r.valor, tipo: r.valor < 0 ? 'ajuste' : 'fixa' });
      }

      for (const c of dados.contas) {
        registrar(contas, `${normalizar(c.descricao)}|${c.valor}|${normalizar(c.forma)}`, mes,
          { descricao: c.descricao, valor: c.valor, forma: c.forma });
      }

      for (const d of dados.despesas) {
        const cartaoId = await idCartao(d.cartao);
        const pessoaId = d.pessoa ? await idPessoa(d.pessoa) : null;
        const categoriaId = classificar(d.descricao);
        const descricao = d.descricao || SEM_DESCRICAO;

        if (d.tipo === 'parcelamento') {
          const inicio = somarMeses(mes, -(d.parcela_atual - 1));
          const grupo = `${cartaoId}|${d.parcelas}|${inicio}`;
          // O valor da parcela oscila alguns centavos entre as abas (326,68 numa,
          // 326,58 na outra). Casar por valor exato criaria duas compras e dobraria
          // a dívida, então a comparação usa tolerância.
          const tolerancia = Math.max(1, d.valor * 0.01);
          const existente = [...parcelas.values()].find((p) => p.grupo === grupo
            && Math.abs(p.valor_parcela - d.valor) <= tolerancia);

          if (existente) {
            // Abas mais recentes descrevem a mesma compra: fica o melhor dado.
            if (existente.descricao === SEM_DESCRICAO && descricao !== SEM_DESCRICAO) {
              existente.descricao = descricao;
              existente.categoria_id = categoriaId;
            }
            if (!existente.pessoa_id && pessoaId) existente.pessoa_id = pessoaId;
            // As abas são lidas em ordem: o valor da fatura mais recente vale.
            existente.valor_parcela = d.valor;
            continue;
          }
          parcelas.set(`${grupo}|${d.valor}`, {
            grupo,
            cartao_id: cartaoId,
            categoria_id: categoriaId,
            pessoa_id: pessoaId,
            descricao,
            valor_parcela: d.valor,
            parcelas: d.parcelas,
            mes_inicio: inicio,
            data_compra: d.data || null,
          });
          continue;
        }

        await insLancamento.run({
          mes,
          data: d.data || null,
          cartao_id: cartaoId,
          categoria_id: categoriaId,
          pessoa_id: pessoaId,
          descricao,
          valor: d.valor,
        });
        relatorio.criados.lancamentos += 1;
      }
    }

    // ---- grava o que é recorrente, já em faixas de vigência ----------------
    //
    // Uma faixa só continua em aberto se terminar na última aba da planilha *e*
    // tiver durado ao menos dois meses. A segunda condição é o que separa um
    // salário (repete) de um saque de cheque especial lançado uma vez só: sem
    // ela, um ajuste pontual da última aba seria projetado para sempre.
    const fimOuAberto = (faixa) => (
      faixa.fim === ultimoMes && diferencaMeses(faixa.inicio, faixa.fim) >= 1 ? null : faixa.fim
    );

    const insConta = tx.prepare(`
      INSERT INTO contas (descricao, valor, forma, mes_inicio, mes_fim)
      VALUES (@descricao, @valor, @forma, @mes_inicio, @mes_fim)`);
    for (const item of contas.values()) {
      for (const faixa of comprimirVigencias(item.meses)) {
        await insConta.run({ ...item, mes_inicio: faixa.inicio, mes_fim: fimOuAberto(faixa) });
        relatorio.criados.contas += 1;
      }
    }

    const insReceita = tx.prepare(`
      INSERT INTO receitas (descricao, valor, tipo, mes_inicio, mes_fim)
      VALUES (@descricao, @valor, @tipo, @mes_inicio, @mes_fim)`);
    for (const item of receitas.values()) {
      for (const faixa of comprimirVigencias(item.meses)) {
        await insReceita.run({ ...item, mes_inicio: faixa.inicio, mes_fim: fimOuAberto(faixa) });
        relatorio.criados.receitas += 1;
      }
    }

    const insParcelamento = tx.prepare(`
      INSERT INTO parcelamentos (cartao_id, categoria_id, pessoa_id, descricao, valor_parcela, parcelas, mes_inicio, data_compra)
      VALUES (@cartao_id, @categoria_id, @pessoa_id, @descricao, @valor_parcela, @parcelas, @mes_inicio, @data_compra)`);
    for (const { grupo, ...item } of parcelas.values()) {
      await insParcelamento.run(item);
      relatorio.criados.parcelamentos += 1;
    }

    const { n: semDescricao } = await tx.prepare(
      'SELECT COUNT(*) AS n FROM lancamentos WHERE descricao = ?').get(SEM_DESCRICAO);
    if (semDescricao > 0) {
      relatorio.avisos.push(
        `${semDescricao} lançamentos vieram sem descrição na planilha e ficaram como "${SEM_DESCRICAO}". `
        + 'Sem descrição eles não têm categoria — vale revisá-los na tela de Lançamentos.',
      );
    }
  });

  return relatorio;
}
