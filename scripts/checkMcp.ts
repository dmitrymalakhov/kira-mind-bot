import { McpService } from '../services/mcp/client';
import { MCP_CONFIG_FILE, readMcpConfig } from '../services/mcp/config';

async function main() {
    const args = process.argv.slice(2);
    let file = MCP_CONFIG_FILE;
    const index = args.indexOf('--config');
    if (index >= 0) {
        if (!args[index + 1]) throw new Error('После --config нужен путь');
        file = args.splice(index, 2)[1];
    }
    const service = new McpService(() => readMcpConfig(file));
    const servers = service.servers().filter(server => !args[0] || server.id === args[0]);
    if (!servers.length) throw new Error('MCP-серверы не настроены в выбранном файле');
    for (const server of servers) {
        try {
            const page = await service.listTools(server.id);
            console.log(`${server.id}: initialize/tools/list OK; разрешено ${page.total} инструментов на странице сервера${page.nextCursor ? ', есть nextCursor' : ''}.`);
        } catch {
            console.error(`${server.id}: проверка не пройдена. Проверь транспорт, доступность и авторизацию (credentials скрыты).`);
            process.exitCode = 1;
        }
    }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Проверка MCP не завершена'); process.exitCode = 1; });
