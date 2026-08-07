import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { migrar, semear, esperarBanco, descricaoBanco } from './db/index.js';
import { pastaCliente } from './lib/caminhos.js';
import {
  cartoes, categorias, pessoas, encargos, contasBancarias,
} from './routes/cadastros.js';
import {
  lancamentos, parcelamentos, contas, receitas, despesas, limpeza,
} from './routes/despesas.js';
import { painel } from './routes/painel.js';
import { importacao } from './routes/importacao.js';
import { fatura } from './routes/fatura.js';
import { extrato } from './routes/extrato.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api/cartoes', cartoes);
app.use('/api/contas-bancarias', contasBancarias);
app.use('/api/categorias', categorias);
app.use('/api/pessoas', pessoas);
app.use('/api/encargos', encargos);
app.use('/api/lancamentos', lancamentos);
app.use('/api/parcelamentos', parcelamentos);
app.use('/api/contas', contas);
app.use('/api/receitas', receitas);
app.use('/api/despesas', despesas);
app.use('/api/limpeza', limpeza);
app.use('/api/importacao', importacao);
app.use('/api/fatura', fatura);
app.use('/api/extrato', extrato);
app.use('/api', painel);

app.get('/api/saude', (_req, res) => res.json({ ok: true, banco: descricaoBanco }));

// Em produção o Express também serve o build do React.
if (fs.existsSync(pastaCliente)) {
  app.use(express.static(pastaCliente));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(pastaCliente, 'index.html')));
}

app.use((_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

app.use((erro, _req, res, _next) => {
  if (erro.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ erro: 'O arquivo passa de 15 MB. Envie uma fatura menor ou só as páginas de lançamentos.' });
  }
  const status = erro.status || 500;
  if (status >= 500) console.error(erro);
  const conflito = /UNIQUE constraint failed/.test(erro.message)
    ? 'Já existe um registro com esse nome.'
    : null;
  return res.status(conflito ? 409 : status).json({ erro: conflito || erro.message || 'Erro interno.' });
});

const porta = Number(process.env.PORT) || 3333;

/**
 * O servidor só passa a ouvir depois que o banco está pronto.
 *
 * Com o SQLite isso era instantâneo — abrir um arquivo. Com o Postgres, quem
 * responde é outro processo, que no Docker sobe junto e leva alguns segundos; e
 * a migração é assíncrona. Ouvir antes disso aceitaria requisições que
 * quebrariam por tabela inexistente, e o usuário veria erro 500 numa tela que
 * só precisava esperar.
 */
async function iniciar() {
  await esperarBanco();
  await migrar();
  const semeou = await semear();

  app.listen(porta, () => {
    console.log(`FinTrack • API em http://localhost:${porta}`);
    console.log(`FinTrack • banco em ${descricaoBanco}`);
    if (semeou) console.log('FinTrack • categorias iniciais criadas');
  });
}

iniciar().catch((erro) => {
  console.error('FinTrack • não foi possível iniciar:', erro.message);
  process.exit(1);
});
