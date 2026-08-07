/**
 * Importa uma planilha pela linha de comando:
 *   npm run importar -- "Planilha 2026.xlsx"
 *   npm run importar -- "Planilha 2026.xlsx" --ano 2026 --somar
 */
import path from 'node:path';
import { migrar, semear, esperarBanco, encerrar } from '../db/index.js';
import { importarPlanilha } from '../services/importador.js';
import { raizProjeto } from '../lib/caminhos.js';

const args = process.argv.slice(2);
const nome = args.find((a) => !a.startsWith('--')) || 'Planilha 2026.xlsx';
const ano = args.includes('--ano') ? Number(args[args.indexOf('--ano') + 1]) : undefined;
const substituir = !args.includes('--somar');

async function principal() {
  await esperarBanco();
  await migrar();
  await semear();

  const relatorio = await importarPlanilha({
    arquivo: path.isAbsolute(nome) ? nome : path.join(raizProjeto, nome),
    ano,
    substituir,
  });
  console.log(`\nPlanilha: ${relatorio.arquivo}  (ano ${relatorio.ano})`);
  console.log(`Abas importadas: ${relatorio.abas.map((a) => a.aba).join(', ')}\n`);
  for (const [chave, valor] of Object.entries(relatorio.criados)) {
    console.log(`  ${chave.padEnd(16)} ${valor}`);
  }
  relatorio.avisos.forEach((a) => console.log(`\n  aviso: ${a}`));
  console.log('');
}

principal()
  .catch((erro) => {
    console.error(`\nFalha na importação: ${erro.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => encerrar());
