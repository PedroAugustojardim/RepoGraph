import * as assert from 'assert';
import * as path from 'path';
import { McpClient, McpClientOptions, McpOutputSink, McpExitInfo } from '../mcpClient';

class RecordingOutput implements McpOutputSink {
	lines: string[] = [];
	appendLine(line: string): void {
		this.lines.push(line);
	}
}

const fixturePath = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

function makeClient(
	mode: string,
	overrides: Partial<McpClientOptions> = {},
): { client: McpClient; output: RecordingOutput } {
	process.env.FAKE_MCP_MODE = mode;
	const output = new RecordingOutput();
	const client = new McpClient({
		command: process.execPath,
		args: [fixturePath],
		cwd: __dirname,
		allowedRoots: [],
		outputChannel: output,
		...overrides,
	});
	return { client, output };
}

suite('McpClient', () => {
	teardown(() => {
		delete process.env.FAKE_MCP_MODE;
	});

	test('handshake succeeds and callTool unwraps the tool result', async () => {
		const { client } = makeClient('normal');
		await client.start();
		try {
			assert.strictEqual(client.isAlive, true);
			const result = await client.callTool<{ success: boolean; echoed: unknown }>('echo', { msg: 'hi' });
			assert.strictEqual(result.success, true);
			assert.deepStrictEqual(result.echoed, { msg: 'hi' });
		} finally {
			await client.shutdown();
		}
	});

	test('callTool rejects with the server-provided error message', async () => {
		const { client } = makeClient('normal');
		await client.start();
		try {
			await assert.rejects(client.callTool('fail', { message: 'mensagem customizada' }), /mensagem customizada/);
		} finally {
			await client.shutdown();
		}
	});

	test('start() rejects with a friendly message when the server crashes before the handshake', async () => {
		const { client } = makeClient('crash-before-init');
		await assert.rejects(client.start(), /banco de dados está em uso/);
		assert.strictEqual(client.isAlive, false);
	});

	test('start() rejects on handshake timeout instead of hanging forever', async () => {
		const { client } = makeClient('hang', { handshakeTimeoutMs: 300 });
		await assert.rejects(client.start(), /Tempo limite excedido/);
	});

	test('unexpected exit after start rejects in-flight calls and notifies onDidExit', async () => {
		const { client } = makeClient('crash-after-init');
		await client.start();

		let exitInfo: McpExitInfo | undefined;
		client.onDidExit((info) => {
			exitInfo = info;
		});

		await assert.rejects(client.callTool('echo', {}));
		assert.strictEqual(exitInfo?.expected, false);
		assert.strictEqual(client.isAlive, false);
	});

	test('shutdown() ends the process gracefully and marks the exit as expected', async () => {
		const { client } = makeClient('normal');
		await client.start();

		let exitInfo: McpExitInfo | undefined;
		client.onDidExit((info) => {
			exitInfo = info;
		});

		await client.shutdown();
		assert.strictEqual(exitInfo?.expected, true);
		assert.strictEqual(client.isAlive, false);
	});

	test('a malformed line on stdout is ignored instead of breaking the client', async () => {
		const { client, output } = makeClient('malformed-line');
		await client.start();
		try {
			const result = await client.callTool<{ success: boolean }>('echo', {});
			assert.strictEqual(result.success, true);
			assert.ok(output.lines.some((l) => l.includes('não-JSON')));
		} finally {
			await client.shutdown();
		}
	});
});
