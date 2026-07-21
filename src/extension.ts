// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { friendlyEngineError, isEngineVersionSufficient, parseEngineVersion, MIN_ENGINE_VERSION } from './engineErrors';
import { EngineGate } from './engineGate';
import { McpClient, McpExitInfo } from './mcpClient';

const REPOSITORIES_KEY = 'repograph.repositories';
const STATUS_KEY = 'repograph.status';
const WATCH_KEY = 'repograph.watchState';
const ENGINE_COMMAND = 'cgc';
const ENGINE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

type RepoStatus = 'pending' | 'indexed' | 'error';
type WatchState = 'off' | 'starting' | 'watching' | 'error';

// Conexão persistente com `cgc mcp start`, usada só enquanto pelo menos um
// repositório está em modo watch. Precisa ser module-level (não local a
// activate()) para que deactivate() consiga encerrá-la de forma graciosa.
const engineGate = new EngineGate();
let mcpClient: McpClient | undefined;
// Hook para a tree view se atualizar a partir de código que roda "abaixo" da UI
// (ex: ensureMcpClientForRoots, chamado de dentro de withEngine) sem precisar
// threadar o RepositoryTreeProvider por todas as funções de baixo nível.
let refreshRepositoriesView: (() => void) | undefined;

interface GraphNode {
	id: string;
	type: string;
}

interface GraphEdge {
	source: string;
	target: string;
	type: string;
}

function getRepositories(context: vscode.ExtensionContext): string[] {
	return context.globalState.get<string[]>(REPOSITORIES_KEY, []);
}

function getStatuses(context: vscode.ExtensionContext): Record<string, RepoStatus> {
	return context.globalState.get<Record<string, RepoStatus>>(STATUS_KEY, {});
}

async function setStatus(context: vscode.ExtensionContext, folderPath: string, status: RepoStatus): Promise<void> {
	const statuses = getStatuses(context);
	statuses[folderPath] = status;
	await context.globalState.update(STATUS_KEY, statuses);
}

async function clearStatus(context: vscode.ExtensionContext, folderPath: string): Promise<void> {
	const statuses = getStatuses(context);
	delete statuses[folderPath];
	await context.globalState.update(STATUS_KEY, statuses);
}

function getWatchStates(context: vscode.ExtensionContext): Record<string, WatchState> {
	return context.globalState.get<Record<string, WatchState>>(WATCH_KEY, {});
}

async function setWatchState(context: vscode.ExtensionContext, folderPath: string, state: WatchState): Promise<void> {
	const states = getWatchStates(context);
	states[folderPath] = state;
	await context.globalState.update(WATCH_KEY, states);
}

async function clearWatchState(context: vscode.ExtensionContext, folderPath: string): Promise<void> {
	const states = getWatchStates(context);
	delete states[folderPath];
	await context.globalState.update(WATCH_KEY, states);
}

function getWatchingPaths(context: vscode.ExtensionContext): string[] {
	return Object.entries(getWatchStates(context))
		.filter(([, state]) => state === 'watching')
		.map(([path]) => path);
}

function getActiveWatchPaths(context: vscode.ExtensionContext): string[] {
	return Object.entries(getWatchStates(context))
		.filter(([, state]) => state === 'watching' || state === 'starting')
		.map(([path]) => path);
}

function isWatchModeActive(context: vscode.ExtensionContext): boolean {
	return getActiveWatchPaths(context).length > 0;
}

class RepositoryTreeProvider implements vscode.TreeDataProvider<string> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(folderPath: string): vscode.TreeItem {
		const status = getStatuses(this.context)[folderPath] ?? 'pending';
		const statusLabel = { pending: 'pendente', indexed: 'indexado', error: 'erro' }[status];
		const watch = getWatchStates(this.context)[folderPath] ?? 'off';
		const watchSuffix = {
			off: '',
			starting: ' · sincronizando',
			watching: ' · observando',
			error: ' · watch com erro',
		}[watch];

