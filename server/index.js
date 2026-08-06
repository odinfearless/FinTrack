import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { migrar, semear, arquivoBanco } from './db/index.js';
import { pastaCliente } from './lib/caminhos.js';
import { cartoes, categorias, pessoas, encargos } from './routes/cadastros.js';
import {
  lancamentos, parcelamentos, contas, receitas, despesas,
} from './routes/despesas.js';
import { painel } from './routes/painel.js';
import { importacao } from './routes/importacao.js';
import { fatura } from './routes/fatura.js';

migrar();
const semeou = semear();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api/cartoes', cartoes);
app.use('/api/categorias', categorias);
app.use('/api/pessoas', pessoas);
app.use('/api/encargos', encargos);
app.use('/api/lancamentos', lancamentos);
app.use('/api/parcelamentos', parcelamentos);
app.use('/api/contas', contas);
app.use('/api/receitas', receitas);
app.use('/api/despesas', despesas);
app.use('/api/importacao', importacao);
app.use('/api/fatura', fatura);
app.use('/api', painel);

app.get('/api/saude', (_req, res) => res.json({ ok: true, banco: arquivoBanco }));

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
app.listen(porta, () => {
  console.log(`FinTrack • API em http://localhost:${porta}`);
  console.log(`FinTrack • banco em ${arquivoBanco}`);
  if (semeou) console.log('FinTrack • categorias iniciais criadas');
});
