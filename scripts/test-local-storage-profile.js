const assert = require('node:assert/strict');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
const {
  localStorageConfiguredLaunchUrl,
  localStorageInjectionExpression,
  localStorageLaunchExpression
} = require('./local-agent.js');

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(name) { return this.values.has(String(name)) ? this.values.get(String(name)) : null; }
  setItem(name, value) { this.values.set(String(name), String(value)); }
  removeItem(name) { this.values.delete(String(name)); }
}

const entries = [
  { name: 'currentVideoModelId', value: '{"value":"minimax-video-2_3","meta":{"expiration":1785304397169}}' },
  { name: 'image:expand:v4:resolution-by-mode-v1', value: '{}' },
  { name: 'imageGenerator.quality', value: '{"value":"","meta":{"expiration":null}}' },
  { name: 'pikaso:unlimited-mode:enabled:v2', value: 'true' },
  { name: 'user.videoGenerator.videoDuration', value: '{"value":6,"meta":{"expiration":1785304150713}}' },
  { name: 'user.videoGenerator.videoResolution', value: '{"value":"768p","meta":{"expiration":1785304402832}}' }
];
const localStorage = new MemoryStorage({
  currentVideoModelId: '{"value":"kling-25","meta":{"expiration":1}}',
  'video-recent-models-v1': '["kling-25"]',
  'user.videoGenerator.videoResolution': '{"value":"720p","meta":{"expiration":1}}',
  authToken: 'deve-permanecer'
});
const expression = localStorageInjectionExpression('https://www.magnific.com', entries);
const result = vm.runInNewContext(expression, {
  location: { origin: 'https://www.magnific.com' },
  localStorage,
  Date,
  JSON,
  Number,
  String,
  Set
});

assert.equal(result.applied, entries.length);
assert.equal(result.videoModelId, 'minimax-video-2_3');
assert.equal(localStorage.getItem('video-recent-models-v1'), '["minimax-video-2_3"]');
assert.match(localStorage.getItem('currentVideoModelId'), /minimax-video-2_3/);
assert.match(localStorage.getItem('user.videoGenerator.videoResolution'), /768p/);
assert.equal(localStorage.getItem('authToken'), 'deve-permanecer');

const launchUrl = localStorageConfiguredLaunchUrl({
  targetUrl: 'https://www.magnific.com/br/app/ai-video-generator',
  entries
});
assert.equal(new URL(launchUrl).searchParams.get('modelId'), 'minimax-video-2_3');

const launchStorage = new MemoryStorage({
  currentVideoModelId: '{"value":"kling-25","meta":{"expiration":1}}'
});
let reloadedUrl = '';
let reloadCallback = null;
const runtimeLaunchExpression = localStorageLaunchExpression(
  'https://www.magnific.com',
  entries,
  launchUrl
);
const launchResult = vm.runInNewContext(runtimeLaunchExpression, {
  location: {
    origin: 'https://www.magnific.com',
    href: launchUrl,
    replace(url) { reloadedUrl = url; }
  },
  localStorage: launchStorage,
  Date,
  JSON,
  Number,
  String,
  Set,
  setTimeout(callback) { reloadCallback = callback; }
});
assert.equal(launchResult.applied, entries.length);
assert.match(launchStorage.getItem('currentVideoModelId'), /minimax-video-2_3/);
assert.equal(typeof reloadCallback, 'function');
reloadCallback();
assert.equal(reloadedUrl, launchUrl);
console.log('LocalStorage por ferramenta OK: Kling foi substituído por Hailuo sem apagar a sessão.');
