import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../youtube-player.js', import.meta.url), 'utf8');
const { createYouTubePlayer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const first = { embedUrl: 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?rel=0&playsinline=1&start=30' };
const second = { embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1&start=90' };

function stage() {
  return {
    childNodes: [], replacements: 0,
    ownerDocument: { createElement: tagName => ({ tagName }) },
    replaceChildren() { this.replacements++; this.childNodes = []; },
    append(child) { this.childNodes.push(child); },
  };
}

test('loading, replacing, removing and selecting branch videos never replaces the main iframe', () => {
  const mainStage = stage(), branchStage = stage();
  const main = createYouTubePlayer(mainStage), branch = createYouTubePlayer(branchStage);
  const mainFrame = main.show(first, 'map-1', 'Map video');
  const replacements = mainStage.replacements;
  branch.show(second, 'map-1:idea-a', 'Idea A');
  branch.show(first, 'map-1:idea-b', 'Idea B');
  branch.show(null, 'map-1:idea-c', 'Idea C');
  branch.show(second, 'map-1:idea-a', 'Idea A');
  branch.clear();
  assert.equal(mainStage.childNodes[0], mainFrame);
  assert.equal(mainFrame.src, first.embedUrl);
  assert.equal(mainStage.replacements, replacements);
});

test('same-owner updates and repeated selection preserve the iframe without touching its source', () => {
  const container = stage(), player = createYouTubePlayer(container);
  const frame = player.show(first, 'map-1:idea-a', 'Idea A');
  const replacements = container.replacements;
  Object.defineProperty(frame, 'src', { get: () => first.embedUrl, set: () => assert.fail('Unchanged playback source must not be reassigned') });
  assert.equal(player.show({ ...first }, 'map-1:idea-a', 'Renamed idea'), frame);
  assert.equal(player.show(first, 'map-1:idea-a', 'Renamed idea'), frame);
  assert.equal(frame.title, 'Renamed idea');
  assert.equal(container.replacements, replacements);
});

test('different ideas with identical URLs get distinct scoped players', () => {
  const container = stage(), player = createYouTubePlayer(container);
  const firstFrame = player.show(first, 'map-1:idea-a', 'Idea A');
  const secondFrame = player.show(first, 'map-1:idea-b', 'Idea B');
  assert.notEqual(firstFrame, secondFrame);
  assert.equal(container.childNodes.includes(firstFrame), false);
  assert.equal(secondFrame.src, first.embedUrl);
  const otherMapFrame = player.show(first, 'map-2:idea-b', 'Other map');
  assert.notEqual(otherMapFrame, secondFrame);
});

test('explicit main-video changes leave the branch iframe intact', () => {
  const mainStage = stage(), branchStage = stage();
  const main = createYouTubePlayer(mainStage), branch = createYouTubePlayer(branchStage);
  const branchFrame = branch.show(second, 'map-1:idea-a', 'Idea A');
  const originalMain = main.show(first, 'map-1', 'Map video');
  const updatedMain = main.show(second, 'map-1', 'Map video');
  assert.notEqual(originalMain, updatedMain);
  main.clear();
  assert.equal(branchStage.childNodes[0], branchFrame);
  assert.equal(branchFrame.src, second.embedUrl);
});

test('removal releases only its own player and a main placeholder has no playable source', () => {
  const container = stage(), player = createYouTubePlayer(container, 'Add a map video.');
  const frame = player.show(first, 'map-1', 'Map video');
  player.show(null, 'map-1', 'Map video');
  assert.equal(container.childNodes.includes(frame), false);
  assert.equal(container.childNodes[0].tagName, 'div');
  assert.equal(container.childNodes[0].textContent, 'Add a map video.');
  player.clear();
  assert.equal(container.childNodes.length, 0);
});
