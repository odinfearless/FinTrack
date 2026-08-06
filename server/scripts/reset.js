/**
 * Apaga o banco local e recria o esquema vazio.
 *   npm run reset -- --sim
 */
import fs from 'node:fs';
import { arquivoBanco, db } from '../db/index.js';

if (!process.argv.includes('--sim')) {
  console.log(`\nIsto apaga TODOS os dados de ${arquivoBanco}.`);
  console.log('Confirme com:  npm run reset -- --sim\n');
  process.exit(0);
}

db.close();
for (const sufixo of ['', '-wal', '-shm']) {
  const alvo = `${arquivoBanco}${sufixo}`;
  if (fs.existsSync(alvo)) fs.unlinkSync(alvo);
}
console.log(`\nBanco removido: ${arquivoBanco}`);
console.log('Ele será recriado vazio no próximo "npm run dev".\n');