		const item = new vscode.TreeItem(folderPath.split(/[\\/]/).pop() ?? folderPath);
		item.description = statusLabel + watchSuffix;
		item.tooltip = folderPath;
		item.iconPath = new vscode.ThemeIcon(
			watch === 'watching'
				? 'eye'
				: watch === 'starting'
					? 'sync~spin'
					: status === 'indexed'
						? 'check'
						: status === 'error'
							? 'error'
							: 'clock',
		);
		item.contextValue = watch === 'watching' || watch === 'starting' ? 'repository.watching' : 'repository';
		item.command = { command: 'repograph.revealOutput', title: 'Ver log', arguments: [] };
		return item;
	}

	getChildren(): string[] {
		return getRepositories(this.context);
	}
}

class GraphViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private pendingData?: { nodes: GraphNode[]; edges: GraphEdge[] };
	private ready = false;

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.ready = false;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
		};
		webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
			if (message?.type === 'ready') {
				this.ready = true;
				if (this.pendingData) {
					this.post(this.pendingData);
				}
			}
		});
		webviewView.webview.html = this.buildHtml(webviewView.webview);
	}

	showGraph(nodes: GraphNode[], edges: GraphEdge[]): void {
		this.pendingData = { nodes, edges };
		if (this.view && this.ready) {
			this.post(this.pendingData);
		}
	}

	private post(data: { nodes: GraphNode[]; edges: GraphEdge[] }): void {
		this.view?.webview.postMessage({ type: 'graph', nodes: data.nodes, edges: data.edges });
	}

	private buildHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'graph.js'));
		const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2);
		return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:var(--vscode-editor-background);overflow:hidden;color:var(--vscode-foreground);font-family:var(--vscode-font-family);}
#graph,#empty{width:100%;height:100%;}
#empty{display:none;align-items:center;justify-content:center;text-align:center;padding:1em;box-sizing:border-box;}
</style>
</head>
<body>
<div id="graph"></div>
<div id="empty">Nenhuma relação encontrada para este repositório.</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function runEngineCommandSpawn(args: string[], outputChannel: vscode.OutputChannel): Promise<void> {
	return new Promise((resolve, reject) => {
		outputChannel.show(true);
		outputChannel.appendLine(`\n> cgc ${args.join(' ')}`);

		// Args passados como array (não concatenados em string) para evitar injeção de comando.
		// PYTHONIOENCODING força UTF-8 na saída do processo Python: sem isso, no Windows,
		// stdout redirecionado (pipe) cai para a codepage ANSI do sistema e o CLI trava com
		// UnicodeEncodeError ao imprimir emojis/símbolos nas mensagens.
		const child = spawn(ENGINE_COMMAND, args, {
			shell: false,
			env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
		});
		let stderrOutput = '';
		let timedOut = false;

		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
			outputChannel.appendLine(`\nTempo limite excedido (${ENGINE_TIMEOUT_MS / 1000}s). Processo cancelado.`);
		}, ENGINE_TIMEOUT_MS);

		child.stdout.on('data', (data: Buffer) => outputChannel.append(data.toString()));
		child.stderr.on('data', (data: Buffer) => {
			stderrOutput += data.toString();
			outputChannel.append(data.toString());
		});

		child.on('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});

		child.on('close', (code) => {
			clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`cgc ${args[0]} excedeu o tempo limite de ${ENGINE_TIMEOUT_MS / 1000}s e foi cancelado.`));
			} else if (code === 0) {
				resolve();
			} else {
				reject(new Error(friendlyEngineError(stderrOutput) || `cgc ${args[0]} terminou com código ${code}`));
			}
		});
	});
}

async function getMcpCwd(context: vscode.ExtensionContext): Promise<string> {
	// CGC_ALLOWED_ROOTS é a única fonte de verdade de paths permitidos — o cwd do
	// processo também conta como root implícito do lado do motor, então fixamos
	// num diretório da própria extensão para não depender de onde o VSCode foi aberto.
	await vscode.workspace.fs.createDirectory(context.globalStorageUri);
	return context.globalStorageUri.fsPath;
}

function isSupersetOf(set: ReadonlySet<string>, subset: ReadonlySet<string>): boolean {
	for (const item of subset) {
		if (!set.has(item)) {
			return false;
		}
	}
	return true;
}

