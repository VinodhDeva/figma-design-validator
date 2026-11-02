import { test } from 'node:test';
import assert from 'node:assert/strict';
import frame from '../fixtures/figma-frame.json' with { type: 'json' };
import { collectLayers, componentName, matchLayers, tokens } from '../../src/design/match.ts';
import type { FigmaNode } from '../../src/design/figma.ts';

const root = frame.nodes['0:1'].document as FigmaNode;

test('tokens split case, separators and btn', () => {
  assert.deepEqual(tokens('PrimaryButton'), ['primary', 'button']);
  assert.deepEqual(tokens('primary-btn'), ['primary', 'button']);
  assert.deepEqual(tokens('Card / Frame'), ['card']);
});

test('collects nameable layers, skips instance internals and vectors', () => {
  const layers = collectLayers(root);
  assert.deepEqual(layers.map((l) => l.name), ['Card', 'Title', 'Hint', 'Primary Button', 'Promo banner']);
  assert.equal(layers.find((l) => l.name === 'Primary Button')!.text, 'Continue');
});

test('matches by text and name, one-to-one, reports unmatched', () => {
  const cands = [
    { selector: '[data-testid="card"]', tag: 'div', testId: 'card', text: 'Welcome Faint hint text Continue' },
    { selector: '[data-testid="title"]', tag: 'h2', testId: 'title', text: 'Welcome' },
    { selector: 'body > p', tag: 'p', text: 'Faint hint text' },
    { selector: '[data-testid="primary-btn"]', tag: 'button', testId: 'primary-btn', text: 'Continue' },
  ];
  const { matches, unmatched } = matchLayers(collectLayers(root), cands);
  const got = Object.fromEntries(matches.map((m) => [m.layer.name, [m.candidate.selector, m.by]]));
  assert.deepEqual(got, {
    Card: ['[data-testid="card"]', 'name'],
    Title: ['[data-testid="title"]', 'name'],
    Hint: ['body > p', 'text'],
    'Primary Button': ['[data-testid="primary-btn"]', 'name'],
  });
  assert.deepEqual(unmatched.map((l) => l.name), ['Promo banner']);
});

test('component names are unique PascalCase', () => {
  const taken = new Set<string>();
  assert.equal(componentName('primary button', taken), 'PrimaryButton');
  assert.equal(componentName('Primary/Button', taken), 'PrimaryButton2');
});
