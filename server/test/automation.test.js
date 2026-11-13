import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesKeyword, findKeywordAutomation, evaluateCondition, runFlow, continueFlow, validateFlow, nextAfterReply } from '../src/automation/engine.js';

const nodes = [
  { node_key: 'start', type: 'buttons', config: { text: 'Hi {{first_name}}', buttons: [{ id: 'track', title: 'Track order' }, { id: 'bulk', title: 'Bulk order' }, { id: 'agent', title: 'Talk to team' }] }, next: { track: 'check', bulk: 'tag_bulk', agent: 'human' } },
  { node_key: 'check', type: 'condition', config: { field: 'custom.order_status', operator: 'exists' }, next: { true: 'status', false: 'ask' } },
  { node_key: 'status', type: 'message', config: { text: 'Order is {{custom.order_status}}' }, next: {} },
  { node_key: 'ask', type: 'message', config: { text: 'Share your order id' }, next: { default: 'human' } },
  { node_key: 'tag_bulk', type: 'tag', config: { add: ['bulk'] }, next: { default: 'assign' } },
  { node_key: 'assign', type: 'assign', config: { strategy: 'round_robin' }, next: { default: 'ai' } },
  { node_key: 'ai', type: 'handoff', config: { to: 'ai' }, next: {} },
  { node_key: 'human', type: 'handoff', config: { to: 'human', message: 'Connecting you…' }, next: {} },
];

test('keyword matching modes', () => {
  assert.ok(matchesKeyword({ keywords: ['price list'], match: 'contains' }, 'Can you send the PRICE LIST?'));
  assert.ok(!matchesKeyword({ keywords: ['price'], match: 'contains' }, 'priceless'));
  assert.ok(matchesKeyword({ keywords: ['menu'], match: 'exact' }, ' Menu! '));
  assert.ok(!matchesKeyword({ keywords: ['menu'], match: 'exact' }, 'show menu'));
  assert.ok(matchesKeyword({ keywords: ['order'], match: 'starts_with' }, 'order status please'));
  assert.ok(matchesKeyword({ keywords: ['^sun\\d{4}$'], match: 'regex' }, 'SUN1023'));
  assert.ok(!matchesKeyword({ keywords: ['(unclosed'], match: 'regex' }, 'x'));
  const autos = [
    { id: 'a', type: 'keyword', is_active: true, priority: 50, trigger: { keywords: ['price'], match: 'contains' } },
    { id: 'b', type: 'flow', is_active: true, priority: 10, trigger: { keywords: ['price'], match: 'contains' } },
    { id: 'c', type: 'keyword', is_active: false, priority: 1, trigger: { keywords: ['price'], match: 'contains' } },
  ];
  assert.equal(findKeywordAutomation(autos, 'price?').id, 'b');
});

test('conditions', () => {
  const c = { name: 'Ravi', tags: ['vip', 'bulk'], custom: { city: 'Pune', credit_limit: 50000 } };
  assert.ok(evaluateCondition({ field: 'custom.city', operator: 'equals', value: 'pune' }, c));
  assert.ok(evaluateCondition({ field: 'tags', operator: 'equals', value: 'VIP' }, c));
  assert.ok(evaluateCondition({ field: 'custom.credit_limit', operator: 'gt', value: '10000' }, c));
  assert.ok(evaluateCondition({ field: 'custom.missing', operator: 'not_exists' }, c));
  assert.ok(evaluateCondition({ field: 'custom.city', operator: 'in', value: 'Delhi, Pune' }, c));
  assert.ok(evaluateCondition({ field: 'last_message', operator: 'contains', value: 'urgent' }, c, { text: 'This is URGENT' }));
});

test('flow: buttons wait, then branch by button id, title or number', () => {
  const contact = { tags: [], custom: { order_status: 'Shipped' } };
  const r1 = runFlow(nodes, 'start', contact, { text: 'menu' });
  assert.equal(r1.actions[0].type, 'send_buttons');
  assert.deepEqual(r1.state, { node: 'start', waiting: true });

  const r2 = continueFlow(nodes, r1.state, contact, { interactiveId: 'track' });
  assert.deepEqual(r2.actions.map((a) => a.type), ['send_text']);
  assert.equal(r2.actions[0].text, 'Order is {{custom.order_status}}');
  assert.equal(r2.state, null);

  const r3 = continueFlow(nodes, r1.state, { tags: [], custom: {} }, { text: 'Bulk Order' });
  assert.deepEqual(r3.actions.map((a) => a.type), ['tag', 'assign', 'handoff']);
  assert.equal(r3.actions[2].to, 'ai');

  const r4 = continueFlow(nodes, r1.state, contact, { text: '3' });
  assert.deepEqual(r4.actions.map((a) => a.type), ['send_text', 'handoff']);
  assert.equal(r4.actions[1].to, 'human');

  const r5 = continueFlow(nodes, r1.state, contact, { text: 'what?' });
  assert.equal(r5.actions[0].type, 'send_text');
  assert.equal(r5.state.retries, 1);
  const r6 = continueFlow(nodes, r5.state, contact, { text: 'still no' });
  assert.ok(r6.exit);
});

test('flow loop protection and validation', () => {
  const loop = [
    { node_key: 'a', type: 'tag', config: { add: ['x'] }, next: { default: 'b' } },
    { node_key: 'b', type: 'tag', config: { add: ['y'] }, next: { default: 'a' } },
  ];
  const r = runFlow(loop, 'a', { tags: [] }, {});
  assert.ok(r.actions.some((x) => x.type === 'error' && /too many steps/.test(x.message)));
  assert.deepEqual(validateFlow(nodes, 'start'), []);
  const bad = validateFlow([{ node_key: 'x', type: 'buttons', config: { text: '', buttons: [] }, next: { a: 'nope' } }], 'start');
  assert.ok(bad.length >= 3);
  assert.equal(nextAfterReply(nodes[0], { text: 'nothing' }).key, null);
});