async function handleUnexpectedMcpExit(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
	info: McpExitInfo,
): Promise<void> {
	mcpClient = undefined;
	if (info.expected) {
		return;
	}
	const message = friendlyEngineError(info.stderrTail) || 'A conexão com o motor foi encerrada inesperadamente.';
	outputChannel.appendLine(`\nAuto-atualização caiu inesperadamente: ${message}`);

	const affected = getActiveWatchPaths(context);
	for (const path of affected) {
		await setWatchState(context, path, 'error');
	}
	refreshRepositoriesView?.();

	if (affected.length > 0) {
		vscode.window.showErrorMessage(`Auto-atualização parou inesperadamente: ${message}`);
	}
}

async function ensureMcpClientForRoots(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<McpClient> {
	const desired = new Set(getRepositories(context));

	if (mcpClient?.isAlive && isSupersetOf(mcpClient.allowedRoots, desired)) {
		return mcpClient;
	}

	if (mcpClient) {
		outputChannel.appendLine('\nReiniciando conexão de auto-atualização para atualizar permissões de caminho...');
		await mcpClient.shutdown();
		mcpClient = undefined;
	}

	if (!(await checkEngineSupportsWatch(outputChannel))) {
		throw new Error(`Auto-atualização exige codegraphcontext ${MIN_ENGINE_VERSION} ou mais recente.`);
	}

	const client = new McpClient({
		command: ENGINE_COMMAND,
		cwd: await getMcpCwd(context),
		allowedRoots: [...desired],
		outputChannel,
	});
	client.onDidExit((info) => void handleUnexpectedMcpExit(context, outputChannel, info));

	outputChannel.appendLine('\n> cgc mcp start (auto-atualização)');
	await client.start();
	mcpClient = client;

	// Sempre reaplica watch_directory para tudo que já está 'watching' no estado
	// persistido — cobre tanto reinício por causa de roots novos (paths de sessões
	// anteriores deste mesmo processo) quanto retomada na inicialização da extensão
	// (processo novo nunca viu esses paths).
	for (const path of getWatchingPaths(context)) {
		try {
			await client.callTool('watch_directory', { repo_path: path });
		} catch (error) {
			await setWatchState(context, path, 'error');
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Aviso: falha ao restabelecer watch para ${path.split(/[\\/]/).pop()}: ${message}`);
		}
	}
	refreshRepositoriesView?.();
	return mcpClient;
}

interface EngineOperation<T> {
	viaSpawn: () => Promise<T>;
	viaMcp: (client: McpClient) => Promise<T>;
}

async function withEngine<T>(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
	op: EngineOperation<T>,
): Promise<T> {
	return engineGate.run(async () => {
		if (isWatchModeActive(context)) {
			const client = await ensureMcpClientForRoots(context, outputChannel);
			return op.viaMcp(client);
		}
		if (mcpClient) {
			// Nenhum repositório em watch neste momento, mas a conexão de uma operação
			// anterior ainda está viva — encerra antes de cair no spawn curto, para não
			// segurar o lock do banco sem necessidade.
			const client = mcpClient;
			mcpClient = undefined;
			await client.shutdown();
		}
		return op.viaSpawn();
	});
}

interface JobStatus {
	status?: string;
	processed_files?: number;
	total_files?: number;
	error?: string;
}

async function pollJobUntilDone(client: McpClient, jobId: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const start = Date.now();
	let lastProgress = '';
	while (Date.now() - start < ENGINE_TIMEOUT_MS) {
		const job = await client.callTool<JobStatus>('check_job_status', { job_id: jobId });
		const progress = `${job.processed_files ?? '?'}/${job.total_files ?? '?'}`;
		if (progress !== lastProgress) {
			outputChannel.appendLine(`Progresso da indexação inicial: ${progress} arquivos`);
			lastProgress = progress;
		}
		if (job.status === 'completed') {
			return;
		}
		if (job.status === 'failed' || job.status === 'cancelled') {
			throw new Error(job.error ?? `Job de indexação ${job.status === 'failed' ? 'falhou' : 'foi cancelado'}.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	throw new Error(`Indexação inicial excedeu o tempo limite de ${ENGINE_TIMEOUT_MS / 1000}s.`);
}

async function indexRepository(
	context: vscode.ExtensionContext,
	folderPath: string,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	await withEngine(context, outputChannel, {
		viaSpawn: () => runEngineCommandSpawn(['index', folderPath], outputChannel),
		viaMcp: async (client) => {
			const res = await client.callTool<{ job_id?: string; message?: string }>('add_code_to_graph', {
				repo_path: folderPath,
			});
			if (res.message) {
				outputChannel.appendLine(res.message);
			}
			if (res.job_id) {
				await pollJobUntilDone(client, res.job_id, outputChannel);
			}
		},
	});
	outputChannel.appendLine(`Indexação concluída: ${folderPath}`);
}

async function deleteRepositoryIndex(
	context: vscode.ExtensionContext,
	folderPath: string,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	await withEngine(context, outputChannel, {
		viaSpawn: () => runEngineCommandSpawn(['delete', folderPath], outputChannel),
		viaMcp: async (client) => {
			const res = await client.callTool<{ message?: string }>('delete_repository', { repo_path: folderPath });
			if (res.message) {
				outputChannel.appendLine(res.message);
			}
		},
	});
	outputChannel.appendLine(`Índice removido do code graph: ${folderPath}`);
}

interface CypherQueryResult {
	success?: boolean;
	results?: unknown[];
	truncated?: boolean;
	notice?: string;
}

async function executeCypherQuery(
	context: vscode.ExtensionContext,
	query: string,
	outputChannel: vscode.OutputChannel,
): Promise<unknown[]> {
	return withEngine(context, outputChannel, {
		viaSpawn: () => runQueryCommandSpawn(query, outputChannel),
		viaMcp: async (client) => {
			const res = await client.callTool<CypherQueryResult>('execute_cypher_query', { cypher_query: query });
			if (!Array.isArray(res.results)) {
				if (res.truncated) {
					throw new Error(
						res.notice ??
							'A resposta da consulta foi truncada pelo motor (configuração MAX_TOOL_RESPONSE_TOKENS) antes de virar uma lista completa de resultados.',
					);
				}
				throw new Error('Resposta inesperada do execute_cypher_query (não é uma lista).');
			}
			return res.results;
		},
	});
}

function runQueryCommandSpawn(query: string, outputChannel: vscode.OutputChannel): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		outputChannel.appendLine(`\n> cgc query ${query}`);

		// cgc query é um processo de vida curta (como index/delete), diferente do antigo
		// cgc visualize — não sobe servidor nenhum, então não segura o banco travado.
		const child = spawn(ENGINE_COMMAND, ['query', query], {
			shell: false,
			env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		// Guarda contra travas do próprio KuzuDB (ex: comparação de string com a letra
		// da unidade em caixa diferente da armazenada no banco fez a consulta nunca retornar).
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, ENGINE_TIMEOUT_MS);

		child.stdout.on('data', (data: Buffer) => {
			const text = data.toString();
			stdout += text;
			outputChannel.append(text);
		});
		child.stderr.on('data', (data: Buffer) => {
			const text = data.toString();
			stderr += text;
			outputChannel.append(text);
		});

		child.on('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});

		child.on('close', (code) => {
			clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`cgc query excedeu o tempo limite de ${ENGINE_TIMEOUT_MS / 1000}s e foi cancelado.`));
				return;
			}
			if (code !== 0) {
				// friendlyEngineError trata os casos conhecidos (ex: banco travado); nos demais
				// casos a saída bruta já foi logada acima no Output, então nada fica escondido
				// mesmo quando a mensagem de erro do motor mudar e deixar de bater com o que
				// reconhecemos aqui.
				reject(new Error(friendlyEngineError(stderr) || `cgc query terminou com código ${code}`));
				return;
			}
			// O cgc query também imprime linhas de status ("Resolving context...", etc.) no
			// stdout antes do JSON — extrai só a partir do primeiro '[' em vez de parsear tudo.
			const jsonStart = stdout.indexOf('[');
			if (jsonStart === -1) {
				reject(new Error('Não foi possível interpretar a resposta do cgc query (nenhum JSON encontrado).'));
				return;
			}
			try {
				resolve(JSON.parse(stdout.slice(jsonStart)));
			} catch {
				reject(new Error('Não foi possível interpretar a resposta do cgc query.'));
			}
		});
	});
}

