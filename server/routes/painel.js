import { Router } from 'express';
import { db } from '../db/index.js';
import { resumoDoMes, projecao, mesesComDados, contasDoMes, receitasDoMes } from '../services/mes.js';
import { mesAtual, ehMes, somarMeses, intervalo } from '../lib/mes.js';

export const painel = Router();

painel.get('/meses', async (_req, res, next) => {
  try {
  const existentes = await mesesComDados();
  const hoje = mesAtual();
  // Sempre oferece o mês corrente e os dois seguintes, mesmo sem lançamento.
  const conhecidos = new Set([...existentes, hoje, somarMeses(hoje, 1), somarMeses(hoje, 2)]);
  const ordenados = [...conhecidos].sort();
  const completos = ordenados.length > 1
    ? intervalo(ordenados[0], ordenados[ordenados.length - 1])
    : ordenados;
  res.json({ atual: hoje, meses: completos, com_dados: existentes });
  } catch (erro) { next(erro); }
});

painel.get('/resumo', async (req, res, next) => {
  try {
  const mes = ehMes(req.query.mes) ? req.query.mes : mesAtual();
  const resumo = await resumoDoMes(mes);
  const anterior = await resumoDoMes(somarMeses(mes, -1));
  res.json({
    ...resumo,
    comparativo: {
      mes: anterior.mes,
      divida_total: anterior.divida_total,
      renda_liquida: anterior.renda_liquida,
      saldo: anterior.saldo,
      variacao_divida: anterior.divida_total > 0
        ? Math.round(((resumo.divida_total - anterior.divida_total) / anterior.divida_total) * 1000) / 10
        : null,
    },
  });
  } catch (erro) { next(erro); }
});

painel.get('/projecao', async (req, res, next) => {
  try {
  const mes = ehMes(req.query.mes) ? req.query.mes : mesAtual();
  const meses = Math.min(Math.max(Number(req.query.meses) || 6, 1), 24);
  res.json({ mes, meses, linhas: await projecao(mes, meses) });
  } catch (erro) { next(erro); }
});

painel.get('/mes/:mes', async (req, res, next) => {
  try {
  const { mes } = req.params;
  if (!ehMes(mes)) return res.status(400).json({ erro: 'Mês inválido. Use o formato AAAA-MM.' });
  return res.json({
    resumo: await resumoDoMes(mes),
    contas: await contasDoMes(mes),
    receitas: await receitasDoMes(mes),
  });
  } catch (erro) { return next(erro); }
});

/** Números globais para a tela de configurações / diagnóstico. */
painel.get('/estatisticas', async (_req, res, next) => {
  try {
  const contar = async (t) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n;
  res.json({
    cartoes: await contar('cartoes'),
    contas_bancarias: await contar('contas_bancarias'),
    categorias: await contar('categorias'),
    pessoas: await contar('pessoas'),
    lancamentos: await contar('lancamentos'),
    parcelamentos: await contar('parcelamentos'),
    contas: await contar('contas'),
    receitas: await contar('receitas'),
    meses: (await mesesComDados()).length,
  });
  } catch (erro) { next(erro); }
});
