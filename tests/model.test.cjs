const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./build/model.cjs');

const CH = `---\ncssclasses: manuscript\n---\n\n# BRAN\n\n%% se-scene id=s1 pov=eri moment=m1 where=farm %%\n\nExcited as the boy was.\n\nFortunately for her.\n\n✦ ✦ ✦\n\nThe young boy noticed.\n\n✦ ✦ ✦\n\n%% se-scene with=s1 %%\nBran was on the cusp.`;

test('scenes: split at heading and breaks, read hidden comments', () => {
  const s = M.scenesOf(CH.split('\n'));
  assert.equal(s.length, 3);
  assert.deepEqual(s.map(x => x.meta), [{ id: 's1', pov: 'eri', moment: 'm1', where: 'farm' }, {}, { with: 's1' }]);
  assert.equal(s[0].metaLine, 6); assert.equal(s[1].metaLine, null);
  assert.deepEqual(M.parseSceneComment(M.formatSceneComment({ id: 'a', flash: 'b', moment: 'm-2' })), { id: 'a', flash: 'b', moment: 'm-2' });
});
test('the scene comment does not steal the drop cap', () => {
  const { classify } = require('./build/manuscript.cjs');
  assert.equal(classify(CH.split('\n'))[8], 'dropcap');
});

test('timeline: plain scenes move on one slot each; parallel and flashback reuse slots', () => {
  const moments = [{ id: 'd1', label: 'Day 1', note: '', skip: false }, { id: 'sk', label: 'Two years later', note: '', skip: true }];
  const metas = [
    { id: 'a', moment: 'd1' },     // 1 → slot 0
    {},                            // 2 → slot 1
    { id: 'c' },                   // 3 → slot 2
    { with: 'a' },                 // 4 → parallel to 1 (slot 0)
    { moment: 'sk' },              // 5 → slot 3, starts the time skip
    { flash: 'c' },                // 6 → flashback to scene 3 (slot 2)
    { flash: 'd1' },               // 7 → flashback to the moment Day 1 (slot 0)
    { with: 'gone' },              // 8 → target missing: alongside scene 7
  ];
  const t = M.buildTimeline(metas, moments);
  assert.deepEqual(t.scenes.map(s => s.slot), [0, 1, 2, 0, 3, 2, 0, 0]);
  assert.deepEqual(t.scenes.map(s => s.kind), ['next', 'next', 'next', 'parallel', 'next', 'flashback', 'flashback', 'parallel']);
  assert.equal(t.scenes[3].ref, 1); assert.equal(t.scenes[5].ref, 3);
  assert.equal(t.slots, 4);
  assert.deepEqual(t.bands.map(b => [b.moment.label, b.start, b.end]), [['Day 1', 0, 3], ['Two years later', 3, 4]]);
  assert.equal(M.bandAt(t, 2).moment.id, 'd1');
  assert.equal(t.bySlot.get(0).length, 4, 'scenes 1, 4, 7 and 8');
});
test('a parallel scene can point at a later-resolved parallel scene', () => {
  const t = M.buildTimeline([{ id: 'x' }, { id: 'y', with: 'x' }, { with: 'y' }, {}], []);
  assert.deepEqual(t.scenes.map(s => s.slot), [0, 0, 0, 1]);
});

test('where pieces are: from a scene on, gone, only-this-scene, places, events', () => {
  const d = M.blankData();
  const slots = new Map([['s0', 0], ['s1', 1], ['s2', 2], ['s3', 3]]);
  const p = { id: 'p' }, pl = { id: 'pl' }, ev = { id: 'ev' };
  d.places.pl = { x: .5, y: .5 };
  M.setTrack(d, 'p', 's0', { place: 'pl' });
  assert.equal(M.whereAt(d, p, 'token', 3, slots).place, 'pl', 'stays until moved');
  M.setTrack(d, 'p', 's2', { gone: true });
  assert.equal(M.whereAt(d, p, 'token', 1, slots).place, 'pl'); assert.equal(M.whereAt(d, p, 'token', 2, slots), null);
  M.setTrack(d, 'p', 's1', { pt: { x: .1, y: .1 }, only: true });
  assert.deepEqual(M.whereAt(d, p, 'token', 1, slots).pt, { x: .1, y: .1 }); assert.equal(M.whereAt(d, p, 'token', 2, slots), null);
  M.setTrack(d, 'ev', 's1', { place: 'pl' });
  assert.ok(M.whereAt(d, ev, 'event', 1, slots)); assert.equal(M.whereAt(d, ev, 'event', 2, slots), null);
  assert.deepEqual(M.whereAt(d, pl, 'place', 0, slots).pt, { x: .5, y: .5 });
});