const GRAPH_DISPLAY_LIMIT = 500;

interface GraphRow {
	source: string;
	sourceType: string;
	relType: string;
	target: string;
	targetType: string;
}

function isGraphRow(row: unknown): row is GraphRow {
	if (typeof row !== 'object' || row === null) {
		return false;
	}
	const candidate = row as Record<string, unknown>;
	return (
		typeof candidate.source === 'string' &&
		typeof candidate.target === 'string' &&
		typeof candidate.relType === 'string'
	);
}

async function fetchGraphData(
	context: vscode.ExtensionContext,
	folderPath: string,
	outputChannel: vscode.OutputChannel,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }> {
	// O CodeGraphContext guarda os caminhos com barra normal e letra de unidade maiúscula
	// (ex: "C:/Users/..."). O VSCode às vezes entrega o caminho com letra minúscula
	// (ex: "c:\Users\...") — sem essa normalização, a comparação STARTS WITH nunca bate
	// e, pior, faz o KuzuDB travar em vez de simplesmente devolver zero resultados.
	const normalizedPath = folderPath
		.replace(/\\/g, '/')
		.replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`)
		.replace(/'/g, "\\'");
	// Pede um a mais que o teto de exibição só pra saber se o resultado foi truncado.
	const query =
		`MATCH (a)-[r]->(b) WHERE a.path STARTS WITH '${normalizedPath}' AND b.path STARTS WITH '${normalizedPath}' ` +
		`RETURN a.name AS source, label(a) AS sourceType, type(r) AS relType, b.name AS target, label(b) AS targetType ` +
		`LIMIT ${GRAPH_DISPLAY_LIMIT + 1}`;

	const rawRows = await executeCypherQuery(context, query, outputChannel);
	if (!Array.isArray(rawRows)) {
		throw new Error('Resposta inesperada do cgc query (não é uma lista).');
	}

	// Linhas que não têm o formato esperado são descartadas em vez de viraram nós/arestas
	// quebrados (ex: com id "undefined") caso o formato de saída do CodeGraphContext mude.
	const rows = rawRows.filter(isGraphRow);
	const truncated = rows.length > GRAPH_DISPLAY_LIMIT;
	if (truncated) {
		rows.length = GRAPH_DISPLAY_LIMIT;
	}

	const nodeTypes = new Map<string, string>();
	const edges: GraphEdge[] = [];

	for (const row of rows) {
		nodeTypes.set(row.source, row.sourceType);
		nodeTypes.set(row.target, row.targetType);
		edges.push({ source: row.source, target: row.target, type: row.relType });
	}

	const nodes = Array.from(nodeTypes.entries()).map(([id, type]) => ({ id, type }));
	return { nodes, edges, truncated };
}

function createVisualizeRepositoryFlow(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
	graphViewProvider: GraphViewProvider,
): (folderPath: string) => Promise<void> {
	// Contador de "última requisição": se o usuário clicar em visualizar um repositório
	// diferente antes da consulta anterior terminar, o resultado desatualizado é descartado
	// em vez de sobrescrever o painel por cima do que foi pedido por último.
	let latestRequestId = 0;

	return async function visualizeRepositoryFlow(folderPath: string): Promise<void> {
		const status = getStatuses(context)[folderPath];
		if (status !== 'indexed') {
			vscode.window.showInformationMessage('Este repositório ainda não foi indexado — indexe antes de visualizar.');
			return;
		}

		const requestId = ++latestRequestId;

		try {
			outputChannel.appendLine(`\n> Consultando grafo de: ${folderPath}`);
			const { nodes, edges, truncated } = await fetchGraphData(context, folderPath, outputChannel);
			if (requestId !== latestRequestId) {
				return;
			}
			outputChannel.appendLine(`Grafo carregado: ${nodes.length} nós, ${edges.length} conexões.`);
			await vscode.commands.executeCommand('repograph.graphView.focus');
			graphViewProvider.showGraph(nodes, edges);
			if (truncated) {
				vscode.window.showWarningMessage(
					`Grafo muito grande — mostrando um recorte parcial (${GRAPH_DISPLAY_LIMIT} relações).`,
				);
			}
		} catch (error) {
			if (requestId !== latestRequestId) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Erro ao consultar grafo: ${message}`);
			vscode.window.showErrorMessage(`Não foi possível carregar a visualização 3D: ${message}`);
		}
	};
}

