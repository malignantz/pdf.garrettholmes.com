// Lets plain Node (22.18+, built-in type stripping) import the repo's TypeScript
// sources, whose relative imports have no extension (Vite resolves them in the app).
import { register } from 'node:module';
register('./resolve-ts.mjs', import.meta.url);
