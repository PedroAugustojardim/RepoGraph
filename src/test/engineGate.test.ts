import * as assert from 'assert';
import { EngineGate } from '../engineGate';

suite('EngineGate', () => {
	test('runs tasks strictly in FIFO order', async () => {
		const gate = new EngineGate();
		const order: number[] = [];

		const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		const p1 = gate.run(async () => {
			await delay(20);
			order.push(1);
		});
		const p2 = gate.run(async () => {
			await delay(5);
			order.push(2);
		});
		const p3 = gate.run(async () => {
			order.push(3);
		});

		await Promise.all([p1, p2, p3]);
		assert.deepStrictEqual(order, [1, 2, 3]);
	});

	test('a rejected task does not break the chain for later tasks', async () => {
		const gate = new EngineGate();
		const order: string[] = [];

		await assert.rejects(
			gate.run(async () => {
				order.push('a');
				throw new Error('boom');
			}),
			/boom/,
		);

		await gate.run(async () => {
			order.push('b');
		});

		assert.deepStrictEqual(order, ['a', 'b']);
	});

	test('propagates the task result and does not swallow it for the caller', async () => {
		const gate = new EngineGate();
		const value = await gate.run(async () => 42);
		assert.strictEqual(value, 42);
	});
});