function isEngineInstalled(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(ENGINE_COMMAND, ['--version'], { shell: false });
		child.on('error', () => resolve(false));
		child.on('close', (code) => resolve(code === 0));
	});
}

function getEngineVersion(): Promise<string | null> {
	return new Promise((resolve) => {
		// `cgc --version` imprime no stderr (Console(stderr=True) do lado do motor).
		const child = spawn(ENGINE_COMMAND, ['--version'], { shell: false });
		let stderr = '';
		child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
		child.on('error', () => resolve(null));
		child.on('close', (code) => resolve(code === 0 ? stderr : null));
	});
}

async function checkEngineSupportsWatch(outputChannel: vscode.OutputChannel): Promise<boolean> {
	const versionOutput = await getEngineVersion();
	const version = versionOutput ? parseEngineVersion(versionOutput) : null;
	// Só bloqueia quando a versão foi identificada com confiança e é comprovadamente
	// antiga — se não der para determinar (regex não bateu, saída inesperada), segue
	// em frente por padrão em vez de travar a feature por uma checagem de melhor esforço.
	if (version && !isEngineVersionSufficient(version)) {
		const versionLabel = version.join('.');
		outputChannel.appendLine(
			`Erro: cgc na versão ${versionLabel} não suporta auto-atualização (mínimo: ${MIN_ENGINE_VERSION}).`,
		);
		vscode.window.showErrorMessage(
			`Auto-atualização (watch) exige codegraphcontext ${MIN_ENGINE_VERSION} ou mais recente (detectado: ${versionLabel}). Atualize com "pip install --upgrade codegraphcontext".`,
		);
		return false;
	}
	return true;
}