test('upgrading a 2.0 story: when= becomes moment/with, per-moment positions move to scenes', () => {
  const raw = { version: 2, moments: [{ id: 'm0', label: 'Moment 0', note: '' }, { id: 'm1', label: 'Moment 1', note: '' }], track: { eri: [{ m: 'm0', place: 'tree' }], cate: [{ m: 'm1', place: 'cath' }] }, places: { tree: { x: .2, y: .6 } }, persist: false, themes: { Eyes: '#e9d36b' } };
  const d = M.normalizeData(raw);
  assert.equal(d.version, 3); assert.ok(d.legacy); assert.deepEqual(d.themes.Eyes, { color: '#e9d36b', meaning: '' });
  let n = 0;
  const metas = [{ pov: 'shu' }, { pov: 'eri' }, {}, {}, { when: 'm1' }, {}, { when: 'm0' }];
  const up = M.upgradeLegacy(metas, d.legacy, () => 'id' + n++);
  assert.equal(up.metas[0].moment, 'm0'); assert.equal(up.metas[4].moment, 'm1');
  assert.equal(up.metas[6].with, up.metas[0].id, 'going back to Moment 0 runs alongside its first scene');
  assert.ok(!up.metas.some(m => 'when' in m));
  assert.deepEqual(up.track.eri, [{ s: up.metas[0].id, place: 'tree' }]);
  assert.deepEqual(up.track.cate, [{ s: up.metas[4].id, place: 'cath' }]);
  const t = M.buildTimeline(up.metas, d.moments);
  assert.deepEqual(t.scenes.map(s => s.slot), [0, 1, 2, 3, 4, 5, 0]);
});
test('data on disk is normalised (2.1)', () => {
  const d = M.normalizeData({ version: 3, moments: [{ id: 'x', label: 'X', skip: true }], places: { a: { x: 2, y: -1 } }, look: { size: 99, lineHeight: 2 }, types: [{ id: 'spirit', label: 'Spirit' }] });
  assert.deepEqual(d.places.a, { x: 1, y: 0 }); assert.equal(d.moments[0].skip, true); assert.equal(d.look.size, 40); assert.equal(d.look.lineHeight, 2);
  assert.equal(d.types[0].behaviour, 'token'); assert.equal(d.types[0].plural, 'Spirits');
  assert.equal(M.normalizeData(null).types.length, 6);
});
test('pieces: custom types, connections, description blocks and removing one', () => {
  const p = M.parsePiece('a', 'Ghost', { 'se-id': 'g', 'se-type': 'Spirit', connections: ['[[Bran]] · Haunts'] });
  assert.equal(p.type, 'spirit'); assert.deepEqual(p.connections, [{ target: 'Bran', label: 'Haunts' }]);
  assert.equal(M.typeId('Location'), 'place');
  const note = `---\nse-id: x\n---\n\n${M.quoteBlock('Small for his age.', '02 Bran')}\n\nShe is older.\n`;
  const blocks = M.descriptionBlocks(note);
  assert.deepEqual(blocks.map(b => [b.text, b.source]), [['Small for his age.', '02 Bran'], ['She is older.', null]]);
  assert.equal(M.descriptionBlocks(M.removeBlock(note, blocks[0].raw)).length, 1);
  assert.match(M.removeBlock(note, blocks[0].raw), /^---\nse-id: x\n---\n\nShe is older\.\n$/);
});
test('helpers: bulk lists and colours', () => {
  assert.deepEqual(M.splitList('Sister, Brother\nMentor;  Sister\n'), ['Sister', 'Brother', 'Mentor']);
  assert.equal(M.nextColor([M.PALETTE[0]]), M.PALETTE[1]);
  const f = M.nameMatcher([{ id: 's', name: 'Gared', aliases: ['the girl'] }, { id: 'e', name: 'Bran', aliases: [] }]);
  assert.deepEqual(f("Bran’s sister, the girl, met Brana.").map(h => h.id), ['e', 's']);
});
test('maps inside maps: positions, anchors, roofs', () => {
  const d = M.normalizeData({ version: 3, places: { wf: { x: .2, y: .3 }, hall: { x: .5, y: .5, map: 'mwf' }, crypt: { x: .1, y: .9, map: 'mcr' } }, maps: [{ id: 'mwf', name: 'Winterfell', image: null, anchor: 'wf' }, { id: 'mcr', name: 'Crypts', image: null, anchor: 'hall' }], roofs: { hall: { x: .4, y: .4, w: .2, h: .2, image: null } } });
  assert.equal(M.mapOfPlace(d, 'hall'), 'mwf'); assert.equal(M.mapOfPlace(d, 'wf'), 'main');
  assert.deepEqual(M.mapPath(d, 'mcr'), ['main', 'mwf', 'mcr']);
  assert.deepEqual(M.placeOn(d, 'crypt', 'main'), { x: .2, y: .3 }, 'deep inside shows at the outermost anchor');
  assert.deepEqual(M.placeOn(d, 'crypt', 'mwf'), { x: .5, y: .5 });
  assert.equal(M.placeOn(d, 'wf', 'mwf'), null, 'an outer place is not on the inside map');
  assert.deepEqual(M.entryOn(d, { place: 'crypt' }, 'main'), { pt: { x: .2, y: .3 }, place: 'wf', inside: true });
  assert.deepEqual(M.entryOn(d, { pt: { x: .9, y: .9 }, m: 'mwf' }, 'mwf'), { pt: { x: .9, y: .9 }, place: undefined, inside: false, exact: true });
  assert.deepEqual(M.entryOn(d, { pt: { x: .9, y: .9 }, m: 'mwf' }, 'main').place, 'wf');
  assert.ok(M.inRoof(d.roofs.hall, { x: .5, y: .5 })); assert.ok(!M.inRoof(d.roofs.hall, { x: .1, y: .1 }));
  assert.equal(M.normalizeData({ version: 3, places: { a: { x: .1, y: .1, map: 'main' } } }).places.a.map, undefined);
});
test('place areas: shapes, smallest area wins, spots move with their place, snapping', () => {
  const d = M.normalizeData({ version: 3, places: { castle: { x: .5, y: .5 }, hall: { x: .45, y: .45 }, inn: { x: .9, y: .9 } },
    areas: { castle: [{ x: .3, y: .3 }, { x: .7, y: .3 }, { x: .7, y: .7 }, { x: .3, y: .7 }], hall: [{ x: .4, y: .4 }, { x: .5, y: .4 }, { x: .5, y: .5 }, { x: .4, y: .5 }] } });
  const isPlace = () => true;
  assert.equal(M.placeAt(d, 'main', { x: .45, y: .45 }, isPlace), 'hall', 'nested: the smaller area wins');
  assert.equal(M.placeAt(d, 'main', { x: .6, y: .6 }, isPlace), 'castle');
  assert.equal(M.placeAt(d, 'main', { x: .9 + M.DEFAULT_RADIUS / 2, y: .9 }, isPlace), 'inn', 'default circle');
  assert.equal(M.placeAt(d, 'main', { x: .1, y: .1 }, isPlace), null);
  const e = M.spotEntry(d, 'main', { x: .65, y: .6 }, isPlace);
  assert.equal(e.place, 'castle'); assert.ok(Math.abs(e.off.x - .15) < 1e-9 && Math.abs(e.off.y - .1) < 1e-9);
  d.places.castle = { x: .55, y: .5 };   // the castle moves: the spot inside moves with it
  assert.ok(Math.abs(M.entryOn(d, { place: 'castle', off: e.off }, 'main').pt.x - .7) < 1e-9);
  assert.deepEqual(M.snapPoint({ x: .705, y: .302 }, [d.areas.castle], .01), { pt: { x: .7, y: .3 }, snapped: 'corner' });
  const edge = M.snapPoint({ x: .5, y: .305 }, [d.areas.castle], .01); assert.equal(edge.snapped, 'edge'); assert.ok(Math.abs(edge.pt.y - .3) < 1e-9);
  assert.equal(M.snapPoint({ x: .5, y: .5 }, [d.areas.castle], .01).snapped, null);
  const roof = { x: 0, y: 0, w: 0, h: 0, image: null, pts: [{ x: .1, y: .1 }, { x: .3, y: .1 }, { x: .1, y: .3 }] };
  assert.ok(M.inRoof(roof, { x: .15, y: .15 })); assert.ok(!M.inRoof(roof, { x: .28, y: .28 }), 'triangle roof');
});
test('pieces without a spot get a stable one inside the area, whoever else is there', () => {
  const poly = M.circlePoly({ x: .5, y: .5 }, .1), c = { x: .5, y: .5 };
  const a = M.autoSpots(poly, c, ['eri', 'shu', 'cate', 'jon']);
  for (const q of a.values()) assert.ok(M.inPolygon(poly, q));
  assert.equal(new Set([...a.values()].map(q => `${q.x},${q.y}`)).size, 4, 'all different');
  const b = M.autoSpots(poly, c, ['eri', 'jon']);
  assert.deepEqual(b.get('eri'), a.get('eri'), 'someone leaving does not move the others');
  assert.deepEqual(b.get('jon'), a.get('jon'));
  assert.ok(Math.abs(M.innerRadius(poly, c) - .1 * Math.cos(Math.PI / 16)) < 1e-6);
});

test('default place circles stay round on wide and tall pictures', () => {
  const span = pts => ({ w: Math.max(...pts.map(q => q.x)) - Math.min(...pts.map(q => q.x)), h: Math.max(...pts.map(q => q.y)) - Math.min(...pts.map(q => q.y)) });
  const wide = span(M.circlePoly({ x: 0.5, y: 0.5 }, 0.1, 16, 1.6)), tall = span(M.circlePoly({ x: 0.5, y: 0.5 }, 0.1, 16, 0.5));
  assert.ok(Math.abs(wide.w * 1.6 - wide.h) < 1e-9, 'on a 1.6 : 1 picture, as wide as tall on screen');
  assert.ok(Math.abs(tall.w * 0.5 - tall.h) < 1e-9);
  const d = M.blankData(); d.places.a = { x: 0.5, y: 0.5 }; d.aspects = { [M.MAIN_MAP]: 2 };
  const a = span(M.areaOf(d, 'a')); assert.ok(Math.abs(a.w * 2 - a.h) < 1e-9, 'areaOf uses the map’s shape');
});
