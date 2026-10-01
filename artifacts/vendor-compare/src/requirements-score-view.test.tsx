import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import RequirementsScoreView, { requirementsChartData } from './RequirementsScoreView';

const rows = [
  { criterion: 'Voice quality', score: 90, weight: 50 },
  { criterion: 'Reliability', score: 80, weight: 30 },
  { criterion: 'Cost', score: 60, weight: 20 },
];

test('radar and weighted totals use saved numeric ratings and actual weights', () => {
  const vendors = [{ vendor: 'Alpha', weightedScores: rows }, { vendor: 'Beta', weightedScores: rows.map((row) => ({ ...row, score: 50 })) }];
  const data = requirementsChartData(vendors);
  assert.equal(data.options[0].points, 81);
  assert.equal(data.options[1].points, 50);
  assert.equal(data.options[0].complete, true);
  const html = renderToStaticMarkup(<RequirementsScoreView vendors={vendors} />);
  assert.match(html, /chart-requirements-radar/);
  assert.match(html, /81.0 \/ 100/);
  assert.match(html, /50.0 \/ 100/);
  assert.match(html, /Voice quality · 50%/);
  assert.match(html, /not independently verified/);
});

test('missing and invalid scores are not fabricated as zero or complete totals', () => {
  const data = requirementsChartData([
    { vendor: 'Alpha', weightedScores: rows },
    { vendor: 'Beta', weightedScores: [{ ...rows[0], score: 0 }, { ...rows[1], score: NaN }] },
    { vendor: 'Empty' },
  ]);
  assert.equal(data.options[1].ratings.length, 1);
  assert.equal(data.options[1].ratings[0].score, 0);
  assert.equal(data.options[1].complete, false);
  assert.equal(data.options[2].complete, false);
});

test('single criterion avoids a fabricated radar shape and duplicate criteria are not double-counted', () => {
  const vendors = [{ vendor: 'Alpha', weightedScores: [rows[0], rows[0]] }];
  assert.equal(requirementsChartData(vendors).options[0].points, 45);
  const html = renderToStaticMarkup(<RequirementsScoreView vendors={vendors} />);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /at least three/);
  assert.match(html, /partial/);
});