async function enableWatchFlow(
	context: vscode.ExtensionContext,
	treeProvider: RepositoryTreeProvider,
	outputChannel: vscode.OutputChannel,
	folderPath: string,
): Promise<void> {
	await setWatchState(context, folderPath, 'starting');
	treeProvider.refresh();

	try {
		await withEngine(context, outputChannel, {
			viaSpawn: () => {
				throw new Error('Estado interno inconsistente: watch ativo deveria sempre rotear pela conexão MCP.');
			},
			viaMcp: async (client) => {
				const res = await client.callTool<{ job_id?: string; message?: string }>('watch_directory', {
					repo_path: folderPath,
				});
				if (res.message) {
					outputChannel.appendLine(res.message);
				}
				if (res.job_id) {
					await pollJobUntilDone(client, res.job_id, outputChannel);
					await setStatus(context, folderPath, 'indexed');
				}
			},
		});
		await setWatchState(context, folderPath, 'watching');
		vscode.window.showInformationMessage(`Auto-atualização ativada: ${folderPath}`);
	} catch (error) {
		await setWatchState(context, folderPath, 'error');
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Erro ao ativar auto-atualização: ${message}`);
		vscode.window.showErrorMessage(`Não foi possível ativar auto-atualização: ${message}`);
	} finally {
		treeProvider.refresh();
	}
}

async function disableWatchFlow(
	context: vscode.ExtensionContext,
	treeProvider: RepositoryTreeProvider,
	outputChannel: vscode.OutputChannel,
	folderPath: string,
): Promise<void> {
	try {
		await withEngine(context, outputChannel, {
			viaSpawn: async () => {
				// Sem conexão MCP viva não há watch ativo para este path — nada a fazer.
			},
			viaMcp: async (client) => {
				const res = await client.callTool<{ message?: string }>('unwatch_directory', { repo_path: folderPath });
				if (res.message) {
					outputChannel.appendLine(res.message);
				}
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Aviso: falha ao desativar auto-atualização: ${message}`);
	} finally {
		await setWatchState(context, folderPath, 'off');
		treeProvider.refresh();

		// Se este era o último repositório observado, encerra a conexão persistente
		// já — sem esperar pela próxima operação — para soltar o lock do banco assim
		// que possível (reduz a janela de colisão com o assistente de IA do usuário).
		if (!isWatchModeActive(context) && mcpClient) {
			const client = mcpClient;
			mcpClient = undefined;
			await client.shutdown();
		}
	}
}

