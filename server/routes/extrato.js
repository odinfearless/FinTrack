import { Router } from 'express';
import multer from 'multer';
import { db, transacao } from '../db/index.js';
import { extrair, analisar } from '../services/leitorExtrato.js';
import { normalizar } from '../services/categorias.js';
import { contasDoMes, receitasDoMes, despesasDoMes } from '../services/mes.js';
import { ehMes, mesAtual, somarMeses } from '../lib/mes.js';

export const extrato = Router();

// Arquivo fica só em memória: um extrato traz saldo, limite e o nome de quem
// recebeu cada Pix. Não há motivo para deixar isso em disco depois de lido.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, arquivo, cb) => {
    if (/\.pdf$/i.test(arquivo.originalname)) return cb(null, true);
    const erro = new Error('Envie o extrato em PDF, como o banco disponibiliza para download.');
    erro.status = 400;
    return cb(erro);
  },
});

/* ------------------------------- etapa 1 ---------------------------------- */

/**
 * A conta bancária já cadastrada que corresponde ao extrato enviado.
 *
 * Agência e número identificam a conta melhor que o nome do banco: quem tem
 * duas contas no mesmo banco veria as duas se a busca fosse só pelo banco, e
 * escolher a errada mandaria os lançamentos para o lugar errado.
 */
async function acharContaBancaria(cabecalho) {
  const contas = await db.prepare('SELECT * FROM contas_bancarias').all();
  const digitos = (v) => String(v ?? '').replace(/\D/g, '');

  if (cabecalho.numero) {
    const porNumero = contas.find((c) => digitos(c.numero) === digitos(cabecalho.numero)
      && (!cabecalho.agencia || !c.agencia || digitos(c.agencia) === digitos(cabecalho.agencia)));
    if (porNumero) return porNumero;
  }

  // Sem número casando, o banco só serve quando há uma conta dele e mais
  // nenhuma — aí não há como errar de conta.
  if (!cabecalho.banco) return null;
  const doBanco = contas.filter((c) => normalizar(c.banco) === normalizar(cabecalho.banco));
  return doBanco.length === 1 ? doBanco[0] : null;
}

const chaveDe = (descricao, valor) => `${normalizar(descricao)}|${Math.round(Number(valor) * 100)}`;

/**
 * Marca o que já existe no app, para a mesma linha não entrar duas vezes.
 *
 * A comparação é feita mês a mês porque um extrato atravessa a virada do mês —
 * o do Itaú vai do dia 7 ao dia 6 do seguinte — e cada lançamento tem que ser
 * procurado na competência dele, não numa competência única.
 *
 * Conta tem regra própria: ela é um cadastro que se repete, não um lançamento
 * de um mês. Encontrar uma conta com o mesmo nome já basta para avisar, mesmo
 * que o valor tenha mudado — a luz nunca vem igual duas vezes, e cadastrar a
 * segunda faria as duas somarem no painel.
 */
async function marcarConhecidos(itens) {
  const meses = [...new Set(itens.map((i) => i.mes).filter(Boolean))];
  // Um mês por vez: `Promise.all` sobre todos os meses de um extrato dispararia
  // três consultas por mês de uma vez, e o ganho não paga a fila no pool.
  const cache = new Map();
  for (const mes of meses) {
    cache.set(mes, {
      receitas: new Set((await receitasDoMes(mes)).map((r) => chaveDe(r.descricao, r.valor))),
      gastos: new Set((await despesasDoMes(mes))
        .filter((d) => !d.cartao_id)
        .map((d) => chaveDe(d.descricao, d.valor))),
      contas: await contasDoMes(mes),
    });
  }

  return itens.map((item) => {
    const doMes = cache.get(item.mes);
    if (!doMes) return item;

    if (item.destino === 'conta') {
      const existente = doMes.contas.find((c) => normalizar(c.descricao) === normalizar(item.descricao));
      if (!existente) return item;
      return {
        ...item,
        duplicata: true,
        selecionado: false,
        existente: {
          id: existente.id,
          valor: existente.valor,
          mes_inicio: existente.mes_inicio,
          mes_fim: existente.mes_fim,
        },
      };
    }

    const conjunto = item.destino === 'receita' ? doMes.receitas : doMes.gastos;
    return conjunto.has(chaveDe(item.descricao, item.valor))
      ? { ...item, duplicata: true, selecionado: false }
      : item;
  });
}

/** Etapa 1 — lê o arquivo e devolve os candidatos. Não grava nada. */
extrato.post('/ler', upload.single('arquivo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo foi enviado.' });

    const mesPadrao = ehMes(req.body?.mes) ? req.body.mes : mesAtual();

    const { linhas, conta, saldos, paginas, colunas_detectadas: colunas } = await extrair(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );

    const categorias = await db.prepare('SELECT id, nome FROM categorias').all();
    const { itens, descartadas, totais, conferencia } = analisar(linhas, {
      mesPadrao, categorias, saldos,
    });

    return res.json({
      arquivo: req.file.originalname,
      paginas,
      // Falso quer dizer que o cabeçalho "valor | saldo" não foi encontrado e
      // todo número virou lançamento. A tela avisa, porque aí vale conferir
      // linha por linha se algum saldo entrou como despesa.
      colunas_detectadas: colunas,
      conta,
      conta_bancaria: await acharContaBancaria(conta),
      conferencia,
      totais,
      linhas_lidas: linhas.length,
      itens: await marcarConhecidos(itens),
      descartadas: descartadas.slice(0, 40),
    });
  } catch (erro) {
    return next(erro);
  }
});

