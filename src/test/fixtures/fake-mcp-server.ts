// Fixture usado só pelos testes de mcpClient.ts — processo Node que fala o mesmo
// protocolo JSON-RPC por linha do `cgc mcp start`, com alguns modos controláveis
// via FAKE_MCP_MODE para simular cenários de falha sem precisar do motor real.
import * as readline from 'readline';

type Mode = 'normal' | 'crash-before-init' | 'crash-after-init' | 'hang' | 'malformed-line';

const mode = (process.env.FAKE_MCP_MODE as Mode) || 'normal';

function send(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + '\n');
}

if (mode === 'crash-before-init') {
	// Simula o motor real desistindo depois do retry de lock do KuzuDB.
	process.stderr.write('Could not set lock on file /fake/kuzudb (simulado pelo fixture)\n');
	process.exit(1);
}

if (mode === 'malformed-line') {
	process.stdout.write('isto não é json\n');
}

const rl = readline.createInterface({ input: process.stdin });

let toolCallCount = 0;

rl.on('line', (line) => {
	if (!line.trim()) {
		return;
	}
	const request = JSON.parse(line);

	if (request.method === 'initialize') {
		if (mode === 'hang') {
			return; // nunca responde, para testar timeout de handshake
		}
		send({
			jsonrpc: '2.0',
			id: request.id,
			result: {
				protocolVersion: '2025-03-26',
				serverInfo: { name: 'fake-mcp-server', version: '0.0.0' },
				capabilities: { tools: { listTools: true } },
			},
		});
		return;
	}

	if (request.method === 'notifications/initialized') {
		return; // notificação, sem resposta
	}

	if (request.method === 'tools/call') {
		toolCallCount++;
		if (mode === 'crash-after-init' && toolCallCount === 1) {
			process.stderr.write('Simulated crash after first tool call\n');
			process.exit(1);
		}

		const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
		if (params.name === 'fail') {
			send({
				jsonrpc: '2.0',
				id: request.id,
				error: {
					code: -32000,
					message: 'Tool execution error',
					data: { error: params.arguments?.message ?? 'boom' },
				},
			});
			return;
		}

		send({
			jsonrpc: '2.0',
			id: request.id,
			result: {
				content: [{ type: 'text', text: JSON.stringify({ success: true, echoed: params.arguments ?? {} }) }],
			},
		});
		return;
	}
});