async function resumeWatchesOnStartup(
	context: vscode.ExtensionContext,
	treeProvider: RepositoryTreeProvider,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const toResume = getWatchingPaths(context);
	if (toResume.length === 0) {
		return;
	}
	if (!(await isEngineInstalled())) {
		for (const path of toResume) {
			await setWatchState(context, path, 'error');
		}
		treeProvider.refresh();
		return;
	}

	for (const path of toResume) {
		await setWatchState(context, path, 'starting');
	}
	treeProvider.refresh();

	try {
		await withEngine(context, outputChannel, {
			viaSpawn: () => {
				throw new Error('Estado interno inconsistente: watch ativo deveria sempre rotear pela conexão MCP.');
			},
			viaMcp: async (client) => {
				for (const path of toResume) {
					try {
						await client.callTool('watch_directory', { repo_path: path });
						await setWatchState(context, path, 'watching');
					} catch (error) {
						await setWatchState(context, path, 'error');
						const message = error instanceof Error ? error.message : String(error);
						outputChannel.appendLine(
							`Aviso: falha ao retomar auto-atualização de ${path.split(/[\\/]/).pop()}: ${message}`,
						);
					}
				}
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Aviso: falha ao retomar auto-atualização na inicialização: ${message}`);
		for (const path of toResume) {
			await setWatchState(context, path, 'error');
		}
	} finally {
		treeProvider.refresh();
	}
}

async function removeRepositoryFlow(
	context: vscode.ExtensionContext,
	treeProvider: RepositoryTreeProvider,
	outputChannel: vscode.OutputChannel,
	folderPath: string,
): Promise<void> {
	const watchState = getWatchStates(context)[folderPath] ?? 'off';
	if (watchState === 'watching' || watchState === 'starting') {
		await disableWatchFlow(context, treeProvider, outputChannel, folderPath);
	}

	const repositories = getRepositories(context);
	await context.globalState.update(
		REPOSITORIES_KEY,
		repositories.filter((repo) => repo !== folderPath),
	);
	await clearStatus(context, folderPath);
	await clearWatchState(context, folderPath);
	treeProvider.refresh();
	vscode.window.showInformationMessage(`Repositório removido da lista: ${folderPath}`);

	try {
		await deleteRepositoryIndex(context, folderPath, outputChannel);
		vscode.window.showInformationMessage(`Índice removido do code graph: ${folderPath}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`Aviso: não foi possível remover o índice: ${message}`);
		vscode.window.showWarningMessage(
			`Repositório removido da lista, mas o índice não pôde ser apagado do code graph: ${message}`,
		);
	}
}

async function warnIfEngineMissing(): Promise<void> {
	if (await isEngineInstalled()) {
		return;
	}

	const choice = await vscode.window.showWarningMessage(
		'CodeGraphContext (comando "cgc") não foi encontrado nesta máquina. O RepoGraph precisa dele instalado para indexar repositórios.',
		'Copiar comando de instalação',
		'Abrir documentação',
	);

	if (choice === 'Copiar comando de instalação') {
		await vscode.env.clipboard.writeText('pip install codegraphcontext');
		vscode.window.showInformationMessage('Comando copiado: pip install codegraphcontext');
	} else if (choice === 'Abrir documentação') {
		vscode.env.openExternal(vscode.Uri.parse('https://github.com/CodeGraphContext/CodeGraphContext'));
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "repograph" is now active!');

	const outputChannel = vscode.window.createOutputChannel('RepoGraph');
	context.subscriptions.push(outputChannel);

	const treeProvider = new RepositoryTreeProvider(context);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('repograph.repositoriesView', treeProvider));
	refreshRepositoriesView = () => treeProvider.refresh();

	const graphViewProvider = new GraphViewProvider(context.extensionUri);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('repograph.graphView', graphViewProvider));

	const visualizeRepositoryFlow = createVisualizeRepositoryFlow(context, outputChannel, graphViewProvider);

	void warnIfEngineMissing();

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('repograph.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from RepoGraph!');
	});

	const addRepository = vscode.commands.registerCommand('repograph.addRepository', async () => {
		const selection = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Adicionar repositório',
		});

		if (!selection || selection.length === 0) {
			return;
		}

		const folderPath = selection[0].fsPath;
		const repositories = getRepositories(context);

		if (repositories.includes(folderPath)) {
			vscode.window.showInformationMessage(`Repositório já cadastrado: ${folderPath}`);
			return;
		}

		await context.globalState.update(REPOSITORIES_KEY, [...repositories, folderPath]);
		await setStatus(context, folderPath, 'pending');
		treeProvider.refresh();
		vscode.window.showInformationMessage(`Repositório adicionado: ${folderPath}`);

		try {
			await indexRepository(context, folderPath, outputChannel);
			await setStatus(context, folderPath, 'indexed');
			vscode.window.showInformationMessage(`Repositório indexado: ${folderPath}`);
		} catch (error) {
			await setStatus(context, folderPath, 'error');
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Erro ao indexar: ${message}`);
			vscode.window.showErrorMessage(`Falha ao indexar repositório: ${message}`);
		} finally {
			treeProvider.refresh();
		}
	});

	const removeRepository = vscode.commands.registerCommand('repograph.removeRepository', async () => {
		const repositories = getRepositories(context);

		if (repositories.length === 0) {
			vscode.window.showInformationMessage('Nenhum repositório cadastrado.');
			return;
		}

		const folderPath = await vscode.window.showQuickPick(repositories, {
			placeHolder: 'Escolha o repositório para remover',
		});

		if (!folderPath) {
			return;
		}

		await removeRepositoryFlow(context, treeProvider, outputChannel, folderPath);
	});

	const removeRepositoryItem = vscode.commands.registerCommand(
		'repograph.removeRepositoryItem',
		async (folderPath: string) => {
			const confirm = await vscode.window.showWarningMessage(
				`Remover "${folderPath.split(/[\\/]/).pop()}" do RepoGraph?`,
				{ modal: true },
				'Remover',
			);
			if (confirm !== 'Remover') {
				return;
			}
			await removeRepositoryFlow(context, treeProvider, outputChannel, folderPath);
		},
	);

	const revealOutput = vscode.commands.registerCommand('repograph.revealOutput', () => {
		outputChannel.show(true);
	});

	const visualizeRepository = vscode.commands.registerCommand('repograph.visualizeRepository', async () => {
		const repositories = getRepositories(context);

		if (repositories.length === 0) {
			vscode.window.showInformationMessage('Nenhum repositório cadastrado.');
			return;
		}

		const folderPath = await vscode.window.showQuickPick(repositories, {
			placeHolder: 'Escolha o repositório para visualizar em 3D',
		});

		if (!folderPath) {
			return;
		}

		await visualizeRepositoryFlow(folderPath);
	});

	const visualizeRepositoryItem = vscode.commands.registerCommand(
		'repograph.visualizeRepositoryItem',
		async (folderPath: string) => {
			await visualizeRepositoryFlow(folderPath);
		},
	);

	const configureMcp = vscode.commands.registerCommand('repograph.configureMcp', () => {
		// O motor já fala MCP sozinho (um único servidor cobre todos os repositórios
		// indexados), então aqui só orientamos o assistente oficial de configuração
		// em vez de reescrever a lógica de detecção de cliente (VS Code, Cursor, etc.).
		const terminal = vscode.window.createTerminal('RepoGraph MCP Setup');
		terminal.show();
		terminal.sendText(`${ENGINE_COMMAND} mcp setup`);
	});

	const enableWatchItem = vscode.commands.registerCommand(
		'repograph.enableWatchItem',
		async (folderPath: string) => {
			await enableWatchFlow(context, treeProvider, outputChannel, folderPath);
		},
	);

	const disableWatchItem = vscode.commands.registerCommand(
		'repograph.disableWatchItem',
		async (folderPath: string) => {
			await disableWatchFlow(context, treeProvider, outputChannel, folderPath);
		},
	);

	context.subscriptions.push(
		disposable,
		addRepository,
		removeRepository,
		removeRepositoryItem,
		revealOutput,
		visualizeRepository,
		visualizeRepositoryItem,
		configureMcp,
		enableWatchItem,
		disableWatchItem,
	);

	void resumeWatchesOnStartup(context, treeProvider, outputChannel);
}

// This method is called when your extension is deactivated
export function deactivate(): Thenable<void> | undefined {
	refreshRepositoriesView = undefined;
	return mcpClient?.shutdown();
}
