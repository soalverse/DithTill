// Bootstraps tsx, then starts the halftone MCP server. The server (and the
// DithTill core it imports) uses extensionless TypeScript imports, which plain
// `node` cannot resolve — tsx can. `tsx/esm/api` resolves relative to THIS file
// (the repo's node_modules), so the launcher works from any cwd:
//   node scripts/mcp/halftone-server-launcher.mjs
import { register } from 'tsx/esm/api';

register();
const { startHalftoneServer } = await import('./halftone-server.ts');
await startHalftoneServer();
