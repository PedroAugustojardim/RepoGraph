import ForceGraph3D from '3d-force-graph';
import SpriteText from 'three-spritetext';

(function () {
	const vscode = acquireVsCodeApi();
	const graphContainer = document.getElementById('graph');
	const emptyContainer = document.getElementById('empty');
	const style = getComputedStyle(document.documentElement);
	const themeColor = (varName, fallback) => style.getPropertyValue(varName).trim() || fallback;

	const colorByType = {
		File: themeColor('--vscode-charts-blue', '#4fc1ff'),
		Function: themeColor('--vscode-charts-green', '#89d185'),
		Class: themeColor('--vscode-charts-orange', '#d19a66'),
		Interface: themeColor('--vscode-charts-purple', '#c586c0'),
	};
	const defaultColor = themeColor('--vscode-charts-foreground', '#cccccc');
	const linkColor = themeColor('--vscode-editorWidget-border', '#454545');

	function escapeHtml(str) {
		return String(str).replace(/[&<>"']/g, (ch) => ({
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#39;',
		})[ch]);
	}

	// Instância única, reaproveitada entre trocas de repositório — criar uma nova a cada
	// vez deixava o loop de animação WebGL da instância antiga rodando pra sempre em segundo
	// plano (nunca era liberado só por remover o canvas do DOM).
	let graph;

	function ensureGraph() {
		if (!graph) {
			graph = ForceGraph3D()(graphContainer)
				.backgroundColor('rgba(0,0,0,0)')
				.nodeLabel((n) => `${escapeHtml(n.type)}: ${escapeHtml(n.id)}`)
				.nodeColor((n) => colorByType[n.type] || defaultColor)
				.nodeThreeObject((n) => {
					// Nós de arquivo ganham um rótulo de texto flutuante com o nome do arquivo,
					// já que suas funções/classes se agrupam naturalmente ao redor deles — isso
					// ajuda a identificar de qual arquivo é cada agrupamento. Outros tipos de nó
					// continuam com a esfera padrão (retornar undefined mantém o comportamento padrão).
					// SpriteText desenha em canvas, não via HTML, então não precisa de escapeHtml.
					if (n.type !== 'File') {
						return undefined;
					}
					const label = new SpriteText(n.id);
					label.color = colorByType.File;
					label.textHeight = 3;
					return label;
				})
				.linkColor(() => linkColor)
				.nodeRelSize(4);
		}
		return graph;
	}

	function render(nodes, edges) {
		if (!nodes.length) {
			graphContainer.style.display = 'none';
			emptyContainer.style.display = 'flex';
			return;
		}
		emptyContainer.style.display = 'none';
		graphContainer.style.display = 'block';
		ensureGraph()
			.graphData({ nodes, links: edges })
			.width(graphContainer.clientWidth)
			.height(graphContainer.clientHeight);
	}

	window.addEventListener('resize', () => {
		if (graph) {
			graph.width(graphContainer.clientWidth).height(graphContainer.clientHeight);
		}
	});

	window.addEventListener('message', (event) => {
		if (event.data && event.data.type === 'graph') {
			render(event.data.nodes, event.data.edges);
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
