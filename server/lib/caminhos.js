import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));

export const raizProjeto = path.resolve(aqui, '..', '..');
export const pastaCliente = path.join(raizProjeto, 'client', 'dist');
