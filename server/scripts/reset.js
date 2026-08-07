/**
 * Esvazia o banco e recria o esquema.
 *   npm run reset -- --sim
 *
 * No SQLite isto apagava o arquivo. No Postgres o banco é de outro processo, e
 * quem some são as tabelas: `DROP TABLE ... CASCADE` derruba as dependências
 * entre elas de uma vez, e `migrar()` reconstrói tudo vazio em seguida — assim
 * o comando termina com o banco pronto para uso, e não com o app quebrado até
 * a próxima subida.
 */
import { db, migrar, esperarBanco, encerrar, descricaoBanco } from '../db/index.js';

const TABELAS = ['encargos', 'receitas', 'contas', 'parcelamentos', 'lancamentos',
  'pessoas', 'categorias', 'contas_bancarias', 'cartoes'];

async function principal() {
  if (!process.argv.includes('--sim')) {
    console.log(`\nIsto apaga TODOS os dados de ${descricaoBanco}.`);
    console.log('Confirme com:  npm run reset -- --sim\n');
    return;
  }

  await esperarBanco();
  await db.exec(`DROP TABLE IF EXISTS ${TABELAS.join(', ')} CASCADE`);
  await migrar();

  console.log(`\nBanco esvaziado e esquema recriado: ${descricaoBanco}`);
  console.log('As categorias iniciais voltam no próximo "npm run dev".\n');
}

principal()
  .catch((erro) => {
    console.error('\nFalhou:', erro.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => encerrar());