/* ------------------------------- etapa 2 ---------------------------------- */

/**
 * Até quando o registro vale.
 *
 * O padrão é só o mês do lançamento, e é o padrão certo: o extrato mostra um
 * mês, e afirmar a partir dele que a conta de luz vale para sempre espalharia
 * pela projeção inteira um valor que muda toda fatura. Quem sabe que repete
 * marca a caixinha e o fim vira nulo.
 *
 * Com parcela conhecida a conta se fecha sozinha: começa neste mês e termina em
 * quantas ainda faltam. Nada é escrito para trás — as parcelas já vencidas
 * pertencem a meses que o usuário já fechou.
 */
function vigenciaDe(item, mes) {
  if (item.recorrente) return null;
  const total = Number(item.parcela?.total);
  const atual = Number(item.parcela?.atual);
  if (Number.isFinite(total) && Number.isFinite(atual) && total > atual) {
    return somarMeses(mes, total - atual);
  }
  return mes;
}

const DESTINOS = new Set(['receita', 'conta', 'gasto']);

/** Etapa 2 — grava o que o usuário revisou e confirmou. */
extrato.post('/confirmar', async (req, res, next) => {
  try {
    const { itens, conta_bancaria_id: contaId } = req.body || {};
    const mesPadrao = ehMes(req.body?.mes) ? req.body.mes : mesAtual();

    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: 'Selecione ao menos um lançamento para importar.' });
    }

    let contaBancaria = null;
    if (contaId) {
      contaBancaria = await db.prepare('SELECT id, nome FROM contas_bancarias WHERE id = ?').get(Number(contaId));
      if (!contaBancaria) return res.status(404).json({ erro: 'Conta bancária não encontrada.' });
    }

    const criados = { receitas: 0, contas: 0, gastos: 0 };
    const ignorados = [];

    // Tudo ou nada: metade de um extrato importado deixa o mês num estado que
    // ninguém consegue auditar contra o documento.
    await transacao(async (tx) => {
      const insReceita = tx.prepare(`
      INSERT INTO receitas (descricao, valor, tipo, conta_bancaria_id, mes_inicio, mes_fim)
        VALUES (@descricao, @valor, @tipo, @conta_bancaria_id, @mes_inicio, @mes_fim)`);
      const insConta = tx.prepare(`
      INSERT INTO contas (descricao, valor, forma, categoria_id, conta_bancaria_id,
                          dia_vencimento, mes_inicio, mes_fim)
      VALUES (@descricao, @valor, @forma, @categoria_id, @conta_bancaria_id,
              @dia_vencimento, @mes_inicio, @mes_fim)`);
      const insGasto = tx.prepare(`
      INSERT INTO lancamentos (mes, data, forma, categoria_id, conta_bancaria_id,
                               descricao, valor, observacao)
      VALUES (@mes, @data, @forma, @categoria_id, @conta_bancaria_id,
              @descricao, @valor, @observacao)`);

      for (const item of itens) {
        const descricao = String(item.descricao || '').trim();
        const valor = Number(item.valor);
        const mes = ehMes(item.mes) ? item.mes : mesPadrao;

        if (!descricao || !Number.isFinite(valor) || valor === 0) {
          ignorados.push({ descricao: descricao || '(vazio)', motivo: 'descrição ou valor inválido' });
          continue;
        }
        if (!DESTINOS.has(item.destino)) {
          ignorados.push({ descricao, motivo: `destino desconhecido: ${item.destino}` });
          continue;
        }

        const comum = {
          descricao,
          conta_bancaria_id: contaBancaria?.id ?? null,
          categoria_id: item.categoria_id || null,
        };

        if (item.destino === 'receita') {
          await insReceita.run({
            descricao: comum.descricao,
            conta_bancaria_id: comum.conta_bancaria_id,
            // Receita negativa é o ajuste da planilha — juros do limite, cheque
            // especial —, então o sinal do extrato é preservado como veio.
            valor,
            tipo: item.tipo || (valor < 0 ? 'ajuste' : 'variavel'),
            mes_inicio: mes,
            mes_fim: vigenciaDe(item, mes),
          });
          criados.receitas += 1;
          continue;
        }

        if (item.destino === 'conta') {
          await insConta.run({
            ...comum,
            // Em `contas` e em `lancamentos` a despesa é positiva: lá o sinal
            // de menos significa estorno, e não saída de dinheiro.
            valor: Math.abs(valor),
            forma: item.forma || 'D.AUTO',
            dia_vencimento: Number(item.dia_vencimento) || null,
            mes_inicio: mes,
            mes_fim: vigenciaDe(item, mes),
          });
          criados.contas += 1;
          continue;
        }

        await insGasto.run({
          ...comum,
          mes,
          data: item.data || null,
          valor: Math.abs(valor),
          // Sem cartão, é a forma que identifica de onde o gasto saiu — e o
          // banco exige uma das duas.
          forma: item.forma || 'Débito',
          observacao: item.linha_original
            ? `Importado do extrato: ${item.linha_original}`.slice(0, 300)
            : null,
        });
        criados.gastos += 1;
      }
    });

    return res.json({
      conta_bancaria: contaBancaria?.nome || null,
      total: criados.receitas + criados.contas + criados.gastos,
      criados,
      ignorados,
    });
  } catch (erro) {
    return next(erro);
  }
});
